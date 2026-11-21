//! The capability index (`toolcall/capabilities.ts`, `calibration.ts`): what an agent can find, and in which order.
//!
//! The library index ranks the entries it is given; persistence and policy filtering belong to the ports (the registry of
//! [`super::registry`], the caller's view). An entry is kept as the JSON object it was registered as, members in their
//! order, because the store keeps `JSON.stringify(entry)` and compares that text. A ranking is the same ranking only when
//! the scores are the same doubles: the sums are formed in TypeScript's order and the logarithm is V8's
//! ([`super::math::js_log`]); `fixtures/parity/capabilities/index.json` compares the printed scores.
use super::json::{parse_units, JsStr, Obj, Parsed, V};
use super::math::js_log;
use super::tables::category_prefix;
use super::validation::Thrown;
use std::collections::HashMap;
use std::sync::OnceLock;

/// The kinds an entry may have (`CapabilityKind`).
pub const KINDS: &[&str] = &[
    "tool",
    "skill",
    "mcp-tool",
    "extension",
    "plugin-command",
    "channel-action",
];
/// The effects an entry may have (`Effect` of the policy).
pub const EFFECTS: &[&str] = &[
    "read",
    "local-write",
    "local-destructive",
    "external",
    "network.a2a",
    "money",
];
/// The risks an entry may have (`Risk` of the policy).
pub const RISKS: &[&str] = &["low", "medium", "high", "critical"];

/// One registered capability (`CapabilityEntry`): the object as registered. Made by [`CapabilityEntry::new`], which is
/// the registration check, so every entry in an index or a store passed it.
#[derive(Clone, Debug)]
pub struct CapabilityEntry(Obj);

impl CapabilityEntry {
    /// The object.
    pub fn object(&self) -> &Obj {
        &self.0
    }

    /// `JSON.stringify(entry)`.
    pub fn text(&self) -> String {
        V::Obj(self.0.clone()).stringify()
    }

    /// The object as a value.
    pub fn to_v(&self) -> V {
        V::Obj(self.0.clone())
    }

    /// A string member; empty when it is absent.
    pub fn field(&self, key: &str) -> String {
        self.0
            .get(key)
            .and_then(V::as_js)
            .map(JsStr::lossy)
            .unwrap_or_default()
    }

    /// A string member that may be absent.
    pub fn optional(&self, key: &str) -> Option<String> {
        self.0.get(key).and_then(V::as_js).map(JsStr::lossy)
    }

    /// `entry.id`.
    pub fn id(&self) -> String {
        self.field("id")
    }

    /// `entry.name`.
    pub fn name(&self) -> String {
        self.field("name")
    }

    /// `entry.category`.
    pub fn category(&self) -> String {
        self.field("category")
    }

    /// `entry.source`.
    pub fn source(&self) -> String {
        self.field("source")
    }

    /// `entry.version`.
    pub fn version(&self) -> String {
        self.field("version")
    }

    /// `entry.enabled !== false`.
    pub fn enabled(&self) -> bool {
        !matches!(self.0.get("enabled"), Some(V::Bool(false)))
    }

    fn secondary(&self, category: &str) -> bool {
        self.0
            .get("secondaryCategories")
            .and_then(V::as_arr)
            .is_some_and(|list| list.iter().any(|c| c.is_str(category)))
    }
}

/// `SearchFilters`. An empty string filters nothing, as in TypeScript.
#[derive(Clone, Debug, Default)]
pub struct SearchFilters {
    /// Primary or secondary category.
    pub category: Option<String>,
    /// Kind.
    pub kind: Option<String>,
    /// Effect.
    pub effect: Option<String>,
    /// Source.
    pub source: Option<String>,
    /// At most this many hits (0 to 128); absent is 12.
    pub limit: Option<f64>,
}

/// One hit (`SearchHit`).
#[derive(Clone, Debug)]
pub struct SearchHit {
    /// The entry.
    pub entry: CapabilityEntry,
    /// The score.
    pub score: f64,
    /// Why it scored: `lexical:<term>`, `fts5`, `embedding`, `usage-prior`, `fallback:no lexical overlap`,
    /// `category:<filter>`.
    pub reasons: Vec<String>,
}

