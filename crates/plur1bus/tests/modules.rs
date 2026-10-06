//! The supervisor runs modules (spec §6.4, D14, criterion 5, G3): every module installed under `<home>/modules/` is
//! started after the core in dependency order, health-polled through `module.status`, backed off and given up on its
//! own (never touching the core), adopted by a restarted supervisor, reported in `daemon.status` (`kind: "module"`),
//! `module.watch`/`module.state` and `1staid check modules.state`, and stopped before the core. The core is
//! `tests/fixtures/fake-core.mjs`; the module is the built fixture (`PLUR1BUS_FIXTURE_MODULE`, default
//! `packages/module-fixture/dist`, built by `pnpm build`). Durations are scaled by 0.02 unless a test says otherwise.
mod common;

use common::{assert_valid, client, start_with_core, wait_until, Supervisor};
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(20);
const SCALE: &str = "0.02";

/// The built fixture module's directory.
fn fixture_dist() -> PathBuf {
    std::env::var_os("PLUR1BUS_FIXTURE_MODULE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/module-fixture/dist")
        })
}

/// A temp home plus the fake core's events file. On drop, every module or core process whose pid file is still in
/// `run/` (and whose command line names this home) is killed, so no test leaves one behind.
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
        Home {
            _dir: dir,
            home,
            events,
        }
    }

    /// Copies the fixture into `modules/<dir>` with `manifest` merged over its module.json.
    fn install(&self, dir: &str, manifest: Value) -> PathBuf {
        let src = fixture_dist();
        let dst = self.home.join("modules").join(dir);
        std::fs::create_dir_all(&dst).unwrap();
        for entry in std::fs::read_dir(&src)
            .unwrap_or_else(|e| panic!("{}: {e} (run `pnpm build` first)", src.display()))
        {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                std::fs::copy(entry.path(), dst.join(entry.file_name())).unwrap();
            }
        }
        let mut m: Value =
            serde_json::from_str(&std::fs::read_to_string(src.join("module.json")).unwrap())
                .unwrap();
        for (k, v) in manifest.as_object().unwrap() {
            m[k] = v.clone();
        }
        std::fs::write(
            dst.join("module.json"),
            serde_json::to_string_pretty(&m).unwrap(),
        )
        .unwrap();
        dst
    }

    /// config.json: `supervisor.graceMs = grace_ms` and `modules`.
    fn config(&self, grace_ms: u64, modules: Value) {
        let v = json!({ "schemaVersion": 1, "supervisor": { "graceMs": grace_ms }, "modules": modules });
        std::fs::write(
            self.home.join("config.json"),
            serde_json::to_string_pretty(&v).unwrap(),
        )
        .unwrap();
    }

    fn start(&self, env: &[(&str, &str)]) -> Supervisor {
        self.start_scaled(SCALE, env)
    }

    fn start_scaled(&self, scale: &str, env: &[(&str, &str)]) -> Supervisor {
        start_with_core(&self.home, &self.events, scale, env)
    }

    /// The fake service manager's directory (`PLUR1BUS_SERVICE_FAKE`): no test here touches a real one.
    fn service_fake(&self) -> PathBuf {
        let dir = self._dir.path().join("svc");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("logs/supervisor.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// The index of the first supervisor.log record whose `msg` is `msg` and that satisfies `f`.
    fn log_index(&self, msg: &str, f: impl Fn(&Value) -> bool) -> Option<usize> {
        self.log().iter().position(|r| r["msg"] == msg && f(r))
    }

    fn events(&self, name: &str) -> Vec<Value> {
        common::fake_core_events(&self.events, name)
    }

    fn check(&self) -> (Output, Value) {
        let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
            .arg("--json")
            .arg("--home")
            .arg(&self.home)
            .args(["1staid", "check"])
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", self.service_fake())
            .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let v: Value =
            serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{e}: {out:?}"));
        (out, v)
    }
}

impl Drop for Home {
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

/// Kills `pid` when its command line names `home` (a recycled pid is left alone).
#[cfg(target_os = "linux")]
fn kill_if_ours(pid: u32, home: &Path) {
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    if String::from_utf8_lossy(&cmdline).contains(&*home.to_string_lossy()) {
        kill(pid);
    }
}
#[cfg(all(unix, not(target_os = "linux")))]
fn kill_if_ours(pid: u32, home: &Path) {
    let args = Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    if args.contains(&*home.to_string_lossy()) {
        kill(pid);
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
        kill(pid);
    }
}

/// SIGKILL / TerminateProcess.
fn kill(pid: u32) {
    #[cfg(unix)]
    // SAFETY: a plain signal to a test process named by its own pid file.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }
}

/// `daemon.status` (validated against the schema).
fn status(c: &mut Client) -> Value {
    let st = c.call("daemon.status", json!({})).unwrap();
    assert_valid("methods/daemon.status/result", &st);
    st
}

fn child<'a>(st: &'a Value, role: &str) -> Option<&'a Value> {
    st["children"]
        .as_array()?
        .iter()
        .find(|c| c["role"] == role)
}

