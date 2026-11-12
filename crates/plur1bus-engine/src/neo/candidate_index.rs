//! C4 candidate-index projection with D130 authority preserved (RE-D61).
//!
//! An index is derived data, not a new authorization source. Dropping a conflicting binding
//! would make the same record visible after indexing, so every ACL-relevant field survives.
use super::{
    derived_fields::{set, validate_object},
    merged_order::{field, string, truthy},
};
use crate::{
    contract::StoreError,
    text::{js::JsString, json::TolerantJsonValue as Json},
};

const FIELDS: &[&str] = &[
    "id",
    "workspaceKey",
    "agentId",
    "statement",
    "category",
    "status",
    "stale",
    "hardDeleted",
    "confidence",
    "salience",
    "recency",
    "createdAt",
    "updatedAt",
    "startTime",
    "epistemicStatus",
    "visibility",
    "ownerId",
    "ownerUserId",
    "sourceTurnIds",
    "embeddingDims",
    "emotionalDominant",
];
const ORIGIN_FIELDS: &[&str] = &["kind", "role", "trustLevel", "ownerId", "scope"];
const ROOT_AUTHORITY: &[&str] = &["scope", "workspaceIdentity", "workspaceId", "aclBindings"];
const ORIGIN_AUTHORITY: &[&str] = &[
    "ownerUserId",
    "agentId",
    "workspaceKey",
    "workspaceIdentity",
    "workspaceId",
];

/// Project one source record into the vector-free index shape. Null/no-ID/parse-error inputs
/// are absent as in Node. Duplicate object fields and malformed origins fail explicitly.
/// The caller must still authorize the source and serialize publication under its writer lease.
pub fn project(record: &Json) -> Result<Option<Json>, StoreError> {
    if !matches!(record, Json::Object(_)) {
        return Ok(None);
    }
    validate_object(record)?;
    let Some(id) = field(record, "id").filter(|v| truthy(v)) else {
        return Ok(None);
    };
    if field(record, "__parseError").is_some_and(truthy) {
        return Ok(None);
    }
    for key in ["visibility", "aclBindings"] {
        if let Some(value @ Json::Object(_)) = field(record, key) {
            validate_object(value)?;
        }
    }
    let mut entry = copy(record, FIELDS);
    set(&mut entry, "id", Json::String(string(id)))?;
    if !matches!(field(&entry, "statement"), Some(Json::String(_))) {
        let statement = ["statement", "content", "text"]
            .into_iter()
            .filter_map(|key| field(record, key))
            .find(|v| !matches!(v, Json::Null))
            .map_or_else(|| JsString::from(""), string);
        set(&mut entry, "statement", Json::String(statement))?;
    }
    match field(record, "origin") {
        None | Some(Json::Null) => {}
        Some(origin @ Json::Object(_)) => {
            validate_object(origin)?;
            let mut projected = copy(origin, ORIGIN_FIELDS);
            copy_into(&mut projected, origin, ORIGIN_AUTHORITY)?;
            set(&mut entry, "origin", projected)?;
        }
        Some(_) => return Err(StoreError::InvalidInput),
    }
    copy_into(&mut entry, record, ROOT_AUTHORITY)?;
    Ok(Some(entry))
}
fn copy(record: &Json, keys: &[&str]) -> Json {
    Json::Object(
        keys.iter()
            .filter_map(|key| field(record, key).map(|value| (JsString::from(*key), value.clone())))
            .collect(),
    )
}
fn copy_into(out: &mut Json, record: &Json, keys: &[&str]) -> Result<(), StoreError> {
    for key in keys {
        if let Some(value) = field(record, key) {
            set(out, key, value.clone())?;
        }
    }
    Ok(())
}
