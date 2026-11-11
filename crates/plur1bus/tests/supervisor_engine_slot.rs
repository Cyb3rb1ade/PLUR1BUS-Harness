//! RE-D172 (RX8 T8a): the supervisor's `engine` slot. With `engine.implementation: "rust"` the supervisor runs
//! `plur1bus-engine serve --home <home> --lifeline stdin --instance <id>` beside the core: started before the core,
//! listed right after it in `daemon status` (`kind: "engine"`), health over `engine.status`, adopted after a supervisor
//! restart through `engine.adopt`, restarted with the core's backoff (its exit 3 is fatal), stopped after the core, and
//! added or removed when a core restart finds the selection changed. `1staid check` reports it in three rows.
//!
//! The engine is `tests/fixtures/fake-engine.mjs` (no engine build): every test home has a `bin/` directory with Node
//! hard-linked as `plur1bus-engine` and a file named `serve` that imports the fixture, and the supervisor runs with
//! that directory as its working directory. The core is `fake-core.mjs`, as in `supervisor_children.rs`.
#[path = "common/owned_children.rs"]
mod owned_children;
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(30);

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn node() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .expect("node on PATH")
}

/// A temp home, its fake engine's `bin/` and the event files of both fakes.
struct Home {
    _dir: tempfile::TempDir,
    home: PathBuf,
    bin: PathBuf,
    core_events: PathBuf,
    engine_events: PathBuf,
}

