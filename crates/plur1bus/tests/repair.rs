//! `plur1bus 1staid repair` (2a-H3b-b Task 7, spec §6.6, HB16): a plan over the failing `1staid check` rows, printed
//! first, applied only when confirmed. No network and no real service manager: the service manager is the recording
//! fake (`PLUR1BUS_SERVICE_FAKE`) with `HOME`/`USERPROFILE`/`LOCALAPPDATA` in the temp dir, the Node runtime comes from
//! a `file://` mirror whose archive hash replaces the pin (`PLUR1BUS_TEST_NODE_SHA256`), and the supervised core is
//! `tests/fixtures/fake-core.mjs` (the real built core where `memory recall` must work). Every run has no terminal on
//! stdin, so `--yes` is what confirms.
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(20);

fn bin() -> PathBuf {
    assert_cmd::cargo::cargo_bin("plur1bus")
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs")
}

/// A temp root with the PLUR1BUS home, the stand-in OS user home and the fake service manager's directory.
struct Env {
    _tmp: tempfile::TempDir,
    #[cfg_attr(not(unix), allow(dead_code))] // the Node mirror of the unix-only reinstall test
    root: PathBuf,
    home: PathBuf,
    user: PathBuf,
    fake: PathBuf,
    events: PathBuf,
}

impl Env {
    fn new() -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let home = root.join("h");
        let user = root.join("user");
        let fake = root.join("fake");
        for d in [&home, &user, &fake] {
            fs::create_dir_all(d).unwrap();
        }
        Env {
            events: root.join("events.jsonl"),
            _tmp: tmp,
            root,
            home,
            user,
            fake,
        }
    }

    /// `plur1bus --home <home> <args>` with the fake service manager and the temp OS user home.
    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(bin());
        c.arg("--home")
            .arg(&self.home)
            .args(args)
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", &self.fake)
            .env("HOME", &self.user)
            .env("USERPROFILE", &self.user)
            .env("LOCALAPPDATA", self.user.join("AppData").join("Local"))
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("PLUR1BUS_HOME")
            .env_remove("PLUR1BUS_CONTAINER")
            .env_remove("PLUR1BUS_NODE")
            .env_remove("PLUR1BUS_CORE_JS")
            .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    /// `plur1bus --json --home <home> 1staid repair <args>` → (exit code, stdout document).
    fn repair(&self, args: &[&str]) -> (i32, Value) {
        let mut all = vec!["--json", "1staid", "repair"];
        all.extend_from_slice(args);
        json_of(self.cmd(&all).output().unwrap())
    }

    /// Registers and starts the home's service in the fake manager, so `service.registration` is `ok`.
    fn install_service(&self) {
        let (code, v) = json_of(
            self.cmd(&["--json", "service", "install"])
                .output()
                .unwrap(),
        );
        assert_eq!(code, 0, "{v}");
    }

    fn service_status(&self) -> Value {
        json_of(self.cmd(&["--json", "service", "status"]).output().unwrap()).1
    }

    /// Stale run files and a broken hand edit: `run/core.pid` naming a dead process and an invalid `config.json`.
    fn break_home(&self) {
        let run = self.home.join("run");
        fs::create_dir_all(&run).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&run, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            run.join("core.pid"),
            format!("{} 00000000-0000-4000-8000-000000000000\n", dead_pid()),
        )
        .unwrap();
        fs::write(self.home.join("config.json"), "{ not json").unwrap();
    }

    fn audit_lines(&self) -> Vec<Value> {
        fs::read_to_string(self.home.join("logs").join("audit.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

fn json_of(out: Output) -> (i32, Value) {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v = serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
        panic!(
            "stdout is not JSON ({e}): {stdout:?}; stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        )
    });
    (out.status.code().unwrap_or(-1), v)
}

/// The pid of a process that has exited (a child this test ran and reaped).
fn dead_pid() -> u32 {
    let mut c = Command::new(bin())
        .arg("--version")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let pid = c.id();
    c.wait().unwrap();
    pid
}

fn ids(v: &Value) -> Vec<String> {
    v["steps"]
        .as_array()
        .unwrap_or_else(|| panic!("no steps: {v}"))
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect()
}

fn step<'a>(v: &'a Value, id: &str) -> &'a Value {
    v["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap_or_else(|| panic!("no step {id}: {v}"))
}

/// Every file and directory under `dir`: relative path → (content hash or "dir", unix mode bits).
fn tree(dir: &Path) -> BTreeMap<PathBuf, (String, u32)> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<PathBuf, (String, u32)>) {
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            let meta = fs::symlink_metadata(&p).unwrap();
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o7777
            };
            #[cfg(not(unix))]
            let mode = 0;
            let rel = p.strip_prefix(root).unwrap().to_path_buf();
            if meta.is_dir() {
                out.insert(rel, ("dir".into(), mode));
                walk(&p, root, out);
            } else {
                let h = format!("{:x}", Sha256::digest(fs::read(&p).unwrap_or_default()));
                out.insert(rel, (h, mode));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn wait_until(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ---- a supervised stack ---------------------------------------------------------------------------------------

fn supervisor_address(home: &Path) -> String {
    if cfg!(windows) {
        let h = format!(
            "{:x}",
            Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes())
        );
        format!(r"\\.\pipe\plur1bus-{}-supervisor", &h[..16])
    } else {
        format!("{}/run/supervisor.sock", home.display())
    }
}

fn supervisor_client(home: &Path) -> Client {
    let deadline = Instant::now() + WAIT;
    loop {
        let token = fs::read_to_string(home.join("run/supervisor.token")).unwrap_or_default();
        let opts = ConnectOptions {
            connect_timeout: Duration::from_secs(2),
            call_timeout: Duration::from_secs(10),
            endpoint: Endpoint::Supervisor,
            expected_server_pid: None,
        };
        match Client::connect(&supervisor_address(home), token.trim(), opts) {
            Ok(c) => return c,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("cannot connect to the supervisor: {e}"),
        }
    }
}

fn core_child(c: &mut Client) -> Value {
    let s = c.call("daemon.status", json!({})).unwrap();
    s["children"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["kind"] != "module").cloned())
        .unwrap_or(Value::Null)
}

