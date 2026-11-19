import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {checkPublication,publicationDecision,TARGET_REFRESH_MS,EARLY_WINDOW_MS} from '../lib/pages-schedule.mjs';

const now=Date.parse('2026-11-19T18:00:00Z');
const manifest=(age=0)=>({version:1,publishedAt:new Date(now).toISOString(),modes:Object.fromEntries(['pvp','pve','seasonal'].map(mode=>[mode,{
  file:`data/${mode}-${'a'.repeat(64)}.json`,sha256:'a'.repeat(64),checkedAt:new Date(now-age).toISOString(),
}]))});

test('scheduled checks skip recent markets and become due with the build-latency allowance',()=>{
  assert.equal(publicationDecision(manifest(5*60000),now).publish,false);
  const threshold=TARGET_REFRESH_MS-EARLY_WINDOW_MS;
  assert.equal(publicationDecision(manifest(threshold-1),now).publish,false);
  assert.equal(publicationDecision(manifest(threshold),now).publish,true);
  const regular=publicationDecision(manifest(15*60000),now);
  assert.equal(regular.publish,true);assert.equal(regular.oldestAgeSeconds,900);
});

test('one delayed market requires a refresh even when the site was just published',()=>{
  const data=manifest(60000);data.modes.pve.checkedAt=new Date(now-7*3600000).toISOString();
  const result=publicationDecision(data,now);
  assert.equal(result.publish,true);assert.equal(result.oldestAgeSeconds,7*3600);
  assert.equal(result.oldestCheckedAt,data.modes.pve.checkedAt);
});

test('missing and future check timestamps cannot suppress an update',()=>{
  for(const checkedAt of [undefined,'invalid',new Date(now+61000).toISOString()]){
    const data=manifest();data.modes.seasonal.checkedAt=checkedAt;
    assert.equal(publicationDecision(data,now).publish,true);
  }
});

test('the due check reads only the bounded public manifest at the correct repository subpath',async()=>{
  const calls=[];
  const result=await checkPublication({baseUrl:'https://example.invalid/stashwise',now,fetcher:async(url,options)=>{
    calls.push(String(url));assert.equal(options.cache,'no-store');assert.equal(options.credentials,'omit');
    return new Response(JSON.stringify(manifest(60000)));
  }});
  assert.equal(result.publish,false);assert.deepEqual(calls,['https://example.invalid/stashwise/data/manifest.json']);
});

test('unavailable, incomplete or malformed publications cause a normal update attempt',async()=>{
  const incomplete=manifest();delete incomplete.modes.pve;
  for(const fetcher of [
    async()=>{throw Error('offline');},
    async()=>new Response('unavailable',{status:503}),
    async()=>new Response('{bad'),
    async()=>new Response(JSON.stringify(incomplete)),
    async()=>new Response(''),
  ]){
    const result=await checkPublication({baseUrl:'https://example.invalid/',now,fetcher});
    assert.equal(result.publish,true);assert.match(result.reason,/could not be verified/);
  }
  let called=false;
  const result=await checkPublication({baseUrl:'http://example.invalid/',now,fetcher:async()=>{called=true;}});
  assert.equal(result.publish,true);assert.equal(called,false);
});

test('oversized manifest streams are cancelled and cannot suppress refresh',async()=>{
  let cancelled=false,pulls=0;
  const result=await checkPublication({baseUrl:'https://example.invalid/',now,fetcher:async()=>new Response(new ReadableStream({
    pull(controller){pulls++;controller.enqueue(new Uint8Array(1024));if(pulls===40)controller.close();},
    cancel(){cancelled=true;},
  }),{headers:{'content-length':'1'}})});
  assert.equal(result.publish,true);assert.equal(cancelled,true);assert.ok(pulls<=34);
});

test('pushes and normal manual runs emit publish output without requiring a manifest request',async t=>{
  const dir=await mkdtemp(fileURLToPath(new URL('../.cache/cadence-',import.meta.url)));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const output=path.join(dir,'output'),summary=path.join(dir,'summary');
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/check-publication.mjs',import.meta.url))],{
    windowsHide:true,env:{...process.env,STASHWISE_SCHEDULE_CHECK:'false',PAGES_PREVIOUS_URL:'invalid',GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary},
  });
  assert.equal(JSON.parse(stdout).publish,true);
  assert.equal(await readFile(output,'utf8'),'publish=true\n');
  assert.match(await readFile(summary,'utf8'),/Code push or forced manual run/);
});

