//! `plur1bus uninstall` (M8): removes the installation, keeps the data unless `--purge` asks otherwise.
//!
//! The command builds a [`Plan`] first (what is stopped, which service unit goes, which files go, what stays), shows
//! it, asks (`--yes` skips the question) and then executes exactly that plan. `--dry-run` shows the same plan and
//! changes nothing. See `docs/uninstall.md`.
//!
//! Removed by default: the registered service unit, the `plur1bus` binary (and the `.old-*` files an update leaves
//! next to it), `runtime/` (Node, the core payload), `update/` (update state and snapshots), `manifest.json` and
//! `run/`. Kept: everything else under the home (config, agents, stores, skills, modules, logs, ...). `--purge` removes
//! the home itself; by default it first writes a backup next to the home (`--no-backup` skips it).
//!
//! Windows cannot delete a running executable. There the binary is removed by a one-shot `.cmd` script that waits for
//! this process to exit ([`windows_cleanup_script`]); the platform is injected ([`Os`]) so the plan and the script are
//! testable everywhere.
use crate::output::Out;
use crate::paths::Layout;
use crate::service::{self, Manager, Runner};
use clap::Args;
use serde::Serialize;
use serde_json::json;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

/// `plur1bus uninstall`
#[derive(Args, Debug)]
pub struct UninstallArgs {
    /// Do not ask; apply the plan
    #[arg(short = 'y', long)]
    pub yes: bool,
    /// Print the plan and change nothing
    #[arg(long)]
    pub dry_run: bool,
    /// Also remove the data: the whole home (config, agents, stores, logs, ...). Writes a backup first unless --no-backup
    #[arg(long)]
    pub purge: bool,
    /// With --purge: do not write a backup first
    #[arg(long, requires = "purge", conflicts_with = "backup_out")]
    pub no_backup: bool,
    /// With --purge: where the backup goes (default: next to the home, never inside it)
    #[arg(long, value_name = "FILE", requires = "purge")]
    pub backup_out: Option<PathBuf>,
}

/// The platform the plan is made for. Injected so the Windows branch is testable on every host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Unix,
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else {
            Os::Unix
        }
    }
}

/// One thing the uninstaller removes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Item {
    /// `binary`, `runtime`, `update-state`, `manifest`, `run` or `home`.
    pub kind: &'static str,
    pub path: PathBuf,
    /// Windows: removed by the cleanup script after this process has exited, not now.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deferred: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePlan {
    pub manager: Manager,
    pub name: String,
    pub path: PathBuf,
    pub registered: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPlan {
    /// The directory the archive goes to (outside the home).
    pub dir: PathBuf,
    /// The exact file when `--backup-out` names it; otherwise the name is chosen when the backup is written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub home: PathBuf,
    pub os: Os,
    pub purge: bool,
    /// A supervisor answers for the home: it is asked to stop (which stops the core).
    pub stop_daemon: bool,
    pub service: ServicePlan,
    pub remove: Vec<Item>,
    /// Top-level entries of the home that stay (empty with `--purge`).
    pub keep: Vec<String>,
    /// Present with `--purge` unless `--no-backup`; interactively the person may still decline it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<BackupPlan>,
    pub notes: Vec<String>,
    pub nothing_to_remove: bool,
}

/// What [`plan`] reads from the process and the machine.
pub struct Inputs<'a> {
    pub layout: &'a Layout,
    /// The installed binary (`update::target_binary()`); `None` when it cannot be located.
    pub binary: Option<PathBuf>,
    pub purge: bool,
    pub no_backup: bool,
    pub backup_out: Option<PathBuf>,
    pub os: Os,
    pub supervisor_running: bool,
    pub service: ServicePlan,
    /// The OS user's home directory, which a purge must never reach.
    pub user_home: Option<PathBuf>,
}

pub struct PlanError {
    pub code: &'static str,
    pub reason: &'static str,
    pub message: String,
}

impl PlanError {
    fn invalid(reason: &'static str, message: String) -> Self {
        PlanError {
            code: "E_INVALID_PARAMS",
            reason,
            message,
        }
    }
}