impl Home {
    /// `implementation`: the `engine.implementation` written to config.json (`None`: no config file at all).
    fn new(implementation: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        // The real engine refuses a home reached through a symlink (macOS: /var -> /private/var) or open to others.
        // Windows keeps the plain path: canonicalize would add the `\\?\` prefix to the home.
        let root = if cfg!(unix) {
            dir.path().canonicalize().unwrap()
        } else {
            dir.path().to_owned()
        };
        let home = root.join("home");
        let bin = root.join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let engine = bin.join(if cfg!(windows) {
            "plur1bus-engine.exe"
        } else {
            "plur1bus-engine"
        });
        let node = node().canonicalize().unwrap();
        if std::fs::hard_link(&node, &engine).is_err() {
            std::fs::copy(&node, &engine).unwrap();
        }
        std::fs::write(
            bin.join("serve"),
            "import(require('node:url').pathToFileURL(process.env.FAKE_ENGINE_JS).href);\n",
        )
        .unwrap();
        let h = Self {
            core_events: root.join("core-events.jsonl"),
            engine_events: root.join("engine-events.jsonl"),
            _dir: dir,
            home,
            bin,
        };
        if let Some(implementation) = implementation {
            h.write_config(
                json!({ "schemaVersion": 1, "engine": { "implementation": implementation } }),
            );
        }
        h
    }
    fn engine_bin(&self) -> PathBuf {
        self.bin.join(if cfg!(windows) {
            "plur1bus-engine.exe"
        } else {
            "plur1bus-engine"
        })
    }
    fn write_config(&self, config: Value) {
        std::fs::write(self.home.join("config.json"), config.to_string()).unwrap();
    }
    fn lines(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
    fn engine_events(&self, name: &str) -> Vec<Value> {
        Self::lines(&self.engine_events)
            .into_iter()
            .filter(|e| e["event"] == name)
            .collect()
    }
    /// `logs/supervisor.log` as JSON records.
    fn log_records(&self) -> Vec<Value> {
        Self::lines(&self.home.join("logs/supervisor.log"))
    }
    /// The position of the first supervisor log record whose `msg` is `msg`.
    fn log_position(&self, msg: &str) -> Option<usize> {
        self.log_records().iter().position(|r| r["msg"] == msg)
    }
}

/// Reaps the supervisor and any remaining peers of this home if a test ends early.
struct Supervisor {
    child: Child,
    home: PathBuf,
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        owned_children::cleanup(&self.home, self.child.id());
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

fn start(h: &Home, env: &[(&str, &str)]) -> Supervisor {
    let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&h.home)
        .arg("supervise")
        .current_dir(&h.bin)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.1")
        .env("PLUR1BUS_CORE_JS", fixture("fake-core.mjs"))
        .env("PLUR1BUS_NODE", "node")
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env("FAKE_CORE_MODE", "ok")
        .env("FAKE_CORE_EVENTS", &h.core_events)
        .env("FAKE_CORE_GRACE_MS", "300")
        .env("PLUR1BUS_ENGINE_BIN", h.engine_bin())
        .env("FAKE_ENGINE_JS", fixture("fake-engine.mjs"))
        .env("FAKE_ENGINE_EVENTS", &h.engine_events)
        .env("FAKE_ENGINE_GRACE_MS", "300")
        .env_remove("FAKE_ENGINE_MODE")
        .env_remove("FAKE_ENGINE_LATER_MODE")
        .env_remove("FAKE_ENGINE_STATUS")
        .env_remove("FAKE_ENGINE_LOCK_HELPER")
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let s = Supervisor {
        child,
        home: h.home.clone(),
    };
    wait_until("run/supervisor.token", || {
        h.home.join("run/supervisor.token").exists()
    });
    s
}

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn client(home: &Path) -> Client {
    let address = owned_children::address(home, "supervisor");
    let opts = ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None,
    };
    let deadline = Instant::now() + WAIT;
    loop {
        let token = std::fs::read_to_string(home.join("run/supervisor.token")).unwrap_or_default();
        match Client::connect(&address, token.trim(), opts.clone()) {
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

/// `daemon.status`, validated against the schema. Ruling 2 (B1): whenever there are children at all, the core is
/// the first of them, from the supervisor's first answer on (the engine is started before it).
fn status(c: &mut Client) -> Value {
    let st = c.call("daemon.status", json!({})).unwrap();
    let errors: Vec<String> = validator()
        .iter_errors(&st)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?} in {st}");
    if let Some(first) = st["children"].get(0) {
        assert_eq!(
            first["kind"], "core",
            "the core is always listed first: {st}"
        );
    }
    st
}

fn core_events(h: &Home, name: &str) -> Vec<Value> {
    Home::lines(&h.core_events)
        .into_iter()
        .filter(|e| e["event"] == name)
        .collect()
}

fn kill_pid(pid: u64) {
    #[cfg(unix)]
    assert!(Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .unwrap()
        .success());
    #[cfg(windows)]
    assert!(Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status()
        .unwrap()
        .success());
}

/// The argv of this test binary's [`engine_lock_holder_helper`]: a process that takes `run/engine.process.lock` with
/// the OS lock the supervisor tests (`File::lock`, like `backup/writer_guard.rs`) and holds it until its stdin closes.
fn lock_helper_argv() -> Vec<String> {
    vec![
        std::env::current_exe().unwrap().display().to_string(),
        "engine_lock_holder_helper".into(),
        "--exact".into(),
        "--ignored".into(),
        "--nocapture".into(),
        "--test-threads=1".into(),
    ]
}

/// A lock holder the test owns directly (not an engine): killed when dropped.
struct LockHolder(Child);
impl LockHolder {
    fn start(path: &Path) -> Self {
        use std::io::BufRead;
        let argv = lock_helper_argv();
        let mut child = Command::new(&argv[0])
            .args(&argv[1..])
            .env("ENGINE_LOCK_HOLDER_PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
        assert!(
            lines.any(|l| l.is_ok_and(|l| l.contains("engine-lock-held"))),
            "the lock helper did not take the lock"
        );
        Self(child)
    }
}
impl Drop for LockHolder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Helper process for the B3 tests (run by [`lock_helper_argv`], a no-op otherwise): holds the OS lock on
/// `ENGINE_LOCK_HOLDER_PATH` until its stdin closes.
#[test]
#[ignore = "helper process for the engine lock tests; does nothing without ENGINE_LOCK_HOLDER_PATH"]
fn engine_lock_holder_helper() {
    use std::io::{Read, Write};
    let Some(path) = std::env::var_os("ENGINE_LOCK_HOLDER_PATH") else {
        return;
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .unwrap();
    file.lock().unwrap();
    let mut out = std::io::stdout();
    writeln!(out, "engine-lock-held").unwrap();
    out.flush().unwrap();
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    drop(file);
}

fn child<'a>(st: &'a Value, role: &str) -> Option<&'a Value> {
    st["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["role"] == role)
}

fn state(child: Option<&Value>) -> &str {
    child
        .and_then(|c| c["process"]["state"].as_str())
        .unwrap_or("")
}

fn roles(st: &Value) -> Vec<String> {
    st["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["role"].as_str().unwrap().to_owned())
        .collect()
}

fn wait_status(c: &mut Client, what: &str, f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let st = status(c);
        if f(&st) {
            return st;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}; last: {st}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn both_ready(st: &Value) -> bool {
    state(child(st, "core")) == "ready" && state(child(st, "engine")) == "ready"
}

fn stop(sup: &mut Supervisor, c: &mut Client) {
    c.call("daemon.stop", json!({ "budgetMs": 2000 })).unwrap();
    assert!(sup.wait_exit(WAIT).success());
}

#[test]
fn daemon_start_starts_engine_then_core_and_status_lists_both() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let children = st["children"].as_array().unwrap();
    assert_eq!(children[0]["role"], "core", "{st}");
    assert_eq!(children[0]["kind"], "core", "{st}");
    assert_eq!(children[1]["role"], "engine", "{st}");
    assert_eq!(children[1]["kind"], "engine", "{st}");
    assert_eq!(children[1]["adopted"], false, "{st}");
    assert_eq!(children[1]["restarts"], 0, "{st}");
    // One engine, spawned with the stdin lifeline and the instance the supervisor reports.
    let started = h.engine_events("started");
    assert_eq!(started.len(), 1, "{started:?}");
    assert_eq!(started[0]["pid"], children[1]["pid"], "{started:?}");
    assert_eq!(started[0]["instanceId"], children[1]["instanceId"]);
    assert_eq!(started[0]["lifeline"], "stdin");
    assert_eq!(started[0]["testInternals"], Value::Null);
    // Engine before core.
    let engine = h.log_position("engine spawned").expect("engine spawned");
    let core = h.log_position("core spawned").expect("core spawned");
    assert!(engine < core, "{:?}", h.log_records());
    // Its output goes to its own out log.
    let out = std::fs::read_to_string(h.home.join("logs/engine.out.log")).unwrap_or_default();
    assert!(out.contains("fake-engine stderr marker"), "{out}");
    stop(&mut sup, &mut c);
}

#[test]
fn an_engine_crash_is_restarted_with_backoff_and_the_core_survives() {
    let h = Home::new(Some("rust"));
    let mut sup = start(
        &h,
        &[
            ("FAKE_ENGINE_MODE", "crash-after:300"),
            ("FAKE_ENGINE_LATER_MODE", "ok"),
        ],
    );
    let mut c = client(&h.home);
    let first = wait_status(&mut c, "core ready", |st| {
        state(child(st, "core")) == "ready"
    });
    let core = child(&first, "core").unwrap().clone();
    let st = wait_status(&mut c, "engine restarted and ready", |st| {
        let engine = child(st, "engine");
        state(engine) == "ready" && engine.unwrap()["restarts"].as_u64().unwrap_or(0) >= 1
    });
    let engine = child(&st, "engine").unwrap();
    assert_eq!(engine["lastExit"]["code"], 1, "{st}");
    // The restart waited for its backoff, scheduled at the exit.
    let exited = h
        .log_records()
        .into_iter()
        .find(|r| r["msg"] == "engine exited")
        .expect("engine exited logged");
    assert_eq!(exited["code"], 1, "{exited}");
    assert!(exited["nextRestartAt"].is_u64(), "{exited}");
    assert_eq!(h.engine_events("started").len(), 2);
    // The core never noticed.
    let now = child(&st, "core").unwrap();
    assert_eq!(now["pid"], core["pid"], "{st}");
    assert_eq!(now["restarts"], 0, "{st}");
    assert_eq!(now["process"]["state"], "ready", "{st}");
    stop(&mut sup, &mut c);
}

/// B4 (variant c): an engine exit 3 (another owner, a stamp still inside its age rule) is retried like the core's
/// `lock-held`, probing first, and does not count toward the give-up.
#[test]
fn engine_exit_3_is_retried_with_backoff() {
    let h = Home::new(Some("rust"));
    let mut sup = start(
        &h,
        &[
            ("FAKE_ENGINE_MODE", "exit:3"),
            ("FAKE_ENGINE_LATER_MODE", "ok"),
        ],
    );
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "the engine ready after its exit 3", |st| {
        state(child(st, "engine")) == "ready" && state(child(st, "core")) == "ready"
    });
    let engine = child(&st, "engine").unwrap();
    assert_eq!(engine["lastExit"]["code"], 3, "{st}");
    assert_eq!(engine["lastExit"]["reason"], "lock-held", "{st}");
    assert!(engine["restarts"].as_u64().unwrap() >= 1, "{st}");
    let exited = h
        .log_records()
        .into_iter()
        .find(|r| r["msg"] == "engine exited")
        .unwrap();
    assert!(exited["nextRestartAt"].is_u64(), "{exited}");
    stop(&mut sup, &mut c);
}

/// B4: an exit 3 that persists past the stamp ceiling (660 s × scale) turns fatal `lock-held`; only then is nothing
/// scheduled any more.
#[test]
fn a_persistent_engine_exit_3_turns_fatal_after_the_stamp_ceiling() {
    let h = Home::new(Some("rust"));
    // 660 s × 0.005 = 3.3 s of retries (the backoff caps at 60 s × 0.005 = 0.3 s).
    let mut sup = start(
        &h,
        &[
            ("FAKE_ENGINE_MODE", "exit:3"),
            ("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.005"),
        ],
    );
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "the engine fatal after the ceiling", |st| {
        let engine = child(st, "engine");
        state(engine) == "crashed" && engine.unwrap()["nextRestartAt"].is_null()
    });
    let engine = child(&st, "engine").unwrap();
    assert_eq!(engine["process"]["reason"], "lock-held", "{st}");
    assert_eq!(engine["lastExit"]["code"], 3, "{st}");
    // Retried more than the five exits that would have given up any other crash.
    assert!(h.engine_events("started").len() > 5, "{st}");
    let first = h.engine_events("started")[0]["at"].as_u64().unwrap();
    let last = h.engine_events("exiting").last().unwrap()["at"]
        .as_u64()
        .unwrap();
    assert!(
        last - first >= 3_300,
        "fatal only after the ceiling: {}",
        last - first
    );
    stop(&mut sup, &mut c);
}

/// B4: an engine crashed for good (here an exit 2, `config-invalid`) gets one new try at the next core restart, so a
/// corrected configuration brings it back without `daemon start`.
#[test]
fn a_fatal_engine_gets_a_new_try_at_the_next_core_restart() {
    let h = Home::new(Some("rust"));
    let mut sup = start(
        &h,
        &[
            ("FAKE_ENGINE_MODE", "exit:2"),
            ("FAKE_ENGINE_LATER_MODE", "ok"),
        ],
    );
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "a fatal engine beside a ready core", |st| {
        state(child(st, "engine")) == "crashed" && state(child(st, "core")) == "ready"
    });
    assert_eq!(
        child(&st, "engine").unwrap()["process"]["reason"],
        "config-invalid"
    );
    assert_eq!(child(&st, "engine").unwrap()["nextRestartAt"], Value::Null);
    kill_pid(child(&st, "core").unwrap()["pid"].as_u64().unwrap());
    let st = wait_status(&mut c, "the engine back after the core restart", both_ready);
    assert!(
        child(&st, "core").unwrap()["restarts"].as_u64().unwrap() >= 1,
        "{st}"
    );
    assert_eq!(h.engine_events("started").len(), 2);
    stop(&mut sup, &mut c);
}

/// B2: an engine found hung (or foreign) at the supervisor's start is handled after the core started: the core's start
/// never waits for the engine's probe or its termination.
#[test]
fn a_hung_or_foreign_engine_found_at_start_does_not_delay_the_core() {
    for case in ["hung", "foreign"] {
        let h = Home::new(Some("rust"));
        let env = [("FAKE_ENGINE_GRACE_MS", "60000")];
        let mut first = start(&h, &env);
        let mut c = client(&h.home);
        let st = wait_status(&mut c, "core and engine ready", both_ready);
        let old = child(&st, "engine").unwrap()["pid"].as_u64().unwrap();
        first.child.kill().unwrap();
        first.child.wait().unwrap();
        drop(c);
        wait_until("the old core gone", || {
            !core_events(&h, "exiting").is_empty()
        });
        if case == "hung" {
            std::fs::write(h.home.join("state/fake-engine-hang"), "").unwrap();
        } else {
            // The pid file now names another incarnation: the engine answers, but as a stranger.
            std::fs::write(
                h.home.join("run/engine.pid"),
                format!("{old} 00000000-0000-4000-8000-00000000beef\n"),
            )
            .unwrap();
        }
        // Scale 1: the probe alone may take 2.5 s and the termination at least 2 s more.
        let t0 = Instant::now();
        let mut second = start(&h, &[env[0], ("PLUR1BUS_SUPERVISOR_TIME_SCALE", "1")]);
        let mut c = client(&h.home);
        wait_status(&mut c, "core ready", |st| {
            state(child(st, "core")) == "ready"
        });
        let elapsed = t0.elapsed();
        assert!(
            elapsed < Duration::from_millis(2_500),
            "{case}: the core waited {elapsed:?} for the engine"
        );
        let core = h.log_position("core spawned").unwrap();
        wait_until("the engine probe", || {
            h.log_position("engine probe").is_some()
        });
        assert!(
            core < h.log_position("engine probe").unwrap(),
            "{case}: {:?}",
            h.log_records()
        );
        // The scheduler then ends the old engine and starts another.
        let _ = std::fs::remove_file(h.home.join("state/fake-engine-hang"));
        wait_until("the old engine gone", || {
            plur1bus_rpc::process::alive(old as u32) == plur1bus_rpc::process::Liveness::Gone
        });
        drop(first);
        stop(&mut second, &mut c);
    }
}

/// B3: an engine left running by a killed supervisor, with the selection switched to `node` offline, is ended before
/// the Node core starts: two writers never share the stores.
#[test]
fn an_engine_left_running_is_stopped_before_a_node_core_starts() {
    let h = Home::new(Some("rust"));
    let helper = serde_json::to_string(&lock_helper_argv()).unwrap();
    let env = [
        ("FAKE_ENGINE_GRACE_MS", "60000"),
        ("FAKE_ENGINE_LOCK_HELPER", helper.as_str()),
    ];
    let mut first = start(&h, &env);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let old = child(&st, "engine").unwrap()["pid"].as_u64().unwrap();
    assert_eq!(h.engine_events("os-lock").len(), 1);
    first.child.kill().unwrap();
    first.child.wait().unwrap();
    drop(c);
    wait_until("the old core gone", || {
        !core_events(&h, "exiting").is_empty()
    });
    h.write_config(json!({ "schemaVersion": 1, "engine": { "implementation": "node" } }));
    let mut second = start(&h, &env);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "a node core ready", |st| {
        state(child(st, "core")) == "ready"
    });
    assert!(child(&st, "engine").is_none(), "{st}");
    let gone = h
        .engine_events("exiting")
        .into_iter()
        .find(|e| e["pid"] == old)
        .expect("the old engine ended");
    let core_started = core_events(&h, "started").last().unwrap()["at"]
        .as_u64()
        .unwrap();
    assert!(
        gone["at"].as_u64().unwrap() <= core_started,
        "{gone} vs {core_started}"
    );
    assert_eq!(
        h.engine_events("shutdown").len(),
        1,
        "stopped through engine.shutdown"
    );
    drop(first);
    stop(&mut second, &mut c);
}

