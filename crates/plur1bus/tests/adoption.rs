//! Adoption (spec §6.4, rulings S3–S6): a supervisor that starts while a core is already running probes it, adopts a
//! healthy one through `core.adopt` (the connection becomes the core's lifeline), and terminates a hung or foreign
//! one — identified by the socket's peer credentials, never by a pid read from a file — before spawning a fresh core.
//! The core is `tests/fixtures/fake-core.mjs`; every duration is scaled by 0.02 except the fake core's own grace.
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(15);
/// A grace no test outlives: the core stays orphaned until a new supervisor adopts it.
const LONG_GRACE: &str = "20000";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs")
}

struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
    events: PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let events = dir.path().join("events.jsonl");
        Self {
            _dir: dir,
            home,
            events,
        }
    }
    fn events(&self, name: &str) -> Vec<Value> {
        std::fs::read_to_string(&self.events)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| e["event"] == name)
            .collect()
    }
    fn log_records(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("logs/supervisor.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
    fn token(&self) -> String {
        std::fs::read_to_string(self.home.join("run/supervisor.token"))
            .unwrap()
            .trim()
            .to_string()
    }
}

/// Kills the supervisor (SIGKILL / TerminateProcess) if a test ends before it exits.
struct Supervisor {
    child: Child,
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Supervisor {
    /// The supervisor dies without a stop: the core loses its lifeline and is orphaned.
    fn kill(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
    fn wait_exit(&mut self, within: Duration) -> ExitStatus {
        let deadline = Instant::now() + within;
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s;
            }
            assert!(Instant::now() < deadline, "supervisor did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// `daemon.stop`: the supervisor shuts the core down and exits 0.
    fn stop(&mut self, c: &mut Client) {
        c.call("daemon.stop", json!({})).unwrap();
        assert!(self.wait_exit(WAIT).success());
    }
}

fn start(h: &Home, grace_ms: &str) -> Supervisor {
    let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&h.home)
        .arg("supervise")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.02")
        .env("PLUR1BUS_CORE_JS", fixture())
        .env("PLUR1BUS_NODE", "node")
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env("FAKE_CORE_MODE", "ok")
        .env("FAKE_CORE_EVENTS", &h.events)
        .env("FAKE_CORE_GRACE_MS", grace_ms)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    let s = Supervisor { child };
    // A killed supervisor leaves its run files behind: wait for this one's pid file.
    wait_until("run/supervisor.pid of the new supervisor", WAIT, || {
        std::fs::read_to_string(h.home.join("run/supervisor.pid"))
            .is_ok_and(|p| p.split_whitespace().next() == Some(&pid.to_string()))
    });
    s
}

/// A fake core started by hand (no supervisor, no lifeline), reaped by a background thread as soon as it exits.
struct HandCore {
    child: Arc<Mutex<Child>>,
    status: Arc<Mutex<Option<ExitStatus>>>,
    pid: u32,
}
impl HandCore {
    fn start(h: &Home, mode: &str) -> Self {
        let child = Command::new("node")
            .arg(fixture())
            .arg("--home")
            .arg(&h.home)
            .env("FAKE_CORE_MODE", mode)
            .env("FAKE_CORE_EVENTS", &h.events)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let child = Arc::new(Mutex::new(child));
        let status = Arc::new(Mutex::new(None));
        let (c, s) = (child.clone(), status.clone());
        std::thread::spawn(move || loop {
            if let Ok(Some(st)) = c.lock().unwrap().try_wait() {
                *s.lock().unwrap() = Some(st);
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        });
        wait_until("the hand-started core's pid file", WAIT, || {
            pid_file(&h.home).is_some_and(|(p, _)| p == u64::from(pid))
        });
        Self { child, status, pid }
    }
    fn exit_status(&self) -> Option<ExitStatus> {
        *self.status.lock().unwrap()
    }
}
impl Drop for HandCore {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
    }
}

fn wait_until(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
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

fn client(home: &Path) -> Client {
    let opts = ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Supervisor,
    };
    let deadline = Instant::now() + WAIT;
    loop {
        let token = std::fs::read_to_string(home.join("run/supervisor.token")).unwrap_or_default();
        match Client::connect(&supervisor_address(home), token.trim(), opts.clone()) {
            Ok(c) => return c,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("cannot connect to the supervisor: {e}"),
        }
    }
}

fn validator() -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
    let doc = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": "#/$defs/methods/daemon.status/result",
        "$defs": schema["$defs"],
    });
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&doc)
        .unwrap()
}

