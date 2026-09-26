//! `plur1bus 1staid check` (spec §6.6, S12): read-only diagnostics. The supervisor/core stack is
//! `tests/fixtures/fake-core.mjs`, reached through `PLUR1BUS_CORE_JS`/`PLUR1BUS_NODE`, mirroring `tests/daemon.rs`.
//! The one test that needs `core.status.deprecationsUsed` (a real field the fake core does not implement) starts
//! the actual built core instead (`plur1bus core run --test-internals flat-embedder`).
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime};

const WAIT: Duration = Duration::from_secs(15);

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs")
}

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

/// The real core's built entry point (`packages/core/dist/core.js`), required for the deprecations test.
fn core_js() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/dist/core.js")
        .canonicalize()
        .expect("packages/core/dist/core.js (run `pnpm --filter @plur1bus/core build` first)")
}

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
}

fn supervise_cmd(h: &Home, mode: &str) -> Command {
    let mut c = Command::new(bin());
    c.arg("--home")
        .arg(&h.home)
        .arg("supervise")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.02")
        .env("PLUR1BUS_CORE_JS", fixture())
        .env("PLUR1BUS_NODE", "node")
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env("FAKE_CORE_MODE", mode)
        .env("FAKE_CORE_EVENTS", &h.events)
        .env("FAKE_CORE_GRACE_MS", "300")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    c
}

