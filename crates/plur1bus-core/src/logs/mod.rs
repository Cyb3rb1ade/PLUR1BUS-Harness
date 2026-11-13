//! The core's logs (P4-11, `packages/core/src/logs/`): redaction first, because every writer, reader and output path
//! goes through it, then the write path.
//!
//! - [`redact`]: the redactor's core-side surface: options, the live registry of secret values, the [`TextRedactor`]
//!   seam; the algorithm itself is `plur1bus_log_schema::redact`, shared with the CLI;
//! - [`with_redaction`]: a logger wrapper that masks every message and field before delivery;
//! - [`levels`], [`trace`]: the live level policy and trace contexts;
//! - [`lines`], [`files`]: the streaming line reader and the listing of a role's log files;
//! - [`query`], [`methods`]: the log query (cursor, time range, filters, both directions, redaction) and the
//!   `logs.query`, `logs.tail` and `logs.levels` handlers over a deps struct;
//! - [`sink`]: the file sink (rotation, retention, cross-process role lock);
//! - [`writer`]: the diagnostic writer (validation, redaction, de-duplication, rate limit, batching);
//! - [`output`]: line framing for child-process output;
//! - [`bootstrap`]: the core logger the process starts with.
//!
//! Nothing here is wired into the running core yet.
//!
//! [`TextRedactor`]: redact::TextRedactor

pub mod bootstrap;
pub mod error;
pub mod files;
pub mod levels;
pub mod lines;
pub mod methods;
pub mod output;
pub mod query;
pub mod redact;
pub mod sink;
pub mod trace;
pub mod with_redaction;
pub mod writer;

#[cfg(test)]
mod query_vectors;
#[cfg(test)]
mod vectors;
