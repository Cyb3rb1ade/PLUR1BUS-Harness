//! Strict captured-turn input access and ordered projection fields, not an authority adapter.
use crate::{
    contract::StoreError,
    text::{js::JsString, json::TolerantJsonValue as Json},
};
use std::collections::HashSet;

pub(super) fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(k, v)| (JsString::from(k), v))
            .collect(),
    )
}
pub(super) fn text(value: &str) -> Json {
    Json::String(JsString::from(value))
}
pub(super) fn string(value: &JsString) -> Json {
    Json::String(value.clone())
}
pub(super) fn validate_object(value: &Json) -> Result<(), StoreError> {
    let Json::Object(fields) = value else {
        return Err(StoreError::InvalidInput);
    };
    let mut names = HashSet::new();
    for (key, _) in fields {
        if !names.insert(key) {
            return Err(StoreError::InvalidInput);
        }
    }
    Ok(())
}
pub(super) fn field<'a>(value: &'a Json, key: &str) -> Result<&'a Json, StoreError> {
    super::merged_order::field(value, key).ok_or(StoreError::InvalidInput)
}
pub(super) fn str_field<'a>(value: &'a Json, key: &str) -> Result<&'a JsString, StoreError> {
    match field(value, key)? {
        Json::String(s) => Ok(s),
        _ => Err(StoreError::InvalidInput),
    }
}
pub(super) fn bool_field(value: &Json, key: &str) -> Result<bool, StoreError> {
    match field(value, key)? {
        Json::Bool(b) => Ok(*b),
        _ => Err(StoreError::InvalidInput),
    }
}
pub(super) fn set(object: &mut Json, key: &str, value: Json) -> Result<(), StoreError> {
    let Json::Object(fields) = object else {
        return Err(StoreError::InvalidInput);
    };
    let key = JsString::from(key);
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == &key) {
        *old = value;
    } else {
        fields.push((key, value));
    }
    Ok(())
}
pub(super) fn slice(value: &JsString, limit: usize) -> JsString {
    JsString::from_utf16_units(value.as_utf16_units().iter().take(limit).copied().collect())
}
