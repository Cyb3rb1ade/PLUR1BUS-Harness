//! The decision service (ADR-015, D103, D105; plan P4-42, P4-K K9a), ported from `packages/core/src/decision/`:
//! small bounded decisions (the probability of a statement, one of several options, a score over levels) asked of a
//! backend under one deadline, with the privacy rules decided before any content leaves the client. A library:
//! nothing in the running core calls it yet.
//!
//! The call of a model is a port. No provider crate and no HTTP client is linked here: the role backend talks to the
//! router through [`role::RoleRouter`], the System One transport to HTTP, the secret store and the call budget through
//! the traits of [`system_one`]. What the vectors of `scripts/parity/export-decision.ts` hold is which request
//! TypeScript builds (byte for byte) and what it makes of recorded answers, broken ones included.
//!
//! - [`types`]: inputs, results, events and the backend port;
//! - [`client`]: validation, backend order, privacy, the deadline, normalisation, bounded aggregates;
//! - [`skills`]: the rule shortlist, the decision-refined selection, follow-ups and fair slots;
//! - [`adapters`]: the three-way pruning verdict and the tree chooser;
//! - [`role`]: the decision role through the router;
//! - [`system_one`]: the System One transport.
//!
//! Not here: the decision receipts of D133 (K11), the `decision.*` RPC methods (the flip).
pub mod adapters;
pub mod client;
pub mod role;
pub mod skills;
pub mod system_one;
pub mod types;

#[cfg(test)]
mod vectors;

pub use client::{DecisionClient, DecisionOptions};
pub use types::*;
