import {MODES,validateManifest} from './pages-engine.mjs';

export const TARGET_REFRESH_MS=15*60*1000;
// Allow for the previous build's latency so a regular 15-minute tick is not
// skipped just because its successful source check finished a little later.
export const EARLY_WINDOW_MS=60*1000;

export function publicationDecision(manifest,now=Date.now()){
  validateManifest(manifest);
  const checks=Object.keys(MODES).map(mode=>({mode,time:Date.parse(manifest.modes[mode].checkedAt)}));
  if(!Number.isFinite(now)||checks.some(({time})=>!Number.isFinite(time)||time>now+60000))
    return {publish:true,reason:'Missing or invalid market check time; publish a validated snapshot.'};
  const oldest=Math.min(...checks.map(({time})=>time)),ageMs=Math.max(0,now-oldest);
  const publish=ageMs>=TARGET_REFRESH_MS-EARLY_WINDOW_MS;
  return {publish,oldestCheckedAt:new Date(oldest).toISOString(),oldestAgeSeconds:Math.floor(ageMs/1000),
    reason:publish?'At least one market is due for a source check.':'Every market was checked recently; skip this build.'};
}

export async function checkPublication({baseUrl,fetcher=fetch,now=Date.now()}={}){
  try{
    const base=new URL(baseUrl);
    if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Invalid Pages URL');
    if(!base.pathname.endsWith('/'))base.pathname+='/';
    const response=await fetcher(new URL('data/manifest.json',base),{
      cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000),
      headers:{Accept:'application/json','Cache-Control':'no-cache'},
    });
    if(!response.ok)throw new Error('Manifest unavailable');
    if(!response.body)throw new Error('Manifest empty');
    const reader=response.body.getReader(),parts=[];let size=0;
    try{
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768)throw new Error('Manifest too large');parts.push(value);}
    }catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{reader.releaseLock();}
    return publicationDecision(JSON.parse(new TextDecoder().decode(Buffer.concat(parts,size))),now);
  }catch{
    // Failure to read the public manifest must never suppress a needed update.
    return {publish:true,reason:'The published check times could not be verified; attempt a normal publication.'};
  }
}

