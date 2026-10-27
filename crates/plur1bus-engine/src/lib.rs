//! `plur1bus-engine`: the PLUR1BUS memory engine in Rust (rust-engine plan §2,
//! `docs/superpowers/plans/2026-10-23-rust-engine-rewrite.md`).
//!
//! The engine owns the memory stores (LanceDB table `memories`, the SQLite caches, the working-memory files and the
//! ledgers), the embedding and rerank providers, the recall and capture pipelines and the background jobs. It runs as
//! its own process under the harness supervisor and answers `engine.*` RPC (plan §2.1). This crate is the RE-00
//! skeleton: it declares the dependency set and the lint policy and implements no engine behaviour yet; the modules
//! of plan §2.4 arrive with RE-01 onwards.
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]

pub mod cache_profiles;
pub mod config;
pub mod contract;
pub mod tokens;

/// The crate version, which is the workspace version (`[workspace.package] version` in the root `Cargo.toml`).
pub const CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");
