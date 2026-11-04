//! Node namespace merge, including CP-5.2's rerank-score ordering.
//! Node-shaped wrappers retain provenance fields that the renderer still needs.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::acl::AclMemory;
use super::candidate::RecallCandidate;
use super::dedupe::{dedup_results, has_disjoint_validity_windows};
use super::namespace_trace::{NamespaceTrace, Replay, TraceLimits};
use crate::text::js;

/// One completed table recall or the merged result. Wrappers are cloned before tagging.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NamespaceResult {
    /// Per-store embedding identity, used before combining independent vector spaces.
    pub identity_id: Option<String>,
    /// Bounded capability degradation, matching the namespace wrapper's Node shape.
    pub degraded: Option<Value>,
    /// Namespace that produced this child.
    pub namespace: Option<String>,
    /// `private`, `workspace` or `user`; inferred from shared namespace labels when absent.
    pub source_kind: Option<String>,
    /// First child's query vector, cloned independently of its store.
    pub query_vector: Option<Vec<f32>>,
    /// Canonical heading/text wrappers, preserving their additional fields.
    pub canonical: Vec<Value>,
    /// Hydrated `{entry, score, source, rerankScore}` wrappers, preserving additional fields.
    pub memories: Vec<Value>,
    /// The child trace or the merged master trace.
    pub trace: Option<NamespaceTrace>,
}

/// Global caps and deduplication controls. Character/time budgets are owned by T6.
#[derive(Clone, Debug)]
pub struct MergeOptions {
    /// Combined maximum of canonical sections and memories.
    pub max_out: usize,
    /// Canonical limit, additionally capped at `max_out`.
    pub canonical_max_items: usize,
    /// Apply the Node Jaccard/chunk-group deduper after origin and id dedupe.
    pub dedup_enabled: bool,
    /// Jaccard threshold; non-finite values use 0.78.
    pub dedup_jaccard: f64,
    /// Absent means no master trace is collected.
    pub trace_limits: Option<TraceLimits>,
}
impl Default for MergeOptions {
    fn default() -> Self {
        Self {
            max_out: 0,
            canonical_max_items: usize::MAX,
            dedup_enabled: true,
            dedup_jaccard: 0.78,
            trace_limits: None,
        }
    }
}

#[derive(Clone)]
struct Candidate {
    item: Value,
    namespace: Option<String>,
    priority: u8,
    ordinal: usize,
}

/// Merge all settled children without modifying any source wrapper or entry.
/// Finite rerank scores sort first, then raw scores; every tie retains configured order.
#[must_use]
pub fn merge(results: &[NamespaceResult], options: &MergeOptions) -> NamespaceResult {
    let mut replay = child_traces(results, options);
    let (canonicals, memories) = candidates(results);
    let canonical = select_canonical(canonicals, options, &mut replay);
    let mut unique = origins(memories, &mut replay);
    unique.sort_by(compare);
    dedup_ids(&mut unique, &mut replay);
    let slots = options.max_out.saturating_sub(canonical.len());
    let selected = select(&unique, slots, options);
    note_unselected(&unique, &selected, &mut replay);
    NamespaceResult {
        query_vector: results
            .iter()
            .find_map(|result| result.query_vector.clone()),
        canonical,
        memories: selected
            .into_iter()
            .map(|index| unique[index].item.clone())
            .collect(),
        trace: replay.map(Replay::finish),
        ..NamespaceResult::default()
    }
}

fn child_traces(results: &[NamespaceResult], options: &MergeOptions) -> Option<Replay> {
    let mut replay = options.trace_limits.map(Replay::new);
    if let Some(replay) = &mut replay {
        let sources = results
            .iter()
            .filter_map(|result| {
                result
                    .trace
                    .as_ref()
                    .map(|trace| (namespace(result.namespace.as_deref()), trace))
            })
            .collect::<Vec<_>>();
        replay.children(&sources);
    }
    replay
}

fn select_canonical(
    mut candidates: Vec<Candidate>,
    options: &MergeOptions,
    replay: &mut Option<Replay>,
) -> Vec<Value> {
    candidates.sort_by(compare);
    let mut canonical = Vec::new();
    let mut keys = HashSet::new();
    for candidate in candidates {
        let key = format!(
            "{}\0{}",
            normalized(&candidate.item["heading"]),
            normalized(&candidate.item["text"])
        );
        let (stage, reason) = if !keys.insert(key) {
            ("namespace-canonical-dedup", "duplicate canonical content")
        } else if canonical.len() >= options.canonical_max_items.min(options.max_out) {
            ("namespace-canonical-cap", "beyond global canonical cap")
        } else {
            canonical.push(candidate.item);
            continue;
        };
        let title = text(&candidate.item["heading"]);
        let title = if title.is_empty() {
            text(&candidate.item["text"])
        } else {
            title
        };
        note(
            replay,
            &candidate,
            format!("canonical:{}", preview(&title, 40)),
            stage,
            reason.to_owned(),
        );
    }
    canonical
}

