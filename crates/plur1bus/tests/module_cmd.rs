//! `plur1bus module list|graph|install|uninstall|start|stop|restart` (B13, B14, criteria 4 and 12) and the
//! `modules.<name>` configuration: a module key restarts only its module, `enabled` stops and starts it (and its
//! dependents), `configSchema` refuses a bad value on `config set` and on a hand edit. `list`, `graph`, `install` and
//! `uninstall` also run without a supervisor; `start`, `stop` and `restart` need one. The core is
//! `tests/fixtures/fake-core.mjs`, the module the built fixture (`PLUR1BUS_FIXTURE_MODULE`, default
//! `packages/module-fixture/dist`). Durations are scaled by 0.02.
mod common;

use common::{assert_valid, client, start_with_core, Supervisor};
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(20);
const SCALE: &str = "0.02";

fn fixture_dist() -> PathBuf {
    std::env::var_os("PLUR1BUS_FIXTURE_MODULE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/module-fixture/dist")
        })
}

/// A temp home, a scratch directory for module sources, and the fake core's events file. On drop, every module or
/// core process whose pid file is still in `run/` (and whose command line names this home) is killed.
struct Home {
    dir: tempfile::TempDir,
    home: PathBuf,
    events: PathBuf,
}

impl Home {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("h");
        std::fs::create_dir_all(&home).unwrap();
        let events = dir.path().join("events.jsonl");
        Home { dir, home, events }
    }

    /// A copy of the fixture under `<scratch>/<dir>` with `manifest` merged over its module.json: an install source.
    fn source(&self, dir: &str, manifest: Value) -> PathBuf {
        let src = fixture_dist();
        let dst = self.dir.path().join("src").join(dir);
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

    fn config(&self, modules: Value) {
        let v =
            json!({ "schemaVersion": 1, "supervisor": { "graceMs": 1000 }, "modules": modules });
        std::fs::write(
            self.home.join("config.json"),
            serde_json::to_string_pretty(&v).unwrap(),
        )
        .unwrap();
    }

    fn start(&self) -> Supervisor {
        start_with_core(&self.home, &self.events, SCALE, &[])
    }

    fn service_fake(&self) -> PathBuf {
        let dir = self.dir.path().join("svc");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `plur1bus [--json] --home <home> <args>`, stdin closed (no terminal).
    fn run(&self, json: bool, args: &[&str]) -> Output {
        let mut cmd = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
        if json {
            cmd.arg("--json");
        }
        cmd.arg("--home")
            .arg(&self.home)
            .args(args)
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", self.service_fake())
            .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    /// `--json` run: (exit code, document).
    fn cli(&self, args: &[&str]) -> (i32, Value) {
        let out = self.run(true, args);
        let v: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|e| panic!("{args:?}: {e}: {out:?}"));
        (out.status.code().unwrap_or(-1), v)
    }

    /// A successful `--json` run, its `schema` checked and removed, the rest validated as `methods/<method>/result`.
    fn ok(&self, args: &[&str], method: &str) -> Value {
        let (code, mut v) = self.cli(args);
        assert_eq!(code, 0, "{args:?}: {v}");
        assert_eq!(v["schema"], format!("{method}/1"), "{v}");
        v.as_object_mut().unwrap().remove("schema");
        assert_valid(&format!("methods/{method}/result"), &v);
        v
    }

    fn modules_listing(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.home.join("modules"))
            .map(|r| {
                r.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
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

fn ready(c: &mut Client, role: &str) -> Value {
    let st = wait_for(c, role, "ready", |m| state(m) == "ready");
    child(&st, role).unwrap().clone()
}

fn stop(s: &mut Supervisor, c: &mut Client) {
    c.call("daemon.stop", json!({ "budgetMs": 5000 })).unwrap();
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

fn entry<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == name)
        .unwrap_or_else(|| panic!("{name} not in {list}"))
}

fn path_str(p: &Path) -> &str {
    p.to_str().unwrap()
}

/// Criterion 12: a module installed through `module install` (no supervisor, no code change) is listed, graphed and
/// then run by the supervisor.
#[test]
fn install_then_list_and_graph_show_the_fixture_without_code_changes() {
    let h = Home::new();
    let v = h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    assert_eq!(
        v,
        json!({ "name": "fixture", "version": "0.1.0", "replaced": false })
    );
    assert!(h.home.join("modules/fixture/module.json").is_file());
    // H3B-R23: the module's package.json (`"type": "module"`) comes along.
    assert!(h.home.join("modules/fixture/package.json").is_file());

    let list = h.ok(&["module", "list"], "module.list");
    let m = entry(&list, "fixture");
    assert_eq!(m["version"], "0.1.0");
    assert_eq!(m["apiVersion"], "1");
    assert_eq!(m["priority"], 500);
    assert_eq!(m["band"], "add-ons");
    assert_eq!(m["scope"], "installation");
    assert_eq!(m["enabled"], true);
    assert_eq!(m["errors"], json!([]));
    assert_eq!(m["child"], Value::Null);
    let text = String::from_utf8(h.run(false, &["module", "list"]).stdout).unwrap();
    assert!(text.contains("fixture 0.1.0"), "{text}");
    assert!(text.contains("add-ons"), "{text}");

    let graph = h.ok(&["module", "graph"], "module.graph");
    let edges = graph["edges"].as_array().unwrap();
    assert!(
        edges.contains(&json!({ "from": "fixture", "to": "core", "kind": "needs" })),
        "{graph}"
    );
    assert!(
        edges.contains(
            &json!({ "from": "fixture", "to": "core", "kind": "consumes", "capability": "memory" })
        ),
        "{graph}"
    );
    let node = graph["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["name"] == "fixture")
        .unwrap();
    assert_eq!(
        node["extensionPoints"],
        json!({ "collect-status": "collect" })
    );
    let text = String::from_utf8(h.run(false, &["module", "graph"]).stdout).unwrap();
    assert!(text.contains("add-ons"), "{text}");
    assert!(text.contains("fixture 0.1.0"), "{text}");

    // The supervisor runs it.
    let mut s = h.start();
    let mut c = client(&h.home);
    ready(&mut c, "fixture");
    let list = h.ok(&["module", "list"], "module.list");
    assert_eq!(
        entry(&list, "fixture")["child"]["process"]["state"],
        "ready"
    );
    let graph2 = h.ok(&["module", "graph"], "module.graph");
    assert_eq!(graph2, graph, "the supervisor's graph is the offline one");
    stop(&mut s, &mut c);
}

/// Review Focus 5 (B14): an escaping entry, a reserved name, an invalid manifest, a missing directory and (unix) a
/// symlink anywhere are refused before anything is copied: `modules/` stays exactly as it was.
#[test]
fn install_refuses_escaping_entries_symlinks_and_reserved_names_and_copies_nothing() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    let before = h.modules_listing();
    let manifest_before = std::fs::read(h.home.join("modules/fixture/module.json")).unwrap();
    assert_eq!(before, ["fixture"]);
    let mut cases: Vec<(PathBuf, &str)> = vec![
        (
            h.source("escape", json!({ "entry": "../x.js" })),
            "entry-outside",
        ),
        (
            h.source("absolute", json!({ "entry": "/abs.js" })),
            "entry-outside",
        ),
        (h.source("core", json!({ "name": "core" })), "reserved-name"),
        (
            h.source("supervisor", json!({ "name": "supervisor" })),
            "reserved-name",
        ),
        (
            h.source("priority", json!({ "priority": 1000 })),
            "manifest-invalid",
        ),
        (
            h.source("no-entry", json!({ "entry": "gone.js" })),
            "manifest-invalid",
        ),
        // M3: a configSchema that is not a JSON Schema is refused at install, not at every later config set.
        (
            h.source("bad-schema", json!({ "configSchema": { "type": 5 } })),
            "manifest-invalid",
        ),
        (h.dir.path().join("does-not-exist"), "not-a-directory"),
        // M8: Windows device names are reserved on every OS.
        (h.source("con", json!({ "name": "con" })), "reserved-name"),
        (h.source("lpt1", json!({ "name": "lpt1" })), "reserved-name"),
    ];
    #[cfg(unix)]
    {
        let inner = h.source("inner-link", json!({}));
        std::fs::create_dir(inner.join("lib")).unwrap();
        std::os::unix::fs::symlink("/etc/hostname", inner.join("lib/host")).unwrap();
        cases.push((inner, "symlink"));
        let target = h.source("link-target", json!({}));
        let outer = h.dir.path().join("src/outer-link");
        std::os::unix::fs::symlink(&target, &outer).unwrap();
        cases.push((outer, "symlink"));
        // M2: a FIFO (any special file) is refused as user input, and never opened.
        let fifo = h.source("fifo", json!({}));
        let path = std::ffi::CString::new(fifo.join("pipe").to_str().unwrap()).unwrap();
        // SAFETY: mkfifo on a NUL-terminated path in the test's own scratch directory.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        cases.push((fifo, "not-a-regular-file"));
    }
    #[cfg(windows)]
    {
        // A junction (a mount-point reparse point, no privilege needed) is refused like a symlink.
        let inner = h.source("junction", json!({}));
        let target = h.source("junction-target", json!({}));
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(inner.join("lib"))
            .arg(&target)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        cases.push((inner, "symlink"));
    }
    for (src, reason) in cases {
        let (code, v) = h.cli(&["module", "install", path_str(&src)]);
        assert_eq!(code, 1, "{src:?}: {v}");
        assert_eq!(v["error"], "E_INVALID_PARAMS", "{src:?}: {v}");
        assert_eq!(v["reason"], reason, "{src:?}: {v}");
        assert_eq!(h.modules_listing(), before, "{src:?} left something behind");
    }
    assert_eq!(
        std::fs::read(h.home.join("modules/fixture/module.json")).unwrap(),
        manifest_before
    );
}

/// M7: a module whose `run/module-<name>.sock` would not fit a Unix socket address under this home is refused before
/// anything is copied (it would install and then crash-loop, unable to listen). Windows modules use named pipes.
#[cfg(unix)]
#[test]
fn install_refuses_a_module_whose_socket_path_would_be_too_long() {
    let mut h = Home::new();
    // `sun_path` holds the address and its NUL: 104 bytes on macOS and the BSDs, 108 elsewhere. The home is made as
    // deep as this platform's limit and the real temp dir (long on macOS: /var/folders/.../T/) allow, so that
    // `<home>/run/module-m.sock` fits with one byte to spare and the 40-character name is over it everywhere.
    let limit = if cfg!(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    )) {
        104
    } else {
        108
    };
    let short_suffix = "/run/module-m.sock".len();
    let base = h.dir.path().join("h");
    let home_len = limit - 2 - short_suffix;
    let pad = home_len
        .checked_sub(base.as_os_str().len() + 1)
        .filter(|&p| p > 0)
        .unwrap_or_else(|| panic!("temp dir too long for this test: {}", base.display()));
    let deep = base.join("d".repeat(pad));
    std::fs::create_dir_all(&deep).unwrap();
    h.home = deep;
    let short_address = format!("{}/run/module-m.sock", h.home.display());
    assert!(short_address.len() < limit, "{short_address}");
    let name = format!("m{}", "x".repeat(39));
    let address = format!("{}/run/module-{name}.sock", h.home.display());
    assert!(address.len() >= limit, "{address}");
    let src = h.source("long-name", json!({ "name": name }));
    let (code, v) = h.cli(&["module", "install", path_str(&src)]);
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["error"], "E_INVALID_PARAMS", "{v}");
    assert_eq!(v["reason"], "socket-path-too-long", "{v}");
    assert!(h.modules_listing().is_empty(), "{:?}", h.modules_listing());
    // The same home takes a short name.
    let short = h.source("short-name", json!({ "name": "m" }));
    h.ok(&["module", "install", path_str(&short)], "module.install");
    assert_eq!(h.modules_listing(), ["m"]);
}

#[test]
fn reinstall_replaces_and_restarts_a_running_module() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    let mut s = h.start();
    let mut c = client(&h.home);
    let core = ready(&mut c, "core");
    let first = ready(&mut c, "fixture");
    let v2 = h.source("v2", json!({ "version": "0.2.0" }));
    let v = h.ok(&["module", "install", path_str(&v2)], "module.install");
    assert_eq!(
        v,
        json!({ "name": "fixture", "version": "0.2.0", "replaced": true })
    );
    let st = wait_for(&mut c, "fixture", "running again", |m| {
        state(m) == "ready" && m["pid"] != first["pid"] && !m["pid"].is_null()
    });
    let list = h.ok(&["module", "list"], "module.list");
    let m = entry(&list, "fixture");
    assert_eq!(m["version"], "0.2.0");
    assert_eq!(m["child"]["pid"], child(&st, "fixture").unwrap()["pid"]);
    assert_eq!(child(&st, "core").unwrap()["pid"], core["pid"]);
    // A refusal through the supervisor is the same refusal, and nothing changes.
    let bad = h.source("core", json!({ "name": "core" }));
    let (code, v) = h.cli(&["module", "install", path_str(&bad)]);
    assert_eq!((code, &v["reason"]), (1, &json!("reserved-name")), "{v}");
    assert_eq!(h.modules_listing(), ["fixture"]);
    stop(&mut s, &mut c);
}

