import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,rm,cp,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runCore,corePath} from '../lib/core.mjs';
import {createPagesEngine,digest,validateManifest,snapshotMeta,MODES} from '../lib/pages-engine.mjs';
import {publishSnapshots} from '../lib/pages-publish.mjs';
import {CatalogStore} from '../lib/feed.mjs';
import {importPreferences,emptyPreferences,defaults,fields} from '../public/preferences.js';
import init,{run_json} from '../.cache/wasm-web/stashwise_core.js';

await init({module_or_path:await readFile(new URL('../.cache/wasm-web/stashwise_core_bg.wasm',import.meta.url))});
const wasm=async input=>{const data=JSON.parse(run_json(JSON.stringify(input)));if(data.error)throw new Error(data.error);return data;};
const stamp='2026-11-13T18:00:00.000Z',now=Date.parse(stamp);
const raw=(id,type)=>({id,name:id==='secure'?'Secure container example':id,width:2,height:2,types:[type],quoteUpdated:stamp,lastLowPrice:id==='secure'?null:45000,avg24hPrice:50000,
  buyFromTrader:id==='secure'?[]:[{traderName:'Ragman',traderId:'ragman',price:30000,priceRUB:30000,currency:'RUB',minTraderLevel:2}],
  properties:{capacity:8,grids:[{width:2,height:2},{width:1,height:4}]}});
const raws=[raw('rig','rig'),raw('pack','backpack'),raw('case','container'),raw('secure','container')];
const normalized=await runCore({op:'normalize',items:raws});
async function dataset(price=45000){
  const files=new Map(),modes={};
  for(const mode of Object.keys(MODES)){
    const items=normalized.items.map(item=>({...item,fleaPrice:item.id==='secure'?null:price+(mode==='pve'?10000:0)}));
    const snapshot={version:1,mode,checkedAt:stamp,source:'Fixture',sourceUrl:'https://example.invalid',items,fitCategories:[],revision:await digest(JSON.stringify(items))};
    const bytes=JSON.stringify(snapshot),sha256=await digest(bytes),file=`data/${mode}-${sha256}.json`;
    files.set('/stashwise/'+file,bytes);modes[mode]={file,sha256};
  }
  const manifest={version:1,publishedAt:stamp,modes};files.set('/stashwise/data/manifest.json',JSON.stringify(manifest));
  return {files,manifest};
}
const transport=data=>async url=>new Response(data.files.get(new URL(url).pathname)||'missing',{status:data.files.has(new URL(url).pathname)?200:404});
async function temporary(t){const base=fileURLToPath(new URL('../.cache/',import.meta.url));await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'qa-pages-'));assert.ok(dir.startsWith(base));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('WebAssembly and native Rust agree on every sort, price source, shape, access and comparison',async()=>{
  assert.deepEqual(await wasm({op:'normalize',items:raws}),normalized);
  const requests=[];
  for(const [field]of fields)for(const direction of ['asc','desc'])requests.push({op:'query',items:normalized.items,query:{sort:[{field,direction},{field:'cost',direction:'asc'}]}});
  for(const source of ['best','trader','flea','average'])for(const level of [null,1,2,4])requests.push({op:'query',items:normalized.items,query:{source,access:{enabled:true,flea:false,traders:{ragman:level}},shape:{width:2,height:2,rotate:true}}});
  for(const shape of [{width:2,height:2},{width:4,height:1,rotate:false},{width:4,height:1,rotate:true},{width:1,height:4,categoryId:'unknown'}])requests.push({op:'query',items:normalized.items,query:{shape}});
  requests.push({op:'compare',items:normalized.items,query:{lines:[{id:'rig',quantity:3},{id:'secure',quantity:2},{id:'missing',quantity:1}]}});
  for(const request of requests)assert.deepEqual(await wasm(request),await runCore(request));
  for(const request of [{op:'query',items:normalized.items,query:{sort:[{field:'bad'}]}},{op:'compare',items:normalized.items,query:{lines:[{id:'rig',quantity:0}]}}]){
    await assert.rejects(wasm(request));await assert.rejects(runCore(request));
  }
});

