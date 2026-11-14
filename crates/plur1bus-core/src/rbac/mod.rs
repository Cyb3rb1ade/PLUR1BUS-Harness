//! Port of the RBAC decision (`packages/core/src/rbac/{types,policy,authorize,surface,connection-surface}.ts`, ADR-007, P4-12).
//!
//! One security decision, two implementations (R10): `packages/api` keeps importing the TypeScript policy beyond the cut, so
//! the vectors under `fixtures/parity/rbac/` (recorded by `scripts/parity/export-rbac.ts`) are the contract that holds both.
//! This is a library: nothing in the front door calls it yet (`route::NATIVE` stays empty). The RBAC principal, resource,
//! grant and decision types here are their own types and have nothing to do with [`crate::route::Principal`].
//!
//! - [`types`]: roles, rights, principal, resource, grant and decision types;
//! - [`policy`]: the `POLICY` table as data and [`policy::policy_for`];
//! - [`authorize`]: [`authorize::authorize`], [`authorize::can_see`] and their JavaScript-input twins ([`authorize::authorize_js`],
//!   [`authorize::can_see_js`]) that accept every input the TypeScript function can receive;
//! - [`surface`]: the surface trust level (T0 to T3) of a decision and of an RPC connection;
//! - [`audit`]: the audit event of the RBAC modules, its sink and the line writer of `logs/audit.log`;
//! - [`guard`]: the rule table of the RPC methods and the decision before a handler runs, with the memory fallback;
//! - [`break_glass`]: the registry of break-glass grants (request, use, expiry, revocation, notice);
//! - [`loose`]: the JavaScript value model the `_js` entry points take (and the few coercions JavaScript applies to it).
pub mod audit;
pub mod authorize;
pub mod break_glass;
pub mod guard;
#[cfg(test)]
mod guard_vectors;
pub mod loose;
pub mod policy;
pub mod surface;
pub mod types;
#[cfg(test)]
mod vectors;
