//! `packages/core/src/approvals/` (P4-K K3a, plan P4-22): the D109 approval store and service, the HMAC chain that is their
//! authority, the Ed25519 decision signatures, the keys behind both, and the daily integrity job. The grants that share the
//! file and the chain are [`crate::grants`]. The TypeScript code is the specification; where Rust differs on purpose, the
//! module says so and the ledger has the reason.
//!
//! **Nothing here runs in the product.** No RPC method, no Front Door route, no dispatcher and no supervisor hook reaches
//! this module; the flip wires it. What it needs from the rest of the core comes in as a trait (R-K-2): [`Clock`],
//! [`Random`] (ids and nonces), [`keys::ChainKeySource`] and [`keys::SigningKeySource`] over [`keys::SecretSlot`] (the
//! secret store), [`signing::DecisionSigner`], the policy audit ([`AuditPort`]), and for the service the timers, the event
//! sink, the argument canonicaliser and the redactor ([`service`]).
//!
//! **One writer.** Every write runs inside `plur1bus_store::Store::write_with` (`BEGIN IMMEDIATE`) on the one connection
//! [`crate::grants::open::PermissionStores`] owns; the store functions below take that transaction's connection, and the
//! chain refuses to append outside one.
//!
//! Not ported here, on purpose: `rpc.ts` and `rpc-common.ts` (the RPC surface, mode T at the flip), `wire.ts` (the projection
//! to the RPC records, used only by that surface and by `notify.ts`), `notify.ts` (the delivery rule over the RPC server's
//! subscriptions; the service emits its events through [`service::ApprovalEvents`], and the flip's notifier decides who
//! receives them), and `runtime.ts` (lazy open on first use behind the RPC handlers; the flip's composition).
pub mod chain;
pub mod db;
pub mod integrity;
pub mod js_json;
pub mod keys;
pub mod node_codec;
pub mod signing;
pub mod store;

#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
mod vectors;

use chain::{ChainError, VerifyFailure};
use js_json::J;
use plur1bus_store::StoreError;
use serde_json::Value;
use std::fmt;

/// The clock of the approval code (milliseconds since the epoch; the chain and the tables store integers).
pub trait Clock {
    /// The current instant.
    fn now(&self) -> i64;
}

/// The system clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64)
    }
}

/// Random bytes for ids and nonces (`randomBytes`).
pub trait Random {
    /// Fills `buf`.
    fn fill(&self, buf: &mut [u8]);
}

/// The operating system's random source.
pub struct OsRandom;

impl Random for OsRandom {
    #[allow(clippy::panic)]
    fn fill(&self, buf: &mut [u8]) {
        // A random source that fails leaves zeros, which would repeat ids: a nonce must never repeat, so this aborts.
        if getrandom::fill(buf).is_err() {
            panic!("the operating system's random source failed");
        }
    }
}

/// `randomBytes(n).toString("hex")`.
pub fn random_hex(r: &dyn Random, n: usize) -> String {
    let mut b = vec![0u8; n];
    r.fill(&mut b);
    node_codec::hex_encode(&b)
}

/// The policy audit as the approval code uses it (`PolicyAudit.record`): `Err` when the line could not be written, and a
/// caller that must not act unrecorded lets that propagate. [`crate::policy::audit::PolicyAudit`] is the implementation.
pub trait AuditPort {
    /// One line.
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String>;
    /// Whether an audit trail is configured at all (`this.#audit` is set): [`NoAudit`] answers `false`.
    fn present(&self) -> bool {
        true
    }
}

impl AuditPort for crate::policy::audit::PolicyAudit<'_> {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        crate::policy::audit::PolicyAudit::record(self, action, fields)
    }
}

/// An audit port that records nothing (`audit` not given).
pub struct NoAudit;

impl AuditPort for NoAudit {
    fn record(&mut self, _: &str, _: &Value) -> Result<(), String> {
        Ok(())
    }
    fn present(&self) -> bool {
        false
    }
}

/// Why an approval operation failed (as opposed to being refused with a reason).
#[derive(Clone, Debug, PartialEq)]
pub enum ApprovalError {
    /// `ApprovalIntegrityError` / `ApprovalChainError`: the chain does not verify; nothing is decided from it.
    Integrity {
        /// The first position that does not hold.
        broken_at: f64,
        /// Why.
        reason: VerifyFailure,
    },
    /// `TypeError`: the input cannot become a request (too large a detail).
    Invalid(String),
    /// The audit line could not be written (the operation was rolled back).
    Audit(String),
    /// SQLite or an unreadable row.
    Storage(String),
}

impl fmt::Display for ApprovalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApprovalError::Integrity { broken_at, reason } => write!(
                f,
                "approval chain is broken at {} ({})",
                J::Num(*broken_at).stringify(),
                reason.as_str()
            ),
            ApprovalError::Invalid(m) | ApprovalError::Audit(m) | ApprovalError::Storage(m) => {
                f.write_str(m)
            }
        }
    }
}

impl std::error::Error for ApprovalError {}

impl From<ChainError> for ApprovalError {
    fn from(e: ChainError) -> Self {
        match e {
            ChainError::Broken {
                broken_at, reason, ..
            } => ApprovalError::Integrity { broken_at, reason },
            other => ApprovalError::Storage(other.to_string()),
        }
    }
}

impl From<StoreError> for ApprovalError {
    fn from(e: StoreError) -> Self {
        ApprovalError::Storage(e.to_string())
    }
}

impl From<plur1bus_store::rusqlite::Error> for ApprovalError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        ApprovalError::Storage(e.to_string())
    }
}

/// `String(v)` for a member read from a payload (`undefined` when absent).
pub fn js_string(v: Option<&J>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(J::Null) => "null".to_owned(),
        Some(J::Bool(b)) => b.to_string(),
        Some(J::Num(n)) => crate::metrics::registry::js_number_to_string(*n),
        Some(J::Str(s)) => s.clone(),
        Some(J::Arr(a)) => a
            .iter()
            .map(|x| match x {
                J::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(J::Obj(_)) => "[object Object]".to_owned(),
    }
}

/// `Number(v)` for a member read from a payload.
pub fn js_number(v: Option<&J>) -> f64 {
    match v {
        None => f64::NAN,
        Some(J::Null) => 0.0,
        Some(J::Bool(b)) => f64::from(u8::from(*b)),
        Some(J::Num(n)) => *n,
        Some(J::Str(s)) => crate::policy::js_value::string_to_number(s),
        // `Number([...])` is `Number(String([...]))`.
        Some(J::Arr(_)) => crate::policy::js_value::string_to_number(&js_string(v)),
        Some(J::Obj(_)) => f64::NAN,
    }
}
