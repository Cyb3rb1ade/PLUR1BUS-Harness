//! One test executable for the `ops_*` integration tests of the engine.
//!
//! Every file under `tests/` used to be an executable of its own, each linking the whole store stack. The files
//! stay where they are and are mounted here as modules, so a test is now named `<file>::<test>`. A file mounted
//! with `#[path]` resolves its own `mod` and `#[path]` declarations relative to `tests/`, as before.
//!
//! Each file brings its own copy of the support modules it mounts, as it did as an executable of its own.
#![allow(clippy::duplicate_mod)]

#[path = "../ops_adopt.rs"]
mod ops_adopt;
#[path = "../ops_conflicts.rs"]
mod ops_conflicts;
#[path = "../ops_correct.rs"]
mod ops_correct;
#[path = "../ops_curation.rs"]
mod ops_curation;
#[path = "../ops_curation_store.rs"]
mod ops_curation_store;
#[path = "../ops_durable_merge.rs"]
mod ops_durable_merge;
#[path = "../ops_forget.rs"]
mod ops_forget;
#[path = "../ops_import.rs"]
mod ops_import;
#[path = "../ops_import_lock.rs"]
mod ops_import_lock;
#[path = "../ops_import_primitives.rs"]
mod ops_import_primitives;
#[path = "../ops_interference.rs"]
mod ops_interference;
#[path = "../ops_link.rs"]
mod ops_link;
#[path = "../ops_memory.rs"]
mod ops_memory;
#[path = "../ops_memory_guards.rs"]
mod ops_memory_guards;
#[path = "../ops_memory_stats.rs"]
mod ops_memory_stats;
#[path = "../ops_models.rs"]
mod ops_models;
#[path = "../ops_normal_merge.rs"]
mod ops_normal_merge;
#[path = "../ops_private_routes.rs"]
mod ops_private_routes;
#[path = "../ops_promotion_plan.rs"]
mod ops_promotion_plan;
#[path = "../ops_rebind.rs"]
mod ops_rebind;
#[path = "../ops_rebind_ledger.rs"]
mod ops_rebind_ledger;
#[path = "../ops_shared_routes.rs"]
mod ops_shared_routes;
#[path = "../ops_shared_store.rs"]
mod ops_shared_store;
#[path = "../ops_shares.rs"]
mod ops_shares;
#[path = "../ops_snapshot_verify.rs"]
mod ops_snapshot_verify;
#[path = "../ops_state.rs"]
mod ops_state;
#[path = "../ops_status.rs"]
mod ops_status;
#[path = "../ops_tombstone_crash.rs"]
mod ops_tombstone_crash;
#[path = "../ops_tombstone_reapply.rs"]
mod ops_tombstone_reapply;
#[path = "../ops_tombstones.rs"]
mod ops_tombstones;
#[path = "../ops_unimport.rs"]
mod ops_unimport;
#[path = "../ops_unimport_ledger.rs"]
mod ops_unimport_ledger;
#[path = "../ops_workspace_policy.rs"]
mod ops_workspace_policy;
#[path = "../ops_workspace_policy_native.rs"]
mod ops_workspace_policy_native;
