import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanView,readPreferences,stateFromLocation,visibleColumns,locationParams,defaults,quickPresets} from '../public/preferences.js';
test('shared URLs take precedence over stored defaults and round-trip both sort levels',()=>{
  const stored={lastView:cleanView({...defaults,mode:'pve',minEfficiency:'3',sort:'gain',then:'cost'})};
  const state=stateFromLocation('?mode=pvp&minEfficiency=2&sort=pocketScore&direction=desc&then=costPerEfficiency&thenDirection=asc',stored);
  assert.equal(state.mode,'pvp');assert.equal(state.minEfficiency,'2');assert.equal(state.sort,'pocketScore');assert.equal(state.then,'costPerEfficiency');
  assert.deepEqual(stateFromLocation('?'+locationParams(state),stored),state);assert.equal(stateFromLocation('',stored).mode,'pve');
});
test('active sort columns remain visible in every preset and custom selections',()=>{
  for(const view of ['space','value','pockets','all','custom']){const columns=visibleColumns(cleanView({...defaults,view,columns:['gain'],sort:'weight',then:'costPerEfficiency'}));assert.ok(columns.includes('weight'));assert.ok(columns.includes('costPerEfficiency'));assert.ok(columns.includes('cost'));}
  assert.equal(quickPresets.value.positiveOnly,true);
});
test('preferences tolerate corrupt, excessive and retired data without storing a catalogue',()=>{
  assert.equal(readPreferences({getItem:()=>'{broken'}).views.length,0);
  const prefs=readPreferences({getItem:()=>JSON.stringify({version:1,favorites:['old-id','old-id',null,{},'x'.repeat(100)],views:[{id:'1',name:'View',state:{mode:'bad',columns:['description','gain'],catalogue:{secret:true}}}],catalogue:{huge:true}})});
  assert.deepEqual(prefs.favorites,['old-id']);assert.equal(prefs.views[0].state.mode,'pvp');assert.deepEqual(prefs.views[0].state.columns,['gain']);assert.equal(prefs.catalogue,undefined);assert.equal(prefs.views[0].state.catalogue,undefined);
  const empty=stateFromLocation('?ids=',{lastView:null});assert.deepEqual(empty.ids,[]);assert.deepEqual(stateFromLocation('?'+locationParams(empty),{}).ids,[]);
});
