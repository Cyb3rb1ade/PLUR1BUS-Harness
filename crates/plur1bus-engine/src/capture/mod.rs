//! Capture admission, scheduling and durable replay protection (RE-05).
//!
//! Provider and store work is composed through the capture worker; public engine
//! contracts remain owned by `contract`, and recall counters remain owned by recall.

/// Non-blocking receipt and capture-pipeline composition.
pub mod accept;
/// Batch-embedding failure boundary with content-free diagnostics.
pub mod batch;
mod cancel_link;
/// New-write trust decisions and legacy injected-context filters.
pub mod epistemic;
/// Restore-safe epistemic upgrade markers and legacy-window boundaries.
pub mod epistemic_cutoff;
/// Reuse of Node-compatible Neo journal records; capture replay uses its own WAL.
pub mod journal;
/// Content-free capture diagnostics (controller CA-R2, 2026-11-01).
pub mod logging;
/// Durable light-dream/episode post-turn work.
pub mod post_turn;
/// Per-agent admission, priorities, pressure and worker settlement.
pub mod queue;
/// Per-agent turn keys, completed turns and pending row plans.
pub mod replay_guard;
/// Node-order result projection without changes to generated contract types.
pub mod result;
/// Fail-closed, acknowledged capture WAL for productive row writers.
pub mod wal;

/// Shared row categorization.
pub mod categorize;
/// Deterministic memory dynamics.
pub mod dynamics;
/// Fact-quality rules shared with import.
pub mod fact_quality;
/// Native schema defaults.
pub mod row_defaults;

/// Pure chunk-decider request/response projection.
pub mod chunk_decider;
/// Node-compatible sentence plans and capture expansion.
pub mod chunking;
/// Native Lance distance duplicate rule.
pub mod dedupe;
/// Exact persisted capture-row projection.
pub mod row_builder;

/// Acceptance-to-Lance capture worker with acknowledged replay boundaries.
pub mod pipeline;
/// Capture adapter for the canonical workspace policy.
pub mod shared_scope;

mod output_unicode;

/// Ordered lexical blend and transition rules.
pub mod emotion_blends;
/// Stateful per-owner emotion tier routing.
pub mod emotion_engine;
mod emotion_json;
/// Ordered legacy emotion columns and compact Lance string projection.
pub mod emotion_legacy;
/// Validated lexical/LLM emotional score with Node-order persistence.
pub mod emotion_score;
/// Curated English/German lexical emotional classification.
pub mod tier1;
/// Deterministic keyword-density second tier; no model is loaded.
pub mod tier2;
/// Caller-owned emotion LLM route and exact messages.
pub mod tier3;

/// Per-owner mood state, decay, restart projection and display.
pub mod emotion_state;
/// Host-bound mood persistence with exact ownership and atomic state replacement.
pub mod emotion_store;
/// Host-only joint importance/emotion encoding and deterministic refinement patches.
pub mod encoding;
/// Caller-bound reminder capture into the actual agent Lance store.
pub mod reminder_store;
/// Deterministic relative-time reminder parsing and capture eligibility.
pub mod reminders;
/// Canonical diarization segments and contextual speaker-name proposals.
pub mod speaker;
/// Authenticated contextual speaker proposals over the existing SQLite mapping table.
pub mod speaker_store;

/// Shared continuity taste gate for capture/recall composition.
pub mod continuity;