test('Pages fetches only selected storage snapshots, coalesces loads and reuses unchanged results',async()=>{
  const data=await dataset(),calls=[];
  const engine=createPagesEngine({baseUrl:'https://example.invalid/stashwise/',core:wasm,now:()=>now,fetcher:async url=>{calls.push(new URL(url).pathname);return transport(data)(url);}});
  const responses=await Promise.all(Array.from({length:8},()=>engine.request({path:'/api/items?projection=summary'})));
  assert.ok(responses.every(r=>r.status===200));assert.equal(calls.filter(p=>p.endsWith('manifest.json')).length,1);assert.equal(calls.length,2);
  assert.equal(responses[0].body.items[0].grids,undefined);assert.equal(responses[0].body.meta.distribution,'pages');
  const unchanged=await engine.request({path:'/api/items?projection=summary',headers:{'if-none-match':responses[0].headers.ETag}});
  assert.equal(unchanged.status,304);assert.equal(unchanged.body,null);assert.equal(calls.length,2);
  const detail=await engine.request({path:'/api/items/rig?shape='+encodeURIComponent(JSON.stringify({width:10,height:10}))});assert.equal(detail.status,200);assert.ok(detail.body.item.grids.length);
  const pve=await engine.request({path:'/api/items?mode=pve&source=flea'});assert.equal(pve.body.items.find(i=>i.id==='rig').cost,55000);assert.equal(calls.length,3);
  const mine=await engine.request({path:'/api/items?access='+encodeURIComponent(JSON.stringify({enabled:true,flea:false,traders:{ragman:1}}))});assert.equal(mine.body.items.find(i=>i.id==='rig').cost,null);
  assert.equal((await engine.request({path:'/api/items?sort=bad'})).status,400);assert.equal((await engine.request({path:'/api/items?mode=wrong'})).status,400);
  assert.equal((await engine.request({path:'/api/items/missing'})).status,404);assert.equal((await engine.request({path:'/api/planner-options'})).body.traders.length,1);
});

test('failed publication and corrupt snapshots retain usable data and quote times; manual retry recovers',async()=>{
  let data=await dataset(),time=now,failManifest=false,corrupt=false,calls=0;
  const engine=createPagesEngine({baseUrl:'https://example.invalid/stashwise/',core:wasm,now:()=>time,fetcher:async url=>{
    calls++;const file=new URL(url).pathname;if(failManifest&&file.endsWith('manifest.json'))throw new Error('offline');
    if(corrupt&&!file.endsWith('manifest.json'))return new Response('bad data');return transport(data)(url);
  }});
  const first=await engine.request({path:'/api/items?source=flea'});time+=61000;failManifest=true;
  const retained=await engine.request({path:'/api/items?source=flea'});assert.equal(retained.status,200);assert.equal(retained.body.items[0].cost,first.body.items[0].cost);assert.equal(retained.body.meta.checkedAt,stamp);assert.ok(retained.body.meta.lastError);
  failManifest=false;data=await dataset(75000);corrupt=true;await engine.request({path:'/api/refresh',method:'POST'});
  const bad=await engine.request({path:'/api/items?source=flea'});assert.ok(bad.body.meta.lastError);assert.equal(bad.body.items.find(i=>i.id==='rig').cost,45000);
  const before=calls;await engine.request({path:'/api/items?search=rig'});assert.equal(calls,before,'bad data is not retried for every filter');
  corrupt=false;const retry=await engine.request({path:'/api/refresh',method:'POST'});assert.equal(retry.status,200);assert.equal(retry.body.lastError,null);
  const updated=await engine.request({path:'/api/items?source=flea'});assert.equal(updated.body.items.find(i=>i.id==='rig').cost,75000);assert.notEqual(updated.headers.ETag,first.headers.ETag);
});

test('initial broken/incomplete/mismatched snapshots cannot masquerade as a loaded market',async()=>{
  const data=await dataset();delete data.manifest.modes.pve;assert.throws(()=>validateManifest(data.manifest),/Incomplete/);
  const engine=createPagesEngine({baseUrl:'https://example.invalid/stashwise/',core:wasm,fetcher:async()=>new Response('{}')});assert.notEqual((await engine.request({path:'/api/items'})).status,200);
  const valid=await dataset();valid.files.set('/stashwise/'+valid.manifest.modes.pvp.file,valid.files.get('/stashwise/'+valid.manifest.modes.pve.file));
  const mismatch=createPagesEngine({baseUrl:'https://example.invalid/stashwise/',core:wasm,fetcher:transport(valid)});assert.equal((await mismatch.request({path:'/api/items'})).status,503);
});

