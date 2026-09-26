//! OS service registration of `plur1bus supervise` in the user's own context (spec §6.5, S10): a systemd user unit
//! (Linux), a launchd agent (macOS) or a Task Scheduler task with a logon trigger (Windows). No command needs admin
//! rights. Every manager command goes through a [`Runner`], so tests record them instead of touching the real
//! service manager.
//!
//! Stop timeouts. A running `daemon.stop` may use a budget of up to 120 s, the supervisor adds a 5 s hard-stop grace
//! (Task 6) and ignores a second SIGTERM, so the OS must wait longer than that before it kills: [`STOP_TIMEOUT_SECS`]
//! (150 s = 120 s + 5 s + 25 s margin) is systemd's `TimeoutStopSec` and launchd's `ExitTimeOut`. Task Scheduler
//! has no graceful stop at all (`schtasks /End` terminates the process); the core then ends by its own grace timer.
//!
//! Children. The supervisor must be the only process the OS stops or restarts: the core survives a supervisor crash
//! and is adopted by the next supervisor (D11, criterion 3). systemd therefore uses `KillMode=process` (the default
//! `control-group` would kill the core with the supervisor), launchd `AbandonProcessGroup` (the core already runs in
//! its own process group).
use crate::paths::{self, Layout};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

pub mod fake;
pub mod launchd;
pub mod schtasks;
pub mod systemd;

/// Seconds the OS waits for `supervise` to exit after asking it to stop (see the module docs).
pub const STOP_TIMEOUT_SECS: u32 = 150;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Manager {
    Systemd,
    Launchd,
    TaskScheduler,
}

impl Manager {
    /// The service manager of the target OS.
    pub fn current() -> Manager {
        if cfg!(target_os = "macos") {
            Manager::Launchd
        } else if cfg!(windows) {
            Manager::TaskScheduler
        } else {
            Manager::Systemd
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Manager::Systemd => "systemd",
            Manager::Launchd => "launchd",
            Manager::TaskScheduler => "task-scheduler",
        }
    }
    /// The S10 name for the default home; any other home appends `-<suffix>`.
    fn base_name(self) -> &'static str {
        match self {
            Manager::Systemd => "plur1bus",
            Manager::Launchd => "dev.plur1bus.supervisor",
            Manager::TaskScheduler => "PLUR1BUS Supervisor",
        }
    }
}

/// A rendered registration: what `install` writes to `path` and registers under `name`.
#[derive(Debug, Clone)]
pub struct Unit {
    pub manager: Manager,
    pub name: String,
    pub path: PathBuf,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceStatus {
    pub registered: bool,
    pub running: bool,
    pub manager: Manager,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug)]
pub enum ServiceError {
    /// Reading or writing the unit file failed.
    Io { path: PathBuf, err: io::Error },
    /// The manager command could not be started (e.g. `systemctl` missing).
    Spawn { program: String, err: io::Error },
    /// The manager command ran and failed.
    Command {
        program: String,
        args: Vec<String>,
        code: Option<i32>,
        stderr: String,
    },
    /// A path that goes into the unit is not valid UTF-8 (unit files and task XML are UTF-8/UTF-16 text).
    PathNotUtf8 { path: PathBuf },
    /// The service manager still has the job loaded after the stop timeout.
    StillLoaded { name: String, secs: u64 },
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceError::Io { path, err } => write!(f, "{}: {err}", path.display()),
            ServiceError::Spawn { program, err } => write!(f, "cannot run {program}: {err}"),
            ServiceError::Command {
                program,
                args,
                code,
                stderr,
            } => {
                let code = code.map_or("a signal".to_string(), |c| c.to_string());
                write!(
                    f,
                    "`{program} {}` failed with {code}: {}",
                    args.join(" "),
                    stderr.trim()
                )
            }
            ServiceError::PathNotUtf8 { path } => {
                write!(f, "{} is not valid UTF-8", path.to_string_lossy())
            }
            ServiceError::StillLoaded { name, secs } => {
                write!(f, "{name} is still loaded after {secs} s")
            }
        }
    }
}

/// Runs one service-manager command and returns its output (a non-zero exit is not an `Err`).
pub trait Runner {
    fn run(&self, program: &str, args: &[OsString]) -> io::Result<std::process::Output>;
}

/// The real service manager.
pub struct SystemRunner;
impl Runner for SystemRunner {
    fn run(&self, program: &str, args: &[OsString]) -> io::Result<std::process::Output> {
        std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
    }
}

