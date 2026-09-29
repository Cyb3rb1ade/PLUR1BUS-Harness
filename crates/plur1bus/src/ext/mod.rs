//! Extensions from file, the state layer (spec 2026-09-27 §6.2; X1-R12, X1-R14, X1-R17): where extension state lives
//! (`paths`), the package records (`state`), the skills index writer that shares the importer's lock (`index`),
//! revocations, integrity and overlays (`overlays`) and the host facts and test seams (`host`); the install commit
//! with per-step rollback and the offline `ModuleHost` (`commit`), list and show (`list`), the process-wide mutation
//! lock ([`try_mutation`]) and the start-up clean-up ([`recover`]).
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
pub mod record;
pub mod remove;
pub mod stage;
pub mod state;
pub mod worker;

use crate::paths::Layout;
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

/// The one process-wide lock every ext mutation (`install`, `uninstall`, `restore`, `enable`, `disable`) holds while it
/// runs (X1-R15). A second mutation does not wait: it gets `E_CONFLICT reason=busy` and changes nothing.
static MUTATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Held for the length of one ext mutation; see [`try_mutation`].
#[derive(Debug)]
pub struct MutationGuard(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

/// Takes the ext mutation lock without waiting (X1-R15). A lock poisoned by a panicking mutation is taken over: the
/// files it guards are each written atomically, and the next mutation re-reads them.
pub fn try_mutation() -> Result<MutationGuard, ExtError> {
    match MUTATION.try_lock() {
        Ok(g) => Ok(MutationGuard(g)),
        Err(std::sync::TryLockError::Poisoned(p)) => Ok(MutationGuard(p.into_inner())),
        Err(std::sync::TryLockError::WouldBlock) => Err(ExtError::new(
            "E_CONFLICT",
            "busy",
            "another extension change is running; try again when it has finished",
        )),
    }
}

/// `<name>.tmp-<pid>` written by a process that is gone.
fn dead_temp(name: &str) -> bool {
    name.rsplit_once(".tmp-")
        .and_then(|(_, pid)| pid.parse::<u32>().ok())
        .is_some_and(|pid| pid != std::process::id() && !crate::proc::pid_alive(pid))
}

/// What a killed command left behind (global constraints, Review Focus 3), removed at supervisor start and before an
/// offline command: every entry of `extensions/staging/` (a stage or commit that did not finish; the supervisor
/// stages and commits under the ext mutation lock, and the offline CLI runs only when no supervisor does) and the
/// directory itself, temp files of dead writers in `extensions/`, `extensions/cache/` and `skills/`, expired
/// inspections in `run/inspect/`, unfinished trash entries, the skills index entries a killed commit left without a
/// folder or a folder without an entry (X1-C10), and the module staging directories of dead installs
/// (`modules::install::recover`). Returns what was done, for the log. Best effort: a failure is skipped.
pub fn recover(layout: &Layout) -> Vec<String> {
    let p = paths::ExtPaths::of(layout);
    let mut done = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&p.staging) {
        for e in entries.flatten() {
            let path = e.path();
            let gone = match std::fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path),
                Ok(_) => std::fs::remove_file(&path),
                Err(e) => Err(e),
            };
            if gone.is_ok() {
                done.push(format!("removed the staging leftover {}", path.display()));
            }
        }
        if std::fs::remove_dir(&p.staging).is_ok() {
            done.push(format!("removed {}", p.staging.display()));
        }
    }
    for dir in [p.root.clone(), p.cache.clone(), layout.skills()] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_file = e.file_type().is_ok_and(|t| t.is_file());
            if is_file && dead_temp(&name) && state::remove_retrying(&e.path()).is_ok() {
                done.push(format!("removed the temp file {}", e.path().display()));
            }
        }
    }
    let count = |d: &std::path::Path| std::fs::read_dir(d).map_or(0, |r| r.count());
    let before = count(&p.inspect);
    record::prune(layout);
    let pruned = before.saturating_sub(count(&p.inspect));
    if pruned > 0 {
        done.push(format!(
            "removed {pruned} expired inspection file(s) from {}",
            p.inspect.display()
        ));
    }
    // Trash entries a killed commit was still building (`<trashId>.tmp-<pid>`: `record.json` and `package.p1x` only;
    // the code moves in after the rename).
    if let Ok(entries) = std::fs::read_dir(&p.trash) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if dead_temp(&name) && state::remove_dir_all_retrying(&e.path()).is_ok() {
                done.push(format!(
                    "removed the unfinished trash entry {}",
                    e.path().display()
                ));
            }
        }
    }
    done.extend(restore_missing_code(layout, &p));
    done.extend(reconcile_skills(layout, &p));
    done.extend(crate::modules::install::recover(layout));
    done
}