#[test]
fn stop_start_restart_by_name() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    let mut s = h.start();
    let mut c = client(&h.home);
    let core = ready(&mut c, "core");
    let first = ready(&mut c, "fixture");

    let v = h.ok(&["module", "stop", "fixture"], "module.stop");
    assert_eq!(v, json!({ "accepted": true, "name": "fixture" }));
    let st = wait_for(&mut c, "fixture", "stopped by request", |m| {
        state(m) == "stopped" && m["process"]["reason"] == "stopped-by-request"
    });
    assert_eq!(child(&st, "fixture").unwrap()["pid"], Value::Null);
    // B13: it stays stopped (no restart is scheduled for a requested stop).
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        let st = status(&mut c);
        let m = child(&st, "fixture").unwrap();
        assert_eq!(state(m), "stopped", "{st}");
        assert_eq!(m["nextRestartAt"], Value::Null, "{st}");
        std::thread::sleep(Duration::from_millis(100));
    }

    h.ok(&["module", "start", "fixture"], "module.start");
    let started = ready(&mut c, "fixture");
    assert_ne!(started["pid"], first["pid"]);

    h.ok(&["module", "restart", "fixture"], "module.restart");
    let st = wait_for(&mut c, "fixture", "restarted", |m| {
        state(m) == "ready" && m["pid"] != started["pid"] && !m["pid"].is_null()
    });
    assert_eq!(child(&st, "core").unwrap()["pid"], core["pid"]);
    assert_eq!(child(&st, "core").unwrap()["restarts"], 0);

    for verb in ["start", "stop", "restart"] {
        let (code, v) = h.cli(&["module", verb, "nope"]);
        assert_eq!(code, 1, "{v}");
        assert_eq!(v["error"], "E_MODULE_UNKNOWN", "{v}");
    }
    stop(&mut s, &mut c);
}

