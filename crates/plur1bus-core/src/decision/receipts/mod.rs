//! Decision receipts with replay (owner decision D133, rulings 1 to 11; plan P4-45 D0 to D4; P4-K K11). The spec is
//! `docs/superpowers/specs/2026-11-18-decision-receipts-design.md`. There is no TypeScript to port: the format, the store and
//! the rules here are new.
//!
//! A library: nothing in the turn path calls it, no RPC method, CLI command or configuration key exists for it, and no
//! timer runs in it (a host calls [`ReceiptStore::prune`]). Everything the module needs from the outside is a port: the
//! clock and the id source of the budget module, the audit sink of the RBAC module, the replay gate, the case text and
//! the calibration record.
//!
//! - [`format`]: the receipt `plur1bus.decisionreceipt/1`, which holds identifiers, hashes, classes, counters and times and
//!   never content, and [`format::capture`], which makes one from a decision without copying any;
//! - [`store`]: `decision-receipts.sqlite`, one receipt per turn and use case, incognito sessions write nothing, retention;
//! - [`rights`]: who may list, replay and adopt (rulings 10 and 11);
//! - [`replay`]: decide stored cases again through the decision client and compare, deterministically, no text in the report;
//! - [`adopt`]: a person takes a candidate as the new version of the calibration record, audit first, one transaction.
pub mod adopt;
pub mod format;
pub mod replay;
pub mod rights;
pub mod store;

#[cfg(test)]
mod tests;

pub use adopt::{AdoptRequest, CalibrationRecord, CalibrationRecords, MemoryCalibrationRecords};
pub use format::{
    capture, Decided, Fallback, Outcome, Receipt, ReceiptDraft, ReceiptError, ReceiptResult,
    ReceiptUseCase, RejectReason, ToolErrorCount, Validation,
};
pub use replay::{
    replay, Candidate, CaseKind, CaseSet, CaseSource, PortFault, ReplayGate, ReplayPorts,
    ReplayReport,
};
pub use store::{
    ListQuery, ReceiptPage, ReceiptStore, ReceiptStoreOptions, Retention, WriteResult,
};
