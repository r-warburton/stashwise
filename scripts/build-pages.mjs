import {mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {publishSnapshots} from '../lib/pages-publish.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const output=path.resolve(root,option('--out','dist/pages'));
if(!output.startsWith(path.join(root,'dist')+path.sep))throw new Error('Pages output must be a fresh directory under dist.');
await mkdir(path.dirname(output),{recursive:true});
await mkdir(output); // Deliberately refuse to overwrite an existing distribution.
const wasm=path.resolve(root,option('--wasm','.cache/wasm-web'));
const assets=new Map();
for(const name of await readdir(path.join(root,'public'))){
  if(name!=='index.html'&&/\.(js|css|json|svg)$/.test(name))assets.set(name,await readFile(path.join(root,'public',name)));
}
for(const name of ['query.mjs','planner.mjs','http-cache.mjs','pages-engine.mjs'])assets.set(`shared/${name}`,await readFile(path.join(root,'lib',name)));
for(const name of ['stashwise_core.js','stashwise_core_bg.wasm'])assets.set(`wasm/${name}`,await readFile(path.join(wasm,name)));
const buildHash=createHash('sha256');for(const [name,bytes]of assets)buildHash.update(name).update(bytes);
const assetDirectory=`assets/${buildHash.digest('hex').slice(0,20)}`;
for(const [name,bytes]of assets){const destination=path.join(output,assetDirectory,name);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes);}
let html=(await readFile(path.join(root,'public/index.html'),'utf8')).replace('<html lang="en">','<html lang="en" data-distribution="pages">').replaceAll('href="/"','href="./"').replaceAll('Refresh prices','Check published prices');
for(const name of ['app.js','tokens.css','style.css','favicon.svg'])html=html.replaceAll(`"/${name}"`,`"./${assetDirectory}/${name}"`);
const csp="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' https://assets.tarkov.dev data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'";
html=html.replace('<head>',`<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  <meta name="referrer" content="no-referrer">`);
await writeFile(path.join(output,'index.html'),html);await writeFile(path.join(output,'.nojekyll'),'');
const manifest=await publishSnapshots({cacheDir:path.join(root,args.includes('--cached')?'.cache':'.cache/pages-snapshots'),outputDir:output,
  previousUrl:process.env.PAGES_PREVIOUS_URL||undefined,refresh:!args.includes('--cached')});
await writeFile(path.join(output,'build.json'),JSON.stringify({version:'0.4.0',assets:assetDirectory,publishedAt:manifest.publishedAt}));
const registry=path.join(process.env.CARGO_HOME||path.join(homedir(),'.cargo'),'registry','src');
const lockfile=await readFile(path.join(root,'Cargo.lock'),'utf8');
const runtimePackages=new Set([...lockfile.matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"/g)].map(match=>`${match[1]}-${match[2]}`));
let notices='Stashwise dependency notices\n\nUnofficial fan tool. Escape from Tarkov and artwork belong to Battlestate Games. Data is attributed to Tarkov.dev and labelled fallback services in the app. No artwork or whole-game feed is bundled.\n';
for(const directory of await readdir(registry))for(const pkg of await readdir(path.join(registry,directory))){
  if(!runtimePackages.has(pkg))continue;
  const location=path.join(registry,directory,pkg);
  for(const file of (await readdir(location)).filter(name=>/^licen[sc]e(?:[-.]|$)/i.test(name))){try{notices+=`\n--- ${pkg} / ${file} ---\n${await readFile(path.join(location,file),'utf8')}\n`;}catch(error){if(error.code!=='EISDIR')throw error;}}
}
await writeFile(path.join(output,'THIRD-PARTY-NOTICES.txt'),notices);
// Persist check times in hosted job logs; a rebuilt fallback keeps its original checkedAt.
console.log(JSON.stringify({record:'stashwise-publication',output,assets:assetDirectory,
  runId:process.env.GITHUB_RUN_ID||null,event:process.env.GITHUB_EVENT_NAME||null,
  timerTick:process.env.STASHWISE_TIMER_TICK||null,observationStartedAt:process.env.STASHWISE_OBSERVATION_STARTED_AT||null,
  publishedAt:manifest.publishedAt,checkedAt:Object.fromEntries(Object.entries(manifest.modes).map(([mode,value])=>[mode,value.checkedAt])),
  items:Object.fromEntries(Object.entries(manifest.modes).map(([mode,value])=>[mode,value.count]))}));
