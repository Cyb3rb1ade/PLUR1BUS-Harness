//! Validation shared by service batches and provider probes.

use super::{Cancel, EmbedError, EmbedKind, EmbeddingProvider};
use crate::contract::EngineError;

/// Reject cardinality, non-finite values and wrong vector widths before caching.
pub fn validate_vectors(
    vectors: &[Vec<f32>],
    count: usize,
    width: usize,
) -> Result<(), EmbedError> {
    if vectors.len() != count {
        return Err(EmbedError::InvalidVector);
    }
    for vector in vectors {
        if vector.iter().any(|value| !value.is_finite()) {
            return Err(EmbedError::InvalidVector);
        }
        if vector.len() != width {
            return Err(EmbedError::DimensionMismatch {
                expected: width,
                actual: vector.len(),
            });
        }
        if vector.is_empty() {
            return Err(EmbedError::InvalidVector);
        }
    }
    Ok(())
}

/// Embed and validate an uncached batch on the already-selected provider.
pub(super) fn embed_checked(
    provider: &dyn EmbeddingProvider,
    texts: &[String],
    kind: EmbedKind,
    width: usize,
    cancel: &Cancel,
) -> Result<Vec<Vec<f32>>, EngineError> {
    cancel.check()?;
    let result = provider.embed(texts, kind, cancel)?;
    validate_vectors(&result, texts.len(), width)?;
    cancel.check()?;
    Ok(result)
}
