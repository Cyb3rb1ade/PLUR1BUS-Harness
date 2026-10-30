//! Effective embedding configuration, with host-owned provider and cache selection.
//!
//! The host selects the provider and a literal local cache path before normalization.
//! This is intentionally stricter than Node's implicit provider and legacy host-home
//! defaults. Neither host choice changes vector-space identity or fingerprint material.

use super::artifacts::pinned_profile;
use crate::config::ConfigError;
use crate::text::js::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Effective Node embedding configuration, omitting JavaScript undefined properties.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NormalizedEmbeddingConfig(Value);

impl NormalizedEmbeddingConfig {
    /// Complete effective provider configuration.
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    /// Selected provider identifier.
    pub fn provider(&self) -> &str {
        self.0["provider"].as_str().unwrap_or_default()
    }
    /// Selected model identifier.
    pub fn model(&self) -> &str {
        self.0["model"].as_str().unwrap_or_default()
    }
    /// Selected vector width.
    pub fn dimensions(&self) -> usize {
        self.0["dimensions"].as_u64().unwrap_or_default() as usize
    }
    /// Effective local settings, when this is a local provider.
    pub fn local(&self) -> Option<&Value> {
        self.0.get("local")
    }
}
impl std::ops::Deref for NormalizedEmbeddingConfig {
    type Target = Value;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub(super) fn config_error(message: impl Into<String>) -> ConfigError {
    ConfigError {
        path: "embedding".into(),
        message: message.into(),
    }
}

pub(super) fn safe_positive_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    ((1.0..=9_007_199_254_740_991.0).contains(&number) && number.fract() == 0.0)
        .then_some(number as u64)
}

pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn non_null<'a>(raw: &'a Value, key: &str) -> Option<&'a Value> {
    raw.get(key).filter(|value| !value.is_null())
}

fn non_empty(raw: &Value, key: &str) -> Option<Value> {
    raw.get(key)
        .filter(|value| !value.as_str().is_some_and(|text| js_trim(text).is_empty()))
        .cloned()
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::String(value) => {
            let value = js_trim(value);
            if value.is_empty() {
                Some(0.0)
            } else {
                value.parse().ok()
            }
        }
        _ => None,
    }
}

