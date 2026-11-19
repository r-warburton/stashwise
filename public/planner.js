import {pocketMarkup} from './pockets.js';
import {apiFetch} from './transport.js';
import {cleanAccess} from './preferences.js';

export function initPlanner({state,getPreferences,persist,loadItems,toast,esc,money,imageUrl,modeNames}) {
  const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
  let options=null,optionsMode='',optionsRevision='',optionsController,optionsNumber=0;
  let comparison=null,comparisonKey='',comparisonContext='',comparisonController,comparisonNumber=0,comparisonError='',lastRevision='',pending=false,changedPrices=false,focusQuantity=null;
  const profile=()=>cleanAccess(getPreferences().accessProfiles[state.mode]);
  function requestParams(params){
    for(const key of ['shapeEnabled','shapeWidth','shapeHeight','shapeRotate','shapeCategory','accessMode'])params.delete(key);
    if(state.shapeEnabled)params.set('shape',JSON.stringify({width:Number(state.shapeWidth),height:Number(state.shapeHeight),rotate:state.shapeRotate,categoryId:state.shapeCategory}));
    if(state.accessMode==='mine')params.set('access',JSON.stringify({...profile(),enabled:true}));
    return params;
  }
  const priceContext=()=>JSON.stringify([state.mode,state.source,state.accessMode,state.accessMode==='mine'?profile():null]);
  const comparisonParams=()=>requestParams(new URLSearchParams({mode:state.mode,source:state.source,lines:JSON.stringify(getPreferences().comparison)}));
  function compareButton(item){const selected=getPreferences().comparison.some(line=>line.id===item.id);return `<button class="compare-toggle" data-compare="${esc(item.id)}" aria-pressed="${selected}" aria-label="${selected?'Remove':'Add'} ${esc(item.name)} ${selected?'from':'to'} comparison">${selected?'✓':'+'}<span class="sr-only"> Compare</span></button>`;}
  function sync(){
    $('#shape-enabled').checked=state.shapeEnabled;$('#shape-width').value=state.shapeWidth;$('#shape-height').value=state.shapeHeight;$('#shape-rotate').checked=state.shapeRotate;
    if(state.shapeCategory&&!Array.from($('#shape-category').options).some(option=>option.value===state.shapeCategory))$('#shape-category').add(new Option('Saved category · awaiting source',state.shapeCategory));
    $('#shape-category').value=state.shapeCategory;$('#access-settings').textContent=state.accessMode==='mine'?'Offers: my access':'Offers: all listed';
    $$('[data-compare]').forEach(button=>{const selected=getPreferences().comparison.some(line=>line.id===button.dataset.compare);button.setAttribute('aria-pressed',String(selected));button.firstChild.textContent=selected?'✓':'+';const item=comparison?.rows.find(row=>row.id===button.dataset.compare)?.item;if(item)button.setAttribute('aria-label',`${selected?'Remove':'Add'} ${item.name} ${selected?'from':'to'} comparison`);});
    renderTray();if($('#compare-dialog').open)renderComparison();
  }
  async function loadOptions({fillAccess=false,force=false}={}) {
    if(options&&optionsMode===state.mode&&optionsRevision===lastRevision&&!force){if(fillAccess)renderAccess();return;}
    optionsController?.abort();const controller=optionsController=new AbortController(),number=++optionsNumber,mode=state.mode;
    if(fillAccess){$('#access-status').textContent='Loading traders and purchase requirements…';$('#apply-access').disabled=true;$('#retry-access').hidden=true;}
    try {
      const response=await apiFetch(`/api/planner-options?mode=${mode}`,{signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'Options unavailable');
      if(number!==optionsNumber||mode!==state.mode)return;
      options=data;optionsMode=mode;optionsRevision=data.meta.revision;
      $('#shape-category').innerHTML='<option value="">Dimensions only</option>'+data.categories.map(category=>`<option value="${esc(category.id)}">${esc(category.name)}</option>`).join('');
      $('#planner-options-status').textContent=data.categories.length?'':'Category metadata is unavailable. Dimension checks still work; restrictions remain unknown.';
      sync();if(fillAccess&&$('#access-dialog').open)renderAccess();
    } catch(error){if(error.name==='AbortError')return;$('#planner-options-status').textContent='Category options unavailable. Dimension checks still work.';if(fillAccess){$('#access-status').textContent=error.message;$('#retry-access').hidden=false;$('#apply-access').disabled=true;}}
  }
  function renderAccess(){
    const access=profile();$('#access-market').textContent=`${modeNames[state.mode]} access settings`;$('#access-status').textContent='';$('#apply-access').disabled=false;$('#retry-access').hidden=true;
    $('#access-scope').value=state.accessMode;$('#access-flea').value=access.flea===null?'unknown':String(access.flea);
    $('#trader-levels').innerHTML=options.traders.map(trader=>`<label class="field"><span>${esc(trader.name)}</span><select data-trader="${esc(trader.id)}" aria-label="${esc(trader.name)} loyalty level"><option value="unknown">Not confirmed</option><option value="0">Unavailable</option>${[1,2,3,4].map(level=>`<option value="${level}">Loyalty level ${level}</option>`).join('')}</select></label>`).join('');
    for(const select of $$('[data-trader]'))select.value=access.traders[select.dataset.trader]==null?'unknown':String(access.traders[select.dataset.trader]);
    $('#quest-unlocks').innerHTML=options.quests.length?options.quests.map(quest=>`<label class="quest-option"><input type="checkbox" data-quest="${esc(quest.id)}" ${access.quests.includes(quest.id)?'checked':''}><span><strong>${esc(quest.name||'Quest purchase unlock')}</strong><span>${esc(quest.offers.join(' · '))}</span><small>Source requirement: ${esc(quest.id)}</small></span></label>`).join(''):'<p class="detail-caption">No quest-gated cash offers are supplied for this catalogue.</p>';
  }
  function renderTray(){
    const lines=getPreferences().comparison;$('#compare-tray').hidden=!lines.length;document.body.classList.toggle('has-comparison',Boolean(lines.length));
    $('#open-compare').textContent=`Compare (${lines.length}/4)`;
    $('#compare-tray-status').textContent=pending?'Updating…':comparisonError?'Prices unavailable · retry in Compare':'';
    $('#compare-pills').innerHTML=lines.map(line=>{const item=comparison?.rows.find(row=>row.id===line.id)?.item;const src=imageUrl(item?.image);return `<div class="compare-pill">${src?`<img src="${esc(src)}" alt="" width="28" height="28">`:''}<span>${esc(item?.shortName||item?.name||line.id)}${line.quantity>1?` × ${line.quantity}`:''}</span><button class="text-button" data-remove-compare="${esc(line.id)}" aria-label="Remove ${esc(item?.name||line.id)} from comparison">×</button></div>`;}).join('');
  }
  function pocketDiagram(item){return `<div class="pockets compare-pockets">${pocketMarkup(item,true)}</div>`;}
  let comparisonRenderDeferred=false;
  function renderComparison(){
    const lines=getPreferences().comparison,context=priceContext(),sameData=comparison&&comparisonContext===context&&comparison.queryKey===comparisonParams().toString();
    $('#compare-context').textContent=`${modeNames[state.mode]} · ${state.source==='best'?'Cheapest cash / flea':state.source==='trader'?'Trader cash':state.source==='average'?'24h flea average':'Latest flea'} · ${state.accessMode==='mine'?'My accessible offers':'All listed offers'}`;
    $('#compare-content').setAttribute('aria-busy',String(pending));
    $('#compare-notice').textContent=comparisonError||(pending?'Updating comparison…':changedPrices?'One or more selected prices changed. Your selections are kept.':comparison?.meta.checkDelayed?'Published price updates are delayed; these prices may be outdated.':comparison?.meta.stale?'Some source quotes are old or unavailable; check offers before buying.':'');
    // A price/options response can finish after editing has started. Keep the
    // input and its draft until focus leaves; the latest result stays in memory.
    if(document.activeElement?.matches('#compare-content input')){comparisonRenderDeferred=true;return;}
    comparisonRenderDeferred=false;
    if(!lines.length){$('#compare-content').innerHTML='<p class="detail-caption">Use the + buttons beside items to compare up to four candidates.</p>';return;}
    if(!sameData){$('#compare-content').innerHTML=comparisonError?'<button class="button secondary" data-retry-compare>Retry comparison</button>':'<p class="detail-caption">Loading the selected items and prices…</p>';return;}
    const number=value=>value==null?'—':String(value);
    const metric=(label,value)=>`<div><dt>${label}</dt><dd>${value}</dd></div>`;
    $('#compare-content').innerHTML=`${comparisonError?'<button class="button secondary" data-retry-compare>Retry comparison</button>':''}<div class="comparison-grid" style="--compare-columns:${comparison.rows.length}">${comparison.rows.map(row=>{
      const item=row.item;
      if(!item)return `<article class="compare-card"><h3>Item unavailable in this market</h3><p class="detail-caption">${esc(row.id)}</p><button class="text-button" data-remove-compare="${esc(row.id)}">Remove item</button></article>`;
      const src=imageUrl(item.image);
      return `<article class="compare-card" data-compare-id="${esc(row.id)}"><div class="compare-identity">${src?`<img src="${esc(src)}" alt="${esc(item.name)}" width="64" height="64" loading="lazy">`:''}<h3>${esc(item.name)}</h3></div><div class="compare-actions"><label class="field"><span>Quantity</span><input type="number" data-compare-quantity="${esc(row.id)}" aria-label="Quantity for ${esc(item.name)}" min="1" max="99" step="1" value="${row.quantity}"></label><button class="text-button" data-remove-compare="${esc(row.id)}">Remove</button></div>
      <dl class="compare-metrics">${metric('Purchase cost / item',money(item.cost))}${metric('Cost / extra slot',money(item.costPerGain))}${metric('Cost / efficiency',money(item.costPerEfficiency))}${metric('Cost / inside slot',money(item.costPerSlot))}${metric('Efficiency',`${item.efficiency.toFixed(2)}×`)}${metric('Pocket score',item.pocketScore==null?'—':item.pocketScore.toFixed(2))}${metric('Inside / footprint',`${item.capacity} / ${item.footprint}`)}${metric('Extra slots / item',`${item.gain>0?'+':''}${item.gain}`)}${metric('Quantity cost',money(row.cost))}${metric('Quantity extra slots',number(row.gain))}</dl><p class="detail-caption">${esc(item.costSource||'No priced accessible offer')}${item.gain<=0?' · No extra stash space':''}</p>${pocketDiagram(item)}${item.fit?`<p class="fit-label" data-fit-status="${item.fit.status}">${esc(item.fit.label)}</p>`:''}<details class="compare-rules"><summary>Storage restrictions &amp; access</summary><p>Allowed: ${esc(item.restrictions.join(', ')||'Not supplied')}</p><p>Excluded: ${esc(item.exclusions.join(', ')||'None supplied')}</p>${item.accessSummary.length?`<ul>${item.accessSummary.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul>`:''}<p>Quote: ${esc(item.quoteUpdated?new Date(item.quoteUpdated).toLocaleString():'Time unavailable')}</p></details></article>`;
    }).join('')}</div><section class="comparison-totals" aria-label="Combined independent-container totals"><h3>Combined totals · ${comparison.totals.quantity} items</h3><dl>${metric('Purchase total',comparison.totals.cost==null?'Incomplete':money(comparison.totals.cost))}${metric('Stash footprint',number(comparison.totals.footprint))}${metric('Inside slots',number(comparison.totals.capacity))}${metric('Extra slots',number(comparison.totals.gain))}${metric('Cost / extra slot',money(comparison.totals.costPerGain))}</dl>${comparison.totals.unpricedQuantity?`<p class="detail-caption">${comparison.totals.unpricedQuantity} items have no usable quote. Known priced subtotal: ${money(comparison.totals.knownCost)}. A complete total is unavailable.</p>`:''}${comparison.totals.missingItems?'<p class="detail-caption">Missing catalogue items prevent complete space totals.</p>':''}</section>`;
    for(const img of $$('#compare-content img'))img.addEventListener('error',()=>{img.hidden=true;},{once:true});
    if(focusQuantity&&!pending){$(`[data-compare-quantity="${CSS.escape(focusQuantity)}"]`)?.focus();focusQuantity=null;}
  }
  async function loadComparison({force=false,focusId=null}={}){
    const lines=getPreferences().comparison,params=comparisonParams(),key=`${lastRevision}:${params}`;
    if(!lines.length){comparisonController?.abort();comparisonNumber++;comparison=null;comparisonKey='';comparisonError='';pending=false;sync();return;}
    if(key===comparisonKey&&!force)return;
    focusQuantity=focusId||document.activeElement?.dataset.compareQuantity||null;
    comparisonController?.abort();const controller=comparisonController=new AbortController(),number=++comparisonNumber,context=priceContext();comparisonKey=key;pending=true;comparisonError='';sync();
    try{
      const response=await apiFetch(`/api/compare?${params}`,{signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'Comparison unavailable');
      if(number!==comparisonNumber||context!==priceContext())return;
      changedPrices=comparisonContext===context&&Boolean(comparison?.rows.some(row=>data.rows.some(next=>next.id===row.id&&next.item?.cost!==row.item?.cost)));
      comparison={...data,queryKey:params.toString()};comparisonContext=context;
    }catch(error){if(error.name==='AbortError'||number!==comparisonNumber)return;comparisonError='The comparison could not be updated. Retry to check the selected prices.';comparisonKey='';}
    finally{if(number===comparisonNumber){pending=false;sync();}}
  }
  function toggle(id){
    const prefs=getPreferences(),found=prefs.comparison.some(line=>line.id===id);
    if(found)prefs.comparison=prefs.comparison.filter(line=>line.id!==id);
    else {if(prefs.comparison.length>=4){toast('Compare up to four items. Remove one from the tray first.');return;}prefs.comparison.push({id,quantity:1});}
    persist();sync();loadComparison();
  }
  $('#shape-form').addEventListener('submit',event=>{event.preventDefault();if(!event.target.reportValidity())return;state.shapeEnabled=true;state.shapeWidth=$('#shape-width').value;state.shapeHeight=$('#shape-height').value;state.shapeRotate=$('#shape-rotate').checked;state.shapeCategory=$('#shape-category').value;loadItems();});
  $('#shape-enabled').addEventListener('change',()=>{if($('#shape-enabled').checked){$('#shape-form').requestSubmit();}else{state.shapeEnabled=false;loadItems();}});
  $('#access-settings').addEventListener('click',()=>{$('#access-market').textContent=`${modeNames[state.mode]} access settings`;$('#access-status').textContent='Loading…';$('#trader-levels').replaceChildren();$('#quest-unlocks').replaceChildren();$('#access-dialog').showModal();loadOptions({fillAccess:true});});
  $('#retry-access').addEventListener('click',()=>loadOptions({fillAccess:true,force:true}));
  $('#access-form').addEventListener('submit',event=>{
    event.preventDefault();if(!options||optionsMode!==state.mode)return;
    const next=profile();next.enabled=$('#access-scope').value==='mine';next.flea=$('#access-flea').value==='unknown'?null:$('#access-flea').value==='true';
    for(const select of $$('[data-trader]'))next.traders[select.dataset.trader]=select.value==='unknown'?null:Number(select.value);
    const shown=new Set(options.quests.map(quest=>quest.id));next.quests=next.quests.filter(id=>!shown.has(id)).concat($$('[data-quest]:checked').map(input=>input.dataset.quest));
    getPreferences().accessProfiles[state.mode]=cleanAccess(next);state.accessMode=next.enabled?'mine':'all';$('#access-dialog').close();loadItems();
  });
  $('#open-compare').addEventListener('click',()=>{$('#compare-dialog').showModal();renderComparison();loadComparison();});
  $('#clear-compare').addEventListener('click',()=>{getPreferences().comparison=[];persist();loadComparison();});
  document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.compare)toggle(button.dataset.compare);if(button.dataset.removeCompare)toggle(button.dataset.removeCompare);if(button.hasAttribute('data-retry-compare'))loadComparison({force:true});});
  $('#compare-content').addEventListener('change',event=>{
    const input=event.target;if(!input.dataset.compareQuantity)return;const line=getPreferences().comparison.find(line=>line.id===input.dataset.compareQuantity);if(!line)return;
    if(!input.checkValidity()){input.reportValidity();input.value=line.quantity;return;}
    line.quantity=Number(input.value);persist();loadComparison({focusId:input.dataset.compareQuantity});
  });
  $('#compare-content').addEventListener('focusout',event=>{
    // Let a newly focused comparison control finish its click/keyboard action.
    if(event.relatedTarget?.closest('#compare-content'))return;
    queueMicrotask(()=>{if(comparisonRenderDeferred&&$('#compare-dialog').open&&!document.activeElement?.matches('#compare-content input'))renderComparison();});
  });
  for(const [id,trigger]of [['access-dialog','access-settings'],['compare-dialog','open-compare']])$(`#${id}`).addEventListener('close',()=>{$(`#${trigger}`).focus();});
  return {requestParams,compareButton,sync,onData(data){lastRevision=data.meta.revision;if(comparison?.meta.revision===data.meta.revision){comparison.meta=data.meta;if($('#compare-dialog').open)renderComparison();}loadOptions();loadComparison();},modeChanged(){optionsController?.abort();optionsNumber++;state.accessMode=profile().enabled?'mine':'all';sync();loadComparison();},loadComparison};
}
