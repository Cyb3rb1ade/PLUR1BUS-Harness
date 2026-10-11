//! Write-ahead recovery state. Only validated object names and redacted diagnostics are persisted.
use super::{atomic_json, read_private_json, CtlError, Installed};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Preflight,
    Stopping,
    Snapshotting,
    Swapping,
    Migrating,
    Gating,
    Done,
    RollingBack,
    RestoringSnapshot,
    StartingPrevious,
    GatingPrevious,
    RolledBack,
    RecoveryFailed,
}
impl Step {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Done | Self::RolledBack | Self::RecoveryFailed)
    }
}
/// Each destructive rollback operation has its own write-ahead checkpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestorePhase {
    VerifySnapshot,
    PreserveFailed,
    VerifyFailed,
    RemoveNew,
    ReplaceState,
    RestoreState,
    RenamePrevious,
    Start,
    Gate,
    Complete,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub volume: String,
    pub manifest_sha256: String,
    pub created_at: String,
    pub bytes: u64,
    pub file_count: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub from: Version,
    pub to: Version,
    pub from_digest: String,
    pub to_digest: String,
    pub step: Step,
    pub snapshot: Option<Snapshot>,
    pub failed_step: Option<Step>,
    pub diagnostic: Option<String>,
    pub previous: Installed,
    pub skipped: bool,
    pub restore_phase: RestorePhase,
    pub failed_snapshot: Option<Snapshot>,
    pub cleanup: Option<Snapshot>,
    pub cleanup_failed: Option<String>,
}
impl Journal {
    pub fn load(dir: &Path) -> Result<Option<Self>, CtlError> {
        match std::fs::symlink_metadata(dir.join("upgrades.json")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(CtlError::Storage),
            Ok(_) => {}
        }
        let j: Self = serde_json::from_str(&read_private_json(dir, "upgrades.json", 32768)?)
            .map_err(|_| CtlError::Storage)?;
        j.validate()?;
        Ok(Some(j))
    }
    pub fn save(&self, dir: &Path) -> Result<(), CtlError> {
        self.validate()?;
        atomic_json(dir, "upgrades.json", self)
    }
    pub fn validate(&self) -> Result<(), CtlError> {
        let name = |s: &str| {
            !s.is_empty()
                && s.len() <= 200
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        };
        let hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
        if !crate::runtime::spec::valid_digest(&self.from_digest)
            || !crate::runtime::spec::valid_digest(&self.to_digest)
            || !name(&self.from.to_string())
            || !name(&self.to.to_string())
            || self
                .snapshot
                .iter()
                .chain(self.failed_snapshot.iter())
                .chain(self.cleanup.iter())
                .any(|s| {
                    !name(&s.volume)
                        || !hash(&s.manifest_sha256)
                        || s.created_at.len() > 64
                        || chrono::DateTime::parse_from_rfc3339(&s.created_at).is_err()
                })
            || self.cleanup_failed.as_ref().is_some_and(|s| !name(s))
            || self.previous.image_digest != self.from_digest
            || self.previous.installed_version != self.from.to_string()
            || self.diagnostic.as_ref().is_some_and(|d| d.len() > 32768)
        {
            return Err(CtlError::Storage);
        }
        self.previous.resources.validate()?;
        Ok(())
    }
}
