//! One test executable for the `jobs_*` integration tests of the engine.
//!
//! Every file under `tests/` used to be an executable of its own, each linking the whole store stack. The files
//! stay where they are and are mounted here as modules, so a test is now named `<file>::<test>`. A file mounted
//! with `#[path]` resolves its own `mod` and `#[path]` declarations relative to `tests/`, as before.
//!
//! Each file brings its own copy of the support modules it mounts, as it did as an executable of its own.
#![allow(clippy::duplicate_mod)]

#[path = "../job_prompts.rs"]
mod job_prompts;
#[path = "../jobs_catalog.rs"]
mod jobs_catalog;
#[path = "../jobs_ledger.rs"]
mod jobs_ledger;
#[path = "../jobs_maintenance_gate.rs"]
mod jobs_maintenance_gate;
#[path = "../jobs_metadata.rs"]
mod jobs_metadata;
#[path = "../jobs_migration.rs"]
mod jobs_migration;
#[path = "../jobs_migration_store.rs"]
mod jobs_migration_store;
#[path = "../jobs_notes.rs"]
mod jobs_notes;
#[path = "../jobs_outcome.rs"]
mod jobs_outcome;
#[path = "../jobs_rate_limit.rs"]
mod jobs_rate_limit;
#[path = "../jobs_rate_limit_store.rs"]
mod jobs_rate_limit_store;
#[path = "../jobs_recovery.rs"]
mod jobs_recovery;
#[path = "../jobs_registry.rs"]
mod jobs_registry;
