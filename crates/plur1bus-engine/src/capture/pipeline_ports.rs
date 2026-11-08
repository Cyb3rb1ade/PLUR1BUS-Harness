//! Internal capture dependencies; none changes the public engine contract.

use crate::context::RequestContext;
use crate::contract::{Cancel, CaptureOptions, EngineError, MemoryRow, TurnRecord};
use crate::text::js::JsString;

use super::chunking::StorageDecision;

/// Dynamics produced by classification, without caller identity, provenance or row ids.
#[derive(Clone, Debug)]
pub struct CaptureDynamics {
    /// Initial strength after encoding.
    pub memory_strength: f64,
    /// Encoded half-life in days.
    pub half_life_days: f64,
    /// Last encoding/strengthening timestamp, or zero.
    pub last_strengthened_at: f64,
    /// Encoding timestamp used as the future decay origin.
    pub last_dynamics_at: f64,
    /// Standard, flashbulb or core class selected by the Node encoding rules.
    pub memory_class: String,
    /// Node's numeric persistent never-forget marker.
    pub never_forget: f64,
    /// Core encoding score.
    pub core_memory_score: f64,
    /// Encoding explanation, persisted in the row and never logged.
    pub core_memory_reason: String,
}

/// Only the classification fields that RE-05/T3 supplies to row construction.
#[derive(Clone, Debug)]
pub struct CaptureClassification {
    /// Deterministic category chosen for the prepared text.
    pub category: String,
    /// Node's compact serialized emotion object.
    pub emotional_valence: String,
    /// Classified emotional intensity.
    pub emotional_intensity: f64,
    /// Classified dominant emotion.
    pub emotional_dominant: String,
    /// Serialized mood snapshot at capture time.
    pub mood_context_at_capture: String,
    /// `final` or the pinned deferred classification status.
    pub emotion_status: String,
    /// Initial memory-dynamics values.
    pub dynamics: CaptureDynamics,
}

/// One prepared capture item plus its original caller authority.
/// This is an internal native port, separate from frozen Engine/HostServices contracts.
pub struct ClassificationRequest<'a> {
    /// Prepared text after summary/chunking.
    pub text: &'a JsString,
    /// Original message role.
    pub role: &'a str,
    /// Actual accepted turn carrying Principal and AgentContext.
    pub turn: &'a TurnRecord,
    /// Capture's already resolved context, rechecked by sensitive dependencies.
    pub context: &'a RequestContext,
    /// Captured row timestamp.
    pub now: i64,
    /// Effective caller cancellation.
    pub cancel: &'a Cancel,
}

/// RE-05/T3 classification and post-store effects on the actual capture path.
pub trait CaptureClassifier: Send + Sync {
    /// Classify one prepared item before its Lance commit; errors leave only that item incomplete.
    fn classify(
        &self,
        request: ClassificationRequest<'_>,
    ) -> Result<CaptureClassification, EngineError>;

    /// Best-effort speaker/reminder/emotional-state work after replay settlement.
    /// A failure cannot make an already committed capture run twice on host replay.
    fn post_store(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _rows: &[MemoryRow],
        _cancel: &Cancel,
    ) -> Result<(), EngineError>;
}

/// The optional configured `capture-summary` LLM route.
pub trait CaptureSummary: Send + Sync {
    /// Summarize a long message with the existing host LLM and the effective caller cancellation.
    fn summarize(
        &self,
        text: &JsString,
        max_chars: usize,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<JsString, EngineError>;
}

/// The optional per-message Jev decider, called only for a deterministic splittable plan.
pub trait CaptureChunkDecider: Send + Sync {
    /// Return the normalized storage decision; callers use both on any failure.
    fn decide(
        &self,
        text: &JsString,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<StorageDecision, EngineError>;
}

/// RE-05/T5 working-memory work at the real pre-store and post-store capture boundaries.
pub trait NeoCaptureHook: Send + Sync {
    /// Record the turn before durable capture when Neo is enabled; capture continues on failure.
    fn record_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) -> Result<(), EngineError>;

    /// Run post-turn journal/watermark work even when the optional Neo pre-store hook is disabled.
    fn post_store(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _options: &CaptureOptions,
        _cancel: &Cancel,
    ) -> Result<(), EngineError>;
}
