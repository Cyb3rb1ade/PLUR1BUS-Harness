//! `plur1bus daemon start|stop|restart|status` and the supervisor's view in core-unavailable answers (spec §6.4,
//! §6.6, ruling H3-R4). The core is `tests/fixtures/fake-core.mjs`, reached through `PLUR1BUS_CORE_JS`/
//! `PLUR1BUS_NODE`, at scale 0.02. Every test uses its own temp home.
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(15);

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs")
}

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

/// A temp home plus the fake core's event file, mirroring `tests/supervisor_children.rs`.
struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
    events: PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("h");
        std::fs::create_dir_all(&home).unwrap();
        let events = dir.path().join("events.jsonl");
        Self {
            _dir: dir,
            home,
            events,
        }
    }
    fn named_events(&self, name: &str) -> Vec<Value> {
        std::fs::read_to_string(&self.events)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| e["event"] == name)
            .collect()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        teardown(&self.home);
    }
}

/// A `plur1bus --json --home <home> <args>` invocation with the fake-core test seams set, run to completion.
fn daemon_cmd(h: &Home, mode: &str, scale: &str, args: &[&str]) -> Command {
    let mut c = Command::new(bin());
    c.arg("--json")
        .arg("--home")
        .arg(&h.home)
        .args(args)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", scale)
        .env("PLUR1BUS_CORE_JS", fixture())
        .env("PLUR1BUS_NODE", "node")
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env("FAKE_CORE_MODE", mode)
        .env("FAKE_CORE_EVENTS", &h.events)
        .env("FAKE_CORE_GRACE_MS", "300")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

/// A plain `plur1bus --json --home <home> <args>` with no core test seams (no supervisor expected to exist).
fn plain_cmd(h: &Home, args: &[&str]) -> Command {
    let mut c = Command::new(bin());
    c.arg("--json")
        .arg("--home")
        .arg(&h.home)
        .args(args)
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
        .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

fn json_stdout(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: stdout={:?} stderr={:?}", out.stdout, out.stderr))
}

fn supervisor_address(home: &Path) -> String {
    if cfg!(windows) {
        use sha2::{Digest, Sha256};
        let h = format!(
            "{:x}",
            Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes())
        );
        format!(r"\\.\pipe\plur1bus-{}-supervisor", &h[..16])
    } else {
        format!("{}/run/supervisor.sock", home.display())
    }
}

fn opts() -> ConnectOptions {
    ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None,
    }
}

/// Connects to and authenticates with the home's supervisor, retrying while it finishes binding.
fn client(home: &Path) -> Client {
    let deadline = Instant::now() + WAIT;
    loop {
        let token = std::fs::read_to_string(home.join("run/supervisor.token")).unwrap_or_default();
        match Client::connect(&supervisor_address(home), token.trim(), opts()) {
            Ok(c) => return c,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("cannot connect to the supervisor: {e}"),
        }
    }
}

