//! Ordered Node blend rules, semantic triggers and preceding-emotion transitions.

use crate::contract::EngineError;
use crate::text::js::{js_to_lower_case, JsString};
use crate::text::json::TolerantJsonValue as Json;

use super::emotion_json::{array, coerce, data, get, num, object, string, text};

/// Select the first strongest qualifying blend, retaining Node's strict tie behavior.
pub fn detect_blend(
    labels: &Json,
    input: &JsString,
    context: &Json,
) -> Result<Option<Json>, EngineError> {
    if super::emotion_json::entries(labels).is_empty() {
        return Ok(None);
    }
    let lower = js_to_lower_case(&input.to_utf8_lossy());
    let mut best = None;
    let mut best_confidence = 0.0;
    for rule in array(get(data()?, "blendRules")) {
        let required: Vec<_> = array(get(rule, "requiredEmotions"))
            .iter()
            .filter_map(text)
            .collect();
        let minimum = coerce(get(rule, "minIntensity"));
        let present: Vec<_> = required
            .iter()
            .filter(|label| coerce(get(labels, label)) >= minimum)
            .collect();
        let previous = text(get(context, "previous_top_emotion"));
        let transition = text(get(rule, "transitionFrom"));
        if let Some(transition) = &transition {
            if present.is_empty() || previous.as_ref() != Some(transition) {
                continue;
            }
        } else if present.len() < required.len().min(2) {
            continue;
        }
        let mut confidence = 0.0;
        for label in &present {
            confidence += coerce(get(labels, label));
        }
        confidence /= present.len() as f64;
        let trigger = array(get(rule, "semanticTriggers"))
            .iter()
            .filter_map(text)
            .find(|trigger| lower.contains(trigger));
        if trigger.is_some() {
            confidence += coerce(get(rule, "confidenceBoost"));
        }
        if transition.is_some() {
            confidence += 0.15;
        }
        confidence = confidence.min(1.0);
        if confidence < if trigger.is_some() { 0.45 } else { 0.5 } {
            continue;
        }
        if confidence > best_confidence {
            best_confidence = confidence;
            let mut factors: Vec<_> = required
                .iter()
                .map(|label| (label.clone(), num(coerce(get(labels, label)))))
                .collect();
            if let Some(previous) = transition {
                let value = coerce(get(labels, &previous));
                let value = if value == 0.0 || value.is_nan() {
                    0.3
                } else {
                    value
                };
                if let Some((_, old)) = factors.iter_mut().find(|(label, _)| label == &previous) {
                    *old = num(value);
                } else {
                    factors.push((previous, num(value)));
                }
            }
            let label = text(get(rule, "label")).unwrap_or_default();
            let polarity = match label.as_str() {
                "schadenfreude" | "contempt" | "resentment" | "disappointment" => "negative",
                "love" | "fiero" | "relief" | "gratitude" | "pride" => "positive",
                _ => "mixed",
            };
            best = Some(object([
                ("label", string(&label)),
                (
                    "confidence",
                    num((confidence * 1000.0 + 0.5).floor() / 1000.0),
                ),
                (
                    "evidence",
                    object([
                        ("base_blend", object(factors)),
                        (
                            "semantic_trigger",
                            string(trigger.as_deref().unwrap_or("co_occurrence")),
                        ),
                        ("polarity_toward_target", string(polarity)),
                    ]),
                ),
            ]));
        }
    }
    Ok(best)
}

/// Equal or absent preceding labels do not create a transition.
#[must_use]
pub fn detect_transition(primary: &str, context: &Json) -> Option<String> {
    text(get(context, "previous_top_emotion"))
        .filter(|previous| !previous.is_empty() && previous != primary)
        .map(|previous| format!("{previous}_to_{primary}"))
}