#[test]
fn start_without_a_supervisor_is_supervisor_not_running() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    for verb in ["start", "stop", "restart"] {
        let (code, v) = h.cli(&["module", verb, "fixture"]);
        assert_eq!(code, 1, "{verb}: {v}");
        assert_eq!(v["error"], "E_NOT_AVAILABLE", "{verb}: {v}");
        assert_eq!(v["reason"], "supervisor-not-running", "{verb}: {v}");
    }
    let out = h.run(false, &["module", "start", "fixture"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("daemon start"),
        "{out:?}"
    );
}

#[test]
fn graph_reports_cycles_and_unresolved() {
    let h = Home::new();
    for (name, needs) in [
        ("loop-a", json!(["core", "loop-b"])),
        ("loop-b", json!(["loop-a"])),
        ("needy", json!(["core", "missing"])),
    ] {
        let src = h.source(name, json!({ "name": name, "needs": needs }));
        h.ok(&["module", "install", path_str(&src)], "module.install");
    }
    let graph = h.ok(&["module", "graph"], "module.graph");
    assert_eq!(graph["cycles"], json!([["loop-a", "loop-b"]]), "{graph}");
    assert!(
        graph["unresolved"]
            .as_array()
            .unwrap()
            .contains(&json!({ "from": "needy", "kind": "needs", "name": "missing" })),
        "{graph}"
    );
    let list = h.ok(&["module", "list"], "module.list");
    assert!(
        entry(&list, "loop-a")["errors"]
            .to_string()
            .contains("needs-cycle"),
        "{list}"
    );
    assert!(
        entry(&list, "needy")["errors"]
            .to_string()
            .contains("missing"),
        "{list}"
    );
    let text = String::from_utf8(h.run(false, &["module", "graph"]).stdout).unwrap();
    assert!(text.contains("cycle: loop-a, loop-b"), "{text}");
    assert!(text.contains("unresolved: needy needs missing"), "{text}");
}

