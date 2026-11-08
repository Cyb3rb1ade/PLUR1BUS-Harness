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
pub mod validation;

// Private host mechanics only; RX8 supplies the authorized Core composition. F7 is unchanged.
#[allow(
    dead_code,
    reason = "switch/recovery host composition follows in RX8; no wire adapter"
)]
mod switch;

#[allow(
    dead_code,
    reason = "post-activation probe is private until RX8 host composition"
)]
mod runtime_probe;
