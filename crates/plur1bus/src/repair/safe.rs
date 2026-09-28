//! The repair steps of 2a-H3b-b Task 7 (HB16): permissions, stale run files, config restore, service renewal and the
//! runtime reinstalls. None of them touches `state/`. Each returns the evidence of what it did as the step's `detail`.
use super::{Ctx, Step};
use crate::commands::config::{self as config_cmd, Route};
use crate::commands::firstaid::pid_alive;
use crate::install::setup::{self, CoreSource};
use crate::install::{manifest, pins, targets::Target};
use plur1bus_config as cfg;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long `config.restore` waits for a running supervisor to take the restored file (its watcher polls config.json
/// every second at most) and to re-arm a core that stopped on the broken one (B18).
const SUPERVISOR_ACCEPT_WAIT: Duration = Duration::from_secs(10);
/// The connect probe of a socket that may still have a live server behind it.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

#[cfg(unix)]
pub const PERMISSIONS_ACTION: &str = "chmod run/ 0700 and its token and pid files 0600";
#[cfg(not(unix))]
pub const PERMISSIONS_ACTION: &str =
    "restrict run/ (inheritable) and its token and pid files to the user and SYSTEM";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn io_msg(path: &Path, e: io::Error) -> String {
    format!("{}: {e}", path.display())
}

// ---- run.permissions.fix ---------------------------------------------------------------------------------------

/// The token and pid files in `run/`, sorted.
fn run_secret_files(run: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(run)
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".token") || n.ends_with(".pid"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// unix: `run/` 0700, every token and pid file in it 0600. Windows: `run/` gets the protected, inheritable
/// user-and-SYSTEM DACL the supervisor sets at start (HB5), and each token and pid file is reset to inherit exactly
/// that DACL (no explicit ACE, not protected) instead of receiving an explicit DACL of its own: resetting needs only
/// `READ_CONTROL | WRITE_DAC`, which the user holds on its own files, and it leaves the files as the ones a child
/// creates in a secured `run/`. The directory goes first, so the files inherit its new ACEs. A file another process
/// holds locked (a sharing or lock violation) is left as it is and reported in `inUse`; any other error fails the
/// step after every file was tried.
pub fn fix_run_permissions(ctx: &Ctx, _step: &Step) -> Result<Value, String> {
    let run = ctx.layout.run();
    if !run.is_dir() {
        return Ok(json!({ "files": [], "note": "run/ does not exist" }));
    }
    let files = run_secret_files(&run);
    let mut fixed: Vec<String> = Vec::new();
    #[allow(unused_mut)] // only the Windows branch finds locked files
    let mut in_use: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&run, fs::Permissions::from_mode(0o700))
            .map_err(|e| io_msg(&run, e))?;
        for f in &files {
            let p = run.join(f);
            match fs::set_permissions(&p, fs::Permissions::from_mode(0o600)) {
                Ok(()) => fixed.push(f.clone()),
                Err(e) => errors.push(io_msg(&p, e)),
            }
        }
    }
    #[cfg(windows)]
    {
        let sid = plur1bus_rpc::win::user_sid().map_err(|e| format!("user SID: {e}"))?;
        plur1bus_rpc::win::set_path_dacl(&run, &plur1bus_rpc::acl::run_dir_sddl(&sid))
            .map_err(|e| io_msg(&run, e))?;
        for f in &files {
            let p = run.join(f);
            match plur1bus_rpc::win::inherit_path_dacl(&p) {
                Ok(()) => fixed.push(f.clone()),
                Err(e) if is_locked(&e) => in_use.push(f.clone()),
                Err(e) => errors.push(io_msg(&p, e)),
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(json!({ "files": fixed, "inUse": in_use }))
}

/// `ERROR_SHARING_VIOLATION` (32) or `ERROR_LOCK_VIOLATION` (33): another process holds the file.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_locked(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(32 | 33))
}

// ---- run.stale-files.remove ------------------------------------------------------------------------------------

/// The run files this step may ever remove: a pid file or a socket of the core, the supervisor or a module. Never a
/// token, `supervisor.lock` or anything else.
fn removable(name: &str) -> bool {
    let stem = name
        .strip_suffix(".pid")
        .or_else(|| name.strip_suffix(".sock"));
    let Some(stem) = stem else {
        return false;
    };
    let module = stem.strip_prefix("module-").is_some_and(|m| {
        !m.is_empty()
            && m.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    stem == "core" || stem == "supervisor" || module
}

/// Why `run/<name>` must stay, or `None` when nothing lives behind it: re-checked right before the removal
/// (Review Focus 3), so a process that started since the check keeps its files.
fn live_reason(run: &Path, name: &str) -> Option<&'static str> {
    let path = run.join(name);
    if name.ends_with(".pid") {
        let pid = fs::read_to_string(&path)
            .ok()
            .and_then(|t| t.split_whitespace().next()?.parse::<u32>().ok());
        return match pid {
            Some(p) if pid_alive(p) => Some("process-alive"),
            _ => None,
        };
    }
    // A socket: something accepting a connection on it is alive.
    let address = path.to_string_lossy();
    plur1bus_rpc::transport::connect(&address, PROBE_TIMEOUT)
        .is_ok()
        .then_some("listening")
}

/// Removes the planned stale files that still have no live peer.
pub fn remove_stale_files(ctx: &Ctx, step: &Step) -> Result<Value, String> {
    let run = ctx.layout.run();
    let planned: Vec<String> = step
        .detail
        .as_ref()
        .and_then(|d| d["files"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|f| f.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    for name in planned {
        if !removable(&name) {
            kept.push(json!({ "file": name, "why": "not-a-run-endpoint" }));
            continue;
        }
        if let Some(why) = live_reason(&run, &name) {
            kept.push(json!({ "file": name, "why": why }));
            continue;
        }
        let p = run.join(&name);
        match fs::remove_file(&p) {
            Ok(()) => removed.push(name),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                kept.push(json!({ "file": name, "why": "already-gone" }))
            }
            Err(e) => return Err(io_msg(&p, e)),
        }
    }
    Ok(json!({ "removed": removed, "kept": kept }))
}

// ---- config.restore ----------------------------------------------------------------------------------------------

/// Writes `bytes` to `path` atomically: `<name>.tmp-<pid>` (private), fsync, rename, directory fsync (unix).
fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
    let written = (|| {
        let mut f = crate::audit::create_private(&tmp, true)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// Keeps the broken config.json as `config.json.rejected-<ms>` (the name the supervisor uses for the same backup),
/// private to the user. `None` when there was no file to keep.
fn back_up_broken(path: &Path) -> Result<Option<PathBuf>, String> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_msg(path, e)),
    };
    let backup = path.with_file_name(format!("config.json.rejected-{}", now_ms()));
    write_atomic_bytes(&backup, &bytes).map_err(|e| io_msg(&backup, e))?;
    Ok(Some(backup))
}

/// `config.json.bak-*` beside `path`, newest first: by the numeric suffix, then by modification time.
fn backups_newest_first(path: &Path) -> Vec<PathBuf> {
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let mut found: Vec<(u64, SystemTime, PathBuf)> = fs::read_dir(dir)
        .map(|d| {
            d.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let suffix = name.strip_prefix("config.json.bak-")?;
                    if suffix.contains(".tmp-") {
                        return None;
                    }
                    let meta = e.metadata().ok().filter(|m| m.is_file())?;
                    Some((
                        suffix.parse::<u64>().unwrap_or(0),
                        meta.modified().unwrap_or(UNIX_EPOCH),
                        e.path(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort_by_key(|f| std::cmp::Reverse((f.0, f.1)));
    found.into_iter().map(|(_, _, p)| p).collect()
}

/// The newest `config.json.bak-*` that validates, with its bytes.
fn newest_valid_backup(path: &Path) -> Option<(PathBuf, Vec<u8>)> {
    backups_newest_first(path).into_iter().find_map(|p| {
        let bytes = fs::read(&p).ok()?;
        let text = std::str::from_utf8(&bytes).ok()?;
        cfg::parse(text).ok()?;
        Some((p, bytes))
    })
}

/// Waits until the supervisor has taken the restored file (no pending rejection, a running revision) and no longer
/// holds the core stopped for `config-invalid` (B18 re-arms it). `true` when both happened in time.
fn wait_supervisor_accepts(client: &mut plur1bus_rpc::Client) -> bool {
    let deadline = Instant::now() + SUPERVISOR_ACCEPT_WAIT;
    loop {
        if let Ok(s) = client.call("daemon.status", json!({})) {
            let accepted =
                !s["config"]["rejected"].is_object() && s["config"]["revision"].is_string();
            let held = crate::commands::daemon::core_child(&s).is_some_and(|c| {
                c["process"]["state"] == "crashed"
                    && c["process"]["reason"] == "config-invalid"
                    && c["nextRestartAt"].is_null()
            });
            if accepted && !held {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A supervisor that answers: the broken file is backed up and the configuration it runs (`config.get`) is written
/// in its place, which re-arms a core stopped on it (B18). No supervisor, or one that runs no valid configuration:
/// the newest `config.json.bak-*` that validates. A supervisor that does not answer: nothing is written (B6).
pub fn restore_config(ctx: &Ctx, _step: &Step) -> Result<Value, String> {
    let path = ctx.layout.config_path();
    let mut client = match config_cmd::route(ctx.layout) {
        Ok(Route::Supervisor(c)) => Some(c),
        Ok(Route::Direct) => None,
        Err(e) => return Err(format!("{e}; nothing was changed")),
    };
    let running = client
        .as_mut()
        .and_then(|c| config_cmd::call(c, "config.get", json!({})).ok())
        .map(|r| r["value"].clone())
        .filter(Value::is_object);
    let mut detail = match running {
        Some(config) => {
            let backup = back_up_broken(&path)?;
            cfg::write_atomic(&path, &config).map_err(|e| io_msg(&path, e))?;
            json!({ "source": "supervisor", "backup": backup })
        }
        None => {
            let (from, bytes) = newest_valid_backup(&path).ok_or_else(|| {
                "no running configuration to restore and no config.json.bak-* that validates; fix config.json by hand"
                    .to_string()
            })?;
            let backup = back_up_broken(&path)?;
            write_atomic_bytes(&path, &bytes).map_err(|e| io_msg(&path, e))?;
            json!({ "source": "backup", "from": from, "backup": backup })
        }
    };
    if let Some(c) = client.as_mut() {
        detail["accepted"] = json!(wait_supervisor_accepts(c));
    }
    Ok(detail)
}

// ---- service.renew -------------------------------------------------------------------------------------------------

/// Rewrites the home's unit and registers it without starting it (`service::install(runner, unit, false)`).
pub fn renew_service(ctx: &Ctx, _step: &Step) -> Result<Value, String> {
    let manager = crate::service::Manager::current();
    let bin =
        std::env::current_exe().map_err(|e| format!("cannot locate the plur1bus binary: {e}"))?;
    let name = crate::service::service_name(ctx.layout, &crate::paths::default_home());
    let unit =
        crate::service::render(manager, &bin, ctx.layout, &name, &[]).map_err(|e| e.to_string())?;
    // launchd opens StandardErrorPath there before `supervise` creates the directory itself.
    let logs = ctx.layout.logs();
    fs::create_dir_all(&logs).map_err(|e| io_msg(&logs, e))?;
    crate::service::install(ctx.runner, &unit, false).map_err(|e| e.to_string())?;
    Ok(json!({ "manager": manager, "name": unit.name, "path": unit.path, "started": false }))
}

// ---- runtime.node.reinstall / runtime.core.reinstall ---------------------------------------------------------------

/// The release payload this build installs the core from, as setup's `runtime.core` step picks it without
/// `--core-from`; `Err` when the build bakes none (a dev build).
pub fn release_core_source() -> Result<CoreSource, String> {
    let t = Target::current().ok_or_else(unsupported)?;
    match (pins::release_base_url(), pins::core_payload_sha256()) {
        (Some(base), Some(sha)) => Ok(CoreSource::Release {
            url: format!(
                "{}/core-{}-{}.tar.gz",
                base.trim_end_matches('/'),
                env!("CARGO_PKG_VERSION"),
                t.id()
            ),
            sha256: sha.to_string(),
        }),
        _ => Err("this build has no release payload to install the core from; run `plur1bus setup --core-from <dir>`".into()),
    }
}

fn unsupported() -> String {
    format!(
        "no release target for {}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Records a reinstalled unit in the install manifest (HB9: `repair` writes it when it reinstalls a unit).
fn update_manifest(
    ctx: &Ctx,
    f: impl FnOnce(&mut manifest::InstallManifest),
) -> Result<(), String> {
    let Some(mut m) = manifest::read(ctx.layout)? else {
        return Ok(());
    };
    f(&mut m);
    m.updated_at = now_ms();
    manifest::write(ctx.layout, &m).map_err(|e| io_msg(&ctx.layout.install_manifest(), e))
}

fn step_error(e: setup::StepError) -> String {
    match e.hint {
        Some(h) => format!("{} ({}); {h}", e.message, e.reason),
        None => format!("{} ({})", e.message, e.reason),
    }
}

pub fn reinstall_node(ctx: &Ctx, _step: &Step) -> Result<Value, String> {
    let t = Target::current().ok_or_else(unsupported)?;
    let unit = setup::install_node(ctx.layout, t).map_err(step_error)?;
    let detail =
        json!({ "path": unit.path, "version": unit.version, "binarySha256": unit.binary_sha256 });
    update_manifest(ctx, |m| m.node = unit)?;
    Ok(detail)
}

pub fn reinstall_core(ctx: &Ctx, _step: &Step) -> Result<Value, String> {
    let src = release_core_source()?;
    let unit = setup::install_core(ctx.layout, src).map_err(step_error)?;
    let detail = json!({ "version": unit.version, "source": unit.source, "path": ctx.layout.runtime().join("core") });
    update_manifest(ctx, |m| m.core = unit)?;
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pid_files_and_sockets_of_known_endpoints_are_removable() {
        for ok in [
            "core.pid",
            "supervisor.pid",
            "module-fixture.pid",
            "core.sock",
            "module-fixture-b.sock",
        ] {
            assert!(removable(ok), "{ok}");
        }
        for no in [
            "core.token",
            "supervisor.token",
            "supervisor.lock",
            "module-.pid",
            "module-../x.pid",
            "../core.pid",
            "other.pid",
            "PLUR1BUS Supervisor.xml",
        ] {
            assert!(!removable(no), "{no}");
        }
    }

    #[test]
    fn backups_are_ordered_newest_first_by_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        for n in [
            "config.json.bak-2",
            "config.json.bak-10",
            "config.json.bak-1",
            "config.json.bak-3.tmp-9",
        ] {
            fs::write(dir.path().join(n), "{}").unwrap();
        }
        let names: Vec<String> = backups_newest_first(&path)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "config.json.bak-10",
                "config.json.bak-2",
                "config.json.bak-1"
            ]
        );
    }

    #[test]
    fn atomic_writes_leave_no_temp_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        write_atomic_bytes(&path, b"{}").unwrap();
        write_atomic_bytes(&path, b"{\"schemaVersion\":1}").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"schemaVersion\":1}");
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }
}
