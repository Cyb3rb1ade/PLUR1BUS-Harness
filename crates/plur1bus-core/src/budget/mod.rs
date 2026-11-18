//! `packages/core/src/budget/` and `licences/` (P4-K K1, plan P4-24): usage accounting and limits for model and media calls,
//! the pre-call reservation port, retry and zone budgets, the subagent result cap, the A2A peer budgets and the shared model
//! licence ledger. The TypeScript code is the specification; a difference is a recorded `P4D-n`, never a quiet choice.
//!
//! **Nothing here runs in the product.** No RPC method (`budget.status`, `budget.set`), no Front Door route and no supervisor
//! hook reaches this module; the flip package wires it. What the module needs from the rest of the core comes in as a trait
//! (R-K-2): [`Clock`], [`IdSource`], [`period::Zones`] (the time-zone database), the event sinks of the two services, the
//! audit sink and the licence catalogue of [`licences`], the token counter and result store of [`subagent`].
//!
//! The store is `state/budget.sqlite`, the file the TypeScript core writes, opened by [`store::open`] the way `openBudgetDb`
//! opens it (private file, WAL, `synchronous = NORMAL`, one `BEGIN IMMEDIATE` migration to [`store::SCHEMA_VERSION`], a newer
//! file refused untouched). Tables a constructor creates outside `user_version` (`budget_call*`, `a2a_peer_*`) are created
//! the same way here, so a file written by one core opens in the other at every step. One writer: every write is a
//! [`plur1bus_store::Store::write_with`] transaction, which is `BEGIN IMMEDIATE`. The ledger holds counts and ids only; there
//! is no money dimension (the legacy `cost*` and `price_version` columns stay in the file, unused).
//!
//! Differences that the types make, not the code: a TypeScript object that is "closed" (an unknown property is refused) is a
//! Rust struct that cannot carry one, so the closed-shape refusal belongs to the JSON boundary of the flip. A number that must
//! be a safe integer is an `i64` that [`count`] checks against the 2^53 - 1 range JavaScript counts in.
pub mod cache_report;
pub mod calls;
pub mod context;
pub mod licences;
pub mod media;
pub mod peer;
pub mod period;
pub mod retry;
pub mod service;
pub mod store;
pub mod subagent;
pub mod weight;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_calls;
#[cfg(test)]
mod vectors;

use plur1bus_store::StoreError;
use std::fmt;

/// `Number.MAX_SAFE_INTEGER`: counts and sums stay below it, or they are refused.
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
/// The largest instant a JavaScript `Date` holds (milliseconds); a later one cannot be bucketed into a period.
pub const MAX_TS: i64 = 8_640_000_000_000_000;

/// The clock of the services: milliseconds since the epoch (a port, so tests run on a fixed one).
pub trait Clock: Send + Sync {
    /// The current instant.
    fn now(&self) -> i64;
}

/// Where reservation and peer-call ids come from (`randomUUID()` in TypeScript).
pub trait IdSource: Send + Sync {
    /// A fresh id.
    fn next_id(&self) -> String;
}

/// Version 4 UUIDs, the production id source.
#[derive(Clone, Copy, Debug, Default)]
pub struct UuidIds;

impl IdSource for UuidIds {
    fn next_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// Why a store could not be opened (`BudgetStoreError.code`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreErrorCode {
    /// The file was written by a newer schema; it is left as it was.
    NewerSchema,
    /// The file could not be prepared, opened or initialised.
    OpenFailed,
}

/// The errors of this module, by the TypeScript class they stand for.
#[derive(Debug)]
pub enum BudgetError {
    /// `BudgetInputError`: a malformed identifier, count or setting.
    Input(String),
    /// A plain `RangeError` (a bad time zone, retry policy or result).
    Range(String),
    /// `BudgetStoreError`.
    Store {
        /// `code`.
        code: StoreErrorCode,
        /// The message.
        message: String,
    },
    /// SQLite failed while the store was in use (the TypeScript code lets the driver's error through).
    Sqlite(String),
    /// `BudgetExceededError`: `enforce` found a hard limit passed.
    Exceeded(Box<service::BudgetExceeded>),
}

impl fmt::Display for BudgetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(m) | Self::Range(m) | Self::Sqlite(m) => f.write_str(m),
            Self::Store { message, .. } => f.write_str(message),
            Self::Exceeded(e) => f.write_str(&e.message),
        }
    }
}

impl std::error::Error for BudgetError {}

impl From<plur1bus_store::rusqlite::Error> for BudgetError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        Self::Sqlite(e.to_string())
    }
}

impl From<StoreError> for BudgetError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NewerSchema {
                found, supported, ..
            } => Self::Store {
                code: StoreErrorCode::NewerSchema,
                message: format!(
                    "budget store schema {found} is newer than this core's {supported}"
                ),
            },
            other => Self::Sqlite(other.to_string()),
        }
    }
}

pub(crate) fn input(message: impl Into<String>) -> BudgetError {
    BudgetError::Input(message.into())
}

/// `ident` of `service.ts`: 1 to 128 characters of `A-Z a-z 0-9 . _ : / @ + = -`, the first alphanumeric.
pub(crate) fn is_identifier(v: &str) -> bool {
    let b = v.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/@+=-".contains(c))
}

pub(crate) fn ident<'a>(name: &str, v: &'a str) -> Result<&'a str, BudgetError> {
    if is_identifier(v) {
        Ok(v)
    } else {
        Err(input(format!(
            "{name} must be an identifier (1-128 chars of A-Z a-z 0-9 . _ : / @ + = -)"
        )))
    }
}

/// `count` of `service.ts`: a non-negative safe integer.
pub(crate) fn count(name: &str, v: i64) -> Result<i64, BudgetError> {
    if (0..=MAX_SAFE).contains(&v) {
        Ok(v)
    } else {
        Err(input(format!("{name} must be a non-negative integer")))
    }
}
