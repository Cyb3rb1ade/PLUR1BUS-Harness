//! Pure mood style text; emotion inference and persona storage stay with their owners.

use super::render_value::{concat, join, text, trim};
use super::style_constants::*;
use crate::text::js::JsString;
use serde_json::Value;

/// Format known mood and ordered optional directives, dropping whole trailing sentences.
#[must_use]
pub fn build(mood: &Value, options: &Value) -> Option<JsString> {
    let parts = mood_parts(mood);
    let extras = extras(options);
    let mut directive = join(&parts, " ");
    for extra in extras {
        let candidate = if directive.is_empty() {
            JsString::from(extra)
        } else {
            concat("", &directive, &format!(" {extra}"))
        };
        if candidate.utf16_len() > 400 {
            break;
        }
        directive = candidate;
    }
    if directive.utf16_len() > 400 {
        directive = concat("", &trim(&directive.utf16_slice(0, 399)), "…");
    }
    (!directive.is_empty()).then_some(directive)
}

fn mood_parts(mood: &Value) -> Vec<JsString> {
    let dimension = text(&mood["dominant"]);
    let intensity = mood["intensity"]
        .as_str()
        .filter(|v| ["hoch", "mittel", "niedrig"].contains(v))
        .unwrap_or("mittel");
    let mut parts = Vec::<JsString>::new();
    if let Some((_, _, tone)) = TONES
        .iter()
        .find(|(dim, level, _)| *dim == dimension && *level == intensity)
    {
        parts.push(JsString::from(*tone));
        if let Some((_, energy)) = ENERGY.iter().find(|(trend, _)| mood["trend"] == *trend) {
            parts.push(JsString::from(*energy));
        }
        parts.push(JsString::from(NO_LABEL_INSTRUCTION));
    }
    parts
}

fn extras(options: &Value) -> Vec<&'static str> {
    let mut extras = Vec::new();
    if let Some(hour) = options["hour"]
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0)
    {
        if hour < 10.0 {
            extras.push(TIME_MORNING);
        } else if hour >= 20.0 {
            extras.push(TIME_EVENING);
        }
    }
    if options["opinion"] == true {
        extras.push(
            if matches!(
                options["temperamentName"].as_str(),
                Some("warm" | "sensibel")
            ) {
                OPINION_SOFT
            } else {
                OPINION_STANDARD
            },
        );
    }
    if options["askBack"] == true {
        extras.push(ASK_BACK);
    }
    extras
}
