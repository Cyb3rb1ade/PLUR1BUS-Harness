//! The real `backup/manifest.rs` and `backup/archive.rs` of the `plur1bus` binary crate (which has no lib target),
//! included by path and unmodified. `BackupError` is copied from `backup/mod.rs` (the rest of that file is CLI glue).
#![allow(dead_code, clippy::all)]
use std::fmt;

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

#[path = "../../crates/plur1bus/src/backup/manifest.rs"]
pub mod manifest;

#[path = "../../crates/plur1bus/src/backup/archive.rs"]
pub mod archive;
