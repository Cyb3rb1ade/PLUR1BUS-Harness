//! Process-local handles whose receivers and callbacks are intentionally not serialized.

use std::sync::mpsc::Receiver;

use super::{AgentId, CaptureResult, EngineError, EngineEvent};

/// A receiver for typed events published by one engine subscription.
pub type EventReceiver = Receiver<EngineEvent>;

/// A non-blocking capture receipt and its background completion channel.
pub struct CaptureHandle {
    /// Stable id of the accepted capture.
    pub id: String,
    /// Host-clock time at which the capture was accepted, in epoch milliseconds.
    pub accepted_at: i64,
    /// Receives the completed capture's counters and reason codes.
    pub done: Receiver<CaptureResult>,
    /// Ask the background work to stop, with an optional caller-supplied reason.
    pub abort: Box<dyn Fn(Option<String>) + Send + Sync>,
}

/// A lifetime handle for an opened agent store.
pub struct AgentStoreHandle {
    /// The agent whose store was opened.
    pub agent_id: AgentId,
    /// Close this handle's resources; repeated calls must be idempotent.
    pub close: Box<dyn Fn() -> Result<(), EngineError> + Send + Sync>,
}
