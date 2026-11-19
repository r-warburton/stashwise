import {requestQuery} from './query.mjs';
import {plannerOptions} from './planner.mjs';
import {BoundedCache,summaryItem} from './http-cache.mjs';

export const MODES={pvp:'Standard PvP',pve:'PvE',seasonal:'Seasonal PvP'};
export const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
export function validateManifest(value){
  if(value?.version!==1||!Number.isFinite(Date.parse(value.publishedAt)))throw new Error('Invalid published manifest.');
  for(const mode of Object.keys(MODES)){
    const row=value.modes?.[mode];
    if(!row||!new RegExp(`^data/${mode}-[a-f0-9]{64}\\.json$`).test(row.file)||!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error('Incomplete published markets.');
  }
  return value;
}
export function snapshotMeta(snapshot,manifest,now,error){
  const times=snapshot.items.map(item=>Date.parse(item.quoteUpdated||'')).filter(Number.isFinite);
  const oldest=times.length?Math.min(...times):null,newest=times.length?Math.max(...times):null;
  const checkTime=Date.parse(snapshot.checkedAt);
  const checkDelayed=!Number.isFinite(checkTime)||now-checkTime>30*60000||checkTime>now+60000;
  return {source:snapshot.source,sourceUrl:snapshot.sourceUrl,checkedAt:snapshot.checkedAt,
    quoteUpdated:oldest?new Date(oldest).toISOString():null,newestQuoteUpdated:newest?new Date(newest).toISOString():null,
    stale:Boolean(error||snapshot.lastError)||times.length!==snapshot.items.length||!oldest||now-oldest>15*60000||newest>now+60000||checkDelayed,
    warnings:snapshot.warnings||[],lastError:error||snapshot.lastError||null,refreshing:false,revision:snapshot.revision,modeLabel:MODES[snapshot.mode],
    distribution:'pages',publishedAt:manifest.publishedAt,refreshEverySeconds:900,checkDelayed,
    refreshMessage:checkDelayed?'The published price check is overdue. GitHub has not published a recent successful source check; reloading cannot start one.':'Latest published snapshot checked. Source checks are requested every 15 minutes, but GitHub can delay or skip them.'};
}
export function createPagesEngine({baseUrl,core,fetcher=fetch,now=Date.now,onError=()=>{}}={}){
  const snapshots=new Map(),loads=new Map(),errors=new Map(),attempts=new Map(),results=new BoundedCache();
  let manifest=null,manifestLoad=null,manifestAttempt=-Infinity,manifestError=null;
  async function bytesAt(file,maxBytes){
    const response=await fetcher(new URL(file,baseUrl),{cache:'no-cache',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`Published data returned HTTP ${response.status}.`);
    const reader=response.body.getReader(),parts=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new Error('Published data is too large.');parts.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
  }
  async function publication(force=false){
    if(manifestLoad)return manifestLoad;
    if(manifest&&now()-manifestAttempt<60000&&!force)return manifest;
    manifestAttempt=now();
    manifestLoad=(async()=>{
      try{const next=validateManifest(JSON.parse(new TextDecoder().decode(await bytesAt('data/manifest.json',32768))));manifest=next;manifestError=null;}
      catch(error){manifestError='The latest published snapshot could not be checked. Showing previously loaded data.';if(!manifest)throw error;}
      return manifest;
    })().finally(()=>manifestLoad=null);
    return manifestLoad;
  }
  async function snapshot(mode,force=false){
    const published=await publication(force),entry=published.modes[mode];
    const attempt=attempts.get(mode),cooling=snapshots.has(mode)&&attempt?.hash===entry.sha256&&errors.has(mode)&&now()-attempt.at<60000&&!force;
    if(snapshots.get(mode)?.hash!==entry.sha256&&!cooling){
      if(!loads.has(mode))loads.set(mode,(async()=>{
        attempts.set(mode,{hash:entry.sha256,at:now()});
        try{
          const bytes=await bytesAt(entry.file,4*1024*1024);
          if(await digest(bytes)!==entry.sha256)throw new Error('Published snapshot integrity check failed.');
          const value=JSON.parse(new TextDecoder().decode(bytes));
          if(value.version!==1||value.mode!==mode||!value.items?.length||!Number.isFinite(Date.parse(value.checkedAt))||!value.revision)throw new Error('Invalid published snapshot.');
          await core({op:'query',items:value.items,categories:value.fitCategories||[],query:{}});
          snapshots.set(mode,{hash:entry.sha256,value});errors.delete(mode);
        }catch(error){errors.set(mode,'The latest market snapshot could not be loaded. Showing previously loaded data.');if(!snapshots.has(mode))throw error;}
      })().finally(()=>loads.delete(mode)));
      await loads.get(mode);
    }
    const value=snapshots.get(mode).value;
    return {...value,meta:snapshotMeta(value,published,now(),errors.get(mode)||manifestError)};
  }
  async function request({path,method='GET',headers={}}){
    const response=(status,body,extra={})=>({status,body,headers:{'Content-Type':'application/json',...extra}});
    try{
      const url=new URL(path,'https://stashwise.invalid');
      const mode=url.searchParams.get('mode')||'pvp';
      if(!Object.hasOwn(MODES,mode))return response(400,{error:'Invalid game mode.'});
      if(url.pathname==='/api/status')return response(200,{ready:snapshots.has(mode),refreshing:loads.has(mode),progress:loads.has(mode)?'Loading published snapshot…':''});
      if(url.pathname==='/api/refresh'&&method==='POST')return response(200,(await snapshot(mode,true)).meta);
      const detail=url.pathname.match(/^\/api\/items\/([a-zA-Z0-9_-]{1,64})$/)?.[1];
      const comparison=url.pathname==='/api/compare',options=url.pathname==='/api/planner-options';
      if(method!=='GET'||!(url.pathname==='/api/items'||detail||comparison||options))return response(404,{error:'API route not found.'});
      const query=requestQuery(url.searchParams,{comparison,detail,options}),saved=await snapshot(mode);
      const full=Boolean(detail)||url.searchParams.get('projection')!=='summary';
      const key=JSON.stringify([saved.revision,mode,query,full,comparison,options]);
      let result=results.get(key);
      if(!result){
        const data=options?plannerOptions(saved):await core({op:comparison?'compare':'query',items:saved.items,categories:saved.fitCategories||[],query});
        result=options||comparison?data:detail?{item:data.items[0]||null}:{...data,items:full?data.items:data.items.map(summaryItem)};
        if(detail&&!result.item)return response(404,{error:'This item is not in the current catalogue.'});
        results.set(key,result);
      }
      const etag=`"${(await digest(`0.4:${key}`)).slice(0,24)}"`;
      const metadata={ETag:etag,'X-Stashwise-Meta':encodeURIComponent(JSON.stringify(saved.meta))};
      if(headers['if-none-match']===etag)return response(304,null,metadata);
      return response(200,{...result,mode,meta:saved.meta},metadata);
    }catch(error){onError(error);const validation=/Invalid|Unknown|Choose|too long|at most/.test(error.message);return response(validation?400:503,{error:validation?error.message:'The published item snapshot could not be loaded. Please retry shortly.'});}
  }
  return {request};
}
