use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

mod planner;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Offer {
    #[serde(default)]
    trader_id: Option<String>,
    trader: String,
    price: Option<f64>,
    currency: String,
    price_rub: Option<f64>,
    level: Option<u64>,
    quest: Option<String>,
    #[serde(default)]
    access_allowed: Option<bool>,
    #[serde(default)]
    access_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grid {
    width: u64,
    height: u64,
    allowed: Vec<String>,
    excluded: Vec<String>,
    #[serde(default)]
    rules: Option<planner::PocketRules>,
}

const MAX_POCKETS: usize = 128;
const MAX_STORAGE_CELLS: u64 = 10000;

// Partial/unknown layouts are supported, but no layout may exceed its stated
// capacity or the rendering budget. Check raw feeds and cached catalogues alike.
fn valid_layout(capacity: u64, grids: &[Grid]) -> bool {
    if capacity == 0 || capacity > MAX_STORAGE_CELLS || grids.len() > MAX_POCKETS {
        return false;
    }
    let mut cells = 0_u64;
    for grid in grids {
        if grid.width == 0 || grid.height == 0 || grid.width > 100 || grid.height > 100 {
            return false;
        }
        let Some(total) = grid
            .width
            .checked_mul(grid.height)
            .and_then(|area| cells.checked_add(area))
        else {
            return false;
        };
        if total > capacity {
            return false;
        }
        cells = total;
    }
    true
}

fn read_catalogue(value: &Value) -> Result<Vec<Item>, String> {
    let items: Vec<Item> =
        serde_json::from_value(value.clone()).map_err(|e| format!("Invalid catalogue: {e}"))?;
    if items
        .iter()
        .any(|item| !valid_layout(item.capacity, &item.grids))
    {
        return Err("Invalid pocket layout in catalogue".into());
    }
    Ok(items)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PocketSize {
    width: u64,
    height: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    name: String,
    short_name: String,
    description: String,
    category: String,
    width: u64,
    height: u64,
    footprint: u64,
    capacity: u64,
    gain: i64,
    efficiency: f64,
    #[serde(default)]
    pocket_score: Option<f64>,
    #[serde(default)]
    largest_pocket: Option<PocketSize>,
    weight: Option<f64>,
    image: String,
    large_image: String,
    wiki: String,
    grids: Vec<Grid>,
    restrictions: Vec<String>,
    exclusions: Vec<String>,
    restrictions_known: bool,
    offers: Vec<Offer>,
    trader_price: Option<f64>,
    trader_name: Option<String>,
    trader_level: Option<u64>,
    flea_price: Option<f64>,
    flea_average: Option<f64>,
    flea_enabled: bool,
    quote_updated: Option<String>,
    source: String,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default)]
    cost_source: Option<String>,
    #[serde(default)]
    cost_per_slot: Option<f64>,
    #[serde(default)]
    cost_per_gain: Option<f64>,
    #[serde(default)]
    cost_per_efficiency: Option<f64>,
    #[serde(default)]
    access_summary: Vec<String>,
    #[serde(default)]
    fit: Option<Value>,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}