fn exists_nofollow(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// A purge removes a directory tree, so it only runs on something that is recognisably a PLUR1BUS home.
pub fn check_purge_home(home: &Path, user_home: Option<&Path>) -> Result<(), PlanError> {
    let normal = home
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count();
    if !home.is_absolute() || normal < 2 {
        return Err(PlanError::invalid(
            "unsafe-home",
            format!(
                "refusing to purge {}: not a dedicated directory",
                home.display()
            ),
        ));
    }
    if user_home.is_some_and(|u| u.starts_with(home)) {
        return Err(PlanError::invalid(
            "unsafe-home",
            format!(
                "refusing to purge {}: it contains your user home directory",
                home.display()
            ),
        ));
    }
    let Ok(meta) = std::fs::symlink_metadata(home) else {
        return Ok(()); // nothing there
    };
    if meta.file_type().is_symlink() {
        return Err(PlanError::invalid(
            "home-is-symlink",
            format!(
                "refusing to purge {}: it is a symlink; point --home at the real directory",
                home.display()
            ),
        ));
    }
    let empty = std::fs::read_dir(home).is_ok_and(|mut d| d.next().is_none());
    let marked = [
        "config.json",
        "manifest.json",
        "run",
        "state",
        "runtime",
        "agents",
        "logs",
    ]
    .iter()
    .any(|m| exists_nofollow(&home.join(m)));
    if !empty && !marked {
        return Err(PlanError::invalid(
            "not-a-home",
            format!(
                "refusing to purge {}: it does not look like a PLUR1BUS home",
                home.display()
            ),
        ));
    }
    Ok(())
}

/// Files an update left next to the binary (`plur1bus.old-<pid>`, Windows).
fn leftovers(binary: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(stem)) = (binary.parent(), binary.file_stem().and_then(|s| s.to_str()))
    else {
        return Vec::new();
    };
    let prefix = format!("{stem}.old-");
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Builds the plan from the current state. Same inputs, same plan: `--dry-run` and the real run call this alike.
pub fn plan(inp: &Inputs) -> Result<Plan, PlanError> {
    let home = inp.layout.home.clone();
    let mut notes = Vec::new();
    if inp.purge {
        check_purge_home(&home, inp.user_home.as_deref())?;
    }
    let mut remove: Vec<Item> = Vec::new();

    // The binary and what an update left beside it.
    let mut binary_inside_home = false;
    if let Some(bin) = &inp.binary {
        let stem_ok = bin.file_stem().and_then(|s| s.to_str()) == Some("plur1bus");
        if !stem_ok {
            notes.push(format!(
                "{} is not named plur1bus: left alone",
                bin.display()
            ));
        } else {
            let mut files = leftovers(bin);
            if exists_nofollow(bin) {
                files.insert(0, bin.clone());
            }
            for f in files {
                binary_inside_home |= f.starts_with(&home);
                remove.push(Item {
                    kind: "binary",
                    path: f,
                    deferred: inp.os == Os::Windows,
                });
            }
        }
    }

    // The installed software and transient state inside the home.
    let software: [(&'static str, PathBuf); 4] = [
        ("runtime", inp.layout.runtime()),
        ("update-state", crate::update::state::dir(inp.layout)),
        ("manifest", inp.layout.install_manifest()),
        ("run", inp.layout.run()),
    ];
    let mut removed_names: Vec<&str> = Vec::new();
    for (kind, path) in software {
        if exists_nofollow(&path) {
            if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                removed_names.push(match n {
                    "runtime" => "runtime",
                    "update" => "update",
                    "manifest.json" => "manifest.json",
                    _ => "run",
                });
            }
            remove.push(Item {
                kind,
                path,
                deferred: false,
            });
        }
    }

    let mut keep: Vec<String> = Vec::new();
    let mut backup = None;
    if inp.purge {
        if exists_nofollow(&home) {
            // The home takes everything in it along; only what lies outside stays an item of its own.
            remove.retain(|i| !i.path.starts_with(&home));
            // A running executable inside the home (Windows) is removed with the home, after this process exits.
            let deferred = inp.os == Os::Windows && binary_inside_home;
            if deferred {
                notes.push(
                    "the binary lies inside the home: the whole home is removed after this process exits"
                        .to_string(),
                );
            }
            remove.push(Item {
                kind: "home",
                path: home.clone(),
                deferred,
            });
            if !inp.no_backup {
                let dir = match &inp.backup_out {
                    Some(f) => f
                        .parent()
                        .filter(|p| !p.as_os_str().is_empty())
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|| PathBuf::from(".")),
                    None => home
                        .parent()
                        .map(Path::to_path_buf)
                        .unwrap_or_else(|| PathBuf::from(".")),
                };
                let inside = |p: &Path| {
                    // Lexical, plus the canonical form when both exist: a symlinked parent must not hide it.
                    p.starts_with(&home)
                        || matches!((p.canonicalize(), home.canonicalize()), (Ok(a), Ok(b)) if a.starts_with(&b))
                };
                if inside(&dir) {
                    return Err(PlanError::invalid(
                        "backup-inside-home",
                        format!(
                            "the backup would be written inside {}, which --purge removes; choose --backup-out elsewhere",
                            home.display()
                        ),
                    ));
                }
                backup = Some(BackupPlan {
                    dir,
                    file: inp.backup_out.clone(),
                });
            }
        }
    } else if let Ok(rd) = std::fs::read_dir(&home) {
        keep = rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !removed_names.contains(&n.as_str()))
            .collect();
        keep.sort();
    }

    let nothing = !inp.supervisor_running && !inp.service.registered && remove.is_empty();
    Ok(Plan {
        home,
        os: inp.os,
        purge: inp.purge,
        stop_daemon: inp.supervisor_running,
        service: inp.service.clone(),
        remove,
        keep,
        backup,
        notes,
        nothing_to_remove: nothing,
    })
}

