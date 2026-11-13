// Transport adaptation only. Rust remains authoritative for prices and storage math.
export const MODES = Object.freeze({pvp:{path:'regular',label:'Standard PvP'},pve:{path:'pve',label:'PvE'},seasonal:{path:'pvp-season',label:'Seasonal PvP'}});
const BASE='https://json.tarkov.dev/';
const METADATA_TTL=6*60*60*1000;
const dictionaryCache=new Map();

export async function getResource(resource,{etag,fetcher=fetch}={}) {
  const response=await fetcher(BASE+resource,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/json','User-Agent':'Stashwise/0.2 storage-comparison','Cache-Control':'no-cache',...(etag?{'If-None-Match':etag}:{})}});
  if(response.status===304)return {unchanged:true,etag};
  if(!response.ok)throw new Error(`JSON source returned HTTP ${response.status}`);
  // Cap decoded bytes too: compressed content-length is not an allocation bound.
  const reader=response.body.getReader();const chunks=[];let size=0;
  try { for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32*1024*1024)throw new Error('JSON source exceeds the catalogue size limit');chunks.push(value);} }
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(!body.data||typeof body.data!=='object')throw new Error('Incomplete JSON resource');
  return {data:body.data,etag:response.headers.get('etag'),bytes:size};
}

async function dictionary(resource,fetcher,force=false) {
  const old=dictionaryCache.get(resource);
  if(!force&&old&&Date.now()-old.checkedAt<METADATA_TTL)return old.data;
  const result=await getResource(resource,{etag:old?.etag,fetcher});
  if(result.unchanged&&!old)throw new Error('Source returned 304 without a local resource');
  const value={data:result.unchanged?old.data:result.data,etag:result.etag,checkedAt:Date.now()};
  dictionaryCache.set(resource,value); // At most three modes × three known resources.
  return value.data;
}

export function adaptBulk(itemsData,translations,traders,traderTranslations) {
  const all=Object.values(itemsData.items||{});
  const storage=all.filter(item=>(item.types?.some(type=>['rig','backpack','container'].includes(type))||['ItemPropertiesContainer','ItemPropertiesChestRig','ItemPropertiesBackpack'].includes(item.properties?.propertiesType))&&item.properties?.grids?.length);
  if(!storage.some(i=>i.types.includes('rig'))||!storage.some(i=>i.types.includes('backpack'))||!storage.some(i=>i.types.includes('container')))
    throw new Error('Incomplete JSON storage catalogue');
  const translate=(key)=>typeof translations[key]==='string'?translations[key]:'';
  const referenced=new Set();
  const items=storage.map(item=>{
    const name=translate(item.name);
    if(!name)throw new Error('Storage item translation is missing');
    for(const grid of item.properties.grids)for(const ids of Object.values(grid.filters||{}))if(Array.isArray(ids))for(const id of ids)referenced.add(id);
    const offers=(item.buyFromTrader||[]).map(offer=>{
      const trader=traders[offer.trader];
      const traderName=traderTranslations[trader?.name];
      if(!traderName)throw new Error('Trader translation is missing');
      return {...offer,traderName};
    });
    // Carry just the input fields needed by the established Rust normaliser.
    return {id:item.id,name,shortName:translate(item.shortName)||name,description:translate(item.description),
      width:item.width,height:item.height,weight:item.weight,types:item.types,
      iconLink:item.iconLink,image512pxLink:item.image512pxLink,wikiLink:item.wikiLink,
      properties:{...item.properties,__typename:item.properties.propertiesType},
      buyFromTrader:offers,lastLowPrice:item.lastLowPrice,avg24hPrice:item.avg24hPrice,
      quoteUpdated:item.types.includes('noFlea')||!item.lastLowPrice?item.updated||null:item.lastScan||null,source:'Tarkov.dev JSON'};
  });
  const categories=[...Object.values(itemsData.itemCategories||{}),...all.filter(i=>referenced.has(i.id))]
    .map(item=>({id:item.id,name:translate(item.name)})).filter(i=>i.name);
  const fitCategories=Object.values(itemsData.itemCategories||{}).map(item=>({id:item.id,name:translate(item.name),parent:item.parent||''})).filter(item=>item.name);
  return {items,categories,fitCategories,source:'Tarkov.dev JSON',sourceUrl:'https://tarkov.dev/api/',warnings:[]};
}

export async function fetchBulk(mode,{previous,progress=()=>{},fetcher=fetch,now=Date.now()}={}) {
  const market=MODES[mode];if(!market)throw new Error('Invalid game mode');
  const prefix=market.path;
  const old=previous?.source==='Tarkov.dev JSON'&&previous.upstream?.adapterVersion===3?previous:null;
  progress('Checking the storage catalogue…');
  let resource=await getResource(`${prefix}/items`,{etag:old?.upstream?.etag,fetcher});
  if(resource.unchanged&&old&&now-(old.upstream?.metadataCheckedAt||0)<METADATA_TTL)
    return {unchanged:true,upstream:old.upstream};
  if(resource.unchanged)resource=await getResource(`${prefix}/items`,{fetcher});
  progress('Resolving names and trader offers…');
  let dictionaries=await Promise.all([`${prefix}/items_en`,`${prefix}/traders`,`${prefix}/traders_en`].map(p=>dictionary(p,fetcher)));
  let adapted;
  try { adapted=adaptBulk(resource.data,...dictionaries); }
  catch(error) {
    if(!/translation is missing/.test(error.message))throw error;
    dictionaries=await Promise.all([`${prefix}/items_en`,`${prefix}/traders`,`${prefix}/traders_en`].map(p=>dictionary(p,fetcher,true)));
    adapted=adaptBulk(resource.data,...dictionaries);
  }
  return {...adapted,requiredCategories:['rig','armored-rig','backpack','container','secure'],upstream:{adapterVersion:3,etag:resource.etag,metadataCheckedAt:now}};
}
