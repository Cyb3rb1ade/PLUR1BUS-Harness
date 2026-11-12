//! Render only trace data already present; full trace construction remains T6.

use super::memory_context::PromptItem;
use super::memory_sanitize::attribute;
use super::render_value::{fixed, text, truthy};
use serde_json::{json, Value};

/// Stage-local observations use the existing trace's caps; T6 owns final normalization.
pub(super) fn append(trace: &mut Value, field: &str, event: Value) {
    let (key, default) = match field {
        "candidates" => ("maxCandidates", 50),
        "decisions" => ("maxDecisions", 200),
        "guards" => ("maxGuards", 200),
        _ => return,
    };
    let cap = trace["config"][key]
        .as_u64()
        .map_or(default, |n| n as usize);
    if let Some(events) = trace.get_mut(field).and_then(Value::as_array_mut) {
        events.push(event);
        // Array.slice(-0) keeps everything in the pin.
        if cap > 0 && events.len() > cap {
            events.drain(..events.len() - cap);
        }
    }
}

pub(super) fn summary(trace: &Value) -> String {
    // A forgotten card is not even counted in the prompt (RE-D153 review N4); the internal
    // trace keeps its id with the fixed `tombstoned` reason.
    let decisions = trace["decisions"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(|decision| decision["stage"] != "tombstone")
        .collect::<Vec<_>>();
    let guards = trace["guards"].as_array().map_or(&[][..], Vec::as_slice);
    let candidates = trace["candidates"].as_array().map_or(0, Vec::len);
    let mut values = vec![("totalCandidates", candidates)];
    for (label, action) in [
        ("included", "inclusion"),
        ("rejected", "rejection"),
        ("downranked", "downrank"),
        ("superseded", "superseded"),
        ("deduped", "deduped"),
        ("merged", "merged"),
    ] {
        values.push((
            label,
            decisions.iter().filter(|d| d["action"] == action).count(),
        ));
    }
    values.push((
        "guardPass",
        guards.iter().filter(|g| g["passed"] == true).count(),
    ));
    values.push((
        "guardFail",
        guards.iter().filter(|g| g["passed"] == false).count(),
    ));
    let attributes = values
        .iter()
        .map(|(name, value)| format!("{name}=\"{value}\""))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        concat!(
            "<memory-decision-trace>\n  <trace-summary {attributes} ",
            "/>\n</memory-decision-trace>\n",
        ),
        attributes = attributes
    )
}

fn resolve(item: &PromptItem, trace: &Value) -> Option<Value> {
    if let Some(attached) = &item.trace {
        if ["stage", "sourceStage", "evidence", "reason"]
            .iter()
            .any(|key| truthy(&attached[key]))
            || attached["score"].as_f64().is_some_and(f64::is_finite)
        {
            return Some(json!({"stage":attached.get("stage").filter(|v|truthy(v))
                .or_else(||attached.get("sourceStage")), "score":attached["score"],
                "evidence":attached["evidence"],"reason":attached["reason"]}));
        }
    }
    let id = &item.fields["id"];
    let candidate = trace["candidates"]
        .as_array()
        .and_then(|rows| rows.iter().rfind(|r| &r["id"] == id));
    let decision = trace["decisions"]
        .as_array()
        .and_then(|rows| rows.iter().rfind(|r| &r["memoryId"] == id));
    if candidate.is_none() && decision.is_none() {
        return None;
    }
    let candidate = candidate.unwrap_or(&Value::Null);
    let decision = decision.unwrap_or(&Value::Null);
    Some(
        json!({"stage":decision.get("stage").filter(|v|truthy(v)).unwrap_or(&candidate["source"]),
        "score":candidate["score"],"evidence":candidate.get("evidence").filter(|v|truthy(v))
            .cloned().unwrap_or_else(|| {
                if candidate["source"] == "graph" {json!("weak-association")} else {Value::Null}
            }),
        "reason":decision["reason"]}),
    )
}

pub(super) fn attributes(item: &PromptItem, trace: &Value) -> String {
    let Some(meta) = resolve(item, trace) else {
        return String::new();
    };
    let mut out = String::new();
    if truthy(&meta["stage"]) {
        out += &format!(" source-stage=\"{}\"", attribute(&meta["stage"], "unknown"));
    }
    if let Some(score) = meta["score"].as_f64().filter(|n| n.is_finite()) {
        out += &format!(" score=\"{}\"", fixed(score, 3));
    }
    for (key, label) in [("evidence", "evidence"), ("reason", "trace-reason")] {
        if truthy(&meta[key]) {
            out += &format!(" {label}=\"{}\"", attribute(&meta[key], "unknown"));
        }
    }
    out
}

pub(super) fn graph_decision(trace: &mut Value, item: &PromptItem, reason: &str, allowed: bool) {
    let action = if allowed { "inclusion" } else { "rejection" };
    if let Some(decisions) = trace.get_mut("decisions").and_then(Value::as_array_mut) {
        decisions.push(json!({"memoryId":item.fields["id"],"action":action,
            "stage":"continuity-gate","reason":reason}));
    }
    if !allowed {
        if let Some(guards) = trace.get_mut("guards").and_then(Value::as_array_mut) {
            guards.push(json!({"passed":false,"memoryId":text(&item.fields["id"])}));
        }
    }
}