fn state(c: &Value) -> &str {
    c["process"]["state"].as_str().unwrap_or("")
}

/// Polls `daemon.status` until the child `role` satisfies `f`; returns the whole status.
fn wait_for(c: &mut Client, role: &str, what: &str, f: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    loop {
        let st = status(c);
        if child(&st, role).is_some_and(&f) {
            return st;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {role} {what}; last: {st}{}",
            common::log_tails()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The human `daemon status` text (fake service manager).
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

fn stop(s: &mut Supervisor, c: &mut Client, budget_ms: u64) {
    c.call("daemon.stop", json!({ "budgetMs": budget_ms }))
        .unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(st) = s.child.try_wait().unwrap() {
            assert_eq!(st.code(), Some(0));
            return;
        }
        assert!(Instant::now() < deadline, "the supervisor did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn an_installed_module_is_spawned_after_the_core_and_becomes_ready() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.config(1000, json!({}));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let roles: Vec<&str> = st["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["core", "fixture"], "{st}");
    let core = child(&st, "core").unwrap();
    let fixture = child(&st, "fixture").unwrap();
    assert_eq!(core["kind"], "core");
    assert_eq!(fixture["kind"], "module");
    assert_eq!(fixture["adopted"], false);
    assert_eq!(fixture["restarts"], 0, "{st}{}", common::log_tails());
    let pid = fixture["pid"].as_u64().unwrap();
    // Its own run files, as the module runtime writes them.
    let recorded = std::fs::read_to_string(h.home.join("run/module-fixture.pid")).unwrap();
    assert_eq!(recorded.split_whitespace().next(), Some(&*pid.to_string()));
    assert_eq!(
        recorded.split_whitespace().nth(1),
        fixture["instanceId"].as_str()
    );
    // Its captured output goes beside the log the module writes itself.
    assert!(h.home.join("logs/module-fixture.out.log").exists());
    assert!(!h.home.join("logs/fixture.out.log").exists());
    // After the core.
    let core_spawned = h.log_index("core spawned", |_| true).unwrap();
    let fixture_spawned = h
        .log_index("fixture spawned", |r| r["pid"].as_u64() == Some(pid))
        .unwrap();
    assert!(core_spawned < fixture_spawned, "{:?}", h.log());
    // `daemon status` prints one line per child with its kind (the fake core reports ready once its run files are
    // secured, which on Windows can outlast the module's start).
    wait_for(&mut c, "core", "ready", |m| state(m) == "ready");
    let text = daemon_status_text(&h);
    assert!(text.contains("core (core): ready"), "{text}");
    assert!(text.contains("fixture (module): ready"), "{text}");
    stop(&mut s, &mut c, 5000);
}

/// Scale 0.2: the backoff delays (200, 400, 800 ms …) are long enough to be sampled between two polls.
#[test]
fn a_crashing_module_backs_off_and_the_core_is_untouched() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.config(1000, json!({ "fixture": { "crashAfterMs": 200 } }));
    let mut s = h.start_scaled("0.2", &[]);
    let mut c = client(&h.home);
    // Sample from the first status on, not from the core's ready: a module no longer securing its run files with
    // `icacls` (Windows, HB5) can crash for the first time before the core, still securing its own, reports ready,
    // and waiting for the core would miss that first backoff.
    let mut core_pid: Option<Value> = None;
    // (lastExit.at, nextRestartAt - lastExit.at) of every crash seen with a restart scheduled.
    let mut delays: Vec<(u64, u64)> = Vec::new();
    let deadline = Instant::now() + WAIT;
    let last = loop {
        let st = status(&mut c);
        // Right after start the supervisor may not list its children yet.
        let (Some(core), Some(m)) = (child(&st, "core"), child(&st, "fixture")) else {
            assert!(Instant::now() < deadline, "children never listed: {st}");
            std::thread::sleep(Duration::from_millis(20));
            continue;
        };
        let m = m.clone();
        match &core_pid {
            // Once ready, the core stays the same, ready process whatever the module does.
            Some(pid) => {
                assert_eq!(&core["pid"], pid, "the core was touched: {st}");
                assert_eq!(state(core), "ready", "{st}");
            }
            None if state(core) == "ready" => core_pid = Some(core["pid"].clone()),
            None => {}
        }
        if let (Some(next), Some(at)) = (m["nextRestartAt"].as_u64(), m["lastExit"]["at"].as_u64())
        {
            assert_eq!(state(&m), "crashed", "{m}");
            assert_eq!(m["lastExit"]["code"], 1, "{m}");
            if delays.last().map(|d| d.0) != Some(at) {
                delays.push((at, next - at));
            }
        }
        if delays.len() >= 3 && m["restarts"].as_u64() >= Some(2) && core_pid.is_some() {
            break m;
        }
        assert!(Instant::now() < deadline, "{delays:?}; last {m}");
        std::thread::sleep(Duration::from_millis(20));
    };
    for w in delays.windows(2) {
        assert!(w[1].1 > w[0].1, "delays must grow: {delays:?}");
    }
    assert!(last["restarts"].as_u64().unwrap() >= 2, "{last}");
    let core = child(&status(&mut c), "core").unwrap().clone();
    assert_eq!(core["restarts"], 0);
    assert_eq!(h.events("started").len(), 1, "one core only");
    stop(&mut s, &mut c, 5000);
}

/// Review Focus 3: a module that dies at start (its entry is `process.exit(1)`) backs off, gives up after five exits
/// in the window, shows `crashed` in `daemon status` and fails `1staid check modules.state`; the core never notices.
#[test]
fn a_module_that_crashes_at_start_gives_up_after_five_and_the_core_is_untouched() {
    let h = Home::new();
    let dir = h.install("fixture", json!({}));
    std::fs::write(dir.join("index.js"), "process.exit(1);\n").unwrap();
    h.config(1000, json!({}));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "given up", |m| {
        state(m) == "crashed" && m["nextRestartAt"].is_null() && m["restarts"] == 4
    });
    let m = child(&st, "fixture").unwrap();
    assert_eq!(m["lastExit"]["code"], 1, "{m}");
    // H3B-R26: the state says why it stays down; the last exit keeps its own (no specific) reason.
    assert_eq!(m["process"]["reason"], "gave-up", "{m}");
    assert_eq!(m["lastExit"]["reason"], Value::Null, "{m}");
    assert_eq!(m["pid"], Value::Null);
    // The module gives up within a few scaled backoffs, which can be before the fake core has secured its run files
    // and reports ready (icacls on Windows): wait for that before reading the text.
    let st_ready = wait_for(&mut c, "core", "ready", |m| state(m) == "ready");
    let text = daemon_status_text(&h);
    assert!(
        text.contains("fixture (module): crashed: gave-up"),
        "{text}"
    );
    assert!(text.contains("core (core): ready"), "{text}");
    // M5: `module list` (through the supervisor) shows the same state and reason.
    let list = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .args(["--json", "--home"])
        .arg(&h.home)
        .args(["module", "list"])
        .env("PLUR1BUS_SERVICE_FAKE", h.service_fake())
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(list.status.code(), Some(0), "{list:?}");
    let list: Value = serde_json::from_slice(&list.stdout).unwrap();
    let listed = list["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "fixture")
        .unwrap_or_else(|| panic!("{list}"));
    assert_eq!(listed["child"]["process"]["state"], "crashed", "{list}");
    assert_eq!(listed["child"]["process"]["reason"], "gave-up", "{list}");
    // `st` was read when the module gave up, possibly before the core was ready; use the later snapshot.
    let core = child(&st_ready, "core").unwrap().clone();
    assert_eq!(state(&core), "ready", "{st_ready}");
    assert_eq!(core["restarts"], 0);
    // No sixth attempt.
    std::thread::sleep(Duration::from_millis(500));
    let st = status(&mut c);
    assert_eq!(child(&st, "fixture").unwrap()["restarts"], 4, "{st}");
    let spawned = h
        .log()
        .iter()
        .filter(|r| r["msg"] == "fixture spawned")
        .count();
    assert_eq!(spawned, 5);
    let (out, v) = h.check();
    assert_eq!(out.status.code(), Some(1), "{v}");
    let check = v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "modules.state")
        .unwrap_or_else(|| panic!("no modules.state in {v}"))
        .clone();
    assert_eq!(check["status"], "fail", "{check}");
    assert!(
        check["summary"].as_str().unwrap().contains("fixture"),
        "{check}"
    );
    let detail = &check["detail"]["modules"];
    let fixture = detail
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == "fixture")
        .unwrap_or_else(|| panic!("{check}"));
    assert_eq!(fixture["state"], "crashed", "{check}");
    assert_eq!(fixture["restarts"], 4, "{check}");
    assert_eq!(fixture["lastExit"]["code"], 1, "{check}");
    assert_eq!(child(&status(&mut c), "core").unwrap()["pid"], core["pid"]);
    stop(&mut s, &mut c, 5000);
}