/// Criterion 4 (module part): a `modules.<name>` key restarts that module only.
#[test]
fn a_module_key_change_restarts_only_that_module() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    h.config(json!({ "fixture": {} }));
    let mut s = h.start();
    let mut c = client(&h.home);
    let core = ready(&mut c, "core");
    let first = ready(&mut c, "fixture");
    let v = h.ok(
        &[
            "config",
            "set",
            "modules.fixture.greeting",
            "\"hi\"",
            "--yes",
        ],
        "config.set",
    );
    assert_eq!(v["changed"], json!(["modules.fixture.greeting"]), "{v}");
    assert_eq!(v["restart"]["modules"], json!(["fixture"]), "{v}");
    assert_eq!(v["restart"]["core"], false, "{v}");
    assert_eq!(v["restarted"], json!(["fixture"]), "{v}");
    let st = status(&mut c);
    let m = child(&st, "fixture").unwrap();
    assert_eq!(state(m), "ready", "{st}");
    assert_ne!(m["pid"], first["pid"], "{st}");
    let core_now = child(&st, "core").unwrap();
    assert_eq!(core_now["pid"], core["pid"], "{st}");
    // The change must not restart the core: compared with the count at ready, so this checks the change alone (the
    // core's start-up is covered by its ready-timeout floor, `CORE_READY_FLOOR`).
    assert_eq!(core_now["restarts"], core["restarts"], "{st}");
    let list = h.ok(&["module", "list"], "module.list");
    assert_eq!(
        entry(&list, "fixture")["detail"]["greeting"],
        "hi",
        "{list}"
    );
    stop(&mut s, &mut c);
}

