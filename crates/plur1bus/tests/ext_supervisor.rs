//! `ext.*` over the supervisor's RPC (X1 Task 11; spec §6.1, §6.3, §10.2; X1-R2, X1-R8, X1-R15, X1-R17; acceptance 4
//! and the second half of 7): inspect and install through the worker process, enable and disable with held-back
//! dependents, `ext.watch`/`ext.changed`, uninstall into the trash and restore, overlays that hold a packaged module
//! back at start, worker failures, the mutation lock, and a supervisor process that never opens a package.
//!
//! Every test has its own temp home. A test that needs running modules starts the supervisor with
//! `tests/fixtures/fake-core.mjs` as its core and packages built from the fixture module (`PLUR1BUS_FIXTURE_MODULE`,
//! default `packages/module-fixture/dist`, built by `pnpm build`); the others run `supervise --no-core`. Packages are
//! signed with a throwaway key the supervisor trusts through `PLUR1BUS_TEST_EXT_PUBKEYS`. No test touches a real
//! service manager (`daemon status` runs against the fake one), a real home or another harness's install.
mod common;

use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, test_key, TestKey};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(30);
const SCALE: &str = "0.02";

// ---- homes and supervisors ----------------------------------------------------------------------------------------

struct Home {
    dir: tempfile::TempDir,
    home: PathBuf,
    events: PathBuf,
    key: TestKey,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("h");
        std::fs::create_dir_all(&home).unwrap();
        let events = dir.path().join("events.jsonl");
        Home {
            home,
            events,
            key: test_key("test"),
            dir,
        }
    }

    fn pubkeys(&self) -> String {
        format!("{}={}", self.key.label, self.key.public_b64)
    }

    /// `supervise --no-core` with the trusted test key and `env`.
    fn start_no_core(&self, env: &[(&str, &str)]) -> common::Supervisor {
        let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
            .arg("--home")
            .arg(&self.home)
            .args(["supervise", "--no-core"])
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", "0.2")
            .env("PLUR1BUS_TEST_EXT_PUBKEYS", self.pubkeys())
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let s = common::Supervisor {
            child,
            home: self.home.clone(),
        };
        common::wait_until("run/supervisor.token", WAIT, || {
            self.home.join("run/supervisor.token").exists()
        });
        drop(common::client(&self.home));
        s
    }

    /// `supervise` with the fake core, the trusted test key and `env`.
    fn start_with_core(&self, env: &[(&str, &str)]) -> common::Supervisor {
        let keys = self.pubkeys();
        let mut all: Vec<(&str, &str)> = vec![("PLUR1BUS_TEST_EXT_PUBKEYS", keys.as_str())];
        all.extend_from_slice(env);
        common::start_with_core(&self.home, &self.events, SCALE, &all)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn config(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.home.join("config.json")).unwrap())
            .unwrap()
    }

    fn service_fake(&self) -> PathBuf {
        let dir = self.dir.path().join("svc");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

impl Drop for Home {
    /// Kills every module or core process whose pid file is still in `run/` (and whose command line names this home).
    fn drop(&mut self) {
        let Ok(entries) = std::fs::read_dir(self.home.join("run")) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".pid") || name == "supervisor.pid" {
                continue;
            }
            let pid = std::fs::read_to_string(e.path())
                .ok()
                .and_then(|s| s.split_whitespace().next()?.parse::<u32>().ok());
            if let Some(pid) = pid {
                kill_if_ours(pid, &self.home);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn kill_if_ours(pid: u32, home: &Path) {
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    if String::from_utf8_lossy(&cmdline).contains(&*home.to_string_lossy()) {
        // SAFETY: a plain signal to a process of this test's own home.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn kill_if_ours(pid: u32, home: &Path) {
    let out = Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output();
    if out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&*home.to_string_lossy())) {
        // SAFETY: a plain signal to a process of this test's own home.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
fn kill_if_ours(pid: u32, home: &Path) {
    let query = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
    let args = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &query])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
        .unwrap_or_default();
    if args.contains(&home.to_string_lossy().to_lowercase()) {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }
}

// ---- RPC ------------------------------------------------------------------------------------------------------------

/// One authenticated call on a fresh raw connection: the whole JSON-RPC reply (`result` or `error`).
fn call(home: &Path, method: &str, params: Value) -> Value {
    let home = home.to_path_buf();
    let name = method.to_string();
    let method = name.clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut conn = common::raw(&home);
        let lines = format!(
            "{}\n{}\n",
            json!({ "jsonrpc": "2.0", "id": 1, "method": "supervisor.auth", "params": { "token": common::token(&home) } }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }),
        );
        conn.write_all(lines.as_bytes()).unwrap();
        conn.flush().unwrap();
        let mut r = BufReader::new(conn);
        let mut line = String::new();
        loop {
            line.clear();
            if r.read_line(&mut line).unwrap_or(0) == 0 {
                // The connection closed without a reply (a supervisor that stopped): `null`.
                let _ = tx.send(Value::Null);
                return;
            }
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"] == 2 {
                let _ = tx.send(v);
                return;
            }
        }
    });
    rx.recv_timeout(Duration::from_secs(120))
        .unwrap_or_else(|_| panic!("no reply to {name}"))
}

