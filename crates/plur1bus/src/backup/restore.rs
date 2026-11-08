//! `backup restore`: verify, plan, extract into a staging directory, swap each unit in by rename, keep what was replaced.
//!
//! A restore never writes into live state. The archive is read twice (verify, then extract, each file re-checked against its
//! digest on the way), everything lands in `<home>/.restore-<id>/`, and only then is each unit swapped by `rename`: the live
//! tree moves to `<home>/backups/pre-restore-<id>/<target>` (RULING R5: that displaced tree is the automatic pre-restore
//! backup) and the staged tree takes its place. A failure at any step puts the units already swapped back, so the old
//! state stays as it was. The core must be stopped (R5); the units are the allow-list of `manifest.rs` and nothing else.
//!
//! Forgotten memories stay forgotten: the tombstone registry (`state/_tombstones`, a sibling of the store) is not a unit,
//! so a restore never replaces it and never archives it. The restored store rows are the backup's, though, and a memory
//! forgotten after the backup is active in them again. The restore therefore leaves [`REAPPLY_MARKER`] behind (written
//! before the first swap, removed again by a clean roll-back); the next core start re-applies the committed tombstones
//! to the restored rows before it serves a recall and removes the marker once that succeeded
//! (`packages/core/src/restore-reapply.ts`).
use super::archive::{verify, visit};
use super::create::{ensure_backups_dir, Cleanup};
use super::manifest::{is_sqlite_name, redacted_config_keys, Kind, Manifest, SQLITE_SIDECARS};
use super::{now_ms, short_id, utc_stamp, BackupError};
use crate::paths::Layout;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Home-relative marker a restore leaves for the next core start: "the store rows came from a backup, re-apply the
/// committed tombstones to them". The core (`packages/core/src/restore-reapply.ts`) reads the same path.
pub const REAPPLY_MARKER: &str = "state/.restore-reapply-tombstones";
/// Schema id in the marker's JSON body; the core only checks that the file exists and reads the time for its log line.
const REAPPLY_MARKER_SCHEMA: &str = "plur1bus.restore-reapply-tombstones/1";

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
    /// Guidance for CLI stderr only; the JSON result shape remains unchanged (owner SH2 ruling).
    #[serde(skip)]
    pub redacted_config_keys: Vec<String>,
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
            action: if exists(&live(home, &u.target)) {
                "replace"
            } else {
                "create"
            },
        })
        .collect();
    let removed = manifest
        .absent
        .iter()
        .filter(|t| exists(&live(home, t)))
        .cloned()
        .collect();
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
    let probe =
        crate::supervisor::adopt::probe_core(layout, crate::supervisor::adopt::PROBE_TIMEOUT);
    if !matches!(probe, crate::supervisor::adopt::Probe::Absent) {
        return Err(BackupError::new(
            "core-running",
            "a core answers for this home; stop it first (plur1bus daemon stop, or end the `core run` process)",
        ));
    }
    drop(hold_legacy_lock(layout)?);
    Ok(())
}

/// Phase 4 (P4-10 security review M3): behind the Rust front door the TypeScript core runs as `core-legacy` and holds
/// `run/core-legacy.lock` for its whole life. When the front door dies abruptly, nothing answers on the core's address any
/// more while that legacy core may still be stopping and writing the stores, so the probes above see no core. Its lock
/// is taken here without waiting and held for the restore (`core-running` while it is held). A legacy core creates the
/// file before it opens a store and it is never removed, so where it does not exist no legacy core ever got that far:
/// nothing to take, and a refused restore leaves the home byte for byte as it was. The restore takes no other lock, so
/// the order every holder follows (`state/core.lock`, then `run/core-legacy.lock`) cannot deadlock with it.
fn hold_legacy_lock(
    layout: &Layout,
) -> Result<Option<plur1bus_audit::lock::CoreLock>, BackupError> {
    let path = layout.run().join("core-legacy.lock");
    if path.symlink_metadata().is_err() {
        return Ok(None);
    }
    match plur1bus_audit::lock::CoreLock::try_acquire(&path) {
        Ok(Some(lock)) => Ok(Some(lock)),
        Ok(None) => Err(BackupError::new(
            "core-running",
            "a legacy core behind a stopped front door still holds run/core-legacy.lock; wait until it has stopped",
        )),
        Err(e) => Err(BackupError::new(
            "core-running",
            format!("run/core-legacy.lock cannot be checked ({e}); refusing to restore"),
        )),
    }
}