#[test]
fn a_supervisor_restart_within_grace_adopts_the_module() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.config(20_000, json!({}));
    let long = [("FAKE_CORE_GRACE_MS", "20000")];
    let mut s1 = h.start(&long);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let first = child(&st, "fixture").unwrap().clone();
    // The supervisor dies without a stop: the module loses its stdin lifeline and is orphaned.
    s1.child.kill().unwrap();
    s1.child.wait().unwrap();

    let mut s2 = h.start(&long);
    // A killed supervisor leaves its token behind: wait until the new one has written its own pid file.
    let new_pid = s2.child.id().to_string();
    wait_until("the new supervisor's pid file", WAIT, || {
        std::fs::read_to_string(h.home.join("run/supervisor.pid"))
            .is_ok_and(|p| p.split_whitespace().next() == Some(new_pid.as_str()))
    });
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "adopted and ready", |m| {
        state(m) == "ready" && m["adopted"] == true
    });
    let m = child(&st, "fixture").unwrap();
    assert_eq!(m["pid"], first["pid"], "{st}");
    assert_eq!(m["instanceId"], first["instanceId"], "{st}");
    let probes: Vec<Value> = h
        .log()
        .into_iter()
        .filter(|r| r["msg"] == "fixture probe")
        .map(|r| r["result"].clone())
        .collect();
    assert_eq!(probes, [json!("absent"), json!("serving")]);
    stop(&mut s2, &mut c, 5000);
    // The adopted module was stopped with the supervisor: its run files are gone.
    assert!(!h.home.join("run/module-fixture.pid").exists());
}

