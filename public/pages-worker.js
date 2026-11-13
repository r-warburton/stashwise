import init,{run_json} from './wasm/stashwise_core.js';
import {createPagesEngine} from './shared/pages-engine.mjs';
let wasmReady;
const engine=createPagesEngine({baseUrl:new URL('../../',import.meta.url),onError:error=>console.warn('Snapshot request failed:',error.message),core:async request=>{
  wasmReady??=init().catch(error=>{wasmReady=null;throw error;});
  await wasmReady;
  const result=JSON.parse(run_json(JSON.stringify(request)));
  if(result.error)throw new Error(result.error);
  return result;
}});
self.onmessage=async({data:{id,...request}})=>self.postMessage({id,...await engine.request(request)});
