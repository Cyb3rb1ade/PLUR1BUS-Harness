//! The ACP server (P4-K K8, plan P4-71 without external agents): the Agent Client Protocol, schema v1, over a line-framed
//! stream, as `packages/core/src/acp/` speaks it. A library: nothing calls it yet, `main.ts` is not ported (the library takes an
//! [`server::InputPort`] and a `Write`), and no turn runs here (the turn is the Core's, behind [`backend::RpcCaller`]).
//!
//! - [`json`]: `JSON.parse` and `JSON.stringify` as the server needs them (iterative, bounded, JavaScript member order);
//! - [`jsops`]: the JavaScript operators applied to values from outside (`===` on objects, `Number(text)`, truthiness);
//! - [`framing`]: one message per line, bounded by bytes before it is decoded;
//! - [`exec`]: the small single-threaded executor and its primitives (design D1);
//! - [`text`]: the bilingual fixed texts, the failure reasons and the two session modes;
//! - [`permissions`]: agent-to-client permission requests (ids, options, timeout, close);
//! - [`core_permissions`]: the relay between the editor's choice and the Core's approval service;
//! - [`file_changes`]: when a file tool's result is shown as a standard diff;
//! - [`backend`]: the port to a harness and [`backend::CoreSessionBackend`] over `session.*` calls;
//! - [`server`]: the agent side itself.
//!
//! Ports (R-K-2): the session store and the approval service sit behind [`backend::RpcCaller`] (`session.*`, `approval.*`, `code.*`
//! of the Core); the clock and the id source are `budget::{Clock, IdSource}`; the poll pause is [`backend::Sleeper`]; input and
//! output are [`server::InputPort`] and `std::io::Write`. [`testing`] holds the scripted doubles the tests and the vector replay use.
pub mod backend;
pub mod core_permissions;
pub mod exec;
pub mod file_changes;
pub mod framing;
pub mod json;
pub mod jsops;
pub mod permissions;
pub mod server;
#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
pub mod text;
#[cfg(test)]
mod vectors;

/// The ACP schema version this server speaks.
pub use server::ACP_PROTOCOL_VERSION;
