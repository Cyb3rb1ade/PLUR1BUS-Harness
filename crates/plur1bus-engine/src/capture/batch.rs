//! The capture batch-embedding boundary; fallback callers retain the original failure.

use crate::contract::EngineError;

use super::logging::{CaptureLogSink, CaptureLogStage, SafeCaptureLog};

/// Execute one provider batch, preserving its result for the individual fallback.
/// The diagnostic never receives input text or provider response bodies (CA-R2).
pub fn run_batch<T>(
    log: &dyn CaptureLogSink,
    count: u64,
    work: impl FnOnce() -> Result<T, EngineError>,
) -> Result<T, EngineError> {
    let result = work();
    if let Err(error) = &result {
        log.record(SafeCaptureLog::from_error(
            CaptureLogStage::BatchEmbedding,
            error,
            count,
        ));
    }
    result
}
