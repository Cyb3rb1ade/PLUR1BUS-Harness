//! Native C4 Neo scoring, latest-revision routing and cross-block lexical dedupe.
use super::{
    acl,
    merged::Record,
    merged_order::{field, record_id, string, time, truthy},
};
use crate::{
    capture::dynamics::number,
    context::RequestContext,
    recall::score::epistemic_score_boost,
    text::{
        js::{js_to_lower_case, JsString},
        json::TolerantJsonValue as Json,
    },
};
use std::collections::{HashMap, HashSet};
/// Node's stable lane order, also used to break equal score ties.
pub const LANES: [&str; 14] = [
    "recent_turns",
    "workspace_facts",
    "architecture_decisions",
    "technical_constraints",
    "tooling_constraints",
    "user_preferences",
    "behavior_cards",
    "failures_and_corrections",
    "open_questions",
    "todos",
    "shared_dreams",
    "agent_private_reflections",
    "code_context",
    "knowledge_md",
];
/// Caller-selected limits and the already bound query embedding.
pub struct Options<'a> {
    /// Maximum number of items in each lane.
    pub max_per_lane: usize,
    /// Strict lower score threshold (an equal score is excluded).
    pub min_score: f64,
    /// Optional native query vector; no provider is called by routing.
    pub query_vector: Option<&'a [f64]>,
}
/// A reference into the caller's authorized record collection.
#[derive(Clone, Debug)]
pub struct Hit {
    /// Index of the winning revision in the supplied record array.
    pub index: usize,
    /// Exact native floating-point score.
    pub score: f64,
}
/// One named lane, including empty lanes to retain stable formatting order.
#[derive(Clone, Debug)]
pub struct Lane {
    /// Fixed lane identifier.
    pub name: &'static str,
    /// Selected, ordered record references.
    pub hits: Vec<Hit>,
}
fn raw(row: &Json, name: &str) -> String {
    field(row, name)
        .map(string)
        .map(|s| s.to_utf8_lossy())
        .unwrap_or_default()
}
fn label(row: &Json, name: &str) -> String {
    match field(row, name) {
        Some(Json::String(s)) => s.to_utf8_lossy(),
        _ => String::new(),
    }
}
fn inherited_key(value: &str) -> bool {
    matches!(
        value,
        "constructor"
            | "__defineGetter__"
            | "__defineSetter__"
            | "hasOwnProperty"
            | "__lookupGetter__"
            | "__lookupSetter__"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toString"
            | "valueOf"
            | "__proto__"
            | "toLocaleString"
    )
}
fn text(row: &Json) -> String {
    ["statement", "content"]
        .iter()
        .find_map(|k| field(row, k).filter(|v| truthy(v)))
        .map(string)
        .map(|s| s.to_utf8_lossy())
        .unwrap_or_default()
}
fn tokens(text: &str) -> HashSet<String> {
    js_to_lower_case(text)
        .split(|c: char| !(c.is_ascii_alphanumeric() || "äöüß_-".contains(c)))
        .filter(|s| s.encode_utf16().count() > 2)
        .map(str::to_owned)
        .collect()
}
fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.;
    }
    let intersection = a.intersection(b).count();
    intersection as f64 / (a.len() + b.len() - intersection) as f64
}
fn category_match(lane: &str, category: &str) -> bool {
    let categories: &[&str] = match lane {
        "workspace_facts" => &["project_fact", "workspace_rule"],
        "architecture_decisions" => &["architecture_decision"],
        "technical_constraints" => &["technical_constraint"],
        "tooling_constraints" => &["tooling_constraint"],
        "user_preferences" => &["user_preference", "communication_style"],
        "behavior_cards" => &["behavior_feedback"],
        "failures_and_corrections" => &["failure", "bug", "assistant_mistake_candidate"],
        "open_questions" => &["open_question"],
        "todos" => &["todo"],
        "shared_dreams" => &["dream_synthesis"],
        "code_context" => &["code_context", "file_context"],
        "knowledge_md" => &["curation_note"],
        _ => &[],
    };
    categories.contains(&category)
}
fn clamped(row: &Json, name: &str) -> f64 {
    let value = field(row, name).filter(|v| !matches!(v, Json::Null));
    let n = if value.is_none() { 0.5 } else { number(value) };
    if n.is_finite() {
        n.clamp(0., 1.)
    } else {
        0.
    }
}
fn cosine(a: Option<&[f64]>, b: Option<&[f64]>) -> f64 {
    let (Some(a), Some(b)) = (a, b) else {
        return f64::NAN;
    };
    if a.is_empty() || a.len() != b.len() {
        return f64::NAN;
    }
    let (mut dot, mut left, mut right) = (0., 0., 0.);
    for (a, b) in a.iter().zip(b) {
        if !a.is_finite() || !b.is_finite() {
            return f64::NAN;
        }
        dot += a * b;
        left += a * a;
        right += b * b;
    }
    if left == 0. || right == 0. {
        f64::NAN
    } else {
        dot / (left * right).sqrt()
    }
}
/// Pure score computation. Call `route` to perform latest-revision and caller authorization.
/// Hard-deleted, pruned, tombstoned, demoted and invalidated records return negative infinity.
pub fn score(record: &Record, query: &str, lane: &str, query_vector: Option<&[f64]>) -> f64 {
    let row = &record.metadata;
    let status = label(row, "status");
    let epistemic = raw(row, "epistemicStatus");
    if matches!(status.as_str(), "pruned" | "tombstoned" | "demoted")
        || field(row, "hardDeleted") == Some(&Json::Bool(true))
        || label(row, "epistemicStatus") == "invalidated"
    {
        return f64::NEG_INFINITY;
    }
    let category = label(row, "category");
    let category_text = field(row, "category")
        .filter(|v| truthy(v))
        .map(string)
        .map(|s| s.to_utf8_lossy())
        .unwrap_or_default();
    let semantic = jaccard(
        &tokens(query),
        &tokens(&format!("{} {}", text(row), category_text)),
    );
    let origin = field(row, "origin").unwrap_or(&Json::Null);
    let trust_key = raw(origin, "trustLevel");
    // The pin looks these two boosts up on ordinary JS objects. Inherited object
    // properties become nonnumeric terms, making its final score NaN, hence excluded.
    if inherited_key(&trust_key) || inherited_key(&epistemic) {
        return f64::NAN;
    }
    let trust = match trust_key.as_str() {
        "curated" => 0.3,
        "validated" => 0.25,
        "user_asserted" | "tool_observed" => 0.18,
        "assistant_asserted" => -0.2,
        "untrusted" => -0.3,
        _ => 0.,
    };
    let curation = match status.as_str() {
        "promoted" => 0.25,
        "active" => 0.1,
        _ => 0.,
    };
    let penalties = if label(origin, "role") == "assistant" {
        0.2
    } else {
        0.
    } + if status == "conflict" { 0.3 } else { 0. }
        + if field(row, "stale") == Some(&Json::Bool(true)) {
            0.15
        } else {
            0.
        };
    let vector = cosine(query_vector, record.embedding.as_deref());
    semantic
        + if vector.is_finite() {
            vector * 0.75
        } else {
            0.
        }
        + if category_match(lane, &category) {
            0.25
        } else {
            0.
        }
        + trust
        + curation
        + epistemic_score_boost(&epistemic)
        + clamped(row, "salience") * 0.15
        + clamped(row, "recency") * 0.1
        - penalties
}
/// Dedupe revisions before ACL, score all lanes, and place each identified record at most once.
/// Ties use lane order, then the first occurrence's slot even if its revision was replaced.
pub fn route(
    records: &[Record],
    query: &str,
    ctx: &RequestContext,
    options: &Options<'_>,
) -> Vec<Lane> {
    let mut lanes: Vec<_> = LANES
        .iter()
        .map(|name| Lane {
            name,
            hits: Vec::new(),
        })
        .collect();
    let mut unique: Vec<usize> = Vec::new();
    let mut slots: HashMap<JsString, usize> = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        let Some(id) = record_id(&record.metadata) else {
            unique.push(index);
            continue;
        };
        if let Some(slot) = slots.get(&id) {
            if time(&record.metadata, true) >= time(&records[unique[*slot]].metadata, true) {
                unique[*slot] = index;
            }
        } else {
            slots.insert(id, unique.len());
            unique.push(index);
        }
    }
    let mut candidates = Vec::new();
    for (slot, index) in unique.into_iter().enumerate() {
        if !acl::visible(&records[index].metadata, Some(ctx)) {
            continue;
        }
        for (lane, name) in LANES.iter().enumerate() {
            let value = score(&records[index], query, name, options.query_vector);
            if value.is_finite() && value > options.min_score {
                candidates.push((lane, slot, index, value));
            }
        }
    }
    candidates.sort_by(|a, b| b.3.total_cmp(&a.3).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    let mut seen = HashSet::new();
    for (lane, _, index, score) in candidates {
        if lanes[lane].hits.len() >= options.max_per_lane {
            continue;
        }
        let id = record_id(&records[index].metadata);
        if id.as_ref().is_some_and(|id| seen.contains(id)) {
            continue;
        }
        lanes[lane].hits.push(Hit { index, score });
        if let Some(id) = id {
            seen.insert(id);
        }
    }
    lanes
}
/// Remove exact/near lexical duplicates against already selected memory texts.
/// `only_ids` restricts dedupe to a supplied global-search subset, as in Node.
pub fn dedupe(
    lanes: &mut [Lane],
    records: &[Record],
    texts: &[String],
    only_ids: Option<&[String]>,
    threshold: f64,
) -> usize {
    let sets: Vec<_> = texts
        .iter()
        .map(|t| tokens(t))
        .filter(|s| !s.is_empty())
        .collect();
    let threshold = if threshold.is_finite() {
        threshold
    } else {
        0.8
    };
    let mut dropped = 0;
    for lane in lanes {
        lane.hits.retain(|hit| {
            let Some(record) = records.get(hit.index) else {
                dropped += 1;
                return false;
            };
            let id = record_id(&record.metadata).unwrap_or_default();
            if sets.is_empty()
                || only_ids.is_some_and(|ids| !ids.iter().any(|s| JsString::from_utf8_str(s) == id))
            {
                return true;
            }
            let own = tokens(&text(&record.metadata));
            let duplicate =
                !own.is_empty() && sets.iter().any(|set| jaccard(&own, set) >= threshold);
            if duplicate {
                dropped += 1;
            }
            !duplicate
        });
    }
    dropped
}
