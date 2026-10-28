//! Canonical persisted vector-space identities from the pinned Node implementation.
//!
//! The field order is part of the SHA-256 material. The generated contract's map order is
//! deliberately not used to serialize the identity table.

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::contract::{StoreError, VectorSpaceIdentity, VectorSpaceIdentityArtifactsItem};

/// JavaScript's largest exactly representable positive integer (`Number.MAX_SAFE_INTEGER`).
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalIdentity<'a> {
    provider: &'a str,
    model: &'a str,
    revision: &'a str,
    dimension: u64,
    normalization: &'a str,
    prefix_scheme: &'a str,
    instruction: &'a str,
    dtype: &'a str,
    token_cap: Option<u64>,
    pooling: &'a str,
    artifacts: &'a [VectorSpaceIdentityArtifactsItem],
}

/// Validate and normalize a typed identity, returning its canonical value, exact Node JSON and ID.
///
/// Missing optional fields become `tokenCap: null`, `pooling: "unspecified"` and `artifacts: []`.
/// Artifact paths are sorted by UTF-16 code units, matching JavaScript's `<` comparison.
/// Invalid arguments return a bounded error without exposing identity contents.
pub fn canonical_identity(
    input: &VectorSpaceIdentity,
) -> Result<(VectorSpaceIdentity, String, String), StoreError> {
    if input.provider.is_empty() || input.model.is_empty() {
        return Err(StoreError::InvalidInput);
    }
    let dimension = positive_safe_integer(&input.dimension)?;
    let token_cap = input
        .token_cap
        .as_ref()
        .and_then(Option::as_ref)
        .map(positive_safe_integer)
        .transpose()?;
    let pooling = input.pooling.as_deref().unwrap_or("unspecified");
    let mut artifacts = input.artifacts.clone().unwrap_or_default();
    for artifact in &artifacts {
        if artifact.path.is_empty()
            || artifact.sha256.len() != 64
            || !artifact
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(StoreError::InvalidInput);
        }
    }
    artifacts.sort_by(|left, right| left.path.encode_utf16().cmp(right.path.encode_utf16()));
    if artifacts
        .windows(2)
        .any(|pair| pair[0].path == pair[1].path)
    {
        return Err(StoreError::InvalidInput);
    }
    let value = CanonicalIdentity {
        provider: &input.provider,
        model: &input.model,
        revision: &input.revision,
        dimension,
        normalization: &input.normalization,
        prefix_scheme: &input.prefix_scheme,
        instruction: &input.instruction,
        dtype: &input.dtype,
        token_cap,
        pooling,
        artifacts: &artifacts,
    };
    let json = serde_json::to_string(&value).map_err(|_| StoreError::InvalidInput)?;
    let id = format!("{:x}", Sha256::digest(json.as_bytes()));
    let mut normalized = input.clone();
    normalized.dimension = dimension.into();
    normalized.token_cap = Some(token_cap.map(Into::into));
    normalized.pooling = Some(pooling.to_owned());
    normalized.artifacts = Some(artifacts);
    Ok((normalized, json, id))
}

/// The exact `JSON.stringify(embeddingIdentity(input))` text used by the identity table.
pub fn canonical_json(input: &VectorSpaceIdentity) -> Result<String, StoreError> {
    canonical_identity(input).map(|(_, json, _)| json)
}

/// SHA-256 of the canonical Node identity JSON, encoded as lowercase hexadecimal.
pub fn identity_id(input: &VectorSpaceIdentity) -> Result<String, StoreError> {
    canonical_identity(input).map(|(_, _, id)| id)
}

fn positive_safe_integer(number: &serde_json::Number) -> Result<u64, StoreError> {
    let value = number.as_f64().ok_or(StoreError::InvalidInput)?;
    if value < 1.0 || value > JS_MAX_SAFE_INTEGER as f64 || value.fract() != 0.0 {
        return Err(StoreError::InvalidInput);
    }
    Ok(value as u64)
}
