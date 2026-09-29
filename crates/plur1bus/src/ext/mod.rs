//! Extensions from file, the state layer (spec 2026-09-27 §6.2; X1-R12, X1-R14, X1-R17): where extension state lives
//! (`paths`), the package records (`state`), the skills index writer that shares the importer's lock (`index`),
//! revocations, integrity and overlays (`overlays`) and the host facts and test seams (`host`).
//!
//! The supervisor never parses package bytes (X1-R2): the files of this module that it can reach must not name the
//! parser, verifier, packer or extractor (`scripts/lint-hygiene.mjs`). `inspect.rs` and `stage.rs` run in the worker.
// Each later X1 task starts using more of this layer; until then only the tests call it.
#![allow(dead_code)]

pub mod commit;
pub mod host;
pub mod index;
pub mod inspect;
pub mod lifecycle;
pub mod list;
pub mod overlays;
pub mod paths;
pub mod remove;
pub mod stage;
pub mod state;
pub mod worker;

use plur1bus_ext::refusal::Refusal;
use serde_json::Value;

/// A failure of an ext operation: an `ErrorCode` name, an X1 `reason` (X1-R4) and a human message. The RPC and CLI
/// layers turn it into `error.data.{error,reason}` and `error/1` unchanged; `data` carries what a refusal such as
/// `acknowledge-capabilities` must show (or `null`).
#[derive(Debug, Clone)]
pub struct ExtError {
    pub code: &'static str,
    pub reason: Option<&'static str>,
    pub message: String,
    pub data: Value,
}

impl ExtError {
    pub fn new(code: &'static str, reason: &'static str, message: impl Into<String>) -> Self {
        ExtError {
            code,
            reason: Some(reason),
            message: message.into(),
            data: Value::Null,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }
}

impl From<Refusal> for ExtError {
    fn from(r: Refusal) -> Self {
        ExtError {
            code: r.code,
            reason: Some(r.reason),
            message: r.detail,
            data: Value::Null,
        }
    }
}

impl std::fmt::Display for ExtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.reason {
            Some(r) => write!(f, "{} {}: {}", self.code, r, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for ExtError {}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for an epoch-ms instant (the format of JavaScript's `toISOString`, which the importer
/// writes into `importedAt`). Wall time appears only in `at`/`installedAt`-style fields (global constraints).
pub(crate) fn iso8601(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

/// [`iso8601`] of now.
pub(crate) fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    iso8601(ms)
}