fn dedup_ids(candidates: &mut Vec<Candidate>, replay: &mut Option<Replay>) {
    let mut ids = HashSet::new();
    candidates.retain(|candidate| {
        let id = text(&candidate.item["entry"]["id"]);
        if id.is_empty() || ids.insert(id.clone()) {
            return true;
        }
        note(
            replay,
            candidate,
            id,
            "namespace-id-dedup",
            "duplicate memory ID with a lower global score".to_owned(),
        );
        false
    });
}

fn note_unselected(candidates: &[Candidate], selected: &[usize], replay: &mut Option<Replay>) {
    let selected = selected.iter().copied().collect::<HashSet<_>>();
    for (index, candidate) in candidates.iter().enumerate() {
        if !selected.contains(&index) {
            note(
                replay,
                candidate,
                text(&candidate.item["entry"]["id"]),
                "namespace-result-dedup",
                "duplicate or beyond global result cap".to_owned(),
            );
        }
    }
}

fn candidates(results: &[NamespaceResult]) -> (Vec<Candidate>, Vec<Candidate>) {
    let mut canonical = Vec::new();
    let mut memories = Vec::new();
    let mut ordinal = 0;
    for result in results {
        let namespace = namespace(result.namespace.as_deref());
        let kind = match result.source_kind.as_deref() {
            Some(kind @ ("private" | "workspace" | "user")) => kind,
            _ => match namespace.as_deref() {
                Some("shared-workspace") => "workspace",
                Some("shared-user") => "user",
                _ => "private",
            },
        };
        let priority = match kind {
            "workspace" => 1,
            "user" => 2,
            _ => 0,
        };
        for (items, target, memory) in [
            (&result.canonical, &mut canonical, false),
            (&result.memories, &mut memories, true),
        ] {
            for item in items {
                if !item.is_object() || (memory && !item["entry"].is_object()) {
                    continue;
                }
                // Namespace labels belong to wrappers, never the shared input entries.
                let mut item = item.clone();
                item["namespace"] = json!(namespace);
                target.push(Candidate {
                    item,
                    namespace: namespace.clone(),
                    priority,
                    ordinal,
                });
                ordinal += 1;
            }
        }
    }
    (canonical, memories)
}

fn origins(memories: Vec<Candidate>, replay: &mut Option<Replay>) -> Vec<Candidate> {
    let mut groups: HashMap<String, Vec<Candidate>> = HashMap::new();
    let mut unique = Vec::new();
    for candidate in memories {
        let key = origin_key(&candidate.item["entry"]);
        if key.is_empty() {
            unique.push(candidate);
            continue;
        }
        let winners = groups.entry(key.clone()).or_default();
        insert_origin(winners, candidate, &key, replay);
    }
    unique.extend(groups.into_values().flatten());
    unique
}

fn select(unique: &[Candidate], slots: usize, options: &MergeOptions) -> Vec<usize> {
    if !options.dedup_enabled {
        return (0..unique.len().min(slots)).collect();
    }
    let candidates = unique
        .iter()
        .map(|candidate| candidate_of(&candidate.item))
        .collect::<Vec<_>>();
    let threshold = if options.dedup_jaccard.is_finite() {
        options.dedup_jaccard
    } else {
        0.78
    };
    let selected = dedup_results(&candidates, slots, threshold);
    let mut used = HashSet::new();
    selected
        .iter()
        .filter_map(|selected| {
            candidates
                .iter()
                .enumerate()
                .find(|(index, candidate)| !used.contains(index) && *candidate == selected)
                .map(|(index, _)| {
                    used.insert(index);
                    index
                })
        })
        .collect()
}

fn compare(left: &Candidate, right: &Candidate) -> Ordering {
    let l = finite(&left.item["rerankScore"]);
    let r = finite(&right.item["rerankScore"]);
    match (l, r) {
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (Some(l), Some(r)) => r
            .partial_cmp(&l)
            .unwrap_or(Ordering::Equal)
            .then(left.ordinal.cmp(&right.ordinal)),
        _ => finite(&right.item["score"])
            .unwrap_or(f64::NEG_INFINITY)
            .partial_cmp(&finite(&left.item["score"]).unwrap_or(f64::NEG_INFINITY))
            .unwrap_or(Ordering::Equal)
            .then(left.ordinal.cmp(&right.ordinal)),
    }
}

