//! Ordered eight-dimension compatibility format used by persisted memory rows.
use super::{
    emotion_blends::detect_blend,
    emotion_json::{clamp01, coerce, entries, get, num, object, string},
    emotion_score::EmotionScore,
    tier1::Tier1Classifier,
    tier3,
};
use crate::{
    contract::EngineError,
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
/// Pinned Plutchik dimension order; order matters in both JSON and compact row strings.
pub const DIMENSIONS: [&str; 8] = [
    "joy",
    "trust",
    "anticipation",
    "sadness",
    "disgust",
    "anger",
    "fear",
    "surprise",
];

/// Project a validated score into the exact legacy field order without losing enrichment.
pub fn from_score(score: &EmotionScore) -> Json {
    let intensity = clamp01(score.intensity);
    let mut values = Vec::new();
    let labels = object(score.emotion_labels.clone());
    for dim in DIMENSIONS {
        let value = clamp01(coerce(get(&labels, dim)));
        values.push((
            dim,
            num(if score.primary_emotion == dim {
                value.max(intensity)
            } else {
                value
            }),
        ));
    }
    values.extend([
        ("emotionalIntensity", num(intensity)),
        ("emotionalDominant", string(&score.primary_emotion)),
        ("confidence", num(clamp01(score.confidence))),
        ("tierUsed", num(f64::from(score.tier_used))),
        ("nuances", Json::Array(score.nuances.clone())),
        (
            "complexEmotion",
            score.complex_emotion.clone().unwrap_or(Json::Null),
        ),
        ("blendFactors", object(score.blend_factors.clone())),
        (
            "emotionalContext",
            score.emotional_context.clone().unwrap_or(Json::Null),
        ),
    ]);
    object(values)
}
/// Synchronous lexical fallback. No preceding-owner context is read or advanced.
pub fn infer_sync(
    classifier: &Tier1Classifier,
    input: &JsString,
    now: i64,
) -> Result<Json, EngineError> {
    let Some(mut score) = classifier.classify(input, "user", now)? else {
        return Ok(from_score(&tier3::neutral("user", 1, now)?));
    };
    if let Some(blend) = detect_blend(&object(score.emotion_labels.clone()), input, &Json::Null)? {
        score.blend_factors = entries(get(get(&blend, "evidence"), "base_blend"));
        score.complex_emotion = Some(blend);
    }
    Ok(from_score(&score))
}
/// Compact row encoding uses JavaScript's exact binary64-toFixed rounding, not Rust tie-even.
#[must_use]
pub fn serialize(value: &Json) -> String {
    DIMENSIONS
        .into_iter()
        .filter_map(|dim| {
            let v = coerce(get(value, dim));
            (v > 0.).then(|| format!("{dim}:{}", crate::text::number::fixed(v, 2)))
        })
        .collect::<Vec<_>>()
        .join(",")
}
fn parse_float(value: &str) -> Option<f64> {
    let value = crate::text::js::js_trim(value);
    let bytes = value.as_bytes();
    let mut end = usize::from(bytes.first().is_some_and(|b| matches!(b, b'+' | b'-')));
    let start = end;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    let mut digits = end - start;
    if bytes.get(end) == Some(&b'.') {
        end += 1;
        let start = end;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        digits += end - start;
    }
    if digits == 0 {
        return None;
    }
    if bytes.get(end).is_some_and(|b| matches!(b, b'e' | b'E')) {
        let mantissa_end = end;
        end += 1;
        if bytes.get(end).is_some_and(|b| matches!(b, b'+' | b'-')) {
            end += 1;
        }
        let start = end;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if start == end {
            end = mantissa_end;
        }
    }
    value[..end].parse().ok()
}
/// Read the compact scalar form in dimension order; unknown labels never become columns.
#[must_use]
pub fn deserialize(value: &str) -> Json {
    let mut values = [0.; 8];
    for part in value.split(',') {
        let mut parts = part.split(':');
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        if let Some(index) = DIMENSIONS.iter().position(|dim| *dim == key) {
            if let Some(number) = parse_float(value).filter(|n| n.is_finite()) {
                values[index] = clamp01(number);
            }
        }
    }
    object(
        DIMENSIONS
            .into_iter()
            .zip(values)
            .map(|(name, value)| (name, num(value))),
    )
}
/// Node-order JSON for the compatibility projection.
#[must_use]
pub fn to_json(value: &Json) -> String {
    write_json(value)
}