fn fail_point(opts: &RestoreOpts, at: &str) -> Result<(), BackupError> {
    if opts.fail_at.as_deref() == Some(at) {
        return Err(BackupError::new(
            "restore-failed",
            format!("injected failure at {at}"),
        ));
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
    private_dirs(staging)?;
    Ok(manifest)
}

/// Directories this restore created are private to the user (0700 on unix; Windows inherits the home's ACL).
#[cfg(unix)]
fn private_dirs(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    for e in fs::read_dir(dir)? {
        let e = e?;
        if e.file_type()?.is_dir() {
            private_dirs(&e.path())?;
        }
    }
    Ok(())
}
#[cfg(not(unix))]
fn private_dirs(_: &Path) -> io::Result<()> {
    Ok(())
}

/// Writes [`REAPPLY_MARKER`] (private, fsynced) and returns whether this call created it. A marker that is already there
/// belongs to an earlier restore whose re-apply is still owed: it is kept as it is and a roll-back of this restore must
/// not remove it.
fn write_reapply_marker(home: &Path) -> io::Result<bool> {
    fn create(path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::json!({ "schema": REAPPLY_MARKER_SCHEMA, "restoredAtMs": now_ms() });
        let mut w = crate::audit::create_private(path, true)?;
        io::Write::write_all(&mut w, body.to_string().as_bytes())?;
        w.sync_all()
    }
    let path = live(home, REAPPLY_MARKER);
    if exists(&path) {
        return Ok(false);
    }
    if let Err(e) = create(&path) {
        let _ = fs::remove_file(&path); // never leave half a marker behind a refused restore
        return Err(e);
    }
    Ok(true)
}

/// One completed step of the swap, kept to undo it.
struct Done {
    live: PathBuf,
    moved_to: Option<PathBuf>,
    placed: bool,
}

/// `create_dir_all`, with every directory it creates private to the user (0700 on unix, whatever the umask; Windows inherits
/// the home's ACL). The pre-restore tree holds the replaced live state: `config.json`, the API accounts database.
fn create_private_dirs(dir: &Path) -> io::Result<()> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
}

fn move_aside(home: &Path, pre: &Path, target: &str) -> io::Result<Option<PathBuf>> {
    let from = live(home, target);
    if !exists(&from) {
        return Ok(None);
    }
    let to = live(pre, target);
    if let Some(p) = to.parent() {
        create_private_dirs(p)?;
    }
    fs::rename(&from, &to)?;
    Ok(Some(to))
}

