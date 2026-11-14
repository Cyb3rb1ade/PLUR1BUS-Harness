//! Engine-process composition, authenticated IPC, lifecycle and reverse host services.

pub mod config;
pub mod diagnostics;
pub mod engine;
pub mod host_client;
pub mod layout;
pub mod lifeline;
pub mod maintenance;
mod methods;
pub mod platform;
#[cfg(test)]
mod roundtrip;
pub mod seams;
pub mod server;
mod signals;
pub mod snapshot;

mod tokens;
