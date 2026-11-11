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

/// `daemon.status`, validated against the schema.
fn status(c: &mut Client) -> Value {
    let st = c.call("daemon.status", json!({})).unwrap();
    let errors: Vec<String> = validator()
        .iter_errors(&st)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?} in {st}");
    st
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

#[test]
fn engine_exit_3_is_fatal_and_not_restarted() {
    let h = Home::new(Some("rust"));
    let mut sup = start(&h, &[("FAKE_ENGINE_MODE", "exit:3")]);
    let mut c = client(&h.home);
    let st = wait_status(&mut c, "engine crashed and core ready", |st| {
        state(child(st, "engine")) == "crashed" && state(child(st, "core")) == "ready"
    });
    let engine = child(&st, "engine").unwrap();
    assert_eq!(engine["lastExit"]["code"], 3, "{st}");
    assert_eq!(engine["process"]["reason"], "lock-held", "{st}");
    assert_eq!(
        engine["nextRestartAt"],
        Value::Null,
        "no restart is scheduled: {st}"
    );
    assert_eq!(engine["restarts"], 0, "{st}");
    assert_eq!(h.engine_events("started").len(), 1);
    // Only `daemon start` tries again.
    c.call("daemon.start", json!({})).unwrap();
    wait_until("a second engine start", || {
        h.engine_events("started").len() == 2
    });
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
    // The stop is bounded by its deadline although the engine never answers engine.shutdown.
    let t0 = Instant::now();
    stop(&mut sup, &mut c);
    assert!(t0.elapsed() < Duration::from_secs(20), "{:?}", t0.elapsed());
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