fn core_state(c: &mut Client) -> String {
    core_child(c)["process"]["state"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

/// A `supervise` process started by a test: stopped over RPC on drop, then killed and reaped.
struct Supervised {
    child: std::process::Child,
    home: PathBuf,
}

impl Drop for Supervised {
    fn drop(&mut self) {
        if let Ok(token) = fs::read_to_string(self.home.join("run/supervisor.token")) {
            let opts = ConnectOptions {
                connect_timeout: Duration::from_millis(500),
                call_timeout: Duration::from_secs(5),
                endpoint: Endpoint::Supervisor,
                expected_server_pid: None,
            };
            if let Ok(mut c) = Client::connect(&supervisor_address(&self.home), token.trim(), opts)
            {
                let _ = c.call("daemon.stop", json!({ "budgetMs": 1000 }));
                let deadline = Instant::now() + Duration::from_secs(10);
                while self.home.join("run/supervisor.pid").exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `plur1bus supervise` with `core_js` as its core and `env` added; waits until the supervisor answers.
fn supervise(e: &Env, core_js: &Path, env: &[(&str, &str)]) -> Supervised {
    let child = e
        .cmd(&["supervise"])
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.02")
        .env("PLUR1BUS_CORE_JS", core_js)
        .env("PLUR1BUS_NODE", "node")
        .env("FAKE_CORE_EVENTS", &e.events)
        .env("FAKE_CORE_GRACE_MS", "300")
        .envs(env.iter().copied())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let s = Supervised {
        child,
        home: e.home.clone(),
    };
    drop(supervisor_client(&e.home));
    s
}

// ---- the plan ---------------------------------------------------------------------------------------------------

/// A healthy installation is a running one: the registered service, and a supervisor that secured `run/` at start
/// (0700 on unix, the protected inheritable user-and-SYSTEM DACL on Windows, HB5) serving a ready core.
#[test]
fn a_healthy_installation_plans_nothing() {
    let e = Env::new();
    e.install_service();
    let _s = supervise(&e, &fixture(), &[("FAKE_CORE_MODE", "ok")]);
    let mut c = supervisor_client(&e.home);
    wait_until("the core to become ready", WAIT, || {
        core_state(&mut c) == "ready"
    });
    let (code, v) = e.repair(&[]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["schema"], "1staid.repair/1", "{v}");
    assert_eq!(v["dryRun"], false);
    assert_eq!(v["steps"], json!([]), "{v}");
    assert_eq!(v["checkAfter"]["fail"], 0, "{v}");
    assert!(e.audit_lines().is_empty());
}

#[cfg(unix)]
#[test]
fn dry_run_prints_the_plan_and_changes_nothing() {
    let e = Env::new();
    e.install_service();
    e.break_home();
    let before = tree(&e.home);
    let (code, v) = e.repair(&["--dry-run"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["dryRun"], true);
    assert_eq!(
        ids(&v),
        [
            "run.permissions.fix",
            "run.stale-files.remove",
            "config.restore"
        ],
        "{v}"
    );
    let expect = [
        ("run.permissions.fix", "run.permissions", "low"),
        ("run.stale-files.remove", "run.stale-files", "low"),
        ("config.restore", "config.valid", "medium"),
    ];
    for (id, reason, risk) in expect {
        let s = step(&v, id);
        assert_eq!(s["status"], "planned", "{s}");
        assert_eq!(s["reason"], reason, "{s}");
        assert_eq!(s["risk"], risk, "{s}");
        assert_eq!(s["needsConfirmation"], true, "{s}");
        assert!(s["action"].is_string() && s["target"].is_string(), "{s}");
    }
    assert!(v["checkAfter"].is_null(), "{v}");
    assert_eq!(tree(&e.home), before, "a dry run changed the home");
}

#[test]
fn yes_applies_the_plan_and_the_check_after_is_clean() {
    let e = Env::new();
    e.install_service();
    e.break_home();
    fs::write(
        e.home.join("config.json.bak-1"),
        r#"{"schemaVersion":1,"core":{"logLevel":"debug"}}"#,
    )
    .unwrap();
    let (code, v) = e.repair(&["--yes"]);
    assert_eq!(code, 0, "{v}");
    for id in ["run.stale-files.remove", "config.restore"] {
        assert_eq!(step(&v, id)["status"], "done", "{v}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(step(&v, "run.permissions.fix")["status"], "done", "{v}");
        let mode = fs::metadata(e.home.join("run"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
    }
    assert!(v["steps"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["status"] == "done"));
    assert_eq!(v["checkAfter"]["fail"], 0, "{v}");
    assert!(v["checkAfter"]["failing"].as_array().unwrap().is_empty());
    assert!(!e.home.join("run/core.pid").exists());
    let config: Value =
        serde_json::from_str(&fs::read_to_string(e.home.join("config.json")).unwrap()).unwrap();
    assert_eq!(config["core"]["logLevel"], "debug");
}

#[test]
fn no_tty_without_yes_exits_2_and_changes_nothing() {
    let e = Env::new();
    e.install_service();
    e.break_home();
    let before = tree(&e.home);
    let (code, v) = e.repair(&[]);
    assert_eq!(code, 2, "{v}");
    assert_eq!(v["schema"], "error/1", "{v}");
    assert_eq!(v["applied"], false, "{v}");
    assert!(ids(&v).contains(&"config.restore".to_string()), "{v}");
    assert_eq!(
        tree(&e.home),
        before,
        "an unconfirmed repair changed the home"
    );
    assert!(e.audit_lines().is_empty());
}

#[test]
fn config_restore_with_a_running_supervisor_backs_up_the_edit_and_rearms_the_core() {
    let e = Env::new();
    fs::write(e.home.join("config.json"), r#"{"schemaVersion":1}"#).unwrap();
    // The first core crashes 600 ms after ready; every later one serves, but exits 2 at start while config.json is
    // not JSON (B18: fatal config-invalid until a valid file re-arms it).
    let _s = supervise(
        &e,
        &fixture(),
        &[
            ("FAKE_CORE_MODE", "crash-after:600"),
            ("FAKE_CORE_LATER_MODE", "ok"),
            ("FAKE_CORE_CONFIG_CHECK", "1"),
        ],
    );
    let mut c = supervisor_client(&e.home);
    wait_until("the core to become ready", WAIT, || {
        core_state(&mut c) == "ready"
    });
    fs::write(e.home.join("config.json"), "{ not json").unwrap();
    wait_until("the core to crash config-invalid", WAIT, || {
        let child = core_child(&mut c);
        child["process"]["state"] == "crashed" && child["process"]["reason"] == "config-invalid"
    });

    let (code, v) = e.repair(&["--yes", "--only", "config.restore"]);
    assert_eq!(ids(&v), ["config.restore"], "{v}");
    assert_eq!(step(&v, "config.restore")["status"], "done", "{v}");
    assert_eq!(code, 0, "{v}");
    let rejected: Vec<PathBuf> = fs::read_dir(&e.home)
        .unwrap()
        .flatten()
        .map(|d| d.path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("config.json.rejected-")
        })
        .collect();
    assert_eq!(rejected.len(), 1, "{rejected:?}");
    assert_eq!(fs::read(&rejected[0]).unwrap(), b"{ not json");
    plur1bus_config::parse(&fs::read_to_string(e.home.join("config.json")).unwrap()).unwrap();
    wait_until("the core to be ready again", WAIT, || {
        core_state(&mut c) == "ready"
    });
}

#[test]
fn offline_config_restore_uses_the_newest_valid_backup() {
    let e = Env::new();
    fs::write(e.home.join("config.json"), "{ not json").unwrap();
    fs::write(e.home.join("config.json.bak-1"), "{ also not json").unwrap();
    fs::write(
        e.home.join("config.json.bak-2"),
        r#"{"schemaVersion":1,"core":{"logLevel":"warn"}}"#,
    )
    .unwrap();
    fs::write(e.home.join("config.json.bak-3"), "{ newest, invalid").unwrap();
    let (code, v) = e.repair(&["--yes", "--only", "config.restore"]);
    assert_eq!(step(&v, "config.restore")["status"], "done", "{v}");
    assert_eq!(code, 0, "{v}");
    assert!(
        step(&v, "config.restore")["detail"]["from"]
            .as_str()
            .unwrap()
            .ends_with("config.json.bak-2"),
        "{v}"
    );
    let config: Value =
        serde_json::from_str(&fs::read_to_string(e.home.join("config.json")).unwrap()).unwrap();
    assert_eq!(config["core"]["logLevel"], "warn");
}

#[test]
fn repair_never_touches_state() {
    let e = Env::new();
    e.install_service();
    e.break_home();
    fs::write(e.home.join("config.json.bak-1"), r#"{"schemaVersion":1}"#).unwrap();
    let state = e.home.join("state");
    fs::create_dir_all(state.join("agents").join("bernd")).unwrap();
    fs::write(state.join("memory.db"), b"TEST ONLY").unwrap();
    fs::write(state.join("agents/bernd/journal.jsonl"), b"{}\n").unwrap();
    fs::write(state.join("core.pid.tmp-1"), b"1").unwrap();
    let before = tree(&state);
    let (code, v) = e.repair(&["--yes"]);
    assert_eq!(code, 0, "{v}");
    assert!(!ids(&v).is_empty());
    assert_eq!(tree(&state), before, "repair changed state/");
}

/// Review Focus 3: with the daemon running and serving, a live socket, token or pid file is never "stale", even when
/// the check found a stale sibling.
#[test]
fn repair_never_removes_a_live_endpoint() {
    let e = Env::new();
    e.install_service();
    let core_js = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/dist/core.js")
        .canonicalize()
        .expect("packages/core/dist/core.js (run `pnpm build` first)");
    let mut config = plur1bus_config::defaults();
    config["agents"]["bernd"] = json!({});
    config["engine"] = json!({
        "neo": { "enabled": false }, "gc": { "enabled": false }, "obsidianBridge": { "enabled": false },
        "merging": { "enabled": false }, "dreaming": { "enabled": false }, "skillMiner": { "enabled": false },
        "temporalContext": { "enabled": false }, "conversationReactivationRecall": { "enabled": false },
        "reranker": { "enabled": false }, "runtime": { "recallTimeoutMs": 10_000 }, "duplicateThreshold": 1.01,
    });
    plur1bus_config::write_atomic(&e.home.join("config.json"), &config).unwrap();
    let _s = supervise(
        &e,
        &core_js,
        &[("PLUR1BUS_TEST_INTERNALS", "flat-embedder")],
    );
    let mut c = supervisor_client(&e.home);
    wait_until("the core to become ready", Duration::from_secs(60), || {
        core_state(&mut c) == "ready"
    });
    let run = e.home.join("run");
    fs::write(
        run.join("module-gone.pid"),
        format!("{} 00000000-0000-4000-8000-000000000000\n", dead_pid()),
    )
    .unwrap();
    let live: Vec<&str> = if cfg!(windows) {
        vec![
            "core.pid",
            "core.token",
            "supervisor.pid",
            "supervisor.token",
        ]
    } else {
        vec![
            "core.pid",
            "core.sock",
            "core.token",
            "supervisor.pid",
            "supervisor.sock",
            "supervisor.token",
        ]
    };
    for f in &live {
        assert!(run.join(f).exists(), "{f} is missing before the repair");
    }

    let (code, v) = e.repair(&["--yes"]);
    assert_eq!(code, 0, "{v}");
    let s = step(&v, "run.stale-files.remove");
    assert_eq!(s["status"], "done", "{v}");
    assert_eq!(s["detail"]["removed"], json!(["module-gone.pid"]), "{v}");
    assert!(!run.join("module-gone.pid").exists());
    for f in &live {
        assert!(run.join(f).exists(), "repair removed the live {f}");
    }
    let out = e
        .cmd(&["--json", "memory", "recall", "--agent", "bernd", "anything"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
}

#[test]
fn only_limits_the_plan_to_the_named_steps() {
    let e = Env::new();
    e.install_service();
    e.break_home();
    let (code, v) = e.repair(&["--dry-run", "--only", "config.restore"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(ids(&v), ["config.restore"], "{v}");
    let (code, v) = e.repair(&["--dry-run", "--only", "no.such-step"]);
    assert_eq!(code, 2, "{v}");
    assert_eq!(v["error"], "E_INVALID_PARAMS", "{v}");
}

#[test]
fn each_applied_step_writes_one_audit_line() {
    let e = Env::new();
    e.install_service();
    e.break_home();
    fs::write(e.home.join("config.json.bak-1"), r#"{"schemaVersion":1}"#).unwrap();
    let (code, v) = e.repair(&["--yes"]);
    assert_eq!(code, 0, "{v}");
    let done: Vec<String> = v["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["status"] == "done")
        .map(|s| format!("repair.{}", s["id"].as_str().unwrap()))
        .collect();
    assert!(!done.is_empty());
    let actions: Vec<String> = e
        .audit_lines()
        .iter()
        .map(|l| l["action"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(actions, done);
}

#[test]
fn service_renew_rewrites_a_deleted_unit() {
    let e = Env::new();
    e.install_service();
    let path = PathBuf::from(e.service_status()["path"].as_str().unwrap());
    let (code, v) = json_of(e.cmd(&["--json", "service", "uninstall"]).output().unwrap());
    assert_eq!(code, 0, "{v}");
    assert!(!path.exists());
    assert_eq!(e.service_status()["registered"], false);

    let (code, v) = e.repair(&["--yes"]);
    // On Windows `service install` created run/ (the task XML lives there) with the temp dir's inherited ACL, which
    // `run.permissions` rightly fails; that step is covered by its own tests.
    let planned: Vec<String> = ids(&v)
        .into_iter()
        .filter(|id| !(cfg!(windows) && id == "run.permissions.fix"))
        .collect();
    assert_eq!(planned, ["service.renew"], "{v}");
    assert_eq!(step(&v, "service.renew")["status"], "done", "{v}");
    assert_eq!(step(&v, "service.renew")["risk"], "low", "{v}");
    assert_eq!(code, 0, "{v}");
    assert!(path.exists(), "the unit was not rewritten");
    assert_eq!(e.service_status()["registered"], true);
}

// ---- runtime.node.reinstall ----------------------------------------------------------------------------------------

#[cfg(unix)]
mod node {
    use super::*;

    const NODE_VERSION: &str = "24.21.0";
    const SHIM: &[u8] = b"#!/bin/sh\nexec \"$REAL_NODE\" \"$@\"\n";

    fn target_id() -> &'static str {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => "linux-x64",
            ("linux", "aarch64") => "linux-arm64",
            ("macos", "aarch64") => "darwin-arm64",
            other => panic!("no release target for {other:?}"),
        }
    }

    /// The Task 4 fixture: `node-v24.21.0-<target>.tar.gz` holding a `bin/node` shim.
    fn archive() -> Vec<u8> {
        let root = format!("node-v{NODE_VERSION}-{}", target_id());
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        let mut add = |name: String, data: &[u8], mode: u32, dir: bool| {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(if dir {
                tar::EntryType::Directory
            } else {
                tar::EntryType::Regular
            });
            h.set_mode(mode);
            h.set_size(data.len() as u64);
            h.set_cksum();
            b.append_data(&mut h, name, data).unwrap();
        };
        add(format!("{root}/"), b"", 0o755, true);
        add(format!("{root}/bin/"), b"", 0o755, true);
        add(format!("{root}/bin/node"), SHIM, 0o755, false);
        add(
            format!("{root}/README.md"),
            b"TEST ONLY fake Node\n",
            0o644,
            false,
        );
        b.into_inner().unwrap().finish().unwrap()
    }

    fn sha(b: &[u8]) -> String {
        format!("{:x}", Sha256::digest(b))
    }

    #[test]
    fn runtime_node_reinstall_restores_a_corrupted_binary() {
        use std::os::unix::fs::PermissionsExt;
        let e = Env::new();
        let bytes = archive();
        let mirror = e.root.join("mirror");
        fs::create_dir_all(mirror.join(format!("v{NODE_VERSION}"))).unwrap();
        fs::write(
            mirror
                .join(format!("v{NODE_VERSION}"))
                .join(format!("node-v{NODE_VERSION}-{}.tar.gz", target_id())),
            &bytes,
        )
        .unwrap();
        // What setup left: the runtime, a core payload and the install manifest.
        let node_dir = e.home.join("runtime").join(format!("node-{NODE_VERSION}"));
        let node = node_dir.join("bin").join("node");
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        fs::write(&node, SHIM).unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let core = e.home.join("runtime").join("core");
        fs::create_dir_all(&core).unwrap();
        fs::write(core.join("core.js"), b"// TEST ONLY\n").unwrap();
        fs::write(core.join("package.json"), r#"{"version":"0.0.1"}"#).unwrap();
        let manifest = json!({
            "schemaVersion": 1, "installedAt": 1, "updatedAt": 1, "channel": "stable", "target": target_id(),
            "binary": { "version": "0.0.0", "sha256": null },
            "node": { "version": NODE_VERSION, "archiveSha256": sha(&bytes), "binarySha256": sha(SHIM),
                      "path": node.to_string_lossy() },
            "core": { "version": "0.0.1", "contract": "1.9.0", "rpc": "1.3.0", "sha256": null, "source": "local" },
            "modules": [], "skills": [],
        });
        fs::write(e.home.join("manifest.json"), manifest.to_string()).unwrap();
        // One byte flipped.
        let mut corrupt = SHIM.to_vec();
        corrupt[3] ^= 0x01;
        fs::write(&node, &corrupt).unwrap();

        let run = |args: &[&str]| {
            let mut all = vec!["--json", "1staid", "repair"];
            all.extend_from_slice(args);
            json_of(
                e.cmd(&all)
                    .env(
                        "PLUR1BUS_NODE_MIRROR",
                        format!("file://{}", mirror.display()),
                    )
                    .env("PLUR1BUS_TEST_NODE_SHA256", sha(&bytes))
                    .output()
                    .unwrap(),
            )
        };
        let (code, v) = run(&["--dry-run"]);
        assert_eq!(code, 0, "{v}");
        let s = step(&v, "runtime.node.reinstall");
        assert_eq!(s["reason"], "runtime.node", "{v}");
        assert_eq!(s["risk"], "medium", "{v}");

        let (code, v) = run(&["--yes", "--only", "runtime.node.reinstall"]);
        assert_eq!(step(&v, "runtime.node.reinstall")["status"], "done", "{v}");
        assert_eq!(code, 0, "{v}");
        assert_eq!(sha(&fs::read(&node).unwrap()), sha(SHIM));
        let m: Value =
            serde_json::from_str(&fs::read_to_string(e.home.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(m["node"]["binarySha256"], sha(SHIM));
        assert!(!v["checkAfter"]["failing"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "runtime.node"));
    }
}

// ---- run.permissions.fix on Windows --------------------------------------------------------------------------------

/// The run files as a real installation leaves them: `core.token` and `core.pid` with the protected explicit DACL an
/// older core's `securePath` gives them (`icacls /inheritance:r /grant:r <user>:(F) SYSTEM:(F)`), a module token
/// with whatever it inherited, and a `run/` that BUILTIN\Users may modify. The fix gives `run/` the supervisor's
/// protected inheritable DACL (HB5) and resets every token and pid file to inherit exactly that.
#[cfg(windows)]
#[test]
fn windows_permissions_fix_resets_run_files_made_by_the_core_to_inherit_the_run_acl() {
    use plur1bus_rpc::acl::{INHERITED_ACE, SYSTEM_SID};
    let e = Env::new();
    e.install_service();
    let run = e.home.join("run");
    fs::create_dir_all(&run).unwrap();
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let icacls = |args: &[&str]| {
        let ok = Command::new(Path::new(&system_root).join(r"System32\icacls.exe"))
            .args(args)
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(ok.success(), "icacls {args:?}");
    };
    let sid = plur1bus_rpc::win::user_sid().unwrap();
    // `core.pid` names a live process (this test), so `run.stale-files` rightly leaves it alone and the plan is the
    // permission reset only.
    fs::write(
        run.join("core.pid"),
        format!(
            "{} 00000000-0000-4000-8000-000000000000\n",
            std::process::id()
        ),
    )
    .unwrap();
    for f in ["core.token", "module-fixture.token"] {
        fs::write(run.join(f), b"TEST ONLY").unwrap();
    }
    for f in ["core.token", "core.pid"] {
        let p = run.join(f);
        icacls(&[
            p.to_str().unwrap(),
            "/inheritance:r",
            "/grant:r",
            &format!("*{sid}:(F)"),
            "*S-1-5-18:(F)",
        ]);
        assert!(plur1bus_rpc::win::file_dacl_detail(&p).unwrap().protected);
    }
    icacls(&[run.to_str().unwrap(), "/grant", "*S-1-5-32-545:(OI)(CI)(M)"]);

    let (code, v) = e.repair(&["--dry-run"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(ids(&v), ["run.permissions.fix"], "{v}");

    let (code, v) = e.repair(&["--yes"]);
    let s = step(&v, "run.permissions.fix");
    assert_eq!(s["status"], "done", "{v}");
    assert_eq!(
        s["detail"]["files"],
        json!(["core.pid", "core.token", "module-fixture.token"]),
        "{v}"
    );
    assert_eq!(code, 0, "{v}");
    assert!(!v["checkAfter"]["failing"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "run.permissions"));

    let dir = plur1bus_rpc::win::file_dacl_detail(&run).unwrap();
    assert!(dir.protected, "{dir:?}");
    let mut sids: Vec<&str> = dir.aces.iter().map(|(a, _)| a.sid.as_str()).collect();
    sids.sort();
    let mut want = vec![sid.as_str(), SYSTEM_SID];
    want.sort();
    assert_eq!(sids, want, "{dir:?}");
    for f in ["core.token", "core.pid", "module-fixture.token"] {
        let d = plur1bus_rpc::win::file_dacl_detail(&run.join(f)).unwrap();
        assert!(!d.protected, "{f}: {d:?}");
        assert!(!d.aces.is_empty(), "{f}: {d:?}");
        for (ace, flags) in &d.aces {
            assert!(flags & INHERITED_ACE != 0, "{f}: explicit ACE left: {d:?}");
            assert!(ace.sid == sid || ace.sid == SYSTEM_SID, "{f}: {d:?}");
        }
    }
}