pub(crate) fn candidate_of(item: &Value) -> RecallCandidate {
    let e = &item["entry"];
    RecallCandidate {
        id: text(&e["id"]),
        text: text(&e["text"]),
        summary: text(&e["summary"]),
        category: text(&e["category"]),
        agent_id: text(&e["agentId"]),
        scope: text(&e["scope"]),
        chunk_group_id: text(&e["chunkGroupId"]),
        source_turn_id: text(&e["sourceTurnId"]),
        core_memory_score: finite(&e["coreMemoryScore"]).unwrap_or(0.0),
        valid_from: finite(&e["validFrom"]).unwrap_or(0.0),
        valid_until: finite(&e["validUntil"]).unwrap_or(0.0),
        score: finite(&item["score"]),
        rerank_score: finite(&item["rerankScore"]),
        source: text(&item["source"]),
        graph_source: text(&item["graphSource"]),
        ownership: AclMemory {
            id: text(&e["id"]),
            scope: text(&e["scope"]),
            agent_id: text(&e["agentId"]),
            stored_by: text(&e["storedBy"]),
            workspace_id: text(&e["workspaceId"]),
            workspace_key: text(&e["workspaceKey"]),
            owner_user_id: text(&e["ownerUserId"]),
            type_name: text(&e["type"]),
        },
    }
}
fn origin_key(entry: &Value) -> String {
    let agent = text(&entry["sourceAgentId"]);
    let id = text(&entry["sourceMemoryId"]);
    if !js::js_trim(&agent).is_empty() && !js::js_trim(&id).is_empty() {
        return format!("{}:{}", js::js_trim(&agent), js::js_trim(&id));
    }
    let agent = if text(&entry["agentId"]).is_empty() {
        text(&entry["storedBy"])
    } else {
        text(&entry["agentId"])
    };
    let id = text(&entry["id"]);
    if js::js_trim(&agent).is_empty() || js::js_trim(&id).is_empty() {
        String::new()
    } else {
        format!("{}:{}", js::js_trim(&agent), js::js_trim(&id))
    }
}
fn namespace(value: Option<&str>) -> Option<String> {
    value
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 64
                && v.as_bytes()[0].is_ascii_alphanumeric()
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
        .map(str::to_owned)
}
fn normalized(value: &Value) -> String {
    let words = text(value)
        .split(js::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    js::js_to_lower_case(&words.join(" "))
}
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}
fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").to_owned()
}
pub(crate) fn preview(value: &str, limit: usize) -> String {
    let clean = value
        .chars()
        .map(|c| {
            if (c <= '\u{1f}' && c != '\t' && c != '\n') || ('\u{7f}'..='\u{9f}').contains(&c) {
                ' '
            } else {
                c
            }
        })
        .collect::<String>();
    let clean = clean
        .split(js::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if js::utf16_len(&clean) <= limit {
        return clean;
    }
    let units = clean.encode_utf16().collect::<Vec<_>>();
    let mut cut = limit;
    while cut > 0 && units.get(cut) != Some(&32) && units.get(cut - 1) != Some(&32) {
        cut -= 1;
    }
    if cut == 0 {
        cut = limit;
    }
    format!(
        "{}…",
        js::js_trim_end(&js::utf16_slice(&clean, 0, cut).to_utf8_lossy())
    )
}
fn note(
    replay: &mut Option<Replay>,
    candidate: &Candidate,
    id: String,
    stage: &str,
    reason: String,
) {
    if let Some(replay) = replay {
        replay.decision(candidate.namespace.clone(), id, stage, reason);
    }
}

fn insert_origin(
    winners: &mut Vec<Candidate>,
    candidate: Candidate,
    key: &str,
    replay: &mut Option<Replay>,
) {
    let current = candidate_of(&candidate.item);
    let overlaps = winners
        .iter()
        .enumerate()
        .filter(|(_, old)| !has_disjoint_validity_windows(&candidate_of(&old.item), &current))
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    if overlaps.iter().all(|index| {
        candidate.priority < winners[*index].priority
            || (candidate.priority == winners[*index].priority
                && compare(&candidate, &winners[*index]) == Ordering::Less)
    }) {
        note_replaced_origins(winners, &overlaps, key, replay);
        let mut index = 0;
        winners.retain(|_| {
            let keep = !overlaps.contains(&index);
            index += 1;
            keep
        });
        winners.push(candidate);
    } else {
        note(
            replay,
            &candidate,
            text(&candidate.item["entry"]["id"]),
            "namespace-origin-dedup",
            format!("duplicate canonical origin {key}"),
        );
    }
}

fn note_replaced_origins(
    winners: &[Candidate],
    overlaps: &[usize],
    key: &str,
    replay: &mut Option<Replay>,
) {
    for index in overlaps {
        note(
            replay,
            &winners[*index],
            text(&winners[*index].item["entry"]["id"]),
            "namespace-origin-dedup",
            format!("duplicate canonical origin {key}"),
        );
    }
}
