//! Port of the mechanical base of the secret store (`packages/core/src/secrets/{types,leases,memory-backend,audit}.ts`,
//! ADR-005 "Secret storage", P4-20, first library commit).
//!
//! A library: nothing in the front door calls it yet (`route::NATIVE` stays empty). The vectors under
//! `fixtures/parity/secrets/` (recorded by `scripts/parity/export-secrets.ts`) are replayed by `vectors.rs`.
//!
//! Ported here:
//! - [`error`]: [`SecretError`] and its twelve codes, every fixed message as a constructor;
//! - [`types`]: the name, value and description rules with exact JavaScript semantics (`*_units` forms over `&[u16]` for a
//!   string that may not be well-formed UTF-16), the constants, [`SecretMeta`], [`SecretPrincipal`], [`BackendKind`],
//!   [`BackendProbe`], `backendFailure`;
//! - [`backend`]: the [`SecretBackend`] trait as a synchronous translation of the TypeScript interface, `new
//!   Date(ms).toISOString()`, and [`backend::compare_names`], the order of `list` (`localeCompare`, ICU root collation);
//! - [`memory_backend`]: the in-memory backend;
//! - [`leases`]: the lease table over an injected clock and an injected [`crate::identity::codes::RandomSource`];
//! - [`audit`]: the action names, `sanitizeDetail` and the actor's `user` string (no sink).
//!
//! Not ported yet (later commits of the same pull request): the file backend, the keyring backend, the helper process and its
//! protocol, the registry and the store itself (`store.ts`), the audit sinks and the secret redaction.
pub mod audit;
pub mod backend;
pub mod error;
pub mod file_backend;
pub mod jsdoc;
pub mod leases;
pub mod memory_backend;
#[cfg(test)]
mod store_vectors;
pub mod types;
#[cfg(test)]
mod vectors;

pub use backend::SecretBackend;
pub use error::{SecretError, SecretErrorCode};
pub use types::{BackendKind, BackendProbe, SecretMeta, SecretPrincipal};
