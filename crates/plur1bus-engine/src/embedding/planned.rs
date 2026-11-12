//! Provider construction bound to an explicit, recomputed migration fingerprint.
//! Legacy construction is unchanged for existing Node stores (RE-D47).
use super::{model_selection::ModelSelection, EmbeddingProvider};
use crate::contract::{
    Cancel, EmbedError, EmbedKind, EngineConfig, EngineError, HostServices, VectorSpaceIdentity,
};
use serde_json::Value;
use std::sync::Arc;
fn invalid() -> EngineError {
    super::invalid_config(
        "embedding.identity",
        "configured provider does not match the planned fingerprint",
    )
}
struct BoundProvider {
    inner: Box<dyn EmbeddingProvider>,
    identity: VectorSpaceIdentity,
}
impl EmbeddingProvider for BoundProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn model_selection(&self) -> ModelSelection {
        self.inner.model_selection()
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        c: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.inner.embed(texts, kind, c)
    }
    fn invalidate_egress(&self) {
        self.inner.invalidate_egress();
    }
}
/// Construct the real provider only after its full effective fingerprint matches the requested
/// fingerprint. Bind the known local token-cap prefix representation to that plan, while retaining
/// every other identity field exactly. The legacy factory stays unchanged for pre-migration stores.
/// A host activating a recorded generation must use this same explicit-fingerprint constructor.
pub fn build_for_fingerprint(
    config: &EngineConfig,
    host: Arc<dyn HostServices>,
    fingerprint: &Value,
) -> Result<Box<dyn EmbeddingProvider>, EngineError> {
    let raw = super::configuration(config)?;
    let normalized = super::normalized_embedding(&raw, host.as_ref())?;
    let actual_fp =
        super::fingerprint::fingerprint_from_normalized(&normalized).map_err(|_| invalid())?;
    let actual_id = super::fingerprint::fingerprint_record_id(&actual_fp).map_err(|_| invalid())?;
    let expected_id =
        super::fingerprint::fingerprint_record_id(fingerprint).map_err(|_| invalid())?;
    if actual_id != expected_id {
        return Err(invalid());
    }
    let expected = super::identity::identity_from_value(fingerprint).map_err(|_| invalid())?;
    let provider = super::build_embedding_owned(config, host)?;
    let actual = serde_json::to_value(provider.identity()).map_err(|_| invalid())?;
    let expected_value = serde_json::to_value(&expected).map_err(|_| invalid())?;
    if actual == expected_value {
        return Ok(provider);
    }
    // C2 puts explicit maxTokens in tokenCap but omits it from its provider prefixScheme.
    // The complete config fingerprint above proves that runtime prompts/limits/artifacts match.
    if normalized.provider() != "local-transformers"
        || !matches_known_local_prefix(&actual, &expected_value)
    {
        return Err(invalid());
    }
    Ok(Box::new(BoundProvider {
        inner: provider,
        identity: expected,
    }))
}
fn matches_known_local_prefix(actual: &Value, expected: &Value) -> bool {
    let Some(cap) = actual.get("tokenCap").filter(|v| !v.is_null()) else {
        return false;
    };
    let parse = |v: &Value| -> Option<Vec<Value>> {
        serde_json::from_str(v["prefixScheme"].as_str()?).ok()
    };
    let Some(mut old) = parse(actual) else {
        return false;
    };
    let Some(new) = parse(expected) else {
        return false;
    };
    if old.len() != 4 || new.len() != 4 || !old[3].is_null() || new[3] != *cap {
        return false;
    }
    old[3] = cap.clone();
    if old != new {
        return false;
    }
    let mut adjusted = actual.clone();
    adjusted["prefixScheme"] = expected["prefixScheme"].clone();
    adjusted == *expected
}
