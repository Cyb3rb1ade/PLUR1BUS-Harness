//! Reembedding migration components; the F7 coordinator owns maintenance authority.
pub mod backend;
pub mod confirmation;
pub mod coordinator;
pub mod coordinator_ports;
pub mod planner;
pub mod state;
mod state_json;
pub mod validation;
