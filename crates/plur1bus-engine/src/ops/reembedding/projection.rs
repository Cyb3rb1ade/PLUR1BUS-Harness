//! Pure host configuration projection. This module never mutates active configuration or stores.
use crate::{
    embedding::artifacts::pinned_profile,
    text::js::{js_trim, utf16_len},
};
use serde_json::{json, Map, Value};

/// Fixed categories; caller configuration and credential material never enter error messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionError {
    /// A selection lacks its fingerprint object.
    Fingerprint,
    /// A credential reference is malformed or contains unexpected fields.
    SecretReference,
}
impl std::fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Fingerprint => "embedding selection fingerprint is required",
            Self::SecretReference => "invalid embedding SecretRef",
        })
    }
}
impl std::error::Error for ProjectionError {}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn copy(out: &mut Map<String, Value>, from: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(v) = from.get(*key) {
            out.insert((*key).into(), v.clone());
        }
    }
}
fn env_id(s: &str) -> bool {
    let mut bytes = s.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn secret_ref(value: &Value) -> Result<Value, ProjectionError> {
    let invalid = ProjectionError::SecretReference;
    let object = value.as_object().ok_or(invalid)?;
    if object.len() != 3
        || !["id", "provider", "source"]
            .iter()
            .all(|k| object.contains_key(*k))
    {
        return Err(invalid);
    }
    if !matches!(
        value["source"].as_str(),
        Some("env" | "store" | "file" | "exec")
    ) {
        return Err(invalid);
    }
    let provider = value["provider"].as_str().ok_or(invalid)?;
    if provider.is_empty()
        || provider.len() > 64
        || !provider.as_bytes()[0].is_ascii_lowercase()
        || !provider
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
    {
        return Err(invalid);
    }
    let id = value["id"].as_str().ok_or(invalid)?;
    if id.is_empty() || utf16_len(id) > 256 {
        return Err(invalid);
    }
    Ok(value.clone())
}
/// Retain a persistable reference only; a literal credential produces None and is never copied.
pub fn redacted_secret_ref(config: &Value) -> Result<Option<Value>, ProjectionError> {
    if config["provider"] == "local-transformers" {
        return Ok(None);
    }
    let key = config.get("apiKey");
    if let Some(key) = key.filter(|v| !v.is_null() && (v.is_object() || v.is_array())) {
        return secret_ref(key).map(Some);
    }
    let env = |id: &str| json!({"source":"env","provider":"default","id":id});
    if let Some(id) = config["apiKeyEnv"].as_str().filter(|s| env_id(s)) {
        return Ok(Some(env(id)));
    }
    if let Some(key) = key.and_then(Value::as_str) {
        let id = js_trim(key)
            .strip_prefix("${")
            .and_then(|s| s.strip_suffix('}'))
            .filter(|s| env_id(s));
        return Ok(id.map(env));
    }
    Ok(if key.is_none_or(Value::is_null) {
        Some(env("OPENAI_API_KEY"))
    } else {
        None
    })
}
fn canonical_prefix(model: &str, key: &str, stored: &Value) -> Value {
    let Some(stored_text) = stored.as_str() else {
        return stored.clone();
    };
    let profile = pinned_profile(model, None);
    let canonical = if key == "queryPrefix" {
        profile
            .and_then(|p| p.query_prefix.as_deref())
            .unwrap_or("query: ")
    } else {
        profile
            .and_then(|p| p.passage_prefix.as_deref())
            .unwrap_or("passage: ")
    };
    if stored_text == js_trim(canonical) {
        json!(canonical)
    } else {
        stored.clone()
    }
}
/// Project a validated migration selection into the host's embedding configuration. Preserve its
/// current fallback/cache settings and all vector-space fields, including tokenCap → maxTokens.
/// Authorization, atomic config.set and generation activation belong to the calling Core.
pub fn embedding_config(selection: &Value, current: &Value) -> Result<Value, ProjectionError> {
    let fingerprint = selection
        .get("fingerprint")
        .filter(|f| f.is_object())
        .ok_or(ProjectionError::Fingerprint)?;
    let mut output = Map::new();
    copy(&mut output, fingerprint, &["provider", "dimensions"]);
    if let Some(reference) = selection.get("secretRef").filter(|v| truthy(v)) {
        output.insert("apiKey".into(), secret_ref(reference)?);
    }
    if let Some(fallback) = current.get("fallback").filter(|v| truthy(v)) {
        output.insert("fallback".into(), fallback.clone());
    }
    if fingerprint["provider"] == "local-transformers" {
        let model = fingerprint["model"]
            .as_str()
            .ok_or(ProjectionError::Fingerprint)?;
        let mut local = Map::new();
        copy(
            &mut local,
            fingerprint,
            &["model", "dimensions", "revision"],
        );
        for key in ["queryPrefix", "passagePrefix"] {
            if let Some(value) = fingerprint.get(key).filter(|v| truthy(v)) {
                local.insert(key.into(), canonical_prefix(model, key, value));
            }
        }
        let default_dtype = pinned_profile(model, None).and_then(|p| p.dtype.as_deref());
        if let Some(dtype) = fingerprint
            .get("dtype")
            .filter(|v| truthy(v) && v.as_str() != default_dtype)
        {
            local.insert("dtype".into(), dtype.clone());
        }
        if let Some(cap) = fingerprint.get("tokenCap") {
            local.insert("maxTokens".into(), cap.clone());
        }
        if let Some(cache) = current
            .get("local")
            .and_then(|v| v.get("cacheDir"))
            .filter(|v| truthy(v))
        {
            local.insert("cacheDir".into(), cache.clone());
        }
        output.insert("local".into(), Value::Object(local));
    } else {
        copy(
            &mut output,
            fingerprint,
            &[
                "model",
                "revision",
                "normalization",
                "dtype",
                "prefixScheme",
                "instruction",
            ],
        );
        if let Some(endpoint) = fingerprint.get("endpoint").filter(|v| truthy(v)) {
            output.insert("baseUrl".into(), endpoint.clone());
        }
    }
    Ok(Value::Object(output))
}
/// Pinned local-provider constructor options, or None when the model/dtype/revision is unknown.
/// This is a pure projection and never resolves cache files or starts/downloads a model.
pub fn local_options(fingerprint: &Value) -> Option<Value> {
    let model = fingerprint["model"].as_str()?;
    let profile = pinned_profile(model, fingerprint.get("dtype").and_then(Value::as_str))?;
    if fingerprint["revision"].as_str() != Some(&profile.revision) {
        return None;
    }
    let mut output = Map::new();
    copy(
        &mut output,
        fingerprint,
        &["model", "revision", "dimensions"],
    );
    for key in ["queryPrefix", "passagePrefix"] {
        if let Some(v) = fingerprint.get(key) {
            output.insert(key.into(), canonical_prefix(model, key, v));
        }
    }
    let default_dtype = pinned_profile(model, None).and_then(|p| p.dtype.as_deref());
    if let Some(dtype) = fingerprint
        .get("dtype")
        .filter(|v| truthy(v) && v.as_str() != default_dtype)
    {
        output.insert("dtype".into(), dtype.clone());
    }
    Some(Value::Object(output))
}
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "actual frozen Node projection fixtures")]
    use super::*;
    #[test]
    fn actual_node_projection_preserves_fingerprint_fields_and_reference_redaction() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/ops/golden/reembedding-projection.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 44);
        for case in cases {
            let input = &case["input"];
            let result = match case["kind"].as_str().unwrap() {
                "projection" => embedding_config(&input["selection"], &input["current"]),
                "secret-ref" => redacted_secret_ref(input).map(|v| v.unwrap_or(Value::Null)),
                "local-options" => Ok(local_options(input).unwrap_or(Value::Null)),
                _ => unreachable!(),
            };
            if case.get("error").is_some() || case.get("rustException").is_some() {
                assert_eq!(
                    result,
                    Err(ProjectionError::SecretReference),
                    "{}",
                    case["name"]
                );
            } else {
                assert_eq!(result.unwrap(), case["value"], "{}", case["name"]);
            }
        }
    }
    #[test]
    fn malformed_selection_references_never_project_literal_material() {
        assert_eq!(
            embedding_config(&json!({}), &json!({})),
            Err(ProjectionError::Fingerprint)
        );
        let selection = json!({"fingerprint":{"provider":"openai","model":"synthetic","dimensions":8},"secretRef":"not-a-credential"});
        assert_eq!(
            embedding_config(&selection, &json!({})),
            Err(ProjectionError::SecretReference)
        );
        assert!(!ProjectionError::SecretReference
            .to_string()
            .contains("not-a-credential"));
    }
}
