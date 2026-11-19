import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchJson} from '../lib/feed.mjs';
import {runCore} from '../lib/core.mjs';
import {pocketMarkup} from '../public/pockets.js';

const raw={id:'safe',name:'Safe rig',types:['rig'],width:2,height:2,properties:{capacity:4,grids:[{width:2,height:2}]}};

test('legitimate feeds and partial layouts still pass the boundary',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response('{"price":123}');
  assert.deepEqual(await fetchJson('https://example.invalid/data'),{price:123});
  globalThis.fetch=async()=>new Response(new Uint8Array([239,187,191,...new TextEncoder().encode('{"price":456}')]));
  assert.deepEqual(await fetchJson('https://example.invalid/data'),{price:456},'Fetch JSON decoding accepts a UTF-8 BOM');
  const {items}=await runCore({op:'normalize',items:[raw]});
  assert.equal((await runCore({op:'query',items,query:{}})).items[0].pocketScore,4);
});

test('both pocket views reject excessive or malformed layouts before generating cells',()=>{
  for(const compact of [false,true]){
    for(const item of [
      {capacity:4,grids:[{width:100,height:100}]},
      {capacity:10000,grids:Array.from({length:129},()=>({width:1,height:1}))},
      {capacity:10000,grids:[{width:Number.MAX_SAFE_INTEGER,height:2}]},
      {capacity:4,grids:[{width:'2',height:2}]},
      {capacity:4,grids:[{width:0,height:2}]},
      {capacity:4,grids:[null]},
      {capacity:4,grids:{}},
    ]){
      const html=pocketMarkup(item,compact);
      assert.match(html,/Layout unavailable/);assert.ok(html.length<100);assert.ok(!html.includes('pocket-cell'));
    }
    assert.equal((pocketMarkup({capacity:8,grids:[{width:2,height:2}]},compact).match(/pocket-cell/g)||[]).length,4);
    assert.equal((pocketMarkup({capacity:196,grids:[{width:14,height:14}]},compact).match(/pocket-cell/g)||[]).length,196);
  }
});

test('provider body limit rejects streamed and compressed-length oversized JSON before parsing',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const headers of [{},{'content-length':'32','content-encoding':'gzip'}]){
    let pulls=0,cancelled=false;
    globalThis.fetch=async()=>new Response(new ReadableStream({
      pull(controller){pulls++;controller.enqueue(new TextEncoder().encode(pulls===1?'"'+ 'a'.repeat(1024*1024-1):'a'.repeat(1024*1024)));if(pulls===28){controller.enqueue(new TextEncoder().encode('"'));controller.close();}},
      cancel(){cancelled=true;},
    }),{headers});
    await assert.rejects(fetchJson('https://example.invalid/data'),/too large/);
    assert.ok(cancelled,'oversized reader is cancelled');assert.ok(pulls<=26);
  }
  globalThis.fetch=async()=>new Response('{"price":123}',{headers:{'content-length':'13'}});
  assert.deepEqual(await fetchJson('https://example.invalid/data'),{price:123});
});

test('normalization rejects unsafe layouts without accepting a truncated interpretation',async()=>{
  const invalid=[
    {...raw,id:'over-capacity',properties:{capacity:4,grids:[{width:100,height:100},{width:100,height:100}]}},
    {...raw,id:'many-pockets',properties:{capacity:10000,grids:Array.from({length:129},()=>({width:1,height:1}))}},
    {...raw,id:'bad-dimension',properties:{capacity:4,grids:[{width:2,height:2},{width:0,height:1}]}},
    {...raw,id:'top-level',properties:{capacity:4},grids:[{width:100,height:100}]},
  ];
  const result=await runCore({op:'normalize',items:[raw,...invalid]});
  assert.deepEqual(result.items.map(i=>i.id),['safe']);
  const partial=await runCore({op:'normalize',items:[{...raw,properties:{capacity:8,grids:[{width:2,height:2}]}}]});
  assert.equal(partial.items[0].pocketScore,null);assert.equal(partial.items[0].grids.length,1);
});

test('query and comparison reject poisoned cached layouts through the same Rust boundary',async()=>{
  const {items}=await runCore({op:'normalize',items:[raw]});
  for(const grids of [
    [{width:100,height:100,allowed:[],excluded:[]}],
    Array.from({length:129},()=>({width:1,height:1,allowed:[],excluded:[]})),
    [{width:Number.MAX_SAFE_INTEGER,height:100,allowed:[],excluded:[]}],
    [{width:0,height:1,allowed:[],excluded:[]}],
  ]){
    for(const op of ['query','compare']){
      await assert.rejects(runCore({op,items:[{...items[0],grids}],query:{comparison:[{id:'safe',quantity:1}]}}),/Invalid pocket layout/);
    }
  }
  assert.equal((await runCore({op:'query',items,query:{}})).items[0].pocketScore,4);
});

