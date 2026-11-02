//! Normalization and thematic evidence shared by the bounded CRR selector.

use super::render_value::{text, truthy};
use crate::text::legacy::text_utils::tokenize;
use serde_json::{json, Value};
use std::collections::HashSet;

pub(super) fn normalize(raw: &Value) -> Option<Value> {
    let entry = raw.get("entry").filter(|v| !v.is_null()).unwrap_or(raw);
    if !entry.is_object() {
        return None;
    }
    let status = entry
        .get("status")
        .filter(|v| !v.is_null())
        .unwrap_or(&entry["plur1bus_status"]);
    if matches!(
        status.as_str(),
        Some("superseded" | "archived" | "deleted" | "tombstoned")
    ) {
        return None;
    }
    let epistemic =
        super::score::normalize_epistemic_status(entry["epistemicStatus"].as_str().unwrap_or(""));
    if epistemic == "invalidated" {
        return None;
    }
    project(raw, entry, status, epistemic)
}

fn project(raw: &Value, entry: &Value, status: &Value, epistemic: &str) -> Option<Value> {
    let first = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| entry.get(key).filter(|v| truthy(v)))
            .cloned()
            .unwrap_or(json!(""))
    };
    let nullable = |key: &str, default: Value| {
        entry
            .get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(default)
    };
    let id = [
        entry.get("id"),
        entry.get("memory_id"),
        entry.get("memoryId"),
        raw.get("id"),
    ]
    .into_iter()
    .flatten()
    .find(|v| !v.is_null())
    .cloned()
    .unwrap_or(Value::Null);
    Some(
        json!({"id":id,"category":nullable("category",json!("memory")),
        "display":first(&["display","summary","text"]),"text":first(&["text","summary"]),
        "summary":first(&["summary"]),"memoryStrength":entry["memoryStrength"].as_f64()
            .map(|_|entry["memoryStrength"].clone())
            .unwrap_or_else(||nullable("strength",json!(1.0))),
        "faded":entry["faded"] == true,
        "status":if truthy(status) {status.clone()} else {json!("active")},
        "epistemicStatus":epistemic,"expiresAt":nullable("expiresAt",json!(0)),
        "scope":nullable("scope",json!("")),"agentId":nullable("agentId",json!("")),
        "storedBy":nullable("storedBy",json!("")),"workspaceId":nullable("workspaceId",json!("")),
        "workspaceKey":nullable("workspaceKey",json!("")),
        "ownerUserId":nullable("ownerUserId",json!("")),
        "createdAt":nullable("createdAt",json!(0)),"updatedAt":nullable("updatedAt",Value::Null)}),
    )
}

fn tokens(value: &str) -> HashSet<String> {
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
    tokenize(value)
        .into_iter()
        .filter(|token| !generic.contains(&token.as_str()))
        .collect()
}

pub(super) fn overlaps(prompt: &str, memory: &Value) -> bool {
    let display = ["display", "text", "summary"]
        .iter()
        .map(|key| text(&memory[key]))
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    tokens(prompt)
        .intersection(&tokens(&display))
        .take(2)
        .count()
        >= 2
}

pub(super) fn candidate(memory: &Value, source: &str, community: Option<&Value>) -> Value {
    let mut result = memory.clone();
    result["source"] = json!(source);
    result["faded"] = json!(
        memory["faded"] == true || memory["memoryStrength"].as_f64().is_some_and(|n| n < 0.25)
    );
    if let Some(community) = community {
        result["communityId"] = community.clone();
    }
    result
}
