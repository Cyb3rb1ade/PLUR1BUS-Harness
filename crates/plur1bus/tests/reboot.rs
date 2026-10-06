//! Reboot survival as a test strategy (M8 acceptance 3; `docs/reboot-survival.md`). A "reboot" kills every process of
//! a home with SIGKILL, so nothing cleans up after itself, and leaves `run/` as the dead processes left it (stale pid
//! files, sockets, tokens and the lock file) or discards it. The stack then comes back the way a boot brings it back:
//! through the service abstraction. The service manager is the fake one (`PLUR1BUS_SERVICE_FAKE`, it only records
//! commands), and the test plays the OS: it sees the manager's `start` command and launches the registered unit's
//! `supervise`. Core is `tests/fixtures/fake-core.mjs`, the module the built fixture. Temp homes only.
//!
//! Unix only: the kill and the zombie reaping use signals and `waitpid`. Windows and the real service managers are
//! in the manual protocol of `docs/reboot-survival.md`.
#![cfg(unix)]
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(30);
const SCALE: &str = "0.05";

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

fn fixture_core() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs")
}

fn fixture_module() -> PathBuf {
    std::env::var_os("PLUR1BUS_FIXTURE_MODULE")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/module-fixture/dist"))
}

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Orphans of a killed supervisor become this process's children, so a killed core or module is reaped here rather
/// than left a zombie that still answers `kill(pid, 0)` (a container's pid 1 may never reap).
fn become_subreaper() {
    #[cfg(target_os = "linux")]
    // SAFETY: a plain prctl on this process.
    unsafe {
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
    }
}

fn pid_gone(pid: u32) -> bool {
    let mut status = 0;
    // SAFETY: waitpid on a pid that may be our child (a subreaped orphan); ECHILD for any other is fine.
    unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
    // SAFETY: signal 0 only checks that the pid exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) != 0 }
}

fn sigkill(pid: u32) {
    // SAFETY: plain kill(2) on a pid this test's own stack wrote into a pid file.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
}

struct Env {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    user: PathBuf,
    fake: PathBuf,
    events: PathBuf,
    supervisors: Vec<Child>,
}