impl SearchHit {
    /// `{ entry, score, reasons }`.
    pub fn to_v(&self) -> V {
        V::obj([
            ("entry", self.entry.to_v()),
            ("score", V::Num(self.score)),
            ("reasons", V::strs(&self.reasons)),
        ])
    }
}

/// What [`CapabilityIndex::route`] returns.
#[derive(Clone, Debug)]
pub struct Routed {
    /// The selected hits.
    pub items: Vec<SearchHit>,
    /// The answer is the remembered one of the same question at the same revision.
    pub cached: bool,
    /// A hint for a low-confidence routing.
    pub hint: Option<&'static str>,
}

impl Routed {
    /// `{ items, cached, hint? }`.
    pub fn to_v(&self) -> V {
        let mut v = V::obj([
            (
                "items",
                V::Arr(self.items.iter().map(SearchHit::to_v).collect()),
            ),
            ("cached", V::Bool(self.cached)),
        ]);
        if let (V::Obj(o), Some(hint)) = (&mut v, self.hint) {
            o.set("hint", V::s(hint));
        }
        v
    }
}

/// Scores of a query against entries, by entry id (`EmbeddingPort`). Only a finite, positive score counts.
pub trait EmbeddingPort {
    /// The scores.
    fn score(&self, query: &str, entries: &[&CapabilityEntry]) -> HashMap<String, f64>;
}

/// The store's lexical ranking: where it is given, its score replaces the index's own.
pub type LexicalPort = Box<dyn Fn(&str, &[&CapabilityEntry]) -> HashMap<String, f64>>;
/// The usage prior of an entry. It changes ranking only; search and visibility never consume it.
pub type PriorPort = Box<dyn Fn(&CapabilityEntry) -> f64>;

/// `CapabilityIndex`: the library index. Entries are kept in registration order (an update keeps its place).
#[derive(Default)]
pub struct CapabilityIndex {
    entries: Vec<CapabilityEntry>,
    revision: u64,
    last: Option<(String, Vec<SearchHit>, Option<&'static str>)>,
    embedding: Option<Box<dyn EmbeddingPort>>,
    lexical: Option<LexicalPort>,
    prior: Option<PriorPort>,
}

/// `CalibrationConfig`: how much recorded use may move a ranking.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CalibrationConfig {
    /// Offers below which there is no prior.
    pub min_offers: f64,
    /// The largest bonus.
    pub max_bonus: f64,
    /// The largest penalty.
    pub max_penalty: f64,
    /// Half-life of a recorded event, in days.
    pub half_life_days: f64,
    /// The success rate that earns nothing.
    pub success_target: f64,
    /// Weight of the success rate.
    pub success_weight: f64,
    /// Weight of "found by search although offered".
    pub search_weight: f64,
}

/// `CapabilityStats`: counts, possibly decayed and so fractional.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CapabilityStats {
    /// Times offered.
    pub offered: f64,
    /// Times used.
    pub used: f64,
    /// Times found by search.
    pub found_by_search: f64,
    /// Times a use succeeded.
    pub succeeded: f64,
}

/// `calibration.defaults.json`.
pub const CALIBRATION_DEFAULTS: &str = r#"{
  "minOffers": 10,
  "maxBonus": 0.2,
  "maxPenalty": 0.2,
  "halfLifeDays": 14,
  "successTarget": 0.8,
  "successWeight": 0.5,
  "searchWeight": 0.1
}"#;

/// `/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/`: a two-level category id.
pub fn valid_category(text: &str) -> bool {
    let segment = |s: &str| {
        let b = s.as_bytes();
        b.first().is_some_and(u8::is_ascii_lowercase)
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
    };
    text.split_once('.')
        .is_some_and(|(group, child)| segment(group) && segment(child))
}

fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

