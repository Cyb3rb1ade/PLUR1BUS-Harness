//! Primary/client role state, validation, durable persistence and fencing.
//! Event facts are verified by the caller. RS1/RS4 own supervisor and command wiring.
#![allow(dead_code)]
mod atomic;
mod events;
pub(crate) mod fence;
mod membership;
pub(crate) mod model;
mod observation;
mod source;
pub(crate) mod store;
mod target;
#[cfg(test)]
mod tests;
mod validation;
