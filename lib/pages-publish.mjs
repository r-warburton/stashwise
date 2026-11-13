import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CatalogStore} from './feed.mjs';
import {runCore} from './core.mjs';
import {MODES,digest,validateManifest} from './pages-engine.mjs';

export async function readPublishedFile(url,maxBytes,fetcher=fetch){
  const response=await fetcher(url,{cache:'no-cache',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Published source returned ${response.status}`);
  const reader=response.body.getReader(),parts=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new Error('Published source is too large');parts.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  return Buffer.concat(parts);
}
export async function validSnapshot(bytes,mode,core=runCore){
  const saved=JSON.parse(bytes.toString());
  if(saved.version!==1||saved.mode!==mode||!saved.items?.length||!Number.isFinite(Date.parse(saved.checkedAt)))throw new Error(`Invalid ${mode} snapshot`);
  const data=await core({op:'query',items:saved.items,categories:saved.fitCategories||[],query:{}});
  for(const category of ['rig','backpack','container','secure'])if(!data.items.some(item=>item.category===category))throw new Error(`Incomplete ${mode} storage categories`);
  return saved;
}
export async function publishSnapshots({cacheDir,outputDir,previousUrl,refresh=true,store,core=runCore,fetcher=fetch,now=Date.now,onWarning=console.warn}={}){
  await mkdir(cacheDir,{recursive:true});await mkdir(path.join(outputDir,'data'),{recursive:true});
  const previous=new Map();
  if(previousUrl){
    const base=new URL(previousUrl.endsWith('/')?previousUrl:previousUrl+'/');
    if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Previous deployment must be a public HTTPS base URL');
    try{
      const manifest=validateManifest(JSON.parse((await readPublishedFile(new URL('data/manifest.json',base),32768,fetcher)).toString()));
      for(const mode of Object.keys(MODES))try{
        const entry=manifest.modes[mode],bytes=await readPublishedFile(new URL(entry.file,base),4*1024*1024,fetcher);
        if(await digest(bytes)!==entry.sha256)throw new Error('Snapshot hash mismatch');
        await validSnapshot(bytes,mode,core);
        await writeFile(path.join(cacheDir,`${mode}.json`),bytes);previous.set(entry.file,bytes);
      }catch(error){onWarning(`Previous ${mode} snapshot unavailable: ${error.message}`);}
    }catch(error){onWarning(`Previous deployment unavailable: ${error.message}`);}
  }
  store??=new CatalogStore(cacheDir,{core,onError:onWarning});
  const modes={};
  for(const mode of Object.keys(MODES)){
    await store.loadDisk(mode);
    if(refresh)await store.refresh(mode);
    const state=store.state(mode);
    if(!state.snapshot)throw new Error(`No validated ${mode} snapshot; publication stopped.`);
    // Publish the small storage schema only. Never include logs, preferences or raw feeds.
    const saved=state.snapshot;
    const publicData={version:1,mode,items:saved.items,fitCategories:saved.fitCategories||[],source:saved.source,sourceUrl:saved.sourceUrl,
      checkedAt:saved.checkedAt,revision:saved.revision,warnings:saved.warnings||[],upstream:saved.upstream,lastError:state.lastError||(!refresh?saved.lastError:null)||null};
    const body=JSON.stringify(publicData),bytes=Buffer.from(body);await validSnapshot(bytes,mode,core);
    const sha256=await digest(bytes),file=`data/${mode}-${sha256}.json`;
    await writeFile(path.join(outputDir,file),bytes);
    modes[mode]={file,sha256,count:saved.items.length,checkedAt:saved.checkedAt};
  }
  // One previous generation keeps an already-open/CDN-cached manifest usable.
  for(const [file,bytes]of previous)await writeFile(path.join(outputDir,file),bytes);
  const manifest={version:1,publishedAt:new Date(now()).toISOString(),scheduledEverySeconds:900,modes};
  await writeFile(path.join(outputDir,'data/manifest.json'),JSON.stringify(manifest));
  return manifest;
}
