//! The core's logs (P4-11, `packages/core/src/logs/`): redaction first, because every writer, reader and output path of the
//! later tasks goes through it.
//!
//! - [`redact`]: the redactor's core-side surface: options, the live registry of secret values, the [`TextRedactor`]
//!   seam; the algorithm itself is `plur1bus_log_schema::redact`, shared with the CLI;
//! - [`with_redaction`]: a logger wrapper that masks every message and field before delivery.
//!
//! [`TextRedactor`]: redact::TextRedactor

pub mod redact;
pub mod with_redaction;
