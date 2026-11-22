//! ADR-009 store records and transition inputs.

use plur1bus_store::rusqlite;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

macro_rules! wire_enum {
    ($(#[$note:meta])* $name:ident { $($(#[$doc:meta])* $variant:ident : $wire:literal),+ $(,)? }) => {
        $(#[$note])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
        pub enum $name {
            $($(#[$doc])* #[serde(rename = $wire)] $variant),+
        }

        impl $name {
            /// The durable name used by the dreaming database.
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }

            pub(super) fn from_column(row: &rusqlite::Row<'_>, column: &str) -> rusqlite::Result<Self> {
                let raw: String = row.get(column)?;
                match raw.as_str() {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(rusqlite::Error::InvalidQuery),
                }
            }
        }
    };
}

wire_enum! {
    /// A scheduled dreaming phase.
    Phase {
        /// Lightweight maintenance.
        Light: "light",
        /// Association and link discovery.
        Rem: "rem",
        /// Consolidation and cleanup.
        Deep: "deep",
    }
}

impl Phase {
    /// Chronological order used for schedules that are due at the same time.
    pub const ALL: [Self; 3] = [Self::Light, Self::Rem, Self::Deep];
}

wire_enum! {
    /// How a run was requested.
    Trigger {
        /// Scheduled floor.
        Cron: "cron",
        /// Capture importance crossed the threshold.
        Importance: "importance",
        /// Explicit human request.
        Manual: "manual",
        /// Bounded retry of a missed or interrupted window.
        Catchup: "catchup",
    }
}

wire_enum! {
    /// Terminal disposition of a dreaming run.
    Outcome {
        /// The run completed and retains the key.
        Completed: "completed",
        /// A gate refused the run.
        Skipped: "skipped",
        /// A step failed.
        Failed: "failed",
        /// The run was interrupted.
        Aborted: "aborted",
    }
}

wire_enum! {
    /// Circuit-breaker state.
    Breaker {
        /// Scheduling may proceed.
        Closed: "closed",
        /// Scheduling is fenced until the breaker resets.
        Open: "open",
    }
}

wire_enum! {
    /// State of an agent's candidate.
    CandidateState {
        /// Still eligible for evaluation.
        Shortlisted: "shortlisted",
        /// Promotion confirmed by the engine-side port.
        Promoted: "promoted",
        /// The promotion gate refused the candidate.
        Rejected: "rejected",
        /// Outside the freshness window.
        Expired: "expired",
    }
}

/// Values that a new schedule can set.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSeed {
    /// Agent receiving the schedule.
    pub agent_id: String,
    /// Dreaming phase.
    pub phase: Phase,
    /// Five-part cron expression.
    pub cron: String,
    /// IANA zone.
    pub timezone: String,
    /// Whether the schedule is enabled.
    pub enabled: bool,
    /// Stable deterministic offset in seconds.
    pub stagger_offset_s: i64,
    /// Next stored deadline.
    pub next_run_at: Option<i64>,
}

/// Schedule plus its persisted signals and breaker.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// Current editable schedule and deadline.
    #[serde(flatten)]
    pub seed: ScheduleSeed,
    /// Last run associated with this schedule.
    pub last_run_id: Option<String>,
    /// Circuit-breaker state.
    pub breaker_state: Breaker,
    /// When the breaker may close again.
    pub breaker_until: Option<i64>,
    /// Reason the breaker opened, if set.
    pub breaker_reason: Option<String>,
    /// Summed importance since a run last consumed the corpus.
    pub importance_acc: f64,
    /// Captures since a run last consumed the corpus.
    pub captures_acc: i64,
    /// Monotonic capture count for the content identity.
    pub capture_seq: i64,
    /// Last observed capture time.
    pub last_capture_at: Option<i64>,
}

/// Typed subset of the schedule that may change.
#[derive(Default)]
pub struct SchedulePatch {
    /// Optional new cron.
    pub cron: Option<String>,
    /// Optional new zone.
    pub timezone: Option<String>,
    /// Optional new enablement.
    pub enabled: Option<bool>,
    /// Optional new stagger.
    pub stagger_offset_s: Option<i64>,
    /// Set or clear the next deadline on Some.
    pub next_run_at: Option<Option<i64>>,
    /// Set or clear the last run on Some.
    pub last_run_id: Option<Option<String>>,
    /// Optional new breaker state.
    pub breaker_state: Option<Breaker>,
    /// Set or clear the breaker deadline on Some.
    pub breaker_until: Option<Option<i64>>,
    /// Set or clear the breaker reason on Some.
    pub breaker_reason: Option<Option<String>>,
    /// Optional reset or update of accumulated importance.
    pub importance_acc: Option<f64>,
    /// Optional reset or update of accumulated capture count.
    pub captures_acc: Option<i64>,
}

/// The ledger identity and initial metadata for a run.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRun {
    /// The opaque identifier of this attempt.
    pub run_id: String,
    /// Agent receiving the run.
    pub agent_id: String,
    /// Phase that selected jobs.
    pub phase: Phase,
    /// Primary job name.
    pub job_id: String,
    /// Optional authorized memory partition.
    pub partition: Option<String>,
    /// Stable key of the intended effect.
    pub idempotency_key: String,
    /// Origin of the work.
    pub trigger: Trigger,
    /// Scheduled deadline, if present.
    pub scheduled_for: Option<i64>,
    /// Clock time when the row opened.
    pub started_at: i64,
    /// Log reference owned by the host.
    pub log_path: Option<String>,
}

