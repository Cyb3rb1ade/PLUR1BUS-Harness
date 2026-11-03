//! Stable overlap scoring, taste gate, and REM pattern text from the pin.

use super::memory_sanitize::{attribute, evidence};
use super::render_date::parse_timestamp;
use super::render_value::{concat, fixed, join, text, truthy};
use crate::text::js::JsString;
use serde_json::{json, Value};

fn weeks_since(pattern: &Value, now: f64) -> f64 {
    let date = pattern
        .get("createdAt")
        .filter(|v| truthy(v))
        .unwrap_or(&pattern["weekOf"]);
    parse_timestamp(date).map_or(0.0, |at| ((now - at) / 604_800_000.0).max(0.0))
}

/// Normalized overlap; duplicates and stable ties intentionally match Node.
#[must_use]
pub fn score(pattern: &Value, candidates: &[String], weeks: f64) -> f64 {
    let Some(members) = pattern["memberIds"].as_array() else {
        return 0.0;
    };
    if members.is_empty() || candidates.is_empty() {
        return 0.0;
    }
    let overlap = members
        .iter()
        .filter(|m| candidates.iter().any(|c| m.as_str() == Some(c)))
        .count();
    if overlap < 2 {
        return 0.0;
    }
    let bounded_weeks = if weeks.is_finite() {
        weeks.max(0.0)
    } else {
        0.0
    };
    overlap as f64 / members.len().min(candidates.len()) as f64
        * pattern["confidence"].as_f64().unwrap_or(0.5)
        * (-bounded_weeks / 12.0).exp()
}

/// Highest-scoring pattern strictly above the threshold; equal scores retain input order.
#[must_use]
pub fn select(candidates: &[String], records: &[Value], threshold: f64, now: f64) -> Option<Value> {
    let mut scored = records
        .iter()
        .filter(|p| p["memberIds"].is_array())
        .map(|p| (p, score(p, candidates, weeks_since(p, now))))
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .find(|(_, score)| *score > threshold)
        .map(|(pattern, score)| {
            let triggers = candidates
                .iter()
                .filter(|id| {
                    pattern["memberIds"].as_array().is_some_and(|members| {
                        members.iter().any(|m| m.as_str() == Some(id.as_str()))
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            json!({"pattern":pattern,"score":score,"triggerIds":triggers})
        })
}

/// Reject opposite high-intensity emotional registers like the continuity gate.
#[must_use]
pub fn emotional_mismatch(trajectory: &str, register: &str) -> bool {
    let negative = ["grief", "conflict", "loss", "anger", "anguish"];
    let positive = ["celebration", "joy", "triumph", "delight", "elation"];
    let trajectory = trajectory.to_lowercase();
    let register = register.to_lowercase();
    (negative.iter().any(|w| trajectory.contains(w))
        && positive.iter().any(|w| register.contains(w)))
        || (positive.iter().any(|w| trajectory.contains(w))
            && negative.iter().any(|w| register.contains(w)))
}

/// Render humility-framed pattern text without affecting the stored record.
#[must_use]
pub fn format_pattern(pattern: &Value, triggers: &Value, score: f64, now: f64) -> JsString {
    let name = evidence(&JsString::from(text(&pattern["patternName"])), 200);
    let description = evidence(&JsString::from(text(&pattern["description"])), 400);
    let mut body = Vec::new();
    if !name.is_empty() {
        body.push(concat(
            "This may connect to a pattern I've noticed: \"",
            &name,
            "\".\n",
        ));
    }
    if !description.is_empty() {
        body.push(concat("", &description, "\n"));
    }
    body.push(JsString::from(concat!(
        "My memory of when this started is partial — it appeared across ",
        "several conversations. I'm surfacing it because today's ",
        "recalled memories overlap with it.",
    )));
    let triggers = triggers
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| attribute(&json!(text(v)), "id"))
        .collect::<Vec<_>>()
        .join(",");
    let prefix = format!(
        concat!(
            "<memory-continuity source=\"rem-pattern\" confidence=\"{}\" ",
            "weeks-ago=\"{:.0}\" trigger-memory-ids=\"{triggers}\">\n",
        ),
        fixed(score, 2),
        (weeks_since(pattern, now) + 0.5).floor(),
        triggers = triggers
    );
    concat(&prefix, &join(&body, ""), "\n</memory-continuity>")
}
