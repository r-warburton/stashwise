import { readFile, writeFile } from 'node:fs/promises';
const source = JSON.parse(await readFile(new URL('../public/tokens.json',import.meta.url),'utf8'));
const css = `/* Generated from tokens.json revision ${source.revision}. */\n:root {\n${Object.entries(source.tokens).map(([key,value])=>`  --${key}: ${value};`).join('\n')}\n}\n`;
await writeFile(new URL('../public/tokens.css',import.meta.url),css);