#[test]
fn invalid_disabled_and_agent_scoped_modules_are_listed_not_spawned() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.install("broken", json!({ "name": "broken", "priority": 1000 }));
    h.install(
        "agent-mod",
        json!({ "name": "agent-mod", "scope": "agent" }),
    );
    h.install(
        "needy",
        json!({ "name": "needy", "needs": ["core", "missing"] }),
    );
    // H3B-R25: a dependent of a module that is not started stays stopped, transitively.
    h.install(
        "needs-disabled",
        json!({ "name": "needs-disabled", "needs": ["core", "fixture"] }),
    );
    h.install(
        "needs-agent",
        json!({ "name": "needs-agent", "needs": ["agent-mod"] }),
    );
    h.install(
        "needs-needs",
        json!({ "name": "needs-needs", "needs": ["needs-disabled"] }),
    );
    h.config(1000, json!({ "fixture": { "enabled": false } }));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    wait_for(&mut c, "core", "ready", |c| state(c) == "ready");
    // Modules start after the core, and a manifest-invalid one is only recorded when its turn comes, so "core ready"
    // does not yet mean every module is listed in its final state. Wait for each one's reason instead of snapshotting
    // at core-ready (which raced under load: `broken` was not listed yet).
    for name in [
        "fixture",
        "agent-mod",
        "broken",
        "needy",
        "needs-disabled",
        "needs-agent",
        "needs-needs",
    ] {
        wait_for(&mut c, name, "its final state", |m| {
            m["process"]["reason"].is_string()
        });
    }
    let st = status(&mut c);
    std::thread::sleep(Duration::from_millis(300));
    let st2 = status(&mut c);
    for st in [&st, &st2] {
        let expect = [
            ("fixture", "stopped", "disabled"),
            ("agent-mod", "stopped", "scope-agent-unsupported"),
            ("broken", "crashed", "manifest-invalid"),
            ("needy", "crashed", "manifest-invalid"),
            ("needs-disabled", "stopped", "needs-unavailable"),
            ("needs-agent", "stopped", "needs-unavailable"),
            ("needs-needs", "stopped", "needs-unavailable"),
        ];
        for (name, s, reason) in expect {
            let m = child(st, name).unwrap_or_else(|| panic!("{name} missing: {st}"));
            assert_eq!(state(m), s, "{name}: {m}");
            assert_eq!(m["process"]["reason"], reason, "{name}: {m}");
            assert_eq!(m["pid"], Value::Null, "{name}: {m}");
            assert_eq!(m["nextRestartAt"], Value::Null, "{name}: {m}");
            assert_eq!(m["kind"], "module");
        }
    }
    assert!(!h.log().iter().any(|r| r["msg"]
        .as_str()
        .is_some_and(|m| m.ends_with(" spawned") && !m.starts_with("core"))));
    let transitive = h
        .log()
        .into_iter()
        .find(|r| r["msg"] == "module not started" && r["module"] == "needs-needs")
        .unwrap();
    assert!(
        transitive["errors"].to_string().contains("needs-disabled"),
        "{transitive}"
    );
    for name in [
        "fixture",
        "broken",
        "agent-mod",
        "needy",
        "needs-disabled",
        "needs-agent",
        "needs-needs",
    ] {
        assert!(!h.home.join(format!("run/module-{name}.pid")).exists());
    }
    // The reasons behind manifest-invalid are logged (ChildStatus has no detail).
    let broken = h
        .log()
        .into_iter()
        .find(|r| r["msg"] == "module not started" && r["module"] == "broken")
        .unwrap();
    assert!(
        broken["errors"].to_string().contains("priority"),
        "{broken}"
    );
    let needy = h
        .log()
        .into_iter()
        .find(|r| r["msg"] == "module not started" && r["module"] == "needy")
        .unwrap();
    assert!(needy["errors"].to_string().contains("missing"), "{needy}");
    let (out, v) = h.check();
    assert_eq!(out.status.code(), Some(1), "{v}");
    let check = v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "modules.state")
        .unwrap()
        .clone();
    assert_eq!(check["status"], "fail", "{check}");
    let text = check["detail"].to_string();
    assert!(text.contains("priority"), "the manifest errors: {check}");
    stop(&mut s, &mut c, 5000);
}