fn dimensions(provider: &str, model: &str, configured: Option<&Value>) -> Result<u64, ConfigError> {
    let known = match model {
        "intfloat/multilingual-e5-small" => Some(384),
        "jinaai/jina-embeddings-v3" => Some(1024),
        "jinaai/jina-embeddings-v5-text-nano-retrieval" | "google/embeddinggemma-2" => Some(768),
        "text-embedding-3-small" | "text-embedding-ada-002" => Some(1536),
        "text-embedding-3-large" => Some(3072),
        _ => None,
    };
    let fallback = known.unwrap_or_else(|| {
        if provider == "local-transformers" {
            384
        } else if model.contains("small") || model.contains("ada") {
            1536
        } else {
            3072
        }
    });
    let value = configured.and_then(number).unwrap_or_else(|| {
        if configured.is_some() {
            f64::NAN
        } else {
            f64::from(fallback)
        }
    });
    let dimension = safe_positive_integer(&json!(value)).ok_or_else(|| {
        config_error(format!(
            "embedding dimensions for {model} must be a positive integer"
        ))
    })?;
    let canonical = model.strip_prefix("openai/").unwrap_or(model);
    if provider == "local-transformers" && model == "intfloat/multilingual-e5-small"
        || provider == "openai" && canonical == "text-embedding-ada-002"
    {
        let expected = if provider == "openai" { 1536 } else { 384 };
        if dimension != expected {
            return Err(config_error(format!(
                "{model} has fixed {expected} dimensions; configured {dimension}"
            )));
        }
    }
    if provider == "openai"
        && matches!(
            canonical,
            "text-embedding-3-small" | "text-embedding-3-large"
        )
    {
        let max = if canonical.ends_with("small") {
            1536
        } else {
            3072
        };
        if dimension > max {
            return Err(config_error(format!(
                "{model} supports dimensions from 1 through {max}; configured {dimension}"
            )));
        }
    }
    if provider == "local-transformers" {
        if let Some(profile) = pinned_profile(model, None) {
            if !profile.matryoshka_dimensions.is_empty()
                && !profile
                    .matryoshka_dimensions
                    .contains(&(dimension as usize))
            {
                return Err(config_error(format!(
                    "{model} supports only its declared dimensions: {}; configured {dimension}",
                    profile
                        .matryoshka_dimensions
                        .iter()
                        .map(usize::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
        }
    }
    Ok(dimension)
}

/// Normalize an embedding block whose provider and local cache path the host selected explicitly.
/// The pure Rust boundary requires both choices; Node's host-specific defaults are not inferred.
pub fn normalize_embedding_config(raw: &Value) -> Result<NormalizedEmbeddingConfig, ConfigError> {
    let raw_object = raw
        .as_object()
        .ok_or_else(|| config_error("embedding config must be an object"))?;
    let provider = raw
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| config_error("embedding provider is required"))?;
    let mut output = Map::new();
    output.insert("provider".into(), json!(provider));
    output.insert("id".into(), json!(provider));
    if provider == "local-transformers" {
        let empty = json!({});
        let local = raw
            .get("local")
            .filter(|value| truthy(value))
            .unwrap_or(&empty);
        let model_value = non_empty(local, "model")
            .filter(truthy)
            .unwrap_or(json!("intfloat/multilingual-e5-small"));
        let model = model_value
            .as_str()
            .ok_or_else(|| config_error("local embedding model must be a string"))?;
        let dtype_value = non_empty(local, "dtype");
        let dtype = dtype_value.as_ref().and_then(Value::as_str);
        let profile = pinned_profile(model, dtype);
        if dtype_value.is_some() && (dtype.is_none() || profile.is_none()) {
            return Err(config_error(format!(
                "local embedding dtype {} is not a pinned dtype of {model}",
                dtype_value.unwrap_or(Value::Null)
            )));
        }
        if profile.is_some_and(|profile| profile.role != "embedding") {
            return Err(config_error(format!(
                "{model} is a pinned reranker, not an embedding model"
            )));
        }
        if local
            .get("maxBatchSize")
            .is_some_and(|value| safe_positive_integer(value).is_none_or(|size| size > 64))
        {
            let value = &local["maxBatchSize"];
            return Err(config_error(format!(
                "local embedding maxBatchSize must be an integer between 1 and 64, got {}",
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string())
            )));
        }
        let dimension = dimensions(
            provider,
            model,
            non_null(local, "dimensions").or_else(|| non_null(raw, "dimensions")),
        )?;
        let cache_dir = local
            .get("cacheDir")
            .and_then(Value::as_str)
            .filter(|value| !js_trim(value).is_empty())
            .ok_or_else(|| {
                config_error("local embedding local.cacheDir must be supplied by the host")
            })?;
        let mut effective = Map::new();
        effective.insert("model".into(), json!(model));
        effective.insert("dimensions".into(), json!(dimension));
        if let Some(revision) = non_empty(local, "revision")
            .filter(truthy)
            .or_else(|| profile.map(|profile| json!(profile.revision)))
        {
            effective.insert("revision".into(), revision);
        }
        for (key, fallback) in [("queryPrefix", "query: "), ("passagePrefix", "passage: ")] {
            let pinned = profile.and_then(|profile| {
                if key == "queryPrefix" {
                    profile.query_prefix.as_ref()
                } else {
                    profile.passage_prefix.as_ref()
                }
            });
            effective.insert(
                key.into(),
                non_null(local, key)
                    .cloned()
                    .unwrap_or_else(|| json!(pinned.map(String::as_str).unwrap_or(fallback))),
            );
        }
        for key in ["maxTokens", "maxBatchSize"] {
            if let Some(value) = local.get(key) {
                effective.insert(key.into(), value.clone());
            }
        }
        if let Some(dtype) = dtype_value {
            effective.insert("dtype".into(), dtype);
        }
        effective.insert("cacheDir".into(), json!(cache_dir));
        effective.insert("acceptNonCommercialLicense".into(), Value::Bool(false));
        output.insert("model".into(), json!(model));
        output.insert("dimensions".into(), json!(dimension));
        output.insert("local".into(), Value::Object(effective));
        output.insert("fallback".into(), Value::Null);
    } else {
        let model_value = non_empty(raw, "model")
            .filter(truthy)
            .unwrap_or(json!("text-embedding-3-small"));
        let model = model_value
            .as_str()
            .ok_or_else(|| config_error("embedding model must be a string"))?;
        let dimension = dimensions(provider, model, non_null(raw, "dimensions"))?;
        for key in [
            "apiKey",
            "apiKeyEnv",
            "baseUrl",
            "revision",
            "normalization",
            "dtype",
            "prefixScheme",
            "instruction",
        ] {
            if let Some(value) = raw.get(key) {
                output.insert(key.into(), value.clone());
            }
        }
        if let Some(reference) = raw
            .get("apiKeyRef")
            .filter(|value| !value.is_null() && **value != json!(""))
        {
            let name = reference
                .as_str()
                .map(js_trim)
                .filter(|name| {
                    !name.is_empty()
                        && name.len() <= 256
                        && name.as_bytes()[0].is_ascii_alphanumeric()
                        && name
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/@-".contains(&byte))
                })
                .ok_or_else(|| {
                    config_error(
                        "apiKeyRef must be a secret name of 1-256 characters ([A-Za-z0-9._:/@-])",
                    )
                })?;
            output.insert("apiKeyRef".into(), json!(name));
        }
        output.insert("model".into(), json!(model));
        output.insert("dimensions".into(), json!(dimension));
        let timeout = raw
            .get("requestTimeoutMs")
            .and_then(number)
            .filter(|number| number.is_finite() && *number >= 1000.0)
            .map(f64::floor)
            .unwrap_or(15000.0);
        output.insert(
            "requestTimeoutMs".into(),
            if timeout <= u64::MAX as f64 {
                json!(timeout as u64)
            } else {
                json!(timeout)
            },
        );
        output.insert(
            "fallback".into(),
            raw.get("fallback")
                .filter(|value| truthy(value))
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    for (old, new) in [
        ("embeddingCacheMaxEntries", "cacheMaxEntries"),
        ("embeddingCacheTtlMs", "cacheTtlMs"),
    ] {
        if let Some(value) = non_null(raw, old).or_else(|| raw.get(new)) {
            output.insert(new.into(), value.clone());
        }
    }
    for key in [
        "embeddingCacheEnabled",
        "embeddingCachePersist",
        "embeddingCachePersistDebug",
        "embeddingCacheCoalesce",
        "embeddingCacheMetrics",
        "embeddingCacheScope",
        "embeddingCacheMaxBytes",
    ] {
        if let Some(value) = raw_object.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    Ok(NormalizedEmbeddingConfig(Value::Object(output)))
}
