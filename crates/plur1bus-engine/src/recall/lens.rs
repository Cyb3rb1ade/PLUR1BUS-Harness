//! Semantic Lens selection with the controller-approved canonical hydration ACL.

use super::acl::AclSubject;
use super::render::{RenderError, RenderHit};
use super::render_value::{number, text, truthy};
use crate::text::legacy::text_utils::tokenize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

/// Raw caller-owned source snapshot. No preselected Lens list bypasses authorization.
#[derive(Clone, Debug, Default)]
pub struct LensInputs {
    /// Original version-1 index, including its memory-to-community mapping.
    pub index: Value,
    /// Raw rows available through this authorized source lease.
    pub hydrated: BTreeMap<String, Value>,
}

/// Only read access is supplied; the selector has no logger, counter or ledger port.
pub trait LensHydrator {
    /// Hydrate one raw row by its existing identifier.
    fn get(&self, id: &str) -> Result<Option<Value>, RenderError>;
}

impl LensHydrator for LensInputs {
    fn get(&self, id: &str) -> Result<Option<Value>, RenderError> {
        Ok(self.hydrated.get(id).cloned())
    }
}

/// Base selection, raw index/configuration and the canonical request.
pub struct LensRequest {
    /// Existing authorized ordinary results; never replaced by Lens selection.
    pub base: Vec<RenderHit>,
    /// Raw index snapshot.
    pub index: Value,
    /// Resolved semanticLens configuration (empty means enabled).
    pub config: Value,
    /// Existing T1 canonical ACL context.
    pub subject: AclSubject,
}

fn positive(config: &Value, name: &str, fallback: usize) -> usize {
    let n = config.get(name).map_or(f64::NAN, number);
    if n.is_finite() && n > 0.0 {
        n.floor() as usize
    } else {
        fallback
    }
}

fn id_of(entry: &Value) -> String {
    ["memory_id", "memoryId", "id"]
        .iter()
        .find_map(|key| entry.get(key).filter(|v| !v.is_null()))
        .map_or_else(String::new, |v| {
            crate::text::js::js_trim(&text(v)).to_owned()
        })
}

fn significant(entry: &Value) -> HashSet<String> {
    let value = ["text", "summary", "display"]
        .iter()
        .filter_map(|key| entry.get(key).filter(|v| truthy(v)))
        .map(text)
        .collect::<Vec<_>>()
        .join(" ");
    let generic = [
        "api",
        "project",
        "memory",
        "recall",
        "test",
        "user",
        "bot",
        "agent",
        concat!("open", "claw"),
        "plur1bus",
    ];
    tokenize(&value)
        .into_iter()
        .filter(|token| !generic.contains(&token.as_str()))
        .collect()
}

fn communities(request: &LensRequest) -> Vec<String> {
    let mut result = Vec::new();
    let maximum = positive(&request.config, "maxCommunities", 2);
    for base in &request.base {
        let id = id_of(&base.entry);
        let community = text(&request.index["memoryToCommunity"][&id]);
        if community.is_empty()
            || result.contains(&community)
            || request.index["communities"][&community].is_null()
        {
            continue;
        }
        result.push(community);
        if result.len() >= maximum {
            break;
        }
    }
    result
}

fn eligible(entry: &Value) -> bool {
    let status = entry
        .get("status")
        .filter(|v| !v.is_null())
        .unwrap_or(&entry["plur1bus_status"]);
    !matches!(
        status.as_str(),
        Some("superseded" | "archived" | "deleted" | "tombstoned")
    ) && super::score::normalize_epistemic_status(entry["epistemicStatus"].as_str().unwrap_or(""))
        != "invalidated"
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Bridge,
    Representative,
    Faded,
}

struct Selection<'a> {
    request: &'a LensRequest,
    source: &'a dyn LensHydrator,
    picked: HashSet<String>,
    base_tokens: HashSet<String>,
    bridge_count: usize,
    faded_count: usize,
    memories: Vec<RenderHit>,
}

impl Selection<'_> {
    fn role_full(&self, role: Role) -> bool {
        match role {
            Role::Bridge => {
                self.bridge_count >= positive(&self.request.config, "maxBridgeMemories", 2)
            }
            Role::Faded => {
                self.faded_count >= positive(&self.request.config, "maxFadedMemories", 1)
            }
            Role::Representative => false,
        }
    }

    fn try_pick(&mut self, id: &str, role: Role) -> Result<(), RenderError> {
        if id.is_empty()
            || self.picked.contains(id)
            || self.role_full(role)
            || self.memories.len() >= positive(&self.request.config, "maxLensMemories", 3)
        {
            return Ok(());
        }
        let Some(entry) = self.source.get(id)? else {
            return Ok(());
        };
        // RE-04-T5-LENS-ACL: the controller-authorized CRR hydration check,
        // before quotas/projection. Denial has no log, ledger or counter port.
        if !super::render_access::allowed(&entry, &self.request.subject) {
            return Ok(());
        }
        if !eligible(&entry)
            || significant(&entry)
                .intersection(&self.base_tokens)
                .take(2)
                .count()
                < 2
        {
            return Ok(());
        }
        self.push(entry, id, role);
        Ok(())
    }

    fn push(&mut self, mut entry: Value, id: &str, role: Role) {
        self.picked.insert(id.to_owned());
        match role {
            Role::Bridge => self.bridge_count += 1,
            Role::Faded => self.faded_count += 1,
            Role::Representative => {}
        }
        let actual_id = id_of(&entry);
        entry["id"] = json!(if actual_id.is_empty() { id } else { &actual_id });
        self.memories.push(RenderHit {
            entry,
            score: 0.0,
            source: "semantic_lens".into(),
            depth: None,
        });
    }
}

/// Select in bridge/representative/faded order. Rejection is silent and consumes no cap.
pub fn select(
    request: &LensRequest,
    source: &dyn LensHydrator,
) -> Result<Vec<RenderHit>, RenderError> {
    if request.config["enabled"] == false
        || request.index["version"].as_f64() != Some(1.0)
        || !request.index["memoryToCommunity"].is_object()
        || !request.index["communities"].is_object()
    {
        return Ok(Vec::new());
    }
    let mut selection = Selection {
        request,
        source,
        picked: request
            .base
            .iter()
            .map(|m| id_of(&m.entry))
            .filter(|id| !id.is_empty())
            .collect(),
        base_tokens: request
            .base
            .iter()
            .flat_map(|m| significant(&m.entry))
            .collect(),
        bridge_count: 0,
        faded_count: 0,
        memories: Vec::new(),
    };
    for community_id in communities(request) {
        let community = &request.index["communities"][&community_id];
        for (key, role) in [
            ("bridgeMemoryIds", Role::Bridge),
            ("representativeMemoryIds", Role::Representative),
            ("fadedCandidateMemoryIds", Role::Faded),
        ] {
            for id in community[key].as_array().into_iter().flatten().map(text) {
                selection.try_pick(&id, role)?;
            }
        }
        if selection.memories.len() >= positive(&request.config, "maxLensMemories", 3) {
            break;
        }
    }
    Ok(selection.memories)
}
