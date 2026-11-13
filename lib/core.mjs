import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const executable=`stashwise-core${process.platform === 'win32' ? '.exe' : ''}`;
const packaged=fileURLToPath(new URL(`../bin/${executable}`,import.meta.url));
export const corePath = process.env.STASHWISE_CORE || (existsSync(packaged)?packaged:fileURLToPath(new URL(`../target/release/${executable}`, import.meta.url)));

export function runCore(request, binary = corePath, {signal} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('The comparison engine timed out.')); }, 15000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', data => {
      size += data.length;
      if (size > 24 * 1024 * 1024) { child.kill(); reject(new Error('Catalogue response is too large.')); }
      else chunks.push(data);
    });
    child.stderr.on('data', data => { stderr += data.toString().slice(0, 3000); });
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (code !== 0 || data.error) reject(new Error(data.error || stderr || 'Comparison failed.'));
        else resolve(data);
      } catch { reject(new Error(stderr || 'The comparison engine did not return valid data.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
