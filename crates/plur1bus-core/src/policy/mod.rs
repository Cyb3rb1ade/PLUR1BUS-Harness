//! `packages/core/src/policy/` (P4-K K2, plan P4-21): the D109 decision evaluator, the capability table, the effect
//! vocabulary, the headless gate and the pure half of the path layer. The TypeScript code is the specification.
//!
//! **Nothing here runs in the product.** No RPC method, no Front Door route, no dispatcher and no supervisor hook reaches
//! this module; the flip (with the dispatcher of P4-43) wires it. What it needs from the rest of the core comes in as a
//! trait (R-K-2): [`decide::Clock`], [`decide::GrantSource`] (the grants store of K3), [`paths::Nfc`] (Unicode
//! normalisation, see [`paths`]) and [`fs_paths::PathFs`] (the file system under `canonicalisePath` and `openVerified`).
pub mod audit;
pub mod capabilities;
pub mod decide;
pub mod effects;
pub mod fs_paths;
#[cfg(not(unix))]
pub mod fs_windows;
pub mod headless;
pub mod js_value;
pub mod paths;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;
