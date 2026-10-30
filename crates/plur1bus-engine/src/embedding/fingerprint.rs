//! Schema-versioned Node embedding fingerprints.
//!
//! Only canonical vector-space fields enter the digest. Credential rotation,
//! local cache paths and request timeouts do not change the space.

use super::artifacts::pinned_profile;
use super::normalize::{config_error, safe_positive_integer, truthy, NormalizedEmbeddingConfig};
use crate::config::ConfigError;
use crate::text::js::{js_trim, locale_compare};
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const CONFIG_FIELDS: &[&str] = &[
    "provider",
    "model",
    "revision",
    "dimensions",
    "endpoint",
    "baseUrl",
    "queryPrefix",
    "passagePrefix",
    "pooling",
    "normalize",
    "dtype",
    "tokenCap",
    "instruction",
    "normalization",
    "prefixScheme",
];
const CREDENTIAL_FIELDS: &[&str] = &["apiKey", "apiKeyEnv", "credentialGeneration"];
const RECORD_ORDER: &[&str] = &[
    "schemaVersion",
    "provider",
    "model",
    "revision",
    "dimensions",
    "endpoint",
    "queryPrefix",
    "passagePrefix",
    "pooling",
    "normalize",
    "dtype",
    "tokenCap",
    "instruction",
    "normalization",
    "prefixScheme",
    "artifacts",
];

fn non_empty(value: Option<&Value>, label: &str) -> Result<String, ConfigError> {
    value
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| config_error(format!("invalid embedding fingerprint {label}")))
}

fn artifacts(input: &Value) -> Result<Value, ConfigError> {
    let entries = input
        .as_array()
        .ok_or_else(|| config_error("embedding fingerprint artifacts must be an array"))?;
    let mut entries = entries
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| config_error("invalid embedding fingerprint artifact"))?;
            if object.len() != 2 || !object.contains_key("path") || !object.contains_key("sha256") {
                return Err(config_error(
                    "invalid embedding fingerprint artifact fields",
                ));
            }
            let path = non_empty(entry.get("path"), "artifact path")?;
            if path.starts_with('/')
                || path
                    .split(['/', '\\'])
                    .any(|part| matches!(part, "" | "." | ".."))
            {
                return Err(config_error("invalid embedding fingerprint artifact path"));
            }
            let sha256 = non_empty(entry.get("sha256"), "artifact sha256")?.to_lowercase();
            if sha256.len() != 64
                || !sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(config_error(
                    "invalid embedding fingerprint artifact sha256",
                ));
            }
            Ok((path, sha256))
        })
        .collect::<Result<Vec<_>, ConfigError>>()?;
    entries.sort_by(|left, right| {
        locale_compare(&left.0, &right.0).then_with(|| locale_compare(&left.1, &right.1))
    });
    if entries.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(config_error(
            "duplicate embedding fingerprint artifact path",
        ));
    }
    Ok(Value::Array(
        entries
            .into_iter()
            .map(|(path, sha256)| json!({ "path": path, "sha256": sha256 }))
            .collect(),
    ))
}

fn endpoint(value: &Value) -> Result<Option<String>, ConfigError> {
    if value.is_null() || value == "" {
        return Ok(None);
    }
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    let mut endpoint = url::Url::parse(&text)
        .map_err(|_| config_error("invalid embedding fingerprint endpoint"))?;
    if !matches!(endpoint.scheme(), "http" | "https") {
        return Err(config_error(
            "invalid embedding fingerprint endpoint protocol",
        ));
    }
    endpoint
        .set_username("")
        .map_err(|_| config_error("invalid embedding fingerprint endpoint"))?;
    endpoint
        .set_password(None)
        .map_err(|_| config_error("invalid embedding fingerprint endpoint"))?;
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    Ok(Some(endpoint.to_string()))
}