/// B3: a holder of `run/engine.process.lock` that cannot be stopped keeps the Node core off (fail closed), for at
/// most the orphan grace plus 5 s, with its own reason.
#[test]
fn an_engine_lock_that_stays_held_keeps_the_node_core_off() {
    let h = Home::new(None);
    h.write_config(json!({ "schemaVersion": 1, "supervisor": { "graceMs": 10000 } }));
    std::fs::create_dir_all(h.home.join("run")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(h.home.join("run"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
    }
    let _holder = LockHolder::start(&h.home.join("run/engine.process.lock"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "the core held off", |st| {
        state(child(st, "core")) == "crashed"
    });
    let core = child(&st, "core").unwrap();
    assert_eq!(core["process"]["reason"], "engine-lock-held", "{st}");
    assert_eq!(core["nextRestartAt"], Value::Null, "{st}");
    assert!(core_events(&h, "started").is_empty(), "no core ran");
    let checks = firstaid(&h.home);
    let row = checks.iter().find(|r| r["id"] == "core.state").unwrap();
    assert!(
        row["summary"]
            .as_str()
            .unwrap()
            .contains("engine-lock-held"),
        "{row:#}"
    );
    stop(&mut sup, &mut c);
}

/// B3: without a held engine lock (no file, or a free one) the Node core starts exactly as before.
#[test]
fn without_a_held_engine_lock_the_node_core_starts_at_once() {
    for lock_file in [false, true] {
        let h = Home::new(None);
        if lock_file {
            std::fs::create_dir_all(h.home.join("run")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    h.home.join("run"),
                    std::fs::Permissions::from_mode(0o700),
                )
                .unwrap();
            }
            std::fs::write(h.home.join("run/engine.process.lock"), "").unwrap();
        }
        let mut sup = start(&h, &[]);
        let mut c = client(&h.home);
        wait_status(&mut c, "core ready", |st| {
            state(child(st, "core")) == "ready"
        });
        assert!(
            !h.log_records()
                .iter()
                .any(|r| r["msg"].as_str().is_some_and(|m| m.contains("engine lock"))),
            "{:?}",
            h.log_records()
        );
        stop(&mut sup, &mut c);
    }
}

/// B6: a requested core restart (a core-class configuration change) also restarts the engine, which reads config.json
/// only at its start: core stopped, engine stopped, engine started, core started.
#[test]
fn a_requested_core_restart_restarts_the_engine_too() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let (core, engine) = (
        child(&st, "core").unwrap()["pid"].clone(),
        child(&st, "engine").unwrap()["pid"].clone(),
    );
    let r = c
        .call(
            "config.set",
            json!({ "changes": [{ "key": "core.recall.capChars", "value": 20000 }] }),
        )
        .unwrap();
    assert_eq!(r["restart"]["core"], true, "{r}");
    wait_status(&mut c, "a new core and a new engine", |st| {
        both_ready(st)
            && child(st, "core").unwrap()["pid"] != core
            && child(st, "engine").unwrap()["pid"] != engine
    });
    let records = h.log_records();
    let at = |msg: &str, nth: usize| {
        records
            .iter()
            .enumerate()
            .filter(|(_, r)| r["msg"] == msg)
            .nth(nth)
            .unwrap_or_else(|| panic!("{msg} #{nth}: {records:?}"))
            .0
    };
    assert!(
        at("stopping core", 0) < at("stopping engine", 0),
        "{records:?}"
    );
    assert!(
        at("stopping engine", 0) < at("engine spawned", 1),
        "{records:?}"
    );
    assert!(
        at("engine spawned", 1) < at("core spawned", 1),
        "{records:?}"
    );
    stop(&mut sup, &mut c);
}

/// B6: a core crash restarts only the core; the engine keeps running.
#[test]
fn a_core_crash_leaves_the_engine_running() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let (core, engine) = (
        child(&st, "core").unwrap()["pid"].clone(),
        child(&st, "engine").unwrap()["pid"].clone(),
    );
    kill_pid(core.as_u64().unwrap());
    let st = wait_status(&mut c, "the core restarted", |st| {
        state(child(st, "core")) == "ready" && child(st, "core").unwrap()["pid"] != core
    });
    assert_eq!(child(&st, "engine").unwrap()["pid"], engine, "{st}");
    assert_eq!(child(&st, "engine").unwrap()["restarts"], 0, "{st}");
    assert_eq!(h.engine_events("started").len(), 1);
    stop(&mut sup, &mut c);
}