fn check_cmd(h: &Home) -> Command {
    let mut c = Command::new(bin());
    c.arg("--json")
        .arg("--home")
        .arg(&h.home)
        .args(["1staid", "check"])
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

fn checks_by_id(v: &Value) -> BTreeMap<String, Value> {
    v["checks"]
        .as_array()
        .unwrap_or_else(|| panic!("no checks array: {v}"))
        .iter()
        .map(|c| (c["id"].as_str().unwrap().to_string(), c.clone()))
        .collect()
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

fn opts(endpoint: Endpoint) -> ConnectOptions {
    ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint,
        expected_server_pid: None,
    }
}

fn supervisor_client(home: &Path) -> Client {
    let deadline = Instant::now() + WAIT;
    loop {
        let token = std::fs::read_to_string(home.join("run/supervisor.token")).unwrap_or_default();
        match Client::connect(
            &supervisor_address(home),
            token.trim(),
            opts(Endpoint::Supervisor),
        ) {
            Ok(c) => return c,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("cannot connect to the supervisor: {e}"),
        }
    }
}

fn wait_until(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn stop_supervisor(home: &Path) {
    if !home.join("run/supervisor.token").exists() {
        return;
    }
    let mut c = supervisor_client(home);
    let _ = c.call("daemon.stop", json!({ "budgetMs": 500 }));
    wait_until("supervisor to stop", WAIT, || {
        !home.join("run/supervisor.pid").exists()
    });
}

/// A recursive listing of `dir`'s contents, path -> (len, mtime), used to prove `1staid check` never touches the
/// home directory.
fn snapshot(dir: &Path) -> BTreeMap<PathBuf, (u64, SystemTime)> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<PathBuf, (u64, SystemTime)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let rel = path.strip_prefix(root).unwrap().to_path_buf();
            out.insert(
                rel,
                (
                    meta.len(),
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ),
            );
            if meta.is_dir() {
                walk(&path, root, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// A fresh home with `agent create bernd` (writes `config.json`, nothing else running): `1staid check` reports
/// `ok: true` with `supervisor.state`/`core.state` warning that nothing is running, and never modifies the home.
#[test]
fn check_with_nothing_running_is_read_only_and_exits_0() {
    let h = Home::new();
    let create = Command::new(bin())
        .arg("--home")
        .arg(&h.home)
        .args(["agent", "create", "bernd"])
        .output()
        .unwrap();
    assert_eq!(create.status.code(), Some(0), "{create:?}");

    let before = snapshot(&h.home);
    let out = check_cmd(&h).output().unwrap();
    let after = snapshot(&h.home);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(before, after, "1staid check must never modify the home");

    let v = json_stdout(&out);
    assert_eq!(v["ok"], true, "{v}");
    let checks = checks_by_id(&v);
    assert_eq!(checks["supervisor.state"]["status"], "warn", "{v}");
    assert_eq!(checks["core.state"]["status"], "warn", "{v}");
}

/// The document shape (S12): `schema`, `ok`, `checks[]` each with a known `id`/`status`, in the brief's table order.
#[test]
fn check_json_validates_the_document_shape() {
    let h = Home::new();
    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["schema"], "1staid.check/1", "{v}");
    assert!(v["ok"].is_boolean(), "{v}");

    const EXPECTED_ORDER: &[&str] = &[
        "config.valid",
        "run.permissions",
        "run.stale-files",
        "supervisor.state",
        "core.state",
        "models.warm",
        "memory.shared",
        "core.lock",
        "service.registration",
        "agents.activity",
        "journal.backlog",
        "jobs.last-runs",
        "api.deprecations",
        "windows.pipe-acl",
    ];
    let ids: Vec<String> = v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, EXPECTED_ORDER, "{v}");

    for c in v["checks"].as_array().unwrap() {
        let status = c["status"].as_str().unwrap();
        assert!(
            matches!(status, "ok" | "warn" | "fail" | "skip"),
            "unknown status {status} in {c}"
        );
        assert!(c["summary"].is_string(), "{c}");
    }
}

/// Review Focus 3: a socket/pid file left behind by a power loss, with no process behind it, is a warning.
#[cfg(unix)]
#[test]
fn stale_run_files_are_a_warning() {
    use std::os::unix::fs::PermissionsExt;
    let h = Home::new();
    std::fs::create_dir_all(h.home.join("run")).unwrap();
    std::fs::set_permissions(h.home.join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
    drop(std::os::unix::net::UnixListener::bind(h.home.join("run/supervisor.sock")).unwrap());
    std::fs::write(
        h.home.join("run/supervisor.pid"),
        "999999 00000000-0000-4000-8000-000000000000\n",
    )
    .unwrap();
    // No `run/supervisor.token`: this is a stale-files check, not a supervisor.state one, so `supervisor.state`
    // should read "not running" (warn), not "unresponsive" (fail) — and a warning alone must not fail the check.

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["run.stale-files"]["status"], "warn", "{v}");
    let files: Vec<String> = checks["run.stale-files"]["detail"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap().to_string())
        .collect();
    assert!(files.contains(&"supervisor.sock".to_string()), "{files:?}");
    assert!(files.contains(&"supervisor.pid".to_string()), "{files:?}");
    assert_eq!(
        v["ok"], true,
        "a warning alone does not fail the check: {v}"
    );
}

/// S9/C7: a crashed core is a failed check and exit 1.
#[test]
fn a_crashed_core_is_a_failure_and_exit_1() {
    let h = Home::new();
    let mut sup = supervise_cmd(&h, "exit:2").spawn().unwrap();
    wait_until("the supervisor token", WAIT, || {
        h.home.join("run/supervisor.token").exists()
    });
    let mut c = supervisor_client(&h.home);
    wait_until("the core to crash", WAIT, || {
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"] == "crashed"
    });

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["ok"], false, "{v}");
    let checks = checks_by_id(&v);
    assert_eq!(checks["core.state"]["status"], "fail", "{v}");
    assert_eq!(
        checks["core.state"]["detail"]["reason"], "config-invalid",
        "{v}"
    );

    stop_supervisor(&h.home);
    let _ = sup.kill();
    let _ = sup.wait();
}

/// A fully ready stack: the supervisor and the core both answer and report `ready`.
#[test]
fn ready_stack_is_all_ok_except_service() {
    let h = Home::new();
    let mut sup = supervise_cmd(&h, "ok").spawn().unwrap();
    wait_until("the supervisor token", WAIT, || {
        h.home.join("run/supervisor.token").exists()
    });
    let mut c = supervisor_client(&h.home);
    wait_until("the core to become ready", WAIT, || {
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"] == "ready"
    });

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["supervisor.state"]["status"], "ok", "{v}");
    assert_eq!(checks["core.state"]["status"], "ok", "{v}");
    assert_eq!(
        checks["service.registration"]["status"], "warn",
        "no service was installed: {v}"
    );

    stop_supervisor(&h.home);
    let _ = sup.kill();
    let _ = sup.wait();
}

