import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogStore, fetchCatalog, freshness, mapLimit, REFRESH_MS, STALE_MS } from '../lib/feed.mjs';
import { runCore } from '../lib/core.mjs';

const root = fileURLToPath(new URL('../.cache/', import.meta.url));
const stamp = '2026-11-13T18:00:00.000Z';
const raw = (id = 'rig', cost = 60000) => ({ id, name:id, width:4, height:3, types:['rig'], properties:{capacity:24}, lastLowPrice:cost, quoteUpdated:stamp });
const feed = (id, cost) => ({ items:[raw(id,cost)], categories:[], source:'Fixture', sourceUrl:'https://example.invalid', warnings:[] });
async function temporary(t) {
  const dir = await mkdtemp(path.join(root,'qa-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(root) + path.sep));
  t.after(() => rm(dir,{recursive:true,force:true}));
  return dir;
}

test('real Rust boundary normalizes and sorts purchase prices without sell values', async () => {
  const normalized = await runCore({op:'normalize',items:[raw('A',60000), {...raw('B',40000), sellToTrader:[{priceRUB:1}]}]});
  const result = await runCore({op:'query',items:normalized.items,query:{sort:[{field:'efficiency',direction:'desc'},{field:'cost',direction:'asc'}]}});
  assert.deepEqual(result.items.map(i=>i.name),['B','A']);
  assert.equal(result.items[0].gain,12);
  assert.equal(result.items[0].traderPrice,null);
  assert.equal(result.items[0].costPerGain,40000/12);
  await assert.rejects(runCore({op:'query',items:normalized.items,query:{sort:[{field:'unsupported',direction:'asc'}]}}),/Invalid sort/);
});

test('freshness uses original quote times, including missing and future timestamps', () => {
  const now=Date.parse(stamp);
  const snapshot={items:[{quoteUpdated:stamp}],checkedAt:stamp,source:'Fixture'};
  assert.equal(freshness(snapshot,now).stale,false);
  assert.equal(freshness(snapshot,now+STALE_MS+1).stale,true);
  assert.equal(freshness({...snapshot,items:[...snapshot.items,{quoteUpdated:null}]},now).stale,true);
  assert.equal(freshness(snapshot,now-120000).stale,true);
  const failed=freshness(snapshot,now,'Network failed');
  assert.equal(failed.stale,true);
  assert.equal(failed.quoteUpdated,stamp);
});

test('failed refresh preserves persisted prices and timestamps; PvE stays separate', async t => {
  const dir=await temporary(t);
  let now=Date.parse(stamp), failing=false;
  const store=new CatalogStore(dir,{now:()=>now,loader:async mode=>{
    if(failing)throw new Error('Intentional upstream outage');
    return feed(mode,mode==='pvp'?60000:120000);
  }});
  const pvp=await store.get('pvp'),pve=await store.get('pve');
  assert.equal(pvp.items[0].fleaPrice,60000);
  assert.equal(pve.items[0].fleaPrice,120000);
  now+=REFRESH_MS+1; failing=true;
  const failed=await store.get('pvp',true);
  assert.equal(failed.items[0].fleaPrice,60000);
  assert.equal(failed.checkedAt,pvp.checkedAt);
  assert.equal(failed.meta.quoteUpdated,stamp);
  assert.equal(failed.meta.stale,true);
  assert.match(failed.meta.lastError,/refresh failed/);
  assert.equal(JSON.parse(await readFile(path.join(dir,'pvp.json'))).checkedAt,pvp.checkedAt);
  const restarted=new CatalogStore(dir,{now:()=>now,loader:async()=>{throw new Error('Offline');}});
  assert.equal((await restarted.get('pve')).items[0].fleaPrice,120000);
  // Wait for the intentional background refresh before removing its directory.
  if(restarted.state('pve').inflight)await restarted.state('pve').inflight;
});

test('concurrent refreshes are coalesced and failures have a retry cooldown', async t => {
  const dir=await temporary(t);
  let now=Date.parse(stamp),calls=0,fail=false;
  const store=new CatalogStore(dir,{now:()=>now,loader:async()=>{
    calls++; await new Promise(resolve=>setTimeout(resolve,10));
    if(fail)throw new Error('Intentional outage');
    return feed('rig',60000);
  }});
  await Promise.all([store.get('pvp'),store.get('pvp'),store.get('pvp')]);
  assert.equal(calls,1);
  now+=REFRESH_MS+1;fail=true;
  await store.get('pvp',true);
  for(let i=0;i<3;i++){await store.get('pvp');store.tick();}
  assert.equal(calls,2);
});

test('fallback requests both modes explicitly and never substitutes summary sell price', async () => {
  const requests=[];
  const fetcher=async url=>{
    requests.push(url);
    if(url.includes('graphql'))throw new Error('Primary down');
    assert.match(url,/mode=pve/);
    if(url.includes('/items/categories'))return {categories:[{id:'meds',name:'Meds'}]};
    if(url.includes('/items?'))return {total:1,results:[{id:'case',price:1}]};
    if(url.includes('/rigs?'))return {results:[{id:'rig',kind:'soft',price:1}]};
    if(url.includes('/backpacks?'))return {results:[{id:'pack',price:1}]};
    const id=url.match(/\/items\/([^?]+)/)[1];
    return {item:raw(id,50000),cache:{pricesLastUpdated:stamp}};
  };
  const data=await fetchCatalog('pve',{fetcher,bulk:async()=>{throw new Error('JSON source down');}});
  assert.equal(data.items.length,3);
  assert.equal(data.source,'TarkovHQ');
  assert.equal(data.items[0].lastLowPrice,50000);
  assert.equal(data.items[0].quoteUpdated,stamp);
  assert.equal(data.items[0].price,undefined);
  assert.ok(requests.length>6);
});

test('bounded mapping preserves ordering and concurrency', async()=>{
  let active=0,peak=0;
  const out=await mapLimit([1,2,3,4,5,6,7],3,async n=>{
    peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,3));active--;return n*2;
  });
  assert.equal(peak,3);
  assert.deepEqual(out,[2,4,6,8,10,12,14]);
});

test('old cached items acquire pocket scores without a price refresh or timestamp change', async()=>{
  const normalized=await runCore({op:'normalize',items:[{...raw('mixed pockets',60000),properties:{capacity:7,grids:[{width:2,height:2},{width:1,height:2},{width:1,height:1}]}}]});
  assert.equal(normalized.items[0].pocketScore,3);
  delete normalized.items[0].pocketScore;
  delete normalized.items[0].largestPocket;
  const queried=await runCore({op:'query',items:normalized.items,query:{sort:[{field:'pocketScore',direction:'desc'},{field:'cost',direction:'asc'}]}});
  assert.equal(queried.items[0].pocketScore,3);
  assert.deepEqual(queried.items[0].largestPocket,{width:2,height:2});
  assert.equal(queried.items[0].fleaPrice,60000);
  assert.equal(queried.items[0].quoteUpdated,stamp);
  assert.ok(Math.abs(queried.items[0].costPerEfficiency - 60000 / (7/12)) < 1e-8);
});
