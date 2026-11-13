use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PocketRules {
    allowed_categories: Vec<String>,
    excluded_categories: Vec<String>,
    allowed_items: Vec<String>,
    excluded_items: Vec<String>,
}
impl PocketRules {
    pub(super) fn from_raw(v: &Value) -> Option<Self> {
        if !v.is_object() {
            return None;
        }
        let ids = |key: &str| {
            unique(array(&v[key]).iter().filter_map(|entry| {
                entry
                    .as_str()
                    .or_else(|| entry["id"].as_str())
                    .map(str::to_owned)
            }))
        };
        Some(Self {
            allowed_categories: ids("allowedCategories"),
            excluded_categories: ids("excludedCategories"),
            allowed_items: ids("allowedItems"),
            excluded_items: ids("excludedItems"),
        })
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Access {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    flea: Option<bool>,
    #[serde(default)]
    traders: BTreeMap<String, Option<u8>>,
    #[serde(default)]
    quests: Vec<String>,
}
impl Access {
    pub(super) fn parse(v: &Value) -> Result<Self, String> {
        if v.is_null() {
            return Ok(Self::default());
        }
        let result: Self =
            serde_json::from_value(v.clone()).map_err(|_| "Invalid trader access settings")?;
        if result.traders.len() > 20
            || result.quests.len() > 64
            || result
                .traders
                .iter()
                .any(|(key, level)| key.len() > 128 || level.is_some_and(|v| v > 4))
            || result
                .quests
                .iter()
                .any(|id| id.is_empty() || id.len() > 128)
        {
            return Err("Invalid trader access settings".into());
        }
        Ok(result)
    }
}

pub(super) fn price_item(item: &mut Item, source: &str, access: &Access) {
    item.access_summary.clear();
    for offer in &mut item.offers {
        offer.access_allowed = None;
        offer.access_reason = None;
        if !access.enabled {
            continue;
        }
        let level = access
            .traders
            .get(offer.trader_id.as_deref().unwrap_or(&offer.trader))
            .or_else(|| access.traders.get(&offer.trader))
            .copied()
            .flatten();
        let mut reasons = Vec::new();
        match (level, offer.level) {
            (None, _) => reasons.push("Trader access not confirmed".to_string()),
            (Some(0), _) => reasons.push("Trader unavailable".to_string()),
            (Some(_), None) => reasons.push("Loyalty requirement unavailable".to_string()),
            (Some(level), Some(required)) if u64::from(level) < required => {
                reasons.push(format!("Requires LL{required}"))
            }
            _ => {}
        }
        if offer
            .quest
            .as_ref()
            .is_some_and(|quest| !access.quests.contains(quest))
        {
            reasons.push("Quest unlock not confirmed".into());
        }
        if offer.price_rub.is_none() {
            reasons.push("Rouble price unavailable".into());
        }
        offer.access_allowed = Some(reasons.is_empty());
        if !reasons.is_empty() {
            let reason = reasons.join("; ");
            item.access_summary
                .push(format!("{}: {reason}", offer.trader));
            offer.access_reason = Some(reason);
        }
    }
    if access.enabled {
        let best = item
            .offers
            .iter()
            .filter(|offer| offer.access_allowed == Some(true) && offer.price_rub.is_some())
            .min_by(|a, b| nullable_cmp(a.price_rub, b.price_rub, false));
        item.trader_price = best.and_then(|o| o.price_rub);
        item.trader_name = best.map(|o| o.trader.clone());
        item.trader_level = best.and_then(|o| o.level);
    }
    let flea = item.flea_price;
    let average = item.flea_average;
    if access.enabled && access.flea != Some(true) {
        item.flea_price = None;
        item.flea_average = None;
        item.access_summary.push(
            if access.flea == Some(false) {
                "Flea: access disabled"
            } else {
                "Flea: access not confirmed"
            }
            .into(),
        );
    }
    assign_cost(item, source);
    // Market reference quotes remain visible; only confirmed usable offers
    // participate in acquisition-price selection and the derived metrics.
    item.flea_price = flea;
    item.flea_average = average;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Shape {
    width: u64,
    height: u64,
    #[serde(default = "yes")]
    rotate: bool,
    #[serde(default)]
    category_id: String,
}
fn yes() -> bool {
    true
}
impl Shape {
    pub(super) fn parse(v: &Value) -> Result<Option<Self>, String> {
        if v.is_null() {
            return Ok(None);
        }
        let shape: Self = serde_json::from_value(v.clone()).map_err(|_| "Invalid item shape")?;
        if shape.width == 0
            || shape.height == 0
            || shape.width > 100
            || shape.height > 100
            || shape.category_id.len() > 64
        {
            return Err("Invalid item shape".into());
        }
        Ok(Some(shape))
    }
}
fn ancestry(id: &str, categories: &[Value]) -> (BTreeSet<String>, bool) {
    let mut path = BTreeSet::new();
    let mut current = id.to_owned();
    for _ in 0..128 {
        if !path.insert(current.clone()) {
            return (path, false);
        }
        let Some(category) = categories
            .iter()
            .find(|c| c["id"].as_str() == Some(&current))
        else {
            return (path, false);
        };
        let parent = category["parent"].as_str().unwrap_or("");
        if parent.is_empty() {
            return (path, true);
        }
        current = parent.to_owned();
    }
    (path, false)
}
fn restriction_status(
    rules: &Option<PocketRules>,
    shape: &Shape,
    categories: &[Value],
) -> &'static str {
    if shape.category_id.is_empty() {
        return if rules.is_some() {
            "dimensions"
        } else {
            "unknown"
        };
    }
    let Some(rules) = rules else {
        return "unknown";
    };
    let (path, complete) = ancestry(&shape.category_id, categories);
    if rules.excluded_categories.iter().any(|id| path.contains(id)) {
        return "blocked";
    }
    let partial_exclusion = rules
        .excluded_categories
        .iter()
        .any(|id| ancestry(id, categories).0.contains(&shape.category_id));
    let allowed = rules.allowed_categories.is_empty() && rules.allowed_items.is_empty()
        || rules.allowed_categories.iter().any(|id| path.contains(id));
    if allowed {
        return if !complete || partial_exclusion || !rules.excluded_items.is_empty() {
            "unknown"
        } else {
            "confirmed"
        };
    }
    if !complete
        || !rules.allowed_items.is_empty()
        || rules
            .allowed_categories
            .iter()
            .any(|id| ancestry(id, categories).0.contains(&shape.category_id))
    {
        "unknown"
    } else {
        "blocked"
    }
}
pub(super) fn fit_item(item: &Item, shape: &Shape, categories: &[Value]) -> Value {
    let pockets:Vec<Value>=item.grids.iter().enumerate().filter_map(|(index,grid)|{
        let straight=shape.width<=grid.width&&shape.height<=grid.height;
        let rotated=shape.rotate&&shape.height<=grid.width&&shape.width<=grid.height;
        if !straight&&!rotated{return None;}
        Some(json!({"index":index,"width":grid.width,"height":grid.height,"rotated":!straight,"status":restriction_status(&grid.rules,shape,categories)}))
    }).collect();
    let status = if pockets.iter().any(|p| p["status"] == "confirmed") {
        "confirmed"
    } else if pockets.iter().any(|p| p["status"] == "dimensions") {
        "dimensions"
    } else if pockets.iter().any(|p| p["status"] == "unknown") {
        "unknown"
    } else if pockets.is_empty() {
        "no-fit"
    } else {
        "blocked"
    };
    let label = match status {
        "confirmed" => "Dimensions and category fit",
        "dimensions" => "Dimensions fit; item restrictions not checked",
        "unknown" => "Dimensions fit; restrictions unknown",
        "blocked" => "Category blocked by pocket rules",
        _ => "No pocket fits these dimensions",
    };
    json!({"matches":!["blocked","no-fit"].contains(&status),"status":status,"label":label,"pockets":pockets})
}

pub(super) fn compare(items: Vec<Item>, q: &Value, categories: &[Value]) -> Result<Value, String> {
    let lines = q["lines"]
        .as_array()
        .ok_or("Invalid comparison selection")?;
    if lines.is_empty() || lines.len() > 4 {
        return Err("Choose one to four comparison items".into());
    }
    let access = Access::parse(&q["access"])?;
    let shape = Shape::parse(&q["shape"])?;
    let source = q["source"].as_str().unwrap_or("best");
    if !["best", "trader", "flea", "average"].contains(&source) {
        return Err("Unknown price source".into());
    }
    let mut seen = BTreeSet::new();
    let mut rows = Vec::new();
    let mut quantity = 0;
    let mut unpriced = 0;
    let mut missing = 0;
    let mut cost = 0.0;
    let mut footprint = 0;
    let mut capacity = 0;
    let mut gain = 0_i64;
    for line in lines {
        let id = line["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 64)
            .ok_or("Invalid comparison item")?;
        let qty = line["quantity"]
            .as_u64()
            .filter(|q| (1..=99).contains(q))
            .ok_or("Invalid comparison quantity")?;
        if !seen.insert(id) {
            return Err("Invalid duplicate comparison item".into());
        }
        quantity += qty;
        let Some(mut item) = items.iter().find(|item| item.id == id).cloned() else {
            missing += 1;
            unpriced += qty;
            rows.push(json!({"id":id,"quantity":qty,"item":null}));
            continue;
        };
        assign_pocket_score(&mut item);
        price_item(&mut item, source, &access);
        item.fit = shape
            .as_ref()
            .map(|shape| fit_item(&item, shape, categories));
        let line_cost = item.cost.map(|c| c * qty as f64);
        if let Some(line_cost) = line_cost {
            cost += line_cost;
        } else {
            unpriced += qty;
        }
        footprint += item.footprint * qty;
        capacity += item.capacity * qty;
        gain += item.gain * qty as i64;
        rows.push(json!({"id":id,"quantity":qty,"cost":line_cost,"footprint":item.footprint*qty,"capacity":item.capacity*qty,"gain":item.gain*qty as i64,"item":item}));
    }
    Ok(
        json!({"rows":rows,"totals":{"quantity":quantity,"cost":if unpriced==0{Some(cost)}else{None},"knownCost":cost,"unpricedQuantity":unpriced,"missingItems":missing,"footprint":if missing==0{Some(footprint)}else{None},"capacity":if missing==0{Some(capacity)}else{None},"gain":if missing==0{Some(gain)}else{None},"costPerGain":if unpriced==0&&gain>0{Some(cost/gain as f64)}else{None}}}),
    )
}