/// Spec §6.3/S7: a core whose engine reports `models-warming` is a warning, not a failure (the process is ready and
/// recall falls back while the models load).
#[test]
fn models_warming_is_a_warning() {
    let h = Home::new();
    let engine = json!({ "ready": false, "degraded": { "reason": "models-warming", "capability": "embedding" }, "models": {
        "embedder": { "state": "loading", "warming": true, "checkedAt": null, "id": "e5-small" },
        "reranker": { "state": "loading", "warming": true, "checkedAt": null, "id": "local-transformers" } } });
    let mut sup = supervise_cmd(&h, "ok")
        .env("FAKE_CORE_ENGINE", engine.to_string())
        .spawn()
        .unwrap();
    wait_until("the supervisor token", WAIT, || {
        h.home.join("run/supervisor.token").exists()
    });
    let mut c = supervisor_client(&h.home);
    wait_until("the core to become ready", WAIT, || {
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"] == "ready"
    });

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "a warning alone does not fail the check: {out:?}"
    );
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["core.state"]["status"], "ok", "{v}");
    assert_eq!(checks["models.warm"]["status"], "warn", "{v}");
    assert_eq!(
        checks["models.warm"]["detail"]["capability"], "embedding",
        "{v}"
    );

    stop_supervisor(&h.home);
    let _ = sup.kill();
    let _ = sup.wait();
}

/// Task 14 (E4): a core reporting shared memory as unsupported is a warning, not a failure — agent-private memory
/// still works. `daemon status`'s and `1staid check`'s hint on it must name the answer callers see.
#[test]
fn shared_memory_unavailable_is_a_warning_not_a_failure() {
    let h = Home::new();
    let engine = json!({ "ready": true, "degraded": null, "sharedMemory": {
        "supported": false, "mode": "unavailable", "reason": "platform" } });
    let mut sup = supervise_cmd(&h, "ok")
        .env("FAKE_CORE_ENGINE", engine.to_string())
        .spawn()
        .unwrap();
    wait_until("the supervisor token", WAIT, || {
        h.home.join("run/supervisor.token").exists()
    });
    let mut c = supervisor_client(&h.home);
    wait_until("the core to become ready", WAIT, || {
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"] == "ready"
    });

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "a warning alone does not fail the check: {out:?}"
    );
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["core.state"]["status"], "ok", "{v}");
    assert_eq!(checks["memory.shared"]["status"], "warn", "{v}");
    assert!(
        checks["memory.shared"]["summary"]
            .as_str()
            .unwrap()
            .contains("platform"),
        "{v}"
    );
    assert!(
        checks["memory.shared"]["hint"]
            .as_str()
            .unwrap()
            .contains("E_NOT_AVAILABLE"),
        "{v}"
    );

    let status_out = std::process::Command::new(bin())
        .args(["daemon", "status", "--home"])
        .arg(&h.home)
        .output()
        .unwrap();
    assert_eq!(status_out.status.code(), Some(0), "{status_out:?}");
    let human = String::from_utf8_lossy(&status_out.stdout);
    assert!(
        human.contains("shared memory: unavailable (platform)"),
        "{human}"
    );

    stop_supervisor(&h.home);
    let _ = sup.kill();
    let _ = sup.wait();
}

