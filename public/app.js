import {pocketMarkup} from './pockets.js';
import {apiFetch} from './transport.js';
import {STORAGE_KEY,fields,columnPresets,defaults,cleanView,readPreferences,stateFromLocation,visibleColumns,locationParams,quickPresets,emptyPreferences,importPreferences} from './preferences.js';
import {initPlanner} from './planner.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const categories = [
  ['all','All storage','grid'],['rigs','All rigs','rig'],['rig','Unarmoured rigs','rig'],
  ['armored-rig','Armoured rigs','armor'],['backpack','Backpacks','pack'],['container','Cases & pouches','case'],['secure','Secure containers','lock'],
];
const paths = {
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  rig:'M7 3v5l-4 3v10h18V11l-4-3V3h-3v5h-4V3z M7 13h3v5H7z M14 13h3v5h-3z',
  armor:'M8 3l4 2 4-2 4 4-2 13H6L4 7z M9 10h6v7H9z',
  pack:'M8 6V4a4 4 0 0 1 8 0v2 M6 6h12l2 5v10H4V11z M7 13h10v6H7z',
  case:'M4 7h16v14H4z M8 7V3h8v4 M4 12h16 M10 10h4v5h-4z',
  lock:'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
};
const icon = name => `<svg class="category-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"></path></svg>`;
function money(value, symbol = true) {
  return value == null ? '—' : `${Math.round(value).toLocaleString('en-GB')}${symbol ? ' ₽' : ''}`;
}
function age(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return 'time unavailable';
  const minutes = Math.max(0,Math.floor((Date.now()-time)/60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes/60)}h ago`;
  return `${Math.floor(minutes/1440)}d ago`;
}
function fullDate(value) {
  return value ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : 'Not supplied';
}
function imageUrl(value) {
  try { const url=new URL(value); return url.protocol==='https:' && url.hostname==='assets.tarkov.dev' ? url.href : ''; } catch { return ''; }
}
function safeLink(value) {
  try { const url=new URL(value); return url.protocol==='https:' ? url.href : '#'; } catch { return '#'; }
}
function labelForCategory(value) { return categories.find(c=>c[0]===value)?.[1] || value; }
function imageFallbacks(parent=document) {
  for (const img of parent.querySelectorAll('img[data-item-image]')) {
    const fail = () => { const span=document.createElement('span');span.className='image-fallback';span.textContent='▦';span.setAttribute('aria-label',`${img.alt} — image unavailable`);img.replaceWith(span); };
    img.addEventListener('error',fail,{once:true});
    if (img.complete && img.naturalWidth===0) fail();
  }
}

function renderDetails(item) {
  const img=imageUrl(item.largeImage||item.image);
  const metrics=[['Stash footprint',`${item.footprint}`,`${item.width} × ${item.height}`],['Inside slots',item.capacity,'Pocket capacity'],['Extra slots',`${item.gain>0?'+':''}${item.gain}`,'Inside − footprint'],['Efficiency',`${item.efficiency.toFixed(2)}×`,'Inside / footprint']];
  const gridHtml=pocketMarkup(item);
  const tags=values=>values.filter(v=>!v.startsWith('Item/category ')).map(value=>`<span class="tag">${esc(value)}</span>`).join('');
  const unknown=item.restrictions.filter(v=>v.startsWith('Item/category ')).length;
  const excludedUnknown=item.exclusions.filter(v=>v.startsWith('Item/category ')).length;
  const questLabel=quest=>/^[0-9a-f]{24}$/i.test(quest)?'Quest unlock required (name not supplied)':`Unlock: ${quest}`;
  const restrictionHtml=item.restrictions.includes('Item')?'<p class="detail-caption">General item storage, subject to the exclusions below.</p>':item.restrictions.length?`<div class="tags">${tags(item.restrictions)}${unknown?`<span class="tag">${unknown} other permitted items</span>`:''}</div>`:`<p class="detail-caption">${item.restrictionsKnown?'No item-type allowlist supplied for these pockets. Normal game restrictions still apply.':'Pocket restrictions were not supplied by this feed. Check the item in game.'}</p>`;
  $('#detail-content').innerHTML=`<header class="detail-head">${img?`<img data-item-image class="detail-image" src="${esc(img)}" alt="${esc(item.name)}">`:''}<div><div class="eyebrow">${esc(labelForCategory(item.category))}</div><h2 id="detail-title">${esc(item.name)}</h2><p>${esc(item.description)}</p></div></header>
    <div class="detail-body"><div class="detail-metrics">${metrics.map(([label,value,sub])=>`<div class="detail-metric"><span>${label}</span><strong>${value}</strong><span>${sub}</span></div>`).join('')}</div>
    <section class="detail-section"><div class="pocket-section-heading"><h3>Pocket layout</h3><span class="detail-pocket-score">Pocket score <strong>${item.pocketScore==null?'—':item.pocketScore.toFixed(2)}</strong></span></div><div class="pockets">${gridHtml||'<span class="detail-caption">Layout not supplied.</span>'}</div><p class="detail-caption">${item.grids.length} separate ${item.grids.length===1?'pocket':'pockets'} · ${item.weight==null?'Weight unavailable':`${item.weight.toFixed(2)} kg`} · plate sockets excluded</p><p class="detail-caption">${item.pocketScore==null?'A complete pocket layout is needed to calculate a score.':'Higher scores mean more storage in larger pockets. Score = sum of squared pocket areas ÷ internal slots. Equal-area shapes tie; storage restrictions still apply.'}</p></section>
    <section class="detail-section"><h3>What fits inside</h3>${restrictionHtml}${item.exclusions.length?`<p class="detail-caption">Excluded by the supplied pocket rules:</p><div class="tags">${tags(item.exclusions)}${excludedUnknown?`<span class="tag">${excludedUnknown} other excluded items</span>`:''}</div>`:''}</section>
    <section class="detail-section"><h3>Purchase prices · ${modeLabel()}</h3><div class="detail-prices"><div class="detail-metric"><span>Latest flea price</span><strong>${money(item.fleaPrice)}</strong><span>${item.fleaEnabled?'Community-reported asking price':'Not flea-tradeable'}</span></div><div class="detail-metric"><span>24h flea average</span><strong>${money(item.fleaAverage)}</strong><span>For comparison, not a live offer</span></div><div class="detail-metric"><span>Selected purchase cost</span><strong>${money(item.cost)}</strong><span>${esc(item.costSource||'No price available')}</span></div></div>
    <p class="detail-caption">${money(item.costPerGain)} per extra slot · ${money(item.costPerSlot)} per internal slot.</p><p class="detail-caption"><strong>Cost / efficiency: ${money(item.costPerEfficiency)}</strong> per 1× storage efficiency. Selected purchase price ÷ efficiency; lower is better. Barter values are not included.</p>
    ${item.offers.length?`<table class="offers"><thead><tr><th>Trader / requirement</th><th>Purchase price</th><th>Rouble equivalent</th></tr></thead><tbody>${item.offers.map(offer=>`<tr><td>${esc(offer.trader)}${offer.level?` · LL${offer.level}`:''}${offer.quest?`<span class="offer-note">${esc(questLabel(offer.quest))}</span>`:''}${offer.accessAllowed===false?`<span class="offer-note access-excluded">Excluded: ${esc(offer.accessReason)}</span>`:offer.accessAllowed===true?'<span class="offer-note">Confirmed accessible</span>':''}</td><td class="offer-price">${offer.price==null?'—':`${money(offer.price,false)} ${esc(offer.currency)}`}</td><td class="offer-price">${money(offer.priceRub)}</td></tr>`).join('')}</tbody></table>`:'<p class="detail-caption">No direct trader cash purchase is listed. This does not rule out a barter, quest reward or finding it in raid.</p>'}
    </section></div><footer class="detail-footer"><span>Quote timestamp: ${esc(fullDate(item.quoteUpdated))}</span>${item.wiki?`<a class="detail-link" href="${esc(safeLink(item.wiki))}" target="_blank" rel="noreferrer">Item on the wiki ↗</a>`:''}</footer>`;
  imageFallbacks($('#detail-content'));
  if(!$('#details').open)$('#details').showModal();
}

const modeNames={pvp:'Standard PvP',pve:'PvE',seasonal:'Seasonal PvP'};
let preferences;
try { preferences=readPreferences(localStorage); } catch { preferences=readPreferences({getItem:()=>null}); }
const state=stateFromLocation(location.search,preferences);
const modeLabel=()=>modeNames[state.mode];
const label=key=>fields.find(([id])=>id===key)?.[1]||(key==='layout'?'Pocket layout':key);
let catalogue=null,requestController=null,requestNumber=0,searchTimer,progressTimer,lastTrigger,renderKey='',detailController,detailNumber=0,editingView=null,undoPreferences=null,planner;
const responses=new Map();
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,4000);}
function persist(){
  preferences.lastView=cleanView(state);
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(preferences));}catch{toast('Browser storage is unavailable. This view is still in the URL.');}
  history.replaceState(null,'',`?${locationParams(state)}`);
}
function renderCategories(){
  const focus=document.activeElement?.dataset.category;
  const counts=catalogue?.counts||{};
  $('#categories').innerHTML=categories.map(([id,name,symbol])=>{const count=!catalogue?null:id==='all'?catalogue.total:id==='rigs'?(counts.rig||0)+(counts['armored-rig']||0):counts[id];return `<button class="category-button" data-category="${id}" aria-current="${id===state.category}">${icon(symbol)}<span>${name}</span><span class="category-count">${count??'—'}</span></button>`;}).join('');
  if(focus)$(`#categories [data-category='${focus}']`)?.focus();
}
function syncControls(){
  for(const [selector,key]of [['#search','search'],['#min-efficiency','minEfficiency'],['#price-source','source'],['#budget','maxPrice'],['#sort-primary','sort'],['#sort-secondary','then'],['#game-mode','mode'],['#column-preset','view'],['#density','density'],['#mobile-layout','mobile']]){
    if(key==='minEfficiency'&&!Array.from($(selector).options).some(o=>o.value===state[key]))$(selector).add(new Option(`${state[key]}× and up`,state[key]));
    $(selector).value=state[key];
  }
  $('#positive-only').checked=state.positiveOnly;
  for(const [name,key]of [['primary','direction'],['secondary','thenDirection']]){const button=$(`#direction-${name}`),desc=state[key]==='desc';button.textContent=desc?'↓':'↑';button.setAttribute('aria-label',`${name==='primary'?'Primary':'Secondary'} sort: ${desc?'descending':'ascending'}`);}
  $('#direction-secondary').disabled=!state.then;
  $('#favorite-count').textContent=preferences.favorites.length;$('#favorites').setAttribute('aria-pressed',String(state.ids!==null));
  document.body.dataset.density=state.density;document.body.dataset.mobile=state.mobile;
  $('#sort-description').textContent=`${label(state.sort)}: ${state.direction==='desc'?'high to low':'low to high'}${state.then?`; ties: ${label(state.then).toLowerCase()}, ${state.thenDirection==='desc'?'high to low':'low to high'}`:''}.`;
  renderChips();planner?.sync();
}
function activeFilters(){return [state.search&&['search',`Search: ${state.search}`],Number(state.minEfficiency)>0&&['minEfficiency',`At least ${state.minEfficiency}×`],state.maxPrice!==''&&['maxPrice',`Up to ${money(Number(state.maxPrice))}`],state.positiveOnly&&['positiveOnly','Slot-positive only'],state.ids!==null&&['ids',`${state.ids.length} selected favourites`],state.shapeEnabled&&['shapeEnabled',`Fits ${state.shapeWidth} × ${state.shapeHeight}${state.shapeRotate?' · rotation allowed':''}`],state.accessMode==='mine'&&['accessMode','My accessible offers']].filter(Boolean);}
function renderChips(){
  const chips=activeFilters().map(([key,name])=>`<button class="filter-chip" data-clear="${key}" aria-label="Remove ${esc(name)}">${esc(name)} <span aria-hidden="true">×</span></button>`).join('');
  $('#filter-chips').innerHTML=chips;
  $('#empty-actions').innerHTML=chips;
  $('#empty-message').textContent=state.ids!==null?'Selected favourites may not be available in this market, or another filter may exclude them.':'Remove one of these filters to broaden the results. Your saved views and favourites are kept.';
}
function renderFeedStatus(meta){
  $('#feed-indicator').innerHTML=`<span class="status-dot ${meta.stale?'stale':''}"></span><span>${meta.refreshing?'Checking prices…':`Checked ${esc(age(meta.checkedAt))}${meta.checkDelayed?' · publication delayed':meta.stale?' · some quotes old':''}`}</span>`;
  $('#feed-indicator').title=`Oldest source quote: ${fullDate(meta.quoteUpdated)}. Last successful check: ${fullDate(meta.checkedAt)}.`;
  $('#notice').hidden=!meta.stale&&!meta.warnings?.length;$('#notice').classList.toggle('subtle',!meta.stale);
  $('#notice').textContent=meta.lastError||(meta.checkDelayed?`Published prices were last checked ${age(meta.checkedAt)}. GitHub updates are delayed; these prices may be outdated. Check individual offers before buying.`:meta.stale?'Some quotes are old or have no source timestamp. Check individual offers before buying.':meta.warnings?.join(' ')||'');
  $('#price-note').innerHTML=`Prices in ₽ equivalents. Trader loyalty / quest requirements may apply. Market quotes can change before purchase.<br>Source: <a href="${esc(safeLink(meta.sourceUrl))}" target="_blank" rel="noreferrer">${esc(meta.source)}</a> · Last checked ${esc(fullDate(meta.checkedAt))}${meta.distribution==='pages'?' · Price updates target 15 minutes; GitHub may delay or skip runs. This tab checks for published updates every minute while active. Reloading cannot trigger a new source check.':' · Checks every 5 minutes while used.'}`;
}
function favoriteButton(item){const saved=preferences.favorites.includes(item.id);return `<button class="favorite-toggle" data-favorite="${esc(item.id)}" aria-pressed="${saved}" aria-label="${saved?'Remove':'Add'} ${esc(item.name)} ${saved?'from':'to'} favourites">${saved?'★':'☆'}</button>`;}
function itemHeading(item){const img=imageUrl(item.image);return `<div class="item-cell">${favoriteButton(item)}<div class="item-image-wrap">${img?`<img class="item-image" data-item-image src="${esc(img)}" alt="${esc(item.name)}" loading="lazy" width="53" height="53">`:'<span class="image-fallback">▦</span>'}</div><div class="item-name-wrap"><button class="item-name" data-open="${esc(item.id)}">${esc(item.name)}</button><span class="item-sub">${esc(item.restrictionLabel||labelForCategory(item.category))}</span>${item.fit?`<span class="fit-label" data-fit-status="${esc(item.fit.status)}">${esc(item.fit.label)}</span>`:''}</div></div>`;}
function cell(item,key){
  const sub=text=>`<span class="sub-num">${esc(text)}</span>`;
  if(key==='footprint')return `<span class="num">${item.footprint}</span>${sub(`${item.width} × ${item.height}`)}`;
  if(key==='capacity')return `<span class="num">${item.capacity}</span>`;
  if(key==='gain')return `<span class="num ${item.gain>0?'gain':item.gain<0?'negative':''}">${item.gain>0?'+':''}${item.gain}</span>`;
  if(key==='efficiency')return `<span class="efficiency ${item.efficiency<1.66?'low':''}">${item.efficiency.toFixed(2)}×</span>`;
  if(key==='pocketScore')return `<span class="pocket-score">${item.pocketScore==null?'—':item.pocketScore.toFixed(2)}</span>${sub(item.largestPocket?`Largest ${item.largestPocket.width} × ${item.largestPocket.height}`:'Layout unavailable')}`;
  if(key==='layout'){
    const grids=item.pocketLayout||[];const names=grids.map(g=>`${g.width} × ${g.height}`).join(', ');
    return `<div class="mini-layout" role="img" aria-label="${esc(names||'Layout unavailable')}">${grids.slice(0,8).map(g=>`<span style="width:${Math.min(g.width,12)*4}px;height:${Math.min(g.height,12)*4}px"></span>`).join('')}${grids.length>8?`<small>+${grids.length-8}</small>`:''}</div>${sub(`${grids.length} pockets`)}`;
  }
  if(key==='category')return esc(labelForCategory(item.category));
  if(key==='weight')return `<span class="num">${item.weight==null?'—':`${item.weight.toFixed(2)} kg`}</span>`;
  const captions={cost:item.costSource||'No priced offer',costPerGain:item.costSource||'No priced offer',costPerSlot:'per inside slot',costPerEfficiency:item.costPerEfficiency==null?'No priced offer':'per 1× efficiency',traderPrice:item.traderName?`${item.traderName}${item.traderLevel?` · LL${item.traderLevel}`:''}`:'No cash offer',fleaPrice:item.fleaEnabled?'Latest reported':'Not flea-tradeable',fleaAverage:'24h average'};
  return `<span class="cost-unit ${item[key]==null?'unavailable':''}">${money(item[key])}</span>${sub(captions[key]||'')}${key==='cost'&&item.accessSummary?.length?`<details class="access-reasons"><summary>Excluded offers</summary><ul>${item.accessSummary.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul></details>`:''}`;
}
function render(){
  if(!catalogue)return;
  const {items,summary,meta}=catalogue;const columns=visibleColumns(state);
  const focused=document.activeElement?.dataset.open;
  renderCategories();syncControls();renderFeedStatus(meta);
  $('#category-title').textContent=labelForCategory(state.category);$('#result-caption').textContent=`${items.length} variants · ${modeLabel()}`;
  $('#stat-count').textContent=items.length;$('#stat-count-sub').textContent=`From ${catalogue.total} storage items`;
  $('#stat-efficiency').textContent=summary.bestEfficiency==null?'—':`${summary.bestEfficiency.toFixed(2)}×`;
  $('#stat-gain').textContent=summary.maxGain==null?'—':`${summary.maxGain>=0?'+':''}${summary.maxGain}`;$('#stat-value').textContent=money(summary.lowestGainCost);
  const heading=key=>{const position=key===state.sort?1:key===state.then?2:0;const direction=position===1?state.direction:state.thenDirection;return `<th data-field="${key}"${position===1?` aria-sort="${direction==='asc'?'ascending':'descending'}"`:''}>${key==='layout'?label(key):`<button>${key==='name'?'Item':label(key)} <span class="sort-mark">${position?`${direction==='asc'?'↑':'↓'}${position}`:''}</span></button>`}</th>`;};
  $('#items-table thead tr').innerHTML=heading('name')+columns.map(heading).join('')+'<th class="arrow-heading"><span class="sr-only">Details</span></th>';
  $('#items-table').style.minWidth=`${320+columns.length*108}px`;
  $('#items-body').innerHTML=items.map(item=>`<tr class="item-row" data-id="${esc(item.id)}"><td class="identity-cell">${itemHeading(item)}</td>${columns.map(key=>`<td data-metric="${key}" class="${key==='costPerEfficiency'?'efficiency-cost-cell':key==='pocketScore'?'pocket-score-cell':''}">${cell(item,key)}</td>`).join('')}<td><div class="row-actions">${planner.compareButton(item)}<button class="row-open" data-open="${esc(item.id)}" aria-label="View ${esc(item.name)} details">›</button></div></td></tr>`).join('');
  $('#item-cards').innerHTML=items.map(item=>`<article class="item-card" data-id="${esc(item.id)}">${itemHeading(item)}<dl>${columns.map(key=>`<div><dt>${label(key)}</dt><dd>${cell(item,key)}</dd></div>`).join('')}</dl><div class="card-actions"><button class="button secondary card-details" data-open="${esc(item.id)}">View pockets &amp; offers</button>${planner.compareButton(item)}</div></article>`).join('');
  $('#items-table').hidden=!items.length;$('#item-cards').hidden=!items.length;$('#empty').hidden=Boolean(items.length);$('#loading').hidden=true;$('#error').hidden=true;
  $('#table-count').textContent=`Showing ${items.length} of ${catalogue.total} items`;imageFallbacks($('#items-body'));imageFallbacks($('#item-cards'));
  if(focused)$$(`[data-open='${CSS.escape(focused)}']`).find(button=>button.offsetParent)?.focus();
}
function apiParams(){const params=locationParams(state);for(const key of ['view','columns','density','mobile'])params.delete(key);params.set('projection','summary');return planner.requestParams(params);}
async function loadItems({clear=false,background=false}={}){
  requestController?.abort();const controller=requestController=new AbortController();const current=++requestNumber;
  persist();syncControls();$('#items-table').setAttribute('aria-busy','true');
  if(clear){catalogue=null;renderKey='';$('#items-body').replaceChildren();$('#item-cards').replaceChildren();$('#item-cards').hidden=true;$('#items-table').hidden=true;for(const id of ['stat-count','stat-efficiency','stat-gain','stat-value'])$(`#${id}`).textContent='—';renderCategories();}
  $('#loading').hidden=Boolean(catalogue);$('#error').hidden=true;
  if(!catalogue){$('#empty').hidden=true;$('#notice').hidden=true;$('#stat-count-sub').textContent=`Loading ${modeLabel()} items`;$('#result-caption').textContent=`Loading ${modeLabel()} prices…`;$('#feed-indicator').textContent='Connecting to item data…';}
  const key=apiParams().toString(),cached=responses.get(key);
  if(!catalogue){clearInterval(progressTimer);progressTimer=setInterval(async()=>{try{const status=await(await apiFetch(`/api/status?mode=${state.mode}`)).json();if(current===requestNumber&&status.progress)$('#loading-message').textContent=status.progress;}catch{}},1200);}
  try{
    const response=await apiFetch(`/api/items?${key}`,{signal:controller.signal,cache:'no-store',headers:cached?{'If-None-Match':cached.etag}:{}});
    let data;
    if(response.status===304&&cached){data={...cached.data,meta:JSON.parse(decodeURIComponent(response.headers.get('x-stashwise-meta')))};}
    else {data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load items.');}
    if(current!==requestNumber)return;
    if(background&&!canCheckPrices())return;
    responses.delete(key);responses.set(key,{etag:response.headers.get('etag'),data});while(responses.size>8)responses.delete(responses.keys().next().value);
    catalogue=data;const nextKey=JSON.stringify([locationParams(state).toString(),key,data.meta.revision]);
    if(nextKey!==renderKey){render();renderKey=nextKey;}else renderFeedStatus(data.meta);
    planner.onData(data);
  }catch(error){
    if(error.name==='AbortError'||current!==requestNumber)return;
    if(catalogue){$('#notice').hidden=false;$('#notice').classList.remove('subtle');$('#notice').textContent=`${error.message} Your previous results are still shown.`;}
    else{$('#error').hidden=false;$('#error-message').textContent=error.message;$('#loading').hidden=true;$('#items-table').hidden=true;$('#item-cards').hidden=true;$('#stat-count-sub').textContent='Item library unavailable';$('#table-count').textContent='No catalogue loaded';$('#result-caption').textContent='Prices unavailable';$('#feed-indicator').innerHTML='<span class="status-dot stale"></span><span>Item feed unavailable</span>';}
  }finally{if(current===requestNumber){clearInterval(progressTimer);$('#items-table').setAttribute('aria-busy','false');}}
}
function resetFilters(){Object.assign(state,{search:'',minEfficiency:'0',maxPrice:'',source:'best',sort:'efficiency',direction:'desc',then:'cost',thenDirection:'asc',positiveOnly:false,ids:null,shapeEnabled:false});loadItems();}
async function refreshPrices(){
  const button=$('#refresh');button.disabled=true;button.classList.add('refreshing');const mode=state.mode;
  const timer=setInterval(async()=>{try{const status=await(await apiFetch(`/api/status?mode=${mode}`)).json();if(mode===state.mode&&status.progress){$('#feed-indicator').textContent=status.progress;}}catch{}},1200);
  try{const response=await apiFetch(`/api/refresh?mode=${mode}`,{method:'POST'});const meta=await response.json();if(!response.ok)throw new Error(meta.error||'Refresh failed.');if(state.mode===mode)await loadItems();toast(meta.lastError||meta.refreshMessage||'Price check complete. Latest available quotes shown.');}
  catch(error){toast(error.message);}finally{clearInterval(timer);button.disabled=false;button.classList.remove('refreshing');}
}
async function openDetails(id,trigger){
  detailController?.abort();const controller=detailController=new AbortController(),current=++detailNumber;lastTrigger=trigger||lastTrigger;
  const mode=state.mode,source=state.source;
  $('#detail-content').innerHTML='<div class="detail-body"><h2 id="detail-title">Loading item details…</h2><p class="detail-caption">Retrieving this item’s pocket layout and offers.</p></div>';
  if(!$('#details').open)$('#details').showModal();
  try{const params=planner.requestParams(new URLSearchParams({mode,source}));const response=await apiFetch(`/api/items/${encodeURIComponent(id)}?${params}`,{signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'Details unavailable');if(current!==detailNumber||!$('#details').open||mode!==state.mode)return;renderDetails(data.item);$('#detail-content').insertAdjacentHTML('beforeend',`${data.item.fit?`<section class="detail-section"><h3>Shape check · ${state.shapeWidth} × ${state.shapeHeight}</h3><p class="fit-label">${esc(data.item.fit.label)}</p><p class="detail-caption">Compatible pockets: ${esc(data.item.fit.pockets.filter(p=>p.status!=='blocked').map(p=>`${p.width} × ${p.height}${p.rotated?' (rotated)':''}`).join(', ')||'None')}. Single-item fit only.</p></section>`:''}<p class="detail-snapshot">${esc(modeNames[mode])} · ${state.accessMode==='mine'?'My accessible offers':'All listed offers'} · Snapshot checked ${esc(fullDate(data.meta.checkedAt))}. ${data.meta.stale?'Some source quotes are old or unavailable. ':''}Close and reopen to check for newer offers.</p>`);}
  catch(error){if(error.name==='AbortError'||current!==detailNumber)return;$('#detail-content').innerHTML=`<div class="detail-body"><h2 id="detail-title">Details are unavailable</h2><p>${esc(error.message)}</p><button class="button" data-retry-detail="${esc(id)}">Try again</button></div>`;}
}
function columnOptions(){const visible=visibleColumns(state);$('#column-options').innerHTML=[...fields.filter(([key])=>key!=='name'),['layout','Pocket layout']].map(([key,name])=>`<label class="check"><input type="checkbox" data-column="${key}" ${visible.includes(key)?'checked':''} ${[state.sort,state.then,'cost'].includes(key)?'disabled':''}>${name}${[state.sort,state.then].includes(key)?' · sorting':key==='cost'?' · selected price':''}</label>`).join('');}
function renderViews(){
  $('#views-list').innerHTML=preferences.views.length?preferences.views.map(view=>`<div class="saved-view-row"><strong>${esc(view.name)}</strong><div><button class="button secondary" data-apply-view="${esc(view.id)}">Open</button><button class="text-button" data-rename-view="${esc(view.id)}">Rename</button><button class="text-button" data-delete-view="${esc(view.id)}">Delete</button></div></div>`).join(''):'<p class="detail-caption">No saved views yet. Give this view a name above.</p>';
  $('#undo-preferences').hidden=!undoPreferences;
}
function toggleFavorite(id){
  if(preferences.favorites.includes(id))preferences.favorites=preferences.favorites.filter(value=>value!==id);
  else{if(preferences.favorites.length>=100)return toast('You can save up to 100 favourites.');preferences.favorites.push(id);}
  persist();$('#favorite-count').textContent=preferences.favorites.length;
  $$(`[data-favorite='${CSS.escape(id)}']`).forEach(button=>{const saved=preferences.favorites.includes(id);button.textContent=saved?'★':'☆';button.setAttribute('aria-pressed',String(saved));const item=catalogue?.items.find(i=>i.id===id);button.setAttribute('aria-label',`${saved?'Remove':'Add'} ${item?.name||'item'} ${saved?'from':'to'} favourites`);});
  if(state.ids!==null){state.ids=[...preferences.favorites];loadItems();}
}
function cancelRename(){editingView=null;$('#view-name').value='';$('#save-view-submit').textContent='Save current view';$('#cancel-rename').hidden=true;}
function presentChange(){persist();syncControls();renderKey='';render();}

$('#sort-primary').innerHTML=fields.map(([key,name])=>`<option value="${key}">${name}</option>`).join('');
$('#sort-secondary').innerHTML='<option value="">No tie-breaker</option>'+fields.map(([key,name])=>`<option value="${key}">${name}</option>`).join('');
if(matchMedia('(max-width:800px)').matches)$('#filters-panel').open=false;
$('#categories').addEventListener('click',event=>{const button=event.target.closest('[data-category]');if(button){state.category=button.dataset.category;loadItems();}});
$('#search').addEventListener('input',event=>{state.search=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadItems(),220);});
for(const [selector,key]of [['#min-efficiency','minEfficiency'],['#price-source','source'],['#budget','maxPrice'],['#sort-primary','sort'],['#sort-secondary','then']])$(selector).addEventListener('change',event=>{if(selector==='#budget'&&!event.target.checkValidity()){event.target.reportValidity();return;}state[key]=event.target.value;if(state.sort===state.then){if(key==='then')state.sort=state.then==='efficiency'?'name':'efficiency';else state.then='';}loadItems();});
$('#positive-only').addEventListener('change',event=>{state.positiveOnly=event.target.checked;loadItems();});
for(const [name,key]of [['primary','direction'],['secondary','thenDirection']])$(`#direction-${name}`).addEventListener('click',()=>{state[key]=state[key]==='desc'?'asc':'desc';loadItems();});
$('#items-table thead').addEventListener('click',event=>{
  const button=event.target.closest('button'),field=button?.closest('[data-field]')?.dataset.field;if(!field)return;
  const ascending=['name','category','footprint','traderPrice','fleaPrice','fleaAverage','cost','costPerGain','costPerSlot','costPerEfficiency','weight'].includes(field);
  if(event.shiftKey){state.thenDirection=state.then===field?(state.thenDirection==='asc'?'desc':'asc'):(ascending?'asc':'desc');state.then=field;if(state.then===state.sort)state.then='';}
  else{state.direction=state.sort===field?(state.direction==='asc'?'desc':'asc'):(ascending?'asc':'desc');state.sort=field;if(state.then===field)state.then='';}loadItems();
});
$('#game-mode').addEventListener('change',event=>{state.mode=event.target.value;$('#details').close();planner.modeChanged();loadItems({clear:true});});
$('#quick-preset').addEventListener('change',event=>{const selected=quickPresets[event.target.value];if(selected){Object.assign(state,selected);loadItems();}event.target.value='';});
for(const [selector,key]of [['#column-preset','view'],['#density','density'],['#mobile-layout','mobile']])$(selector).addEventListener('change',event=>{if(key==='view'&&event.target.value==='custom')state.columns=visibleColumns(state);state[key]=event.target.value;presentChange();});
$('#choose-columns').addEventListener('click',()=>{columnOptions();$('#columns-dialog').showModal();});
$('#column-options').addEventListener('change',event=>{if(!event.target.dataset.column)return;state.view='custom';state.columns=$$('#column-options input:checked').map(input=>input.dataset.column);presentChange();});
$('#favorites').addEventListener('click',()=>{state.ids=state.ids===null?[...preferences.favorites]:null;loadItems();});
$('#saved-views').addEventListener('click',()=>{cancelRename();renderViews();$('#views-dialog').showModal();});
$('#save-view-form').addEventListener('submit',event=>{event.preventDefault();const name=$('#view-name').value.trim();if(!name)return;
  if(editingView){const view=preferences.views.find(v=>v.id===editingView);if(view)view.name=name;}
  else{if(preferences.views.length>=20)return toast('You can save up to 20 views.');preferences.views.push({id:crypto.randomUUID(),name,state:cleanView(state)});}
  persist();cancelRename();renderViews();toast('View saved on this browser.');
});
$('#cancel-rename').addEventListener('click',cancelRename);
$('#export-preferences').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(preferences,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='stashwise-preferences.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('#import-preferences').addEventListener('click',()=>$('#preferences-file').click());
$('#preferences-file').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  const status=$('#import-status');status.textContent='Reading preferences…';
  try{
    if(file.size>128*1024)throw new Error('Choose a preferences file smaller than 128 KB.');
    const imported=importPreferences(await file.text());
    undoPreferences=structuredClone(preferences);preferences=imported;
    Object.assign(state,cleanView(preferences.lastView||defaults));
    persist();cancelRename();renderViews();planner.loadComparison();loadItems({clear:true});
    status.textContent='Preferences imported. Use Undo last change to restore the previous settings.';
  }catch(error){status.textContent=error.message;}
});
$('#reset-preferences').addEventListener('click',()=>{undoPreferences=structuredClone(preferences);preferences=emptyPreferences();Object.assign(state,cleanView(defaults));persist();cancelRename();renderViews();planner.loadComparison();loadItems();toast('Local preferences reset. Undo is available here.');});
$('#undo-preferences').addEventListener('click',()=>{if(!undoPreferences)return;preferences=undoPreferences;undoPreferences=null;Object.assign(state,cleanView(preferences.lastView||state));persist();renderViews();loadItems({clear:true});});
document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.open)openDetails(target.dataset.open,target);
  if(target.dataset.favorite)toggleFavorite(target.dataset.favorite);
  if(target.dataset.retryDetail)openDetails(target.dataset.retryDetail);
  if(target.dataset.close)$(`#${target.dataset.close}`).close();
  if(target.dataset.clear){const key=target.dataset.clear;state[key]=['positiveOnly','shapeEnabled'].includes(key)?false:key==='minEfficiency'?'0':key==='ids'?null:key==='accessMode'?'all':'';loadItems();}
  if(target.dataset.applyView){const view=preferences.views.find(v=>v.id===target.dataset.applyView);if(view){Object.assign(state,cleanView(view.state));$('#views-dialog').close();loadItems({clear:true});}}
  if(target.dataset.renameView){const view=preferences.views.find(v=>v.id===target.dataset.renameView);if(view){editingView=view.id;$('#view-name').value=view.name;$('#view-name').focus();$('#save-view-submit').textContent='Save name';$('#cancel-rename').hidden=false;}}
  if(target.dataset.deleteView){undoPreferences=structuredClone(preferences);preferences.views=preferences.views.filter(v=>v.id!==target.dataset.deleteView);persist();cancelRename();renderViews();}
});
$('#refresh').addEventListener('click',refreshPrices);$('#reset').addEventListener('click',resetFilters);$('#empty-reset').addEventListener('click',resetFilters);$('#retry').addEventListener('click',()=>loadItems());
$('#close-details').addEventListener('click',()=>$('#details').close());
$('#details').addEventListener('click',event=>{if(event.target===$('#details')){const r=$('#details').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('#details').close();}});
$('#details').addEventListener('close',()=>{detailController?.abort();detailNumber++;lastTrigger?.isConnected&&lastTrigger.focus();});
document.addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)&&!$('dialog[open]')){event.preventDefault();$('#filters-panel').open=true;$('#search').focus();}});
// Keep an open comparison current, but preserve unfinished settings and quantity edits.
function canCheckPrices(){return !document.hidden&&!$('dialog[open]:not(#compare-dialog)')&&!document.activeElement?.matches('#compare-content input');}
setInterval(()=>{if(canCheckPrices())loadItems({background:true});},60000);
document.addEventListener('visibilitychange',()=>{if(canCheckPrices())loadItems({background:true});});
window.addEventListener('popstate',()=>{Object.assign(state,stateFromLocation(location.search,preferences));loadItems({clear:true});});
planner=initPlanner({state,getPreferences:()=>preferences,persist,loadItems,toast,esc,money,imageUrl,modeNames});
renderCategories();syncControls();loadItems();
