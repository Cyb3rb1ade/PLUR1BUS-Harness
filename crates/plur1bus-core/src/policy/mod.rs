//! `packages/core/src/policy/` (P4-K K2, plan P4-21): the D109 decision evaluator, the capability table, the effect
//! vocabulary, the headless gate and the pure half of the path layer. The TypeScript code is the specification.
//!
//! **Nothing here runs in the product.** No RPC method, no Front Door route, no dispatcher and no supervisor hook reaches
//! this module; the flip (with the dispatcher of P4-43) wires it. What it needs from the rest of the core comes in as a
//! trait (R-K-2): [`decide::Clock`], [`decide::GrantSource`] (the grants store of K3) and [`paths::Nfc`] (Unicode
//! normalisation, see [`paths`]).
//!
//! Not yet ported (the K2 entry of the ledger names it): `canonicalisePath` and `openVerified` of `paths.ts`, which read
//! the real file system, and the policy audit writer of `audit.ts`.
pub mod capabilities;
pub mod decide;
pub mod effects;
pub mod headless;
pub mod js_value;
pub mod paths;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;
