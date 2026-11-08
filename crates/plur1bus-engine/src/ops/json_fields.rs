//! Project schema-owned fields from Node JSON without decoding opaque UTF-16 fields.
use crate::text::json::{write_json, TolerantJsonValue};
use serde_json::{Map, Value};

pub(super) fn project(value: &TolerantJsonValue, keys: &[&str]) -> Value {
    let mut projected = Map::new();
    if let TolerantJsonValue::Object(fields) = value {
        for (key, value) in fields {
            let Ok(key) = String::from_utf16(key.as_utf16_units()) else {
                continue;
            };
            if keys.contains(&key.as_str()) {
                // Malformed known text cannot enter the String contract. Preserve the
                // stored record, and let the caller's existing validation reject this field.
                projected.insert(
                    key,
                    serde_json::from_str(&write_json(value)).unwrap_or(Value::Null),
                );
            }
        }
    }
    Value::Object(projected)
}