/// The result of a call that must succeed.
fn ok(home: &Path, method: &str, params: Value) -> Value {
    let v = call(home, method, params);
    assert!(v.get("result").is_some(), "{method} failed: {v}");
    v["result"].clone()
}

/// `(error, reason)` of a call that must fail, and its whole error object.
fn refused(home: &Path, method: &str, params: Value) -> (String, String, Value) {
    let v = call(home, method, params);
    let e = v
        .get("error")
        .unwrap_or_else(|| panic!("{method} succeeded: {v}"));
    common::assert_valid("ErrorObject", e);
    (
        e["data"]["error"].as_str().unwrap_or("").to_string(),
        e["data"]["reason"].as_str().unwrap_or("").to_string(),
        e.clone(),
    )
}

fn status(home: &Path) -> Value {
    ok(home, "daemon.status", json!({}))
}

fn child(st: &Value, role: &str) -> Option<Value> {
    st["children"]
        .as_array()?
        .iter()
        .find(|c| c["role"] == role)
        .cloned()
}

fn state_of(c: &Value) -> (String, String) {
    (
        c["process"]["state"].as_str().unwrap_or("").to_string(),
        c["process"]["reason"].as_str().unwrap_or("").to_string(),
    )
}

/// Polls `daemon.status` until the child `role` satisfies `f`.
fn wait_for(home: &Path, role: &str, what: &str, f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let st = status(home);
        if let Some(c) = child(&st, role).filter(|c| f(c)) {
            return c;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {role} {what}; last: {st}{}",
            common::log_tails()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn is(state: &'static str, reason: &'static str) -> impl Fn(&Value) -> bool {
    move |c: &Value| {
        let (s, r) = state_of(c);
        s == state && (reason.is_empty() || r == reason)
    }
}

fn stop(s: &mut common::Supervisor, home: &Path) {
    ok(home, "daemon.stop", json!({ "budgetMs": 5000 }));
    let deadline = Instant::now() + WAIT;
    while s.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the supervisor did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ---- packages ---------------------------------------------------------------------------------------------------

fn fixture_dist() -> PathBuf {
    std::env::var_os("PLUR1BUS_FIXTURE_MODULE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/module-fixture/dist")
        })
}

fn caps() -> Value {
    json!({
        "network": { "mode": "none" },
        "filesystem": [],
        "processes": { "spawn": false },
        "harness": { "authority": "none" }
    })
}

/// A signed module package built from the fixture module: `module.json` names `name` and `version` and needs the core
/// plus `needs`.
fn module_pkg(h: &Home, name: &str, version: &str, needs: &[&str]) -> Vec<u8> {
    let src = fixture_dist();
    let mut files = Vec::new();
    for e in std::fs::read_dir(&src)
        .unwrap_or_else(|e| panic!("{}: {e} (run `pnpm build` first)", src.display()))
    {
        let e = e.unwrap();
        let file = e.file_name().to_string_lossy().into_owned();
        if !e.file_type().unwrap().is_file() || file == "module.json" {
            continue;
        }
        files.push(PayloadFile {
            rel: file,
            bytes: std::fs::read(e.path()).unwrap(),
            exec: false,
        });
    }
    let mut m: Value =
        serde_json::from_str(&std::fs::read_to_string(src.join("module.json")).unwrap()).unwrap();
    m["name"] = json!(name);
    m["version"] = json!(version);
    let mut all_needs = vec!["core"];
    all_needs.extend_from_slice(needs);
    m["needs"] = json!(all_needs);
    files.push(PayloadFile {
        rel: "module.json".into(),
        bytes: serde_json::to_vec_pretty(&m).unwrap(),
        exec: false,
    });
    let template = json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("demo/{name}"),
        "name": name,
        "version": version,
        "kind": "module",
        "title": { "en": "Demo" },
        "summary": { "en": "A demo." },
        "publisher": { "id": "demo", "name": "Demo" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0", "moduleApi": ["1"] },
        "requires": { "runtime": { "type": "node", "range": ">=24" } },
        "capabilities": caps()
    });
    build_package_from(&template, files, Some(&h.key))
}

/// `ext.inspect` of `name`'s package (written beside the home): the result.
fn inspect(h: &Home, name: &str, needs: &[&str]) -> Value {
    let p = h.write(&format!("{name}.p1x"), &module_pkg(h, name, "1.0.0", needs));
    ok(
        &h.home,
        "ext.inspect",
        json!({ "source": { "path": p.to_string_lossy() } }),
    )
}

/// Inspects and installs `name` (disabled).
fn install(h: &Home, name: &str, needs: &[&str]) -> Value {
    let insp = inspect(h, name, needs);
    ok(
        &h.home,
        "ext.install",
        json!({ "inspectionId": insp["inspectionId"] }),
    )
}

