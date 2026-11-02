//! Preserve JavaScript object iteration order in semantic-lens snapshots.

use super::render::RenderError;
use super::render_value::truthy;
use crate::text::js::JsString;
use crate::text::json::{parse_json, write_json, TolerantJsonValue};
use serde_json::{json, Value};

/// An ordered read snapshot; parsing never writes or refreshes its source index.
#[derive(Clone, Debug, Default)]
pub struct LensIndex {
    /// Communities in source array/Object.values order.
    pub communities: Vec<Value>,
    /// Memory array, in original order.
    pub memories: Vec<Value>,
    /// Entry-object pairs, in original insertion order.
    pub entries: Vec<(String, Value)>,
}

fn field<'a>(value: &'a TolerantJsonValue, name: &str) -> Option<&'a TolerantJsonValue> {
    let TolerantJsonValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find(|(key, _)| key.to_utf8_lossy() == name)
        .map(|(_, value)| value)
}

fn value(value: &TolerantJsonValue) -> Option<Value> {
    serde_json::from_str(&write_json(value)).ok()
}

fn ordered_values(value: Option<&TolerantJsonValue>) -> Vec<Value> {
    match value {
        Some(TolerantJsonValue::Array(items)) => items.iter().filter_map(self::value).collect(),
        Some(TolerantJsonValue::Object(items)) => object_entries(items)
            .into_iter()
            .filter_map(|(_, item)| self::value(item))
            .collect(),
        _ => Vec::new(),
    }
}

fn object_entries(fields: &[(JsString, TolerantJsonValue)]) -> Vec<&(JsString, TolerantJsonValue)> {
    let mut ordered = fields.iter().enumerate().collect::<Vec<_>>();
    ordered.sort_by_cached_key(|(position, (key, _))| {
        let text = key.to_utf8_lossy();
        let index = text
            .parse::<u32>()
            .ok()
            .filter(|index| *index < u32::MAX && index.to_string() == text);
        (index.is_none(), index.unwrap_or_default(), *position)
    });
    ordered.into_iter().map(|(_, field)| field).collect()
}

fn community(raw: &Value, array_shape: bool) -> Value {
    let representatives = if truthy(&raw["representativeMemoryIds"]) {
        raw["representativeMemoryIds"].clone()
    } else if array_shape && truthy(&raw["memoryIds"]) {
        raw["memoryIds"].clone()
    } else if array_shape && truthy(&raw["representative"]) {
        json!([raw["representative"]])
    } else {
        json!([])
    };
    json!({"id":raw["id"],"representativeMemoryIds":representatives,
        "bridgeMemoryIds":raw.get("bridgeMemoryIds").filter(|v|truthy(v)).unwrap_or(&json!([])),
        "fadedCandidateMemoryIds":raw.get("fadedCandidateMemoryIds")
            .filter(|v|truthy(v)).unwrap_or(&json!([]))})
}

impl LensIndex {
    /// Parse original file text before a serde map could reorder its community/entry keys.
    pub fn from_json(source: &str) -> Result<Self, RenderError> {
        let parsed = parse_json(source).map_err(|_| RenderError::InvalidIndex)?;
        let parsed = field(&parsed, "index")
            .filter(|v| !matches!(v, TolerantJsonValue::Null))
            .unwrap_or(&parsed);
        let raw_communities = field(parsed, "communities");
        let array_shape = matches!(raw_communities, Some(TolerantJsonValue::Array(_)));
        let communities = ordered_values(raw_communities)
            .into_iter()
            .map(|raw| community(&raw, array_shape))
            .collect();
        let entries = match field(parsed, "entries") {
            Some(TolerantJsonValue::Object(fields)) => object_entries(fields)
                .into_iter()
                .filter_map(|(key, child)| value(child).map(|value| (key.to_utf8_lossy(), value)))
                .collect(),
            _ => Vec::new(),
        };
        Ok(Self {
            communities,
            memories: ordered_values(field(parsed, "memories")),
            entries,
        })
    }

    /// Build from an already ordered array-based value; file readers should use `from_json`.
    pub fn from_value(value: &Value) -> Result<Self, RenderError> {
        Self::from_json(&value.to_string())
    }
}
