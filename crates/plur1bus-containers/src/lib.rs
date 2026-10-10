//! Container distribution ports. No CLI, installer or update orchestration is wired here.
mod apple;
mod docker;
mod install;
mod model;
mod process;
mod registry;
mod sidecar;
mod stack;
pub use apple::*;
pub use docker::*;
pub use install::*;
pub use model::*;
pub use process::LogStream;
pub use sidecar::*;
pub use stack::*;
pub type Result<T> = std::result::Result<T, String>;