fn enable(h: &Home, name: &str) -> Value {
    ok(
        &h.home,
        "ext.enable",
        json!({ "name": name, "acknowledge": ["capabilities"] }),
    )
}

fn entries(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

// ---- tests ---------------------------------------------------------------------------------------------------------

/// Spec §6.1, Q5: an install over RPC ends installed and disabled; nothing is spawned for it.
#[test]
fn inspect_and_install_over_rpc_install_a_module_disabled_and_nothing_starts() {
    let h = Home::new();
    let mut s = h.start_with_core(&[]);
    let insp = inspect(&h, "fixture", &[]);
    common::assert_valid("ExtInspection", &insp);
    for k in ["sourcePath", "normalised", "nameTakenBy"] {
        assert!(
            insp.get(k).is_none(),
            "{k} leaked into ExtInspection: {insp}"
        );
    }
    assert_eq!(insp["manifest"]["name"], "fixture");
    // The inspection writes nothing under modules/ or extensions/.
    assert!(!h.home.join("modules/fixture").exists());
    assert!(!h.home.join("extensions").exists());

    let r = ok(
        &h.home,
        "ext.install",
        json!({ "inspectionId": insp["inspectionId"] }),
    );
    common::assert_valid("methods/ext.install/result", &r);
    assert_eq!(
        r,
        json!({ "name": "fixture", "version": "1.0.0", "kind": "module", "replaced": false, "state": "installed" })
    );
    assert!(h.home.join("modules/fixture/module.json").is_file());
    assert_eq!(h.config()["modules"]["fixture"]["enabled"], false);
    let c = wait_for(&h.home, "fixture", "held back", is("stopped", "disabled"));
    assert_eq!(c["pid"], Value::Null, "{c}");
    std::thread::sleep(Duration::from_millis(300));
    assert!(!h.home.join("run/module-fixture.pid").exists());
    let list = ok(&h.home, "ext.list", json!({}));
    common::assert_valid("methods/ext.list/result", &list);
    let item = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "fixture")
        .cloned()
        .unwrap();
    assert_eq!(item["state"], "installed", "{item}");
    let shown = ok(&h.home, "ext.show", json!({ "name": "fixture" }));
    common::assert_valid("methods/ext.show/result", &shown);
    // The inspection was consumed.
    let (e, r, _) = refused(
        &h.home,
        "ext.install",
        json!({ "inspectionId": insp["inspectionId"] }),
    );
    assert_eq!(
        (e.as_str(), r.as_str()),
        ("E_NOT_FOUND", "inspection-expired")
    );
    stop(&mut s, &h.home);
}

