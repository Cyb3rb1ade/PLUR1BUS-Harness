//! `backup restore`: verify, plan, extract into a staging directory, swap each unit in by rename, keep what was replaced.
//!
//! A restore never writes into live state. The archive is read twice (verify, then extract, each file re-checked against its
//! digest on the way), everything lands in `<home>/.restore-<id>/`, and only then is each unit swapped by `rename`: the live
//! tree moves to `<home>/backups/pre-restore-<id>/<target>` (RULING R5: that displaced tree is the automatic pre-restore
//! backup) and the staged tree takes its place. A failure at any step puts the units already swapped back, so the old
//! state stays as it was. The core must be stopped (R5); the units are the allow-list of `manifest.rs` and nothing else.
use super::archive::{verify, visit};
use super::create::{backups_dir, Cleanup};
use super::manifest::{Kind, Manifest};
use super::{now_ms, short_id, utc_stamp, BackupError};
use crate::paths::Layout;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub struct RestoreOpts {
    pub dry_run: bool,
    /// Test seam (`PLUR1BUS_TEST_BACKUP_FAIL_AT`, honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`):
    /// `extract`, `swap:<i>` (after unit i's live tree was moved aside) or `swap-after:<i>` (after unit i was placed).
    pub fail_at: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnitPlan {
    pub target: String,
    pub kind: Kind,
    /// `replace` (a live tree exists and is moved to the pre-restore tree) or `create`.
    pub action: &'static str,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub archive: String,
    pub dry_run: bool,
    pub applied: bool,
    pub units: Vec<UnitPlan>,
    /// Known units absent at backup time that exist now: moved to the pre-restore tree.
    pub removed: Vec<String>,
    pub pre_restore: Option<String>,
    pub created_at_ms: u64,
    pub archive_harness: String,
    pub current_harness: String,
    pub store_schema: Option<String>,
}

fn live(home: &Path, target: &str) -> PathBuf {
    target.split('/').fold(home.to_path_buf(), |p, s| p.join(s))
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

pub fn plan(manifest: &Manifest, home: &Path) -> (Vec<UnitPlan>, Vec<String>) {
    let units = manifest
        .units
        .iter()
        .map(|u| UnitPlan {
            target: u.target.clone(),
            kind: u.kind,
            action: if exists(&live(home, &u.target)) { "replace" } else { "create" },
        })
        .collect();
    let removed = manifest.absent.iter().filter(|t| exists(&live(home, t))).cloned().collect();
    (units, removed)
}

/// Refuses while a supervisor or a core answers for this home (`E_LOCKED reason=core-running`).
pub fn ensure_quiescent(layout: &Layout) -> Result<(), BackupError> {
    if crate::commands::daemon::supervisor_answers(layout) {
        return Err(BackupError::new(
            "core-running",
            "a supervisor answers for this home; stop it first (plur1bus daemon stop)",
        ));
    }
    let probe = crate::supervisor::adopt::probe_core(layout, crate::supervisor::adopt::PROBE_TIMEOUT);
    if !matches!(probe, crate::supervisor::adopt::Probe::Absent) {
        return Err(BackupError::new(
            "core-running",
            "a core answers for this home; stop it first (plur1bus daemon stop, or end the `core run` process)",
        ));
    }
    Ok(())
}

fn fail_point(opts: &RestoreOpts, at: &str) -> Result<(), BackupError> {
    if opts.fail_at.as_deref() == Some(at) {
        return Err(BackupError::new("restore-failed", format!("injected failure at {at}")));
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(p: &Path, recorded: Option<u32>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    // Never wider than the owner: a restore only keeps the owner's bits, so a 0644 file comes back 0600.
    let mode = recorded.map_or(0o600, |m| (m & 0o700) | 0o600);
    fs::set_permissions(p, fs::Permissions::from_mode(mode))
}
#[cfg(not(unix))]
fn set_mode(_: &Path, _: Option<u32>) -> io::Result<()> {
    Ok(())
}

fn extract(archive: &Path, staging: &Path, opts: &RestoreOpts) -> Result<Manifest, BackupError> {
    let mut written = 0usize;
    let manifest = visit(archive, &mut |f, r| {
        let dest = live(staging, &f.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut w = crate::audit::create_private(&dest, true)?;
        io::copy(r, &mut w)?;
        w.sync_all()?;
        drop(w);
        set_mode(&dest, f.mode)?;
        written += 1;
        if written == 1 {
            fail_point(opts, "extract")?;
        }
        Ok(())
    })?;
    for u in manifest.units.iter().filter(|u| u.kind == Kind::Dir) {
        fs::create_dir_all(live(staging, &u.archive))?;
    }
    for d in &manifest.dirs {
        fs::create_dir_all(live(staging, d))?;
    }
    Ok(manifest)
}

/// One completed step of the swap, kept to undo it.
struct Done {
    live: PathBuf,
    moved_to: Option<PathBuf>,
    placed: bool,
}

fn move_aside(home: &Path, pre: &Path, target: &str) -> io::Result<Option<PathBuf>> {
    let from = live(home, target);
    if !exists(&from) {
        return Ok(None);
    }
    let to = live(pre, target);
    if let Some(p) = to.parent() {
        fs::create_dir_all(p)?;
    }
    fs::rename(&from, &to)?;
    Ok(Some(to))
}

fn swap(home: &Path, staging: &Path, pre: &Path, manifest: &Manifest, opts: &RestoreOpts, done: &mut Vec<Done>) -> Result<(), BackupError> {
    for (i, u) in manifest.units.iter().enumerate() {
        let target = live(home, &u.target);
        let moved_to = move_aside(home, pre, &u.target)?;
        done.push(Done { live: target.clone(), moved_to, placed: false });
        fail_point(opts, &format!("swap:{i}"))?;
        if let Some(p) = target.parent() {
            fs::create_dir_all(p)?;
        }
        fs::rename(live(staging, &u.archive), &target)?;
        done.last_mut().expect("just pushed").placed = true;
        fail_point(opts, &format!("swap-after:{i}"))?;
    }
    for a in &manifest.absent {
        let moved_to = move_aside(home, pre, a)?;
        if moved_to.is_some() {
            done.push(Done { live: live(home, a), moved_to, placed: false });
        }
    }
    Ok(())
}

/// Puts every swapped unit back, newest first. `Err` carries what could not be undone.
fn roll_back(done: Vec<Done>, rejected: &Path) -> Result<(), String> {
    let mut problems = Vec::new();
    for (n, d) in done.into_iter().enumerate().rev() {
        if d.placed {
            let away = rejected.join(n.to_string());
            let r = fs::create_dir_all(rejected).and_then(|_| fs::rename(&d.live, &away));
            if let Err(e) = r {
                problems.push(format!("{}: {e}", d.live.display()));
                continue;
            }
        }
        if let Some(from) = d.moved_to {
            if let Err(e) = fs::rename(&from, &d.live) {
                problems.push(format!("{} -> {}: {e}", from.display(), d.live.display()));
            }
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems.join("; ")) }
}

pub fn restore(layout: &Layout, archive: &Path, opts: &RestoreOpts) -> Result<RestoreReport, BackupError> {
    let home = &layout.home;
    let manifest = verify(archive)?;
    let (units, removed) = plan(&manifest, home);
    let mut report = RestoreReport {
        archive: archive.display().to_string(),
        dry_run: opts.dry_run,
        applied: false,
        units,
        removed,
        pre_restore: None,
        created_at_ms: manifest.created_at_ms,
        archive_harness: manifest.harness.version.clone(),
        current_harness: env!("CARGO_PKG_VERSION").to_string(),
        store_schema: manifest.engine.store_schema.clone(),
    };
    if opts.dry_run {
        return Ok(report);
    }
    ensure_quiescent(layout)?;

    let id = format!("{}-{}", utc_stamp(now_ms()), short_id());
    let staging = home.join(format!(".restore-{id}"));
    let pre = backups_dir(layout).join(format!("pre-restore-{id}"));
    fs::create_dir_all(&staging)?;
    let mut cleanup = Cleanup(staging.clone());
    extract(archive, &staging, opts)?;

    let mut done = Vec::new();
    if let Err(e) = swap(home, &staging, &pre, &manifest, opts, &mut done) {
        return match roll_back(done, &staging.join(".rejected")) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&pre);
                Err(BackupError::new("restore-failed", format!("{}; the previous state was put back untouched", e.detail)))
            }
            Err(left) => {
                // Keep the staging and pre-restore trees: they hold the only copies of whatever could not be put back.
                cleanup.0 = PathBuf::new(); // disarm: removing "" is a no-op
                Err(BackupError::new(
                    "restore-failed",
                    format!("{}; rolling back failed ({left}); the replaced state is in {} and {}", e.detail, pre.display(), staging.display()),
                ))
            }
        };
    }
    report.applied = true;
    report.pre_restore = pre.exists().then(|| pre.display().to_string());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fail_points_fire_only_where_named() {
        let o = RestoreOpts { dry_run: false, fail_at: Some("swap:1".into()) };
        assert!(fail_point(&o, "swap:0").is_ok());
        assert_eq!(fail_point(&o, "swap:1").unwrap_err().reason, "restore-failed");
    }

    #[test]
    fn roll_back_puts_moved_and_placed_units_back() {
        let d = tempfile::tempdir().unwrap();
        let (home, pre, rej) = (d.path().join("home"), d.path().join("pre"), d.path().join("rej"));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&pre).unwrap();
        // unit a: old tree moved to pre, new tree placed; unit b: only moved aside.
        fs::create_dir_all(pre.join("a")).unwrap();
        fs::write(pre.join("a/old"), "old-a").unwrap();
        fs::create_dir_all(home.join("a")).unwrap();
        fs::write(home.join("a/new"), "new").unwrap();
        fs::write(pre.join("b"), "old-b").unwrap();
        let done = vec![
            Done { live: home.join("a"), moved_to: Some(pre.join("a")), placed: true },
            Done { live: home.join("b"), moved_to: Some(pre.join("b")), placed: false },
        ];
        roll_back(done, &rej).unwrap();
        assert_eq!(fs::read_to_string(home.join("a/old")).unwrap(), "old-a");
        assert!(!home.join("a/new").exists());
        assert_eq!(fs::read_to_string(home.join("b")).unwrap(), "old-b");
    }
}
