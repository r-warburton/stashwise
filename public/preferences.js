export const STORAGE_KEY='stashwise.preferences.v2';
export const fields=[['efficiency','Efficiency'],['pocketScore','Pocket score'],['costPerEfficiency','Cost / efficiency'],['cost','Purchase cost'],['costPerGain','Cost / extra slot'],['costPerSlot','Cost / inside slot'],['gain','Extra slots'],['capacity','Internal slots'],['footprint','Stash footprint'],['traderPrice','Trader purchase'],['fleaPrice','Flea price'],['fleaAverage','24h flea average'],['name','Item name'],['category','Category'],['weight','Weight']];
export const columnPresets={space:['footprint','capacity','gain','efficiency','pocketScore','cost'],value:['gain','efficiency','cost','costPerGain','costPerEfficiency'],pockets:['pocketScore','layout','capacity','efficiency','cost'],all:fields.map(([key])=>key).filter(key=>key!=='name').concat('layout')};
export const defaults={mode:'pvp',category:'rigs',search:'',minEfficiency:'1.66',maxPrice:'',source:'best',sort:'efficiency',direction:'desc',then:'cost',thenDirection:'asc',positiveOnly:true,ids:null,view:'space',columns:[],density:'comfortable',mobile:'cards',shapeEnabled:false,shapeWidth:'2',shapeHeight:'2',shapeRotate:true,shapeCategory:'',accessMode:'all'};
const keySet=new Set(fields.map(([key])=>key));
const idPattern=/^[a-zA-Z0-9_-]{1,64}$/;
const finite=(value,min,max,fallback)=>value!==''&&Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max?String(Number(value)):fallback;
export function cleanView(input={}) {
  const view={...defaults,...input};
  if(!['pvp','pve','seasonal'].includes(view.mode))view.mode=defaults.mode;
  if(!['all','rigs','rig','armored-rig','backpack','container','secure'].includes(view.category))view.category=defaults.category;
  view.search=String(view.search||'').slice(0,200);
  view.minEfficiency=finite(view.minEfficiency,0,1000,defaults.minEfficiency);
  view.maxPrice=finite(view.maxPrice,0,1e12,'');
  if(!['best','trader','flea','average'].includes(view.source))view.source='best';
  if(!keySet.has(view.sort))view.sort='efficiency';
  if(!keySet.has(view.then)||view.then===view.sort)view.then='';
  view.direction=view.direction==='asc'?'asc':'desc';view.thenDirection=view.thenDirection==='desc'?'desc':'asc';
  view.positiveOnly=view.positiveOnly===true||view.positiveOnly==='true';
  view.ids=Array.isArray(view.ids)?[...new Set(view.ids.filter(id=>typeof id==='string'&&idPattern.test(id)))].slice(0,100):null;
  if(![...Object.keys(columnPresets),'custom'].includes(view.view))view.view='space';
  view.columns=Array.isArray(view.columns)?[...new Set(view.columns.filter(key=>keySet.has(key)||key==='layout'))].filter(key=>key!=='name'):[];
  view.density=view.density==='compact'?'compact':'comfortable';view.mobile=view.mobile==='table'?'table':'cards';
  view.shapeEnabled=view.shapeEnabled===true||view.shapeEnabled==='true';view.shapeRotate=view.shapeRotate===true||view.shapeRotate==='true';
  view.shapeWidth=String(Math.floor(Number(finite(view.shapeWidth,1,100,'2'))));view.shapeHeight=String(Math.floor(Number(finite(view.shapeHeight,1,100,'2'))));
  view.shapeCategory=typeof view.shapeCategory==='string'&&idPattern.test(view.shapeCategory)?view.shapeCategory:'';
  view.accessMode=view.accessMode==='mine'?'mine':'all';
  return Object.fromEntries(Object.keys(defaults).map(key=>[key,view[key]]));
}
export function cleanAccess(input={}) {
  const traders=Object.fromEntries(Object.entries(input.traders||{}).filter(([id,level])=>id.length<=128&&(level===null||Number.isInteger(level)&&level>=0&&level<=4)).slice(0,20));
  return {enabled:input.enabled===true,flea:typeof input.flea==='boolean'?input.flea:null,traders,
    quests:[...new Set((Array.isArray(input.quests)?input.quests:[]).filter(id=>typeof id==='string'&&id.length>0&&id.length<=128))].slice(0,64)};
}
export function cleanComparison(input) {
  const seen=new Set();return (Array.isArray(input)?input:[]).filter(line=>line&&typeof line.id==='string'&&idPattern.test(line.id)&&!seen.has(line.id)&&seen.add(line.id)).slice(0,4).map(line=>({id:line.id,quantity:Number.isInteger(line.quantity)&&line.quantity>=1&&line.quantity<=99?line.quantity:1}));
}
export function emptyPreferences(){return {version:2,lastView:null,favorites:[],views:[],accessProfiles:{pvp:cleanAccess(),pve:cleanAccess(),seasonal:cleanAccess()},comparison:[]};}
export function readPreferences(storage) {
  try {
    const value=JSON.parse(storage.getItem(STORAGE_KEY)||storage.getItem('stashwise.preferences.v1')||'{}');
    if(![1,2].includes(value.version))return emptyPreferences();
    return {...emptyPreferences(),lastView:value.lastView?cleanView(value.lastView):null,
      favorites:[...new Set((Array.isArray(value.favorites)?value.favorites:[]).filter(id=>typeof id==='string'&&idPattern.test(id)))].slice(0,100),
      views:(Array.isArray(value.views)?value.views:[]).filter(v=>v&&typeof v.id==='string'&&typeof v.name==='string').slice(0,20).map(v=>({id:v.id.slice(0,64),name:v.name.slice(0,50),state:cleanView(v.state)})),
      accessProfiles:Object.fromEntries(['pvp','pve','seasonal'].map(mode=>[mode,cleanAccess(value.accessProfiles?.[mode]||{})])),comparison:cleanComparison(value.comparison)};
  } catch {return emptyPreferences();}
}
export function importPreferences(text){
  if(typeof text!=='string'||new TextEncoder().encode(text).byteLength>128*1024)throw new Error('Choose a preferences file smaller than 128 KB.');
  let value;try{value=JSON.parse(text);}catch{throw new Error('This file is not valid JSON. Your preferences were kept.');}
  if(!value||![1,2].includes(value.version)||!Array.isArray(value.favorites)||!Array.isArray(value.views))throw new Error('This is not a supported Stashwise preferences export. Your preferences were kept.');
  return readPreferences({getItem:()=>text});
}
export function stateFromLocation(search,preferences) {
  const params=new URLSearchParams(search);
  const explicit=[...params.keys()].some(key=>Object.hasOwn(defaults,key));
  if(!explicit)return cleanView(preferences.lastView||defaults);
  const input={...defaults};
  for(const key of Object.keys(defaults))if(params.has(key))input[key]=['columns','ids'].includes(key)?params.get(key).split(',').filter(Boolean):params.get(key);
  return cleanView(input);
}
export function visibleColumns(state) {
  const selected=state.view==='custom'?state.columns:columnPresets[state.view]||columnPresets.space;
  return [...new Set([...selected,'cost',state.sort,state.then].filter(key=>key&&key!=='name'))];
}
export function locationParams(state) {
  const params=new URLSearchParams();
  for(const [key,value]of Object.entries(cleanView(state))){
    if(value===null||value===''||(key==='columns'&&state.view!=='custom'))continue;
    params.set(key,Array.isArray(value)?value.join(','):String(value));
  }
  return params;
}
export const quickPresets={
  gain:{sort:'gain',direction:'desc',then:'cost',thenDirection:'asc',view:'space'},
  value:{sort:'costPerGain',direction:'asc',then:'efficiency',thenDirection:'desc',positiveOnly:true,view:'value'},
  pockets:{sort:'pocketScore',direction:'desc',then:'costPerEfficiency',thenDirection:'asc',view:'pockets'},
  double:{minEfficiency:'2',sort:'efficiency',direction:'desc',then:'cost',thenDirection:'asc',positiveOnly:true,view:'space'},
};
