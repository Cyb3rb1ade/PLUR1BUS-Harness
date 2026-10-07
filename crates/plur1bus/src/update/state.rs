//! The persistent update state machine (`<home>/update/state.json`, D78, plan 2026-10-06-m8). Every phase is written
//! (atomically, fsynced) *before* the step it names starts, so whatever a crash leaves behind says how far the update
//! got and what [`super::recover`] has to do about it.
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Stopping,
    Snapshotted,
    Swapping,
    Swapped,
    Started,
    /// The health gate passed; only the install manifest write is left (recovery rolls *forward* from here).
    Gated,
    RollingBack,
    Committed,
    RolledBack,
    /// The snapshot could not be verified: nothing was restored (a person has to look).
    Failed,
}

impl Phase {
    pub fn is_terminal(self) -> bool {
        matches!(self, Phase::Committed | Phase::RolledBack | Phase::Failed)
    }
}

/// What the commit step needs to write the new install manifest without the feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub binary_sha256: String,
    pub core: Option<CoreTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreTarget {
    pub version: String,
    pub contract: String,
    pub rpc: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub id: String,
    /// `update` or `manual-rollback`.
    pub trigger: String,
    pub phase: Phase,
    pub from: String,
    pub to: String,
    pub channel: String,
    /// Pid of the process driving the update; recovery acts only when it is gone.
    pub owner: u32,
    pub started_at: u64,
    pub updated_at: u64,
    pub was_running: bool,
    pub target_bin: PathBuf,
    pub core_swapped: bool,
    pub release: Target,
    pub reason: Option<String>,
    pub message: Option<String>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn dir(layout: &Layout) -> PathBuf {
    layout.home.join("update")
}
pub fn state_path(layout: &Layout) -> PathBuf {
    dir(layout).join("state.json")
}
pub fn snapshot_dir(layout: &Layout) -> PathBuf {
    dir(layout).join("snapshot")
}
pub fn staging_dir(layout: &Layout) -> PathBuf {
    dir(layout).join("staging")
}

/// `Ok(None)` when no update ever ran. A file that does not parse is an error, never "no update": recovery must not
/// guess.
pub fn load(layout: &Layout) -> Result<Option<State>, String> {
    let p = state_path(layout);
    match fs::read(&p) {
        Ok(raw) => serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|e| format!("{} is unreadable: {e}", p.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

/// Writes the state through `state.json.tmp-<pid>` + rename, fsynced, after stamping `updated_at`.
pub fn save(layout: &Layout, s: &mut State) -> io::Result<()> {
    s.updated_at = now_ms();
    let d = dir(layout);
    fs::create_dir_all(&d)?;
    let tmp = d.join(format!("state.json.tmp-{}", std::process::id()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        let mut text = serde_json::to_string_pretty(s).map_err(io::Error::other)?;
        text.push('\n');
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, state_path(layout))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    #[cfg(unix)]
    fs::File::open(&d)?.sync_all()?;
    Ok(())
}

/// A fresh id: `<ms>-<pid>`.
pub fn new_id() -> String {
    format!("{}-{}", now_ms(), std::process::id())
}

/// Removes a directory tree if present.
pub fn remove_dir(p: &Path) {
    let _ = fs::remove_dir_all(p);
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample() -> State {
        State {
            id: "1-1".into(),
            trigger: "update".into(),
            phase: Phase::Stopping,
            from: "0.1.0".into(),
            to: "0.2.0".into(),
            channel: "stable".into(),
            owner: 1,
            started_at: 1,
            updated_at: 1,
            was_running: true,
            target_bin: PathBuf::from("/x/plur1bus"),
            core_swapped: false,
            release: Target {
                binary_sha256: "a".repeat(64),
                core: None,
            },
            reason: None,
            message: None,
        }
    }

    #[test]
    fn a_state_round_trips_and_a_torn_file_is_an_error_not_none() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        assert_eq!(load(&layout).unwrap(), None);
        let mut s = sample();
        save(&layout, &mut s).unwrap();
        assert_eq!(load(&layout).unwrap(), Some(s));
        fs::write(state_path(&layout), b"{\"id\":").unwrap();
        assert!(load(&layout).is_err());
    }

    #[test]
    fn phases_are_ordered_as_the_flow_runs_and_terminals_are_marked() {
        use Phase::*;
        let flow = [Stopping, Snapshotted, Swapping, Swapped, Started, Gated];
        assert!(flow.windows(2).all(|w| w[0] < w[1]));
        assert!(flow.iter().all(|p| !p.is_terminal()));
        assert!(!RollingBack.is_terminal());
        assert!([Committed, RolledBack, Failed]
            .iter()
            .all(|p| p.is_terminal()));
    }
}
