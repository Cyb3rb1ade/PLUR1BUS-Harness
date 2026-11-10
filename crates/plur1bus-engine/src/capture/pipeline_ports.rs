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

/// A prepared reminder effect retained until the complete capture finishes.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReminderEffect {
    /// Exact original target; replay never allocates another reminder ID.
    pub row: MemoryRow,
    /// Whether this capture may insert the target if it is still absent.
    pub create: bool,
}

/// Durable, caller-bound effect receipts owned by one capture admission.
/// This internal native port does not alter the engine contract or RPC surface.
pub trait CapturePostStore {
    /// Frozen reference for relative reminder times across process restarts.
    fn reference_time(&self) -> i64;
    /// Read the exact previously prepared selected-message effect.
    fn reminder(&self, position: usize) -> Option<ReminderEffect>;
    /// Save before any reminder write. A failed save forbids the effect.
    fn plan_reminder(
        &mut self,
        position: usize,
        effect: ReminderEffect,
        cancel: &Cancel,
    ) -> Result<(), EngineError>;
    /// Recheck original caller authority and the held durable admission.
    fn check(&self, cancel: &Cancel) -> Result<(), EngineError>;
}

/// RE-05/T3 classification and post-store effects on the actual capture path.
pub trait CaptureClassifier: Send + Sync {
    /// Classify one prepared item before its Lance commit; errors leave only that item incomplete.
    fn classify(
        &self,
        request: ClassificationRequest<'_>,
    ) -> Result<CaptureClassification, EngineError>;

    /// Durable replay-aware post-store boundary. Unknown effect implementations refuse
    /// re-entry after a crash rather than pretending their side effects are idempotent.
    fn post_store_recoverable(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        rows: &[MemoryRow],
        _journal: &mut dyn CapturePostStore,
        resuming: bool,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if resuming {
            return Err(EngineError::NotAvailable {
                reason: "capture-post-store-recovery-unavailable".into(),
            });
        }
        self.post_store(turn, context, rows, cancel)
    }

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

    /// Re-enter only a hook whose implementation provides durable/idempotent post-store recovery.
    fn post_store_recoverable(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        resuming: bool,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        if resuming {
            return Err(EngineError::NotAvailable {
                reason: "neo-post-store-recovery-unavailable".into(),
            });
        }
        self.post_store(turn, context, options, cancel)
    }

    /// Optional queue maintenance after capture's primary work, including early-return paths.
    /// Called only after successful Neo recording; failures cannot undo already stored rows.
    fn after_capture(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _cancel: &Cancel,
    ) -> Result<(), EngineError> {
        Ok(())
    }

    /// Classify prepared plans by owner binding (RE-D162): directory entries and plan files
    /// only, no host callback, no waiting for a lease.
    fn inventory(&self, _cancel: &Cancel) -> Result<(), EngineError> {
        Ok(())
    }

    /// Whether an owner binding's prepared plans wait or are being recovered.
    fn has_retained(&self) -> bool {
        false
    }

    /// One pass over the waiting bindings, one after the other, each under its own budget;
    /// `shutdown` ends it.
    fn recover_retained(&self, _shutdown: &Cancel) {}

    /// Before a turn: join the recovery of this caller's own binding, or start it. It waits
    /// for no other binding and never fails the turn.
    fn recover_owner(
        &self,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _cancel: &Cancel,
        _shutdown: &Cancel,
    ) {
    }

    /// Start no further attempt and wait within `budget` for those in flight.
    fn close_retained(&self, _budget: std::time::Duration) -> bool {
        true
    }
}