#[test]
fn module_api_versions_run_side_by_side() {
    let h = Home::new();
    h.install("fixture", json!({ "apiVersion": "2" }));
    h.install(
        "fixture-b",
        json!({ "name": "fixture-b", "apiVersion": "1" }),
    );
    h.install(
        "fixture-c",
        json!({ "name": "fixture-c", "apiVersion": "3" }),
    );
    h.config(1000, json!({}));
    let mut s = h.start(&[("PLUR1BUS_MODULE_API_CURRENT", "2")]);
    let mut c = client(&h.home);
    wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let st = wait_for(&mut c, "fixture-b", "ready", |m| state(m) == "ready");
    let m = child(&st, "fixture-c").unwrap();
    assert_eq!(state(m), "crashed", "{st}");
    assert_eq!(m["process"]["reason"], "api-version-unsupported", "{st}");
    assert_eq!(m["pid"], Value::Null);
    assert_eq!(m["nextRestartAt"], Value::Null);
    assert!(!h.home.join("run/module-fixture-c.pid").exists());
    stop(&mut s, &mut c, 5000);
}

/// A process on the module's address whose `module.auth` hello names another module (B12) is foreign: it is
/// terminated, and the installed module is spawned in its place.
#[cfg(unix)]
#[test]
fn a_module_reporting_another_name_is_terminated_as_foreign() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.config(1000, json!({}));
    let run = h.home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    let script = h._dir.path().join("impostor.mjs");
    std::fs::write(&script, IMPOSTOR).unwrap();
    let mut impostor = Command::new("node")
        .arg(&script)
        .arg(&run)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    wait_until("the impostor's pid file", WAIT, || {
        run.join("module-fixture.pid").exists()
    });
    // Time scale 1: the supervisor escalates a foreign process to SIGTERM at 2 s x scale. At SCALE (0.02) that is
    // 40 ms, which a loaded machine can spend before the `module.shutdown` call (new thread, connect, handshake) has
    // reached the impostor, so it died of the signal instead of exiting 0. At 1 the shutdown path always wins the race
    // it is asserted to win; the assertion below is unchanged.
    let mut s = h.start_scaled("1", &[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(st) = impostor.try_wait().unwrap() {
            break st;
        }
        assert!(Instant::now() < deadline, "the impostor still runs");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(0), "it was shut down, not killed");
    let m = child(&st, "fixture").unwrap();
    assert_ne!(m["pid"].as_u64(), Some(u64::from(impostor.id())));
    assert_eq!(m["adopted"], false);
    let probe = h
        .log()
        .into_iter()
        .find(|r| r["msg"] == "fixture probe")
        .unwrap();
    assert_eq!(probe["result"], "foreign", "{probe}");
    assert!(
        probe["reason"]
            .as_str()
            .unwrap()
            .contains("module-identity-mismatch"),
        "{probe}"
    );
    assert!(h
        .log_index("terminating a fixture found at start", |_| true)
        .is_some());
    stop(&mut s, &mut c, 5000);
}

