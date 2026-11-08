//! Content-free capture diagnostics; exception text never enters the record.
//!
//! Controller CA-R2 permits this logging-only departure from the Node pin at
//! `capture-turn.js:622` and `runtime-scheduler.js:575`; results remain unchanged.

use serde::Serialize;

use crate::contract::{EngineError, HostError};

/// The bounded capture stage that emitted a diagnostic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureLogStage {
    /// The batch failed; the pipeline can try individual embeddings.
    BatchEmbedding,
    /// A worker rejected after the scheduler had reported its timeout.
    LateCaptureSettlement,
    /// A replay state file could not be read or atomically written.
    ReplayState,
    /// Persistent post-turn work could not be read, queued or drained.
    PostTurnQueue,
    /// A capture worker failed before its timeout.
    CaptureWorker,
    /// Neo failed before durable capture continued, as at the pinned boundary.
    NeoCapture,
    /// A capture pipeline item failed independently of other items.
    CapturePipeline,
}

/// Error families selected by typed variants, never provider-supplied names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureErrorClass {
    /// Caller cancellation or deadline expiry.
    Cancelled,
    /// Persistence failure.
    Store,
    /// Embedding provider failure.
    Embedding,
    /// Host callback failure.
    Host,
    /// Memory-operation failure.
    MemoryOperation,
    /// A required capability is unavailable.
    Unavailable,
    /// Caller input failed validation.
    InvalidInput,
}

/// Fixed diagnostic codes; error messages and recovery identifiers are excluded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureErrorCode {
    /// The operation was cancelled.
    Cancelled,
    /// A persistent-store operation failed.
    StoreFailure,
    /// Embedding failed.
    EmbeddingFailure,
    /// Host policy denied the operation.
    Denied,
    /// The host returned an invalid response.
    InvalidResponse,
    /// A host callback failed.
    HostFailure,
    /// A memory operation failed.
    MemoryOperationFailure,
    /// A required capability is absent.
    Unavailable,
    /// Caller input failed validation.
    InvalidInput,
}

/// The complete allowed capture-log payload: no field can carry a free-text body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeCaptureLog {
    /// The emitting capture stage.
    pub stage: CaptureLogStage,
    /// Typed error family.
    pub class: CaptureErrorClass,
    /// A fixed code selected from the typed error variant.
    pub code: CaptureErrorCode,
    /// Number of affected operations or items.
    pub count: u64,
}

impl SafeCaptureLog {
    /// Classify a failure without reading or formatting caller-controlled fields.
    #[must_use]
    pub fn from_error(stage: CaptureLogStage, error: &EngineError, count: u64) -> Self {
        let (class, code) = match error {
            EngineError::Cancelled(_) => {
                (CaptureErrorClass::Cancelled, CaptureErrorCode::Cancelled)
            }
            EngineError::Store(_) => (CaptureErrorClass::Store, CaptureErrorCode::StoreFailure),
            EngineError::Embedding(_) => (
                CaptureErrorClass::Embedding,
                CaptureErrorCode::EmbeddingFailure,
            ),
            EngineError::Host(HostError::Denied) => {
                (CaptureErrorClass::Host, CaptureErrorCode::Denied)
            }
            EngineError::Host(HostError::InvalidResponse) => {
                (CaptureErrorClass::Host, CaptureErrorCode::InvalidResponse)
            }
            EngineError::Host(_) => (CaptureErrorClass::Host, CaptureErrorCode::HostFailure),
            EngineError::MemoryOp(_) => (
                CaptureErrorClass::MemoryOperation,
                CaptureErrorCode::MemoryOperationFailure,
            ),
            EngineError::NotAvailable { .. } => (
                CaptureErrorClass::Unavailable,
                CaptureErrorCode::Unavailable,
            ),
            EngineError::Invalid { .. } => (
                CaptureErrorClass::InvalidInput,
                CaptureErrorCode::InvalidInput,
            ),
        };
        Self {
            stage,
            class,
            code,
            count,
        }
    }
}

/// An engine-local sink for typed capture records, also injectable in failure-path tests.
pub trait CaptureLogSink: Send + Sync {
    /// Deliver exactly the typed record; implementations receive no exception text.
    fn record(&self, entry: SafeCaptureLog);
}

/// Production sink using the engine's existing logging dependency.
#[derive(Default)]
pub struct StandardCaptureLog;

impl CaptureLogSink for StandardCaptureLog {
    fn record(&self, entry: SafeCaptureLog) {
        // Every serialized value is a closed enum or counter (controller CA-R2).
        if let Ok(record) = serde_json::to_string(&entry) {
            log::warn!(target: "plur1bus_engine::capture", "{record}");
        }
    }
}