/// `daemon.status` (validated against the schema) until `children[0]` satisfies `f`.
fn wait_child(c: &mut Client, what: &str, f: impl Fn(&Value) -> bool) -> Value {
    let v = validator();
    let deadline = Instant::now() + WAIT;
    loop {
        let st = c.call("daemon.status", json!({})).unwrap();
        let errors: Vec<String> = v.iter_errors(&st).map(|e| e.to_string()).collect();
        assert!(errors.is_empty(), "{errors:?} in {st}");
        let child = st["children"].get(0).cloned().unwrap_or(Value::Null);
        if f(&child) {
            return child;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}; last: {child}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn ready(child: &Value) -> bool {
    child["process"]["state"] == "ready"
}

/// `run/core.pid` as `(pid, instanceId)`.
fn pid_file(home: &Path) -> Option<(u64, String)> {
    let s = std::fs::read_to_string(home.join("run/core.pid")).ok()?;
    let mut it = s.split_whitespace();
    Some((it.next()?.parse().ok()?, it.next()?.to_string()))
}

fn probe_results(h: &Home) -> Vec<String> {
    h.log_records()
        .iter()
        .filter(|r| r["msg"] == "core probe")
        .map(|r| r["result"].as_str().unwrap_or("").to_string())
        .collect()
}

#[test]
fn supervisor_killed_and_restarted_within_grace_adopts_the_same_core() {
    let h = Home::new();
    let mut s1 = start(&h, LONG_GRACE);
    let mut c = client(&h.home);
    let first = wait_child(&mut c, "ready", ready);
    assert_eq!(first["adopted"], false);
    let pid = first["pid"].as_u64().unwrap();

    s1.kill();
    wait_until("orphaned", WAIT, || h.events("orphaned").len() == 1);

    let mut s2 = start(&h, LONG_GRACE);
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "adopted and ready", |c| {
        ready(c) && c["adopted"] == true
    });
    assert_eq!(child["pid"].as_u64(), Some(pid), "{child}");
    assert_eq!(child["instanceId"], first["instanceId"]);
    assert_eq!(child["restarts"], 0);
    let adopted = h.events("adopted");
    assert_eq!(adopted.len(), 1);
    assert_eq!(adopted[0]["pid"].as_u64(), Some(pid));
    assert_eq!(adopted[0]["nonce"], h.token().as_str());
    assert_eq!(h.events("started").len(), 1, "no second core was spawned");
    assert_eq!(probe_results(&h), ["absent", "serving"]);

    // The adopted core is stopped like a spawned one.
    s2.stop(&mut c);
    let shutdown = h.events("shutdown");
    assert_eq!(shutdown.len(), 1);
    assert_eq!(shutdown[0]["pid"].as_u64(), Some(pid));
}

#[test]
fn beyond_grace_the_core_exits_and_a_fresh_one_is_spawned() {
    let h = Home::new();
    let mut s1 = start(&h, "300");
    let mut c = client(&h.home);
    let first = wait_child(&mut c, "ready", ready);
    let pid = first["pid"].as_u64().unwrap();

    s1.kill();
    std::thread::sleep(Duration::from_secs(1));
    let exits = h.events("exiting");
    assert_eq!(exits.len(), 1, "the orphan exits after its grace");
    assert_eq!(exits[0]["pid"].as_u64(), Some(pid));

    let mut s2 = start(&h, "300");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "a fresh core", ready);
    assert_eq!(child["adopted"], false);
    assert_ne!(child["pid"].as_u64(), Some(pid));
    assert_eq!(child["pid"].as_u64(), pid_file(&h.home).map(|p| p.0));
    assert!(h.events("adopted").is_empty());
    assert_eq!(h.events("started").len(), 2);
    s2.stop(&mut c);
}

#[test]
fn killing_the_supervisor_twice_readopts() {
    let h = Home::new();
    let mut s1 = start(&h, LONG_GRACE);
    let mut c = client(&h.home);
    let pid = wait_child(&mut c, "ready", ready)["pid"].as_u64().unwrap();

    s1.kill();
    wait_until("orphaned after the stdin lifeline", WAIT, || {
        h.events("orphaned").len() == 1
    });
    let mut s2 = start(&h, LONG_GRACE);
    let mut c = client(&h.home);
    wait_child(&mut c, "first adoption", |c| {
        ready(c) && c["adopted"] == true && c["pid"].as_u64() == Some(pid)
    });

    // The adopted core's lifeline is now the core.adopt connection: losing it orphans the core again.
    s2.kill();
    wait_until("orphaned after the connection lifeline", WAIT, || {
        h.events("orphaned").len() == 2
    });
    let mut s3 = start(&h, LONG_GRACE);
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "second adoption", |c| {
        ready(c) && c["adopted"] == true
    });
    assert_eq!(child["pid"].as_u64(), Some(pid));
    let adopted = h.events("adopted");
    assert_eq!(adopted.len(), 2);
    assert_eq!(adopted[1]["nonce"], h.token().as_str());
    assert_ne!(adopted[0]["nonce"], adopted[1]["nonce"]);
    assert_eq!(h.events("started").len(), 1);
    s3.stop(&mut c);
}