impl Drop for Env {
    fn drop(&mut self) {
        // a stack still running is stopped cleanly; whatever is left is killed (and only what names this home)
        if let Some(mut c) = self.client() {
            let _ = c.call("daemon.stop", json!({ "budgetMs": 500 }));
        }
        for name in ["core.pid", "supervisor.pid", "module-fixture.pid"] {
            if let Some(pid) = self.pid(name) {
                sigkill(pid);
            }
        }
        for c in &mut self.supervisors {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Env {
    fn new() -> Env {
        become_subreaper();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let (home, user, fake) = (root.join("home"), root.join("user"), root.join("fake"));
        for d in [&home, &user, &fake] {
            std::fs::create_dir_all(d).unwrap();
        }
        let env = Env {
            events: root.join("events.jsonl"),
            _tmp: tmp,
            home,
            user,
            fake,
            supervisors: Vec::new(),
        };
        env.install_module();
        std::fs::write(
            env.home.join("config.json"),
            r#"{"schemaVersion":1,"supervisor":{"graceMs":1000}}"#,
        )
        .unwrap();
        let out = env.cli(&["service", "install", "--no-start"]).output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{out:?}");
        env
    }

    fn install_module(&self) {
        let dst = self.home.join("modules/fixture");
        std::fs::create_dir_all(&dst).unwrap();
        for e in std::fs::read_dir(fixture_module()).unwrap().flatten() {
            if e.file_type().unwrap().is_file() {
                std::fs::copy(e.path(), dst.join(e.file_name())).unwrap();
            }
        }
    }

    /// `plur1bus --json --home <home> <args>` with the fake service manager and the fake core's seams.
    fn cli(&self, args: &[&str]) -> Command {
        let mut c = Command::new(bin());
        c.arg("--json")
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", &self.fake)
            .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", SCALE)
            .env("PLUR1BUS_CORE_JS", fixture_core())
            .env("PLUR1BUS_NODE", "node")
            .env("FAKE_CORE_MODE", "ok")
            .env("FAKE_CORE_EVENTS", &self.events)
            .env("FAKE_CORE_GRACE_MS", "300")
            .env("HOME", &self.user)
            .env_remove("PLUR1BUS_HOME")
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("PLUR1BUS_TEST_INTERNALS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    /// What the OS does with the unit: runs `plur1bus supervise` as the registered service would.
    fn launch_unit(&mut self) -> usize {
        let mut c = self.cli(&["supervise"]);
        c.stdout(Stdio::null()).stderr(Stdio::null());
        // `cli` put `--json` first; `supervise` takes no such flag position problem: it is a global flag.
        self.supervisors.push(c.spawn().unwrap());
        self.supervisors.len() - 1
    }

    fn manager_start_calls(&self) -> usize {
        std::fs::read_to_string(self.fake.join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|c| {
                c["args"].as_array().is_some_and(|a| {
                    a.iter().any(|x| x == "start" || x == "/Run" || x == "kickstart")
                })
            })
            .count()
    }

    /// A boot: `daemon start` asks the registered service to start (the fake manager records it); the test then
    /// launches the unit. Returns the `daemon start` document once the stack is ready.
    fn boot(&mut self) -> Value {
        let before = self.manager_start_calls();
        let start = self.cli(&["daemon", "start"]).spawn().unwrap();
        wait_until("the manager's start command", || self.manager_start_calls() > before);
        self.launch_unit();
        let out = start.wait_with_output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
        let d: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(d["via"], "service", "{d}");
        self.wait_stack_ready();
        d
    }

    fn client(&self) -> Option<Client> {
        let token = std::fs::read_to_string(self.home.join("run/supervisor.token")).ok()?;
        let address = self.home.join("run/supervisor.sock").to_string_lossy().into_owned();
        Client::connect(
            &address,
            token.trim(),
            ConnectOptions {
                connect_timeout: Duration::from_millis(500),
                call_timeout: Duration::from_secs(3),
                endpoint: Endpoint::Supervisor,
                expected_server_pid: None,
            },
        )
        .ok()
    }

    fn status(&self) -> Option<Value> {
        self.client()?.call("daemon.status", json!({})).ok()
    }

    fn wait_stack_ready(&self) {
        wait_until("core and module ready", || {
            self.status().is_some_and(|s| {
                let kids = s["children"].as_array().cloned().unwrap_or_default();
                kids.len() == 2 && kids.iter().all(|c| c["process"]["state"] == "ready" || c["state"] == "ready")
            })
        });
    }

    fn pid(&self, name: &str) -> Option<u32> {
        std::fs::read_to_string(self.home.join("run").join(name))
            .ok()?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    }

    fn events(&self, name: &str) -> usize {
        std::fs::read_to_string(&self.events)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| e["event"] == name)
            .count()
    }

    /// The pids of every process of the stack, from `run/`.
    fn stack_pids(&self) -> Vec<u32> {
        ["supervisor.pid", "core.pid", "module-fixture.pid"]
            .iter()
            .filter_map(|n| self.pid(n))
            .collect()
    }

    /// Power loss: SIGKILL every process of the stack at once (the supervisor stopped first, so it cannot restart a
    /// child), and wait until none is left. `run/` stays exactly as the dead processes left it.
    fn power_off(&mut self) -> Vec<u32> {
        let pids = self.stack_pids();
        assert_eq!(pids.len(), 3, "supervisor, core and module are up before the reboot");
        // SAFETY: SIGSTOP on the supervisor so no child is respawned while the others are killed.
        unsafe { libc::kill(pids[0] as libc::pid_t, libc::SIGSTOP) };
        for p in pids.iter().rev() {
            sigkill(*p);
        }
        for c in &mut self.supervisors {
            let _ = c.wait();
        }
        self.supervisors.clear();
        wait_until("every process dead", || pids.iter().all(|p| pid_gone(*p)));
        pids
    }

    fn check(&self) -> Value {
        let out: Output = self.cli(&["1staid", "check"]).output().unwrap();
        serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{e}: {out:?}"))
    }

    fn check_row(&self, id: &str) -> Value {
        self.check()["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .cloned()
            .unwrap_or_else(|| panic!("no check {id}"))
    }
}

#[test]
fn a_rebooted_stack_replaces_what_the_dead_processes_left_behind() {
    let mut e = Env::new();
    e.boot();
    let old = e.power_off();

    // what a power loss leaves: pid files, sockets, tokens and the lock file of processes that no longer exist
    let run = e.home.join("run");
    for f in ["core.pid", "supervisor.pid", "module-fixture.pid", "supervisor.sock", "core.sock", "supervisor.lock"] {
        assert!(run.join(f).exists(), "{f} should be left behind");
    }
    let row = e.check_row("run.stale-files");
    assert_eq!(row["status"], "warn", "{row}");
    let files: Vec<String> = row["detail"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap().to_string())
        .collect();
    for f in ["core.pid", "supervisor.pid", "supervisor.sock", "module-fixture.pid"] {
        assert!(files.contains(&f.to_string()), "{f} not reported stale: {files:?}");
    }

    // the boot after it
    e.boot();
    let new = e.stack_pids();
    assert_eq!(new.len(), 3);
    for (o, n) in old.iter().zip(&new) {
        assert_ne!(o, n, "a new process, not the old pid");
    }
    let st = e.status().unwrap();
    let kids = st["children"].as_array().unwrap();
    assert_eq!(kids.len(), 2, "one core and one module: {st}");
    assert_eq!(st["supervisor"]["pid"].as_u64(), Some(new[0] as u64));
    assert_eq!(e.check_row("run.stale-files")["status"], "ok");
    assert_eq!(e.events("started"), 2, "one core per boot");
}

#[test]
fn a_discarded_run_directory_is_recreated_private() {
    use std::os::unix::fs::PermissionsExt;
    let mut e = Env::new();
    e.boot();
    e.power_off();
    std::fs::remove_dir_all(e.home.join("run")).unwrap();

    e.boot();
    let mode = std::fs::metadata(e.home.join("run")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "run/ is private again");
    for f in ["supervisor.sock", "supervisor.token", "core.sock", "core.token", "module-fixture.pid"] {
        assert!(e.home.join("run").join(f).exists(), "{f} recreated");
    }
    assert_eq!(e.check_row("run.permissions")["status"], "ok");
    assert_eq!(e.check_row("run.stale-files")["status"], "ok");
}

#[test]
fn a_repair_clears_the_stale_files_without_starting_anything() {
    let mut e = Env::new();
    e.boot();
    e.power_off();
    assert_eq!(e.check_row("run.stale-files")["status"], "warn");
    let out = e.cli(&["1staid", "repair", "--yes", "--only", "run.stale-files.remove"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(e.check_row("run.stale-files")["status"], "ok");
    assert!(e.stack_pids().is_empty() || e.stack_pids().iter().all(|p| pid_gone(*p)));
    assert!(e.home.join("run/supervisor.lock").exists(), "the lock file is never removed (ADR-012 §10)");
}

#[test]
fn a_second_start_after_a_reboot_never_makes_a_second_core() {
    let mut e = Env::new();
    e.boot();
    e.power_off();

    // the boot: the unit starts, and at the same moment an impatient `daemon start` and a second launch of the unit
    let first = e.launch_unit();
    let start = e.cli(&["daemon", "start"]).spawn().unwrap();
    let second = e.launch_unit();
    let out = start.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    e.wait_stack_ready();

    // the loser of the single-instance race left (exit 3: lost the race)
    wait_until("the losing launch to exit", || {
        e.supervisors.iter_mut().any(|c| c.try_wait().ok().flatten().is_some())
    });
    let exited: Vec<Option<i32>> = e
        .supervisors
        .iter_mut()
        .filter_map(|c| c.try_wait().ok().flatten().map(|s| s.code()))
        .collect();
    assert_eq!(exited, vec![Some(3)], "exactly one launch lost the race");
    let _ = (first, second);

    let st = e.status().unwrap();
    assert_eq!(st["children"].as_array().unwrap().len(), 2, "{st}");
    assert_eq!(e.events("started"), 2, "one core from the first boot, one from this one");
    let core = e.pid("core.pid").unwrap();
    assert!(!pid_gone(core));
}
