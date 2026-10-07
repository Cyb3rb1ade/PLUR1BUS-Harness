//! `plur1bus backup create|verify|restore` (M8): the CLI side of the archive in `crate::backup`.
//!
//! `create` needs a running core (RULING R7: the engine snapshot goes through `admin.backup.snapshot`); `verify` and
//! `restore` are offline, and `restore` refuses while a supervisor or core answers for the home (R5).
use crate::audit;
use crate::backup::archive::verify;
use crate::backup::create::{self, Snapshot};
use crate::backup::manifest::{Manifest, SECRETS_NOTE};
use crate::backup::restore::{self, RestoreOpts, RestoreReport};
use crate::backup::{now_ms, BackupError};
use crate::cli::BackupCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::commands::module::confirm;
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The core stages the store copy before it answers; a large store takes a while.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn fail(out: &Out, e: BackupError) -> ! {
    let (code, exit) = e.code();
    out.fail(
        code,
        &e.to_string(),
        json!({ "reason": e.reason, "detail": e.detail }),
        exit,
    )
}

fn audit_line(layout: &Layout, action: &str, target: &Path, detail: Value) {
    // Best effort: the audit log is a record of a finished action, never a reason to fail it.
    if let Err(e) = audit::append(layout, action, &target.display().to_string(), detail) {
        eprintln!("plur1bus: could not write the audit log: {e}");
    }
}

fn units_line(m: &Manifest) -> String {
    m.units
        .iter()
        .map(|u| u.target.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn run(out: &Out, layout: &Layout, cmd: BackupCmd) {
    match cmd {
        BackupCmd::Create { out: dest, dry_run } => create_cmd(out, layout, dest, dry_run),
        BackupCmd::Verify { file } => {
            let m = verify(&file).unwrap_or_else(|e| fail(out, e));
            let doc = json!({
                "ok": true, "archive": file.display().to_string(), "createdAtMs": m.created_at_ms,
                "files": m.files.len(), "units": m.units.iter().map(|u| &u.target).collect::<Vec<_>>(),
                "harnessVersion": m.harness.version, "engine": m.engine, "secrets": m.secrets,
            });
            out.ok("backup.verify/1", &doc, || {
                format!(
                    "ok: {} files in {} units ({}), written by harness {}",
                    m.files.len(),
                    m.units.len(),
                    units_line(&m),
                    m.harness.version
                )
            });
        }
        BackupCmd::Restore { file, dry_run, yes } => restore_cmd(out, layout, &file, dry_run, yes),
    }
}

fn create_cmd(out: &Out, layout: &Layout, dest: Option<PathBuf>, dry_run: bool) {
    let path = dest.unwrap_or_else(|| create::default_out(layout, now_ms()));
    if path.exists() {
        fail(
            out,
            BackupError::new(
                "exists",
                format!(
                    "{} already exists; refusing to overwrite it",
                    path.display()
                ),
            ),
        );
    }
    if dry_run {
        let plain: Vec<&str> = create::plain_targets()
            .into_iter()
            .map(|(t, _)| t)
            .filter(|t| layout.home.join(t).exists())
            .collect();
        let doc = json!({
            "dryRun": true, "path": path.display().to_string(), "plain": plain,
            "staged": ["store (engine snapshot)", "memory state (engine snapshot)", "SQLite databases under state/ (backup API)"],
            "secrets": { "included": false, "note": SECRETS_NOTE },
        });
        out.ok("backup.create/1", &doc, || {
            format!(
                "would write {}\n  copied: {}\n  staged by the core: the memory store, the memory state, SQLite databases under state/\n  {SECRETS_NOTE}",
                path.display(), plain.join(", ")
            )
        });
        return;
    }
    // The core owns the snapshot (R1/R7); no core, no backup.
    let mut c = connect_core(out, layout, "backup", SNAPSHOT_TIMEOUT);
    require_supports(out, &c, "admin.backup.snapshot");
    let snap = c
        .call("admin.backup.snapshot", json!({ "label": "backup" }))
        .unwrap_or_else(|e| out.from_rpc_error(&e));
    drop(c);
    let snap = Snapshot::from_rpc(&snap).unwrap_or_else(|e| fail(out, e));
    let r = create::create(layout, &path, &snap).unwrap_or_else(|e| fail(out, e));
    audit_line(
        layout,
        "backup.create",
        &r.path,
        json!({ "files": r.files, "bytes": r.bytes, "units": r.units }),
    );
    let doc = json!({
        "path": r.path.display().to_string(), "bytes": r.bytes, "files": r.files, "units": r.units, "absent": r.absent,
        "skipped": r.skipped, "createdAtMs": r.created_at_ms, "engine": r.engine,
        "secrets": { "included": false, "note": SECRETS_NOTE },
    });
    out.ok("backup.create/1", &doc, || {
        let skipped = if r.skipped.is_empty() { String::new() } else { format!("\n  not archived (symlinks or special files): {}", r.skipped.join(", ")) };
        format!(
            "wrote {} ({} files, {} bytes)\n  units: {}{skipped}\n  {SECRETS_NOTE}\n  verify it with: plur1bus backup verify {}",
            r.path.display(), r.files, r.bytes, r.units.join(", "), r.path.display()
        )
    });
}

fn describe_restore(r: &RestoreReport) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "{} {} (backup of harness {}, this is {})\n",
        if r.dry_run {
            "would restore"
        } else {
            "restored"
        },
        r.archive,
        r.archive_harness,
        r.current_harness
    ));
    for u in &r.units {
        s.push_str(&format!("  {:<8} {}\n", u.action, u.target));
    }
    for t in &r.removed {
        s.push_str(&format!("  remove   {t} (not part of the backup)\n"));
    }
    match (&r.pre_restore, r.dry_run) {
        (Some(p), _) => s.push_str(&format!("what was replaced is kept in {p}\n")),
        (None, true) => {
            s.push_str("what is replaced would be kept in <home>/backups/pre-restore-<id>/\n")
        }
        (None, false) => {}
    }
    if !r.dry_run {
        s.push_str("start the daemon again; if the store schema is older than the engine's, run `plur1bus admin migrate`\n");
    }
    s.trim_end().to_string()
}

fn restore_cmd(out: &Out, layout: &Layout, file: &Path, dry_run: bool, yes: bool) {
    let fail_at = std::env::var("PLUR1BUS_TEST_BACKUP_FAIL_AT")
        .ok()
        .filter(|_| std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1"));
    let opts = RestoreOpts { dry_run, fail_at };
    if !dry_run {
        // Asked before anything is read or changed, after the cheap refusals: a bad archive or a running core need no answer.
        let m = verify(file).unwrap_or_else(|e| fail(out, e));
        restore::ensure_quiescent(layout).unwrap_or_else(|e| fail(out, e));
        confirm(
            out,
            &format!(
                "replace this installation's state ({}) with the backup?",
                units_line(&m)
            ),
            yes,
        );
    }
    let r = restore::restore(layout, file, &opts).unwrap_or_else(|e| fail(out, e));
    if r.applied {
        audit_line(
            layout,
            "backup.restore",
            file,
            json!({ "units": r.units.len(), "preRestore": r.pre_restore }),
        );
    }
    out.ok("backup.restore/1", &r, || describe_restore(&r));
}
