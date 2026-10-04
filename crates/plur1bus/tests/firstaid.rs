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
/// How long the real built core may take to start (`tests/repair.rs` allows the same for the same core).
const REAL_CORE_START: Duration = Duration::from_secs(60);

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
    let _ = Command::new("taskkill")
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

/// A recursive listing of `dir`'s contents, path -> (len, mtime), used to prove `1staid check` never touches the
/// home directory.
fn snapshot(dir: &Path) -> BTreeMap<PathBuf, (u64, SystemTime)> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<PathBuf, (u64, SystemTime)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Not `entry.metadata()`: on Windows that is the parent listing's cached copy, whose directory
            // timestamps NTFS updates lazily; a fresh query reads the entry itself.
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
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
        "modules.state",
        "service.registration",
        "agents.activity",
        "journal.backlog",
        "jobs.last-runs",
        "api.deprecations",
        "windows.pipe-acl",
        "runtime.node",
        "runtime.core",
        "models.cache",
        "extensions.integrity",
        "extensions.consistency",
        "extensions.revoked",
        "models.roles",
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

/// HB15: the installer checks come after the first fifteen ids, in order (X1 appends three more after them).
#[test]
fn check_json_lists_the_installer_ids_after_the_first_fifteen() {
    let h = Home::new();
    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    let ids: Vec<String> = v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids.len(), 22, "{v}");
    assert_eq!(
        &ids[15..18],
        &["runtime.node", "runtime.core", "models.cache"],
        "{v}"
    );
}

/// HB15: a dev home with no install manifest never gets a `fail` from the new checks — `runtime.node` and
/// `runtime.core` `skip` (never installed by `setup`), and `models.cache` only `warn`s that the models are not
/// cached yet.
#[test]
fn a_dev_home_has_no_fail_from_the_new_checks() {
    let h = Home::new();
    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["runtime.node"]["status"], "skip", "{v}");
    assert_eq!(checks["runtime.core"]["status"], "skip", "{v}");
    assert_ne!(checks["models.cache"]["status"], "fail", "{v}");
}

/// Review Focus 3: the run files a SIGKILL or a power loss leaves behind (sockets, pid files and both token files),
/// with no process behind them, are warnings — `supervisor.state` reads "not running (stale run files)", never
/// "unresponsive", so `1staid check` still exits 0 after every crash (final review I1).
#[cfg(unix)]
#[test]
fn stale_run_files_are_a_warning() {
    use std::os::unix::fs::PermissionsExt;
    let h = Home::new();
    let run = h.home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
    drop(std::os::unix::net::UnixListener::bind(run.join("supervisor.sock")).unwrap());
    drop(std::os::unix::net::UnixListener::bind(run.join("core.sock")).unwrap());
    // Pids that cannot exist (above every pid_max), so the check sees them as dead.
    std::fs::write(
        run.join("supervisor.pid"),
        "2147483000 00000000-0000-4000-8000-000000000000\n",
    )
    .unwrap();
    std::fs::write(
        run.join("core.pid"),
        "2147483001 00000000-0000-4000-8000-000000000001\n",
    )
    .unwrap();
    for token in ["supervisor.token", "core.token"] {
        std::fs::write(run.join(token), "a".repeat(64)).unwrap();
        std::fs::set_permissions(run.join(token), std::fs::Permissions::from_mode(0o600)).unwrap();
    }

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
    for f in ["supervisor.sock", "supervisor.pid", "core.sock", "core.pid"] {
        assert!(files.contains(&f.to_string()), "{f} missing from {files:?}");
    }
    assert_eq!(checks["supervisor.state"]["status"], "warn", "{v}");
    assert_eq!(
        checks["supervisor.state"]["summary"], "supervisor is not running (stale run files)",
        "{v}"
    );
    assert_eq!(checks["core.state"]["status"], "warn", "{v}");
    assert_eq!(
        v["ok"], true,
        "a warning alone does not fail the check: {v}"
    );
}