/// The plan as the text `--dry-run` and the real run both print.
pub fn render_plan(p: &Plan) -> String {
    if p.nothing_to_remove {
        return format!("nothing to remove (home {})", p.home.display());
    }
    let mut s = format!("uninstall plan for {}\n", p.home.display());
    if let Some(b) = &p.backup {
        let target = b
            .file
            .as_ref()
            .map_or_else(|| b.dir.display().to_string(), |f| f.display().to_string());
        s.push_str(&format!("  backup   first, to {target}\n"));
    }
    if p.stop_daemon {
        s.push_str("  stop     the daemon (supervisor and core)\n");
    }
    if p.service.registered {
        s.push_str(&format!(
            "  service  remove {} {} ({})\n",
            p.service.manager.as_str(),
            p.service.name,
            p.service.path.display()
        ));
    }
    for i in &p.remove {
        let when = if i.deferred {
            " (after this process exits)"
        } else {
            ""
        };
        s.push_str(&format!(
            "  remove   {:<12} {}{when}\n",
            i.kind,
            i.path.display()
        ));
    }
    if p.purge {
        s.push_str("  purge    the data goes with the home\n");
    } else if !p.keep.is_empty() {
        s.push_str(&format!(
            "  keep     {} (data; --purge removes it)\n",
            p.keep.join(", ")
        ));
    }
    for n in &p.notes {
        s.push_str(&format!("  note     {n}\n"));
    }
    s.trim_end().to_string()
}

// ---- Windows delayed deletion ----------------------------------------------------------------------------------

/// A path as a quoted `cmd` batch argument: `%` doubled (a batch file expands `%VAR%`), spaces survive the quotes.
fn bat_quote(p: &Path) -> String {
    format!(
        "\"{}\"",
        p.to_string_lossy().replace('%', "%%").replace('"', "")
    )
}

/// The one-shot `.cmd` script that removes `files` and `dirs` once process `pid` is gone, retrying while Windows
/// still holds them, and then deletes itself. CRLF line endings, every path quoted.
pub fn windows_cleanup_script(pid: u32, files: &[PathBuf], dirs: &[PathBuf]) -> String {
    let mut l: Vec<String> = vec![
        "@echo off".into(),
        "rem Written by `plur1bus uninstall`: removes what was in use while it ran, then deletes itself.".into(),
        "set tries=0".into(),
        ":wait".into(),
        format!("tasklist /FI \"PID eq {pid}\" /FO CSV /NH 2>NUL | find \"\"\"{pid}\"\"\" >NUL"),
        "if errorlevel 1 goto go".into(),
        "set /a tries+=1".into(),
        "if %tries% GEQ 60 goto go".into(),
        "ping -n 2 127.0.0.1 >NUL".into(),
        "goto wait".into(),
        ":go".into(),
    ];
    let targets = files
        .iter()
        .map(|p| ("del /f /q", p))
        .chain(dirs.iter().map(|p| ("rmdir /s /q", p)));
    for (i, (cmd, p)) in targets.enumerate() {
        let q = bat_quote(p);
        l.push("set n=0".to_string());
        l.push(format!(":t{i}"));
        l.push(format!("{cmd} {q} 2>NUL"));
        l.push(format!("if not exist {q} goto t{i}done"));
        l.push("set /a n+=1".into());
        l.push(format!("if %n% GEQ 20 goto t{i}done"));
        l.push("ping -n 2 127.0.0.1 >NUL".into());
        l.push(format!("goto t{i}"));
        l.push(format!(":t{i}done"));
    }
    l.push("(goto) 2>NUL & del /f /q \"%~f0\"".into());
    let mut s = l.join("\r\n");
    s.push_str("\r\n");
    s
}

/// Writes the script to the temp directory and starts it detached. Windows only.
#[cfg(windows)]
fn spawn_cleanup(script: &str) -> std::io::Result<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let path = std::env::temp_dir().join(format!("plur1bus-uninstall-{}.cmd", std::process::id()));
    std::fs::write(&path, script)?;
    // `cmd /C ""path with spaces.cmd""`: the outer pair is the one cmd strips.
    std::process::Command::new("cmd.exe")
        .raw_arg(format!("/D /C \"\"{}\"\"", path.display()))
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(path)
}

#[cfg(not(windows))]
fn spawn_cleanup(_script: &str) -> std::io::Result<PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "delayed deletion is only used on Windows",
    ))
}

// ---- execution -------------------------------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupDone {
    pub path: PathBuf,
    pub bytes: u64,
    pub files: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub backup: Option<BackupDone>,
    pub daemon_stopped: bool,
    pub service_removed: bool,
    pub removed: Vec<PathBuf>,
    /// Windows: the script that removes the deferred paths, and what it removes.
    pub deferred: Option<Deferred>,
    pub failures: Vec<Failure>,
}

