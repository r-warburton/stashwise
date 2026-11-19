// Defensive display boundary; mirrors the core's layout budget.
export function pocketMarkup(item, compact=false) {
  const grids=item?.grids,capacity=item?.capacity;
  if(!Array.isArray(grids)||!Number.isSafeInteger(capacity)||capacity<1||capacity>10000||grids.length>128)
    return '<span class="detail-caption">Layout unavailable.</span>';
  let cells=0;
  for(const grid of grids){
    const {width,height}=grid||{};
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>100||height>100||(cells+=width*height)>capacity)
      return '<span class="detail-caption">Layout unavailable.</span>';
  }
  if(!grids.length)return '<span class="detail-caption">Layout not supplied.</span>';
  return grids.map((grid,index)=>{
    const match=compact?item.fit?.pockets?.find(pocket=>pocket.index===index):null;
    const status=['confirmed','dimensions','unknown','blocked'].includes(match?.status)?match.status:null;
    const matching=status&&status!=='blocked';
    return `<div><div class="pocket ${matching?'matching-pocket':''}" style="grid-template-columns:repeat(${grid.width},${compact?8:15}px)" role="img" aria-label="${grid.width} by ${grid.height} pocket${status?`, ${status}`:''}">${'<span class="pocket-cell"></span>'.repeat(grid.width*grid.height)}</div><span class="pocket-label">${grid.width} × ${grid.height}${matching?' ✓':''}</span></div>`;
  }).join('');
}