fn token_pattern() -> Option<&'static regress::Regex> {
    static PATTERN: OnceLock<Option<regress::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| regress::Regex::with_flags(r"[\p{L}\p{N}_]+", "u").ok())
        .as_ref()
}

/// The runs of letters, digits and `_` in `units` (`/[\p{L}\p{N}_]+/gu`), as written. Also the store's term rule.
pub(super) fn word_runs(units: &[u16]) -> Vec<String> {
    token_pattern().map_or_else(Vec::new, |pattern| {
        pattern
            .find_from_utf16(units, 0)
            .map(|m| String::from_utf16_lossy(&units[m.range()]))
            .collect()
    })
}

/// `tokens(s)`: the word runs of the lower-cased text.
pub(super) fn tokens(text: &str) -> Vec<String> {
    let units: Vec<u16> = text.to_lowercase().encode_utf16().collect();
    word_runs(&units)
}

impl CapabilityEntry {
    /// The registration check of `CapabilityIndex.upsert`: identity, texts, source and version are non-empty strings,
    /// kind, effect and risk are known words, the category is a two-level id, and there are at most two secondary
    /// categories. Stricter than TypeScript on a malformed entry: a member of the wrong type is refused here, where
    /// TypeScript only asks whether it is truthy.
    pub fn new(entry: &V) -> Result<CapabilityEntry, Thrown> {
        let invalid = || Thrown::error("invalid capability entry");
        let o = entry.as_obj().ok_or_else(invalid)?;
        let text = |key: &str| {
            o.get(key)
                .and_then(V::as_js)
                .filter(|s| !s.is_empty())
                .map(JsStr::lossy)
        };
        let word = |key: &str, list: &[&str]| text(key).is_some_and(|w| list.contains(&w.as_str()));
        let secondary = match o.get("secondaryCategories") {
            None | Some(V::Null) => true,
            Some(V::Arr(list)) => list.len() <= 2,
            Some(_) => false,
        };
        let complete = ["id", "name", "description", "version", "source"]
            .iter()
            .all(|key| text(key).is_some());
        if !complete
            || !word("kind", KINDS)
            || !word("effect", EFFECTS)
            || !word("risk", RISKS)
            || !text("category").is_some_and(|c| valid_category(&c))
            || !secondary
        {
            return Err(invalid());
        }
        Ok(CapabilityEntry(o.clone()))
    }

    /// `textOf(e)`: what the lexical ranking reads of an entry.
    fn search_text(&self) -> String {
        format!(
            "{} {} {} {} {}",
            self.name(),
            self.field("description"),
            self.category(),
            self.field("useWhen"),
            self.field("inputs")
        )
    }
}

/// The comparator of both rankings: the larger number first, equal numbers by name in code-unit order.
fn descending(a: (f64, &str), b: (f64, &str)) -> std::cmp::Ordering {
    let difference = b.0 - a.0;
    if difference > 0.0 {
        std::cmp::Ordering::Greater
    } else if difference < 0.0 {
        std::cmp::Ordering::Less
    } else {
        crate::js::compare_utf16(a.1, b.1)
    }
}

impl CapabilityIndex {
    /// An index with its ports: an embedding score, the store's lexical ranking, a usage prior.
    pub fn new(
        embedding: Option<Box<dyn EmbeddingPort>>,
        lexical: Option<LexicalPort>,
        prior: Option<PriorPort>,
    ) -> Self {
        CapabilityIndex {
            embedding,
            lexical,
            prior,
            ..CapabilityIndex::default()
        }
    }

    /// `upsert`: registers or replaces an entry; a replaced entry keeps its place.
    pub fn upsert(&mut self, entry: &V) -> Result<(), Thrown> {
        let entry = CapabilityEntry::new(entry)?;
        let id = entry.id();
        match self.entries.iter_mut().find(|e| e.id() == id) {
            Some(slot) => *slot = entry,
            None => self.entries.push(entry),
        }
        self.revision += 1;
        Ok(())
    }