#[test]
fn a_running_engine_is_adopted_after_a_supervisor_restart() {
    let h = Home::new(Some("rust"));
    let env = [
        ("FAKE_ENGINE_GRACE_MS", "30000"),
        ("FAKE_CORE_GRACE_MS", "30000"),
    ];
    let mut first = start(&h, &env);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let original = child(&st, "engine").unwrap()["pid"].clone();
    first.child.kill().unwrap();
    first.child.wait().unwrap();
    drop(c);
    let mut replacement = start(&h, &env);
    let mut c = client(&h.home);
    let st = wait_status(
        &mut c,
        "the same engine adopted beside a ready core",
        |st| {
            state(child(st, "core")) == "ready"
                && child(st, "engine").is_some_and(|e| {
                    e["pid"] == original && e["adopted"] == true && e["process"]["state"] == "ready"
                })
        },
    );
    assert_eq!(roles(&st)[..2], ["core", "engine"], "{st}");
    assert_eq!(h.engine_events("started").len(), 1);
    assert_eq!(h.engine_events("adopted").len(), 1);
    // The old guard must leave the adopted engine to its new supervisor.
    drop(first);
    stop(&mut replacement, &mut c);
    assert_eq!(h.engine_events("shutdown").len(), 1);
}

#[cfg(target_os = "linux")]
#[test]
fn an_adopted_engine_is_bound_to_the_max_cores_set() {
    fn allowed(status: &str) -> Vec<usize> {
        let list = status
            .lines()
            .find_map(|l| l.strip_prefix("Cpus_allowed_list:"))
            .unwrap()
            .trim();
        list.split(',')
            .flat_map(|r| match r.split_once('-') {
                Some((a, b)) => (a.parse().unwrap()..=b.parse().unwrap()).collect::<Vec<usize>>(),
                None => vec![r.parse().unwrap()],
            })
            .collect()
    }
    fn threads(pid: u64) -> Vec<Vec<usize>> {
        std::fs::read_dir(format!("/proc/{pid}/task"))
            .unwrap()
            .flatten()
            .filter_map(|t| std::fs::read_to_string(t.path().join("status")).ok())
            .map(|s| allowed(&s))
            .collect()
    }
    let start_cpus = allowed(&std::fs::read_to_string("/proc/self/status").unwrap());
    if start_cpus.len() < 2 {
        eprintln!("skipped: this host offers one CPU");
        return;
    }
    let h = Home::new(Some("rust"));
    let env = [
        ("FAKE_ENGINE_GRACE_MS", "30000"),
        ("FAKE_CORE_GRACE_MS", "30000"),
    ];
    let mut first = start(&h, &env);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let pid = child(&st, "engine").unwrap()["pid"].as_u64().unwrap();
    assert!(threads(pid).iter().all(|cpus| *cpus == start_cpus));
    first.child.kill().unwrap();
    first.child.wait().unwrap();
    drop(c);
    // The replacement starts with a limit the adopted engine (no descendant of it) must be bound to.
    h.write_config(json!({
        "schemaVersion": 1,
        "engine": { "implementation": "rust" },
        "supervisor": { "maxCores": 1 }
    }));
    let mut replacement = start(&h, &env);
    let mut c = client(&h.home);
    wait_status(&mut c, "the same engine adopted", |st| {
        child(st, "engine").is_some_and(|e| e["pid"] == pid && e["adopted"] == true)
    });
    let first_cpu = vec![start_cpus[0]];
    wait_until("the adopted engine bound to the first cpu", || {
        threads(pid).iter().all(|cpus| *cpus == first_cpu)
    });
    drop(first);
    stop(&mut replacement, &mut c);
}