/// Serves `module.auth` on `run/module-fixture.sock` as a module named `impostor`, with its own token and pid file;
/// `module.shutdown` makes it exit 0.
#[cfg(unix)]
const IMPOSTOR: &str = r#"
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const run = process.argv[2];
const address = join(run, "module-fixture.sock");
const token = randomBytes(32).toString("hex");
const instanceId = randomUUID();
rmSync(address, { force: true });
const server = createServer((s) => {
  let buf = "";
  s.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const reply = (result) => s.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      if (msg.method === "module.auth") {
        reply({ rpc: "1.5.0", instanceId, pid: process.pid, module: { name: "impostor", version: "0.1.0", apiVersion: "1" } });
      } else if (msg.method === "module.shutdown") {
        s.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { accepted: true } }) + "\n", () => process.exit(0));
      }
    }
  });
  s.on("error", () => {});
});
server.listen(address, () => {
  writeFileSync(join(run, "module-fixture.token"), token);
  writeFileSync(join(run, "module-fixture.pid"), `${process.pid} ${instanceId}\n`);
});
setTimeout(() => process.exit(3), 60_000).unref();
"#;

#[test]
fn module_state_notifications_reach_a_watcher() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.config(1000, json!({}));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let first_pid = child(&st, "fixture").unwrap()["pid"].as_u64().unwrap();

    let mut conn = common::raw(&h.home);
    let lines = format!(
        "{}\n{}\n",
        json!({ "jsonrpc": "2.0", "id": 1, "method": "supervisor.auth", "params": { "token": common::token(&h.home) } }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "module.watch", "params": {} }),
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
    assert_valid("methods/module.watch/result", &reply["result"]);
    let modules = reply["result"]["modules"].as_array().unwrap();
    assert_eq!(modules.len(), 1, "{reply}");
    assert_eq!(modules[0]["name"], "fixture");
    assert_eq!(modules[0]["process"]["state"], "ready");
    assert_eq!(modules[0]["pid"].as_u64(), Some(first_pid));

    kill(first_pid as u32);
    let mut seen: Vec<Value> = Vec::new();
    let deadline = Instant::now() + WAIT;
    while !seen
        .iter()
        .any(|n| n["process"]["state"] == "ready" && n["pid"].as_u64() != Some(first_pid))
    {
        let left = deadline.saturating_duration_since(Instant::now());
        let v = rx
            .recv_timeout(left)
            .unwrap_or_else(|_| panic!("no ready module.state; seen {seen:?}"));
        assert_eq!(v["method"], "module.state", "{v}");
        assert!(v.get("id").is_none());
        assert_valid("notifications/module.state", &v["params"]);
        seen.push(v["params"].clone());
    }
    let states: Vec<&str> = seen
        .iter()
        .map(|n| n["process"]["state"].as_str().unwrap())
        .collect();
    let crashed = states.iter().position(|s| *s == "crashed").unwrap();
    let starting = states.iter().position(|s| *s == "starting").unwrap();
    assert!(crashed < starting, "{states:?}");
    assert_eq!(seen[crashed]["pid"], Value::Null);
    assert!(seen.iter().all(|n| n["name"] == "fixture"));
    stop(&mut s, &mut c, 5000);
}

#[test]
fn daemon_stop_stops_modules_before_the_core() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.config(1000, json!({}));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let pid = child(&st, "fixture").unwrap()["pid"].clone();
    stop(&mut s, &mut c, 2000);
    let exited = h
        .log_index("fixture exited", |r| {
            r["pid"] == pid && r["state"] == "stopped"
        })
        .unwrap_or_else(|| panic!("{:?}", h.log()));
    let stopping_core = h.log_index("stopping core", |_| true).unwrap();
    assert!(exited < stopping_core, "{:?}", h.log());
    let shutdown = h.events("shutdown");
    assert_eq!(shutdown.len(), 1);
    assert!(shutdown[0]["budgetMs"].as_u64().unwrap() <= 2000);
    assert!(!h.home.join("run/module-fixture.pid").exists());
}

