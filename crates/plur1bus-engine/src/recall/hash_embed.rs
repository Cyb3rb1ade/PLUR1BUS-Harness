//! Deterministic hash embedder for recall goldens.
//!
//! The brief names this `embedding::seam::HashEmbedder`. That module belongs to the
//! embedding workstream, so the same algorithm lives here. It does not sleep.

use sha2::{Digest, Sha256};

use crate::embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity};

/// Width of every vector this provider returns. The recall fixtures use the same width.
pub const HASH_DIMENSION: usize = 384;

/// Counter-mode expansion of `sha256(utf-8 text)` into a unit vector.
///
/// Each block is `sha256(seed || counter_be_u16)`. The first four bytes of a block are a
/// big-endian `u32`, mapped with `((u + 0.5) / 2^32) * 2 - 1` into `(-1, 1)`. The result is
/// L2-normalised. The Node recorder copies this byte for byte.
#[must_use]
pub fn hash_unit(text: &str) -> Vec<f64> {
    let seed = Sha256::digest(text.as_bytes());
    let mut values = Vec::with_capacity(HASH_DIMENSION);
    let mut counter: u16 = 0;
    while values.len() < HASH_DIMENSION {
        let mut hasher = Sha256::new();
        hasher.update(seed);
        hasher.update(counter.to_be_bytes());
        let digest = hasher.finalize();
        let mut offset = 0;
        while offset + 4 <= digest.len() && values.len() < HASH_DIMENSION {
            let unit = u32::from_be_bytes([
                digest[offset],
                digest[offset + 1],
                digest[offset + 2],
                digest[offset + 3],
            ]);
            let mapped = ((f64::from(unit) + 0.5) / 4_294_967_296.0) * 2.0 - 1.0;
            values.push(mapped);
            offset += 4;
        }
        counter = counter.wrapping_add(1);
    }
    l2_normalize(&values)
}

/// L2-normalise `values`. A zero vector is returned unchanged, matching the recorder.
#[must_use]
pub fn l2_normalize(values: &[f64]) -> Vec<f64> {
    let norm = values.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm == 0.0 {
        return values.to_vec();
    }
    values.iter().map(|value| value / norm).collect()
}

/// Narrow a hash vector to the `f32` values Lance stores.
#[must_use]
pub fn to_f32(values: &[f64]) -> Vec<f32> {
    values.iter().map(|value| *value as f32).collect()
}

/// Cosine of two equal-length vectors. A length mismatch or a zero norm returns 0.
#[must_use]
pub fn cosine_similarity(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for (left, right) in left.iter().zip(right) {
        let left = f64::from(*left);
        let right = f64::from(*right);
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    let denom = left_norm.sqrt() * right_norm.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// Hash embedder. Query and passage embeddings are the same hash of the text.
pub struct HashEmbedder {
    identity: VectorSpaceIdentity,
}

impl HashEmbedder {
    /// Build the fixture identity at [`HASH_DIMENSION`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            identity: VectorSpaceIdentity {
                artifacts: None,
                dimension: HASH_DIMENSION.into(),
                dtype: "fp32".into(),
                instruction: String::new(),
                model: "hash-embedder".into(),
                normalization: "l2".into(),
                pooling: None,
                prefix_scheme: "none".into(),
                provider: "fixture".into(),
                revision: "1".into(),
                token_cap: None,
            },
        }
    }
}

impl Default for HashEmbedder {
    fn default() -> Self {
        Self::new()
    }
}

impl EmbeddingProvider for HashEmbedder {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }

    fn embed(
        &self,
        texts: &[String],
        _kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        Ok(texts.iter().map(|text| to_f32(&hash_unit(text))).collect())
    }
}
