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

#[test]
fn concurrent_daemon_starts_leave_one_supervisor_and_one_core() {
    let h = Home::new();
    let a = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
        .spawn()
        .unwrap();
    let b = daemon_cmd(&h, "ok", "0.02", &["daemon", "start"])
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

    wait_until("one started event", WAIT, || {
        h.named_events("started").len() == 1
    });
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
    let mut child = Command::new(bin())
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

    let _ = child.kill();
    let _ = child.wait();
}