/// B13: `modules.<name>` is validated against the manifest's `configSchema` on `config set` (with and without a
/// supervisor) and on a hand edit.
#[test]
fn a_module_config_violating_its_config_schema_is_rejected() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    h.config(json!({}));
    let set = [
        "config",
        "set",
        "--yes",
        "--",
        "modules.fixture.crashAfterMs",
        "-1",
    ];
    let before = std::fs::read(h.home.join("config.json")).unwrap();
    // Without a supervisor.
    let (code, v) = h.cli(&set);
    assert_eq!((code, &v["error"]), (1, &json!("E_CONFIG_INVALID")), "{v}");
    assert!(v["message"].to_string().contains("crashAfterMs"), "{v}");
    assert_eq!(std::fs::read(h.home.join("config.json")).unwrap(), before);
    // Through the supervisor.
    let mut s = h.start();
    let mut c = client(&h.home);
    let first = ready(&mut c, "fixture");
    let (code, v) = h.cli(&set);
    assert_eq!((code, &v["error"]), (1, &json!("E_CONFIG_INVALID")), "{v}");
    assert!(v["detail"].to_string().contains("crashAfterMs"), "{v}");
    assert_eq!(std::fs::read(h.home.join("config.json")).unwrap(), before);
    // `enabled` is the supervisor's, not the module's: it never reaches the configSchema.
    h.ok(
        &[
            "config",
            "set",
            "modules.fixture.greeting",
            "\"ok\"",
            "--yes",
        ],
        "config.set",
    );
    // A hand edit is rejected and the module keeps running on the running configuration: the same process.
    let running = ready(&mut c, "fixture");
    let mut cfg: Value =
        serde_json::from_slice(&std::fs::read(h.home.join("config.json")).unwrap()).unwrap();
    cfg["modules"]["fixture"]["crashAfterMs"] = json!(-5);
    std::fs::write(h.home.join("config.json"), cfg.to_string()).unwrap();
    let deadline = Instant::now() + WAIT;
    // `fs::write` truncates, then writes: a watcher tick in between rejects the empty file ("not JSON") and the next
    // one the edit itself, so wait for a rejection that names the edit's error.
    let rejected = loop {
        let st = status(&mut c);
        if st["config"]["rejected"]["errors"]
            .to_string()
            .contains("crashAfterMs")
        {
            break st["config"]["rejected"].clone();
        }
        assert!(
            Instant::now() < deadline,
            "the hand edit was not rejected: {st}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        rejected["errors"].to_string().contains("crashAfterMs"),
        "{rejected}"
    );
    std::thread::sleep(Duration::from_millis(300)); // a few health intervals: a restart would show by now
    let m = ready(&mut c, "fixture");
    assert_eq!(
        m["pid"], running["pid"],
        "the rejected edit restarted the module"
    );
    assert_ne!(
        running["pid"], first["pid"],
        "the accepted set restarted it"
    );
    stop(&mut s, &mut c);
}

