import {appendFile,mkdir,rename,stat} from 'node:fs/promises';
import path from 'node:path';
export function boundedLogger(directory) {
  let pending=Promise.resolve();
  return message=>{
    pending=pending.then(async()=>{
      await mkdir(directory,{recursive:true});const filename=path.join(directory,'activity.log');
      const size=await stat(filename).then(s=>s.size,()=>0);
      if(size>=256*1024)await rename(filename,path.join(directory,'activity.previous.log'));
      await appendFile(filename,`${new Date().toISOString()} ${String(message).replace(/[\r\n]+/g,' ').slice(0,2000)}\n`);
    }).catch(()=>{});
  };
}
