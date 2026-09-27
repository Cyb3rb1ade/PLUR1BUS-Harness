//! D14 module registry: the `module.json` manifest (schema, reserved names, API-version policy B12)
//! and the dependency graph with its start order. Consumed by the supervisor (Task 9) and the
//! `module` commands (Task 10); nothing calls it yet.
#![allow(dead_code)]
pub mod graph;
pub mod manifest;
#[allow(unused_imports)]
pub use graph::{band, graph, start_order, Graph};
#[allow(unused_imports)]
pub use manifest::{
    api_version_supported, current_api_version, parse_manifest, scan, Installed, Manifest,
    CORE_PROVIDES, MODULE_API_VERSION, RESERVED_NAMES,
};