#[derive(Debug, Serialize)]
pub struct Deferred {
    pub script: PathBuf,
    pub paths: Vec<PathBuf>,
}

#[derive(Debug, Serialize)]
pub struct Failure {
    pub step: &'static str,
    pub path: Option<PathBuf>,
    pub error: String,
}

/// A step that cannot continue: nothing after it ran.
pub struct Abort {
    pub code: &'static str,
    pub reason: &'static str,
    pub message: String,
}

/// The side effects, so the order and the bookkeeping are unit-testable.
pub trait Host {
    /// Stops the supervisor (and with it the core). `Ok(true)`: gone.
    fn stop_daemon(&mut self) -> Result<bool, String>;
    fn remove_service(&mut self) -> Result<bool, String>;
    fn backup(&mut self, plan: &BackupPlan) -> Result<BackupDone, String>;
    fn remove_path(&mut self, path: &Path) -> std::io::Result<()>;
    fn spawn_cleanup(&mut self, script: &str) -> std::io::Result<PathBuf>;
    fn pid(&self) -> u32;
}

/// Executes `p`: backup (when `want_backup`), stop, service, removals, deferred removals. Removals continue past a
/// failure and are reported; the stop, the service and the backup abort the run before anything is removed.
pub fn execute(p: &Plan, want_backup: bool, host: &mut dyn Host) -> Result<Outcome, Abort> {
    let mut o = Outcome::default();
    if let (true, Some(b)) = (want_backup, &p.backup) {
        o.backup = Some(host.backup(b).map_err(|m| Abort {
            code: "E_NOT_AVAILABLE",
            reason: "backup-failed",
            message: format!("{m}; nothing was changed (use --no-backup to purge without one)"),
        })?);
    }
    if p.stop_daemon {
        match host.stop_daemon() {
            Ok(true) => o.daemon_stopped = true,
            Ok(false) => {
                return Err(Abort {
                    code: "E_INTERNAL",
                    reason: "daemon-not-stopped",
                    message: "the supervisor did not stop in time; nothing was removed".into(),
                })
            }
            Err(m) => {
                return Err(Abort {
                    code: "E_INTERNAL",
                    reason: "daemon-stop-failed",
                    message: format!("{m}; nothing was removed"),
                })
            }
        }
    }
    if p.service.registered {
        match host.remove_service() {
            Ok(r) => o.service_removed = r,
            Err(m) => {
                return Err(Abort {
                    code: "E_INTERNAL",
                    reason: "service-manager",
                    message: m,
                })
            }
        }
    }
    let mut deferred: Vec<&Item> = Vec::new();
    for i in &p.remove {
        if i.deferred {
            deferred.push(i);
            continue;
        }
        match host.remove_path(&i.path) {
            Ok(()) => o.removed.push(i.path.clone()),
            Err(e) => o.failures.push(Failure {
                step: "remove",
                path: Some(i.path.clone()),
                error: e.to_string(),
            }),
        }
    }
    if !deferred.is_empty() {
        let (dirs, files): (Vec<&Item>, Vec<&Item>) =
            deferred.iter().partition(|i| i.kind == "home");
        let files: Vec<PathBuf> = files.iter().map(|i| i.path.clone()).collect();
        let dirs: Vec<PathBuf> = dirs.iter().map(|i| i.path.clone()).collect();
        let script = windows_cleanup_script(host.pid(), &files, &dirs);
        match host.spawn_cleanup(&script) {
            Ok(path) => {
                o.deferred = Some(Deferred {
                    script: path,
                    paths: files.into_iter().chain(dirs).collect(),
                })
            }
            Err(e) => o.failures.push(Failure {
                step: "schedule-deletion",
                path: None,
                error: e.to_string(),
            }),
        }
    }
    Ok(o)
}

// ---- the real host ---------------------------------------------------------------------------------------------

struct RealHost<'a> {
    out: &'a Out,
    layout: &'a Layout,
    runner: Box<dyn Runner>,
}