/// `plur1bus --json 1staid check` until a pass reaches every row (a loaded machine can exhaust its 3 s budget).
fn firstaid(home: &Path) -> Vec<Value> {
    let deadline = Instant::now() + WAIT;
    loop {
        let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
            .arg("--json")
            .arg("--home")
            .arg(home)
            .args(["1staid", "check"])
            .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
            .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let doc: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)));
        let checks = doc["checks"].as_array().cloned().unwrap_or_default();
        if !checks
            .iter()
            .any(|c| c["summary"] == "time budget exhausted")
        {
            return checks;
        }
        assert!(Instant::now() < deadline, "no complete pass: {doc}");
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn engine_rows(checks: &[Value]) -> Vec<(String, String)> {
    assert_eq!(checks.len(), 39, "{checks:?}");
    checks[36..]
        .iter()
        .map(|c| {
            (
                c["id"].as_str().unwrap().to_owned(),
                c["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn one_staid_check_reports_engine_process_store_and_runtime() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let pid = child(&st, "engine").unwrap()["pid"].clone();
    let checks = firstaid(&h.home);
    assert_eq!(
        engine_rows(&checks),
        [
            ("engine.process".to_owned(), "ok".to_owned()),
            ("engine.store".to_owned(), "ok".to_owned()),
            ("engine.runtime".to_owned(), "ok".to_owned()),
        ],
        "{checks:#?}"
    );
    assert_eq!(checks[36]["detail"]["pid"], pid, "{:#}", checks[36]);
    assert_eq!(
        checks[37]["detail"]["storeSchema"]["current"], "1",
        "{:#}",
        checks[37]
    );
    assert_eq!(
        checks[38]["detail"]["embedder"], "ready",
        "{:#}",
        checks[38]
    );
    stop(&mut sup, &mut c);

    // Selected but not running: the process row fails once, the other two cannot be checked.
    let checks = firstaid(&h.home);
    let rows = engine_rows(&checks);
    assert_eq!(
        rows[0],
        ("engine.process".to_owned(), "fail".to_owned()),
        "{checks:#?}"
    );
    assert_eq!(rows[1].1, "skip", "{checks:#?}");
    assert_eq!(rows[2].1, "skip", "{checks:#?}");
    assert!(
        checks[37]["summary"]
            .as_str()
            .unwrap()
            .contains("not checkable"),
        "{:#}",
        checks[37]
    );

    // The Node engine: all three rows skip.
    let node = Home::new(None);
    let checks = firstaid(&node.home);
    assert_eq!(
        engine_rows(&checks)
            .iter()
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>(),
        ["skip", "skip", "skip"],
        "{checks:#?}"
    );
}

#[test]
fn the_default_node_engine_has_no_engine_slot() {
    for config in [None, Some("node")] {
        let h = Home::new(config);
        let mut sup = start(&h, &[]);
        let mut c = client(&h.home);
        let st = wait_status(&mut c, "core ready", |st| {
            state(child(st, "core")) == "ready"
        });
        assert_eq!(roles(&st), ["core", "tools", "api"], "{st}");
        let keys: Vec<Vec<String>> = st["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_object().unwrap().keys().cloned().collect())
            .collect();
        for k in &keys {
            assert_eq!(
                k,
                &[
                    "adopted",
                    "instanceId",
                    "kind",
                    "lastExit",
                    "nextRestartAt",
                    "pid",
                    "process",
                    "restarts",
                    "role"
                ],
                "{st}"
            );
        }
        stop(&mut sup, &mut c);
        assert!(h.engine_events("started").is_empty());
        assert!(!h.home.join("logs/engine.out.log").exists());
        assert!(h.log_position("engine spawned").is_none());
    }
}

#[test]
fn switching_engine_implementation_adds_and_removes_the_slot_on_core_restart() {
    let h = Home::new(Some("node"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core ready", |st| {
        state(child(st, "core")) == "ready"
    });
    assert!(child(&st, "engine").is_none(), "{st}");
    let core = child(&st, "core").unwrap()["pid"].clone();
    let r = c
        .call(
            "config.set",
            json!({ "changes": [{ "key": "engine.implementation", "value": "rust" }] }),
        )
        .unwrap();
    assert_eq!(r["restart"]["core"], true, "{r}");
    let st = wait_status(&mut c, "a restarted core beside a ready engine", |st| {
        both_ready(st) && child(st, "core").unwrap()["pid"] != core
    });
    assert_eq!(roles(&st)[..2], ["core", "engine"], "{st}");
    let engine = h.log_position("engine spawned").unwrap();
    let records = h.log_records();
    let respawned = records
        .iter()
        .enumerate()
        .rev()
        .find(|(_, r)| r["msg"] == "core spawned")
        .unwrap()
        .0;
    assert!(
        engine < respawned,
        "the engine starts before the restarted core: {records:?}"
    );

    let core = child(&st, "core").unwrap()["pid"].clone();
    c.call(
        "config.set",
        json!({ "changes": [{ "key": "engine.implementation", "value": "node" }] }),
    )
    .unwrap();
    let st = wait_status(&mut c, "the slot removed and the core restarted", |st| {
        child(st, "engine").is_none()
            && state(child(st, "core")) == "ready"
            && child(st, "core").unwrap()["pid"] != core
    });
    assert_eq!(roles(&st), ["core", "tools", "api"], "{st}");
    assert_eq!(
        h.engine_events("shutdown").len(),
        1,
        "the engine was stopped, not killed"
    );
    stop(&mut sup, &mut c);
}

#[test]
fn a_hanging_engine_does_not_delay_core_readiness() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[("FAKE_ENGINE_MODE", "hang")]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core ready", |st| {
        state(child(st, "core")) == "ready"
    });
    // The engine never answers its handshake; the core is ready while the engine is still starting, long before the
    // engine's ready timeout (10 s at least) could have ended it.
    let engine = child(&st, "engine").expect("engine slot");
    assert_eq!(engine["process"]["state"], "starting", "{st}");
    assert_eq!(engine["restarts"], 0, "{st}");
    let ready = h
        .log_records()
        .into_iter()
        .find(|r| r["msg"] == "core ready")
        .unwrap();
    assert!(ready["readyMs"].as_u64().unwrap() < 10_000, "{ready}");
    // B9: the stop stays inside one budget plus one grace although the engine never answers engine.shutdown: budget
    // 2 s + grace 5 s × 0.1, plus at most the reaping after a kill (1 s) and the process exit.
    let t0 = Instant::now();
    stop(&mut sup, &mut c);
    assert!(
        t0.elapsed() < Duration::from_millis(2_000 + 500 + 1_000 + 500),
        "{:?}",
        t0.elapsed()
    );
}

#[test]
fn daemon_stop_stops_the_core_before_the_engine() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    wait_status(&mut c, "core and engine ready", both_ready);
    stop(&mut sup, &mut c);
    let at = |msg: &str| {
        h.log_position(msg)
            .unwrap_or_else(|| panic!("{msg} not logged: {:?}", h.log_records()))
    };
    assert!(at("stopping core") < at("core exited"));
    assert!(at("core exited") < at("stopping engine"));
    assert!(at("stopping engine") < at("engine exited"));
    assert_eq!(h.engine_events("shutdown").len(), 1);
}

/// The fake engine's pipe has Node's default DACL, so this proves only that `windows.pipe-acl` reads the engine pipe
/// when the Rust engine is selected. The real engine's user-and-SYSTEM DACL is tested in the engine crate
/// (`crates/plur1bus-engine`, its Windows transport tests on Windows CI).
#[cfg(windows)]
#[test]
fn windows_pipe_acl_check_reads_the_engine_pipe() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[]);
    let mut c = client(&h.home);
    wait_status(&mut c, "core and engine ready", both_ready);
    let checks = firstaid(&h.home);
    let acl = checks
        .iter()
        .find(|c| c["id"] == "windows.pipe-acl")
        .unwrap();
    assert_eq!(acl["status"], "ok", "{acl:#}");
    let pipes: Vec<&str> = acl["detail"]["checked"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert!(pipes.contains(&"engine"), "{acl:#}");
    // The supervisor's own run-file check covered the engine's token and pid file too, and found nothing.
    assert!(
        !h.log_records().iter().any(|r| r["child"] == "engine"
            && r["msg"].as_str().is_some_and(|m| m.starts_with("run file"))),
        "{:?}",
        h.log_records()
    );
    stop(&mut sup, &mut c);
}