fn swap(
    home: &Path,
    staging: &Path,
    pre: &Path,
    manifest: &Manifest,
    opts: &RestoreOpts,
    done: &mut Vec<Done>,
) -> Result<(), BackupError> {
    for (i, u) in manifest.units.iter().enumerate() {
        let target = live(home, &u.target);
        let moved_to = move_aside(home, pre, &u.target)?;
        let unit_idx = done.len();
        done.push(Done {
            live: target.clone(),
            moved_to,
            placed: false,
        });
        // A `-wal`/`-shm`/`-journal` left next to a database that is being replaced belongs to the OLD file: SQLite
        // could replay it onto the restored one. It goes aside with the old tree (and comes back on a roll-back).
        if u.kind == Kind::File && is_sqlite_name(&u.target) {
            for sfx in SQLITE_SIDECARS {
                let side = format!("{}{sfx}", u.target);
                if let Some(to) = move_aside(home, pre, &side)? {
                    done.push(Done {
                        live: live(home, &side),
                        moved_to: Some(to),
                        placed: false,
                    });
                }
            }
        }
        fail_point(opts, &format!("swap:{i}"))?;
        if let Some(p) = target.parent() {
            fs::create_dir_all(p)?;
        }
        fs::rename(live(staging, &u.archive), &target)?;
        done[unit_idx].placed = true;
        fail_point(opts, &format!("swap-after:{i}"))?;
    }
    for a in &manifest.absent {
        let moved_to = move_aside(home, pre, a)?;
        if moved_to.is_some() {
            done.push(Done {
                live: live(home, a),
                moved_to,
                placed: false,
            });
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
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

pub fn restore(
    layout: &Layout,
    archive: &Path,
    opts: &RestoreOpts,
) -> Result<RestoreReport, BackupError> {
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
        redacted_config_keys: redacted_config_keys(&manifest.secrets.note)?,
    };
    if opts.dry_run {
        return Ok(report);
    }
    ensure_quiescent(layout)?;
    // Held until the restore returns: no legacy core that outlived its front door writes the units being swapped.
    let _legacy = hold_legacy_lock(layout)?;

    let id = format!("{}-{}", utc_stamp(now_ms()), short_id());
    let staging = home.join(format!(".restore-{id}"));
    // `backups/` holds the replaced state below: private, like `create` makes it (it may not exist yet, or have been made
    // under the umask by an older restore).
    let pre = ensure_backups_dir(layout)?.join(format!("pre-restore-{id}"));
    create_private_dirs(&staging)?;
    let mut cleanup = Cleanup(staging.clone());
    extract(archive, &staging, opts)?;
    // A webhook secret `create` redacted gets a fresh value here, never the placeholder the archive carries.
    super::redact::refill_staged_config(&staging)?;

    // Before the first swap: a restore that dies half-way must not leave swapped rows without the marker. Nothing in the
    // home has changed yet, so a failure here is a plain refusal (the marker is the only thing it may have created).
    let marker_created = write_reapply_marker(home)?;
    let mut done = Vec::new();
    if let Err(e) = swap(home, &staging, &pre, &manifest, opts, &mut done) {
        return match roll_back(done, &staging.join(".rejected")) {
            Ok(()) => {
                if marker_created {
                    let _ = fs::remove_file(live(home, REAPPLY_MARKER));
                }
                let _ = fs::remove_dir_all(&pre);
                Err(BackupError::new(
                    "restore-failed",
                    format!("{}; the previous state was put back untouched", e.detail),
                ))
            }
            Err(left) => {
                // Keep the staging and pre-restore trees: they hold the only copies of whatever could not be put back.
                // The marker stays too: the store may be the restored one, and the re-apply is idempotent.
                cleanup.0 = PathBuf::new(); // disarm: removing "" is a no-op
                Err(BackupError::new(
                    "restore-failed",
                    format!(
                        "{}; rolling back failed ({left}); the replaced state is in {} and {}",
                        e.detail,
                        pre.display(),
                        staging.display()
                    ),
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
    use super::super::create::{self, CreateOpts, SnapFile};
    use super::*;
    use std::collections::BTreeMap;

    fn account_archive(root: &Path, opts: CreateOpts, accounts: Option<&[u8]>) -> PathBuf {
        let source = Layout::new(root.join("src"));
        let mut snapshot = create::testkit::staged(&source, b"BACKED-UP-DB", false);
        if let Some(bytes) = accounts {
            let path = snapshot.dir.join("sqlite/api/accounts.db");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            let (sha256, bytes) = super::super::archive::hash_file(&path).unwrap();
            snapshot.files.push(SnapFile {
                path: "sqlite/api/accounts.db".into(),
                bytes,
                sha256,
            });
        }
        let archive = root.join("accounts.tar.gz");
        create::create_with_opts(&source, &archive, &snapshot, opts).unwrap();
        assert!(
            !snapshot.dir.exists(),
            "private Core staging is cleaned after selection"
        );
        archive
    }

    fn live_api_state(destination: &Layout) -> BTreeMap<String, Vec<u8>> {
        let mut state = BTreeMap::new();
        for name in [
            "accounts.db",
            "accounts.db-wal",
            "accounts.db-shm",
            "accounts.db-journal",
            "neighbor.json",
        ] {
            let relative = format!("state/api/{name}");
            let path = destination.home.join(&relative);
            let bytes = uuid::Uuid::new_v4().to_string().into_bytes();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, &bytes).unwrap();
            state.insert(relative, bytes);
        }
        fs::write(destination.state().join("budget.sqlite"), b"LIVE-DB").unwrap();
        state
    }

    fn assert_api_state(destination: &Layout, expected: &BTreeMap<String, Vec<u8>>) {
        for (relative, bytes) in expected {
            assert_eq!(
                fs::read(destination.home.join(relative)).unwrap(),
                *bytes,
                "{relative}"
            );
        }
    }

    #[test]
    fn default_account_omission_preserves_live_api_bytes_and_produces_no_account_restore_action() {
        let root = tempfile::tempdir().unwrap();
        let incoming = uuid::Uuid::new_v4();
        let archive = account_archive(
            root.path(),
            CreateOpts::default(),
            Some(incoming.as_bytes()),
        );
        let destination = Layout::new(root.path().join("dst"));
        let before = live_api_state(&destination);
        let dry = restore(
            &destination,
            &archive,
            &RestoreOpts {
                dry_run: true,
                fail_at: None,
            },
        )
        .unwrap();
        assert!(!dry.applied && dry.pre_restore.is_none());
        assert!(dry
            .units
            .iter()
            .all(|unit| !unit.target.starts_with("state/api/")));
        assert!(dry
            .removed
            .iter()
            .all(|target| !target.starts_with("state/api/")));
        assert_api_state(&destination, &before);
        assert_eq!(
            fs::read(destination.state().join("budget.sqlite")).unwrap(),
            b"LIVE-DB"
        );
        assert!(!destination.home.join("backups").exists());
        let applied = apply(&destination, &archive, None).unwrap();
        assert_api_state(&destination, &before);
        assert_eq!(
            fs::read(destination.state().join("budget.sqlite")).unwrap(),
            b"BACKED-UP-DB"
        );
        let pre = PathBuf::from(
            applied
                .pre_restore
                .expect("the selected budget DB was displaced"),
        );
        assert_eq!(
            fs::read(pre.join("state/budget.sqlite")).unwrap(),
            b"LIVE-DB"
        );
        assert!(
            !pre.join("state/api").exists(),
            "default omission must not move API files aside"
        );
    }

    #[test]
    fn missing_source_accounts_preserve_destination_for_both_creation_policies() {
        for include_api_accounts in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let archive = account_archive(
                root.path(),
                CreateOpts {
                    include_api_accounts,
                },
                None,
            );
            let manifest = verify(&archive).unwrap();
            assert!(manifest
                .units
                .iter()
                .all(|unit| unit.target != "state/api/accounts.db"));
            assert!(manifest
                .absent
                .iter()
                .all(|target| target != "state/api/accounts.db"));
            let destination = Layout::new(root.path().join("dst"));
            let before = live_api_state(&destination);
            let report = apply(&destination, &archive, None).unwrap();
            assert!(report.applied);
            assert_api_state(&destination, &before);
            assert!(report
                .units
                .iter()
                .all(|unit| !unit.target.starts_with("state/api/")));
            let pre = PathBuf::from(
                report
                    .pre_restore
                    .expect("the selected budget DB was displaced"),
            );
            assert!(!pre.join("state/api").exists());
        }
    }

    #[test]
    fn opted_in_accounts_replace_the_database_and_keep_displaced_sidecars_for_recovery() {
        let root = tempfile::tempdir().unwrap();
        let incoming = uuid::Uuid::new_v4().to_string().into_bytes();
        let archive = account_archive(
            root.path(),
            CreateOpts {
                include_api_accounts: true,
            },
            Some(&incoming),
        );
        let destination = Layout::new(root.path().join("dst"));
        let before = live_api_state(&destination);
        let report = apply(&destination, &archive, None).unwrap();
        assert_eq!(
            fs::read(destination.home.join("state/api/accounts.db")).unwrap(),
            incoming
        );
        let pre = PathBuf::from(report.pre_restore.expect("old account bytes are retained"));
        for (relative, bytes) in before {
            if relative.ends_with("neighbor.json") {
                assert_eq!(fs::read(destination.home.join(&relative)).unwrap(), bytes);
                assert!(!pre.join(relative).exists());
            } else {
                assert_eq!(fs::read(pre.join(&relative)).unwrap(), bytes, "{relative}");
                if relative != "state/api/accounts.db" {
                    assert!(!destination.home.join(relative).exists());
                }
            }
        }
    }

    #[test]
    fn opted_in_account_rollback_restores_all_old_api_bytes_before_and_after_placement() {
        let root = tempfile::tempdir().unwrap();
        let incoming = uuid::Uuid::new_v4();
        let archive = account_archive(
            root.path(),
            CreateOpts {
                include_api_accounts: true,
            },
            Some(incoming.as_bytes()),
        );
        let manifest = verify(&archive).unwrap();
        let index = manifest
            .units
            .iter()
            .position(|unit| unit.target == "state/api/accounts.db")
            .unwrap();
        let destination = Layout::new(root.path().join("dst"));
        let before = live_api_state(&destination);
        for phase in ["swap", "swap-after"] {
            let point = format!("{phase}:{index}");
            let error = apply(&destination, &archive, Some(&point)).unwrap_err();
            assert_eq!(error.reason, "restore-failed", "{point}");
            assert_api_state(&destination, &before);
            assert_eq!(
                fs::read(destination.state().join("budget.sqlite")).unwrap(),
                b"LIVE-DB"
            );
            assert!(!destination
                .state()
                .join(".restore-reapply-tombstones")
                .exists());
            assert_eq!(
                fs::read_dir(destination.home.join("backups"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }

    fn archive_of_a_fresh_home(d: &Path) -> (PathBuf, Layout) {
        use super::super::create::{create, testkit};
        let src = Layout::new(d.join("src"));
        let snap = testkit::staged(&src, b"BACKED-UP-DB", false);
        let out = d.join("backup.tar.gz");
        create(&src, &out, &snap).expect("create on a fresh home");
        // The target: a live database that is still in WAL use (a crash left its sidecars behind).
        let dst = Layout::new(d.join("dst"));
        fs::create_dir_all(dst.state()).unwrap();
        for (n, c) in [
            ("budget.sqlite", "LIVE-DB"),
            ("budget.sqlite-wal", "STALE-WAL"),
            ("budget.sqlite-shm", "STALE-SHM"),
        ] {
            fs::write(dst.state().join(n), c).unwrap();
        }
        (out, dst)
    }

    #[test]
    fn a_restore_sets_stale_sqlite_sidecars_aside_so_they_cannot_be_replayed_onto_the_restored_database(
    ) {
        let d = tempfile::tempdir().unwrap();
        let (out, dst) = archive_of_a_fresh_home(d.path());
        let report = restore(
            &dst,
            &out,
            &RestoreOpts {
                dry_run: false,
                fail_at: None,
            },
        )
        .unwrap();
        assert!(report.applied);
        let st = dst.state();
        assert_eq!(fs::read(st.join("budget.sqlite")).unwrap(), b"BACKED-UP-DB");
        assert!(!exists(&st.join("budget.sqlite-wal")) && !exists(&st.join("budget.sqlite-shm")));
        let pre = PathBuf::from(report.pre_restore.expect("the replaced state is kept"));
        assert_eq!(
            fs::read(pre.join("state/budget.sqlite")).unwrap(),
            b"LIVE-DB"
        );
        assert_eq!(
            fs::read(pre.join("state/budget.sqlite-wal")).unwrap(),
            b"STALE-WAL"
        );
        assert_eq!(
            fs::read(pre.join("state/budget.sqlite-shm")).unwrap(),
            b"STALE-SHM"
        );
    }

    #[test]
    fn a_failed_restore_puts_the_database_and_its_sidecars_back_untouched() {
        let d = tempfile::tempdir().unwrap();
        let (out, dst) = archive_of_a_fresh_home(d.path());
        for at in ["swap:1", "swap-after:1"] {
            let err = restore(
                &dst,
                &out,
                &RestoreOpts {
                    dry_run: false,
                    fail_at: Some(at.into()),
                },
            )
            .unwrap_err();
            assert_eq!(err.reason, "restore-failed", "{at}");
            let st = dst.state();
            for (n, c) in [
                ("budget.sqlite", "LIVE-DB"),
                ("budget.sqlite-wal", "STALE-WAL"),
                ("budget.sqlite-shm", "STALE-SHM"),
            ] {
                assert_eq!(fs::read_to_string(st.join(n)).unwrap(), c, "{at}: {n}");
            }
        }
    }

    const REGISTRY_LINE: &str =
        "{\"schemaVersion\":1,\"status\":\"committed\",\"memoryId\":\"m-1\"}\n";

    /// A live tombstone registry next to the store, as the engine keeps it (`state/_tombstones/<agent>.jsonl`).
    fn with_registry(dst: &Layout) -> PathBuf {
        let dir = dst.state().join("_tombstones");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("bernd.jsonl"), REGISTRY_LINE).unwrap();
        dir
    }

    fn apply(
        dst: &Layout,
        out: &Path,
        fail_at: Option<&str>,
    ) -> Result<RestoreReport, BackupError> {
        restore(
            dst,
            out,
            &RestoreOpts {
                dry_run: false,
                fail_at: fail_at.map(String::from),
            },
        )
    }

    #[test]
    fn a_restore_keeps_the_tombstone_registry_and_leaves_the_reapply_marker() {
        let d = tempfile::tempdir().unwrap();
        let (out, dst) = archive_of_a_fresh_home(d.path());
        let registry = with_registry(&dst);
        let report = apply(&dst, &out, None).unwrap();
        assert!(report.applied);
        // The registry is not a unit: it is neither replaced nor moved aside, so what was forgotten stays on record.
        assert_eq!(
            fs::read_to_string(registry.join("bernd.jsonl")).unwrap(),
            REGISTRY_LINE
        );
        let marker = live(&dst.home, REAPPLY_MARKER);
        let body: serde_json::Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        assert_eq!(body["schema"], REAPPLY_MARKER_SCHEMA);
        assert!(body["restoredAtMs"].as_u64().unwrap() > 0, "{body}");
        let pre = PathBuf::from(report.pre_restore.expect("the replaced state is kept"));
        assert!(!exists(&pre.join("state/_tombstones")));
        assert!(!exists(&pre.join(REAPPLY_MARKER)));
    }

    #[test]
    fn a_dry_run_and_a_failed_extraction_leave_no_marker() {
        let d = tempfile::tempdir().unwrap();
        let (out, dst) = archive_of_a_fresh_home(d.path());
        let marker = live(&dst.home, REAPPLY_MARKER);
        let report = restore(
            &dst,
            &out,
            &RestoreOpts {
                dry_run: true,
                fail_at: None,
            },
        )
        .unwrap();
        assert!(!report.applied);
        assert!(!exists(&marker), "a dry run changes nothing");
        assert_eq!(
            apply(&dst, &out, Some("extract")).unwrap_err().reason,
            "restore-failed"
        );
        assert!(!exists(&marker), "nothing was swapped, nothing is owed");
    }

    #[test]
    fn a_rolled_back_restore_removes_the_marker_it_wrote() {
        let d = tempfile::tempdir().unwrap();
        let (out, dst) = archive_of_a_fresh_home(d.path());
        let marker = live(&dst.home, REAPPLY_MARKER);
        for at in ["swap:0", "swap-after:0", "swap:1", "swap-after:1"] {
            assert_eq!(
                apply(&dst, &out, Some(at)).unwrap_err().reason,
                "restore-failed",
                "{at}"
            );
            assert!(
                !exists(&marker),
                "{at}: the old rows are back, nothing is owed"
            );
        }
    }

    #[test]
    fn a_marker_from_an_earlier_restore_is_kept_whatever_this_restore_does() {
        let d = tempfile::tempdir().unwrap();
        let (out, dst) = archive_of_a_fresh_home(d.path());
        let marker = live(&dst.home, REAPPLY_MARKER);
        fs::write(&marker, "earlier").unwrap();
        apply(&dst, &out, Some("swap:1")).unwrap_err();
        assert_eq!(
            fs::read_to_string(&marker).unwrap(),
            "earlier",
            "rolled back"
        );
        apply(&dst, &out, None).unwrap();
        assert_eq!(fs::read_to_string(&marker).unwrap(), "earlier", "applied");
    }

    #[cfg(unix)]
    #[test]
    fn backups_and_the_pre_restore_tree_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let (out, dst) = archive_of_a_fresh_home(d.path());
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        // A `backups/` that an older restore (or the user) left open is tightened, not trusted.
        let backups = dst.home.join("backups");
        fs::create_dir_all(&backups).unwrap();
        fs::set_permissions(&backups, fs::Permissions::from_mode(0o755)).unwrap();
        let report = restore(
            &dst,
            &out,
            &RestoreOpts {
                dry_run: false,
                fail_at: None,
            },
        )
        .unwrap();
        let pre = PathBuf::from(report.pre_restore.expect("the replaced state is kept"));
        assert_eq!(mode(&backups), 0o700, "backups/");
        assert_eq!(mode(&pre), 0o700, "{}", pre.display());
        // Every directory the restore made below it (the replaced state includes config.json and the account database).
        fn dirs(p: &Path, out: &mut Vec<PathBuf>) {
            for e in fs::read_dir(p).unwrap() {
                let e = e.unwrap();
                if e.file_type().unwrap().is_dir() {
                    out.push(e.path());
                    dirs(&e.path(), out);
                }
            }
        }
        let mut below = Vec::new();
        dirs(&pre, &mut below);
        assert!(!below.is_empty(), "the replaced database sits in pre/state");
        for p in below {
            assert_eq!(mode(&p), 0o700, "{}", p.display());
        }
        // And nothing else of the restore is left behind readable: the staging tree is gone.
        assert!(!fs::read_dir(&dst.home).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".restore-")
        }));
    }

    #[test]
    fn fail_points_fire_only_where_named() {
        let o = RestoreOpts {
            dry_run: false,
            fail_at: Some("swap:1".into()),
        };
        assert!(fail_point(&o, "swap:0").is_ok());
        assert_eq!(
            fail_point(&o, "swap:1").unwrap_err().reason,
            "restore-failed"
        );
    }

    #[test]
    fn roll_back_puts_moved_and_placed_units_back() {
        let d = tempfile::tempdir().unwrap();
        let (home, pre, rej) = (
            d.path().join("home"),
            d.path().join("pre"),
            d.path().join("rej"),
        );
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&pre).unwrap();
        // unit a: old tree moved to pre, new tree placed; unit b: only moved aside.
        fs::create_dir_all(pre.join("a")).unwrap();
        fs::write(pre.join("a/old"), "old-a").unwrap();
        fs::create_dir_all(home.join("a")).unwrap();
        fs::write(home.join("a/new"), "new").unwrap();
        fs::write(pre.join("b"), "old-b").unwrap();
        let done = vec![
            Done {
                live: home.join("a"),
                moved_to: Some(pre.join("a")),
                placed: true,
            },
            Done {
                live: home.join("b"),
                moved_to: Some(pre.join("b")),
                placed: false,
            },
        ];
        roll_back(done, &rej).unwrap();
        assert_eq!(fs::read_to_string(home.join("a/old")).unwrap(), "old-a");
        assert!(!home.join("a/new").exists());
        assert_eq!(fs::read_to_string(home.join("b")).unwrap(), "old-b");
    }
}