/// M3: `daemon.stop` keeps one deadline (budget + grace) for every child, however many there are. Two modules that
/// cannot answer (SIGSTOP) are both killed at that deadline: the stop takes about one budget, not one per module.
/// `healthIntervalMs` is long so the hang detector (three intervals) does not kill them first.
/// The core's reserve is the stop grace (5 s x scale). At 0.02 its 100 ms is used up on a slow runner by reaping the
/// two killed modules; at 0.1 its 500 ms was once not enough on a loaded ubuntu runner either (asked at once, the
/// fake core took about 600 ms to exit and was killed). At 0.3 the core has 1.5 s, and with a 2 s budget the stop
/// (at most budget + grace, 3.5 s) still ends before the 4 s a budget per module would take.
#[cfg(unix)]
#[test]
fn daemon_stop_keeps_one_deadline_for_every_child() {
    let h = Home::new();
    h.install("fixture", json!({}));
    h.install("fixture-b", json!({ "name": "fixture-b" }));
    let config =
        json!({ "schemaVersion": 1, "supervisor": { "graceMs": 1000, "healthIntervalMs": 60000 } });
    std::fs::write(h.home.join("config.json"), config.to_string()).unwrap();
    let mut s = h.start_scaled("0.3", &[]);
    let mut c = client(&h.home);
    wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let st = wait_for(&mut c, "fixture-b", "ready", |m| state(m) == "ready");
    for name in ["fixture", "fixture-b"] {
        let pid = child(&st, name).unwrap()["pid"].as_u64().unwrap();
        // SAFETY: a plain signal to a module this test's supervisor spawned.
        unsafe {
            libc::kill(pid as i32, libc::SIGSTOP);
        }
    }
    let t0 = Instant::now();
    stop(&mut s, &mut c, 2000);
    let took = t0.elapsed();
    // Both modules are killed at the end of the 2000 ms budget, then the core stops within its grace; a budget per
    // module would take over 4 s.
    assert!(took >= Duration::from_millis(2000), "{took:?}");
    assert!(took < Duration::from_millis(3800), "{took:?}");
    for name in ["fixture", "fixture-b"] {
        assert!(
            h.log_index(&format!("{name} did not stop in time, killing"), |_| true)
                .is_some(),
            "{:?}",
            h.log()
        );
    }
    // H3B-R25: the grace is the core's reserve, so the hung modules cost it nothing: it was asked to stop with
    // time left and stopped cleanly.
    let shutdown = h.events("shutdown");
    assert_eq!(shutdown.len(), 1, "{:?}", h.log());
    assert!(
        shutdown[0]["budgetMs"].as_u64().unwrap() > 0,
        "{shutdown:?}"
    );
    assert!(
        h.log_index("core did not stop in time, killing", |_| true)
            .is_none(),
        "{:?}",
        h.log()
    );
    assert!(h
        .log_index("core exited", |r| r["state"] == "stopped"
            && r["code"] == 0
            && r["signal"].is_null())
        .is_some());
}

