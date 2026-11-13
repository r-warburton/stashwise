function numeric(params,name){if(!params.has(name)||params.get(name)==='')return undefined;const value=Number(params.get(name));if(!Number.isFinite(value))throw new Error(`Invalid ${name}`);return value;}
function structured(params,name){if(!params.has(name))return undefined;try{return JSON.parse(params.get(name));}catch{throw new Error(`Invalid ${name} settings`);}}
export function plannerQuery(q){return {access:structured(q,'access'),shape:structured(q,'shape')};}
export function queryFrom(q){
  const sort=[{field:q.get('sort')||'efficiency',direction:q.get('direction')||'desc'}];
  if(q.get('then'))sort.push({field:q.get('then'),direction:q.get('thenDirection')||'asc'});
  return {...plannerQuery(q),category:q.get('category')||'all',search:q.get('search')||'',source:q.get('source')||'best',minEfficiency:numeric(q,'minEfficiency'),maxPrice:numeric(q,'maxPrice'),positiveOnly:q.get('positiveOnly')==='true',sort,...(q.has('ids')?{ids:q.get('ids').split(',').filter(Boolean)}:{})};
}
export function requestQuery(q,{comparison=false,detail=null,options=false}={}){
  return options?{}:comparison?{...plannerQuery(q),source:q.get('source')||'best',lines:structured(q,'lines')}:detail?{...plannerQuery(q),filterShape:false,source:q.get('source')||'best',ids:[detail]}:queryFrom(q);
}