impl Host for RealHost<'_> {
    fn stop_daemon(&mut self) -> Result<bool, String> {
        match super::daemon::stop_supervisor(self.layout, None) {
            None => Ok(true), // stopped by itself since the plan was made
            Some(Ok(stopped)) => Ok(stopped),
            Some(Err(e)) => Err(e.to_string()),
        }
    }
    fn remove_service(&mut self) -> Result<bool, String> {
        service::uninstall(self.runner.as_ref(), self.layout).map_err(|e| e.to_string())
    }
    fn backup(&mut self, plan: &BackupPlan) -> Result<BackupDone, String> {
        use crate::backup::create::{self, Snapshot};
        let path = plan.file.clone().unwrap_or_else(|| {
            plan.dir.join(format!(
                "plur1bus-backup-{}.tar.gz",
                crate::backup::utc_stamp(crate::backup::now_ms())
            ))
        });
        if path.exists() {
            return Err(format!("{} already exists", path.display()));
        }
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        // The core owns the snapshot; no core, no backup (the same rule as `backup create`).
        let mut c = super::memory_ops::connect_core(
            self.out,
            self.layout,
            "backup",
            std::time::Duration::from_secs(30 * 60),
        );
        super::memory_ops::require_supports(self.out, &c, "admin.backup.snapshot");
        let snap = c
            .call("admin.backup.snapshot", json!({ "label": "backup" }))
            .map_err(|e| e.to_string())?;
        drop(c);
        let snap = Snapshot::from_rpc(&snap).map_err(|e| e.to_string())?;
        let r = create::create(self.layout, &path, &snap).map_err(|e| e.to_string())?;
        Ok(BackupDone {
            path: r.path,
            bytes: r.bytes,
            files: r.files,
        })
    }
    fn remove_path(&mut self, path: &Path) -> std::io::Result<()> {
        let meta = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if meta.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        }
    }
    fn spawn_cleanup(&mut self, script: &str) -> std::io::Result<PathBuf> {
        spawn_cleanup(script)
    }
    fn pid(&self) -> u32 {
        std::process::id()
    }
}

/// Asks a yes/no question on a terminal; anywhere else the answer is `default`.
fn ask(out: &Out, question: &str, default: bool) -> bool {
    if !std::io::stdin().is_terminal() || out.json {
        return default;
    }
    eprint!("{question} {} ", if default { "[Y/n]" } else { "[y/N]" });
    std::io::Write::flush(&mut std::io::stderr()).ok();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).ok();
    match line.trim().to_ascii_lowercase().as_str() {
        "" => default,
        "y" | "yes" => true,
        _ => false,
    }
}