/// The real `plur1bus-engine` with the flat embedder (`PLUR1BUS_ENGINE_BIN` must name a built binary): start,
/// status, stop.
#[test]
#[ignore = "needs a built plur1bus-engine in PLUR1BUS_ENGINE_BIN"]
fn the_real_engine_runs_in_the_slot_with_the_flat_embedder() {
    let bin = std::env::var_os("PLUR1BUS_ENGINE_BIN").expect("PLUR1BUS_ENGINE_BIN");
    let h = Home::new(Some("rust"));
    let bin = bin.to_str().unwrap().to_owned();
    let mut sup = start(
        &h,
        &[
            ("PLUR1BUS_ENGINE_BIN", &bin),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
        ],
    );
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let engine = child(&st, "engine").unwrap();
    assert_eq!(engine["kind"], "engine", "{st}");
    let pid = engine["pid"].as_u64().unwrap();
    let recorded = std::fs::read_to_string(h.home.join("run/engine.pid")).unwrap();
    assert_eq!(
        recorded.split_whitespace().next(),
        Some(pid.to_string().as_str())
    );
    stop(&mut sup, &mut c);
    assert!(!h.home.join("run/engine.pid").exists());
}

fn real_engine_env(bin: &str) -> [(&str, &str); 2] {
    [
        ("PLUR1BUS_ENGINE_BIN", bin),
        ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
    ]
}