    /// `remove`.
    pub fn remove(&mut self, id: &str) {
        let before = self.entries.len();
        self.entries.retain(|e| e.id() != id);
        if self.entries.len() != before {
            self.revision += 1;
        }
    }

    /// The entries, in registration order.
    pub fn entries(&self) -> &[CapabilityEntry] {
        &self.entries
    }

    /// `categoriesPrefix`.
    pub fn categories_prefix(&self) -> String {
        category_prefix()
    }

    /// `search`: every enabled entry that passes the filters, ranked. The index's own score is BM25 over name,
    /// description, category, `useWhen` and `inputs`; a lexical port replaces it, an embedding adds to it, and a prior
    /// moves only entries that scored. An entry without any score is still returned (`fallback:no lexical overlap`),
    /// after the scored ones.
    pub fn search(&self, query: &str, filters: &SearchFilters) -> Result<Vec<SearchHit>, Thrown> {
        let limit = filters.limit.unwrap_or(12.0);
        if !is_safe_integer(limit) || !(0.0..=128.0).contains(&limit) {
            return Err(Thrown::error("search limit must be 0..128"));
        }
        let wanted = |filter: &Option<String>| filter.clone().filter(|f| !f.is_empty());
        let (category, kind, effect, source) = (
            wanted(&filters.category),
            wanted(&filters.kind),
            wanted(&filters.effect),
            wanted(&filters.source),
        );
        let entries: Vec<&CapabilityEntry> = self
            .entries
            .iter()
            .filter(|e| {
                e.enabled()
                    && category
                        .as_ref()
                        .is_none_or(|c| e.category() == *c || e.secondary(c))
                    && kind.as_ref().is_none_or(|k| e.field("kind") == *k)
                    && effect.as_ref().is_none_or(|x| e.field("effect") == *x)
                    && source.as_ref().is_none_or(|s| e.source() == *s)
            })
            .collect();
        let ids: Vec<String> = entries.iter().map(|e| e.id()).collect();
        let docs: Vec<Vec<String>> = entries.iter().map(|e| tokens(&e.search_text())).collect();
        let total: usize = docs.iter().map(Vec::len).sum();
        let average = total as f64 / docs.len().max(1) as f64;
        let average = if average == 0.0 { 1.0 } else { average };
        let mut terms: Vec<String> = Vec::new();
        for term in tokens(query) {
            if !terms.contains(&term) {
                terms.push(term);
            }
        }
        let frequency: Vec<f64> = terms
            .iter()
            .map(|term| docs.iter().filter(|d| d.contains(term)).count() as f64)
            .collect();
        let semantic = self
            .embedding
            .as_ref()
            .map(|port| port.score(query, &entries));
        let lexical = self.lexical.as_ref().map(|port| port(query, &entries));
        let count = docs.len() as f64;
        let mut hits: Vec<SearchHit> = Vec::with_capacity(entries.len());
        for ((entry, id), doc) in entries.iter().zip(&ids).zip(&docs) {
            let mut score = 0.0;
            let mut reasons: Vec<String> = Vec::new();
            for (term, df) in terms.iter().zip(&frequency) {
                let tf = doc.iter().filter(|t| *t == term).count() as f64;
                if tf == 0.0 {
                    continue;
                }
                score += js_log(1.0 + (count - df + 0.5) / (df + 0.5)) * tf * 2.2
                    / (tf + 1.2 * (0.25 + 0.75 * doc.len() as f64 / average));
                reasons.push(format!("lexical:{term}"));
            }
            if let Some(lexical) = &lexical {
                score = lexical.get(id).copied().unwrap_or(0.0);
                if score > 0.0 {
                    reasons.push("fts5".to_owned());
                }
            }
            if let Some(embedding) = semantic
                .as_ref()
                .and_then(|s| s.get(id))
                .copied()
                .filter(|e| e.is_finite() && *e > 0.0)
            {
                score += embedding;
                reasons.push("embedding".to_owned());
            }
            if score > 0.0 {
                let prior = self.prior.as_ref().map_or(0.0, |port| port(entry));
                score += prior;
                if prior != 0.0 && !prior.is_nan() {
                    reasons.push("usage-prior".to_owned());
                }
            }
            if reasons.is_empty() {
                reasons.push("fallback:no lexical overlap".to_owned());
            }
            if let Some(category) = &category {
                reasons.push(format!("category:{category}"));
            }
            hits.push(SearchHit {
                entry: (*entry).clone(),
                score,
                reasons,
            });
        }
        let mut order: Vec<usize> = (0..hits.len()).collect();
        order.sort_by(|a, b| descending((hits[*a].score, &ids[*a]), (hits[*b].score, &ids[*b])));
        let limit = limit as usize;
        let mut slots: Vec<Option<SearchHit>> = hits.into_iter().map(Some).collect();
        Ok(order
            .into_iter()
            .take(limit)
            .filter_map(|i| slots[i].take())
            .collect())
    }