fn canonical_record(raw: &Value, artifact_identities: &Value) -> Result<Value, ConfigError> {
    let provider = non_empty(raw.get("provider"), "provider")?;
    let model = non_empty(raw.get("model"), "model")?;
    let revision = raw
        .get("revision")
        .map(|value| non_empty(Some(value), "revision"))
        .transpose()?;
    if revision.as_ref().is_some_and(|revision| {
        ["main", "master", "latest", "dev", "beta", "nightly"]
            .contains(&revision.to_lowercase().as_str())
    }) {
        return Err(config_error(
            "embedding fingerprint requires an immutable revision",
        ));
    }
    let dimensions = raw
        .get("dimensions")
        .and_then(safe_positive_integer)
        .ok_or_else(|| config_error("invalid embedding fingerprint dimensions"))?;
    let endpoint = raw
        .get("endpoint")
        .filter(|value| !value.is_null())
        .or_else(|| raw.get("baseUrl"))
        .map(endpoint)
        .transpose()?
        .flatten();
    if raw
        .get("tokenCap")
        .is_some_and(|value| safe_positive_integer(value).is_none())
    {
        return Err(config_error("invalid embedding fingerprint tokenCap"));
    }
    for key in ["instruction", "normalization", "prefixScheme"] {
        if raw.get(key).is_some_and(|value| !value.is_string()) {
            return Err(config_error(format!("invalid embedding fingerprint {key}")));
        }
    }
    let mut output = Map::new();
    output.insert("schemaVersion".into(), json!(1));
    output.insert("provider".into(), json!(provider));
    output.insert("model".into(), json!(model));
    if let Some(revision) = revision {
        output.insert("revision".into(), json!(revision));
    }
    output.insert("dimensions".into(), json!(dimensions));
    if let Some(endpoint) = endpoint {
        output.insert("endpoint".into(), json!(endpoint));
    }
    for key in ["queryPrefix", "passagePrefix", "pooling", "dtype"] {
        if let Some(value) = raw.get(key) {
            output.insert(key.into(), json!(non_empty(Some(value), key)?));
        }
    }
    if let Some(value) = raw.get("normalize") {
        output.insert("normalize".into(), Value::Bool(value == true));
    }
    if let Some(value) = raw.get("tokenCap") {
        output.insert(
            "tokenCap".into(),
            json!(safe_positive_integer(value)
                .ok_or_else(|| config_error("invalid embedding fingerprint tokenCap"))?),
        );
    }
    for key in ["instruction", "normalization", "prefixScheme"] {
        if let Some(value) = raw.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    output.insert("artifacts".into(), artifacts(artifact_identities)?);
    Ok(Value::Object(output))
}

/// Normalize a closed fingerprint config and its complete artifact identities.
/// Explicit nulls are distinct from omitted JavaScript undefined fields.
pub fn normalize_fingerprint(
    raw: &Value,
    artifact_identities: &Value,
) -> Result<Value, ConfigError> {
    let object = raw
        .as_object()
        .ok_or_else(|| config_error("embedding fingerprint config must be an object"))?;
    for key in object.keys() {
        if !CONFIG_FIELDS.contains(&key.as_str()) && !CREDENTIAL_FIELDS.contains(&key.as_str()) {
            return Err(config_error(format!(
                "unknown embedding fingerprint field: {key}"
            )));
        }
    }
    canonical_record(raw, artifact_identities)
}

struct OrderedRecord<'a>(&'a Value);
impl Serialize for OrderedRecord<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for key in RECORD_ORDER {
            if let Some(value) = self.0.get(key) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

/// Return the schema-prefixed SHA-256 of a canonical or raw fingerprint record.
pub fn fingerprint_record_id(record: &Value) -> Result<String, ConfigError> {
    let object = record
        .as_object()
        .ok_or_else(|| config_error("embedding fingerprint must be an object"))?;
    for key in object.keys() {
        if !CONFIG_FIELDS.contains(&key.as_str())
            && !CREDENTIAL_FIELDS.contains(&key.as_str())
            && !["schemaVersion", "artifacts"].contains(&key.as_str())
        {
            return Err(config_error(format!(
                "unknown embedding fingerprint field: {key}"
            )));
        }
    }
    if record
        .get("schemaVersion")
        .is_some_and(|value| value.as_f64() != Some(1.0))
    {
        return Err(config_error(
            "unsupported embedding fingerprint schema version",
        ));
    }
    let empty = json!([]);
    let canonical = canonical_record(
        record,
        record
            .get("artifacts")
            .filter(|value| truthy(value))
            .unwrap_or(&empty),
    )?;
    let json = serde_json::to_string(&OrderedRecord(&canonical))
        .map_err(|_| config_error("invalid embedding fingerprint"))?;
    Ok(format!(
        "embedding:v1:sha256:{:x}",
        Sha256::digest(json.as_bytes())
    ))
}

/// Project an effective provider config into the canonical vector-space fingerprint.
pub fn fingerprint_from_normalized(
    normalized: &NormalizedEmbeddingConfig,
) -> Result<Value, ConfigError> {
    let config = normalized.as_value();
    let mut raw = json!({ "provider": config["provider"], "model": config["model"], "dimensions": config["dimensions"] });
    if normalized.provider() == "local-transformers" {
        let local = normalized
            .local()
            .ok_or_else(|| config_error("local embedding config is required"))?;
        let profile = pinned_profile(
            normalized.model(),
            local.get("dtype").and_then(Value::as_str),
        )
        .ok_or_else(|| {
            config_error(format!(
                "local embedding model is not pinned: {}",
                normalized.model()
            ))
        })?;
        if profile.role != "embedding" {
            return Err(config_error(format!(
                "local model is not a pinned embedding model: {}",
                profile.repo
            )));
        }
        if local.get("revision").and_then(Value::as_str) != Some(profile.revision.as_str()) {
            return Err(config_error(format!(
                "local embedding revision is not pinned for {}",
                profile.repo
            )));
        }
        raw["revision"] = json!(profile.revision);
        for key in ["queryPrefix", "passagePrefix"] {
            if let Some(value) = local.get(key).filter(|value| truthy(value)) {
                raw[key] = value.clone();
            }
        }
        raw["pooling"] = json!("mean");
        raw["normalize"] = json!(true);
        raw["prefixScheme"] = json!(serde_json::to_string(&json!([
            local
                .get("queryPrefix")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!("")),
            local
                .get("passagePrefix")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!("")),
            "mean",
            local.get("maxTokens").cloned().unwrap_or(Value::Null),
        ]))
        .map_err(|_| config_error("invalid embedding fingerprint prefixScheme"))?);
        if let Some(value) = local.get("maxTokens") {
            raw["tokenCap"] = value.clone();
        }
        if let Some(dtype) = &profile.dtype {
            raw["dtype"] = json!(dtype);
        }
        let identities = json!(profile
            .files
            .iter()
            .map(|file| json!({ "path": file.path, "sha256": file.sha256 }))
            .collect::<Vec<_>>());
        return normalize_fingerprint(&raw, &identities);
    }
    for key in [
        "revision",
        "normalization",
        "dtype",
        "prefixScheme",
        "instruction",
    ] {
        if let Some(value) = config.get(key) {
            raw[key] = value.clone();
        }
    }
    if let Some(value) = config.get("baseUrl").filter(|value| truthy(value)) {
        raw["endpoint"] = value.clone();
    }
    normalize_fingerprint(&raw, &json!([]))
}

/// Fallible fingerprint of an effective provider configuration.
pub fn try_fingerprint_id(normalized: &NormalizedEmbeddingConfig) -> Result<String, ConfigError> {
    fingerprint_record_id(&fingerprint_from_normalized(normalized)?)
}

/// Return the fingerprint of a validated effective provider configuration.
///
/// # Panics
/// Panics if the local model/revision or a vector-space field is not valid for fingerprinting.
#[allow(clippy::expect_used)] // The infallible port hashes validated configs; untrusted callers use try_fingerprint_id.
pub fn fingerprint_id(normalized: &NormalizedEmbeddingConfig) -> String {
    try_fingerprint_id(normalized).expect("embedding config must support an immutable fingerprint")
}