/// B5 (a): the real engine killed with SIGKILL is restarted by the supervisor; the successor takes over the dead
/// process's stamp on the same host at once (no exit 3) and is ready again.
#[cfg(unix)]
#[test]
#[ignore = "needs a built plur1bus-engine in PLUR1BUS_ENGINE_BIN"]
fn the_real_engine_is_restarted_after_sigkill() {
    let bin = std::env::var("PLUR1BUS_ENGINE_BIN").expect("PLUR1BUS_ENGINE_BIN");
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &real_engine_env(&bin));
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let pid = child(&st, "engine").unwrap()["pid"].clone();
    kill_pid(pid.as_u64().unwrap());
    let st = wait_status(&mut c, "a new engine ready", |st| {
        child(st, "engine").is_some_and(|e| e["pid"] != pid && e["process"]["state"] == "ready")
    });
    let engine = child(&st, "engine").unwrap();
    assert!(engine["restarts"].as_u64().unwrap() >= 1, "{st}");
    assert_eq!(engine["lastExit"]["signal"], "SIGKILL", "{st}");
    assert!(
        !h.log_records()
            .iter()
            .any(|r| r["msg"] == "engine exited" && r["code"] == 3),
        "the successor took the stamp over without exit 3: {:?}",
        h.log_records()
    );
    stop(&mut sup, &mut c);
}

