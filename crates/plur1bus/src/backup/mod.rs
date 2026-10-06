//! M8 backup and restore (`plur1bus backup create|verify|restore`, docs/superpowers/plans/2026-10-06-m8-backup-restore.md).
//!
//! The archive is a `tar.gz` whose first entry is `manifest.json` (schema `plur1bus.backup/1`, a SHA-256 per file) and
//! whose other entries are `data/<archive path>`. The engine- and SQLite-owned parts are staged by the core
//! (`admin.backup.snapshot`, RULING R1/R6); everything else is a point-in-time copy of an allow-listed unit. Nothing
//! here reads a secret store (R4). The module is reached only from `commands::backup`, never from `supervisor/`.
pub mod archive;
pub mod create;
pub mod manifest;
pub mod restore;

use std::fmt;

/// A refusal or failure with a machine-readable `reason` (the `reason` field of the CLI's error document).
#[derive(Debug)]
pub struct BackupError {
    pub reason: &'static str,
    pub detail: String,
}

impl BackupError {
    pub fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        BackupError {
            reason,
            detail: detail.into(),
        }
    }

    /// The CLI error code (an `ErrorCode` of the RPC schema) and exit status for this reason.
    pub fn code(&self) -> (&'static str, i32) {
        match self.reason {
            "core-running" => ("E_LOCKED", 3),
            "core-unavailable" => ("E_CORE_UNAVAILABLE", 1),
            "io" | "restore-failed" | "source-busy" | "snapshot-mismatch" => ("E_STORAGE", 1),
            "exists" => ("E_CONFLICT", 1),
            _ => ("E_INVALID_PARAMS", 1),
        }
    }
}

impl fmt::Display for BackupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.reason, self.detail)
    }
}

impl std::error::Error for BackupError {}

impl From<std::io::Error> for BackupError {
    fn from(e: std::io::Error) -> Self {
        BackupError::new("io", e.to_string())
    }
}

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `yyyymmddThhmmssZ` of `ms` (UTC), for file names; civil-from-days after H. Hinnant.
pub(crate) fn utc_stamp(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// A short unique suffix for staging and pre-restore directory names.
pub(crate) fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_stamp_is_the_calendar_date_of_the_epoch_second() {
        assert_eq!(utc_stamp(0), "19700101T000000Z");
        assert_eq!(utc_stamp(951_782_400_000), "20000229T000000Z"); // a leap day
        assert_eq!(utc_stamp(1_791_298_800_000 + 1_000), "20261006T150001Z");
    }

    #[test]
    fn reasons_map_to_codes() {
        assert_eq!(BackupError::new("core-running", "x").code(), ("E_LOCKED", 3));
        assert_eq!(BackupError::new("checksum-mismatch", "x").code().0, "E_INVALID_PARAMS");
        assert_eq!(BackupError::new("io", "x").code().0, "E_STORAGE");
    }
}