/// B13: `enabled: false` stops the module (and a module that needs it: needs-unavailable), `true` starts both again.
#[test]
fn disabling_by_config_stops_the_module_and_enabling_starts_it() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    let dependent = h.source(
        "fixture-b",
        json!({ "name": "fixture-b", "needs": ["core", "fixture"] }),
    );
    h.ok(
        &["module", "install", path_str(&dependent)],
        "module.install",
    );
    h.config(json!({}));
    let mut s = h.start();
    let mut c = client(&h.home);
    let core = ready(&mut c, "core");
    let first = ready(&mut c, "fixture");
    ready(&mut c, "fixture-b");

    let v = h.ok(
        &["config", "set", "modules.fixture.enabled", "false", "--yes"],
        "config.set",
    );
    assert_eq!(v["restart"]["modules"], json!(["fixture"]), "{v}");
    let st = wait_for(&mut c, "fixture", "disabled", |m| {
        state(m) == "stopped" && m["process"]["reason"] == "disabled"
    });
    let b = child(&st, "fixture-b").unwrap();
    let st = if state(b) == "stopped" {
        st.clone()
    } else {
        wait_for(&mut c, "fixture-b", "held back", |m| state(m) == "stopped")
    };
    assert_eq!(
        child(&st, "fixture-b").unwrap()["process"]["reason"],
        "needs-unavailable",
        "{st}"
    );
    let list = h.ok(&["module", "list"], "module.list");
    assert_eq!(entry(&list, "fixture")["enabled"], false);
    let (code, v) = h.cli(&["module", "start", "fixture"]);
    assert_eq!((code, &v["reason"]), (1, &json!("disabled")), "{v}");

    h.ok(
        &["config", "set", "modules.fixture.enabled", "true", "--yes"],
        "config.set",
    );
    let again = ready(&mut c, "fixture");
    assert_ne!(again["pid"], first["pid"]);
    ready(&mut c, "fixture-b");
    assert_eq!(child(&status(&mut c), "core").unwrap()["pid"], core["pid"]);

    // A hand edit of `enabled` does the same.
    let mut cfg: Value =
        serde_json::from_slice(&std::fs::read(h.home.join("config.json")).unwrap()).unwrap();
    cfg["modules"]["fixture"]["enabled"] = json!(false);
    std::fs::write(h.home.join("config.json"), cfg.to_string()).unwrap();
    wait_for(&mut c, "fixture", "disabled by a hand edit", |m| {
        state(m) == "stopped" && m["process"]["reason"] == "disabled"
    });
    wait_for(&mut c, "fixture-b", "held back after the hand edit", |m| {
        m["process"]["reason"] == "needs-unavailable"
    });
    cfg["modules"]["fixture"]["enabled"] = json!(true);
    std::fs::write(h.home.join("config.json"), cfg.to_string()).unwrap();
    ready(&mut c, "fixture");
    ready(&mut c, "fixture-b");
    stop(&mut s, &mut c);
}

