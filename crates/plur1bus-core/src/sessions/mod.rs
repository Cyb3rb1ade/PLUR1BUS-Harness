//! `packages/core/src/session/` store half (P4-K K5a, plan P4-40): the session store on `sessions.sqlite` with its
//! migrations, shared vocabulary, token calibration, full-text search, tool offers and visibility, summaries, checkpoint
//! rows and the rewind overlay *rows*. The TypeScript code is the specification; a difference is a recorded finding, never a
//! quiet choice.
//!
//! **Nothing here runs in the product.** No RPC method (`session.*`, `chat.*`), no Front Door route and no supervisor hook
//! reaches this module; the flip package wires it. What the store needs from the rest of the core comes in as a trait
//! (R-K-2): the clock and the id source are the ports of [`crate::budget`] ([`Clock`], [`IdSource`]); the ids the TypeScript
//! store draws as `` `${prefix}_${randomUUID()}` `` are `prefix_` plus [`IdSource::next_id`].
//!
//! The file is `state/sessions.sqlite`, the one the TypeScript core writes. [`store::SessionStore::open`] does what
//! `new SessionStore({ path })` does (foreign keys on, 5 s busy timeout, WAL and `synchronous = NORMAL` for a file, the
//! migrations in [`migrations`] to [`migrations::SCHEMA_VERSION`], mode 0600 where the platform has one); a file from a newer
//! core is refused and left as it was. Every write is a [`plur1bus_store::Store::write_with`] transaction (`BEGIN IMMEDIATE`)
//! where the TypeScript store has a `#tx`; a write the TypeScript store runs as a single autocommit statement is one
//! `BEGIN IMMEDIATE` statement here, which commits the same rows. One writer per file: the store holds the only connection.
//!
//! Split with K5b and K5c: this module holds every method of `store.ts`, including those only rewind or compaction call, and
//! the pure overlay helpers the store itself needs ([`overlay`]: `activePath`, `hiddenDigest`, `failedEditCycles`). The
//! services on top (compaction, pruning, context fit, summariser, maintenance, role routing, rewind with its file restore,
//! checkpoint retention) are not here; they take a [`store::SessionStore`] and come with K5b and K5c.
//!
//! Differences the types make, not the code (each is in the inventory): a count is an `i64` where TypeScript has a `number`;
//! an object the TypeScript store accepts with unknown keys is a struct; an event's `data` is a [`crate::approvals::js_json::J`]
//! (members in written order, printed as `JSON.stringify` prints them), which is how the bytes of a Rust-written event equal
//! TypeScript's.
pub mod chat_models;
pub mod checkpoint_retention;
pub mod compaction;
pub mod context_fit;
pub mod fts;
mod jstext;
pub mod maintenance;
pub mod memory_port;
pub mod migrations;
pub mod overlay;
pub mod pruning;
pub mod rewind;
pub mod rewind_checkpoints;
pub mod rewind_git;
pub mod rewind_project;
pub mod role_routing;
pub mod store;
mod store_misc;
mod store_turns;
pub mod summarizer;
pub mod tokens;
pub mod turn_telemetry;
pub mod types;

#[cfg(test)]
mod extras_vectors;
#[cfg(test)]
mod maintenance_vectors;
#[cfg(test)]
mod rewind_support;
#[cfg(test)]
mod rewind_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use crate::budget::{Clock, IdSource};
pub use store::{RewindToken, SessionStore};
pub use store_misc::RewindInput;
pub use types::*;

use plur1bus_store::rusqlite;
use plur1bus_store::StoreError;
use std::fmt;

/// `SessionErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    /// Bad input.
    Invalid,
    /// No such session, turn, rewind or message.
    NotFound,
    /// The state forbids it (archived, running turn, stale revision).
    Conflict,
    /// An immutable field.
    Immutable,
    /// SQLite or the schema.
    Storage,
}

impl ErrorCode {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::NotFound => "not-found",
            Self::Conflict => "conflict",
            Self::Immutable => "immutable",
            Self::Storage => "storage",
        }
    }
}

/// `SessionError`: a code, a message and an optional reason. Messages carry ids and SQLite's constraint text, never message
/// or event content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionError {
    /// The code.
    pub code: ErrorCode,
    /// The reason, where the TypeScript error has one.
    pub reason: Option<String>,
    /// The message.
    pub message: String,
}

impl SessionError {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>, reason: Option<&str>) -> Self {
        Self {
            code,
            reason: reason.map(str::to_owned),
            message: message.into(),
        }
    }
    pub(crate) fn invalid(message: &str, reason: &str) -> Self {
        Self::new(ErrorCode::Invalid, message, Some(reason))
    }
    pub(crate) fn conflict(message: &str, reason: &str) -> Self {
        Self::new(ErrorCode::Conflict, message, Some(reason))
    }
    pub(crate) fn not_found(message: &str, reason: Option<&str>) -> Self {
        Self::new(ErrorCode::NotFound, message, reason)
    }

    /// `mapSqlite`: how an error that was not a `SessionError` becomes one. The trigger text and the two unique indexes are
    /// matched by the same substrings the TypeScript store tests for, in the same order.
    pub(crate) fn from_message(msg: &str) -> Self {
        if msg.contains("I1:") {
            return Self::new(ErrorCode::Immutable, msg, Some("immutable-field"));
        }
        if msg.contains("UNIQUE constraint failed: sessions.chat_key")
            || msg.contains("idx_sessions_active_chat")
        {
            return Self::conflict("chat already has an active session", "active-chat-session");
        }
        if msg.contains("idx_turns_one_running") || msg.contains("turns.session_id") {
            return Self::conflict("session already has a running turn", "turn-in-progress");
        }
        Self::new(ErrorCode::Storage, msg, Some("sqlite"))
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SessionError {}

impl From<rusqlite::Error> for SessionError {
    fn from(e: rusqlite::Error) -> Self {
        Self::from_message(&e.to_string())
    }
}

impl From<StoreError> for SessionError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NewerSchema {
                found, supported, ..
            } => Self::new(
                ErrorCode::Storage,
                format!(
                    "session store schema v{found} is newer than this core supports (v{supported})"
                ),
                Some("schema-too-new"),
            ),
            StoreError::Migration { to, error, .. } => Self::new(
                ErrorCode::Storage,
                format!("session store migration to v{to} failed: {error}"),
                Some("migration-failed"),
            ),
            StoreError::Sqlite(error) => Self::from(error),
            other => Self::from_message(&other.to_string()),
        }
    }
}
