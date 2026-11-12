//! `plur1bus backup create|verify|restore` (M8): the CLI side of the archive in `crate::backup`.
//!
//! `create` needs a running core (RULING R7: the engine snapshot goes through `admin.backup.snapshot`); `verify` and
//! `restore` are offline, and `restore` refuses while a supervisor or core answers for the home (R5).
use crate::audit;
use crate::backup::archive::verify;
use crate::backup::create::{self, CreateOpts, Snapshot};
use crate::backup::manifest::{secrets_policy_note, Manifest};
use crate::backup::restore::{self, RestoreOpts, RestoreReport};
use crate::backup::{now_ms, BackupError};
use crate::cli::BackupCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The core stages the store copy before it answers; a large store takes a while.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn fail(out: &Out, e: BackupError) -> ! {
    let (code, _) = e.code();
    out.fail(
        code,
        &e.to_string(),
        json!({ "reason": e.reason, "detail": e.detail }),
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
        BackupCmd::Create {
            out: dest,
            dry_run,
            include_api_accounts,
        } => create_cmd(
            out,
            layout,
            dest,
            dry_run,
            CreateOpts {
                include_api_accounts,
            },
        ),
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
        BackupCmd::Restore {
            file,
            dry_run,
            confirm,
            force,
            keep,
        } => restore_cmd(
            out,
            layout,
            &file,
            dry_run || !confirm,
            force,
            keep.map(|n| n as usize),
        ),
    }
}

fn create_cmd(out: &Out, layout: &Layout, dest: Option<PathBuf>, dry_run: bool, opts: CreateOpts) {
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
        let note = secrets_policy_note(opts.include_api_accounts);
        let plain: Vec<&str> = create::plain_targets()
            .into_iter()
            .map(|(t, _)| t)
            .filter(|t| layout.home.join(t).exists())
            .collect();
        let doc = json!({
            "dryRun": true, "path": path.display().to_string(), "plain": plain,
            "staged": ["store (engine snapshot)", "memory state (engine snapshot)", "SQLite databases under state/ (backup API)"],
            "secrets": { "included": false, "note": note },
        });
        out.ok("backup.create/1", &doc, || {
            format!(
                "would write {}\n  copied: {}\n  staged by the core: the memory store, the memory state, SQLite databases under state/\n  {note}",
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
    let r = create::create_with_opts(layout, &path, &snap, opts).unwrap_or_else(|e| fail(out, e));
    audit_line(
        layout,
        "backup.create",
        &r.path,
        json!({ "files": r.files, "bytes": r.bytes, "units": r.units }),
    );
    let doc = json!({
        "path": r.path.display().to_string(), "bytes": r.bytes, "files": r.files, "units": r.units, "absent": r.absent,
        "skipped": r.skipped, "createdAtMs": r.created_at_ms, "engine": r.engine,
        "secrets": { "included": false, "note": r.secrets_note },
    });
    out.ok("backup.create/1", &doc, || {
        let skipped = if r.skipped.is_empty() { String::new() } else { format!("\n  not archived (symlinks or special files): {}", r.skipped.join(", ")) };
        format!(
            "wrote {} ({} files, {} bytes)\n  units: {}{skipped}\n  {}\n  verify it with: plur1bus backup verify {}",
            r.path.display(), r.files, r.bytes, r.units.join(", "), r.secrets_note, r.path.display()
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
    // `--keep` leaves the JSON shape alone; the human text says what it did, a skipped purge is a stderr warning.
    if let Some(n) = r.keep {
        if r.dry_run {
            s.push_str(&format!(
                "with --keep {n}, only the {n} newest pre-restore copies would stay after a complete restore\n"
            ));
        } else if r.applied && r.retention_warnings.is_empty() {
            s.push_str(&format!(
                "--keep {n}: only the {n} newest pre-restore copies stay\n"
            ));
        }
    }
    if !r.dry_run {
        s.push_str("start the daemon again; if the store schema is older than the engine's, run `plur1bus admin migrate`\n");
    }
    s.trim_end().to_string()
}

fn restore_cmd(
    out: &Out,
    layout: &Layout,
    file: &Path,
    dry_run: bool,
    force: bool,
    keep: Option<usize>,
) {
    let fail_at = std::env::var("PLUR1BUS_TEST_BACKUP_FAIL_AT")
        .ok()
        .filter(|_| std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1"));
    let opts = RestoreOpts {
        dry_run,
        force,
        fail_at,
        keep,
    };
    if force {
        crate::output::say_err(if dry_run {
            "plur1bus: --force does not confirm a restore; this is a read-only plan. Apply explicitly with --confirm."
        } else {
            "plur1bus: WARNING: --force bypasses endpoint liveness probes. Stop writers before restoring; a held writer lock still refuses the restore."
        });
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
    for w in &r.retention_warnings {
        crate::output::say_err(&format!("plur1bus: WARNING: {w}"));
    }
    if !r.redacted_config_keys.is_empty() {
        crate::output::say_err(&format!(
            "plur1bus: Re-enter secret for config keys: {} (Telegram webhook secrets are regenerated automatically)",
            json!(r.redacted_config_keys)
        ));
    }
    out.ok("backup.restore/1", &r, || describe_restore(&r));
}
