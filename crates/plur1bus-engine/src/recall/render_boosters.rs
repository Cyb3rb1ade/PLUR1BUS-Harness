//! Post-selection taste gate and additive booster orchestration.

use super::blocks::RenderEffects;
use super::memory_context::PromptItem;
use super::render::{RenderError, RenderRequest};
use super::render_value::{number, text, truthy};
use crate::capture::continuity::{ContinuityGate, SessionState, SurfaceOptions};
use crate::text::js::JsString;
use serde_json::{json, Value};

pub(super) fn continuity(
    items: Vec<PromptItem>,
    request: &RenderRequest,
    trace: &mut Value,
) -> Vec<PromptItem> {
    let config = &request.config["continuityEngine"];
    if config["enabled"] == false || config["tasteGate"]["enabled"] == false {
        return items;
    }
    let maximum = config["tasteGate"]["maxAssociationsPerSession"]
        .as_f64()
        .unwrap_or(1.0);
    let threshold = config["associativeRecall"]["assocThreshold"]
        .as_f64()
        .unwrap_or(0.75);
    let gate = ContinuityGate {
        assoc_threshold: threshold,
        max_associations: maximum,
        ..ContinuityGate::default()
    };
    let mut state = SessionState::default();
    items
        .into_iter()
        .filter(|item| {
            if item.fields["graphSource"] != "graph" {
                return true;
            }
            let score = ["relevanceScore", "associatedScore", "associationStrength"]
                .iter()
                .find_map(|key| item.fields.get(*key).filter(|value| !value.is_null()))
                .map_or(0.0, number);
            let options = SurfaceOptions {
                depth: item.fields.get("depth").map(number),
                id: item.fields["id"].as_str().map(JsString::from),
                ..SurfaceOptions::default()
            };
            let decision = gate.filter_decision("associative", score, &state, &options);
            let reason = decision.reason;
            let allowed = decision.allow;
            if request.trace_enabled {
                super::memory_trace::graph_decision(trace, item, reason, allowed);
            }
            if allowed {
                state.record("associative", options.id.as_ref());
            }
            allowed
        })
        .collect()
}

pub(super) fn pattern(request: &RenderRequest) -> Option<Value> {
    let config = &request.config["continuityEngine"];
    if config["enabled"] == false || config["patternSurfacing"]["enabled"] == false {
        return None;
    }
    let candidates = request
        .selected
        .memories
        .iter()
        .map(|hit| text(&hit.entry["id"]))
        .collect::<Vec<_>>();
    let pattern = super::patterns::select(
        &candidates,
        &request.patterns,
        config["patternSurfacing"]["patternThreshold"]
            .as_f64()
            .unwrap_or(0.7),
        request.now_ms,
    )?;
    if config["tasteGate"]["enabled"] != false {
        let maximum = config["patternSurfacing"]
            .get("maxPerSession")
            .filter(|v| !v.is_null())
            .or_else(|| {
                config["tasteGate"]
                    .get("maxPatternsPerSession")
                    .filter(|v| !v.is_null())
            })
            .map_or(1.0, number);
        let gate = ContinuityGate {
            pattern_threshold: 0.0,
            max_patterns: maximum,
            ..ContinuityGate::default()
        };
        let options = SurfaceOptions {
            emotional_trajectory: Some(JsString::from(text(
                &pattern["pattern"]["emotionalTrajectory"],
            ))),
            current_register: Some(JsString::from(text(&request.mood["dominant"]))),
            ..SurfaceOptions::default()
        };
        if !gate
            .filter_decision(
                "pattern",
                pattern["score"].as_f64().unwrap_or(1.0),
                &SessionState::default(),
                &options,
            )
            .allow
        {
            return None;
        }
    }
    Some(pattern)
}

fn contradiction_pairs(items: &mut [PromptItem], request: &RenderRequest) -> Vec<(Value, Value)> {
    let mut pairs = Vec::new();
    for (a, b) in &request.contradictions {
        let Some(left) = items.iter().position(|m| m.fields["id"] == a.as_str()) else {
            continue;
        };
        let Some(right) = items.iter().position(|m| m.fields["id"] == b.as_str()) else {
            continue;
        };
        let winner = if super::boosters::compare_versions(&items[left].fields, &items[right].fields)
            == std::cmp::Ordering::Less
        {
            right
        } else {
            left
        };
        let loser = if winner == left { right } else { left };
        pairs.push((items[winner].fields.clone(), items[loser].fields.clone()));
        if !truthy(&items[loser].fields["supersededBy"]) {
            items[loser].fields["supersededBy"] = items[winner].fields["id"].clone();
            items[loser].fields["status"] = json!("superseded-in-context");
        }
    }
    pairs
}

pub(super) fn boost(
    items: &mut [PromptItem],
    request: &RenderRequest,
    trace: &mut Value,
    effects: &mut RenderEffects,
) -> Result<(JsString, JsString), RenderError> {
    let pairs = contradiction_pairs(items, request);
    let disclosure = super::boosters::contradiction_disclosure(
        &pairs,
        request.config["contradictionDisclosure"]["enabled"] != false,
    )
    .unwrap_or_default();
    let config = &request.config["conversationReactivationRecall"];
    if config["enabled"] == false {
        return Ok((disclosure, JsString::default()));
    }
    let base_ids = items
        .iter()
        .map(|m| text(&m.fields["id"]))
        .collect::<Vec<_>>();
    let top = items
        .first()
        .and_then(|m| m.fields["relevanceScore"].as_f64())
        .or_else(|| request.selected.memories.first().map(|m| m.score))
        .unwrap_or(0.0);
    let selection = super::reactivation::SelectionRequest {
        prompt: request.prompt.clone(),
        base_ids,
        index: request.reactivation.index.clone(),
        graph_edges: request.reactivation.graph_edges.clone(),
        hydrated: request.reactivation.hydrated.clone(),
        config: config.clone(),
        subject: Some(request.context.clone()),
        now_ms: request.now_ms,
    };
    let result = super::reactivation::run(
        &selection,
        &request.reactivation.session,
        top,
        request.reactivation.compacted_at,
        request.trace_enabled.then_some(trace),
    )?;
    effects.reactivation_session = Some(result.session);
    Ok((disclosure, result.context))
}
