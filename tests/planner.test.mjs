import test from 'node:test';
import assert from 'node:assert/strict';
import {runCore} from '../lib/core.mjs';
import {createApp} from '../server.mjs';
import {cleanView,cleanAccess,cleanComparison,readPreferences,STORAGE_KEY,locationParams,stateFromLocation} from '../public/preferences.js';
const categories=[{id:'root',name:'Item',parent:''},{id:'meds',name:'Medical',parent:'root'},{id:'injector',name:'Injector',parent:'meds'},{id:'ammo',name:'Ammo',parent:'root'}];
const grid=(width,height,filters={allowedCategories:['root'],excludedCategories:[],allowedItems:[],excludedItems:[]})=>({width,height,filters});
const raw=(id,grids=[grid(2,2),grid(2,2)])=>({id,name:id,shortName:id,width:2,height:2,types:['rig'],properties:{capacity:grids.reduce((sum,g)=>sum+g.width*g.height,0),grids},lastLowPrice:8000,avg24hPrice:9000,quoteUpdated:'2026-11-13T21:00:00Z',buyFromTrader:[{trader:'ragman-id',traderName:'Ragman',price:10000,priceRUB:10000,currency:'RUB',minTraderLevel:1},{trader:'ragman-id',traderName:'Ragman',price:4000,priceRUB:4000,currency:'RUB',minTraderLevel:3,taskUnlock:'quest-id'}]});
const normalize=async raws=>(await runCore({op:'normalize',items:raws,categories})).items;
const query=(items,q={})=>runCore({op:'query',items,categories,query:q});
const access=(level=1,flea=false,quests=[])=>({enabled:true,traders:{'ragman-id':level},flea,quests});

test('shape checks separate pocket dimensions and rotation without changing area score',async()=>{
  const items=await normalize([raw('square'),raw('long',[grid(1,4),grid(1,4)])]);
  assert.equal(items[0].pocketScore,items[1].pocketScore);
  const square=await query(items,{shape:{width:2,height:2,rotate:true}});assert.deepEqual(square.items.map(i=>i.id),['square']);
  assert.equal(square.items[0].fit.pockets.length,2);assert.equal(square.items[0].fit.status,'dimensions');
  assert.equal((await query(items,{shape:{width:4,height:1,rotate:false}})).items.length,0);
  const rotated=await query(items,{shape:{width:4,height:1,rotate:true}});assert.deepEqual(rotated.items.map(i=>i.id),['long']);assert.equal(rotated.items[0].fit.pockets[0].rotated,true);
  await assert.rejects(query(items,{shape:{width:0,height:1}}),/Invalid item shape/);
  await assert.rejects(query(items,{shape:{width:1.5,height:1}}),/Invalid item shape/);
});

test('shape restrictions honour category ancestry, exclusions and partial/unknown rules',async()=>{
  const items=await normalize([raw('medical',[grid(3,3,{allowedCategories:['meds'],excludedCategories:['injector']})]),raw('specific',[grid(3,3,{allowedItems:['some-item']})])]);
  const result=await query(items,{shape:{width:2,height:2,categoryId:'meds'}});
  assert.equal(result.items.find(i=>i.id==='medical').fit.status,'unknown','A broad category with excluded descendants is not wholly confirmed');
  assert.equal(result.items.find(i=>i.id==='specific').fit.status,'unknown','Item-only rules cannot be confirmed from a category');
  assert.ok(!(await query(items,{shape:{width:2,height:2,categoryId:'injector'}})).items.some(i=>i.id==='medical'));
  assert.ok(!(await query(items,{shape:{width:2,height:2,categoryId:'ammo'}})).items.some(i=>i.id==='medical'));
  const allowed=await normalize([raw('medical',[grid(3,3,{allowedCategories:['meds']})])]);
  assert.equal((await query(allowed,{shape:{width:2,height:2,categoryId:'injector'}})).items[0].fit.status,'confirmed');
  for(const item of allowed)for(const pocket of item.grids)delete pocket.rules;
  assert.equal((await query(allowed,{shape:{width:2,height:2,categoryId:'injector'}})).items[0].fit.label,'Dimensions fit; restrictions unknown');
});

