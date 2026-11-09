//! Lossless scalar projection for authenticated prompt sources; no last-key-wins authority.
use crate::text::json::{write_json, TolerantJsonValue as Json};
use serde_json::Value;
use std::collections::HashSet;
pub(super) fn project(value: &Json) -> Option<Value> {
    unique(value)
        .then(|| serde_json::from_str(&write_json(value)).ok())
        .flatten()
}
fn unique(value: &Json) -> bool {
    match value {
        Json::Object(fields) => {
            let mut names = HashSet::new();
            fields
                .iter()
                .all(|(name, value)| names.insert(name) && unique(value))
        }
        Json::Array(values) => values.iter().all(unique),
        _ => true,
    }
}
