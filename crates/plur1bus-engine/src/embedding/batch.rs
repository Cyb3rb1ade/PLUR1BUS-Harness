//! Validation shared by service batches and provider probes.

use super::EmbedError;

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
