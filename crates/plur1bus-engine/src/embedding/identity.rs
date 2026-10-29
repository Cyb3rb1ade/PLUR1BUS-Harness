//! Node-compatible canonical vector-space identities.
//!
//! Canonical JSON and hashing share RE-02's persisted identity implementation, so the
//! embedding provider and store cannot disagree about the same typed vector space.

use crate::config::ConfigError;
use crate::contract::{StoreError, VectorSpaceIdentity};
use serde_json::{json, Value};

/// Canonicalize a raw Node identity input, including JavaScript nullish defaults.
pub fn identity_from_value(raw: &Value) -> Result<VectorSpaceIdentity, ConfigError> {
    let invalid = |message: &str| ConfigError {
        path: "embedding.identity".into(),
        message: message.into(),
    };
    let raw = raw
        .as_object()
        .ok_or_else(|| invalid("embedding identity must be an object"))?;
    let get = |key: &str| raw.get(key).filter(|value| !value.is_null());
    for field in ["provider", "model"] {
        if raw
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(invalid(&format!("embedding identity requires {field}")));
        }
    }
    let dimension = get("dimension")
        .or_else(|| get("dimensions"))
        .filter(|value| super::normalize::safe_positive_integer(value).is_some())
        .ok_or_else(|| invalid("embedding identity dimension must be positive"))?;
    let default_prefix = serde_json::to_string(&json!([
        get("queryPrefix").cloned().unwrap_or(json!("")),
        get("passagePrefix").cloned().unwrap_or(json!("")),
        get("pooling").cloned().unwrap_or(json!("")),
        get("tokenCap").cloned().unwrap_or(Value::Null),
    ]))
    .map_err(|_| invalid("invalid embedding identity prefixScheme"))?;
    let mut value = json!({
        "provider": raw["provider"], "model": raw["model"],
        "revision": get("revision").cloned().unwrap_or(json!("unspecified")),
        "dimension": dimension,
        "normalization": get("normalization").cloned().unwrap_or_else(||
            json!(if raw.get("normalize") == Some(&Value::Bool(true)) { "l2" } else { "none" })),
        "prefixScheme": get("prefixScheme").cloned().unwrap_or(json!(default_prefix)),
        "instruction": get("instruction").cloned().unwrap_or(json!("")),
        "dtype": get("dtype").cloned().unwrap_or(json!("float32")),
        "tokenCap": get("tokenCap").or_else(|| get("maxTokens")).cloned().unwrap_or(Value::Null),
        "pooling": get("pooling").cloned().unwrap_or(json!("unspecified")),
        "artifacts": [],
    });
    // Node deliberately projects away size/sourcePath and all other artifact metadata.
    let artifacts = match get("artifacts") {
        None => vec![],
        Some(value) => value.as_array().ok_or_else(|| invalid("invalid identity artifact"))?
            .iter().map(|artifact| Ok(json!({
                "path": artifact.get("path").ok_or_else(|| invalid("invalid identity artifact"))?,
                "sha256": artifact.get("sha256").ok_or_else(|| invalid("invalid identity artifact"))?,
            }))).collect::<Result<Vec<_>, ConfigError>>()?,
    };
    value["artifacts"] = Value::Array(artifacts);
    let identity: VectorSpaceIdentity =
        serde_json::from_value(value).map_err(|_| invalid("invalid embedding identity fields"))?;
    crate::store::identity::canonical_identity(&identity)
        .map(|(canonical, _, _)| canonical)
        .map_err(|_| invalid("invalid embedding identity fields"))
}

/// Return the canonical SHA-256 identity of a validated vector space.
///
/// # Panics
/// Panics if a caller constructs an invalid contract value instead of using `identity_from_value`.
#[allow(clippy::expect_used)] // The infallible port accepts canonical identities; untrusted callers use try_identity_id.
pub fn identity_id(identity: &VectorSpaceIdentity) -> String {
    try_identity_id(identity).expect("embedding identity must be validated before hashing")
}

/// Fallible form for identities supplied directly by callers.
pub fn try_identity_id(identity: &VectorSpaceIdentity) -> Result<String, StoreError> {
    crate::store::identity::identity_id(identity)
}
