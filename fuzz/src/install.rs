//! The real `install/{targets,pins,manifest}.rs` of the `plur1bus` binary crate, included by path and unmodified.
#![allow(dead_code, clippy::all)]

#[path = "../../crates/plur1bus/src/install/targets.rs"]
pub mod targets;

#[path = "../../crates/plur1bus/src/install/pins.rs"]
pub mod pins;

#[path = "../../crates/plur1bus/src/install/manifest.rs"]
pub mod manifest;
