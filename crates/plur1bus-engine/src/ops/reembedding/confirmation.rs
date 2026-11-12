//! Node-compatible, hash-bound migration confirmations. Only the non-secret
//! persisted metadata is serializable; the operator proof is returned explicitly.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use subtle::ConstantTimeEq;

const PREFIX: &str = "reemb_v1_";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Invalid confirmation creation input or unavailable OS entropy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmationError {
    /// Plan digests must use the exact lowercase SHA-256 schema.
    PlanDigest,
    /// Expiry must be a positive JavaScript-safe integer.
    Expiry,
    /// The OS entropy source failed.
    Entropy,
}
impl fmt::Display for ConfirmationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::PlanDigest => "invalid-plan-digest",
            Self::Expiry => "invalid-expiry",
            Self::Entropy => "entropy-unavailable",
        })
    }
}
impl std::error::Error for ConfirmationError {}
/// The exact closed Node state-file envelope, containing no operator proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedConfirmation {
    schema_version: u32,
    token_hash: String,
    plan_digest: String,
    expires_at: u64,
}
/// A generated proof. This type intentionally has no Serialize implementation.
/// Debug is redacted; the caller must explicitly expose the proof for the operator reply.
/// ```compile_fail
/// use plur1bus_engine::ops::reembedding::confirmation::Confirmation;
/// fn persist(value: &Confirmation) { let _ = serde_json::to_string(value); }
/// ```
pub struct Confirmation {
    proof: String,
    persisted: PersistedConfirmation,
}
impl Confirmation {
    /// The one-time proof for the operator response, never the state record or audit.
    pub fn expose_token(&self) -> &str {
        &self.proof
    }
    /// The only metadata to place in the durable migration state.
    pub fn persisted(&self) -> &PersistedConfirmation {
        &self.persisted
    }
}
impl fmt::Debug for Confirmation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Confirmation([redacted])")
    }
}
fn lowercase_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn plan_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(lowercase_hash)
}
fn proof_shape(value: &str) -> bool {
    value.strip_prefix(PREFIX).is_some_and(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}
fn proof_hash(proof: &str, digest: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"plur1bus-reembedding-confirmation:v1\0");
    hash.update(digest.as_bytes());
    hash.update(b"\0");
    hash.update(proof.as_bytes());
    format!("{:x}", hash.finalize())
}
fn input(digest: &str, expires_at: u64) -> Result<(), ConfirmationError> {
    if !plan_digest(digest) {
        return Err(ConfirmationError::PlanDigest);
    }
    if expires_at == 0 || expires_at > MAX_SAFE_INTEGER {
        return Err(ConfirmationError::Expiry);
    }
    Ok(())
}
/// Generate 32 bytes of OS entropy. No caller-supplied seed exists on this public API.
pub fn create(digest: &str, expires_at: u64) -> Result<Confirmation, ConfirmationError> {
    input(digest, expires_at)?;
    let mut entropy = [0; 32];
    getrandom::fill(&mut entropy).map_err(|_| ConfirmationError::Entropy)?;
    from_entropy(digest, expires_at, &entropy)
}
fn from_entropy(
    digest: &str,
    expires_at: u64,
    entropy: &[u8; 32],
) -> Result<Confirmation, ConfirmationError> {
    input(digest, expires_at)?;
    let proof = format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(entropy));
    let persisted = PersistedConfirmation {
        schema_version: 1,
        token_hash: proof_hash(&proof, digest),
        plan_digest: digest.into(),
        expires_at,
    };
    Ok(Confirmation { proof, persisted })
}
fn safe_integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0. && n.abs() <= MAX_SAFE_INTEGER as f64)
}
/// Verify exact proof/plan binding without applying its TTL, as required by explicit resume.
/// Unknown/missing fields and malformed input fail with the same boolean outcome.
pub fn verify_binding(proof: &str, persisted: &Value) -> bool {
    if !proof_shape(proof) {
        return false;
    }
    let Some(fields) = persisted.as_object() else {
        return false;
    };
    if fields.len() != 4
        || !["schemaVersion", "tokenHash", "planDigest", "expiresAt"]
            .iter()
            .all(|key| fields.contains_key(*key))
    {
        return false;
    }
    if fields.get("schemaVersion").and_then(Value::as_f64) != Some(1.) {
        return false;
    }
    let Some(expiry) = fields.get("expiresAt").and_then(safe_integer) else {
        return false;
    };
    if expiry <= 0. {
        return false;
    }
    let Some(digest) = fields
        .get("planDigest")
        .and_then(Value::as_str)
        .filter(|s| plan_digest(s))
    else {
        return false;
    };
    let Some(expected) = fields
        .get("tokenHash")
        .and_then(Value::as_str)
        .filter(|s| lowercase_hash(s))
    else {
        return false;
    };
    let actual = proof_hash(proof, digest);
    bool::from(actual.as_bytes().ct_eq(expected.as_bytes()))
}
/// Verify binding and strict expiry. Equality with expiry is already expired.
pub fn verify(proof: &str, persisted: &Value, now: f64) -> bool {
    now.is_finite()
        && now.fract() == 0.
        && now.abs() <= MAX_SAFE_INTEGER as f64
        && persisted
            .get("expiresAt")
            .and_then(safe_integer)
            .is_some_and(|expiry| now < expiry)
        && verify_binding(proof, persisted)
}

#[cfg(test)]
#[path = "confirmation_tests.rs"]
mod tests;