/// S10: the default home keeps the plain name; any other home gets `-<first 8 hex of sha256(lower-cased home)>`, so
/// a test home or a second install never collides with the real one.
pub fn service_name(layout: &Layout, default_home: &Path) -> String {
    name_for(Manager::current(), layout, default_home)
}

pub(crate) fn name_for(manager: Manager, layout: &Layout, default_home: &Path) -> String {
    let home = trim_trailing_separators(&layout.home.to_string_lossy());
    let default = trim_trailing_separators(&default_home.to_string_lossy());
    let is_default = if cfg!(windows) {
        home.to_lowercase() == default.to_lowercase()
    } else {
        home == default
    };
    if is_default {
        manager.base_name().to_string()
    } else {
        let h = format!("{:x}", Sha256::digest(home.to_lowercase().as_bytes()));
        format!("{}-{}", manager.base_name(), &h[..8])
    }
}

/// `/home/u/.plur1bus/` → `/home/u/.plur1bus` (and `\` on Windows), keeping a bare root (`/`, `C:\`) intact, so a
/// trailing separator never changes the service name.
fn trim_trailing_separators(s: &str) -> String {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let mut t = s;
    while t.len() > 1 && t.ends_with(is_sep) && !(t.len() == 3 && t.as_bytes()[1] == b':') {
        t = &t[..t.len() - 1];
    }
    t.to_string()
}

/// Where the registration for `name` lives: the systemd user unit directory, `~/Library/LaunchAgents`, or the
/// task XML under `<home>/run/` (Task Scheduler keeps the registration itself).
pub fn unit_path(manager: Manager, layout: &Layout, name: &str) -> PathBuf {
    match manager {
        Manager::Systemd => systemd::unit_dir().join(format!("{name}.service")),
        Manager::Launchd => user_home()
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{name}.plist")),
        Manager::TaskScheduler => layout.run().join(format!("{name}.xml")),
    }
}

fn user_home() -> PathBuf {
    home::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Renders the registration that runs `<bin> --home <home> supervise`. `env` becomes systemd `Environment=` or
/// launchd `EnvironmentVariables`; Task Scheduler has no per-task environment, so the CLI refuses a non-empty `env`
/// there before rendering (and this ignores it). A binary or home path that is not valid UTF-8 is refused
/// ([`ServiceError::PathNotUtf8`]) rather than rendered lossily.
pub fn render(
    manager: Manager,
    bin: &Path,
    layout: &Layout,
    name: &str,
    env: &[(String, String)],
) -> Result<Unit, ServiceError> {
    let utf8 = |p: &Path| -> Result<String, ServiceError> {
        p.to_str()
            .map(str::to_string)
            .ok_or_else(|| ServiceError::PathNotUtf8 {
                path: p.to_path_buf(),
            })
    };
    let bin = utf8(bin)?;
    let home = utf8(&layout.home)?;
    let content = match manager {
        Manager::Systemd => systemd::render(&bin, &home, env),
        Manager::Launchd => {
            let stderr = utf8(&layout.logs().join("supervisor.stderr"))?;
            launchd::render(&bin, &home, name, env, &stderr)
        }
        Manager::TaskScheduler => schtasks::render(&bin, &home, &schtasks::current_user()),
    };
    Ok(Unit {
        manager,
        name: name.to_string(),
        path: unit_path(manager, layout, name),
        content,
    })
}

/// Writes the unit and registers it; `start` also starts it now (otherwise it starts at the next login).
/// Re-installing over an existing registration replaces it: with `start` a running instance is restarted on the new
/// definition (systemd `restart`, launchd `bootout` + `bootstrap`, Task Scheduler `/End` + `/Run`); without `start`
/// a running instance is left alone and the new definition applies from its next start.
pub fn install(r: &dyn Runner, unit: &Unit, start: bool) -> Result<(), ServiceError> {
    write_unit(unit)?;
    match unit.manager {
        Manager::Systemd => systemd::install(r, &unit.name, start),
        Manager::Launchd => launchd::install(r, &unit.name, &unit.path, start),
        Manager::TaskScheduler => schtasks::install(r, &unit.name, &unit.path, start),
    }
}

/// Stops and unregisters the home's service and removes its unit file. `Ok(false)`: nothing was registered.
pub fn uninstall(r: &dyn Runner, layout: &Layout) -> Result<bool, ServiceError> {
    let (manager, name, path) = locate(layout);
    uninstall_unit(r, manager, &name, &path)
}

pub(crate) fn uninstall_unit(
    r: &dyn Runner,
    manager: Manager,
    name: &str,
    path: &Path,
) -> Result<bool, ServiceError> {
    match manager {
        Manager::Systemd => systemd::uninstall(r, name, path),
        Manager::Launchd => launchd::uninstall(r, name, path),
        Manager::TaskScheduler => schtasks::uninstall(r, name, path),
    }
}

/// Whether the home's service is registered and whether the manager reports it running. Never fails: a manager
/// that cannot be asked reports `running: false`.
pub fn status(r: &dyn Runner, layout: &Layout) -> ServiceStatus {
    let (manager, name, path) = locate(layout);
    let (registered, running) = match manager {
        Manager::Systemd => systemd::status(r, &name, &path),
        Manager::Launchd => launchd::status(r, &name, &path),
        Manager::TaskScheduler => schtasks::status(r, &name),
    };
    ServiceStatus {
        registered,
        running,
        manager,
        name,
        path,
    }
}

fn locate(layout: &Layout) -> (Manager, String, PathBuf) {
    let manager = Manager::current();
    let name = name_for(manager, layout, &paths::default_home());
    let path = unit_path(manager, layout, &name);
    (manager, name, path)
}

fn write_unit(unit: &Unit) -> Result<(), ServiceError> {
    let io_err = |err| ServiceError::Io {
        path: unit.path.clone(),
        err,
    };
    if let Some(dir) = unit.path.parent() {
        std::fs::create_dir_all(dir).map_err(io_err)?;
    }
    let bytes = match unit.manager {
        // schtasks /XML reads the declared UTF-16: little endian with a BOM.
        Manager::TaskScheduler => schtasks::utf16le_with_bom(&unit.content),
        _ => unit.content.as_bytes().to_vec(),
    };
    std::fs::write(&unit.path, bytes).map_err(io_err)
}

/// Removes `path`; a missing file is fine.
pub(crate) fn remove_file(path: &Path) -> Result<(), ServiceError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(ServiceError::Io {
            path: path.to_path_buf(),
            err,
        }),
    }
}