#[test]
fn uninstall_stops_and_removes_but_keeps_the_config() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    h.config(json!({ "fixture": { "greeting": "kept" } }));
    let mut s = h.start();
    let mut c = client(&h.home);
    // `m` is only read by the Linux /proc check below.
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
    let m = ready(&mut c, "fixture");
    // Outside a terminal, --yes is required and nothing happens without it.
    let (code, v) = h.cli(&["module", "uninstall", "fixture"]);
    assert_eq!(code, 2, "{v}");
    assert!(h.home.join("modules/fixture").is_dir());
    let v = h.ok(
        &["module", "uninstall", "fixture", "--yes"],
        "module.uninstall",
    );
    assert_eq!(v, json!({ "name": "fixture", "removed": true }));
    assert!(!h.home.join("modules/fixture").exists());
    assert!(h.modules_listing().is_empty());
    let st = status(&mut c);
    assert!(child(&st, "fixture").is_none(), "{st}");
    assert!(!h.home.join("run/module-fixture.pid").exists());
    #[cfg(target_os = "linux")]
    assert!(
        !Path::new(&format!("/proc/{}", m["pid"])).exists()
            || std::fs::read_to_string(format!("/proc/{}/stat", m["pid"]))
                .is_ok_and(|s| s.contains(") Z")),
        "the module process still runs"
    );
    let cfg: Value =
        serde_json::from_slice(&std::fs::read(h.home.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg["modules"]["fixture"]["greeting"], "kept");
    let list = h.ok(&["module", "list"], "module.list");
    assert_eq!(list["modules"], json!([]));
    let (code, v) = h.cli(&["module", "uninstall", "fixture", "--yes"]);
    assert_eq!((code, &v["error"]), (1, &json!("E_MODULE_UNKNOWN")), "{v}");
    stop(&mut s, &mut c);
    // Offline uninstall works too.
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    h.ok(
        &["module", "uninstall", "fixture", "--yes"],
        "module.uninstall",
    );
    assert!(h.modules_listing().is_empty());
}

/// I2: an offline install or uninstall holds the supervisor's single-instance lock (refused while a supervisor holds
/// it, i.e. is starting), and is refused while a process of that module still runs without a supervisor.
#[test]
fn offline_install_and_uninstall_refuse_while_a_supervisor_starts_or_the_module_runs() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    let v2 = h.source("v2", json!({ "version": "0.2.0" }));
    let manifest = std::fs::read(h.home.join("modules/fixture/module.json")).unwrap();
    let unchanged = |h: &Home| {
        assert_eq!(h.modules_listing(), ["fixture"]);
        assert_eq!(
            std::fs::read(h.home.join("modules/fixture/module.json")).unwrap(),
            manifest
        );
    };
    {
        // What `supervise` holds from its start on.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(h.home.join("run/supervisor.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        let (code, v) = h.cli(&["module", "install", path_str(&v2)]);
        assert_eq!(
            (code, &v["reason"]),
            (1, &json!("supervisor-running")),
            "{v}"
        );
        let (code, v) = h.cli(&["module", "uninstall", "fixture", "--yes"]);
        assert_eq!(
            (code, &v["reason"]),
            (1, &json!("supervisor-running")),
            "{v}"
        );
        unchanged(&h);
    }
    // An orphaned module process (this test's own pid stands in for it).
    let pid_file = h.home.join("run/module-fixture.pid");
    std::fs::write(&pid_file, format!("{} some-instance\n", std::process::id())).unwrap();
    let (code, v) = h.cli(&["module", "install", path_str(&v2)]);
    assert_eq!((code, &v["reason"]), (1, &json!("module-running")), "{v}");
    let (code, v) = h.cli(&["module", "uninstall", "fixture", "--yes"]);
    assert_eq!((code, &v["reason"]), (1, &json!("module-running")), "{v}");
    unchanged(&h);
    std::fs::remove_file(&pid_file).unwrap();
    let v = h.ok(&["module", "install", path_str(&v2)], "module.install");
    assert_eq!(v["replaced"], true);
    h.ok(
        &["module", "uninstall", "fixture", "--yes"],
        "module.uninstall",
    );
}