/// The adopted core is not the supervisor's child: its exit is seen as lifeline EOF plus the pid being gone, is
/// `adopted-exit` (retryable), and the restart spawns a fresh core with the supervisor's own spec.
#[cfg(unix)]
#[test]
fn an_adopted_core_that_exits_is_restarted_as_adopted_exit() {
    let h = Home::new();
    let mut s1 = start(&h, LONG_GRACE);
    let mut c = client(&h.home);
    let pid = wait_child(&mut c, "ready", ready)["pid"].as_u64().unwrap();
    s1.kill();
    wait_until("orphaned", WAIT, || h.events("orphaned").len() == 1);
    let mut s2 = start(&h, LONG_GRACE);
    let mut c = client(&h.home);
    wait_child(&mut c, "adopted", |c| ready(c) && c["adopted"] == true);

    // SAFETY: SIGKILL to the fake core this test started (through the first supervisor).
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }, 0);
    let child = wait_child(&mut c, "a respawned core", |c| {
        ready(c) && c["pid"].as_u64().is_some_and(|p| p != pid)
    });
    assert_eq!(child["adopted"], false);
    assert_eq!(child["restarts"], 1);
    assert_eq!(child["lastExit"]["reason"], "adopted-exit", "{child}");
    assert_eq!(child["lastExit"]["code"], Value::Null);
    assert_eq!(h.events("started").len(), 2);
    let exited: Vec<Value> = h
        .log_records()
        .into_iter()
        .filter(|r| r["msg"] == "core exited")
        .collect();
    assert_eq!(exited.len(), 1);
    assert_eq!(exited[0]["pid"].as_u64(), Some(pid));
    assert_eq!(exited[0]["reason"], "adopted-exit");
    assert_eq!(exited[0]["state"], "crashed");
    s2.stop(&mut c);
}

#[cfg(unix)]
#[test]
fn a_hung_core_found_at_start_is_terminated_and_replaced() {
    use std::os::unix::process::ExitStatusExt;
    let h = Home::new();
    let hung = HandCore::start(&h, "hang-after:0");
    wait_until("hung", WAIT, || !h.events("hung").is_empty());

    let mut s = start(&h, "300");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "a fresh core", |c| {
        ready(c) && c["pid"].as_u64() != Some(u64::from(hung.pid))
    });
    assert_eq!(child["adopted"], false);
    wait_until("the hung core reaped", WAIT, || {
        hung.exit_status().is_some()
    });
    assert_eq!(
        hung.exit_status().unwrap().signal(),
        Some(libc::SIGTERM),
        "terminated with SIGTERM after the core.shutdown attempt"
    );
    assert_eq!(probe_results(&h), ["hung"]);
    let steps: Vec<Value> = h
        .log_records()
        .into_iter()
        .filter(|r| r["msg"] == "terminating a core found at start")
        .collect();
    assert!(!steps.is_empty());
    assert!(steps
        .iter()
        .all(|r| r["pid"].as_u64() == Some(u64::from(hung.pid))));
    assert_eq!(steps[0]["step"], "shutdown");
    assert!(steps.iter().any(|r| r["step"] == "terminate"), "{steps:?}");
    s.stop(&mut c);
}

#[test]
fn a_foreign_instance_id_is_terminated() {
    let h = Home::new();
    let foreign = HandCore::start(&h, "ok");
    let other = "7d3c1b0e-5a4f-4e21-9c8b-2f6a1d0e9b73";
    std::fs::write(
        h.home.join("run/core.pid"),
        format!("{} {other}\n", foreign.pid),
    )
    .unwrap();

    let mut s = start(&h, "300");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "a fresh core", |c| {
        ready(c) && c["pid"].as_u64() != Some(u64::from(foreign.pid))
    });
    assert_eq!(child["adopted"], false);
    wait_until("the foreign core gone", WAIT, || {
        foreign.exit_status().is_some()
    });
    let shutdown = h.events("shutdown");
    assert_eq!(shutdown.len(), 1, "core.shutdown reached the foreign core");
    assert_eq!(shutdown[0]["pid"].as_u64(), Some(u64::from(foreign.pid)));
    assert!(h.events("adopted").is_empty());
    assert_eq!(probe_results(&h), ["foreign"]);
    let probe = h
        .log_records()
        .into_iter()
        .find(|r| r["msg"] == "core probe")
        .unwrap();
    assert_eq!(probe["peerPid"].as_u64(), Some(u64::from(foreign.pid)));
    assert_eq!(probe["reason"], "instance-mismatch");
    s.stop(&mut c);
}

/// Review Focus 3: after a power loss `run/core.sock`, `run/core.pid` and `run/core.token` are left with no process.
#[cfg(unix)]
#[test]
fn a_stale_core_socket_probes_absent() {
    let h = Home::new();
    let run = h.home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    drop(std::os::unix::net::UnixListener::bind(run.join("core.sock")).unwrap());
    assert!(run.join("core.sock").exists());
    std::fs::write(
        run.join("core.pid"),
        "999999 7d3c1b0e-5a4f-4e21-9c8b-2f6a1d0e9b73\n",
    )
    .unwrap();
    std::fs::write(run.join("core.token"), "d".repeat(64)).unwrap();

    let mut s = start(&h, "300");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "a fresh core", ready);
    assert_eq!(child["adopted"], false);
    assert_eq!(child["restarts"], 0);
    assert_eq!(child["pid"].as_u64(), pid_file(&h.home).map(|p| p.0));
    assert_eq!(h.events("started").len(), 1);
    assert_eq!(probe_results(&h), ["absent"]);
    assert!(!h
        .log_records()
        .iter()
        .any(|r| r["msg"] == "terminating a core found at start"));
    s.stop(&mut c);
}
