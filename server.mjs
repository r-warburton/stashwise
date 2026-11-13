import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runCore,corePath} from './lib/core.mjs';
import {CatalogStore} from './lib/feed.mjs';
import {MODES} from './lib/bulk.mjs';
import {BoundedCache,summaryItem} from './lib/http-cache.mjs';
import {boundedLogger} from './lib/log.mjs';
import {plannerOptions} from './lib/planner.mjs';
import {requestQuery} from './lib/query.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon'};
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
function reply(res,status,data){if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}

export function createApp({store,core=runCore,publicRoot=path.join(root,'public'),onError=()=>{}}={}) {
  const results=new BoundedCache();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https://assets.tarkov.dev data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const port=req.socket.localPort;
    const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`]);
    if(!allowedHosts.has(req.headers.host))return reply(res,403,{error:'This local app only accepts localhost requests.'});
    if(req.url.length>10000)return reply(res,414,{error:'Request is too long.'});
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      const url=new URL(req.url,`http://127.0.0.1:${port}`);
      if(url.pathname==='/api/health')return reply(res,200,{ok:true,app:'stashwise',version:'0.4.0'});
      if(url.pathname.startsWith('/api/')){
        const mode=url.searchParams.get('mode')||'pvp';if(!MODES[mode])return reply(res,400,{error:'Invalid game mode.'});
        if(url.pathname==='/api/status'&&req.method==='GET')return reply(res,200,store.status(mode));
        if(url.pathname==='/api/refresh'&&req.method==='POST'){
          if(req.headers.origin&&!allowedHosts.has(new URL(req.headers.origin).host))return reply(res,403,{error:'Invalid origin.'});
          const snapshot=await store.get(mode,true);return reply(res,200,snapshot.meta);
        }
        const detail=url.pathname.match(/^\/api\/items\/([a-zA-Z0-9_-]{1,64})$/);
        const comparison=url.pathname==='/api/compare',options=url.pathname==='/api/planner-options';
        if((url.pathname==='/api/items'||detail||comparison||options)&&req.method==='GET'){
          const q=url.searchParams;
          const query=requestQuery(q,{options,comparison,detail:detail?.[1]});
          const snapshot=await store.get(mode);
          if(controller.signal.aborted)return;
          // Older already-open clients expect full rows. New clients opt into
          // summaries explicitly so a server upgrade does not break their tab.
          const full=Boolean(detail)||q.get('projection')!=='summary';
          const key=JSON.stringify([snapshot.revision,mode,query,full,comparison,options]);
          let result=results.get(key);
          if(!result){
            if(options)result=plannerOptions(snapshot);
            else {
              const data=await core({op:comparison?'compare':'query',items:snapshot.items,categories:snapshot.fitCategories||[],query},corePath,{signal:controller.signal});
              result=comparison?data:detail?{item:data.items[0]||null}:{...data,items:full?data.items:data.items.map(summaryItem)};
            }
            if(detail&&!result.item)return reply(res,404,{error:'This item is not in the current catalogue.'});
            results.set(key,result);
          }
          const etag=`"${hash(`0.4:${key}`)}"`;
          const meta={...snapshot.meta,revision:snapshot.revision,modeLabel:MODES[mode].label};
          const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-cache',ETag:etag,'X-Stashwise-Meta':encodeURIComponent(JSON.stringify(meta))};
          if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
          res.writeHead(200,headers);return res.end(JSON.stringify({...result,mode,meta}));
        }
        return reply(res,404,{error:'API route not found.'});
      }
      if(!['GET','HEAD'].includes(req.method))return reply(res,405,{error:'Method not allowed.'});
      const pathname=decodeURIComponent(url.pathname);
      const destination=path.resolve(publicRoot,`.${pathname==='/'?'/index.html':pathname}`);
      if(!destination.startsWith(publicRoot+path.sep))return reply(res,403,{error:'Invalid path.'});
      let data=await readFile(destination);
      if(path.extname(destination)==='.html'){
        let html=data.toString();
        for(const name of ['app.js','tokens.css','style.css','favicon.svg']){
          const version=hash(await readFile(path.join(publicRoot,name)));
          html=html.replaceAll(`"/${name}"`,`"/${name}?v=${version}"`);
        }
        data=Buffer.from(html);
      }
      const version=hash(data),etag=`"${version}"`;
      const headers={'Content-Type':types[path.extname(destination)]||'application/octet-stream','Cache-Control':url.searchParams.get('v')===version?'public, max-age=31536000, immutable':'no-cache',ETag:etag};
      if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
      res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:data);
    } catch(error){
      if(controller.signal.aborted||error.name==='AbortError')return;
      if(error.code==='ENOENT')return reply(res,404,{error:'File not found.'});
      onError(error.message);
      const validation=/Invalid|Unknown|Choose|too long|at most/.test(error.message);
      reply(res,validation?400:503,{error:validation?error.message:'The item feed could not be loaded. Please try again shortly.'});
    }
  });
  return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||4317),host=process.env.HOST||'127.0.0.1';
  const onError=boundedLogger(path.join(root,'logs'));
  const dataDir=process.env.STASHWISE_DATA||path.join(root,existsSync(path.join(root,'bin'))?'data':'.cache');
  const store=new CatalogStore(dataDir,{onError});
  const server=createApp({store,onError});
  server.listen(port,host,()=>console.log(`Stashwise is running at http://127.0.0.1:${port}`));
  const timer=setInterval(()=>store.tick(),60000);timer.unref();
  function shutdown(){clearInterval(timer);server.close(()=>process.exit(0));}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