test('publisher recovers all markets from the previous deployment on source failure without redating',async t=>{
  const dir=await temporary(t),cacheDir=path.join(dir,'cache'),outputDir=path.join(dir,'site'),data=await dataset();
  const store=new CatalogStore(cacheDir,{core:wasm,now:()=>now+3600000,loader:async()=>{throw new Error('source offline');},onError:()=>{}});
  const manifest=await publishSnapshots({cacheDir,outputDir,previousUrl:'https://example.invalid/stashwise/',fetcher:transport(data),store,core:wasm,now:()=>now+3600000,onWarning:()=>{}});
  for(const mode of Object.keys(MODES)){
    const snapshot=JSON.parse(await readFile(path.join(outputDir,manifest.modes[mode].file),'utf8'));
    assert.equal(snapshot.checkedAt,stamp);assert.equal(snapshot.items[0].quoteUpdated,stamp);assert.ok(snapshot.lastError);
    assert.equal(await digest(await readFile(path.join(outputDir,manifest.modes[mode].file))),manifest.modes[mode].sha256);
    assert.ok(await readFile(path.join(outputDir,data.manifest.modes[mode].file)));
  }
});

test('publisher refuses an empty first deployment rather than replacing a good site with partial data',async t=>{
  const dir=await temporary(t),cacheDir=path.join(dir,'cache'),outputDir=path.join(dir,'site');
  const store=new CatalogStore(cacheDir,{core:wasm,loader:async()=>{throw new Error('offline');},onError:()=>{}});
  await assert.rejects(publishSnapshots({cacheDir,outputDir,store,core:wasm,onWarning:()=>{}}));
  await assert.rejects(readFile(path.join(outputDir,'data/manifest.json')));
});

test('Pages marks delayed scheduled checks stale independently of recent source quote times',()=>{
  const snapshot={mode:'pvp',checkedAt:new Date(now-31*60000).toISOString(),items:[{quoteUpdated:stamp}]};
  assert.equal(snapshotMeta(snapshot,{publishedAt:stamp},now,null).stale,true);
});

test('portable preference exports retain all user choices and reject invalid files before replacement',()=>{
  const prefs=emptyPreferences();prefs.lastView={...defaults,mode:'pve',shapeEnabled:true};prefs.favorites=['rig'];prefs.views=[{id:'view1',name:'My rigs',state:prefs.lastView}];prefs.comparison=[{id:'rig',quantity:3}];prefs.accessProfiles.pve={enabled:true,flea:true,traders:{ragman:3},quests:['quest-1']};
  assert.deepEqual(importPreferences(JSON.stringify(prefs)),prefs);
  assert.equal(importPreferences(JSON.stringify({...prefs,version:1})).version,2);
  for(const input of ['{broken','{}',JSON.stringify({...prefs,version:99}),' '.repeat(129*1024)])assert.throws(()=>importPreferences(input));
  assert.equal(importPreferences(JSON.stringify({...prefs,catalogue:{private:'not retained'}})).catalogue,undefined);
});

test('Pages builds in a clean checkout without dist and refuses to overwrite an existing release',async t=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),dir=await temporary(t),data=await dataset();
  for(const folder of ['lib','public'])await cp(path.join(root,folder),path.join(dir,folder),{recursive:true});
  await mkdir(path.join(dir,'scripts'));await mkdir(path.join(dir,'.cache/wasm-web'),{recursive:true});
  for(const file of ['scripts/build-pages.mjs','Cargo.lock'])await cp(path.join(root,file),path.join(dir,file));
  for(const file of ['stashwise_core.js','stashwise_core_bg.wasm'])await cp(path.join(root,'.cache/wasm-web',file),path.join(dir,'.cache/wasm-web',file));
  for(const mode of Object.keys(MODES))await writeFile(path.join(dir,'.cache',`${mode}.json`),data.files.get('/stashwise/'+data.manifest.modes[mode].file));
  const env={...process.env,STASHWISE_CORE:corePath,CARGO_HOME:process.env.CARGO_HOME||(existsSync(path.join(root,'.cargo-home'))?path.join(root,'.cargo-home'):path.join(homedir(),'.cargo'))};
  assert.equal(existsSync(path.join(dir,'dist')),false);
  await promisify(execFile)(process.execPath,['scripts/build-pages.mjs','--cached'],{cwd:dir,env});
  const html=await readFile(path.join(dir,'dist/pages/index.html'),'utf8');
  assert.match(html,/data-distribution="pages"/);assert.ok(!html.includes('href="/"'));assert.match(html,/\.\/assets\//);
  assert.ok(await readFile(path.join(dir,'dist/pages/THIRD-PARTY-NOTICES.txt')));
  await assert.rejects(promisify(execFile)(process.execPath,['scripts/build-pages.mjs','--cached'],{cwd:dir,env}),/EEXIST/);
  assert.equal(await readFile(path.join(dir,'dist/pages/index.html'),'utf8'),html);
});
