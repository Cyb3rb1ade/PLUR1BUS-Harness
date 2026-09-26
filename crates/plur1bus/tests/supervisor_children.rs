//! `plur1bus supervise` with a child: spawn, handshake readiness, health, hang kill, restart with backoff, the out
//! log, `daemon.start` and the stop sequence. The core is `tests/fixtures/fake-core.mjs`, reached through
//! `PLUR1BUS_CORE_JS` / `PLUR1BUS_NODE`. Every test uses its own temp home.
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(15);

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs")
}

/// A temp home (optionally a sub-directory with an awkward name) plus the fake core's event file.
struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
    events: PathBuf,
}

impl Home {
    fn new() -> Self {
        Self::named(None)
    }
    fn named(sub: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = match sub {
            Some(s) => dir.path().join(s),
            None => dir.path().to_path_buf(),
        };
        std::fs::create_dir_all(&home).unwrap();
        let events = dir.path().join("events.jsonl");
        Self {
            _dir: dir,
            home,
            events,
        }
    }
    fn write_config(&self, config: Value) {
        std::fs::write(self.home.join("config.json"), config.to_string()).unwrap();
    }
    fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.events)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
    fn named_events(&self, name: &str) -> Vec<Value> {
        self.events()
            .into_iter()
            .filter(|e| e["event"] == name)
            .collect()
    }
    fn log(&self, file: &str) -> String {
        std::fs::read_to_string(self.home.join("logs").join(file)).unwrap_or_default()
    }
}

/// Kills the supervisor if a test ends before it exits; its core then loses the lifeline and exits after its grace.
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
    fn wait_exit(&mut self, within: Duration) -> ExitStatus {
        let deadline = Instant::now() + within;
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s;
            }
            assert!(
                Instant::now() < deadline,
                "supervisor did not exit within {within:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn start(h: &Home, mode: &str, scale: &str) -> Supervisor {
    let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&h.home)
        .arg("supervise")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", scale)
        .env("PLUR1BUS_CORE_JS", fixture())
        .env("PLUR1BUS_NODE", "node")
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env("FAKE_CORE_MODE", mode)
        .env("FAKE_CORE_EVENTS", &h.events)
        .env("FAKE_CORE_GRACE_MS", "300")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let s = Supervisor { child };
    wait_until("run/supervisor.token", WAIT, || {
        h.home.join("run/supervisor.token").exists()
    });
    s
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

fn validator(pointer: &str) -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
    let doc = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": format!("#/$defs/methods/{pointer}"),
        "$defs": schema["$defs"],
    });
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&doc)
        .unwrap()
}

/// `daemon.status`, validated against the schema; returns `children[0]` (or null).
fn core_child(c: &mut Client) -> Value {
    let st = c.call("daemon.status", json!({})).unwrap();
    let errors: Vec<String> = validator("daemon.status/result")
        .iter_errors(&st)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?} in {st}");
    st["children"].get(0).cloned().unwrap_or(Value::Null)
}