test('category filtering composes with budget, IDs, efficiency and both sorts',async()=>{
  const items=await normalize([raw('square'),raw('long',[grid(1,4),grid(1,4)])]);
  const result=await query(items,{ids:['square','long','retired'],shape:{width:2,height:2,categoryId:'meds'},minEfficiency:2,maxPrice:5000,sort:[{field:'efficiency',direction:'desc'},{field:'costPerEfficiency',direction:'asc'}]});
  assert.deepEqual(result.items.map(i=>i.id),['square']);assert.equal(result.total,2);assert.equal(result.items[0].fit.status,'confirmed');
});

test('confirmed trader and flea access drive selected price and all derived cost metrics',async()=>{
  const items=await normalize([raw('rig')]);
  assert.equal((await query(items)).items[0].cost,4000,'All listed offers remains the default');
  const eligible=(await query(items,{access:access(1,true)})).items[0];
  assert.equal(eligible.cost,8000);assert.equal(eligible.traderPrice,10000);assert.equal(eligible.costPerGain,2000);assert.equal(eligible.costPerSlot,1000);assert.equal(eligible.costPerEfficiency,4000);
  assert.equal(eligible.offers.find(o=>o.level===3).accessAllowed,false);assert.match(eligible.offers.find(o=>o.level===3).accessReason,/Requires LL3.*Quest/);
  const locked=(await query(items,{access:access(1,false)})).items[0];assert.equal(locked.cost,10000);assert.equal(locked.fleaPrice,8000,'Raw market reference stays visible');
  assert.equal((await query(items,{access:access(3,false)})).items[0].cost,10000,'Unknown quest is not unlocked');
  assert.equal((await query(items,{access:access(3,false,['quest-id'])})).items[0].cost,4000);
  assert.equal((await query(items,{access:access(0,false)})).items[0].cost,null);
  assert.equal((await query(items,{access:access(null,null),maxPrice:50000})).items.length,0);
  assert.equal(items[0].traderPrice,4000,'Queries do not rewrite the normalised catalogue');
});

test('all source choices respect access and unknown requirements do not become usable',async()=>{
  const items=await normalize([raw('rig')]);
  for(const source of ['flea','average'])assert.equal((await query(items,{source,access:access(4,false,['quest-id'])})).items[0].cost,null);
  assert.equal((await query(items,{source:'average',access:access(0,true)})).items[0].cost,9000);
  assert.equal((await query(items,{source:'trader',access:access(1,true)})).items[0].cost,10000);
  const missing=await normalize([{...raw('unknown'),buyFromTrader:[{traderName:'Trader',price:10,priceRUB:10,currency:'RUB'}]}]);
  assert.equal((await query(missing,{access:{enabled:true,traders:{Trader:4},flea:false,quests:[]}})).items[0].cost,null);
  await assert.rejects(query(items,{access:{enabled:true,traders:{Ragman:5}}}),/Invalid trader access/);
});

test('comparison multiplies independent quantities and retains exact layouts and restrictions',async()=>{
  const items=await normalize([raw('square'),{...raw('long',[grid(1,4),grid(1,4)]),buyFromTrader:[],lastLowPrice:6000}]);
  const result=await runCore({op:'compare',items,categories,query:{lines:[{id:'square',quantity:2},{id:'long',quantity:3}],shape:{width:2,height:2}}});
  assert.equal(result.totals.cost,26000);assert.equal(result.totals.footprint,20);assert.equal(result.totals.capacity,40);assert.equal(result.totals.gain,20);assert.equal(result.totals.costPerGain,1300);
  assert.equal(result.rows[0].item.grids.length,2);assert.equal(result.rows[1].item.fit.status,'no-fit','Comparison retains a selected item excluded by the active shape');
  const repriced=await runCore({op:'compare',items,query:{lines:[{id:'square',quantity:2}],access:access(1,false)}});assert.equal(repriced.totals.cost,20000);
});