/// B5 (b): a supervisor restart adopts the running real engine through `engine.adopt` (the supervisor token as nonce);
/// no second engine process is started.
#[test]
#[ignore = "needs a built plur1bus-engine in PLUR1BUS_ENGINE_BIN"]
fn the_real_engine_is_adopted_after_a_supervisor_restart() {
    let bin = std::env::var("PLUR1BUS_ENGINE_BIN").expect("PLUR1BUS_ENGINE_BIN");
    let h = Home::new(Some("rust"));
    let env = real_engine_env(&bin);
    let env = [env[0], env[1], ("FAKE_CORE_GRACE_MS", "30000")];
    let mut first = start(&h, &env);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "core and engine ready", both_ready);
    let pid = child(&st, "engine").unwrap()["pid"].clone();
    first.child.kill().unwrap();
    first.child.wait().unwrap();
    drop(c);
    let mut second = start(&h, &env);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "the same engine adopted", |st| {
        state(child(st, "core")) == "ready"
            && child(st, "engine").is_some_and(|e| {
                e["pid"] == pid && e["adopted"] == true && e["process"]["state"] == "ready"
            })
    });
    assert_eq!(child(&st, "engine").unwrap()["restarts"], 0, "{st}");
    assert_eq!(
        h.log_records()
            .iter()
            .filter(|r| r["msg"] == "engine spawned")
            .count(),
        1,
        "no second engine process"
    );
    let recorded = std::fs::read_to_string(h.home.join("run/engine.pid")).unwrap();
    assert_eq!(
        recorded.split_whitespace().next(),
        Some(pid.to_string().as_str())
    );
    drop(first);
    stop(&mut second, &mut c);
}