fn wait_child(c: &mut Client, what: &str, within: Duration, f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + within;
    loop {
        let child = core_child(c);
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

fn state(child: &Value) -> &str {
    child["process"]["state"].as_str().unwrap_or("")
}

fn pid_file(home: &Path) -> Option<u64> {
    std::fs::read_to_string(home.join("run/core.pid"))
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

#[test]
fn spawns_the_core_and_reports_ready_after_the_handshake() {
    let h = Home::new();
    let _s = start(&h, "ok", "0.02");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "ready", WAIT, |c| state(c) == "ready");
    assert_eq!(child["role"], "core");
    assert_eq!(child["adopted"], false);
    assert_eq!(child["restarts"], 0);
    assert_eq!(child["pid"].as_u64(), pid_file(&h.home), "{child}");
    let started = h.named_events("started");
    assert_eq!(started.len(), 1);
    assert_eq!(started[0]["pid"], child["pid"]);
    assert_eq!(started[0]["instanceId"], child["instanceId"]);
    assert_eq!(started[0]["lifeline"], "stdin");
}

#[test]
fn a_crashed_core_is_restarted_with_backoff() {
    let h = Home::new();
    let _s = start(&h, "crash-after:200", "0.02");
    let mut c = client(&h.home);
    wait_child(&mut c, "a restart", WAIT, |c| {
        c["restarts"].as_u64().unwrap_or(0) >= 1
    });
    wait_until("a second started event", WAIT, || {
        h.named_events("started").len() >= 2
    });
    let first_exit = h.named_events("exiting")[0]["at"].as_u64().unwrap();
    let second_start = h.named_events("started")[1]["at"].as_u64().unwrap();
    assert!(
        second_start >= first_exit + 20,
        "restarted {} ms after the exit, backoff is 20 ms",
        second_start as i64 - first_exit as i64
    );
    let child = core_child(&mut c);
    assert!(
        child["lastExit"]["code"] == 1 || state(&child) == "ready",
        "{child}"
    );
}

#[test]
fn five_quick_crashes_end_in_crashed_without_further_attempts() {
    let h = Home::new();
    let _s = start(&h, "exit:1", "0.02");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "giving up", WAIT, |c| {
        state(c) == "crashed" && c["nextRestartAt"].is_null()
    });
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(h.named_events("started").len(), 5);
    let now = core_child(&mut c);
    assert_eq!(state(&now), "crashed", "{now}");
    assert_eq!(now["restarts"], 4);
    assert_eq!(now["lastExit"]["code"], 1);
    assert!(now["pid"].is_null());
    assert_eq!(child["restarts"], 4);
}

#[test]
fn exit_code_2_is_fatal_config_invalid() {
    let h = Home::new();
    let _s = start(&h, "exit:2", "0.02");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "crashed", WAIT, |c| state(c) == "crashed");
    assert_eq!(child["process"]["reason"], "config-invalid", "{child}");
    assert_eq!(child["lastExit"]["code"], 2);
    assert_eq!(child["lastExit"]["reason"], "config-invalid");
    assert!(child["nextRestartAt"].is_null());
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(h.named_events("started").len(), 1);
    assert_eq!(state(&core_child(&mut c)), "crashed");
}

#[test]
fn daemon_start_after_crashed_resets_and_respawns() {
    let h = Home::new();
    let _s = start(&h, "exit:1", "0.02");
    let mut c = client(&h.home);
    wait_child(&mut c, "giving up", WAIT, |c| {
        state(c) == "crashed" && c["nextRestartAt"].is_null()
    });
    assert_eq!(h.named_events("started").len(), 5);
    let r = c.call("daemon.start", json!({ "role": "core" })).unwrap();
    let errors: Vec<String> = validator("daemon.start/result")
        .iter_errors(&r)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?} in {r}");
    assert_eq!(r, json!({ "accepted": true, "role": "core" }));
    // The backoff was reset: a fresh budget of five attempts.
    wait_until("five more started events", WAIT, || {
        h.named_events("started").len() >= 10
    });
    wait_child(&mut c, "giving up again", WAIT, |c| {
        state(c) == "crashed" && c["nextRestartAt"].is_null()
    });
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(h.named_events("started").len(), 10);
}

#[test]
fn a_hung_core_is_terminated_after_the_hang_threshold() {
    let h = Home::new();
    let _s = start(&h, "hang-after:300", "0.02");
    let mut c = client(&h.home);
    let first = wait_child(&mut c, "ready", WAIT, |c| state(c) == "ready");
    let first_pid = first["pid"].as_u64().unwrap();
    wait_child(&mut c, "a restart", WAIT, |c| {
        c["restarts"].as_u64().unwrap_or(0) >= 1
    });
    wait_until("a second started event", WAIT, || {
        h.named_events("started").len() >= 2
    });
    let log = h.log("supervisor.log");
    assert!(log.contains("core hung, terminating"), "{log}");
    let killed = log.contains("\"step\":\"kill\"") || log.contains("\"step\":\"terminate\"");
    let shut = h
        .named_events("shutdown")
        .iter()
        .any(|e| e["pid"] == first_pid);
    assert!(killed || shut, "neither a shutdown nor a kill: {log}");
    #[cfg(unix)]
    {
        // The fake has no SIGTERM handler, so the SIGTERM step ends it.
        let child = core_child(&mut c);
        let exit_signal = child["lastExit"]["signal"].clone();
        assert!(
            exit_signal == "SIGTERM" || state(&child) != "crashed",
            "{child}"
        );
    }
}