/// Acceptance 4: `fixture-b` needs `fixture`. Disabling `fixture` holds `fixture-b` back (`needs-unavailable`);
/// enabling `fixture` again restarts both.
#[test]
fn enable_starts_the_module_and_disable_holds_back_its_dependent() {
    let h = Home::new();
    let mut s = h.start_with_core(&[]);
    install(&h, "fixture", &[]);
    install(&h, "fixture-b", &["fixture"]);
    // The first enable needs the capability acknowledgment (X1-R13), with the disclosure in error.data.ext.
    let (e, r, err) = refused(&h.home, "ext.enable", json!({ "name": "fixture" }));
    assert_eq!(
        (e.as_str(), r.as_str()),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert_eq!(err["data"]["ext"]["authority"], "full", "{err}");
    assert_eq!(err["data"]["ext"]["capabilities"], caps(), "{err}");

    let on = enable(&h, "fixture");
    common::assert_valid("methods/ext.enable/result", &on);
    assert_eq!(on["state"], "enabled");
    let a = wait_for(&h.home, "fixture", "ready", is("ready", ""));
    enable(&h, "fixture-b");
    wait_for(&h.home, "fixture-b", "ready", is("ready", ""));

    let off = ok(&h.home, "ext.disable", json!({ "name": "fixture" }));
    common::assert_valid("methods/ext.disable/result", &off);
    assert_eq!(off["heldBack"], json!(["fixture-b"]), "{off}");
    wait_for(&h.home, "fixture", "disabled", is("stopped", "disabled"));
    wait_for(
        &h.home,
        "fixture-b",
        "held back",
        is("stopped", "needs-unavailable"),
    );
    // Its own switch is untouched: only the dependency holds it back.
    assert_ne!(h.config()["modules"]["fixture-b"]["enabled"], false);

    // Acknowledged once, so no acknowledgment now.
    ok(&h.home, "ext.enable", json!({ "name": "fixture" }));
    let a2 = wait_for(&h.home, "fixture", "ready again", is("ready", ""));
    wait_for(&h.home, "fixture-b", "ready again", is("ready", ""));
    assert_ne!(a["pid"], a2["pid"], "fixture was restarted");
    stop(&mut s, &h.home);
}

/// §6.3: a dry-run disable names the dependent it would hold back and changes nothing.
#[test]
fn dry_run_disable_names_the_dependent_before_applying() {
    let h = Home::new();
    let mut s = h.start_no_core(&[]);
    install(&h, "fixture", &[]);
    install(&h, "fixture-b", &["fixture"]);
    enable(&h, "fixture");
    enable(&h, "fixture-b");
    let before = std::fs::read(h.home.join("config.json")).unwrap();
    let plan = ok(
        &h.home,
        "ext.disable",
        json!({ "name": "fixture", "dryRun": true }),
    );
    common::assert_valid("methods/ext.disable/result", &plan);
    assert_eq!(plan["heldBack"], json!(["fixture-b"]), "{plan}");
    assert_eq!(plan["restart"]["modules"], json!(["fixture"]), "{plan}");
    assert_eq!(std::fs::read(h.home.join("config.json")).unwrap(), before);
    assert_eq!(h.config()["modules"]["fixture"]["enabled"], true);
    stop(&mut s, &h.home);
}

/// X1-R8: `ext.watch` answers the installed items and then gets `ext.changed` for install, enable and uninstall.
#[test]
fn ext_watch_receives_ext_changed_for_install_enable_uninstall() {
    let h = Home::new();
    let mut s = h.start_no_core(&[]);
    let mut conn = common::raw(&h.home);
    let lines = format!(
        "{}\n{}\n",
        json!({ "jsonrpc": "2.0", "id": 1, "method": "supervisor.auth", "params": { "token": common::token(&h.home) } }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "ext.watch", "params": {} }),
    );
    conn.write_all(lines.as_bytes()).unwrap();
    conn.flush().unwrap();
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut r = BufReader::new(conn);
        let mut line = String::new();
        loop {
            line.clear();
            match r.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if tx.send(v).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
    let auth = rx.recv_timeout(WAIT).unwrap();
    assert_eq!(auth["id"], 1, "{auth}");
    let reply = rx.recv_timeout(WAIT).unwrap();
    assert_eq!(reply["id"], 2, "{reply}");
    common::assert_valid("methods/ext.watch/result", &reply["result"]);
    assert_eq!(reply["result"]["items"], json!([]));

    install(&h, "fixture", &[]);
    enable(&h, "fixture");
    let removed = ok(&h.home, "ext.uninstall", json!({ "name": "fixture" }));
    common::assert_valid("methods/ext.uninstall/result", &removed);

    let mut seen = Vec::new();
    let deadline = Instant::now() + WAIT;
    while seen.len() < 3 && Instant::now() < deadline {
        if let Ok(v) = rx.recv_timeout(Duration::from_millis(200)) {
            assert_eq!(v["method"], "ext.changed", "{v}");
            common::assert_valid("notifications/ext.changed", &v["params"]);
            assert_eq!(v["params"]["name"], "fixture");
            seen.push(v["params"]["state"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(seen, ["installed", "enabled", "removed"]);
    // A second ext.watch on another connection lists nothing now; the first gets nothing more.
    assert_eq!(ok(&h.home, "ext.watch", json!({}))["items"], json!([]));
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    stop(&mut s, &h.home);
}

fn daemon_status_text(h: &Home) -> String {
    let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&h.home)
        .args(["daemon", "status"])
        .env("PLUR1BUS_SERVICE_FAKE", h.service_fake())
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Acceptance 7, second half: a module revoked after it was installed and enabled is held back at the next supervisor
/// start (`ext-revoked`), its dependent as `needs-unavailable`, and `daemon status` says so.
#[test]
fn a_revoked_installed_module_is_held_back_at_start() {
    let h = Home::new();
    let mut s = h.start_with_core(&[]);
    install(&h, "fixture", &[]);
    install(&h, "fixture-b", &["fixture"]);
    enable(&h, "fixture");
    enable(&h, "fixture-b");
    wait_for(&h.home, "fixture", "ready", is("ready", ""));
    wait_for(&h.home, "fixture-b", "ready", is("ready", ""));
    stop(&mut s, &h.home);
    drop(s);

    let revs = h.write(
        "revocations.json",
        json!({ "revocations": [{ "id": "demo/fixture", "versions": "*", "action": "disable", "reason": { "en": "test" } }] })
            .to_string()
            .as_bytes(),
    );
    let revs = revs.to_string_lossy().into_owned();
    let mut s = h.start_with_core(&[("PLUR1BUS_TEST_EXT_REVOCATIONS", &revs)]);
    let c = wait_for(&h.home, "fixture", "revoked", is("stopped", "ext-revoked"));
    assert_eq!(c["pid"], Value::Null);
    // Its dependent (not revoked itself) is held back behind it.
    wait_for(
        &h.home,
        "fixture-b",
        "held back",
        is("stopped", "needs-unavailable"),
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(!h.home.join("run/module-fixture.pid").exists());
    let text = daemon_status_text(&h);
    assert!(text.contains("ext-revoked"), "{text}");
    // Its switch is untouched; enabling it again is refused while it is revoked.
    assert_eq!(h.config()["modules"]["fixture"]["enabled"], true);
    let (e, r, _) = refused(
        &h.home,
        "ext.enable",
        json!({ "name": "fixture", "acknowledge": ["capabilities"] }),
    );
    assert_eq!((e.as_str(), r.as_str()), ("E_DENIED", "revoked"));
    stop(&mut s, &h.home);
}

/// X1-R17: an installed file of an enabled packaged module that no longer matches the package holds it back at the
/// next start (`ext-tampered`), and the re-hash is recorded.
#[test]
fn a_tampered_module_is_held_back_at_start() {
    let h = Home::new();
    let mut s = h.start_with_core(&[]);
    install(&h, "fixture", &[]);
    enable(&h, "fixture");
    wait_for(&h.home, "fixture", "ready", is("ready", ""));
    stop(&mut s, &h.home);
    drop(s);

    let index = h.home.join("modules/fixture/index.js");
    let mut js = std::fs::read(&index).unwrap();
    js.extend_from_slice(b"\n// changed\n");
    std::fs::write(&index, js).unwrap();
    let mut s = h.start_with_core(&[]);
    wait_for(
        &h.home,
        "fixture",
        "tampered",
        is("stopped", "ext-tampered"),
    );
    let st: Value = serde_json::from_str(
        &std::fs::read_to_string(h.home.join("extensions/state.json")).unwrap(),
    )
    .unwrap();
    let integrity = &st["items"]["fixture"]["integrity"];
    assert_eq!(integrity["ok"], false, "{st}");
    assert_eq!(integrity["paths"], json!(["index.js"]), "{st}");
    assert!(daemon_status_text(&h).contains("ext-tampered"));
    stop(&mut s, &h.home);
}

/// X1-R2, X1-C22: the supervisor never opens a package file; only the worker does, and the commit moves the spooled
/// package into the cache with a rename. The supervisor's open files are sampled for the length of an `ext.inspect`
/// and an `ext.install` (both slowed down by the worker's `--sleep-ms` seam).
#[cfg(target_os = "linux")]
#[test]
fn the_supervisor_process_never_opens_the_package() {
    let h = Home::new();
    let mut s = h.start_no_core(&[(
        "PLUR1BUS_TEST_EXT_WORKER_ARGS",
        "inspect:--sleep-ms 800;stage:--sleep-ms 800",
    )]);
    let pid = s.child.id();
    let pkg = h.write("fixture.p1x", &module_pkg(&h, "fixture", "1.0.0", &[]));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let sampler = std::thread::spawn(move || {
        let mut samples = 0u32;
        let mut seen = Vec::new();
        loop {
            if let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) {
                for fd in fds.flatten() {
                    if let Ok(target) = std::fs::read_link(fd.path()) {
                        let t = target.to_string_lossy().into_owned();
                        if t.ends_with(".p1x") || t.contains(".p1x.") {
                            seen.push(t);
                        }
                    }
                }
                samples += 1;
            }
            if done_rx.try_recv().is_ok() {
                return (samples, seen);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    let insp = ok(
        &h.home,
        "ext.inspect",
        json!({ "source": { "path": pkg.to_string_lossy() } }),
    );
    // The worker did its work: the spool is there.
    let id = insp["inspectionId"].as_str().unwrap().to_string();
    let spool = h.home.join(format!("run/inspect/{id}.p1x"));
    assert!(spool.is_file());
    let r = ok(&h.home, "ext.install", json!({ "inspectionId": id }));
    done_tx.send(()).unwrap();
    let (samples, seen) = sampler.join().unwrap();
    assert_eq!(r["state"], "installed");
    assert!(samples > 100, "only {samples} samples");
    assert!(seen.is_empty(), "the supervisor opened {seen:?}");
    // The spool moved into the cache.
    assert!(!spool.exists());
    let sha = insp["sha256"].as_str().unwrap();
    assert!(h.home.join(format!("extensions/cache/{sha}.p1x")).is_file());
    stop(&mut s, &h.home);
}

/// X1-R2: a worker that crashes fails the call with `worker-failed`, leaves no staging and no inspection behind
/// (carry: a killed stage leaves nothing half-written), and the supervisor keeps serving.
#[test]
fn a_worker_failure_is_worker_failed_and_the_supervisor_keeps_serving() {
    let h = Home::new();
    // A crash while staging: the worker aborts after the extraction, with the staging directory half-checked.
    let mut s = h.start_no_core(&[("PLUR1BUS_TEST_EXT_WORKER_ARGS", "stage:--crash")]);
    let insp = inspect(&h, "fixture", &[]);
    let id = insp["inspectionId"].as_str().unwrap().to_string();
    let config_before = std::fs::read(h.home.join("config.json")).ok();
    let (e, r, _) = refused(&h.home, "ext.install", json!({ "inspectionId": id }));
    assert_eq!((e.as_str(), r.as_str()), ("E_INTERNAL", "worker-failed"));
    assert!(
        !h.home.join("extensions").exists(),
        "{:?}",
        entries(&h.home.join("extensions"))
    );
    assert!(
        !entries(&h.home.join("run/inspect"))
            .iter()
            .any(|n| n.starts_with(&id)),
        "{:?}",
        entries(&h.home.join("run/inspect"))
    );
    assert!(!h.home.join("modules/fixture").exists());
    assert_eq!(
        std::fs::read(h.home.join("config.json")).ok(),
        config_before
    );
    // Still serving, and the lock is free again.
    status(&h.home);
    assert_eq!(ok(&h.home, "ext.list", json!({}))["items"], json!([]));
    stop(&mut s, &h.home);
    drop(s);

    // A crash while inspecting: its spool goes too.
    let mut s = h.start_no_core(&[("PLUR1BUS_TEST_EXT_WORKER_ARGS", "inspect:--crash")]);
    let pkg = h.write("fixture.p1x", &module_pkg(&h, "fixture", "1.0.0", &[]));
    let (e, r, _) = refused(
        &h.home,
        "ext.inspect",
        json!({ "source": { "path": pkg.to_string_lossy() } }),
    );
    assert_eq!((e.as_str(), r.as_str()), ("E_INTERNAL", "worker-failed"));
    assert_eq!(entries(&h.home.join("run/inspect")), Vec::<String>::new());
    status(&h.home);
    stop(&mut s, &h.home);
}

/// X1-R15: while an install runs (its stage slowed down by the worker's `--sleep-ms` seam), an enable is
/// `E_CONFLICT busy` and changes nothing; the install then finishes.
#[test]
fn concurrent_install_and_enable_is_busy() {
    let h = Home::new();
    let mut s = h.start_no_core(&[("PLUR1BUS_TEST_EXT_WORKER_ARGS", "stage:--sleep-ms 2500")]);
    install(&h, "fixture", &[]);
    let insp = inspect(&h, "fixture-b", &[]);
    let home = h.home.clone();
    let id = insp["inspectionId"].clone();
    let installing =
        std::thread::spawn(move || call(&home, "ext.install", json!({ "inspectionId": id })));
    common::wait_until("the stage worker runs", WAIT, || {
        workers_of(&h.home).len() == 1
    });
    let config_before = std::fs::read(h.home.join("config.json")).unwrap();
    let (e, r, _) = refused(
        &h.home,
        "ext.enable",
        json!({ "name": "fixture", "acknowledge": ["capabilities"] }),
    );
    assert_eq!((e.as_str(), r.as_str()), ("E_CONFLICT", "busy"));
    let done = installing.join().unwrap();
    assert_eq!(done["result"]["state"], "installed", "{done}");
    let after: Value =
        serde_json::from_slice(&std::fs::read(h.home.join("config.json")).unwrap()).unwrap();
    let before: Value = serde_json::from_slice(&config_before).unwrap();
    assert_eq!(after["modules"]["fixture"], before["modules"]["fixture"]);
    assert_eq!(after["modules"]["fixture"]["enabled"], false);
    stop(&mut s, &h.home);
}

/// §6.4: an uninstall over RPC stops the module and moves it into the trash; a restore brings it back disabled.
#[test]
fn uninstall_over_rpc_moves_the_module_into_the_trash_and_restore_brings_it_back_disabled() {
    let h = Home::new();
    let mut s = h.start_with_core(&[]);
    install(&h, "fixture", &[]);
    enable(&h, "fixture");
    let c = wait_for(&h.home, "fixture", "ready", is("ready", ""));
    assert!(c["pid"].is_u64());

    let r = ok(&h.home, "ext.uninstall", json!({ "name": "fixture" }));
    common::assert_valid("methods/ext.uninstall/result", &r);
    let tid = r["trashId"].as_str().unwrap().to_string();
    assert!(!h.home.join("modules/fixture").exists());
    assert!(h
        .home
        .join("extensions/trash")
        .join(&tid)
        .join("code/module.json")
        .is_file());
    // Its slot goes with it.
    common::wait_until("fixture's slot removed", WAIT, || {
        child(&status(&h.home), "fixture").is_none()
    });
    assert!(!h.home.join("run/module-fixture.pid").exists());

    let back = ok(&h.home, "ext.restore", json!({ "trashId": tid }));
    common::assert_valid("methods/ext.restore/result", &back);
    assert_eq!(
        back,
        json!({ "name": "fixture", "version": "1.0.0", "state": "installed" })
    );
    assert!(h.home.join("modules/fixture/module.json").is_file());
    assert_eq!(h.config()["modules"]["fixture"]["enabled"], false);
    wait_for(&h.home, "fixture", "held back", is("stopped", "disabled"));
    stop(&mut s, &h.home);
}

/// Carry (X1-T7): under the supervisor a rollback goes through `set_config`, where a `null` removes the key: a fresh
/// install that fails after its config step leaves no `modules.<name>` behind.
#[test]
fn a_failed_fresh_install_under_the_supervisor_leaves_no_modules_key() {
    let h = Home::new();
    let mut s = h.start_no_core(&[("PLUR1BUS_TEST_EXT_FAIL_AT", "code")]);
    let insp = inspect(&h, "fixture", &[]);
    let (e, r, _) = refused(
        &h.home,
        "ext.install",
        json!({ "inspectionId": insp["inspectionId"] }),
    );
    assert_eq!((e.as_str(), r.as_str()), ("E_INTERNAL", "io"));
    let cfg = h.config();
    assert!(
        cfg["modules"].get("fixture").is_none(),
        "modules.fixture was left behind: {cfg}"
    );
    assert!(!h.home.join("modules/fixture").exists());
    assert_eq!(ok(&h.home, "ext.list", json!({}))["items"], json!([]));
    stop(&mut s, &h.home);
}

/// X1-R2: a worker that overruns its deadline (shortened by a test seam; the stage sleeps longer) is killed: the call
/// is `worker-failed`, nothing staged or inspected is left, and the supervisor keeps serving.
#[test]
fn a_worker_past_its_deadline_is_killed_and_leaves_nothing() {
    let h = Home::new();
    let mut s = h.start_no_core(&[
        ("PLUR1BUS_TEST_EXT_WORKER_ARGS", "stage:--sleep-ms 20000"),
        ("PLUR1BUS_TEST_EXT_WORKER_DEADLINE_MS", "stage:700"),
    ]);
    let insp = inspect(&h, "fixture", &[]);
    let id = insp["inspectionId"].as_str().unwrap().to_string();
    let started = Instant::now();
    let (e, r, _) = refused(&h.home, "ext.install", json!({ "inspectionId": id }));
    assert_eq!((e.as_str(), r.as_str()), ("E_INTERNAL", "worker-failed"));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert!(!h.home.join("extensions").exists());
    assert!(!entries(&h.home.join("run/inspect"))
        .iter()
        .any(|n| n.starts_with(&id)));
    #[cfg(target_os = "linux")]
    assert!(workers_of(&h.home).is_empty(), "{:?}", workers_of(&h.home));
    assert_eq!(ok(&h.home, "ext.list", json!({}))["items"], json!([]));
    stop(&mut s, &h.home);
}

/// The pids of `ext __worker` processes of this home.
#[cfg(target_os = "linux")]
fn workers_of(home: &Path) -> Vec<u32> {
    let home = home.to_string_lossy().into_owned();
    std::fs::read_dir("/proc")
        .unwrap()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().parse::<u32>().ok())
        .filter(|pid| {
            let cmd = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
            let cmd = String::from_utf8_lossy(&cmd);
            cmd.contains("__worker") && cmd.contains(&home)
        })
        .collect()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn workers_of(home: &Path) -> Vec<u32> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
        .unwrap();
    assert!(out.status.success());
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| line.contains("__worker") && line.contains(&*home.to_string_lossy()))
        .filter_map(|line| line.split_whitespace().next()?.parse().ok())
        .collect()
}

#[cfg(windows)]
fn workers_of(home: &Path) -> Vec<u32> {
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='plur1bus.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('__worker') -and $_.CommandLine.ToLowerInvariant().Contains($env:PLUR1BUS_WORKER_HOME.ToLowerInvariant()) } | ForEach-Object { $_.ProcessId }",
        ])
        .env("PLUR1BUS_WORKER_HOME", home)
        .output()
        .unwrap();
    assert!(out.status.success());
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

/// Finding 9: `daemon.stop` during an install kills the running stage worker and waits for it; the supervisor exits
/// promptly and no worker is left writing into staging.
#[test]
fn daemon_stop_kills_a_running_worker() {
    let h = Home::new();
    let mut s = h.start_no_core(&[("PLUR1BUS_TEST_EXT_WORKER_ARGS", "stage:--sleep-ms 30000")]);
    let insp = inspect(&h, "fixture", &[]);
    let home = h.home.clone();
    let id = insp["inspectionId"].clone();
    let installing =
        std::thread::spawn(move || call(&home, "ext.install", json!({ "inspectionId": id })));
    common::wait_until("the stage worker runs", WAIT, || {
        workers_of(&h.home).len() == 1
    });
    let started = Instant::now();
    stop(&mut s, &h.home);
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "{:?}",
        started.elapsed()
    );
    #[cfg(target_os = "linux")]
    assert!(workers_of(&h.home).is_empty(), "{:?}", workers_of(&h.home));
    // The install answers worker-failed, unless the supervisor exited before the answer went out.
    let reply = installing.join().unwrap();
    assert!(
        reply.is_null() || reply["error"]["data"]["reason"] == "worker-failed",
        "{reply}"
    );
    assert!(!h.home.join("modules/fixture").exists());
}

/// X1-R17: the overlays are refreshed after every mutation. A revocation that appears while the supervisor runs holds
/// the running module back at the next mutation (here: installing another module); once it is lifted, the next
/// mutation releases and starts it again.
#[test]
fn overlays_are_refreshed_after_a_mutation() {
    let h = Home::new();
    let revs = h.write("revocations.json", b"{\"revocations\": []}");
    let revs_path = revs.to_string_lossy().into_owned();
    let mut s = h.start_with_core(&[("PLUR1BUS_TEST_EXT_REVOCATIONS", &revs_path)]);
    install(&h, "fixture", &[]);
    enable(&h, "fixture");
    wait_for(&h.home, "fixture", "ready", is("ready", ""));

    std::fs::write(
        &revs,
        json!({ "revocations": [{ "id": "demo/fixture", "versions": "*", "action": "disable" }] })
            .to_string(),
    )
    .unwrap();
    install(&h, "fixture-c", &[]);
    wait_for(&h.home, "fixture", "revoked", is("stopped", "ext-revoked"));

    std::fs::write(&revs, b"{\"revocations\": []}").unwrap();
    ok(&h.home, "ext.uninstall", json!({ "name": "fixture-c" }));
    wait_for(&h.home, "fixture", "released", is("ready", ""));
    stop(&mut s, &h.home);
}

/// X1-C23: when `extensions/state.json` cannot be read at start, the check fails closed: every module a cached
/// package names is held back as `ext-tampered`, and the log says why.
#[test]
fn an_unreadable_state_file_holds_packaged_modules_back_at_start() {
    let h = Home::new();
    let mut s = h.start_with_core(&[]);
    install(&h, "fixture", &[]);
    enable(&h, "fixture");
    wait_for(&h.home, "fixture", "ready", is("ready", ""));
    stop(&mut s, &h.home);
    drop(s);

    std::fs::write(h.home.join("extensions/state.json"), b"{ not json").unwrap();
    let mut s = h.start_with_core(&[]);
    wait_for(
        &h.home,
        "fixture",
        "held back",
        is("stopped", "ext-tampered"),
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(!h.home.join("run/module-fixture.pid").exists());
    let log = std::fs::read_to_string(h.home.join("logs/supervisor.log")).unwrap();
    assert!(log.contains("state.json is unreadable"), "{log}");
    stop(&mut s, &h.home);
}

/// Finding 5: `source.path` must be absolute (it would resolve against the supervisor's working directory).
#[test]
fn a_relative_inspect_path_is_invalid_params() {
    let h = Home::new();
    let mut s = h.start_no_core(&[]);
    let (e, _, err) = refused(
        &h.home,
        "ext.inspect",
        json!({ "source": { "path": "fixture.p1x" } }),
    );
    assert_eq!(e, "E_INVALID_PARAMS", "{err}");
    assert_eq!(entries(&h.home.join("run/inspect")), Vec::<String>::new());
    stop(&mut s, &h.home);
}

/// X1-C29: with `extensions/state.json` unreadable, `ext.show`, `ext.list` and `ext.watch` answer `E_STORAGE
/// state-invalid` (never `extension-unknown`, never the packaged module listed as a local one).
#[test]
fn an_unreadable_state_json_is_state_invalid_over_rpc() {
    let h = Home::new();
    let mut s = h.start_no_core(&[]);
    install(&h, "fixture", &[]);
    std::fs::write(h.home.join("extensions/state.json"), b"{ broken").unwrap();
    for (method, params) in [
        ("ext.show", json!({ "name": "fixture" })),
        ("ext.list", json!({})),
        ("ext.watch", json!({})),
        ("ext.uninstall", json!({ "name": "fixture" })),
    ] {
        let (e, r, _) = refused(&h.home, method, params);
        assert_eq!(
            (e.as_str(), r.as_str()),
            ("E_STORAGE", "state-invalid"),
            "{method}"
        );
    }
    stop(&mut s, &h.home);
}

/// A `daemon.stop` while an install is committing waits for it (bounded), still running the module ops it queues: the
/// install ends complete (code, record, config disabled), never as code without its record.
#[test]
fn a_stop_during_a_commit_waits_for_it() {
    for point in ["config", "code"] {
        let h = Home::new();
        let seam = format!("sleep:{point}:2000");
        let mut s = h.start_no_core(&[("PLUR1BUS_TEST_EXT_FAIL_AT", seam.as_str())]);
        let insp = inspect(&h, "fixture", &[]);
        let home = h.home.clone();
        let id = insp["inspectionId"].clone();
        let installing =
            std::thread::spawn(move || call(&home, "ext.install", json!({ "inspectionId": id })));
        // The commit is in its pause once its step is done: the config section written, then the module in place.
        let paused = || {
            let cfg: Value = std::fs::read(h.home.join("config.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            cfg["modules"]["fixture"]["enabled"] == false
                && (point == "config" || h.home.join("modules/fixture").is_dir())
        };
        common::wait_until("the commit's pause", WAIT, paused);
        stop(&mut s, &h.home);
        let reply = installing.join().unwrap();
        let st: Value = serde_json::from_slice(
            &std::fs::read(h.home.join("extensions/state.json")).unwrap_or_default(),
        )
        .unwrap_or(Value::Null);
        let recorded = st["items"]["fixture"].is_object();
        let code = h.home.join("modules/fixture").is_dir();
        assert!(
            recorded && code,
            "sleep:{point}: record {recorded}, code {code}; install answered {reply}; log: {}",
            std::fs::read_to_string(h.home.join("logs/supervisor.log")).unwrap_or_default()
        );
        assert_eq!(h.config()["modules"]["fixture"]["enabled"], false);
    }
}
