//! One test executable for the `store_*` integration tests of the engine.
//!
//! Every file under `tests/` used to be an executable of its own, each linking the whole store stack. The files
//! stay where they are and are mounted here as modules, so a test is now named `<file>::<test>`. A file mounted
//! with `#[path]` resolves its own `mod` and `#[path]` declarations relative to `tests/`, as before.
//!
//! Each file brings its own copy of the support modules it mounts, as it did as an executable of its own.
#![allow(clippy::duplicate_mod)]

#[path = "../store_checkpoint.rs"]
mod store_checkpoint;
#[path = "../store_directory.rs"]
mod store_directory;
#[path = "../store_fresh_base_marker.rs"]
mod store_fresh_base_marker;
#[path = "../store_identity.rs"]
mod store_identity;
#[path = "../store_ledger_shapes.rs"]
mod store_ledger_shapes;
#[path = "../store_locks.rs"]
mod store_locks;
#[path = "../store_neo.rs"]
mod store_neo;
#[path = "../store_neo_locks.rs"]
mod store_neo_locks;
#[path = "../store_paths.rs"]
mod store_paths;
#[path = "../store_pool.rs"]
mod store_pool;
#[path = "../store_recall_stats.rs"]
mod store_recall_stats;
#[path = "../store_roundtrip.rs"]
mod store_roundtrip;
#[path = "../store_sqlite.rs"]
mod store_sqlite;
#[path = "../store_tombstone.rs"]
mod store_tombstone;
