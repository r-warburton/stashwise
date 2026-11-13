// Both distributions use the same UI. Pages performs requests inside a worker;
// the local package retains its existing HTTP API.
const pages=globalThis.document?.documentElement.dataset.distribution==='pages';
let worker=null,sequence=0;
const pending=new Map();
function stop(message){
  worker?.terminate();worker=null;
  for(const request of pending.values())request.reject(new Error(message));
  pending.clear();
}
function getWorker(){
  if(worker)return worker;
  worker=new Worker(new URL('./pages-worker.js',import.meta.url),{type:'module'});
  worker.onmessage=({data})=>{const request=pending.get(data.id);if(!request)return;pending.delete(data.id);request.resolve(new Response(data.status===304?null:JSON.stringify(data.body),{status:data.status,headers:data.headers}));};
  worker.onerror=event=>{event.preventDefault();stop('The browser calculation engine could not load. Please retry.');};
  worker.onmessageerror=()=>stop('The browser calculation engine returned an unreadable response. Please retry.');
  return worker;
}
export async function apiFetch(path,options={}){
  if(!pages)return fetch(path,options);
  if(options.signal?.aborted)throw new DOMException('Request cancelled','AbortError');
  const id=++sequence;
  let timer,abort;
  try{return await new Promise((resolve,reject)=>{
    const client=getWorker();
    pending.set(id,{resolve,reject});
    abort=()=>{pending.delete(id);reject(new DOMException('Request cancelled','AbortError'));};
    options.signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{pending.delete(id);reject(new Error('The published snapshot took too long to load. Please retry.'));},45000);
    client.postMessage({id,path,method:options.method||'GET',headers:Object.fromEntries(new Headers(options.headers).entries())});
  });}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