fn positive(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n > 0.0)
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn named(v: &Value, names: &BTreeMap<String, String>) -> String {
    if let Some(id) = v.as_str() {
        names
            .get(id)
            .cloned()
            .unwrap_or_else(|| format!("Item/category {id}"))
    } else {
        let name = text(v, "name");
        if name.is_empty() {
            let id = text(v, "id");
            names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| format!("Item/category {id}"))
        } else {
            name
        }
    }
}
fn unique(values: impl Iterator<Item = String>) -> Vec<String> {
    values
        .filter(|v| !v.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn normalize(raw: &Value, names: &BTreeMap<String, String>) -> Option<Item> {
    let id = text(raw, "id");
    let name = text(raw, "name");
    let width = raw["width"].as_u64()?;
    let height = raw["height"].as_u64()?;
    let footprint = width.checked_mul(height)?;
    if footprint == 0 || width > 100 || height > 100 || id.is_empty() || name.is_empty() {
        return None;
    }
    let properties = &raw["properties"];
    let raw_grids = if properties["grids"].is_array() {
        &properties["grids"]
    } else {
        &raw["grids"]
    };
    if array(raw_grids).len() > MAX_POCKETS {
        return None;
    }
    let grids: Vec<Grid> = array(raw_grids)
        .iter()
        .map(|grid| {
            let w = grid["width"].as_u64()?;
            let h = grid["height"].as_u64()?;
            if w == 0 || h == 0 || w > 100 || h > 100 {
                return None;
            }
            let filters = &grid["filters"];
            Some(Grid {
                width: w,
                height: h,
                rules: planner::PocketRules::from_raw(filters),
                allowed: unique(
                    array(&filters["allowedCategories"])
                        .iter()
                        .chain(array(&filters["allowedItems"]).iter())
                        .map(|v| named(v, names)),
                ),
                excluded: unique(
                    array(&filters["excludedCategories"])
                        .iter()
                        .chain(array(&filters["excludedItems"]).iter())
                        .map(|v| named(v, names)),
                ),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let capacity = properties["capacity"]
        .as_u64()
        .or_else(|| raw["capacity"].as_u64())
        .unwrap_or_else(|| grids.iter().map(|g| g.width * g.height).sum());
    if !valid_layout(capacity, &grids) {
        return None;
    }
    let types: Vec<&str> = array(&raw["types"])
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let category =
        if types.contains(&"rig") || text(properties, "__typename") == "ItemPropertiesChestRig" {
            if text(raw, "kind") == "armoured"
                || types.contains(&"armor")
                || properties["class"].as_u64().unwrap_or(0) > 0
                || !array(&properties["armorSlots"]).is_empty()
            {
                "armored-rig"
            } else {
                "rig"
            }
        } else if types.contains(&"backpack") {
            "backpack"
        } else if name.to_lowercase().contains("secure container") {
            "secure"
        } else if types.contains(&"container")
            || text(properties, "__typename") == "ItemPropertiesContainer"
        {
            "container"
        } else {
            return None;
        };
    let raw_offers = if raw["buyFromTrader"].is_array() {
        &raw["buyFromTrader"]
    } else {
        &raw["buyFor"]
    };
    let mut offers: Vec<Offer> = array(raw_offers)
        .iter()
        .filter_map(|o| {
            let vendor = &o["vendor"];
            let mut trader = text(o, "traderName");
            if trader.is_empty() {
                trader = text(vendor, "name");
            }
            if trader.is_empty() {
                trader = text(o, "trader");
            }
            if trader.is_empty() || trader.to_lowercase().contains("flea") {
                return None;
            }
            let currency = text(o, "currency");
            let price = positive(&o["price"]);
            let price_rub =
                positive(&o["priceRUB"]).or_else(|| if currency == "RUB" { price } else { None });
            if price.is_none() && price_rub.is_none() {
                return None;
            }
            let quest = o.get("taskUnlock").or_else(|| vendor.get("taskUnlock"));
            let quest_name = quest
                .map(|q| {
                    if q.is_string() {
                        q.as_str().unwrap_or("").to_string()
                    } else {
                        text(q, "name")
                    }
                })
                .filter(|q| !q.is_empty());
            Some(Offer {
                trader_id: o
                    .get("trader")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .or_else(|| vendor.get("id").and_then(Value::as_str).map(str::to_owned)),
                trader,
                price,
                currency,
                price_rub,
                level: o["minTraderLevel"]
                    .as_u64()
                    .or_else(|| vendor["minTraderLevel"].as_u64()),
                quest: quest_name,
                access_allowed: None,
                access_reason: None,
            })
        })
        .collect();
    offers.sort_by(|a, b| nullable_cmp(a.price_rub, b.price_rub, false));
    let best_trader = offers.iter().find(|o| o.price_rub.is_some());
    let trader_price = best_trader.and_then(|o| o.price_rub);
    let trader_name = best_trader.map(|o| o.trader.clone());
    let trader_level = best_trader.and_then(|o| o.level);
    let flea_enabled = raw["fleaEnabled"]
        .as_bool()
        .unwrap_or(!types.contains(&"noFlea"));
    let flea_price = if flea_enabled {
        positive(&raw["lastLowPrice"]).or_else(|| positive(&raw["fleaPrice"]))
    } else {
        None
    };
    let flea_average = if flea_enabled {
        positive(&raw["avg24hPrice"]).or_else(|| positive(&raw["fleaAvg24h"]))
    } else {
        None
    };
    let restrictions = unique(grids.iter().flat_map(|g| g.allowed.iter().cloned()));
    let exclusions = unique(grids.iter().flat_map(|g| g.excluded.iter().cloned()));
    let restrictions_known =
        !grids.is_empty() && array(raw_grids).iter().all(|g| g["filters"].is_object());
    let image = text(raw, "iconLink");
    let large_image = [
        "image512pxLink",
        "inspectImageLink",
        "baseImageLink",
        "iconLink",
    ]
    .iter()
    .map(|k| text(raw, k))
    .find(|v| !v.is_empty())
    .unwrap_or_default();
    let mut item = Item {
        id,
        name,
        short_name: text(raw, "shortName"),
        description: text(raw, "description"),
        category: category.into(),
        width,
        height,
        footprint,
        capacity,
        gain: capacity as i64 - footprint as i64,
        efficiency: capacity as f64 / footprint as f64,
        pocket_score: None,
        largest_pocket: None,
        weight: raw["weight"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0),
        image,
        large_image,
        wiki: text(raw, "wikiLink"),
        grids,
        restrictions,
        exclusions,
        restrictions_known,
        offers,
        trader_price,
        trader_name,
        trader_level,
        flea_price,
        flea_average,
        flea_enabled,
        quote_updated: raw["quoteUpdated"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        source: text(raw, "source"),
        cost: None,
        cost_source: None,
        cost_per_slot: None,
        cost_per_gain: None,
        cost_per_efficiency: None,
        access_summary: Vec::new(),
        fit: None,
    };
    assign_pocket_score(&mut item);
    Some(item)
}

fn assign_pocket_score(item: &mut Item) {
    // Recalculate on queries too: existing cached catalogues need no migration,
    // and previously derived values must not override the supplied pocket layout.
    item.pocket_score = None;
    item.largest_pocket = None;
    if item.capacity == 0 || item.capacity > 10000 || item.grids.is_empty() {
        return;
    }
    let mut cells = 0_u64;
    let mut weighted_area = 0_u64;
    let mut largest: Option<&Grid> = None;
    for grid in &item.grids {
        if grid.width == 0 || grid.height == 0 || grid.width > 100 || grid.height > 100 {
            return;
        }
        let area = grid.width * grid.height;
        // This bound also keeps arithmetic bounded for old or malformed caches.
        if area > item.capacity - cells {
            return;
        }
        cells += area;
        weighted_area += area * area;
        let key = (area, grid.width.min(grid.height), grid.width);
        if largest.is_none_or(|previous| {
            key > (
                previous.width * previous.height,
                previous.width.min(previous.height),
                previous.width,
            )
        }) {
            largest = Some(grid);
        }
    }
    // Partial layouts must not get an artificially high or low score.
    if cells != item.capacity {
        return;
    }
    item.pocket_score = Some(weighted_area as f64 / cells as f64);
    item.largest_pocket = largest.map(|grid| PocketSize {
        width: grid.width,
        height: grid.height,
    });
}

fn nullable_cmp(a: Option<f64>, b: Option<f64>, descending: bool) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => {
            let order = a.total_cmp(&b);
            if descending {
                order.reverse()
            } else {
                order
            }
        }
    }
}
fn metric(item: &Item, field: &str) -> Option<f64> {
    match field {
        "footprint" => Some(item.footprint as f64),
        "capacity" => Some(item.capacity as f64),
        "gain" => Some(item.gain as f64),
        "efficiency" => Some(item.efficiency),
        "pocketScore" => item.pocket_score,
        "weight" => item.weight,
        "traderPrice" => item.trader_price,
        "fleaPrice" => item.flea_price,
        "fleaAverage" => item.flea_average,
        "cost" => item.cost,
        "costPerSlot" => item.cost_per_slot,
        "costPerGain" => item.cost_per_gain,
        "costPerEfficiency" => item.cost_per_efficiency,
        _ => None,
    }
}
fn valid_field(field: &str) -> bool {
    [
        "name",
        "category",
        "footprint",
        "capacity",
        "gain",
        "efficiency",
        "pocketScore",
        "weight",
        "traderPrice",
        "fleaPrice",
        "fleaAverage",
        "cost",
        "costPerSlot",
        "costPerGain",
        "costPerEfficiency",
    ]
    .contains(&field)
}
fn assign_cost(item: &mut Item, source: &str) {
    let (cost, label) = match source {
        "trader" => (item.trader_price, item.trader_name.clone()),
        "flea" => (item.flea_price, Some("Flea market".into())),
        "average" => (item.flea_average, Some("24h flea average".into())),
        _ => match (item.trader_price, item.flea_price) {
            (Some(a), Some(b)) if a <= b => (Some(a), item.trader_name.clone()),
            (_, Some(b)) => (Some(b), Some("Flea market".into())),
            (Some(a), _) => (Some(a), item.trader_name.clone()),
            _ => (None, None),
        },
    };
    item.cost = cost;
    item.cost_source = if cost.is_some() { label } else { None };
    item.cost_per_slot = cost.map(|p| p / item.capacity as f64);
    item.cost_per_gain = if item.gain > 0 {
        cost.map(|p| p / item.gain as f64)
    } else {
        None
    };
    item.cost_per_efficiency = if item.efficiency.is_finite() && item.efficiency > 0.0 {
        cost.map(|p| p / item.efficiency)
    } else {
        None
    };
}

fn query_items(mut items: Vec<Item>, q: &Value) -> Result<Value, String> {
    query_items_with_categories(std::mem::take(&mut items), q, &[])
}

fn query_items_with_categories(
    mut items: Vec<Item>,
    q: &Value,
    categories: &[Value],
) -> Result<Value, String> {
    let access = planner::Access::parse(&q["access"])?;
    let shape = planner::Shape::parse(&q["shape"])?;
    let source = q["source"].as_str().unwrap_or("best");
    if !["best", "flea", "trader", "average"].contains(&source) {
        return Err("Unknown price source".into());
    }
    let category = q["category"].as_str().unwrap_or("all");
    if ![
        "all",
        "rigs",
        "rig",
        "armored-rig",
        "backpack",
        "container",
        "secure",
    ]
    .contains(&category)
    {
        return Err("Unknown category".into());
    }
    let search = q["search"].as_str().unwrap_or("").to_lowercase();
    if search.len() > 200 {
        return Err("Search is too long".into());
    }
    let min_eff = q["minEfficiency"].as_f64().unwrap_or(0.0);
    if !(0.0..=1000.0).contains(&min_eff) {
        return Err("Invalid minimum efficiency".into());
    }
    let max_price = q["maxPrice"].as_f64();
    let ids = q.get("ids");
    if ids.is_some_and(|ids| {
        !ids.is_array()
            || array(ids).len() > 100
            || array(ids)
                .iter()
                .any(|id| !id.is_string() || id.as_str().unwrap_or("").len() > 64)
    }) {
        return Err("Invalid item selection".into());
    }
    if max_price.is_some_and(|p| p < 0.0 || !p.is_finite()) {
        return Err("Invalid budget".into());
    }
    let sorts = if q["sort"].is_array() {
        array(&q["sort"]).to_vec()
    } else {
        vec![json!({"field":"efficiency","direction":"desc"})]
    };
    if sorts.len() > 2 {
        return Err("Use at most two sort levels".into());
    }
    for sort in &sorts {
        if !valid_field(&text(sort, "field"))
            || !["asc", "desc"].contains(&sort["direction"].as_str().unwrap_or(""))
        {
            return Err("Invalid sort field or direction".into());
        }
    }
    let mut counts = BTreeMap::<String, usize>::new();
    for item in &items {
        *counts.entry(item.category.clone()).or_default() += 1;
    }
    let total = items.len();
    for item in &mut items {
        assign_pocket_score(item);
        planner::price_item(item, source, &access);
        item.fit = shape
            .as_ref()
            .map(|s| planner::fit_item(item, s, categories));
    }
    items.retain(|i| {
        let matches_category = category == "all"
            || i.category == category
            || (category == "rigs" && (i.category == "rig" || i.category == "armored-rig"));
        matches_category
            && (q["filterShape"].as_bool() == Some(false)
                || i.fit
                    .as_ref()
                    .is_none_or(|fit| fit["matches"].as_bool().unwrap_or(false)))
            && ids.is_none_or(|selected| {
                array(selected)
                    .iter()
                    .any(|id| id.as_str() == Some(i.id.as_str()))
            })
            && (search.is_empty()
                || format!("{} {}", i.name, i.short_name)
                    .to_lowercase()
                    .contains(&search))
            && i.efficiency >= min_eff
            && (!q["positiveOnly"].as_bool().unwrap_or(false) || i.gain > 0)
            && max_price.is_none_or(|budget| i.cost.is_some_and(|cost| cost <= budget))
    });
    items.sort_by(|a, b| {
        for sort in &sorts {
            let field = text(sort, "field");
            let descending = text(sort, "direction") == "desc";
            let cmp = if field == "name" || field == "category" {
                let cmp = if field == "name" {
                    a.name.to_lowercase().cmp(&b.name.to_lowercase())
                } else {
                    a.category.cmp(&b.category)
                };
                if descending {
                    cmp.reverse()
                } else {
                    cmp
                }
            } else {
                nullable_cmp(metric(a, &field), metric(b, &field), descending)
            };
            if cmp != Ordering::Equal {
                return cmp;
            }
        }
        a.name.cmp(&b.name).then(a.id.cmp(&b.id))
    });
    let best_efficiency = items.iter().map(|i| i.efficiency).max_by(f64::total_cmp);
    let max_gain = items.iter().map(|i| i.gain).max();
    let lowest_gain_cost = items
        .iter()
        .filter_map(|i| i.cost_per_gain)
        .min_by(f64::total_cmp);
    Ok(
        json!({"items":items,"total":total,"counts":counts,"summary":{"bestEfficiency":best_efficiency,"maxGain":max_gain,"lowestGainCost":lowest_gain_cost},"query":q}),
    )
}

pub fn run(request: Value) -> Result<Value, String> {
    match request["op"].as_str().unwrap_or("query") {
        "normalize" => {
            let mut names = BTreeMap::new();
            for cat in array(&request["categories"])
                .iter()
                .chain(array(&request["items"]).iter())
            {
                let id = text(cat, "id");
                let name = text(cat, "name");
                if !id.is_empty() && !name.is_empty() {
                    names.insert(id, name);
                }
            }
            let mut ids = BTreeSet::new();
            let items: Vec<Item> = array(&request["items"])
                .iter()
                .filter_map(|r| normalize(r, &names))
                .filter(|i| ids.insert(i.id.clone()))
                .collect();
            if items.is_empty() {
                return Err("No valid storage items in this feed".into());
            }
            Ok(json!({"items":items}))
        }
        "query" => {
            let items = read_catalogue(&request["items"])?;
            if request["categories"].is_array() {
                query_items_with_categories(items, &request["query"], array(&request["categories"]))
            } else {
                query_items(items, &request["query"])
            }
        }
        "compare" => {
            let items = read_catalogue(&request["items"])?;
            planner::compare(items, &request["query"], array(&request["categories"]))
        }
        _ => Err("Unknown operation".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn raw(id: &str, inside: u64, w: u64, h: u64, cost: Value) -> Value {
        json!({"id":id,"name":id,"width":w,"height":h,"types":["rig"],"properties":{"capacity":inside},"lastLowPrice":cost})
    }
    fn item(raw: Value) -> Item {
        normalize(&raw, &BTreeMap::new()).unwrap()
    }
    #[test]
    fn storage_uses_footprint_and_does_not_count_plate_slots() {
        let mut v = raw("Skanda", 25, 4, 3, json!(100000));
        v["properties"]["armorSlots"] = json!([{"name":"front"},{"name":"back"}]);
        let i = item(v);
        assert_eq!(i.gain, 13);
        assert_eq!(i.capacity, 25);
        assert_eq!(i.category, "armored-rig");
        assert!((i.efficiency - 25.0 / 12.0).abs() < 1e-10);
        assert!(normalize(&raw("broken", 20, 0, 3, Value::Null), &BTreeMap::new()).is_none());
    }
    #[test]
    fn cash_purchase_never_uses_sell_price_or_unconverted_currency() {
        let mut v = raw("case", 64, 4, 4, Value::Null);
        v["sellToTrader"] = json!([{"priceRUB":10}]);
        v["price"] = json!(10);
        v["buyFromTrader"] = json!([{"traderName":"Therapist","currency":"EUR","price":19121},{"traderName":"Ragman","currency":"RUB","price":90000,"minTraderLevel":3}]);
        let i = item(v);
        assert_eq!(i.trader_price, Some(90000.0));
        assert_eq!(i.trader_level, Some(3));
        assert_eq!(i.offers[1].price_rub, None);
    }
    #[test]
    fn no_flea_and_zero_prices_are_unknown() {
        let mut v = raw("restricted", 20, 3, 3, json!(40000));
        v["types"] = json!(["rig", "noFlea"]);
        assert_eq!(item(v).flea_price, None);
        assert_eq!(item(raw("zero", 20, 3, 3, json!(0))).flea_price, None);
    }
    #[test]
    fn two_level_sort_respects_primary_then_cheaper_ties() {
        let values = vec![
            item(raw("expensive", 24, 4, 3, json!(80000))),
            item(raw("best", 24, 3, 3, json!(100000))),
            item(raw("cheap", 18, 3, 3, json!(40000))),
        ];
        let out=query_items(values,&json!({"sort":[{"field":"efficiency","direction":"desc"},{"field":"cost","direction":"asc"}]})).unwrap();
        assert_eq!(out["items"][0]["name"], "best");
        assert_eq!(out["items"][1]["name"], "cheap");
    }
    #[test]
    fn unknown_prices_sort_last_both_directions() {
        for direction in ["asc", "desc"] {
            let out = query_items(
                vec![
                    item(raw("unknown", 20, 4, 3, Value::Null)),
                    item(raw("priced", 20, 4, 3, json!(50000))),
                ],
                &json!({"sort":[{"field":"cost","direction":direction}]}),
            )
            .unwrap();
            assert_eq!(out["items"][1]["name"], "unknown");
        }
    }
    #[test]
    fn neutral_or_negative_gain_has_no_cost_per_gain() {
        for inside in [9, 8] {
            let mut i = item(raw("neutral", inside, 3, 3, json!(10000)));
            assign_cost(&mut i, "best");
            assert_eq!(i.cost_per_gain, None);
        }
    }
    #[test]
    fn filters_compose_and_budget_excludes_unknowns() {
        let rows = vec![
            item(raw("Zhuk black", 20, 4, 3, json!(40000))),
            item(raw("Zhuk SURPAT", 20, 4, 3, json!(60000))),
            item(raw("Zhuk missing", 20, 4, 3, Value::Null)),
            item(raw("Alpha", 20, 4, 4, json!(20000))),
        ];
        let out = query_items(
            rows,
            &json!({"category":"rig","search":"zhuk","minEfficiency":1.66,"maxPrice":50000}),
        )
        .unwrap();
        assert_eq!(out["items"].as_array().unwrap().len(), 1);
        assert_eq!(out["items"][0]["gain"], 8);
    }
    #[test]
    fn storage_restrictions_resolve_names() {
        let mut v = raw("med bag", 48, 4, 5, Value::Null);
        v["types"] = json!(["backpack"]);
        v["properties"]["grids"] = json!([{"width":6,"height":8,"filters":{"allowedCategories":["meds"],"excludedItems":[]}}]);
        let i = normalize(&v, &BTreeMap::from([("meds".into(), "Meds".into())])).unwrap();
        assert_eq!(i.restrictions, vec!["Meds"]);
        assert!(i.restrictions_known);
    }

    fn pocket_item(id: &str, pockets: &[(u64, u64)], cost: u64) -> Item {
        let capacity = pockets.iter().map(|(w, h)| w * h).sum();
        let mut value = raw(id, capacity, 2, 2, json!(cost));
        value["properties"]["grids"] = json!(pockets
            .iter()
            .map(|(width, height)| { json!({"width": width, "height": height}) })
            .collect::<Vec<_>>());
        item(value)
    }

    #[test]
    fn pocket_score_ranks_the_requested_equal_capacity_examples() {
        let large = pocket_item("one 2x2", &[(2, 2)], 100);
        let medium = pocket_item("two 2x1", &[(2, 1), (2, 1)], 100);
        let small = pocket_item("four 1x1", &[(1, 1); 4], 100);
        assert_eq!(large.pocket_score, Some(4.0));
        assert_eq!(medium.pocket_score, Some(2.0));
        assert_eq!(small.pocket_score, Some(1.0));
        assert_eq!(large.largest_pocket.unwrap().width, 2);
    }

    #[test]
    fn pocket_score_weights_each_cell_and_is_rotation_and_scale_invariant() {
        let mixed = pocket_item("mixed", &[(2, 2), (1, 2), (1, 1)], 100);
        let rotated = pocket_item("rotated", &[(2, 2), (2, 1), (1, 1)], 100);
        let doubled = pocket_item(
            "doubled",
            &[(2, 2), (1, 2), (1, 1), (2, 2), (1, 2), (1, 1)],
            100,
        );
        assert_eq!(mixed.pocket_score, Some(3.0));
        assert_eq!(mixed.pocket_score, rotated.pocket_score);
        assert_eq!(mixed.pocket_score, doubled.pocket_score);
        // Shape is visible in the layout, but this metric intentionally rates area.
        assert_eq!(pocket_item("long", &[(1, 4)], 100).pocket_score, Some(4.0));
    }

    #[test]
    fn incomplete_layouts_are_unscored_and_sort_last_in_both_directions() {
        let mut partial = pocket_item("partial", &[(2, 2)], 100);
        partial.capacity = 20;
        for direction in ["asc", "desc"] {
            let result = query_items(
                vec![partial.clone(), pocket_item("known", &[(1, 2); 2], 100)],
                &json!({"sort":[{"field":"pocketScore","direction":direction}]}),
            )
            .unwrap();
            assert_eq!(result["items"][1]["name"], "partial");
            assert!(result["items"][1]["pocketScore"].is_null());
            assert!(result["items"][1]["largestPocket"].is_null());
        }
        let mut invalid = partial;
        invalid.grids[0].height = 0;
        assign_pocket_score(&mut invalid);
        assert!(invalid.pocket_score.is_none());
    }

    #[test]
    fn pocket_score_supports_primary_and_secondary_sorting() {
        let items = vec![
            pocket_item("small", &[(1, 1); 4], 100),
            pocket_item("dearer large", &[(2, 2)], 200),
            pocket_item("cheaper large", &[(2, 2)], 100),
        ];
        let primary = query_items(items.clone(), &json!({"sort":[{"field":"pocketScore","direction":"desc"},{"field":"cost","direction":"asc"}]})).unwrap();
        assert_eq!(primary["items"][0]["name"], "cheaper large");
        assert_eq!(primary["items"][1]["name"], "dearer large");
        assert_eq!(primary["items"][2]["name"], "small");
        let secondary = query_items(items, &json!({"sort":[{"field":"cost","direction":"asc"},{"field":"pocketScore","direction":"desc"}]})).unwrap();
        assert_eq!(secondary["items"][0]["name"], "cheaper large");
        assert_eq!(secondary["items"][1]["name"], "small");
    }

    #[test]
    fn cost_per_efficiency_uses_selected_purchase_source() {
        let mut value = raw("two times", 18, 3, 3, json!(40000));
        value["avg24hPrice"] = json!(45000);
        value["buyFromTrader"] = json!([{"traderName":"Ragman","currency":"RUB","price":50000}]);
        let mut rig = item(value);
        for (source, expected) in [
            ("best", 20000.0),
            ("flea", 20000.0),
            ("trader", 25000.0),
            ("average", 22500.0),
        ] {
            assign_cost(&mut rig, source);
            assert_eq!(rig.cost_per_efficiency, Some(expected));
        }
        rig.efficiency = 0.0;
        assign_cost(&mut rig, "best");
        assert_eq!(rig.cost_per_efficiency, None);
    }

    #[test]
    fn cost_per_efficiency_sorts_by_value_with_missing_prices_last() {
        let items = vec![
            item(raw("unpriced", 18, 3, 3, Value::Null)),
            item(raw("costly", 18, 3, 3, json!(60000))),
            item(raw("value", 18, 3, 3, json!(40000))),
        ];
        for direction in ["asc", "desc"] {
            let sorted = query_items(
                items.clone(),
                &json!({"sort":[{"field":"costPerEfficiency","direction":direction}]}),
            )
            .unwrap();
            assert_eq!(
                sorted["items"][0]["name"],
                if direction == "asc" {
                    "value"
                } else {
                    "costly"
                }
            );
            assert_eq!(sorted["items"][2]["name"], "unpriced");
            assert!(sorted["items"][2]["costPerEfficiency"].is_null());
        }
        let tie_break = query_items(items, &json!({"sort":[{"field":"efficiency","direction":"desc"},{"field":"costPerEfficiency","direction":"asc"}]})).unwrap();
        assert_eq!(tie_break["items"][0]["name"], "value");
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn run_json(input: &str) -> String {
    let result = serde_json::from_str(input)
        .map_err(|error| error.to_string())
        .and_then(run);
    match result {
        Ok(value) => value.to_string(),
        Err(message) => json!({"error": message}).to_string(),
    }
}
