export function plannerOptions(snapshot) {
  const traders=new Map(),quests=new Map();
  for(const item of snapshot.items)for(const offer of item.offers){
    const id=offer.traderId||offer.trader;traders.set(id,{id,name:offer.trader});
    if(offer.quest){
      if(!quests.has(offer.quest))quests.set(offer.quest,{id:offer.quest,name:/^[a-f0-9]{24}$/i.test(offer.quest)?null:offer.quest,offers:[]});
      const label=`${offer.trader}: ${item.shortName||item.name}`;
      if(!quests.get(offer.quest).offers.includes(label))quests.get(offer.quest).offers.push(label);
    }
  }
  return {categories:(snapshot.fitCategories||[]).slice().sort((a,b)=>a.name.localeCompare(b.name)),traders:[...traders.values()].sort((a,b)=>a.name.localeCompare(b.name)),quests:[...quests.values()]};
}
