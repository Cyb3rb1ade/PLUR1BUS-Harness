//! C4 mood-first episode tone and the legacy per-turn fallback.
use super::{
    derived_fields::{object, text},
    merged_order::{field, string, truthy},
};
use crate::{
    capture::dynamics::{json_number, number},
    text::{
        js::{js_trim, JsString},
        json::TolerantJsonValue as Json,
    },
};
pub(super) const DIMS: [&str; 7] = [
    "joy",
    "trust",
    "anticipation",
    "sadness",
    "anger",
    "fear",
    "surprise",
];
pub(super) struct Emotion {
    pub tone: Json,
    pub dominant: &'static str,
    pub intensity: f64,
}
pub(super) fn calculate(turns: &[Json], mood: Option<&Json>) -> Emotion {
    let mut values = [0.; 7];
    if let Some(mood) = mood.filter(|m| matches!(m, Json::Object(_))) {
        if let Some(details) =
            field(mood, "details").filter(|d| matches!(d, Json::Object(_) | Json::Array(_)))
        {
            for (i, dim) in DIMS.iter().enumerate() {
                let value = number(field(details, dim));
                values[i] = if value.is_finite() {
                    value.clamp(0., 1.)
                } else {
                    0.
                };
            }
            let strong = ["hoch", "mittel"]
                .iter()
                .any(|v| field(mood, "intensity") == Some(&text(v)));
            let dominant = DIMS
                .iter()
                .find(|dim| strong && field(mood, "dominant") == Some(&text(dim)))
                .copied()
                .unwrap_or("neutral");
            return result(values, dominant, values.into_iter().fold(0., f64::max));
        }
    }
    let mut sums: [Json; 7] = std::array::from_fn(|_| json_number(0.));
    let mut count = 0;
    for turn in turns {
        let Some(value) = field(turn, "emotionalValence").filter(|v| truthy(v)) else {
            continue;
        };
        let parsed;
        let value = if let Json::String(raw) = value {
            parsed = parse_valence(raw);
            &parsed
        } else {
            value
        };
        for (i, dim) in DIMS.iter().enumerate() {
            let zero = json_number(0.);
            let value = field(value, dim).filter(|v| truthy(v)).unwrap_or(&zero);
            sums[i] = add(&sums[i], value);
        }
        count += 1;
    }
    if count > 0 {
        for (i, sum) in sums.iter().enumerate() {
            values[i] = number(Some(sum)) / f64::from(count);
        }
    }
    let mut dominant = "neutral";
    let mut intensity: f64 = 0.;
    for (i, value) in values.iter().enumerate() {
        // Node reduce chooses the later entry when the current maximum is NaN.
        if intensity.is_nan() || value.is_nan() || intensity < *value {
            dominant = DIMS[i];
            intensity = *value;
        }
    }
    if intensity.is_nan() || intensity < 0.25 {
        dominant = "neutral";
    }
    result(values, dominant, intensity)
}
fn result(values: [f64; 7], dominant: &'static str, intensity: f64) -> Emotion {
    Emotion {
        tone: object(DIMS.into_iter().zip(values.map(json_number)).collect()),
        dominant,
        intensity,
    }
}
fn add(a: &Json, b: &Json) -> Json {
    if matches!(a, Json::String(_) | Json::Array(_) | Json::Object(_))
        || matches!(b, Json::String(_) | Json::Array(_) | Json::Object(_))
    {
        let mut units = string(a).as_utf16_units().to_vec();
        units.extend_from_slice(string(b).as_utf16_units());
        Json::String(JsString::from_utf16_units(units))
    } else {
        json_number(number(Some(a)) + number(Some(b)))
    }
}
fn parse_valence(raw: &JsString) -> Json {
    let mut result = object(vec![]);
    for pair in raw.to_utf8_lossy().split(',') {
        let mut parts = pair.split(':');
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        if !key.is_empty() && !value.is_empty() {
            // Node parseFloat accepts a numeric prefix, including a partially supplied exponent.
            let value = js_trim(value);
            let parsed = parse_float(value).unwrap_or(0.);
            let value = if parsed.is_nan() { 0. } else { parsed };
            if let Json::Object(fields) = &mut result {
                let key = JsString::from(js_trim(key));
                if let Some((_, v)) = fields.iter_mut().find(|(k, _)| k == &key) {
                    *v = json_number(value);
                } else {
                    fields.push((key, json_number(value)));
                }
            }
        }
    }
    result
}

fn parse_float(value: &str) -> Option<f64> {
    let value = js_trim(value);
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
