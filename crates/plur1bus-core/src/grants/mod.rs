//! `packages/core/src/grants/` (P4-K K3a, plan P4-22): the D109 grants on the approvals database ([`store`]) and the one
//! place that opens that database with both stores on one chain and one writer ([`open`]), which is also the real
//! [`crate::policy::decide::GrantSource`] of the evaluator.
//!
//! **Nothing here runs in the product** (see [`crate::approvals`]). Not ported: `rpc.ts` (the `grant.*` methods, mode T at
//! the flip).
pub mod open;
pub mod store;

#[cfg(test)]
mod tests;