/// Stops a home's supervisor (however it was started) so a test leaves nothing running behind it, and waits for
/// `run/supervisor.pid` to be gone.
fn stop_supervisor(home: &Path) {
    if !home.join("run/supervisor.token").exists() {
        return;
    }
    let mut c = client(home);
    let _ = c.call("daemon.stop", json!({ "budgetMs": 500 }));
    let deadline = Instant::now() + WAIT;
    while home.join("run/supervisor.pid").exists() {
        assert!(Instant::now() < deadline, "supervisor did not stop");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Best-effort teardown of whatever a test started under `home` (final review M1): `daemon.stop` if a supervisor
/// answers, then a kill of every process `run/supervisor.pid` / `run/core.pid` still names — but only one whose
/// command line names this home, so a stale pid file never kills an unrelated, recycled pid. Never panics: it runs
/// from `Drop`, including while a failed assertion unwinds.
fn teardown(home: &Path) {
    let run = home.join("run");
    if let Ok(token) = std::fs::read_to_string(run.join("supervisor.token")) {
        let quick = ConnectOptions {
            connect_timeout: Duration::from_millis(500),
            call_timeout: Duration::from_secs(2),
            endpoint: Endpoint::Supervisor,
            expected_server_pid: None,
        };
        if let Ok(mut c) = Client::connect(&supervisor_address(home), token.trim(), quick) {
            let _ = c.call("daemon.stop", json!({ "budgetMs": 500 }));
            let deadline = Instant::now() + Duration::from_secs(5);
            while run.join("supervisor.pid").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    for name in ["supervisor.pid", "core.pid"] {
        let pid = std::fs::read_to_string(run.join(name))
            .ok()
            .and_then(|t| t.split_whitespace().next()?.parse::<u32>().ok());
        if let Some(pid) = pid {
            kill_if_under(pid, home);
        }
    }
}

#[cfg(unix)]
fn kill_if_under(pid: u32, home: &Path) {
    let Ok(out) = Command::new("ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
    else {
        return;
    };
    if String::from_utf8_lossy(&out.stdout).contains(&*home.to_string_lossy()) {
        // SAFETY: plain kill(2) on a pid whose command line names this test's own temp home.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
}

#[cfg(windows)]
fn kill_if_under(pid: u32, _home: &Path) {
    // No portable command-line lookup here; the pid was written by this test's own processes moments ago.
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let _ = Command::new(Path::new(&system_root).join(r"System32\taskkill.exe"))
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// A process a test spawned itself (`supervise`, `core run`) under `home`: on drop — also when a test panics —
/// [`teardown`] stops the stack cleanly, then the process is killed and reaped (like `tests/supervisor.rs`'s
/// `Supervisor`).
struct Spawned {
    child: std::process::Child,
    home: PathBuf,
}

impl Spawned {
    fn new(child: std::process::Child, home: &Path) -> Self {
        Self {
            child,
            home: home.to_path_buf(),
        }
    }
}

impl Drop for Spawned {
    fn drop(&mut self) {
        teardown(&self.home);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A temp home plus a fake service-manager directory (`PLUR1BUS_SERVICE_FAKE`) and a stand-in user home, for the
/// "start via the registered service" branch — mirrors `tests/service.rs`'s `Env`/`base`, so this never touches a
/// real systemd/launchd/Task Scheduler.
struct ServiceEnv {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    user: PathBuf,
    fake: PathBuf,
}

impl Drop for ServiceEnv {
    fn drop(&mut self) {
        teardown(&self.home);
    }
}

fn service_env() -> ServiceEnv {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let home = root.join("p1b home");
    let user = root.join("user");
    let fake = root.join("fake");
    for d in [&home, &user, &fake] {
        std::fs::create_dir_all(d).unwrap();
    }
    ServiceEnv {
        _tmp: tmp,
        home,
        user,
        fake,
    }
}

fn service_cmd(e: &ServiceEnv, args: &[&str]) -> Command {
    let mut c = Command::new(bin());
    c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SERVICE_FAKE", &e.fake)
        .env("HOME", &e.user)
        .env("USERPROFILE", &e.user)
        .env("LOCALAPPDATA", e.user.join("AppData").join("Local"))
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("PLUR1BUS_HOME")
        .arg("--home")
        .arg(&e.home)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

fn fake_calls(e: &ServiceEnv) -> Vec<Value> {
    std::fs::read_to_string(e.fake.join("calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn host_manager() -> &'static str {
    if cfg!(target_os = "macos") {
        "launchd"
    } else if cfg!(windows) {
        "task-scheduler"
    } else {
        "systemd"
    }
}

fn base_name() -> &'static str {
    match host_manager() {
        "launchd" => "dev.plur1bus.supervisor",
        "task-scheduler" => "PLUR1BUS Supervisor",
        _ => "plur1bus",
    }
}

fn suffix(home: &Path) -> String {
    use sha2::{Digest, Sha256};
    let h = format!(
        "{:x}",
        Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes())
    );
    h[..8].to_string()
}

/// The manager command `daemon start` issues to start an already-registered service (the same shape
/// `commands::daemon::start_via_manager` builds).
fn expected_start_call(name: &str) -> Value {
    match host_manager() {
        "systemd" => {
            json!({ "program": "systemctl", "args": ["--user", "start", format!("{name}.service")] })
        }
        #[cfg(unix)]
        "launchd" => {
            let uid = unsafe { libc::getuid() };
            json!({ "program": "launchctl", "args": ["kickstart", format!("gui/{uid}/{name}")] })
        }
        _ => json!({ "program": "schtasks", "args": ["/Run", "/TN", name] }),
    }
}

fn wait_until(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn daemon_start_spawns_a_detached_supervisor_and_waits_for_ready() {
    let h = Home::new();
    let out = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["via"], "spawn", "{v}");
    assert_eq!(v["started"], true, "{v}");
    assert_eq!(v["status"]["children"][0]["process"]["state"], "ready");

    // The supervisor (and its core) survive after the `daemon start` CLI process has already exited.
    let mut c = client(&h.home);
    assert_eq!(
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"],
        "ready"
    );
    stop_supervisor(&h.home);
}

/// CI round 2: the detached supervisor must not inherit the CLI's stdout/stderr pipes (on Windows every inheritable
/// handle is passed on unless it is marked private). If it did, a caller reading `daemon start`'s output to the end
/// would wait for as long as the supervisor runs. Bounded here, so a regression fails instead of hanging the run.
#[test]
fn daemon_start_returns_while_the_supervisor_keeps_running() {
    let h = Home::new();
    let mut cmd = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"]);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    let out = rx
        .recv_timeout(Duration::from_secs(60))
        .expect("daemon start's output never reached EOF: the supervisor holds the caller's pipe")
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(json_stdout(&out)["started"], true);
    // The supervisor is still up after the caller has read everything.
    let mut c = client(&h.home);
    assert!(c.call("daemon.status", json!({})).is_ok());
    stop_supervisor(&h.home);
}

#[test]
fn daemon_start_twice_is_idempotent() {
    let h = Home::new();
    let out1 = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert_eq!(out1.status.code(), Some(0), "{out1:?}");
    let v1 = json_stdout(&out1);
    assert_eq!(v1["via"], "spawn");
    assert_eq!(v1["started"], true);
    let pid1 = v1["status"]["supervisor"]["pid"].clone();
    assert!(pid1.is_u64());

    let out2 = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert_eq!(out2.status.code(), Some(0), "{out2:?}");
    let v2 = json_stdout(&out2);
    assert_eq!(v2["started"], false, "{v2}");
    assert_eq!(v2["via"], "running", "{v2}");
    assert_eq!(v2["status"]["supervisor"]["pid"], pid1);

    stop_supervisor(&h.home);
}

/// Time scale 0.1, not 0.02: every scaled duration gets more room while two CLIs and two supervisors start at once. The
/// core's ready timeout no longer depends on it (below scale 1/6 it is `CORE_READY_FLOOR`, 10 s); a core killed as
/// `ready-timeout` and respawned would be a second `started` event.
#[test]
fn concurrent_daemon_starts_leave_one_supervisor_and_one_core() {
    let h = Home::new();
    let a = daemon_cmd(&h, "ok", "0.1", &["daemon", "start"])
        .spawn()
        .unwrap();
    let b = daemon_cmd(&h, "ok", "0.1", &["daemon", "start"])
        .spawn()
        .unwrap();
    let out_a = a.wait_with_output().unwrap();
    let out_b = b.wait_with_output().unwrap();
    assert_eq!(out_a.status.code(), Some(0), "{out_a:?}");
    assert_eq!(out_b.status.code(), Some(0), "{out_b:?}");
    let va = json_stdout(&out_a);
    let vb = json_stdout(&out_b);

    let vias: Vec<&str> = vec![va["via"].as_str().unwrap(), vb["via"].as_str().unwrap()];
    assert!(vias.contains(&"spawn"), "{vias:?}");
    assert!(vias.contains(&"running"), "{vias:?}");
    let starts = [
        va["started"].as_bool().unwrap(),
        vb["started"].as_bool().unwrap(),
    ];
    assert_eq!(
        starts.iter().filter(|s| **s).count(),
        1,
        "exactly one of the two races started something: {va} / {vb}"
    );
    // Both report the same (single) supervisor pid.
    assert_eq!(
        va["status"]["supervisor"]["pid"],
        vb["status"]["supervisor"]["pid"]
    );

    let deadline = Instant::now() + WAIT;
    while h.named_events("started").len() != 1 {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for one started event: {:?}\nsupervisor.log:\n{}",
            h.named_events("started"),
            std::fs::read_to_string(h.home.join("logs/supervisor.log")).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut c = client(&h.home);
    assert_eq!(
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"],
        "ready"
    );
    stop_supervisor(&h.home);
}

#[test]
fn daemon_stop_without_supervisor_exits_0_was_running_false() {
    let h = Home::new();
    let out = plain_cmd(&h, &["daemon", "stop"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(
        v,
        json!({ "schema": "daemon.stop/1", "stopped": false, "wasRunning": false })
    );
}

#[test]
fn daemon_stop_stops_a_running_supervisor() {
    let h = Home::new();
    let start = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert_eq!(start.status.code(), Some(0));
    let out = plain_cmd(&h, &["daemon", "stop"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["stopped"], true, "{v}");
    assert_eq!(v["wasRunning"], true, "{v}");
    assert!(!h.home.join("run/supervisor.pid").exists());
}

#[test]
fn daemon_status_without_supervisor_reports_stopped_and_the_service_state() {
    let h = Home::new();
    let out = plain_cmd(&h, &["daemon", "status"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["supervisor"]["process"]["state"], "stopped", "{v}");
    assert_eq!(v["service"]["registered"], false, "{v}");
}

/// Ruling H3-R25: with a running supervisor, `daemon status --json` has the supervisor's own entry at `supervisor`
/// (not the nested `daemon.status` result) and the children beside it; the human output names both states.
#[test]
fn daemon_status_with_a_running_supervisor_is_flat_and_names_the_core() {
    let h = Home::new();
    let start = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert_eq!(start.status.code(), Some(0), "{start:?}");

    let out = plain_cmd(&h, &["daemon", "status"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["schema"], "daemon.status/1", "{v}");
    assert_eq!(v["supervisor"]["process"]["state"], "ready", "{v}");
    assert!(v["supervisor"]["pid"].is_u64(), "{v}");
    assert!(v["supervisor"]["instanceId"].is_string(), "{v}");
    assert!(v["supervisor"].get("supervisor").is_none(), "{v}");
    assert_eq!(v["children"][0]["role"], "core", "{v}");
    assert_eq!(v["children"][0]["process"]["state"], "ready", "{v}");
    assert_eq!(v["service"]["registered"], false, "{v}");

    let human = Command::new(bin())
        .arg("--home")
        .arg(&h.home)
        .args(["daemon", "status"])
        .output()
        .unwrap();
    assert_eq!(human.status.code(), Some(0), "{human:?}");
    let text = String::from_utf8_lossy(&human.stdout);
    assert!(text.contains("supervisor: ready"), "{text}");
    assert!(text.contains("core (core): ready"), "{text}");

    stop_supervisor(&h.home);
}

/// Final review M3: a core that crashes fatally (exit 2 → `config-invalid`, never retried) fails `daemon start` at
/// once with the crash reason instead of waiting out the 30 s readiness timeout — also when the supervisor was
/// already running with that crash, where `daemon.start` resets it and only the *next* crash may end the wait.
#[test]
fn daemon_start_fails_fast_on_a_fatal_crash() {
    let h = Home::new();
    let started = Instant::now();
    let out = daemon_cmd(&h, "exit:2", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{v}");
    assert_eq!(v["reason"], "core-crashed", "{v}");
    assert_eq!(v["detail"], "config-invalid", "{v}");
    let spawns_before = h.named_events("started").len();
    assert!(spawns_before >= 1);

    let out = daemon_cmd(&h, "exit:2", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["reason"], "core-crashed", "{v}");
    assert!(
        h.named_events("started").len() > spawns_before,
        "the second start must end only after the reset core crashed again: {v}"
    );

    stop_supervisor(&h.home);
}

#[cfg(unix)]
#[test]
fn daemon_status_with_a_hung_supervisor_answers_within_a_second() {
    let h = Home::new();
    std::fs::create_dir_all(h.home.join("run")).unwrap();
    std::fs::write(h.home.join("run/supervisor.token"), "a".repeat(64)).unwrap();
    let listener =
        std::os::unix::net::UnixListener::bind(h.home.join("run/supervisor.sock")).unwrap();
    // Accepts a connection and then never reads or writes anything (no hello, ever).
    let _bg = std::thread::spawn(move || {
        if let Ok((s, _)) = listener.accept() {
            let _s = s; // keep the connection open; never read or write on it
            loop {
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    });
    let started = Instant::now();
    let out = plain_cmd(&h, &["daemon", "status"]).output().unwrap();
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(1), "took {elapsed:?}");
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["supervisor"]["process"]["state"], "degraded", "{v}");
    assert_eq!(v["supervisor"]["process"]["reason"], "unresponsive", "{v}");
}

#[cfg(windows)]
#[test]
fn daemon_status_with_a_hung_supervisor_answers_within_a_second() {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    let h = Home::new();
    std::fs::create_dir_all(h.home.join("run")).unwrap();
    std::fs::write(h.home.join("run/supervisor.token"), "a".repeat(64)).unwrap();
    let address = supervisor_address(&h.home);
    let name: Vec<u16> = std::ffi::OsStr::new(&address)
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: `name` is NUL-terminated; a null security-attributes pointer means the default DACL.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            4096,
            4096,
            0,
            std::ptr::null(),
        )
    };
    assert_ne!(handle, INVALID_HANDLE_VALUE);
    // SAFETY: `handle` is a valid handle we own.
    let owned = unsafe { OwnedHandle::from_raw_handle(handle as _) };
    let _bg = std::thread::spawn(move || {
        // SAFETY: `owned` keeps the handle alive for this call; a null OVERLAPPED blocks for a client.
        unsafe { ConnectNamedPipe(owned.as_raw_handle(), std::ptr::null_mut()) };
        loop {
            std::thread::sleep(Duration::from_secs(10));
        }
    });
    let started = Instant::now();
    let out = plain_cmd(&h, &["daemon", "status"]).output().unwrap();
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(1), "took {elapsed:?}");
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["supervisor"]["process"]["state"], "degraded", "{v}");
    assert_eq!(v["supervisor"]["process"]["reason"], "unresponsive", "{v}");
}

#[test]
fn daemon_restart_gives_new_supervisor_and_core_pids() {
    let h = Home::new();
    let start = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
        .output()
        .unwrap();
    assert_eq!(start.status.code(), Some(0));
    let before = json_stdout(&start);
    let sup_pid_before = before["status"]["supervisor"]["pid"].clone();
    let core_pid_before = before["status"]["children"][0]["pid"].clone();

    let out = daemon_cmd(&h, "ok", "0.02", &["daemon", "restart"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["stopped"], true, "{v}");
    assert_eq!(v["wasRunning"], true, "{v}");
    assert_eq!(v["started"], true, "{v}");
    assert_eq!(v["via"], "spawn", "{v}");
    assert_eq!(v["status"]["children"][0]["process"]["state"], "ready");

    let sup_pid_after = v["status"]["supervisor"]["pid"].clone();
    let core_pid_after = v["status"]["children"][0]["pid"].clone();
    assert_ne!(sup_pid_before, sup_pid_after, "{v}");
    assert_ne!(core_pid_before, core_pid_after, "{v}");

    stop_supervisor(&h.home);
}

#[test]
fn recall_with_core_down_names_the_supervisor_state() {
    let h = Home::new();
    // Start a supervisor whose core exits 2 (config-invalid): fatal, no retry (H3-R11/S9).
    let child = Command::new(bin())
        .arg("--home")
        .arg(&h.home)
        .arg("supervise")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.02")
        .env("PLUR1BUS_CORE_JS", fixture())
        .env("PLUR1BUS_NODE", "node")
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env("FAKE_CORE_MODE", "exit:2")
        .env("FAKE_CORE_EVENTS", &h.events)
        .env("FAKE_CORE_GRACE_MS", "300")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _supervise = Spawned::new(child, &h.home);
    wait_until("the supervisor token", WAIT, || {
        h.home.join("run/supervisor.token").exists()
    });
    let mut c = client(&h.home);
    wait_until("the core to crash", WAIT, || {
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"] == "crashed"
    });

    // Register the CLI agent this recall needs.
    let create = Command::new(bin())
        .arg("--home")
        .arg(&h.home)
        .args(["agent", "create", "a1"])
        .output()
        .unwrap();
    assert_eq!(create.status.code(), Some(0), "{create:?}");

    let started = Instant::now();
    let out = Command::new(bin())
        .arg("--json")
        .arg("--home")
        .arg(&h.home)
        .args(["memory", "recall", "--agent", "a1", "anything"])
        .output()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(1), "took {elapsed:?}");
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["degraded"]["reason"], "core-unavailable", "{v}");
    let detail = v["degraded"]["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains("crashed: config-invalid"),
        "detail did not name the supervisor's state: {detail:?}"
    );
}

/// Follow-up 1: `daemon start` prefers a registered OS service over spawning, and does so through the same
/// `PLUR1BUS_SERVICE_FAKE` recording fake `service install|status` use — never a real systemd/launchd/Task
/// Scheduler. The fake only *records* the "start" command (it does not really launch anything), so once it has
/// been recorded — exactly as the real service manager would then have started the process — this test starts a
/// real `supervise` by hand to stand in for that, and checks `daemon start` still reports `via: "service"`.
#[test]
fn daemon_start_uses_a_registered_service_instead_of_spawning() {
    let e = service_env();
    let install = service_cmd(&e, &["--json", "service", "install", "--no-start"])
        .output()
        .unwrap();
    assert_eq!(install.status.code(), Some(0), "{install:?}");
    assert_eq!(
        service_cmd(&e, &["--json", "service", "status"])
            .output()
            .map(|o| json_stdout(&o))
            .unwrap()["registered"],
        true
    );
    let name = format!("{}-{}", base_name(), suffix(&e.home));

    let start = service_cmd(&e, &["--json", "daemon", "start"])
        .spawn()
        .unwrap();

    wait_until("the fake manager's start command", WAIT, || {
        fake_calls(&e).contains(&expected_start_call(&name))
    });
    // Stand in for the OS actually launching the registered process (the fake only records the command).
    let supervise = Command::new(bin())
        .arg("--home")
        .arg(&e.home)
        .arg("supervise")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.02")
        .env("PLUR1BUS_CORE_JS", fixture())
        .env("PLUR1BUS_NODE", "node")
        .env("FAKE_CORE_MODE", "ok")
        .env("FAKE_CORE_EVENTS", e.fake.join("events.jsonl"))
        .env("FAKE_CORE_GRACE_MS", "300")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _supervise = Spawned::new(supervise, &e.home);

    let out = start.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["via"], "service", "{v}");
    assert_eq!(v["started"], true, "{v}");
    assert_eq!(
        v["status"]["children"][0]["process"]["state"], "ready",
        "{v}"
    );
    // Nothing but the fake recorded a command; the assertion above is that the fake's calls, not a real
    // systemctl/launchctl/schtasks, are what `daemon start` drove.
    assert!(fake_calls(&e).contains(&expected_start_call(&name)));
}

/// Follow-up 2: a spawned `supervise` that exits for any reason other than losing the single-instance race (3)
/// is a genuine failure to start, surfaced at once instead of waiting out the full endpoint timeout.
#[test]
fn daemon_start_surfaces_a_spawn_that_exits_immediately() {
    let h = Home::new();
    let started = Instant::now();
    let out = Command::new(bin())
        .arg("--json")
        .arg("--home")
        .arg(&h.home)
        .args(["daemon", "start"])
        // An invalid time scale makes the freshly spawned `supervise` exit(2) almost immediately, well before
        // it ever binds an endpoint (see `supervisor::tests::time_scale_must_be_finite_and_positive`).
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "took {elapsed:?} (should fail almost immediately, not wait out the 10 s endpoint timeout)"
    );
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{v}");
    assert_eq!(v["reason"], "supervisor-exited", "{v}");
    let detail = v["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains('2'),
        "detail did not name the exit code: {detail:?}"
    );
    assert!(!h.home.join("run/supervisor.token").exists());
}
