//! Ordered JSON, immutable generated vocabulary and JS numeric helpers for the emotion port.

use std::sync::OnceLock;

use crate::contract::EngineError;
use crate::text::js::{js_regex, js_to_lower_case, js_trim, JsRegex, JsString};
use crate::text::json::{parse_json, TolerantJsonValue as Json};

pub(super) use super::dynamics::json_number as num;

pub(super) fn string(value: &str) -> Json {
    Json::String(JsString::from(value))
}
pub(super) fn object(fields: impl IntoIterator<Item = (impl Into<String>, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(key, value)| (JsString::from(key.into().as_str()), value))
            .collect(),
    )
}
pub(super) fn get<'a>(value: &'a Json, key: &str) -> &'a Json {
    static NULL: Json = Json::Null;
    if let Json::Object(fields) = value {
        fields
            .iter()
            .rev()
            .find(|(name, _)| name == &JsString::from(key))
            .map_or(&NULL, |(_, value)| value)
    } else {
        &NULL
    }
}
pub(super) fn entries(value: &Json) -> Vec<(String, Json)> {
    match value {
        Json::Object(fields) => fields
            .iter()
            .map(|(key, value)| (key.to_utf8_lossy(), value.clone()))
            .collect(),
        Json::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        Json::String(value) => value
            .as_utf16_units()
            .iter()
            .enumerate()
            .map(|(index, unit)| {
                (
                    index.to_string(),
                    Json::String(JsString::from_utf16_units(vec![*unit])),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}
pub(super) fn array(value: &Json) -> &[Json] {
    if let Json::Array(values) = value {
        values
    } else {
        &[]
    }
}
pub(super) fn text(value: &Json) -> Option<String> {
    if let Json::String(value) = value {
        Some(value.to_utf8_lossy())
    } else {
        None
    }
}
pub(super) fn numeric(value: &Json) -> Option<f64> {
    if let Json::Number(value) = value {
        value.parse().ok()
    } else {
        None
    }
}
pub(super) fn coerce(value: &Json) -> f64 {
    match value {
        Json::Null => 0.0,
        Json::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Json::Number(value) => value.parse().unwrap_or(f64::NAN),
        Json::String(value) => {
            let value = value.to_utf8_lossy();
            let value = js_trim(&value);
            if value.is_empty() {
                0.0
            } else {
                value.parse().unwrap_or(f64::NAN)
            }
        }
        Json::Array(values) if values.is_empty() => 0.0,
        Json::Array(values) if values.len() == 1 => match &values[0] {
            Json::Null => 0.0,
            value => coerce(value),
        },
        _ => f64::NAN,
    }
}
pub(super) fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}
pub(super) fn round4(value: f64) -> f64 {
    (value * 10_000.0 + 0.5).floor() / 10_000.0
}
pub(super) fn invalid() -> EngineError {
    EngineError::Invalid {
        field: "emotion".into(),
        message: "invalid emotion value".into(),
    }
}
pub(super) fn data() -> Result<&'static Json, EngineError> {
    static DATA: OnceLock<Result<Json, ()>> = OnceLock::new();
    DATA.get_or_init(|| parse_json(include_str!("data/emotion-lexicon.json")).map_err(|_| ()))
        .as_ref()
        .map_err(|()| invalid())
}
pub(super) fn words(value: &JsString) -> Result<Vec<String>, EngineError> {
    static WORDS: OnceLock<Result<JsRegex, ()>> = OnceLock::new();
    let expression = WORDS
        .get_or_init(|| js_regex(r"\p{L}+", "gu").map_err(|_| ()))
        .as_ref()
        .map_err(|()| invalid())?;
    expression
        .find_all(&js_to_lower_case(&value.to_utf8_lossy()))
        .map(|matches| matches.into_iter().map(|matched| matched.matched).collect())
        .map_err(|_| invalid())
}
pub(super) fn iso(now: i64) -> Result<String, EngineError> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(invalid)
}
