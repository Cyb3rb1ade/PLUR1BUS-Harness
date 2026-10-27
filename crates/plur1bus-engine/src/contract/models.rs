//! Model readiness and warm-up operations.

use super::{Cancel, EngineError, ModelsStatus};

/// Readiness of the embedder and reranker used by this engine.
pub trait ModelsService: Send + Sync {
    /// Return the latest readiness state without invoking providers.
    fn status(&self) -> ModelsStatus;
    /// Probe embedder and reranker concurrently, coalescing and memoizing success.
    /// Refresh starts fresh provider probes; cancellation ends this caller's wait.
    fn warm(&self, cancel: &Cancel, refresh: bool) -> Result<ModelsStatus, EngineError>;
}