#[test]
fn one_late_health_reply_does_not_degrade_or_kill() {
    let h = Home::new();
    // healthIntervalMs 1000 is the config schema's minimum (the brief's 200 would be refused, like H3-R8).
    h.write_config(json!({ "schemaVersion": 1, "supervisor": { "healthIntervalMs": 1000 } }));
    let _s = start(&h, "slow-status:2:3000", "1.0");
    let mut c = client(&h.home);
    let first = wait_child(&mut c, "ready", WAIT, |c| state(c) == "ready");
    let pid = first["pid"].clone();
    let until = Instant::now() + Duration::from_millis(5500);
    while Instant::now() < until {
        let child = core_child(&mut c);
        assert_eq!(state(&child), "ready", "{child}");
        assert_eq!(child["pid"], pid);
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(h.named_events("started").len(), 1);
    let log = h.log("supervisor.log");
    // Windows reads have no deadline yet (Task 10), so there the late reply simply arrives late.
    #[cfg(unix)]
    assert!(
        log.contains("health poll failed"),
        "the slow reply was not a failed poll: {log}"
    );
    assert!(!log.contains("config.json unreadable"), "{log}");
}

#[test]
fn child_output_goes_to_the_out_log() {
    let h = Home::new();
    let _s = start(&h, "ok", "0.02");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "ready", WAIT, |c| state(c) == "ready");
    let marker = format!("fake-core stderr marker pid={}", child["pid"]);
    wait_until("the marker in logs/core.out.log", WAIT, || {
        h.log("core.out.log").contains(&marker)
    });
}

#[test]
fn daemon_stop_shuts_the_core_down_first() {
    let h = Home::new();
    let mut s = start(&h, "ok", "0.02");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "ready", WAIT, |c| state(c) == "ready");
    let pid = child["pid"].clone();
    assert_eq!(
        c.call("daemon.stop", json!({ "budgetMs": 2000 })).unwrap(),
        json!({ "accepted": true })
    );
    let status = s.wait_exit(WAIT);
    assert_eq!(status.code(), Some(0));
    // Read right after the supervisor's exit: the core had already shut down.
    let shutdown = h.named_events("shutdown");
    assert_eq!(shutdown.len(), 1, "{:?}", h.events());
    assert_eq!(shutdown[0]["pid"], pid);
    assert_eq!(shutdown[0]["budgetMs"], 2000);
    let exiting = h.named_events("exiting");
    assert_eq!(exiting.len(), 1);
    assert_eq!(exiting[0]["code"], 0);
    let log = h.log("supervisor.log");
    let exited = log
        .lines()
        .position(|l| l.contains("core exited") && l.contains("\"state\":\"stopped\""))
        .unwrap_or_else(|| panic!("no stopped exit in {log}"));
    let stopped = log
        .lines()
        .position(|l| l.contains("supervisor stopped"))
        .unwrap();
    assert!(exited < stopped, "{log}");
    assert!(h.named_events("orphaned").is_empty());
}

#[test]
fn spawns_under_a_home_with_spaces() {
    let h = Home::named(Some("p1b sys ü"));
    let _s = start(&h, "ok", "0.02");
    let mut c = client(&h.home);
    let child = wait_child(&mut c, "ready", WAIT, |c| state(c) == "ready");
    assert_eq!(child["pid"].as_u64(), pid_file(&h.home));
    let started = h.named_events("started");
    assert_eq!(
        Path::new(started[0]["home"].as_str().unwrap()),
        h.home.as_path()
    );
}
