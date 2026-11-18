//! `packages/core/src/collab/` (P4-K K6a, plan P4-50): collaboration between agents of one project as a library: the store
//! (`state/collab.sqlite`), the limits, guardrails and capacity rules, the board, and (in later parts) the delegation
//! service. The TypeScript code is the specification; a difference is a recorded `K6-D` finding.
//!
//! **Nothing here runs in the product.** No RPC method, tool or hook calls this module; the flip wires it. What it needs
//! from the rest of the core comes in as a port (R-K-2): the clock ([`crate::budget::Clock`]), ids ([`ids::CollabIds`]), and
//! the ports of the service.
//!
//! **Not in this part:** the team shell (`collab/team/*`, no specification yet), the coding gate and surface, chat
//! promotion, the runner and verifier, and the evaluation harnesses (K6b and K6c).
pub mod board;
pub mod capacity;
pub mod errors;
pub mod guardrails;
pub mod ids;
pub mod limits;
pub mod migrations;
pub mod store;
pub mod types;

pub use errors::{CollabError, CollabErrorCode, GuardrailReason};
pub use store::{CollabStore, StoreOptions};

#[cfg(test)]
mod vectors;