/// The manifest's `restart` (D14): `never` leaves a crashed module down after one exit; `always` restarts it after a
/// clean exit too (until the give-up); the default `on-failure` does not restart a clean exit (stopped, which
/// `1staid` warns about since nothing asked for it).
#[test]
fn the_manifest_restart_policy_decides_what_an_exit_leads_to() {
    let h = Home::new();
    h.install("fixture", json!({ "restart": "never" }));
    let always = h.install(
        "fixture-b",
        json!({ "name": "fixture-b", "restart": "always" }),
    );
    std::fs::write(always.join("index.js"), "process.exit(0);\n").unwrap();
    let clean = h.install("fixture-c", json!({ "name": "fixture-c" }));
    std::fs::write(clean.join("index.js"), "process.exit(0);\n").unwrap();
    h.config(1000, json!({ "fixture": { "crashAfterMs": 200 } }));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "crashed", |m| state(m) == "crashed");
    let never = child(&st, "fixture").unwrap();
    assert_eq!(never["nextRestartAt"], Value::Null, "{never}");
    assert_eq!(never["restarts"], 0, "{never}");
    assert_eq!(never["lastExit"]["code"], 1, "{never}");
    assert!(never["process"].get("reason").is_none(), "{never}");
    let st = wait_for(&mut c, "fixture-b", "given up", |m| {
        m["process"]["reason"] == "gave-up"
    });
    let b = child(&st, "fixture-b").unwrap();
    assert_eq!(b["restarts"], 4, "{b}");
    assert_eq!(b["lastExit"]["code"], 0, "{b}");
    let st = wait_for(&mut c, "fixture-c", "stopped", |m| state(m) == "stopped");
    let cl = child(&st, "fixture-c").unwrap();
    assert!(cl["process"].get("reason").is_none(), "{cl}");
    assert_eq!(cl["restarts"], 0, "{cl}");
    std::thread::sleep(Duration::from_millis(300));
    let st = status(&mut c);
    assert_eq!(child(&st, "fixture").unwrap()["restarts"], 0, "{st}");
    assert_eq!(child(&st, "fixture-c").unwrap()["restarts"], 0, "{st}");
    let spawned = |name: &str| {
        h.log()
            .iter()
            .filter(|r| r["msg"] == format!("{name} spawned"))
            .count()
    };
    assert_eq!(spawned("fixture"), 1);
    assert_eq!(spawned("fixture-b"), 5);
    assert_eq!(spawned("fixture-c"), 1);
    let (_, v) = h.check();
    let check = v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "modules.state")
        .unwrap()
        .clone();
    assert_eq!(check["status"], "fail", "{check}");
    let summary = check["summary"].as_str().unwrap();
    assert!(
        summary.contains("fixture (crashed, not restarted (restart: never"),
        "{check}"
    );
    assert!(
        summary.contains("fixture-b (crashed: gave up after repeated exits"),
        "{check}"
    );
    assert!(
        summary.contains("fixture-c (stopped: exited on its own"),
        "{check}"
    );
    stop(&mut s, &mut c, 5000);
}

/// Minor 3: every spawn reads the manifest as it is now. A module whose `apiVersion` is changed to an unsupported one
/// while it runs is not respawned after its next exit: `crashed`, `api-version-unsupported`.
#[test]
fn a_respawn_reads_the_manifest_again() {
    let h = Home::new();
    let dir = h.install("fixture", json!({}));
    h.config(1000, json!({}));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "ready", |m| state(m) == "ready");
    let pid = child(&st, "fixture").unwrap()["pid"].as_u64().unwrap();
    let mut m: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("module.json")).unwrap()).unwrap();
    m["apiVersion"] = json!("3");
    std::fs::write(dir.join("module.json"), m.to_string()).unwrap();
    kill(pid as u32);
    let st = wait_for(&mut c, "fixture", "api-version-unsupported", |m| {
        m["process"]["reason"] == "api-version-unsupported"
    });
    let m = child(&st, "fixture").unwrap();
    assert_eq!(state(m), "crashed", "{m}");
    assert_eq!(m["nextRestartAt"], Value::Null, "{m}");
    assert_eq!(m["pid"], Value::Null, "{m}");
    assert_eq!(
        h.log()
            .iter()
            .filter(|r| r["msg"] == "fixture spawned")
            .count(),
        1
    );
    stop(&mut s, &mut c, 5000);
}

/// B12 on the spawn path (minor 2): a spawned module whose hello names another module is killed, and the exit is fatal
/// `manifest-invalid` — a retry would report the same identity.
#[cfg(unix)]
#[test]
fn a_spawned_module_reporting_another_name_is_fatal_manifest_invalid() {
    let h = Home::new();
    let dir = h.install("fixture", json!({}));
    let entry = IMPOSTOR.replace(
        "const run = process.argv[2];",
        "const run = join(process.argv[process.argv.indexOf(\"--home\") + 1], \"run\");",
    );
    std::fs::write(dir.join("index.js"), entry).unwrap();
    h.config(1000, json!({}));
    let mut s = h.start(&[]);
    let mut c = client(&h.home);
    let st = wait_for(&mut c, "fixture", "crashed", |m| state(m) == "crashed");
    let m = child(&st, "fixture").unwrap();
    assert_eq!(m["process"]["reason"], "manifest-invalid", "{m}");
    assert_eq!(m["lastExit"]["reason"], "manifest-invalid", "{m}");
    assert_eq!(m["nextRestartAt"], Value::Null, "{m}");
    assert_eq!(m["restarts"], 0, "{m}");
    assert!(h
        .log_index("fixture reports another identity, killing", |r| r["reason"]
            .as_str()
            .is_some_and(|r| r.contains("impostor")))
        .is_some());
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(child(&status(&mut c), "fixture").unwrap()["restarts"], 0);
    stop(&mut s, &mut c, 5000);
}
