export class BoundedCache {
  constructor({maxEntries=64,maxBytes=5*1024*1024}={}) { this.entries=new Map();this.bytes=0;this.maxEntries=maxEntries;this.maxBytes=maxBytes; }
  get(key) { const value=this.entries.get(key);if(!value)return null;this.entries.delete(key);this.entries.set(key,value);return value.body; }
  set(key,body) {
    const bytes=new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if(this.entries.has(key)){this.bytes-=this.entries.get(key).bytes;this.entries.delete(key);}
    if(bytes>this.maxBytes)return;
    this.entries.set(key,{body,bytes});this.bytes+=bytes;
    while(this.entries.size>this.maxEntries||this.bytes>this.maxBytes){const first=this.entries.keys().next().value;this.bytes-=this.entries.get(first).bytes;this.entries.delete(first);}
  }
}
export function summaryItem(item) {
  const {description,grids,restrictions,exclusions,offers,largeImage,wiki,...summary}=item;
  return {...summary,restrictionLabel:restrictions.length&&!restrictions.includes('Item')
    ? `Stores: ${restrictions.filter(name=>!name.startsWith('Item/category ')).slice(0,3).join(', ')||'Specific items only'}`:null,
    pocketLayout:grids.map(({width,height})=>({width,height}))};
}
