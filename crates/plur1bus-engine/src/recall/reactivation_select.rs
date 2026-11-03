//! Ordered CRR community, bound-bridge, open-project and faded selection.

use super::reactivation::continuation;
use super::reactivation::SelectionRequest;
use super::reactivation_acl;
use super::reactivation_memory::{candidate, normalize, overlaps};
use super::render_value::{number, text, truthy};
use serde_json::{json, Value};

struct Selection<'a> {
    request: &'a SelectionRequest,
    memories: Vec<Value>,
    known: Vec<(String, Value)>,
    hydrations: usize,
    maximum: f64,
    max_faded: f64,
    trace: Option<&'a mut Value>,
}

impl Selection<'_> {
    fn observe(&mut self, candidate: &Value, rejection: Option<&str>) {
        let Some(trace) = self.trace.as_deref_mut() else {
            return;
        };
        super::memory_trace::append(
            trace,
            "candidates",
            json!({"id":candidate["id"],
            "source":"reactivation","category":candidate["category"],
            "score":candidate["memoryStrength"]}),
        );
        let (action, reason) = rejection.map_or_else(
            || {
                (
                    "inclusion",
                    format!("selected via {}", text(&candidate["source"])),
                )
            },
            |reason| ("rejection", reason.to_owned()),
        );
        super::memory_trace::append(
            trace,
            "decisions",
            json!({"memoryId":candidate["id"],
            "action":action,"stage":"reactivation","reason":reason}),
        );
    }

    fn add(&mut self, memory: &Value, source: &str, community: Option<&Value>) -> bool {
        let id = text(&memory["id"]);
        if !truthy(&memory["id"]) {
            return false;
        }
        let candidate = candidate(memory, source, community);
        let rejection = if self.request.base_ids.contains(&id) {
            Some("already in base recall")
        } else if self.memories.iter().any(|m| text(&m["id"]) == id) {
            Some("duplicate candidate")
        } else if crate::text::js::js_trim(&text(&memory["display"])).is_empty() {
            Some("no display text")
        } else if candidate["faded"] == true
            && self.memories.iter().filter(|m| m["faded"] == true).count() as f64 >= self.max_faded
        {
            Some("faded limit reached")
        } else if self.memories.len() as f64 >= self.maximum {
            Some("max reactivation memories reached")
        } else {
            None
        };
        self.observe(&candidate, rejection);
        if rejection.is_some() {
            return false;
        }
        self.memories.push(candidate);
        true
    }

    fn resolve(&mut self, id: &str, expected: Option<&Value>, community: bool) -> Option<Value> {
        let mut from_known = false;
        let raw = if let Some((_, memory)) = self.known.iter().find(|(key, _)| key == id) {
            from_known = true;
            memory.clone()
        } else {
            if community {
                if self.hydrations >= 6 {
                    return None;
                }
                self.hydrations += 1;
            }
            self.request.hydrated.get(id)?.clone()
        };
        let memory = normalize(&raw)?;
        if text(&memory["id"]) != id
            || !reactivation_acl::authorized(
                &memory,
                self.request.subject.as_ref(),
                expected,
                self.request.now_ms,
            )
        {
            return None;
        }
        if !from_known {
            self.known.push((id.into(), memory.clone()));
        }
        Some(memory)
    }
}

fn limit(config: &Value, key: &str, maximum: f64) -> f64 {
    let value = config
        .get(key)
        .filter(|v| !v.is_null())
        .map_or(maximum, number);
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(0.0).min(maximum)
    }
}

fn select_communities(selection: &mut Selection<'_>) {
    let mut used = 0.0;
    let maximum = limit(&selection.request.config, "maxCommunities", 2.0);
    for community in &selection.request.index.communities {
        if used >= maximum || !truthy(&community["id"]) {
            continue;
        }
        let ids = ["representativeMemoryIds", "bridgeMemoryIds"]
            .iter()
            .flat_map(|key| community[key].as_array().into_iter().flatten())
            .map(text)
            .collect::<Vec<_>>();
        let mut matched = false;
        for id in ids {
            if selection.memories.len() as f64 >= selection.maximum {
                break;
            }
            let Some(memory) = selection.resolve(&id, None, true) else {
                continue;
            };
            if overlaps(&selection.request.prompt, &memory) {
                matched |=
                    selection.add(&memory, "semantic-lens-community", Some(&community["id"]));
            } else {
                selection.observe(
                    &candidate(&memory, "semantic-lens-community", Some(&community["id"])),
                    Some("insufficient token overlap"),
                );
            }
        }
        if matched {
            used += 1.0;
        }
    }
}