pub fn run(out: &Out, layout: &Layout, args: UninstallArgs) {
    super::refuse_in_container(out, "uninstall");
    let r = super::service::runner(out);
    let st = service::status(r.as_ref(), layout);
    let inputs = Inputs {
        layout,
        binary: crate::update::target_binary().ok(),
        purge: args.purge,
        no_backup: args.no_backup,
        backup_out: args.backup_out.clone(),
        os: Os::current(),
        supervisor_running: super::daemon::supervisor_answers(layout),
        service: ServicePlan {
            manager: st.manager,
            name: st.name,
            path: st.path,
            registered: st.registered,
        },
        user_home: home::home_dir(),
    };
    let p = match plan(&inputs) {
        Ok(p) => p,
        Err(e) => out.fail(e.code, &e.message, json!({ "reason": e.reason }), 2),
    };
    if args.dry_run || p.nothing_to_remove {
        out.ok(
            "uninstall/1",
            &json!({ "dryRun": args.dry_run, "applied": false, "plan": p, "result": null }),
            || {
                let mut s = render_plan(&p);
                if args.dry_run && !p.nothing_to_remove {
                    s.push_str("\ndry run: nothing was changed");
                }
                s
            },
        );
        return;
    }
    if !out.json {
        crate::output::say(&render_plan(&p));
    }
    super::module::confirm(out, "apply this plan?", args.yes);
    // `--yes` takes the documented default (back up); a person at the terminal may decline it.
    let want_backup = p.backup.is_some()
        && (args.yes
            || ask(
                out,
                "write a backup of the data before it is removed?",
                true,
            ));
    let mut host = RealHost {
        out,
        layout,
        runner: r,
    };
    let o = match execute(&p, want_backup, &mut host) {
        Ok(o) => o,
        Err(a) => out.fail(a.code, &a.message, json!({ "reason": a.reason }), 1),
    };
    if !p.purge {
        // Best effort; the home (and its audit log) is kept.
        let _ = crate::audit::append(
            layout,
            "uninstall",
            &layout.home.display().to_string(),
            json!({ "removed": o.removed.len() }),
        );
    }
    let doc = json!({ "dryRun": false, "applied": true, "plan": p, "result": o });
    if !o.failures.is_empty() {
        let list: Vec<String> = o
            .failures
            .iter()
            .map(|f| match &f.path {
                Some(p) => format!("{}: {}", p.display(), f.error),
                None => format!("{}: {}", f.step, f.error),
            })
            .collect();
        out.fail(
            "E_INTERNAL",
            &format!(
                "uninstall finished with errors; run it again after fixing them:\n  {}",
                list.join("\n  ")
            ),
            json!({ "reason": "remove-failed", "plan": p, "result": o }),
            1,
        );
    }
    out.ok("uninstall/1", &doc, || {
        let mut s = String::new();
        if let Some(b) = &o.backup {
            s.push_str(&format!(
                "backup written to {} ({} files, {} bytes); verify it with: plur1bus backup verify {}\n",
                b.path.display(),
                b.files,
                b.bytes,
                b.path.display()
            ));
        }
        if o.daemon_stopped {
            s.push_str("stopped the daemon\n");
        }
        if o.service_removed {
            s.push_str(&format!("removed the {} service {}\n", p.service.manager.as_str(), p.service.name));
        }
        for r in &o.removed {
            s.push_str(&format!("removed {}\n", r.display()));
        }
        if let Some(d) = &o.deferred {
            s.push_str(&format!(
                "Windows cannot delete a running program: {} will be removed by {} right after this process exits\n",
                d.paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "),
                d.script.display()
            ));
        }
        if p.purge {
            s.push_str("the data was removed with the home");
        } else {
            s.push_str(&format!("kept the data in {} (plur1bus uninstall --purge removes it)", p.home.display()));
        }
        s
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(registered: bool) -> ServicePlan {
        ServicePlan {
            manager: Manager::Systemd,
            name: "plur1bus-test".into(),
            path: PathBuf::from("/u/.config/systemd/user/plur1bus-test.service"),
            registered,
        }
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        bin: PathBuf,
        layout: Layout,
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let home = root.join("p1b home").join(".plur1bus");
        let bin = root.join("bin dir").join("plur1bus");
        for d in ["runtime/core", "update/snapshot", "run", "agents/a", "logs"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::write(home.join("manifest.json"), "{}").unwrap();
        std::fs::write(home.join("config.json"), "{}").unwrap();
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, "elf").unwrap();
        let layout = Layout::new(home.clone());
        Fx {
            _tmp: tmp,
            home,
            bin,
            layout,
        }
    }

    fn inputs<'a>(f: &'a Fx, purge: bool, os: Os) -> Inputs<'a> {
        Inputs {
            layout: &f.layout,
            binary: Some(f.bin.clone()),
            purge,
            no_backup: false,
            backup_out: None,
            os,
            supervisor_running: true,
            service: svc(true),
            user_home: Some(PathBuf::from("/nonexistent-user-home")),
        }
    }

    fn kinds(p: &Plan) -> Vec<&'static str> {
        p.remove.iter().map(|i| i.kind).collect()
    }

    #[test]
    fn default_plan_removes_software_and_keeps_data() {
        let f = fx();
        let p = plan(&inputs(&f, false, Os::Unix)).ok().unwrap();
        assert_eq!(
            kinds(&p),
            ["binary", "runtime", "update-state", "manifest", "run"]
        );
        assert_eq!(p.keep, ["agents", "config.json", "logs"]);
        assert!(p.stop_daemon && p.service.registered && p.backup.is_none());
        assert!(!p.nothing_to_remove);
        assert!(p.remove.iter().all(|i| !i.deferred));
    }

    #[test]
    fn a_plan_is_deterministic() {
        let f = fx();
        let a = plan(&inputs(&f, false, Os::Unix)).ok().unwrap();
        let b = plan(&inputs(&f, false, Os::Unix)).ok().unwrap();
        assert_eq!(a, b);
        assert_eq!(render_plan(&a), render_plan(&b));
    }

    #[test]
    fn nothing_to_remove_when_everything_is_gone() {
        let f = fx();
        let mut i = inputs(&f, false, Os::Unix);
        i.supervisor_running = false;
        i.service.registered = false;
        for d in ["runtime", "update", "run"] {
            std::fs::remove_dir_all(f.home.join(d)).unwrap();
        }
        std::fs::remove_file(f.home.join("manifest.json")).unwrap();
        std::fs::remove_file(&f.bin).unwrap();
        let p = plan(&i).ok().unwrap();
        assert!(p.nothing_to_remove && p.remove.is_empty());
        assert!(render_plan(&p).starts_with("nothing to remove"));
    }

    #[test]
    fn purge_plans_the_home_and_a_backup_next_to_it() {
        let f = fx();
        let p = plan(&inputs(&f, true, Os::Unix)).ok().unwrap();
        assert_eq!(kinds(&p), ["binary", "home"]);
        assert!(p.keep.is_empty());
        let b = p.backup.unwrap();
        assert_eq!(b.dir, f.home.parent().unwrap());
        assert!(b.file.is_none());
    }

    #[test]
    fn no_backup_drops_the_backup_and_a_backup_inside_the_home_is_refused() {
        let f = fx();
        let mut i = inputs(&f, true, Os::Unix);
        i.no_backup = true;
        assert!(plan(&i).ok().unwrap().backup.is_none());
        let mut i = inputs(&f, true, Os::Unix);
        i.backup_out = Some(f.home.join("backups").join("b.tar.gz"));
        let e = plan(&i).err().unwrap();
        assert_eq!(
            (e.code, e.reason),
            ("E_INVALID_PARAMS", "backup-inside-home")
        );
    }

    #[test]
    fn purge_refuses_unsafe_homes() {
        let tmp = tempfile::tempdir().unwrap();
        let reason =
            |home: &Path, user: Option<&Path>| check_purge_home(home, user).err().map(|e| e.reason);
        assert_eq!(reason(Path::new("/"), None), Some("unsafe-home"));
        assert_eq!(reason(Path::new("/home"), None), Some("unsafe-home"));
        assert_eq!(reason(Path::new("relative/x"), None), Some("unsafe-home"));
        // The user's home inside the directory to purge.
        let h = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&h).unwrap();
        assert_eq!(
            reason(tmp.path().join("a").as_path(), Some(&h)),
            Some("unsafe-home")
        );
        // A directory with foreign content.
        std::fs::write(h.join("notes.txt"), "x").unwrap();
        assert_eq!(reason(&h, None), Some("not-a-home"));
        // The same directory with a marker, an empty one and a missing one pass.
        std::fs::write(h.join("config.json"), "{}").unwrap();
        assert_eq!(reason(&h, None), None);
        let empty = tmp.path().join("e").join("f");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(reason(&empty, None), None);
        assert_eq!(reason(&tmp.path().join("no").join("such"), None), None);
        #[cfg(unix)]
        {
            let link = tmp.path().join("l").join("link");
            std::fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&h, &link).unwrap();
            assert_eq!(reason(&link, None), Some("home-is-symlink"));
        }
    }

    #[test]
    fn a_binary_not_named_plur1bus_is_left_alone() {
        let f = fx();
        let other = f.bin.with_file_name("something-else");
        std::fs::write(&other, "x").unwrap();
        let mut i = inputs(&f, false, Os::Unix);
        i.binary = Some(other);
        let p = plan(&i).ok().unwrap();
        assert!(!kinds(&p).contains(&"binary"));
        assert_eq!(p.notes.len(), 1);
    }

    #[test]
    fn update_leftovers_next_to_the_binary_go_with_it() {
        let f = fx();
        let old = f.bin.with_file_name("plur1bus.old-77");
        std::fs::write(&old, "x").unwrap();
        let p = plan(&inputs(&f, false, Os::Unix)).ok().unwrap();
        let bins: Vec<&PathBuf> = p
            .remove
            .iter()
            .filter(|i| i.kind == "binary")
            .map(|i| &i.path)
            .collect();
        assert_eq!(bins, [&f.bin, &old]);
    }

    #[test]
    fn on_windows_the_binary_is_deferred_and_the_rest_is_not() {
        let f = fx();
        let p = plan(&inputs(&f, false, Os::Windows)).ok().unwrap();
        for i in &p.remove {
            assert_eq!(i.deferred, i.kind == "binary", "{}", i.kind);
        }
        assert!(render_plan(&p).contains("(after this process exits)"));
    }

    #[test]
    fn on_windows_a_binary_inside_a_purged_home_defers_the_whole_home() {
        let f = fx();
        let inner = f.home.join("bin").join("plur1bus.exe");
        std::fs::create_dir_all(inner.parent().unwrap()).unwrap();
        std::fs::write(&inner, "MZ").unwrap();
        let mut i = inputs(&f, true, Os::Windows);
        i.binary = Some(inner);
        let p = plan(&i).ok().unwrap();
        assert_eq!(kinds(&p), ["home"]);
        assert!(p.remove[0].deferred);
        // On Unix the same layout is removed at once.
        let mut i = inputs(&f, true, Os::Unix);
        i.binary = Some(f.home.join("bin").join("plur1bus.exe"));
        let p = plan(&i).ok().unwrap();
        assert!(!p.remove[0].deferred);
    }

    #[test]
    fn the_windows_script_waits_for_the_pid_quotes_paths_and_deletes_itself() {
        let files = [PathBuf::from(
            r"C:\Program Files\PLUR1BUS Tools\plur1bus.exe",
        )];
        let dirs = [PathBuf::from(r"C:\Users\Jo 100%\.plur1bus")];
        let s = windows_cleanup_script(4242, &files, &dirs);
        assert!(s.contains("PID eq 4242"));
        assert!(s.contains("\"\"\"4242\"\"\""));
        assert!(s.contains(r#"del /f /q "C:\Program Files\PLUR1BUS Tools\plur1bus.exe" 2>NUL"#));
        assert!(s.contains(r#"rmdir /s /q "C:\Users\Jo 100%%\.plur1bus" 2>NUL"#));
        assert!(s.contains("del /f /q \"%~f0\""));
        assert!(s.lines().count() > 10 && s.matches("\r\n").count() == s.lines().count());
        // The wait comes before any deletion.
        assert!(s.find(":wait").unwrap() < s.find("del /f /q \"C:").unwrap());
        // Two targets get two retry blocks.
        assert!(s.contains(":t0done") && s.contains(":t1done") && !s.contains(":t2"));
    }

    #[test]
    fn a_quote_in_a_path_cannot_break_out_of_the_script() {
        let s = windows_cleanup_script(1, &[PathBuf::from("C:\\a\"&calc&\"b")], &[]);
        assert!(s.contains("del /f /q \"C:\\a&calc&b\""));
    }

    #[derive(Default)]
    struct Mock {
        calls: Vec<String>,
        daemon: Option<Result<bool, String>>,
        backup_err: Option<String>,
        fail_path: Option<PathBuf>,
    }
    impl Host for Mock {
        fn stop_daemon(&mut self) -> Result<bool, String> {
            self.calls.push("stop".into());
            self.daemon.clone().unwrap_or(Ok(true))
        }
        fn remove_service(&mut self) -> Result<bool, String> {
            self.calls.push("service".into());
            Ok(true)
        }
        fn backup(&mut self, plan: &BackupPlan) -> Result<BackupDone, String> {
            self.calls.push("backup".into());
            match &self.backup_err {
                Some(e) => Err(e.clone()),
                None => Ok(BackupDone {
                    path: plan.dir.join("b.tar.gz"),
                    bytes: 1,
                    files: 1,
                }),
            }
        }
        fn remove_path(&mut self, path: &Path) -> std::io::Result<()> {
            self.calls.push(format!(
                "rm {}",
                path.file_name().unwrap().to_string_lossy()
            ));
            if self.fail_path.as_deref() == Some(path) {
                return Err(std::io::Error::other("busy"));
            }
            Ok(())
        }
        fn spawn_cleanup(&mut self, _script: &str) -> std::io::Result<PathBuf> {
            self.calls.push("schedule".into());
            Ok(PathBuf::from("cleanup.cmd"))
        }
        fn pid(&self) -> u32 {
            9
        }
    }

    #[test]
    fn execution_order_is_backup_stop_service_remove() {
        let f = fx();
        let p = plan(&inputs(&f, true, Os::Unix)).ok().unwrap();
        let mut m = Mock::default();
        let o = execute(&p, true, &mut m).ok().unwrap();
        assert_eq!(
            m.calls,
            ["backup", "stop", "service", "rm plur1bus", "rm .plur1bus"]
        );
        assert!(
            o.backup.is_some() && o.daemon_stopped && o.service_removed && o.failures.is_empty()
        );
    }

    #[test]
    fn a_declined_backup_is_not_taken() {
        let f = fx();
        let p = plan(&inputs(&f, true, Os::Unix)).ok().unwrap();
        let mut m = Mock::default();
        let o = execute(&p, false, &mut m).ok().unwrap();
        assert!(!m.calls.contains(&"backup".to_string()) && o.backup.is_none());
    }

    #[test]
    fn a_failed_backup_aborts_before_anything_changes() {
        let f = fx();
        let p = plan(&inputs(&f, true, Os::Unix)).ok().unwrap();
        let mut m = Mock {
            backup_err: Some("core unavailable".into()),
            ..Mock::default()
        };
        let a = execute(&p, true, &mut m).err().unwrap();
        assert_eq!(a.reason, "backup-failed");
        assert_eq!(m.calls, ["backup"]);
    }

    #[test]
    fn a_daemon_that_does_not_stop_aborts_before_any_removal() {
        let f = fx();
        let p = plan(&inputs(&f, false, Os::Unix)).ok().unwrap();
        let mut m = Mock {
            daemon: Some(Ok(false)),
            ..Mock::default()
        };
        assert_eq!(
            execute(&p, false, &mut m).err().unwrap().reason,
            "daemon-not-stopped"
        );
        assert_eq!(m.calls, ["stop"]);
    }

    #[test]
    fn a_failed_removal_is_reported_and_the_rest_still_runs() {
        let f = fx();
        let p = plan(&inputs(&f, false, Os::Unix)).ok().unwrap();
        let mut m = Mock {
            fail_path: Some(f.layout.runtime()),
            ..Mock::default()
        };
        let o = execute(&p, false, &mut m).ok().unwrap();
        assert_eq!(o.failures.len(), 1);
        assert_eq!(o.removed.len(), 4);
    }

    #[test]
    fn windows_defers_the_binary_to_a_script() {
        let f = fx();
        let p = plan(&inputs(&f, false, Os::Windows)).ok().unwrap();
        let mut m = Mock::default();
        let o = execute(&p, false, &mut m).ok().unwrap();
        assert!(m.calls.contains(&"schedule".to_string()));
        assert!(!m.calls.contains(&"rm plur1bus".to_string()));
        assert_eq!(o.deferred.unwrap().paths, std::slice::from_ref(&f.bin));
    }

    #[test]
    fn plan_json_shape() {
        let f = fx();
        let p = plan(&inputs(&f, true, Os::Unix)).ok().unwrap();
        let v = serde_json::to_value(&p).unwrap();
        for k in [
            "home",
            "os",
            "purge",
            "stopDaemon",
            "service",
            "remove",
            "keep",
            "backup",
            "notes",
            "nothingToRemove",
        ] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(v["os"], "unix");
        assert_eq!(v["remove"][0]["kind"], "binary");
        assert!(v["remove"][0].get("deferred").is_none());
        assert_eq!(v["service"]["manager"], "systemd");
    }
}