/// The one case that stays a failure: something accepts the supervisor connection but never answers.
#[cfg(unix)]
#[test]
fn a_supervisor_that_accepts_but_never_answers_is_a_failure() {
    use std::os::unix::fs::PermissionsExt;
    let h = Home::new();
    let run = h.home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(run.join("supervisor.token"), "a".repeat(64)).unwrap();
    std::fs::set_permissions(
        run.join("supervisor.token"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let listener = std::os::unix::net::UnixListener::bind(run.join("supervisor.sock")).unwrap();
    let _bg = std::thread::spawn(move || {
        let mut held = Vec::new();
        for s in listener.incoming().flatten() {
            held.push(s); // keep every connection open; never read or write on it
        }
    });

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["supervisor.state"]["status"], "fail", "{v}");
    assert_eq!(
        checks["supervisor.state"]["summary"], "supervisor is unresponsive",
        "{v}"
    );
}

/// S9/C7: a crashed core is a failed check and exit 1.
#[test]
fn a_crashed_core_is_a_failure_and_exit_1() {
    let h = Home::new();
    let _sup = Spawned::new(supervise_cmd(&h, "exit:2").spawn().unwrap(), &h.home);
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
}

/// A fully ready stack: the supervisor and the core both answer and report `ready`.
#[test]
fn ready_stack_is_all_ok_except_service() {
    let h = Home::new();
    let _sup = Spawned::new(supervise_cmd(&h, "ok").spawn().unwrap(), &h.home);
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
}

/// Spec §6.3/S7: a core whose engine reports `models-warming` is a warning, not a failure (the process is ready and
/// recall falls back while the models load).
#[test]
fn models_warming_is_a_warning() {
    let h = Home::new();
    let engine = json!({ "ready": false, "degraded": { "reason": "models-warming", "capability": "embedding" }, "models": {
        "embedder": { "state": "loading", "warming": true, "checkedAt": null, "id": "e5-small" },
        "reranker": { "state": "loading", "warming": true, "checkedAt": null, "id": "local-transformers" } } });
    let _sup = Spawned::new(
        supervise_cmd(&h, "ok")
            .env("FAKE_CORE_ENGINE", engine.to_string())
            .spawn()
            .unwrap(),
        &h.home,
    );
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
}

/// Task 14 (E4): a core reporting shared memory as unsupported is a warning, not a failure — agent-private memory
/// still works. `daemon status`'s and `1staid check`'s hint on it must name the answer callers see.
#[test]
fn shared_memory_unavailable_is_a_warning_not_a_failure() {
    let h = Home::new();
    let engine = json!({ "ready": true, "degraded": null, "sharedMemory": {
        "supported": false, "mode": "unavailable", "reason": "platform" } });
    let _sup = Spawned::new(
        supervise_cmd(&h, "ok")
            .env("FAKE_CORE_ENGINE", engine.to_string())
            .spawn()
            .unwrap(),
        &h.home,
    );
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
}

/// Task 15 (E4): `jobs.last-runs` reads `core.status.jobs`; an open rem/deep breaker is a warning, not a failure.
#[test]
fn an_open_breaker_is_a_warning() {
    let h = Home::new();
    let jobs = json!({ "ledger": "ok", "agents": [{ "agentId": "bernd", "running": [], "breakerOpen": true,
        "unreadableLines": 0, "lastRuns": { "dream-rem": { "outcome": "skipped", "reason": "breaker-open", "finishedAt": 1 } } }] });
    let _sup = Spawned::new(
        supervise_cmd(&h, "ok")
            .env("FAKE_CORE_JOBS", jobs.to_string())
            .spawn()
            .unwrap(),
        &h.home,
    );
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

    let core = Command::new(bin())
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
    let mut core = Spawned::new(core, &h.home);

    // The real engine's first start on a machine (fresh node_modules, scanned on first load by an antivirus) takes far
    // longer than the fake core's: allow what the repair test allows the same core, and fail at once, with the core's
    // log, if it exits instead.
    let deadline = Instant::now() + REAL_CORE_START;
    while !h.home.join("run/core.token").exists() {
        if let Some(status) = core.child.try_wait().unwrap() {
            let log = fs::read_to_string(h.home.join("logs/core.log")).unwrap_or_default();
            panic!("the core exited before writing its token ({status}): {log}");
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for the core token after {REAL_CORE_START:?}: {}",
            fs::read_to_string(h.home.join("logs/core.log")).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
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
    let deadline = Instant::now() + REAL_CORE_START;
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
}

/// The Windows half of `run.permissions`: a `run/` that another account may write to (here BUILTIN\Users, granted
/// Modify) is a failure. The ready-stack tests show the other side: the fake core secures run/ like the real core.
#[cfg(windows)]
#[test]
fn an_unsecured_run_dir_fails_on_windows() {
    let h = Home::new();
    let run = h.home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let granted = Command::new(Path::new(&system_root).join(r"System32\icacls.exe"))
        .arg(&run)
        .args(["/grant", "*S-1-5-32-545:(OI)(CI)(M)"])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(granted.success());

    let out = check_cmd(&h).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let v = json_stdout(&out);
    let checks = checks_by_id(&v);
    assert_eq!(checks["run.permissions"]["status"], "fail", "{v}");
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

// ---- X1 Task 13: extensions.integrity, extensions.consistency, extensions.revoked ---------------------------------

const EXT_IDS: [&str; 3] = [
    "extensions.integrity",
    "extensions.consistency",
    "extensions.revoked",
];

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Installs a skill record for `name` (content `body`) into the home's `extensions/state.json`, the payload under
/// `skills/<name>/SKILL.md` and, when `index`, an index entry carrying `package`.
fn install_skill(h: &Home, name: &str, version: &str, body: &str, code: bool, index: bool) {
    let ext = h.home.join("extensions");
    fs::create_dir_all(&ext).unwrap();
    let state_path = ext.join("state.json");
    let mut state: Value = fs::read_to_string(&state_path)
        .ok()
        .map(|t| serde_json::from_str(&t).unwrap())
        .unwrap_or_else(|| json!({ "schemaVersion": 1, "items": {} }));
    state["items"][name] = json!({
        "id": format!("local/{name}"),
        "name": name,
        "kind": "skill",
        "version": version,
        "source": "file",
        "trust": "unsigned",
        "packageSha256": "ab".repeat(32),
        "installedAt": "2026-09-28T10:00:00.000Z",
        "files": { "SKILL.md": { "sha256": sha_hex(body.as_bytes()), "size": body.len() } },
        "capabilities": { "network": { "mode": "none" } },
        "scripts": [],
        "requiredSecrets": [],
        "removedByUser": false
    });
    fs::write(&state_path, serde_json::to_string_pretty(&state).unwrap()).unwrap();
    if code {
        let dir = h.home.join("skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), body).unwrap();
    }
    if index {
        write_index_entry(
            h,
            name,
            Some(json!({ "id": format!("local/{name}"), "version": version, "trust": "unsigned" })),
        );
    }
}

fn write_index_entry(h: &Home, id: &str, package: Option<Value>) {
    let dir = h.home.join("skills");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("index.json");
    let mut idx: Value = fs::read_to_string(&path)
        .ok()
        .map(|t| serde_json::from_str(&t).unwrap())
        .unwrap_or_else(|| json!({ "version": 1, "skills": [] }));
    let mut entry = json!({ "id": id, "source": "file", "sourcePath": "x", "sha256": "0".repeat(64), "enabled": false, "importedAt": "2026-09-28T10:00:00.000Z" });
    if let Some(p) = package {
        entry["package"] = p;
    }
    idx["skills"].as_array_mut().unwrap().push(entry);
    fs::write(&path, serde_json::to_string_pretty(&idx).unwrap()).unwrap();
}

fn ext_check(h: &Home, revocations: Option<&Path>) -> BTreeMap<String, Value> {
    let mut c = check_cmd(h);
    if let Some(r) = revocations {
        c.env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_TEST_EXT_REVOCATIONS", r);
    }
    let out = c.output().unwrap();
    let v = json_stdout(&out);
    checks_by_id(&v)
}

#[test]
fn check_ids_are_append_only_and_end_with_the_three_extension_rows() {
    let h = Home::new();
    let out = check_cmd(&h).output().unwrap();
    let v = json_stdout(&out);
    let ids: Vec<String> = v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids.len(), 22, "{v}");
    assert_eq!(
        &ids[15..18],
        &["runtime.node", "runtime.core", "models.cache"]
    );
    assert_eq!(&ids[18..21], &EXT_IDS, "{v}");
    assert_eq!(&ids[21], "models.roles", "{v}");
}

#[test]
fn extension_rows_are_ok_on_a_fresh_home() {
    let h = Home::new();
    let c = ext_check(&h, None);
    for id in EXT_IDS {
        assert_eq!(c[id]["status"], "ok", "{id}: {}", c[id]);
    }
    assert_eq!(
        c["extensions.integrity"]["summary"],
        "no packaged extensions"
    );
    assert!(
        !h.home.join("extensions").exists(),
        "the check must not create anything"
    );
}

#[test]
fn integrity_fails_after_an_installed_skill_file_is_edited() {
    let h = Home::new();
    install_skill(&h, "notes", "1.0.0", "# notes\n", true, true);
    let c = ext_check(&h, None);
    assert_eq!(
        c["extensions.integrity"]["status"], "ok",
        "{}",
        c["extensions.integrity"]
    );
    let state_before = fs::read(h.home.join("extensions/state.json")).unwrap();
    fs::write(h.home.join("skills/notes/SKILL.md"), "# edited\n").unwrap();
    let c = ext_check(&h, None);
    let row = &c["extensions.integrity"];
    assert_eq!(row["status"], "fail", "{row}");
    assert!(
        row["detail"].to_string().contains("notes: SKILL.md"),
        "{row}"
    );
    assert_eq!(c["extensions.consistency"]["status"], "ok");
    assert_eq!(
        fs::read(h.home.join("extensions/state.json")).unwrap(),
        state_before,
        "the check never writes integrity back into state.json"
    );
}

#[test]
fn consistency_warns_on_an_orphan_index_package_entry_and_fails_on_missing_code() {
    let h = Home::new();
    write_index_entry(
        &h,
        "ghost",
        Some(json!({ "id": "local/ghost", "version": "1.0.0", "trust": "unsigned" })),
    );
    // An imported skill (no `package`) is not an orphan.
    write_index_entry(&h, "imported", None);
    let c = ext_check(&h, None);
    let row = &c["extensions.consistency"];
    assert_eq!(row["status"], "warn", "{row}");
    assert!(row["detail"].to_string().contains("ghost"), "{row}");
    assert!(!row["detail"].to_string().contains("imported"), "{row}");

    // A record whose code directory is gone fails, whatever the index says.
    install_skill(&h, "notes", "1.0.0", "# notes\n", false, false);
    let c = ext_check(&h, None);
    let row = &c["extensions.consistency"];
    assert_eq!(row["status"], "fail", "{row}");
    assert!(row["detail"].to_string().contains("notes"), "{row}");
    assert_eq!(
        c["extensions.integrity"]["status"], "fail",
        "missing files are an integrity failure too"
    );
}

#[test]
fn revoked_fails_for_an_installed_revoked_item() {
    let h = Home::new();
    install_skill(&h, "notes", "1.2.0", "# notes\n", true, true);
    install_skill(&h, "other", "1.0.0", "# other\n", true, true);
    let rev = h.home.join("revocations-seam.json");
    fs::write(
        &rev,
        r#"[{"id":"local/notes","versions":"<2.0.0","action":"disable","reason":{"en":"leaks tokens"}},
            {"id":"local/other","versions":"*","action":"warn","reason":"only a warning"}]"#,
    )
    .unwrap();
    let c = ext_check(&h, Some(&rev));
    let row = &c["extensions.revoked"];
    assert_eq!(row["status"], "fail", "{row}");
    let text = row["detail"].to_string();
    assert!(
        text.contains("local/notes") && text.contains("leaks tokens"),
        "{row}"
    );
    assert!(!text.contains("local/other"), "{row}");
    // Without the seam nothing is revoked.
    assert_eq!(ext_check(&h, None)["extensions.revoked"]["status"], "ok");
}

#[test]
fn a_removed_by_user_tombstone_is_skipped_by_all_three_rows() {
    let h = Home::new();
    // Code gone, file edited nowhere, and revoked: a live record would fail every row.
    install_skill(&h, "gone", "1.0.0", "# gone\n", false, false);
    let path = h.home.join("extensions/state.json");
    let mut st: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    st["items"]["gone"]["removedByUser"] = json!(true);
    fs::write(&path, st.to_string()).unwrap();
    let rev = h.home.join("rev.json");
    fs::write(
        &rev,
        r#"[{"id":"local/gone","versions":"*","action":"disable","reason":"x"}]"#,
    )
    .unwrap();
    let c = ext_check(&h, Some(&rev));
    for id in EXT_IDS {
        assert_eq!(c[id]["status"], "ok", "{id}: {}", c[id]);
    }
}

#[test]
fn an_index_entry_named_like_a_tombstone_counts_as_an_orphan() {
    let h = Home::new();
    install_skill(&h, "gone", "1.0.0", "# gone\n", false, true);
    let path = h.home.join("extensions/state.json");
    let mut st: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    st["items"]["gone"]["removedByUser"] = json!(true);
    fs::write(&path, st.to_string()).unwrap();
    let c = ext_check(&h, None);
    let row = &c["extensions.consistency"];
    assert_eq!(row["status"], "warn", "{row}");
    assert!(row["detail"].to_string().contains("gone"), "{row}");
}

#[test]
fn an_unreadable_state_json_fails_all_three_rows() {
    let h = Home::new();
    fs::create_dir_all(h.home.join("extensions")).unwrap();
    fs::write(h.home.join("extensions/state.json"), "{ not json").unwrap();
    let c = ext_check(&h, None);
    for id in EXT_IDS {
        assert_eq!(c[id]["status"], "fail", "{id}: {}", c[id]);
    }
}

#[test]
fn an_unreadable_skills_index_warns_on_consistency() {
    let h = Home::new();
    fs::create_dir_all(h.home.join("skills")).unwrap();
    fs::write(h.home.join("skills/index.json"), "{ not json").unwrap();
    let c = ext_check(&h, None);
    assert_eq!(
        c["extensions.consistency"]["status"], "warn",
        "{}",
        c["extensions.consistency"]
    );
    assert_eq!(c["extensions.integrity"]["status"], "ok");
}
