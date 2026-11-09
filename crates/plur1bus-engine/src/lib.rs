//! `plur1bus-engine`: the PLUR1BUS memory engine in Rust (rust-engine plan §2,
//! `docs/superpowers/plans/2026-10-23-rust-engine-rewrite.md`).
//!
//! The engine owns the memory stores (LanceDB table `memories`, the SQLite caches, the working-memory files and the
//! ledgers), the embedding and rerank providers, the recall and capture pipelines and the background jobs. It runs as
//! its own process under the harness supervisor and answers `engine.*` RPC (plan §2.1). The store and embedding libraries are implemented; RE-08 T2 exposes their host-neutral ports through the
//! authenticated process server in `rpc`. Incomplete memory pipelines remain explicitly unavailable.
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]

pub mod cache_profiles;
pub mod capture;
pub mod config;
pub mod context;
pub mod contract;
pub mod embedding;
pub mod jobs;
pub mod media;
pub mod neo;
pub mod ops;
pub mod recall;
pub mod rpc;
pub mod store;
pub mod text;
pub mod tokens;
pub mod transport;

/// The crate version, which is the workspace version (`[workspace.package] version` in the root `Cargo.toml`).
pub const CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");
