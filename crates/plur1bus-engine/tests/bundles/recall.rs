//! One test executable for the `recall_*` integration tests of the engine.
//!
//! Every file under `tests/` used to be an executable of its own, each linking the whole store stack. The files
//! stay where they are and are mounted here as modules, so a test is now named `<file>::<test>`. A file mounted
//! with `#[path]` resolves its own `mod` and `#[path]` declarations relative to `tests/`, as before.
//!
//! Each file brings its own copy of the support modules it mounts, as it did as an executable of its own.
#![allow(clippy::duplicate_mod)]

#[path = "../recall_acl.rs"]
mod recall_acl;
#[path = "../recall_budget.rs"]
mod recall_budget;
#[path = "../recall_context.rs"]
mod recall_context;
#[path = "../recall_controlled.rs"]
mod recall_controlled;
#[path = "../recall_lens_acl.rs"]
mod recall_lens_acl;
#[path = "../recall_locale.rs"]
mod recall_locale;
#[path = "../recall_maintenance.rs"]
mod recall_maintenance;
#[path = "../recall_namespace_acl.rs"]
mod recall_namespace_acl;
#[path = "../recall_namespace_review.rs"]
mod recall_namespace_review;
#[path = "../recall_namespace_runtime.rs"]
mod recall_namespace_runtime;
#[path = "../recall_namespaces.rs"]
mod recall_namespaces;
#[path = "../recall_query_refiner.rs"]
mod recall_query_refiner;
#[path = "../recall_render.rs"]
mod recall_render;
#[path = "../recall_render_boundaries.rs"]
mod recall_render_boundaries;
#[path = "../recall_rerank.rs"]
mod recall_rerank;
#[path = "../recall_stages.rs"]
mod recall_stages;
#[path = "../recall_stats_render.rs"]
mod recall_stats_render;
#[path = "../recall_tombstone_mask.rs"]
mod recall_tombstone_mask;