test('comparison does not invent totals for missing quotes, missing items or nonpositive gain',async()=>{
  const items=await normalize([raw('priced'),{...raw('unpriced'),buyFromTrader:[],lastLowPrice:null},raw('loss',[grid(1,1)])]);
  const compare=lines=>runCore({op:'compare',items,query:{lines}});
  const unknown=await compare([{id:'priced',quantity:2},{id:'unpriced',quantity:3}]);assert.equal(unknown.totals.cost,null);assert.equal(unknown.totals.knownCost,8000);assert.equal(unknown.totals.unpricedQuantity,3);assert.equal(unknown.totals.gain,20);
  const missing=await compare([{id:'priced',quantity:1},{id:'retired',quantity:2}]);assert.equal(missing.rows[1].item,null);assert.equal(missing.totals.footprint,null);assert.equal(missing.totals.cost,null);
  const loss=await compare([{id:'loss',quantity:2}]);assert.equal(loss.totals.gain,-6);assert.equal(loss.totals.costPerGain,null);assert.equal(loss.rows[0].item.costPerGain,null);
  for(const lines of [[{id:'priced',quantity:0}],[{id:'priced',quantity:1.5}],[{id:'priced',quantity:1},{id:'priced',quantity:1}],Array.from({length:5},(_,i)=>({id:String(i),quantity:1}))])await assert.rejects(compare(lines));
});

test('schema 1 migrates without losing views; profiles are market-local and never in shared links',()=>{
  const legacy={version:1,favorites:['rig'],views:[{id:'view',name:'Saved',state:{mode:'pve'}}],lastView:{mode:'pve',sort:'pocketScore'}};
  const prefs=readPreferences({getItem:key=>key===STORAGE_KEY?null:JSON.stringify(legacy)});
  assert.equal(prefs.version,2);assert.equal(prefs.lastView.mode,'pve');assert.equal(prefs.views[0].name,'Saved');assert.deepEqual(prefs.favorites,['rig']);assert.equal(prefs.accessProfiles.pve.flea,null);
  prefs.accessProfiles.pvp=access(3,true,['quest-id']);assert.equal(prefs.accessProfiles.pve.flea,null);
  const state=cleanView({shapeEnabled:true,shapeWidth:'1',shapeHeight:'4',shapeRotate:false,shapeCategory:'meds',accessMode:'mine'});
  const url=locationParams(state);assert.deepEqual(stateFromLocation('?'+url,prefs),state);assert.ok(!url.toString().includes('quest-id'));assert.ok(!url.toString().includes('traders'));
  assert.equal(cleanAccess({traders:{bad:9},flea:'true'}).flea,null);assert.equal(cleanComparison([{id:'rig',quantity:2},{id:'rig',quantity:3},{id:'new',quantity:999}]).length,2);
});

test('planner HTTP boundaries isolate access cache keys, validate queries and return full selected records',async t=>{
  const items=await normalize([raw('square'),raw('long',[grid(1,4),grid(1,4)])]);
  const store={get:async mode=>({items:items.map(item=>({...item,fleaPrice:mode==='pve'?2000:item.fleaPrice})),fitCategories:categories,revision:'one-'+mode,meta:{source:'Fixture',checkedAt:'2026-11-13T21:00:00Z'}})};
  const server=createApp({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;
  const params=new URLSearchParams({projection:'summary',access:JSON.stringify(access(1,false))});const first=await fetch(base+'/api/items?'+params);const data=await first.json();assert.equal(data.items[0].cost,10000);assert.equal(data.items[0].offers,undefined);assert.ok(data.items[0].accessSummary.length);
  params.set('access',JSON.stringify(access(3,false,['quest-id'])));const changed=await fetch(base+'/api/items?'+params,{headers:{'If-None-Match':first.headers.get('etag')}});assert.equal(changed.status,200);assert.equal((await changed.json()).items[0].cost,4000);
  const detail=await(await fetch(base+'/api/items/long?'+new URLSearchParams({shape:JSON.stringify({width:2,height:2})}))).json();assert.equal(detail.item.fit.status,'no-fit');
  const options=await(await fetch(base+'/api/planner-options')).json();assert.equal(options.traders[0].id,'ragman-id');assert.equal(options.quests[0].id,'quest-id');assert.equal(options.categories.length,4);
  const lines=JSON.stringify([{id:'square',quantity:2}]);const compare=await(await fetch(base+'/api/compare?'+new URLSearchParams({mode:'pve',lines,access:JSON.stringify(access(1,true))}))).json();assert.equal(compare.totals.cost,4000);assert.equal(compare.mode,'pve');
  assert.equal((await fetch(base+'/api/compare?lines=%7Bbad')).status,400);assert.equal((await fetch(base+'/api/items?shape=%7Bbad')).status,400);
});