/// X1-C15: a recorded item whose code directory is missing while a trash entry for that very name and version still
/// holds `code/` was interrupted between moving its code into the trash and the next step (a replace killed before
/// the new code moved into place, or an uninstall killed before the record went). The code moves back; the trash
/// entry goes unless it holds purged data or config. A skill's index entry is rewritten from the record, disabled,
/// so it names the version whose code is back (fails safe: nothing ends enabled that was not acknowledged again).
fn restore_missing_code(layout: &Layout, p: &paths::ExtPaths) -> Vec<String> {
    let mut done = Vec::new();
    let Ok(st) = state::read(p) else {
        return done;
    };
    for rec in st.items.values() {
        if rec.removed_by_user || !matches!(rec.kind.as_str(), "skill" | "module" | "channel") {
            continue;
        }
        let dir = lifecycle::code_dir(layout, &rec.name, &rec.kind);
        if std::fs::symlink_metadata(&dir).is_ok() {
            continue;
        }
        let Some(entry) = remove::newest_trash_with_code(p, &rec.name, &rec.version) else {
            continue;
        };
        if let Some(parent) = dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if state::rename_retrying(&entry.join("code"), &dir).is_err() {
            continue;
        }
        done.push(format!(
            "put the code of {} {} back from the trash entry {} (an interrupted replace or uninstall)",
            rec.name,
            rec.version,
            entry.display()
        ));
        let data = entry.join("data");
        if data.is_dir() && std::fs::symlink_metadata(layout.ext_data(&rec.name)).is_err() {
            let _ = state::rename_retrying(&data, &layout.ext_data(&rec.name));
        }
        if !entry.join("data").exists() && !entry.join("config.json").exists() {
            let _ = state::remove_dir_all_retrying(&entry);
        }
        if rec.kind == "skill" {
            let fixed = index::lock_skills(layout).ok().and_then(|_lock| {
                let mut idx = index::read_index(layout).ok()?;
                let prev = idx.entry(&rec.name).cloned();
                let source = prev
                    .as_ref()
                    .and_then(|e| e["sourcePath"].as_str().map(str::to_string))
                    .unwrap_or_else(|| "-".into());
                idx.upsert(index::package_entry(
                    rec,
                    &source,
                    false,
                    &now_iso(),
                    prev.as_ref(),
                ));
                index::write_index(layout, &idx).ok()
            });
            if fixed.is_none() {
                done.push(format!(
                    "could not rewrite the index entry of {} (the skills index is locked or unreadable)",
                    rec.name
                ));
            }
        }
    }
    done
}

/// X1-C10: what a commit killed between its steps left in `skills/index.json`, under the importer's lock (skipped when
/// another writer holds it, or when the index or the state cannot be read). An entry with `package` set whose folder
/// is gone and that has no state record is removed (a fresh install killed before its folder moved in). A recorded
/// skill whose folder is there but has no entry gets one back, disabled, so X1-R12 never lists it as enabled.
fn reconcile_skills(layout: &Layout, p: &paths::ExtPaths) -> Vec<String> {
    let mut done = Vec::new();
    let Ok(st) = state::read(p) else {
        return done;
    };
    let Ok(_lock) = index::lock_skills(layout) else {
        return done;
    };
    let Ok(mut idx) = index::read_index(layout) else {
        return done;
    };
    let orphans: Vec<String> = idx.0["skills"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["package"].is_object())
        .filter_map(|e| e["id"].as_str().map(str::to_string))
        .filter(|id| {
            !st.items.contains_key(id)
                && std::fs::symlink_metadata(layout.skills().join(id)).is_err()
        })
        .collect();
    for id in &orphans {
        idx.remove(id);
        done.push(format!(
            "removed the index entry of {id}: no folder and no record (an interrupted install)"
        ));
    }
    let now = now_iso();
    let mut restored = Vec::new();
    for rec in st.items.values() {
        if rec.kind == "skill"
            && !rec.removed_by_user
            && idx.entry(&rec.name).is_none()
            && layout.skills().join(&rec.name).is_dir()
        {
            idx.upsert(index::package_entry(rec, "-", false, &now, None));
            restored.push(rec.name.clone());
            done.push(format!(
                "restored the index entry of {} (disabled)",
                rec.name
            ));
        }
    }
    if (!orphans.is_empty() || !restored.is_empty()) && index::write_index(layout, &idx).is_err() {
        done.push(
            "could not write skills/index.json; the reconciliation is retried at the next start"
                .into(),
        );
    }
    done
}

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

#[cfg(test)]
mod tests {
    use super::iso8601;

    #[test]
    fn iso8601_matches_javascript_to_iso_string() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        // 2024-02-29 (a leap day) 12:34:56.789 UTC.
        assert_eq!(iso8601(1_709_210_096_789), "2024-02-29T12:34:56.789Z");
        // The day after a leap day, and the end of a year.
        assert_eq!(iso8601(1_709_251_200_000), "2024-03-01T00:00:00.000Z");
        assert_eq!(iso8601(1_767_225_599_999), "2025-12-31T23:59:59.999Z");
        // Milliseconds are zero-padded.
        assert_eq!(iso8601(5_007), "1970-01-01T00:00:05.007Z");
    }
}