    /// `route`: the offer for one task. The three most probable categories share `top_k` in proportion (largest
    /// remainders first); with low confidence a category that got nothing takes one place from the largest; what the
    /// categories leave free is filled from the unfiltered ranking. The same question at the same revision is answered
    /// from memory. `distribution` is an object's entries: names are distinct.
    pub fn route(
        &mut self,
        query: &str,
        distribution: &[(String, f64)],
        top_k: f64,
        confidence: f64,
    ) -> Result<Routed, Thrown> {
        if !is_safe_integer(top_k) || !(0.0..=128.0).contains(&top_k) {
            return Err(Thrown::error("routing budget must be 0..128"));
        }
        if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
            return Err(Thrown::error("invalid confidence"));
        }
        let invalid = || Thrown::error("invalid category distribution");
        if distribution.iter().any(|(_, p)| !p.is_finite() || *p < 0.0) {
            return Err(invalid());
        }
        let mut categories: Vec<&(String, f64)> = distribution.iter().collect();
        categories.sort_by(|a, b| descending((a.1, &a.0), (b.1, &b.0)));
        categories.truncate(3);
        let sum = categories.iter().fold(0.0, |n, (_, p)| n + p);
        if categories.is_empty() || sum <= 0.0 {
            return Err(invalid());
        }
        let pairs = categories
            .iter()
            .map(|(name, p)| V::Arr(vec![V::s(name), V::Num(*p)]))
            .collect();
        let key = V::Arr(vec![
            V::Num(self.revision as f64),
            V::s(query),
            V::Arr(pairs),
            V::Num(top_k),
            V::Num(confidence),
        ])
        .stringify();
        if let Some((_, items, hint)) = self.last.as_ref().filter(|(last, _, _)| *last == key) {
            return Ok(Routed {
                items: items.clone(),
                cached: true,
                hint: *hint,
            });
        }
        let share = |p: f64| top_k * p / sum;
        let mut quotas: Vec<f64> = categories.iter().map(|(_, p)| share(*p).floor()).collect();
        let remainders: Vec<f64> = categories.iter().map(|(_, p)| share(*p) % 1.0).collect();
        let mut spare = top_k - quotas.iter().fold(0.0, |n, q| n + q);
        let mut by_remainder: Vec<usize> = (0..quotas.len()).collect();
        by_remainder.sort_by(|a, b| descending((remainders[*a], ""), (remainders[*b], "")));
        for i in by_remainder {
            if spare > 0.0 {
                quotas[i] += 1.0;
            }
            spare -= 1.0;
        }
        if confidence < 0.5 && top_k >= quotas.len() as f64 {
            for i in 0..quotas.len() {
                if quotas[i] == 0.0 {
                    // The first of the largest: a stable sort by quota, largest first.
                    let donor =
                        (0..quotas.len())
                            .fold(0, |best, j| if quotas[j] > quotas[best] { j } else { best });
                    if quotas[donor] > 1.0 {
                        quotas[donor] -= 1.0;
                        quotas[i] += 1.0;
                    }
                }
            }
        }
        let mut selected: Vec<SearchHit> = Vec::new();
        let place = |selected: &mut Vec<SearchHit>, hit: SearchHit, replace: bool| {
            let id = hit.entry.id();
            match selected.iter_mut().find(|s| s.entry.id() == id) {
                Some(slot) if replace => *slot = hit,
                Some(_) => {}
                None => selected.push(hit),
            }
        };
        for ((name, _), quota) in categories.iter().zip(&quotas) {
            let filters = SearchFilters {
                category: Some(name.clone()),
                limit: Some(*quota),
                ..SearchFilters::default()
            };
            for hit in self.search(query, &filters)? {
                place(&mut selected, hit, true);
            }
        }
        let wanted = top_k as usize;
        if selected.len() < wanted {
            let all = SearchFilters {
                limit: Some(128.0),
                ..SearchFilters::default()
            };
            for hit in self.search(query, &all)? {
                if selected.len() == wanted {
                    break;
                }
                place(&mut selected, hit, false);
            }
        }
        let hint = (confidence < 0.5)
            .then_some("Low confidence: use capabilities.search to discover alternatives.");
        self.last = Some((key, selected.clone(), hint));
        Ok(Routed {
            items: selected,
            cached: false,
            hint,
        })
    }
}

