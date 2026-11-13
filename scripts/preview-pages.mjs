import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const directory=path.resolve(process.argv[2]||'dist/pages'),port=Number(process.env.PORT||4319),prefix='/stashwise/';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/stashwise'){res.writeHead(301,{Location:prefix});return res.end();}
    if(!pathname.startsWith(prefix)||!['GET','HEAD'].includes(req.method)){res.writeHead(404);return res.end();}
    const target=path.resolve(directory,pathname.slice(prefix.length)||'index.html');
    if(!target.startsWith(directory+path.sep)){res.writeHead(403);return res.end();}
    const body=await readFile(target),etag='"'+createHash('sha256').update(body).digest('hex')+'"';
    const headers={'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache',ETag:etag};
    if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
    res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404);res.end();}
}).listen(port,'127.0.0.1',()=>console.log(`Static Pages preview: http://127.0.0.1:${port}${prefix}`));
