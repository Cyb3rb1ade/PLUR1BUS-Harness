//! One test executable for the `capture_*` integration tests of the engine.
//!
//! Every file under `tests/` used to be an executable of its own, each linking the whole store stack. The files
//! stay where they are and are mounted here as modules, so a test is now named `<file>::<test>`. A file mounted
//! with `#[path]` resolves its own `mod` and `#[path]` declarations relative to `tests/`, as before.
//!
//! Each file brings its own copy of the support modules it mounts, as it did as an executable of its own.
#![allow(clippy::duplicate_mod)]

#[path = "../capture_accept.rs"]
mod capture_accept;
#[path = "../capture_classifier.rs"]
mod capture_classifier;
#[path = "../capture_conflict_resolution.rs"]
mod capture_conflict_resolution;
#[path = "../capture_continuity.rs"]
mod capture_continuity;
#[path = "../capture_contract.rs"]
mod capture_contract;
#[path = "../capture_contradictions.rs"]
mod capture_contradictions;
#[path = "../capture_critical.rs"]
mod capture_critical;
#[path = "../capture_deferred_dynamics.rs"]
mod capture_deferred_dynamics;
#[path = "../capture_durable_merge.rs"]
mod capture_durable_merge;
#[path = "../capture_dynamics.rs"]
mod capture_dynamics;
#[path = "../capture_emotion.rs"]
mod capture_emotion;
#[path = "../capture_emotion_store.rs"]
mod capture_emotion_store;
#[path = "../capture_encoding.rs"]
mod capture_encoding;
#[path = "../capture_epistemic.rs"]
mod capture_epistemic;
#[path = "../capture_fragment_compactor.rs"]
mod capture_fragment_compactor;
#[path = "../capture_history.rs"]
mod capture_history;
#[path = "../capture_interference.rs"]
mod capture_interference;
#[path = "../capture_knowledge_pending.rs"]
mod capture_knowledge_pending;
#[path = "../capture_logging.rs"]
mod capture_logging;
#[path = "../capture_merge_decision.rs"]
mod capture_merge_decision;
#[path = "../capture_merge_safety.rs"]
mod capture_merge_safety;
#[path = "../capture_normal_candidates.rs"]
mod capture_normal_candidates;
#[path = "../capture_normal_effects.rs"]
mod capture_normal_effects;
#[path = "../capture_normal_new.rs"]
mod capture_normal_new;
#[path = "../capture_normal_store.rs"]
mod capture_normal_store;
#[path = "../capture_pipeline.rs"]
mod capture_pipeline;
#[path = "../capture_quality.rs"]
mod capture_quality;
#[path = "../capture_queue.rs"]
mod capture_queue;
#[path = "../capture_queue_isolation.rs"]
mod capture_queue_isolation;
#[path = "../capture_recovery.rs"]
mod capture_recovery;
#[path = "../capture_reminder_store.rs"]
mod capture_reminder_store;
#[path = "../capture_reminders.rs"]
mod capture_reminders;
#[path = "../capture_replay.rs"]
mod capture_replay;
#[path = "../capture_rows.rs"]
mod capture_rows;
#[path = "../capture_safe_update.rs"]
mod capture_safe_update;
#[path = "../capture_speaker.rs"]
mod capture_speaker;
#[path = "../capture_wal.rs"]
mod capture_wal;