/// Runs `program args`; `Err` when it cannot start. The caller decides what a non-zero exit means.
pub(crate) fn exec(
    r: &dyn Runner,
    program: &str,
    args: &[OsString],
) -> Result<std::process::Output, ServiceError> {
    r.run(program, args).map_err(|err| ServiceError::Spawn {
        program: program.to_string(),
        err,
    })
}

/// Runs `program args` and requires exit 0.
pub(crate) fn exec_ok(
    r: &dyn Runner,
    program: &str,
    args: &[OsString],
) -> Result<(), ServiceError> {
    let out = exec(r, program, args)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(ServiceError::Command {
            program: program.to_string(),
            args: args
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
            code: out.status.code(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

/// `["a", "b"]` → `Vec<OsString>`.
pub(crate) fn os_args<S: AsRef<std::ffi::OsStr>>(args: &[S]) -> Vec<OsString> {
    args.iter().map(|a| a.as_ref().to_os_string()).collect()
}

/// XML text/attribute escaping shared by the plist and the task XML.
pub(crate) fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod testing {
    //! A recording [`Runner`] and a tiny XML-to-JSON reader for the render tests.
    use super::Runner;
    use std::cell::RefCell;
    use std::ffi::OsString;
    use std::io;
    use std::process::Output;

    /// Records every call; answers with `codes[(program, verb)]` or exit 0.
    #[derive(Default)]
    pub struct Recording {
        pub calls: RefCell<Vec<Vec<String>>>,
        pub fail: Vec<(&'static str, i32)>,
    }
    impl Runner for Recording {
        fn run(&self, program: &str, args: &[OsString]) -> io::Result<Output> {
            let mut call = vec![program.to_string()];
            call.extend(args.iter().map(|a| a.to_string_lossy().into_owned()));
            let joined = call.join(" ");
            self.calls.borrow_mut().push(call);
            let code = self
                .fail
                .iter()
                .find(|(needle, _)| joined.contains(needle))
                .map_or(0, |(_, c)| *c);
            Ok(output(code))
        }
    }

    pub(crate) use super::fake::exit_output as output;

    /// Parses an XML property list into JSON (dict → object, array, string, integer, true/false).
    pub fn plist_json(xml: &str) -> serde_json::Value {
        let doc = roxmltree::Document::parse_with_options(
            xml,
            roxmltree::ParsingOptions {
                allow_dtd: true,
                ..Default::default()
            },
        )
        .unwrap();
        let root = doc.root_element();
        assert_eq!(root.tag_name().name(), "plist");
        value(root.children().find(|n| n.is_element()).unwrap())
    }
    fn value(n: roxmltree::Node) -> serde_json::Value {
        use serde_json::{json, Value};
        match n.tag_name().name() {
            "dict" => {
                let els: Vec<_> = n.children().filter(|c| c.is_element()).collect();
                let mut map = serde_json::Map::new();
                for pair in els.chunks(2) {
                    assert_eq!(pair[0].tag_name().name(), "key");
                    map.insert(pair[0].text().unwrap_or("").to_string(), value(pair[1]));
                }
                Value::Object(map)
            }
            "array" => Value::Array(n.children().filter(|c| c.is_element()).map(value).collect()),
            "string" => json!(n.text().unwrap_or("")),
            "integer" => json!(n.text().unwrap().parse::<i64>().unwrap()),
            "true" => json!(true),
            "false" => json!(false),
            other => panic!("unexpected plist element {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::Recording;
    use super::*;

    fn unit(manager: Manager, dir: &Path, name: &str) -> Unit {
        let ext = match manager {
            Manager::Systemd => "service",
            Manager::Launchd => "plist",
            Manager::TaskScheduler => "xml",
        };
        Unit {
            manager,
            name: name.into(),
            path: dir.join(format!("{name}.{ext}")),
            content: "x".into(),
        }
    }

    #[test]
    fn service_name_suffixes_non_default_homes() {
        let default = Path::new("/u/.plur1bus");
        let l = Layout::new(default.into());
        assert_eq!(name_for(Manager::Systemd, &l, default), "plur1bus");
        assert_eq!(
            name_for(Manager::Launchd, &l, default),
            "dev.plur1bus.supervisor"
        );
        assert_eq!(
            name_for(Manager::TaskScheduler, &l, default),
            "PLUR1BUS Supervisor"
        );
        let other = Layout::new("/tmp/P1B".into());
        let h = format!("{:x}", Sha256::digest(b"/tmp/p1b"));
        assert_eq!(
            name_for(Manager::Systemd, &other, default),
            format!("plur1bus-{}", &h[..8])
        );
        assert_eq!(
            name_for(Manager::TaskScheduler, &other, default),
            format!("PLUR1BUS Supervisor-{}", &h[..8])
        );
        // The suffix hashes the lower-cased home, so case variants share it.
        assert_eq!(
            name_for(Manager::Systemd, &Layout::new("/tmp/p1b".into()), default),
            name_for(Manager::Systemd, &other, default)
        );
    }

    /// One table per manager: (start, expected calls).
    #[test]
    fn install_runs_the_manager_commands_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let domain = launchd::gui_domain();
        let cases: Vec<(Manager, &str, bool, Vec<String>)> = vec![
            (
                Manager::Systemd,
                "plur1bus-0d0d4b6f",
                true,
                vec![
                    "systemctl --user daemon-reload".into(),
                    "systemctl --user enable plur1bus-0d0d4b6f.service".into(),
                    "systemctl --user restart plur1bus-0d0d4b6f.service".into(),
                ],
            ),
            (
                Manager::Systemd,
                "plur1bus-0d0d4b6f",
                false,
                vec![
                    "systemctl --user daemon-reload".into(),
                    "systemctl --user enable plur1bus-0d0d4b6f.service".into(),
                ],
            ),
            (
                Manager::Launchd,
                "dev.plur1bus.supervisor-0d0d4b6f",
                true,
                vec![
                    format!("launchctl bootout {domain}/dev.plur1bus.supervisor-0d0d4b6f"),
                    format!("launchctl print {domain}/dev.plur1bus.supervisor-0d0d4b6f"),
                    format!(
                        "launchctl bootstrap {domain} {}",
                        tmp.path()
                            .join("dev.plur1bus.supervisor-0d0d4b6f.plist")
                            .display()
                    ),
                ],
            ),
            (
                Manager::Launchd,
                "dev.plur1bus.supervisor-0d0d4b6f",
                false,
                vec![],
            ),
            (
                Manager::TaskScheduler,
                "PLUR1BUS Supervisor-0d0d4b6f",
                true,
                vec![
                    format!(
                        "schtasks /Create /XML {} /TN PLUR1BUS Supervisor-0d0d4b6f /F",
                        tmp.path()
                            .join("PLUR1BUS Supervisor-0d0d4b6f.xml")
                            .display()
                    ),
                    "schtasks /End /TN PLUR1BUS Supervisor-0d0d4b6f".into(),
                    "schtasks /Run /TN PLUR1BUS Supervisor-0d0d4b6f".into(),
                ],
            ),
            (
                Manager::TaskScheduler,
                "PLUR1BUS Supervisor-0d0d4b6f",
                false,
                vec![format!(
                    "schtasks /Create /XML {} /TN PLUR1BUS Supervisor-0d0d4b6f /F",
                    tmp.path()
                        .join("PLUR1BUS Supervisor-0d0d4b6f.xml")
                        .display()
                )],
            ),
        ];
        for (manager, name, start, want) in cases {
            // launchctl bootout of a job that is not loaded fails (install tolerates it) and print then no longer
            // finds it; schtasks /End fails when nothing runs.
            let r = Recording {
                fail: vec![("bootout", 3), ("print", 113), ("/End", 1)],
                ..Default::default()
            };
            let u = unit(manager, tmp.path(), name);
            install(&r, &u, start).unwrap();
            let got: Vec<String> = r.calls.borrow().iter().map(|c| c.join(" ")).collect();
            assert_eq!(got, want, "{manager:?} start={start}");
            assert!(u.path.exists());
        }
    }

    #[test]
    fn a_trailing_separator_keeps_the_service_name() {
        let default = Path::new("/u/.plur1bus");
        let slash = Layout::new("/u/.plur1bus/".into());
        assert_eq!(name_for(Manager::Systemd, &slash, default), "plur1bus");
        assert_eq!(
            name_for(
                Manager::Systemd,
                &Layout::new("/u/.plur1bus".into()),
                Path::new("/u/.plur1bus//")
            ),
            "plur1bus"
        );
        assert_eq!(
            name_for(Manager::Systemd, &Layout::new("/tmp/x/".into()), default),
            name_for(Manager::Systemd, &Layout::new("/tmp/x".into()), default)
        );
        assert_eq!(trim_trailing_separators("/"), "/");
    }

    #[cfg(unix)]
    #[test]
    fn render_refuses_a_non_utf8_path() {
        use std::os::unix::ffi::OsStrExt;
        let bad = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/p1b-\xff"));
        for manager in [Manager::Systemd, Manager::Launchd, Manager::TaskScheduler] {
            let home = render(
                manager,
                Path::new("/bin/p"),
                &Layout::new(bad.clone()),
                "n",
                &[],
            );
            assert!(
                matches!(&home, Err(ServiceError::PathNotUtf8 { path }) if *path == bad),
                "{manager:?}: {home:?}"
            );
            let bin = render(manager, &bad, &Layout::new("/tmp/h".into()), "n", &[]);
            assert!(
                matches!(bin, Err(ServiceError::PathNotUtf8 { .. })),
                "{manager:?}"
            );
        }
        assert!(render(
            Manager::Systemd,
            Path::new("/bin/p"),
            &Layout::new("/tmp/h".into()),
            "n",
            &[]
        )
        .is_ok());
    }

    #[test]
    fn a_failing_manager_command_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let r = Recording {
            fail: vec![("enable", 1)],
            ..Default::default()
        };
        let err = install(&r, &unit(Manager::Systemd, tmp.path(), "p"), true).unwrap_err();
        assert!(
            matches!(err, ServiceError::Command { code: Some(1), .. }),
            "{err}"
        );
    }

    #[test]
    fn uninstall_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        for manager in [Manager::Systemd, Manager::Launchd] {
            let u = unit(manager, tmp.path(), "n");
            std::fs::write(&u.path, "x").unwrap();
            // launchctl print of an unknown label exits 113.
            let r = Recording {
                fail: vec![("print", 113)],
                ..Default::default()
            };
            assert!(uninstall_unit(&r, manager, "n", &u.path).unwrap());
            assert!(!u.path.exists());
            assert!(!uninstall_unit(&r, manager, "n", &u.path).unwrap());
        }
        // Task Scheduler: registration is asked for with /Query; a missing task exits 1.
        let u = unit(Manager::TaskScheduler, tmp.path(), "n");
        std::fs::write(&u.path, "x").unwrap();
        let r = Recording::default();
        assert!(uninstall_unit(&r, Manager::TaskScheduler, "n", &u.path).unwrap());
        assert!(!u.path.exists());
        let calls: Vec<String> = r.calls.borrow().iter().map(|c| c.join(" ")).collect();
        assert_eq!(
            calls,
            [
                "schtasks /Query /TN n /FO CSV",
                "schtasks /End /TN n",
                "schtasks /Delete /TN n /F"
            ]
        );
        let r = Recording {
            fail: vec![("/Query", 1)],
            ..Default::default()
        };
        assert!(!uninstall_unit(&r, Manager::TaskScheduler, "n", &u.path).unwrap());
    }
}