/// M3: a running module whose module.json became invalid can still be stopped by name.
#[test]
fn stop_works_for_a_running_module_whose_manifest_became_invalid() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    let mut s = h.start();
    let mut c = client(&h.home);
    let m = ready(&mut c, "fixture");
    std::fs::write(h.home.join("modules/fixture/module.json"), "{ broken").unwrap();
    h.ok(&["module", "stop", "fixture"], "module.stop");
    let st = wait_for(&mut c, "fixture", "stopped", |x| state(x) == "stopped");
    assert_eq!(child(&st, "fixture").unwrap()["pid"], Value::Null, "{st}");
    #[cfg(target_os = "linux")]
    assert!(
        std::fs::read_to_string(format!("/proc/{}/stat", m["pid"]))
            .map_or(true, |s| s.contains(") Z")),
        "the module process still runs"
    );
    let _ = m;
    // It cannot be started again while its manifest is invalid.
    let (code, v) = h.cli(&["module", "start", "fixture"]);
    assert_eq!((code, &v["reason"]), (1, &json!("manifest-invalid")), "{v}");
    stop(&mut s, &mut c);
}

/// H3B-R28: a need stopped by `module stop` holds its dependents back as needs-unavailable; starting it releases them.
#[test]
fn a_need_stopped_by_request_holds_its_dependents() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    let dependent = h.source(
        "fixture-b",
        json!({ "name": "fixture-b", "needs": ["core", "fixture"] }),
    );
    h.ok(
        &["module", "install", path_str(&dependent)],
        "module.install",
    );
    let mut s = h.start();
    let mut c = client(&h.home);
    ready(&mut c, "fixture");
    let b = ready(&mut c, "fixture-b");
    h.ok(&["module", "stop", "fixture"], "module.stop");
    let st = wait_for(&mut c, "fixture-b", "held back", |m| {
        state(m) == "stopped" && m["process"]["reason"] == "needs-unavailable"
    });
    assert_eq!(
        child(&st, "fixture").unwrap()["process"]["reason"],
        "stopped-by-request"
    );
    let (code, v) = h.cli(&["module", "start", "fixture-b"]);
    assert_eq!(
        (code, &v["reason"]),
        (1, &json!("needs-unavailable")),
        "{v}"
    );
    h.ok(&["module", "start", "fixture"], "module.start");
    ready(&mut c, "fixture");
    let again = ready(&mut c, "fixture-b");
    assert_ne!(again["pid"], b["pid"]);
    stop(&mut s, &mut c);
}

/// I1 and M7 without a supervisor: `enabled` can be flipped over a section that already fails the module's
/// configSchema (the switch is the supervisor's), and `module list` reports the section's errors.
#[test]
fn enabled_flips_over_a_section_that_fails_the_config_schema() {
    let h = Home::new();
    h.ok(
        &["module", "install", path_str(&fixture_dist())],
        "module.install",
    );
    // Written while nothing checked it (by hand, before the module was installed).
    h.config(json!({ "fixture": { "crashAfterMs": -1 } }));
    let list = h.ok(&["module", "list"], "module.list");
    assert!(
        entry(&list, "fixture")["errors"]
            .to_string()
            .contains("modules.fixture.crashAfterMs"),
        "{list}"
    );
    h.ok(
        &["config", "set", "modules.fixture.enabled", "false", "--yes"],
        "config.set",
    );
    h.ok(
        &["config", "set", "modules.fixture.enabled", "true", "--yes"],
        "config.set",
    );
    let (code, v) = h.cli(&[
        "config",
        "set",
        "--yes",
        "--",
        "modules.fixture.crashAfterMs",
        "-2",
    ]);
    assert_eq!((code, &v["error"]), (1, &json!("E_CONFIG_INVALID")), "{v}");
}
