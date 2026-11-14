//! Port of the RBAC decision (`packages/core/src/rbac/{types,policy,authorize,surface,connection-surface}.ts`, ADR-007, P4-12).
//!
//! One security decision, two implementations (R10): `packages/api` keeps importing the TypeScript policy beyond the cut, so
//! the vectors under `fixtures/parity/rbac/` (recorded by `scripts/parity/export-rbac.ts`) are the contract that holds both.
//! This is a library: nothing in the front door calls it yet (`route::NATIVE` stays empty). The RBAC principal, resource,
//! grant and decision types here are their own types and have nothing to do with [`crate::route::Principal`].
//!
//! - [`types`]: roles, rights, principal, resource, grant and decision types;
//! - [`policy`]: the `POLICY` table as data and [`policy::policy_for`];
//! //! //! - [`loose`]: the JavaScript value model the `_js` entry points take (and the few coercions JavaScript applies to it).
pub mod loose;
pub mod policy;
pub mod types;
