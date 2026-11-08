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