/// `loadCalibration`: the built-in defaults for `None`, else the text of an installation's file, validated: exactly
/// the seven members, each a finite number that is not negative, within their ranges. Anything else is refused.
pub fn load_calibration(text: Option<&str>) -> Result<CalibrationConfig, Thrown> {
    let units: Vec<u16> = text
        .unwrap_or(CALIBRATION_DEFAULTS)
        .encode_utf16()
        .collect();
    let value = match parse_units(&units) {
        Ok(Parsed::Value(v)) => v,
        Ok(Parsed::TooDeep { .. }) => V::Null,
        Err(_) => return Err(Thrown::syntax()),
    };
    let invalid = || Thrown::error("invalid capability calibration");
    let fields = [
        "minOffers",
        "maxBonus",
        "maxPenalty",
        "halfLifeDays",
        "successTarget",
        "successWeight",
        "searchWeight",
    ];
    let o = value.as_obj().ok_or_else(invalid)?;
    let mut n = [0.0; 7];
    for (slot, key) in n.iter_mut().zip(fields) {
        *slot = o
            .get(key)
            .and_then(V::as_f64)
            .filter(|x| x.is_finite() && *x >= 0.0)
            .ok_or_else(invalid)?;
    }
    let [min_offers, max_bonus, max_penalty, half_life_days, success_target, success_weight, search_weight] =
        n;
    let unknown = o
        .entries()
        .iter()
        .any(|(key, _)| !fields.iter().any(|f| key.is(f)));
    if unknown
        || min_offers < 1.0
        || half_life_days <= 0.0
        || max_bonus > 1.0
        || max_penalty > 1.0
        || success_target > 1.0
    {
        return Err(invalid());
    }
    Ok(CalibrationConfig {
        min_offers,
        max_bonus,
        max_penalty,
        half_life_days,
        success_target,
        success_weight,
        search_weight,
    })
}

/// `Math.min` and `Math.max` for two numbers: `NaN` wins.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `usagePrior`: what recorded use adds to a score. The agent's own statistics count once it was offered the entry
/// often enough, else everyone's; below that threshold there is no prior. A prior changes ranking only.
pub fn usage_prior(
    agent: &CapabilityStats,
    global: &CapabilityStats,
    config: &CalibrationConfig,
) -> f64 {
    let stats = if agent.offered >= config.min_offers {
        agent
    } else {
        global
    };
    if stats.offered < config.min_offers {
        return 0.0;
    }
    let success = if stats.used != 0.0 && !stats.used.is_nan() {
        (stats.succeeded + 1.0) / (stats.used + 2.0)
    } else {
        config.success_target
    };
    let missed = js_min(1.0, stats.found_by_search / stats.offered);
    js_max(
        -config.max_penalty,
        js_min(
            config.max_bonus,
            config.success_weight * (success - config.success_target)
                + config.search_weight * missed,
        ),
    )
}
