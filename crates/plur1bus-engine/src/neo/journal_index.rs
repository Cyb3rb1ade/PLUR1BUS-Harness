//! Refresh Node's deduplication cache without dropping keys for already-pruned history.
//! Native authorization never trusts this ownerless compatibility index.
use super::{
    derived_fields::{object, set, text, validate_object},
    journal_io,
    merged_order::{field, string, truthy},
    turns::{normalize_statement, stable_id},
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::directory::TrustedDirectory,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use std::collections::HashSet;

pub(super) fn project(dir: &TrustedDirectory, cancel: &Cancel) -> Result<Json, EngineError> {
    let old = match journal_io::bytes(dir, "record-index.json", cancel)? {
        Some(bytes) => parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
            .map_err(|_| StoreError::Corrupt)?,
        None => object(vec![]),
    };
    validate_object(&old)?;
    let old_ids = field(&old, "ids")
        .cloned()
        .unwrap_or_else(|| object(vec![]));
    validate_object(&old_ids)?;
    let mut ids = object(vec![]);
    for (bucket, source) in [
        ("turns", Some(0)),
        ("candidates", None),
        ("candidateContent", Some(1)),
        ("reactions", Some(2)),
        ("behavior", Some(3)),
    ] {
        let mut values = Vec::new();
        let mut seen = HashSet::new();
        if let Some(previous) = field(&old_ids, bucket) {
            let Json::Array(previous) = previous else {
                return Err(StoreError::Corrupt.into());
            };
            for item in previous {
                let s = string(item);
                if !s.is_empty() && seen.insert(s.clone()) {
                    values.push(Json::String(s));
                }
            }
        }
        if let Some(source) = source {
            for row in journal_io::rows(dir, journal_io::FILES[source], cancel)? {
                cancel.check()?;
                let key = if bucket == "candidateContent" {
                    content_key(&row)
                } else {
                    append_id(&row)
                };
                if let Some(key) = key.filter(|key| !key.is_empty()) {
                    if seen.insert(key.clone()) {
                        values.push(Json::String(key));
                    }
                }
            }
        }
        if values.len() > journal_io::MAX_ROWS {
            return Err(StoreError::Corrupt.into());
        }
        set(&mut ids, bucket, Json::Array(values))?;
    }
    let queue = field(&old, "embeddingQueue")
        .cloned()
        .unwrap_or_else(|| object(vec![]));
    validate_object(&queue)?;
    let mut statuses = field(&queue, "statuses")
        .cloned()
        .unwrap_or_else(|| object(vec![]));
    validate_object(&statuses)?;
    if let Json::Object(fields) = &statuses {
        if fields.len() > journal_io::MAX_ROWS
            || fields.iter().any(|(_, v)| !matches!(v, Json::String(_)))
        {
            return Err(StoreError::Corrupt.into());
        }
    }
    for row in journal_io::rows(dir, journal_io::FILES[4], cancel)? {
        let id = journal_io::id(&row)?;
        let Json::Object(fields) = &mut statuses else {
            return Err(StoreError::Corrupt.into());
        };
        let status = field(&row, "status")
            .filter(|s| truthy(s))
            .cloned()
            .unwrap_or_else(|| text("pending"));
        if !matches!(status, Json::String(_)) {
            return Err(StoreError::Corrupt.into());
        }
        if let Some((_, value)) = fields.iter_mut().find(|(key, _)| key == &id) {
            *value = status;
        } else {
            fields.push((id, status));
        }
        if fields.len() > journal_io::MAX_ROWS {
            return Err(StoreError::Corrupt.into());
        }
    }
    Ok(object(vec![
        ("version", Json::Number("1".into())),
        ("ids", ids),
        ("embeddingQueue", object(vec![("statuses", statuses)])),
    ]))
}
fn append_id(row: &Json) -> Option<JsString> {
    if ["updatedAt", "embeddingUpdatedAt"]
        .iter()
        .any(|key| field(row, key).is_some_and(truthy))
    {
        return None;
    }
    field(row, "id").filter(|id| truthy(id)).map(string)
}
fn content_key(row: &Json) -> Option<JsString> {
    if let (Some(id), Some(updated), Some(Json::String(status))) = (
        field(row, "id").filter(|id| truthy(id)),
        field(row, "updatedAt").filter(|v| truthy(v)),
        field(row, "status"),
    ) {
        if super::status::Status::parse(status).is_some() && status != &JsString::from("candidate")
        {
            let mut units = JsString::from("status:").as_utf16_units().to_vec();
            for (i, value) in [string(id), status.clone(), string(updated)]
                .iter()
                .enumerate()
            {
                if i > 0 {
                    units.push(u16::from(b':'));
                }
                units.extend_from_slice(value.as_utf16_units());
            }
            return Some(JsString::from_utf16_units(units));
        }
    }
    let content = ["normalizedStatement", "statement", "content", "text"]
        .iter()
        .filter_map(|key| field(row, key))
        .find(|v| truthy(v))
        .map(string)
        .unwrap_or_default();
    let normalized = normalize_statement(&content);
    if normalized.is_empty() {
        return append_id(row);
    }
    let id = stable_id("candidate-content", vec![Json::String(normalized)]).to_utf8_lossy();
    Some(JsString::from(
        format!(
            "content:{}",
            id.strip_prefix("candidate-content_").unwrap_or(&id)
        )
        .as_str(),
    ))
}
