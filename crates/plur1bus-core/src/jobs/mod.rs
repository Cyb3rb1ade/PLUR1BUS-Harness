//! Jobs (P4-K K7a, plan P4-51): the system jobs registry with its run ledger (`packages/core/src/system-jobs/`), the user jobs
//! that a person schedules for an agent (`packages/core/src/user-jobs/{index,rpc}.ts`, the logic only) and the cron evaluator
//! they schedule with (`packages/core/src/dreams/cron.ts`, which the dream scheduler of a later K7 run will share). The
//! TypeScript code is the specification; a difference is a recorded `K7-D` finding.
//!
//! **Nothing here runs in the product.** No RPC method, no timer, no scheduler thread: a host calls [`user::UserJobs::tick`]
//! and [`system::IntegrityArm::fire`] when its own timer says so (R-K-2). What the code needs from the rest of the core comes
//! in as a port: the clock ([`crate::budget::Clock`]), the id source ([`crate::budget::IdSource`]), the audit sink
//! ([`crate::rbac::audit::AuditSink`]), the principal lookup, and, for the turn a user job submits, a closure the host
//! supplies (the turn itself is not part of this package). TypeScript's `async` ports are plain callbacks here; the places
//! where the TypeScript code awaits (and another caller can change the state) are the places where this code calls a port
//! with no borrow or transaction held, so a caller that re-enters through a shared handle sees what it sees in TypeScript.
//!
//! **Rights.** Who may create, see, change, trigger and delete a user job is decided by [`crate::rbac::authorize::authorize`]
//! over the `agent.list`, `agent.manage` and `agent.use` actions and by the visibility rule of [`user::UserJobs::list`]; a job
//! runs as the person who last saved it ([`user::UserJobs::update`] hands it over) and, at every run, with that person's
//! *current* rights: a person who lost the right to use the agent, or who no longer exists, gets a skipped run and the job is
//! switched off with its reason. A job never keeps an authority snapshot.
//!
//! **Stores.** `state/user-jobs.sqlite` is opened as its TypeScript constructor opens it (private file, WAL, two
//! `CREATE TABLE IF NOT EXISTS`, no `user_version`); the ledger of the system jobs is `state/system-jobs/ledger.jsonl` (and
//! `ledger.jsonl.1` after a rotation), one JSON row per line, every row of schema version 1. Both are mode B: the same
//! file is read and written by either side.
pub mod cron;
#[cfg(test)]
mod cron_vectors;
pub mod system;
pub mod user;

use plur1bus_store::rusqlite;
use std::fmt;

/// Why a jobs call failed.
#[derive(Debug)]
pub enum JobsError {
    /// `RpcError`: the code, the text and its `detail` where it has one.
    Rpc {
        /// The error code (`E_DENIED`, `E_INVALID_PARAMS`, ...).
        code: &'static str,
        /// The text.
        message: String,
        /// `detail`.
        detail: Option<serde_json::Value>,
    },
    /// Any other `Error` (SQLite, a row that does not parse, a cron expression that does not parse).
    Other(String),
}

impl JobsError {
    /// An `RpcError` with a fixed text.
    pub fn rpc(code: &'static str, message: &str) -> Self {
        Self::Rpc {
            code,
            message: message.to_owned(),
            detail: None,
        }
    }

    /// The error code of an `RpcError`.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Rpc { code, .. } => Some(code),
            Self::Other(_) => None,
        }
    }
}

impl fmt::Display for JobsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rpc { message, .. } => f.write_str(message),
            Self::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for JobsError {}

impl From<rusqlite::Error> for JobsError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Other(e.to_string())
    }
}

impl From<plur1bus_store::StoreError> for JobsError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        Self::Other(e.to_string())
    }
}

impl From<cron::CronError> for JobsError {
    fn from(e: cron::CronError) -> Self {
        Self::Other(e.0)
    }
}
