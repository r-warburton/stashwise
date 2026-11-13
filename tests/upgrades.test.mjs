import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {adaptBulk,fetchBulk,getResource} from '../lib/bulk.mjs';
import {CatalogStore,REFRESH_MS,fetchCatalog} from '../lib/feed.mjs';
import {runCore} from '../lib/core.mjs';
import {createApp} from '../server.mjs';
import {BoundedCache} from '../lib/http-cache.mjs';
const stamp='2026-11-13T18:00:00Z';
const raw=(id,type='rig')=>({id,name:`${id} Name`,shortName:`${id} ShortName`,types:[type],width:2,height:2,properties:{capacity:8,grids:[{width:2,height:2,filters:{allowedCategories:['general']}},{width:2,height:2,filters:{allowedCategories:['general']}}]},lastLowPrice:40000,avg24hPrice:50000,lastScan:stamp,buyFromTrader:[{trader:'ragman',price:60000,priceRUB:60000,currency:'RUB',minTraderLevel:2}],sellToTrader:[{priceRUB:1}]});
const raws=[raw('a'),raw('b','backpack'),raw('c','container')];
const english=Object.fromEntries(raws.flatMap(i=>[[i.name,`Item ${i.id}`],[i.shortName,i.id]]));
const adapted=()=>adaptBulk({items:raws,itemCategories:[{id:'general',name:'General'}]},{...english,General:'Item'},{ragman:{name:'RagmanName'}},{RagmanName:'Ragman'});
async function temporary(t){const base=fileURLToPath(new URL('../.cache/',import.meta.url));const dir=await mkdtemp(path.join(base,'qa-upgrade-'));assert.ok(dir.startsWith(base));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('bulk adapter resolves names, category IDs and acquisition offers through the Rust boundary',async()=>{
  const feed=adapted();const {items}=await runCore({op:'normalize',items:feed.items,categories:feed.categories});
  assert.equal(items.length,3);assert.equal(items[0].name,'Item a');assert.equal(items[0].traderName,'Ragman');
  assert.equal(items[0].traderPrice,60000);assert.equal(items[0].quoteUpdated,stamp);assert.equal(items[0].pocketScore,4);
  assert.deepEqual(items[0].restrictions,['Item']);assert.equal(items[0].offers[0].level,2);
  const foreign=adapted();foreign.items[0].buyFromTrader[0]={traderName:'Therapist',price:100,currency:'EUR',priceRUB:19000,minTraderLevel:3};
  const normalized=await runCore({op:'normalize',items:foreign.items});assert.equal(normalized.items[0].traderPrice,19000);assert.equal(normalized.items[0].offers[0].currency,'EUR');
  assert.throws(()=>adaptBulk({items:raws},{},{},{}),/translation is missing/);
  assert.throws(()=>adaptBulk({items:raws.slice(0,1)},english,{},{}),/Incomplete/);
});

test('upstream 304 reuses the correct market snapshot without parsing or redating quotes',async()=>{
  let calls=0;const previous={source:'Tarkov.dev JSON',upstream:{adapterVersion:3,etag:'"same"',metadataCheckedAt:Date.now()}};
  const result=await fetchBulk('pve',{previous,fetcher:async(url,options)=>{
    calls++;assert.match(url,/\/pve\/items$/);assert.equal(options.headers['If-None-Match'],'"same"');return new Response(null,{status:304});
  }});
  assert.equal(calls,1);assert.equal(result.unchanged,true);
  await assert.rejects(getResource('regular/items',{fetcher:async()=>new Response('{}',{status:200})}),/Incomplete/);
});

test('untagged secure containers retain their grids and category in the bulk feed',async()=>{
  const secure={...raw('secure','noFlea'),properties:{...raw('secure').properties,propertiesType:'ItemPropertiesContainer'},updated:stamp};
  const feed=adaptBulk({items:[...raws,secure]},{...english,'secure Name':'Secure container Alpha','secure ShortName':'Alpha'},{ragman:{name:'RagmanName'}},{RagmanName:'Ragman'});
  const {items}=await runCore({op:'normalize',items:feed.items});const item=items.find(i=>i.id==='secure');
  assert.ok(item);assert.equal(item.category,'secure');assert.equal(item.fleaPrice,null);assert.equal(item.capacity,8);assert.equal(item.quoteUpdated,stamp);
});

test('unchanged checks preserve quote time and recovery snapshot survives a corrupt current file',async t=>{
  const dir=await temporary(t);let now=Date.parse(stamp),phase=0;
  const store=new CatalogStore(dir,{now:()=>now,onError:()=>{},loader:async()=>phase===1?{unchanged:true,upstream:{etag:'same'}}:{...adapted(),items:adapted().items.map(i=>({...i,lastLowPrice:phase?80000:40000}))}});
  const first=await store.get('pvp');phase=1;now+=REFRESH_MS+1;
  const second=await store.get('pvp',true);assert.equal(second.revision,first.revision);assert.notEqual(second.checkedAt,first.checkedAt);assert.equal(second.items[0].quoteUpdated,stamp);
  phase=2;now+=REFRESH_MS+1;const third=await store.get('pvp',true);assert.notEqual(third.revision,first.revision);
  assert.equal(JSON.parse(await readFile(path.join(dir,'pvp.previous.json'))).items[0].fleaPrice,40000);
  await writeFile(path.join(dir,'pvp.json'),'{broken');
  const recovered=new CatalogStore(dir,{now:()=>now,onError:()=>{},loader:async()=>{throw new Error('offline');}});
  const restored=await recovered.get('pvp');assert.equal(restored.items[0].fleaPrice,40000);
  if(recovered.state('pvp').inflight)await recovered.state('pvp').inflight;
});

test('ID selection composes with price source, filters and ordering without changing library counts',async()=>{
  const {items}=await runCore({op:'normalize',items:adapted().items});
  const output=await runCore({op:'query',items,query:{ids:['a','c'],source:'trader',maxPrice:60000,sort:[{field:'name',direction:'desc'}]}});
  assert.deepEqual(output.items.map(i=>i.id),['c','a']);assert.equal(output.total,3);assert.equal(output.items[0].cost,60000);
  assert.equal((await runCore({op:'query',items,query:{ids:[]}})).items.length,0);
  await assert.rejects(runCore({op:'query',items,query:{ids:'a'}}),/Invalid item selection/);
});

test('concurrent cached startup shares disk validation without needing the network',async t=>{
  const dir=await temporary(t),now=Date.parse(stamp);
  await new CatalogStore(dir,{now:()=>now,loader:async()=>adapted()}).get('pvp');
  let enter,release,networkCalls=0;
  const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const store=new CatalogStore(dir,{now:()=>now,onError:()=>{},loader:async()=>{networkCalls++;throw new Error('offline');},core:async(...args)=>{enter();await gate;return runCore(...args);}});
  const first=store.get('pvp');await entered;const second=store.get('pvp');release();
  const snapshots=await Promise.all([first,second]);assert.equal(networkCalls,0);assert.equal(snapshots[0].revision,snapshots[1].revision);assert.equal(snapshots[1].items.length,3);
});

test('a partial category refresh preserves the last good file and Seasonal never uses another market',async t=>{
  const dir=await temporary(t);let now=Date.parse(stamp),partial=false;
  const store=new CatalogStore(dir,{now:()=>now,onError:()=>{},loader:async()=>({...adapted(),...(partial?{requiredCategories:['rig','backpack','container','secure']}:{})})});
  const first=await store.get('pvp'),before=await readFile(path.join(dir,'pvp.json'),'utf8');partial=true;now+=REFRESH_MS+1;
  const failed=await store.get('pvp',true);assert.equal(failed.checkedAt,first.checkedAt);assert.ok(failed.meta.lastError);assert.equal(await readFile(path.join(dir,'pvp.json'),'utf8'),before);
  let fallbackCalls=0;
  await assert.rejects(fetchCatalog('seasonal',{bulk:async()=>{throw new Error('seasonal offline');},fetcher:async()=>{fallbackCalls++;throw new Error('wrong market');}}),/seasonal offline/);
  assert.equal(fallbackCalls,0);
});

test('query cache evicts least recently used entries and respects the byte budget',()=>{
  const cache=new BoundedCache({maxEntries:2,maxBytes:80});cache.set('a',{n:1});cache.set('b',{n:2});cache.get('a');cache.set('c',{n:3});
  assert.equal(cache.get('b'),null);assert.equal(cache.get('a').n,1);cache.set('large',{value:'x'.repeat(200)});assert.equal(cache.get('large'),null);assert.ok(cache.bytes<=80);
});

test('HTTP summaries, on-demand detail, 304 metadata, mode isolation and invalidation',async t=>{
  const {items}=await runCore({op:'normalize',items:adapted().items,categories:adapted().categories});
  let revision='first',checkedAt=stamp,calls=0;
  const store={get:async mode=>({items:items.map(i=>({...i,fleaPrice:mode==='pve'?80000:40000})),revision:revision+mode,meta:{checkedAt,source:'Fixture',quoteUpdated:stamp}})};
  const server=createApp({store,core:async(...args)=>{calls++;return runCore(...args);}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/items?mode=pvp&projection=summary');const data=await response.json();const etag=response.headers.get('etag');
  assert.equal(data.items[0].grids,undefined);assert.equal(data.items[0].description,undefined);assert.ok(data.items[0].pocketLayout.length);assert.equal(data.items[0].cost,40000);
  checkedAt='2026-11-13T18:05:00Z';const unchanged=await fetch(base+'/api/items?mode=pvp&projection=summary',{headers:{'If-None-Match':etag}});
  assert.equal(unchanged.status,304);assert.equal((await unchanged.arrayBuffer()).byteLength,0);assert.equal(calls,1);
  assert.equal(JSON.parse(decodeURIComponent(unchanged.headers.get('x-stashwise-meta'))).checkedAt,checkedAt);
  const detail=await(await fetch(base+'/api/items/a?source=trader')).json();assert.ok(detail.item.grids.length);assert.equal(detail.item.cost,60000);
  const pve=await(await fetch(base+'/api/items?mode=pve')).json();assert.equal(pve.items[0].cost,60000);assert.equal(pve.items[0].fleaPrice,80000);
  revision='second';assert.equal((await fetch(base+'/api/items?mode=pvp&projection=summary',{headers:{'If-None-Match':etag}})).status,200);
  assert.ok((await(await fetch(base+'/api/items?mode=pvp')).json()).items[0].grids.length,'legacy clients retain full rows');
  assert.equal((await fetch(base+'/api/items/unknown')).status,404);assert.equal((await fetch(base+'/api/items?sort=bad')).status,400);
  assert.equal((await fetch(base+'/api/items?mode=bad')).status,400);assert.equal((await fetch(base+'/lib/feed.mjs')).status,404);
  const staticResponse=await fetch(base+'/app.js');assert.equal((await fetch(base+'/app.js',{headers:{'If-None-Match':staticResponse.headers.get('etag')}})).status,304);
});