/// Counts attached to a closed run, with forward-compatible counter names.
pub type RunCounts = BTreeMap<String, f64>;

/// Redacted run failure details.
#[derive(Debug, Deserialize, Serialize)]
pub struct RunFailure {
    /// Redacted message from the responsible port.
    pub message: String,
    /// Optional failure category.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Terminal result of one run.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRun {
    /// Terminal disposition.
    pub outcome: Option<Outcome>,
    /// Known skip, failure or interruption reason.
    pub reason: Option<String>,
    /// When the run finished.
    pub finished_at: Option<i64>,
    /// Counters observed by the runner.
    pub counts: RunCounts,
    /// Input usage if measured.
    pub tokens_in: Option<i64>,
    /// Output usage if measured.
    pub tokens_out: Option<i64>,
    /// Redacted failure detail, if present.
    pub error: Option<RunFailure>,
}

/// A persisted run. Open runs have an empty terminal outcome.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamRun {
    /// Initial metadata with the canonical key, excluding any storage suffix.
    #[serde(flatten)]
    pub open: NewRun,
    /// Whether the row holds its deduplication key.
    pub claimed: bool,
    /// Terminal data, also present as null fields while open.
    #[serde(flatten)]
    pub result: FinishRun,
}

/// Optional constraints on a recent run query.
#[derive(Default)]
pub struct RunQuery<'a> {
    /// Filter by agent.
    pub agent_id: Option<&'a str>,
    /// Filter by phase.
    pub phase: Option<Phase>,
    /// Inclusive start instant.
    pub since: Option<i64>,
    /// Default maximum when absent is 50.
    pub limit: Option<u32>,
}

/// Logs retired by an atomic retention update.
#[derive(Serialize)]
pub struct Retention {
    /// Number of closed rows deleted.
    pub deleted: usize,
    /// Host-owned log references that may now be removed.
    pub logs: Vec<String>,
}

/// Current measurement for a shortlisted candidate.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSignals {
    /// Measured recalls.
    pub recalls: i64,
    /// Measured distinct queries.
    pub unique_queries: i64,
    /// Optional score.
    pub score: Option<f64>,
}

/// Durable candidate metadata and utility evidence.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSeed {
    /// Candidate identifier.
    pub candidate_id: String,
    /// Owning agent.
    pub agent_id: String,
    /// Authorized partition.
    pub partition: String,
    /// Normalized content hash.
    pub content_hash: String,
    /// Run that shortlisted this item.
    pub source_run_id: String,
    /// First observed time.
    pub first_seen_at: i64,
    /// End of the allowed age window.
    pub expires_at: i64,
    /// Last measured utility.
    #[serde(flatten)]
    pub signals: CandidateSignals,
}

/// Persisted candidate plus its disposition.
#[derive(Debug, Deserialize, Serialize)]
pub struct CandidateRow {
    /// Candidate metadata and evidence.
    #[serde(flatten)]
    pub seed: CandidateSeed,
    /// Current disposition.
    pub state: CandidateState,
    /// Decision evidence, or null before evaluation.
    pub decision: Value,
}
