//! Port of the secret store (`packages/core/src/secrets/{types,leases,memory-backend,audit,file-backend,store}.ts`, ADR-005
//! "Secret storage", P4-20, library).
//!
//! A library: nothing in the front door calls it yet, no `secret.*` method is native and no file of a running core is
//! touched. The vectors under `fixtures/parity/secrets/` (recorded by `scripts/parity/export-secrets.ts`) are replayed by
//! `vectors.rs`.
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
//! - [`jsdoc`]: a JSON document with JavaScript's member order, for the files the TypeScript core reads and writes too;
//! - [`file_backend`]: the encrypted file (`state/secrets/store.json`, `store.key`), byte for byte as TypeScript writes it;
//! - [`store`]: the store over two backends (selection, merge and sync, preload, gates, leases, change listeners), with
//!   its audit sink as a trait.
//!
//! The registry of `secrets/redaction.ts` is [`crate::logs::redact::SecretSet`]. The recorded scenarios of the registry,
//! the file backend and the store (`fixtures/parity/secrets-store/`, `scripts/parity/export-secrets-store.ts`) are
//! replayed by `store_vectors.rs`. Deliberate differences are P4D-26, P4D-27 and P4D-31 of `docs/phase4/defects.md`.
//!
//! Not ported yet: the keyring backend and the helper process with its protocol (the next pull request), the audit sink
//! that writes `logs/audit.log` and the chain (with the flip, which has the home), and the extension secret handling
//! (`extensions/secret-*.ts`, with the package that ports extensions).
pub mod audit;
pub mod backend;
pub mod error;
pub mod file_backend;
pub mod isolated;
pub mod jsdoc;
pub mod keyring_backend;
#[cfg(test)]
mod keyring_vectors;
pub mod leases;
pub mod memory_backend;
pub mod os_keyring;
pub mod store;
#[cfg(test)]
mod store_vectors;
pub mod types;
#[cfg(test)]
mod vectors;

pub use backend::SecretBackend;
pub use error::{SecretError, SecretErrorCode};
pub use file_backend::FileBackend;
pub use keyring_backend::KeyringBackend;
pub use store::{SecretStore, SecretStoreOptions};
pub use types::{BackendKind, BackendProbe, SecretMeta, SecretPrincipal};