fn select_bridges(selection: &mut Selection<'_>) {
    let edges = reactivation_acl::safe_edges(
        &selection.request.graph_edges,
        selection.request.subject.as_ref(),
    );
    for edge in edges {
        if selection.memories.len() as f64 >= selection.maximum {
            break;
        }
        let (source, target) = (text(&edge["source"]), text(&edge["target"]));
        let (id, expected) = if selection.request.base_ids.contains(&source) {
            (target, &edge["targetOwnership"])
        } else if selection.request.base_ids.contains(&target) {
            (source, &edge["sourceOwnership"])
        } else {
            continue;
        };
        if selection.request.base_ids.contains(&id)
            || selection.memories.iter().any(|m| text(&m["id"]) == id)
        {
            let reason = if selection.request.base_ids.contains(&id) {
                "already in base recall"
            } else {
                "duplicate candidate"
            };
            selection.observe(&json!({"id":id,"category":"memory"}), Some(reason));
            continue;
        }
        if let Some(memory) =
            selection.resolve(&id, (!expected.is_null()).then_some(expected), false)
        {
            selection.add(&memory, "graph-bridge", None);
        }
    }
}

pub(super) fn select_observed<'a>(
    request: &'a SelectionRequest,
    trace: Option<&'a mut Value>,
) -> Vec<Value> {
    let maximum = limit(&request.config, "maxReactivationMemories", 3.0);
    if maximum == 0.0 || maximum.is_nan() {
        return Vec::new();
    }
    let known = known_memories(request);
    let mut selection = Selection {
        request,
        memories: Vec::new(),
        known,
        hydrations: 0,
        maximum,
        max_faded: limit(&request.config, "maxFadedReactivationMemories", 1.0),
        trace,
    };
    select_communities(&mut selection);
    select_bridges(&mut selection);
    select_known(&mut selection);
    selection.memories
}

fn select_known(selection: &mut Selection<'_>) {
    if continuation(&selection.request.prompt)
        && (selection.memories.len() as f64) < selection.maximum
    {
        let mut threads = 0.0;
        for (_, memory) in selection.known.clone() {
            if !matches!(
                text(&memory["category"]).to_lowercase().as_str(),
                "project" | "plan" | "goal" | "task" | "decision"
            ) {
                continue;
            }
            if !overlaps(&selection.request.prompt, &memory) {
                selection.observe(
                    &candidate(&memory, "open-project", None),
                    Some("insufficient token overlap"),
                );
                continue;
            }
            if selection.add(&memory, "open-project", None) {
                threads += 1.0;
                if threads >= limit(&selection.request.config, "maxOpenThreads", 3.0) {
                    break;
                }
            }
        }
    }
    select_faded(selection);
}

fn select_faded(selection: &mut Selection<'_>) {
    if selection.memories.len() as f64 >= selection.maximum {
        return;
    }
    for (_, memory) in selection.known.clone() {
        if memory["faded"] == true && !overlaps(&selection.request.prompt, &memory) {
            selection.observe(
                &candidate(&memory, "faded-memory", None),
                Some("insufficient token overlap"),
            );
            continue;
        }
        if memory["faded"] == true
            && overlaps(&selection.request.prompt, &memory)
            && selection.add(&memory, "faded-memory", None)
        {
            break;
        }
    }
}

fn known_memories(request: &SelectionRequest) -> Vec<(String, Value)> {
    let mut known = Vec::<(String, Value)>::new();
    for (key, raw) in request.index.memories.iter().map(|m| (None, m)).chain(
        request
            .index
            .entries
            .iter()
            .map(|(key, value)| (Some(key), value)),
    ) {
        let Some(memory) = normalize(raw) else {
            continue;
        };
        let id = text(&memory["id"]);
        if key.is_some_and(|key| key != &id)
            || !reactivation_acl::authorized(
                &memory,
                request.subject.as_ref(),
                None,
                request.now_ms,
            )
        {
            continue;
        }
        if let Some((_, prior)) = known.iter_mut().find(|(key, _)| key == &id) {
            if key.is_none() {
                *prior = memory;
            }
        } else {
            known.push((id, memory));
        }
    }
    known
}