/// Task 15 (E4): `jobs.last-runs` reads `core.status.jobs`; an open rem/deep breaker is a warning, not a failure.
#[test]
fn an_open_breaker_is_a_warning() {
    let h = Home::new();
    let jobs = json!({ "ledger": "ok", "agents": [{ "agentId": "bernd", "running": [], "breakerOpen": true,
        "unreadableLines": 0, "lastRuns": { "dream-rem": { "outcome": "skipped", "reason": "breaker-open", "finishedAt": 1 } } }] });
    let mut sup = supervise_cmd(&h, "ok")
        .env("FAKE_CORE_JOBS", jobs.to_string())
        .spawn()
        .unwrap();
    wait_until("the supervisor token", WAIT, || {
        h.home.join("run/supervisor.token").exists()
    });
    let mut c = supervisor_client(&h.home);
    wait_until("the core to become ready", WAIT, || {
        c.call("daemon.status", json!({})).unwrap()["children"][0]["process"]["state"] == "ready"
    });

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "a warning alone does not fail the check: {out:?}"
    );
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["jobs.last-runs"]["status"], "warn", "{v}");
    assert_eq!(
        checks["jobs.last-runs"]["detail"]["breakerOpen"],
        json!(["bernd"]),
        "{v}"
    );
    assert!(
        checks["jobs.last-runs"]["summary"]
            .as_str()
            .unwrap()
            .contains("breaker"),
        "{v}"
    );

    stop_supervisor(&h.home);
    let _ = sup.kill();
    let _ = sup.wait();
}

/// ADR-016 §5/S13: subscribing to the deprecated `engine.event` notification marks it used, and `1staid check`
/// lists it with `used: true`. This needs the real core (the fake core does not implement `deprecationsUsed`).
#[test]
fn deprecations_list_engine_event_with_used_flag() {
    let h = Home::new();
    std::fs::create_dir_all(&h.home).unwrap();
    let mut config = plur1bus_config::defaults();
    config["agents"]["bernd"] = json!({});
    config["engine"] = json!({
        "neo": { "enabled": false }, "gc": { "enabled": false }, "obsidianBridge": { "enabled": false },
        "merging": { "enabled": false }, "dreaming": { "enabled": false }, "skillMiner": { "enabled": false },
        "temporalContext": { "enabled": false }, "conversationReactivationRecall": { "enabled": false },
        "reranker": { "enabled": false }, "runtime": { "recallTimeoutMs": 10_000 }, "duplicateThreshold": 1.01,
    });
    plur1bus_config::write_atomic(&h.home.join("config.json"), &config).unwrap();

    let mut core = Command::new(bin())
        .arg("--home")
        .arg(&h.home)
        .args(["core", "run"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_TEST_INTERNALS", "flat-embedder")
        .env("PLUR1BUS_CORE_JS", core_js())
        .env("PLUR1BUS_NODE", "node")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    wait_until("the core token", WAIT, || {
        h.home.join("run/core.token").exists()
    });
    let address = if cfg!(windows) {
        use sha2::{Digest, Sha256};
        let hh = format!(
            "{:x}",
            Sha256::digest(h.home.to_string_lossy().to_lowercase().as_bytes())
        );
        format!(r"\\.\pipe\plur1bus-{}-core", &hh[..16])
    } else {
        format!("{}/run/core.sock", h.home.display())
    };
    let deadline = Instant::now() + WAIT;
    let mut sub = loop {
        let token = std::fs::read_to_string(h.home.join("run/core.token")).unwrap_or_default();
        match Client::connect(&address, token.trim(), opts(Endpoint::Core)) {
            Ok(c) => break c,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("cannot connect to the core: {e}"),
        }
    };
    sub.call("events.subscribe", json!({ "names": ["engine.event"] }))
        .unwrap();

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    let deps = checks["api.deprecations"]["detail"]["deprecations"]
        .as_array()
        .unwrap_or_else(|| panic!("{v}"));
    let entry = deps
        .iter()
        .find(|e| e["name"] == "engine.event")
        .unwrap_or_else(|| panic!("engine.event missing from {deps:?}"));
    assert_eq!(entry["used"], true, "{entry}");

    let _ = core.kill();
    let _ = core.wait();
}

/// The unix half of `run.permissions`: `run/` wider than 0700 is a failure.
#[cfg(unix)]
#[test]
fn loose_run_permissions_fail() {
    use std::os::unix::fs::PermissionsExt;
    let h = Home::new();
    std::fs::create_dir_all(h.home.join("run")).unwrap();
    std::fs::set_permissions(h.home.join("run"), std::fs::Permissions::from_mode(0o755)).unwrap();

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let v = json_stdout(&out);
    assert_eq!(v["ok"], false, "{v}");
    let checks = checks_by_id(&v);
    assert_eq!(checks["run.permissions"]["status"], "fail", "{v}");
}
