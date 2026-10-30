//! Deterministic configured-width embeddings for host-authorized test seams.

use super::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

/// A unit vector in the configured space, with an optional serialized cold start.
pub struct FlatEmbedder {
    identity: VectorSpaceIdentity,
    width: usize,
    cold: bool,
    cold_calls: AtomicUsize,
    serial: Mutex<()>,
}

impl FlatEmbedder {
    /// Create an e0 provider; the first two cold query calls each wait 350 ms.
    pub fn new(width: usize, cold: bool) -> Self {
        Self {
            identity: VectorSpaceIdentity {
                artifacts: None,
                dimension: width.into(),
                dtype: "fp32".into(),
                instruction: String::new(),
                model: "flat-embedder".into(),
                normalization: "l2".into(),
                pooling: None,
                prefix_scheme: "none".into(),
                provider: "fixture".into(),
                revision: "1".into(),
                token_cap: None,
            },
            width,
            cold,
            cold_calls: AtomicUsize::new(0),
            serial: Mutex::new(()),
        }
    }

    /// Explicitly bind the test seam to a canonical configured vector space of the same width.
    pub fn bind_identity(mut self, identity: &VectorSpaceIdentity) -> Result<Self, EmbedError> {
        let (canonical, _, _) = crate::store::identity::canonical_identity(identity)
            .map_err(|_| EmbedError::InvalidVector)?;
        let width = canonical
            .dimension
            .as_u64()
            .and_then(|width| usize::try_from(width).ok())
            .ok_or(EmbedError::InvalidVector)?;
        if width != self.width {
            return Err(EmbedError::DimensionMismatch {
                expected: self.width,
                actual: width,
            });
        }
        self.identity = canonical;
        Ok(self)
    }

    fn cold_delay(&self, cancel: &Cancel) -> Result<(), EmbedError> {
        if !self.cold || self.cold_calls.fetch_add(1, Ordering::AcqRel) >= 2 {
            return Ok(());
        }
        let _serial = loop {
            cancel.check().map_err(EmbedError::Cancelled)?;
            match self.serial.try_lock() {
                Ok(lock) => break lock,
                Err(std::sync::TryLockError::Poisoned(error)) => break error.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(2))
                }
            }
        };
        let until = Instant::now() + Duration::from_millis(350);
        while Instant::now() < until {
            cancel.check().map_err(EmbedError::Cancelled)?;
            std::thread::sleep(
                until
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(5)),
            );
        }
        cancel.check().map_err(EmbedError::Cancelled)
    }
}

impl EmbeddingProvider for FlatEmbedder {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }

    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        if self.width == 0 {
            return Err(EmbedError::InvalidVector);
        }
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if kind == EmbedKind::Query {
            self.cold_delay(cancel)?;
        }
        let mut vector = vec![0.0; self.width];
        vector[0] = 1.0;
        Ok(vec![vector; texts.len()])
    }
}
