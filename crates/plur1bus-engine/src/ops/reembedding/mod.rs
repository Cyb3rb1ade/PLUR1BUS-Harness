//! Reembedding migration components; the F7 coordinator owns maintenance authority.
pub mod backend;
pub mod confirmation;
pub mod coordinator;
pub mod coordinator_ports;
pub mod planner;
pub mod projection;
pub mod runtime;
pub mod state;
mod state_json;
/// The library's migration ID grammar, for audit envelopes outside the coordinator (RE-D166).
pub(crate) use state_json::id_valid;
pub mod validation;

// Private host mechanics. The process coordinator reuses the selection and reverse-plan projections.
#[allow(
    dead_code,
    reason = "the direct config mutation and recovery require a privileged host implementation"
)]
mod switch;

#[allow(
    dead_code,
    reason = "post-activation probe is private until RX8 host composition"
)]
mod runtime_probe;
