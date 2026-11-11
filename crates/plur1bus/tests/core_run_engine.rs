//! RE-D173 (RX8 T8b): `plur1bus core run` with `engine.implementation: "rust"` stays as a wrapper: it spawns the engine
//! (`plur1bus-engine serve --home <home> --lifeline stdin --instance <uuid>`, from `PLUR1BUS_ENGINE_BIN` or beside the
//! executable) without waiting for it, keeps the engine's ready line off its stdout, spawns the core, forwards SIGTERM and
//! SIGHUP to it, and when the core has ended stops the engine (`engine.shutdown`, SIGTERM, a kill at 5 s) and exits with
//! the core's code. With the Node engine it execs the core as before, and refuses to start beside a live Rust engine
//! (`run/engine.process.lock` held).
//!
//! The engine is `tests/fixtures/fake-engine.mjs` (Node hard-linked as `plur1bus-engine` beside a `serve` stub, run with
//! that directory as the working directory, as in `supervisor_engine_slot.rs`); the core is `fake-core.mjs` with its
//! ready line on stdout and signal events. Homes are canonical (the real engine refuses a home reached through a
//! symlink, KNOWN-GAP: `docs/engine-process.md`).
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(30);
const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn node() -> PathBuf {
    let name = format!("node{EXE}");
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .map(|dir| dir.join(&name))
        .find(|candidate| candidate.is_file())
        .expect("node on PATH")
}

fn link_or_copy(from: &Path, to: &Path) {
    if std::fs::hard_link(from, to).is_err() {
        std::fs::copy(from, to).unwrap();
    }
}

/// A canonical temp home, a `bin/` with the fake engine, and the event files of both fakes.
struct Home {
    _dir: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    bin: PathBuf,
    core_events: PathBuf,
    engine_events: PathBuf,
}

impl Home {
    /// `implementation`: `engine.implementation` in config.json (`None`: no config file).
    fn new(implementation: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        // Canonical on unix (macOS: /var -> /private/var); Windows keeps the plain path (no `\\?\` prefix in the home).
        let root = if cfg!(unix) {
            dir.path().canonicalize().unwrap()
        } else {
            dir.path().to_owned()
        };
        let home = root.join("home");
        let bin = root.join("bin");
        std::fs::create_dir_all(home.join("run")).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::set_permissions(home.join("run"), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        let h = Self {
            core_events: root.join("core-events.jsonl"),
            engine_events: root.join("engine-events.jsonl"),
            _dir: dir,
            root,
            home,
            bin,
        };
        h.fake_engine_in(&h.bin);
        if let Some(implementation) = implementation {
            std::fs::write(
                h.home.join("config.json"),
                json!({ "schemaVersion": 1, "engine": { "implementation": implementation } })
                    .to_string(),
            )
            .unwrap();
        }
        h
    }

    /// Node as `plur1bus-engine` in `dir`, and the `serve` stub it runs (relative to the working directory, `bin/`).
    fn fake_engine_in(&self, dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let engine = dir.join(format!("plur1bus-engine{EXE}"));
        link_or_copy(&node().canonicalize().unwrap(), &engine);
        std::fs::write(
            dir.join("serve"),
            "import(require('node:url').pathToFileURL(process.env.FAKE_ENGINE_JS).href);\n",
        )
        .unwrap();
        engine
    }

    fn engine_bin(&self) -> PathBuf {
        self.bin.join(format!("plur1bus-engine{EXE}"))
    }

    /// This build's `plur1bus` beside the fake engine, so the engine is found as its sibling.
    fn plur1bus_beside_the_engine(&self) -> PathBuf {
        let to = self.bin.join(format!("plur1bus{EXE}"));
        link_or_copy(&assert_cmd::cargo::cargo_bin("plur1bus"), &to);
        to
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
    fn core_events(&self, name: &str) -> Vec<Value> {
        Self::lines(&self.core_events)
            .into_iter()
            .filter(|e| e["event"] == name)
            .collect()
    }
}

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the pid exists.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
}

fn hard_kill(pid: u32) {
    #[cfg(unix)]
    // SAFETY: ends a process this test started (a fake core or engine of its own home).
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
}

#[cfg(unix)]
fn signal(pid: u32, signal: i32) {
    // SAFETY: signals a process this test started.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, signal) }, 0);
}

/// One `plur1bus core run`: its stdout lines and its stderr as they come; kills what is left of the home's processes
/// when dropped.
struct Run {
    child: Child,
    h_core_events: PathBuf,
    h_engine_events: PathBuf,
    lines: mpsc::Receiver<String>,
    stderr: Arc<Mutex<String>>,
}

impl Run {
    fn start(h: &Home, program: &Path, env: &[(&str, &str)]) -> Run {
        let mut cmd = Command::new(program);
        cmd.arg("--home")
            .arg(&h.home)
            .args(["core", "run"])
            .current_dir(&h.bin)
            .env("PLUR1BUS_CORE_JS", fixture("fake-core.mjs"))
            .env("PLUR1BUS_NODE", "node")
            .env_remove("PLUR1BUS_CORE_IMPL")
            .env_remove("PLUR1BUS_TEST_INTERNALS")
            .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
            .env_remove("PLUR1BUS_ENGINE_BIN")
            .env("FAKE_CORE_MODE", "ok")
            .env("FAKE_CORE_EVENTS", &h.core_events)
            .env("FAKE_CORE_READY_LINE", "1")
            .env("FAKE_CORE_SIGNAL_EVENTS", "1")
            .env("FAKE_ENGINE_JS", fixture("fake-engine.mjs"))
            .env("FAKE_ENGINE_EVENTS", &h.engine_events)
            .env("FAKE_ENGINE_GRACE_MS", "300")
            .env_remove("FAKE_ENGINE_MODE")
            .env_remove("FAKE_ENGINE_LATER_MODE")
            .env_remove("FAKE_ENGINE_STATUS")
            .env_remove("FAKE_ENGINE_LOCK_HELPER")
            .env_remove("FAKE_ENGINE_IGNORE_SIGTERM")
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let (tx, lines) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if tx.send(line).is_err() {
                    return;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let (sink, mut from) = (stderr.clone(), child.stderr.take().unwrap());
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = from.read(&mut buf) {
                if n == 0 {
                    return;
                }
                sink.lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
        Run {
            child,
            h_core_events: h.core_events.clone(),
            h_engine_events: h.engine_events.clone(),
            lines,
            stderr,
        }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The next stdout line as JSON.
    fn next_line(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(WAIT)
            .unwrap_or_else(|e| panic!("no stdout line ({e}); stderr: {}", self.stderr()));
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("not JSON: {line}"))
    }

    /// Every stdout line until EOF (after the exit).
    fn rest(&self) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(line) = self.lines.recv_timeout(WAIT) {
            out.push(line);
        }
        out
    }

    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    fn wait_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s;
            }
            assert!(
                Instant::now() < deadline,
                "core run did not exit within {WAIT:?}; stderr: {}",
                self.stderr()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for file in [&self.h_core_events, &self.h_engine_events] {
            for e in Home::lines(file) {
                if e["event"] == "started" {
                    if let Some(pid) = e["pid"].as_u64() {
                        if alive(pid as u32) {
                            hard_kill(pid as u32);
                        }
                    }
                }
            }
        }
    }
}

fn address(home: &Path, role: &str) -> String {
    if cfg!(windows) {
        use sha2::{Digest, Sha256};
        let hash = format!(
            "{:x}",
            Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes())
        );
        format!(r"\\.\pipe\plur1bus-{}-{role}", &hash[..16])
    } else {
        home.join("run")
            .join(format!("{role}.sock"))
            .display()
            .to_string()
    }
}

fn core_client(home: &Path) -> Client {
    let token = std::fs::read_to_string(home.join("run/core.token")).unwrap();
    let opts = ConnectOptions {
        connect_timeout: Duration::from_secs(5),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Core,
        expected_server_pid: None,
    };
    Client::connect(&address(home, "core"), token.trim(), opts).unwrap()
}

/// Ends the fake core cleanly (exit 0).
fn shut_the_core_down(home: &Path) {
    core_client(home)
        .call("core.shutdown", json!({}))
        .expect("core.shutdown");
}

/// The engine's pid once it listens.
fn engine_listening(h: &Home) -> u32 {
    wait_until("the engine listening", || {
        !h.engine_events("listening").is_empty()
    });
    h.engine_events("listening")[0]["pid"].as_u64().unwrap() as u32
}

/// `core run` of this build with `PLUR1BUS_ENGINE_BIN` naming the home's fake engine unless `env` names another.
fn rust_run(h: &Home, env: &[(&str, &str)]) -> Run {
    let bin = h.engine_bin().display().to_string();
    let mut env: Vec<(&str, &str)> = env.to_vec();
    if !env.iter().any(|(k, _)| *k == "PLUR1BUS_ENGINE_BIN") {
        env.insert(0, ("PLUR1BUS_ENGINE_BIN", bin.as_str()));
    }
    Run::start(h, &assert_cmd::cargo::cargo_bin("plur1bus"), &env)
}

#[test]
fn core_run_with_the_rust_engine_spawns_it_beside_the_executable_and_stops_it_on_core_exit() {
    let h = Home::new(Some("rust"));
    let mut run = Run::start(&h, &h.plur1bus_beside_the_engine(), &[]);
    let ready = run.next_line();
    let core_pid = ready["pid"].as_u64().unwrap() as u32;
    assert_ne!(
        core_pid,
        run.pid(),
        "the wrapper stays, the core is its child"
    );
    let engine_pid = engine_listening(&h);
    let started = &h.engine_events("started")[0];
    assert_eq!(started["lifeline"], "stdin");
    assert_eq!(started["testInternals"], Value::Null);
    assert_eq!(
        Path::new(started["home"].as_str().unwrap()),
        h.home.as_path()
    );
    uuid::Uuid::parse_str(started["instanceId"].as_str().unwrap()).expect("an incarnation uuid");
    assert_eq!(
        Path::new(started["execPath"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        h.engine_bin().canonicalize().unwrap(),
        "the engine beside the executable"
    );
    #[cfg(unix)]
    {
        // SAFETY: getpgid only reads process attributes.
        let (engine_group, core_group, wrapper_group) = unsafe {
            (
                libc::getpgid(engine_pid as libc::pid_t),
                libc::getpgid(core_pid as libc::pid_t),
                libc::getpgid(run.pid() as libc::pid_t),
            )
        };
        assert_eq!(engine_group, engine_pid as libc::pid_t, "its own group");
        assert_eq!(core_group, wrapper_group, "the core in the wrapper's group");
    }

    shut_the_core_down(&h.home);
    let status = run.wait_exit();
    assert_eq!(status.code(), Some(0), "stderr: {}", run.stderr());
    assert_eq!(h.engine_events("shutdown").len(), 1, "engine.shutdown");
    assert!(!alive(engine_pid), "the engine ended with core run");
    assert_eq!(h.engine_events("started").len(), 1);
}

#[test]
fn plur1bus_engine_bin_overrides_the_path() {
    let h = Home::new(Some("rust"));
    let program = h.plur1bus_beside_the_engine();
    let other = h.fake_engine_in(&h.root.join("other"));
    let other_str = other.display().to_string();
    let mut run = Run::start(&h, &program, &[("PLUR1BUS_ENGINE_BIN", &other_str)]);
    run.next_line();
    engine_listening(&h);
    assert_eq!(
        Path::new(h.engine_events("started")[0]["execPath"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        other.canonicalize().unwrap(),
        "PLUR1BUS_ENGINE_BIN wins over the sibling"
    );
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
}

#[test]
fn test_internals_reach_the_engine_only_with_the_allow_flag() {
    // Without PLUR1BUS_ALLOW_TEST_INTERNALS the spec refuses the seam: no engine, a clear line, the core runs.
    let h = Home::new(Some("rust"));
    let mut run = rust_run(&h, &[("PLUR1BUS_TEST_INTERNALS", "flat-embedder")]);
    let ready = run.next_line();
    assert_eq!(ready["ready"], true);
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
    assert!(
        h.engine_events("started").is_empty(),
        "no engine without the allow flag"
    );
    let err = run.stderr();
    assert!(
        err.contains("Rust engine is not started") && err.contains("authorization"),
        "{err}"
    );
    drop(run);

    let h = Home::new(Some("rust"));
    let mut run = rust_run(
        &h,
        &[
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
            ("PLUR1BUS_ALLOW_TEST_INTERNALS", "1"),
        ],
    );
    run.next_line();
    engine_listening(&h);
    assert_eq!(
        h.engine_events("started")[0]["testInternals"],
        "flat-embedder"
    );
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
}

#[test]
fn the_engine_ready_line_never_reaches_stdout() {
    let h = Home::new(Some("rust"));
    let mut run = rust_run(&h, &[]);
    let engine_pid = engine_listening(&h);
    let first = run.next_line();
    let core_pid = h.core_events("started")[0]["pid"].as_u64().unwrap();
    assert_eq!(
        first["pid"].as_u64(),
        Some(core_pid),
        "the core's ready line first"
    );
    // The engine wrote its ready line right after its `listening` event: drained to stderr, never to stdout.
    let marker = format!("\"pid\":{engine_pid}");
    wait_until("the engine's ready line on stderr", || {
        run.stderr().contains(&marker)
    });
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
    let rest = run.rest();
    assert!(
        rest.iter().all(|l| !l.contains(&marker)),
        "engine output on stdout: {rest:?}"
    );
}

#[test]
fn the_node_engine_keeps_the_exec_path() {
    for implementation in [None, Some("node")] {
        let h = Home::new(implementation);
        // A free lock file left by an earlier Rust engine changes nothing.
        std::fs::write(h.home.join("run/engine.process.lock"), b"").unwrap();
        let mut run = rust_run(&h, &[]);
        let ready = run.next_line();
        assert_eq!(
            ready["pid"].as_u64(),
            Some(u64::from(run.pid())),
            "exec: the core is the process core run started ({implementation:?})"
        );
        shut_the_core_down(&h.home);
        assert_eq!(run.wait_exit().code(), Some(0));
        assert!(h.engine_events("started").is_empty(), "no engine");
    }
}

#[test]
fn a_held_engine_lock_refuses_the_node_core() {
    let h = Home::new(Some("node"));
    let _holder = LockHolder::start(&h.home.join("run/engine.process.lock"));
    let mut run = rust_run(&h, &[]);
    let status = run.wait_exit();
    assert!(!status.success());
    let err = run.stderr();
    assert!(err.contains("run/engine.process.lock"), "{err}");
    assert!(h.core_events("started").is_empty(), "no core started");
    drop(run);

    let out = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--json")
        .arg("--home")
        .arg(&h.home)
        .args(["core", "run"])
        .env("PLUR1BUS_CORE_JS", fixture("fake-core.mjs"))
        .env("PLUR1BUS_NODE", "node")
        .env("FAKE_CORE_EVENTS", &h.core_events)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["error"], "E_CORE_UNAVAILABLE", "{doc}");
    assert_eq!(doc["reason"], "engine-lock-held", "{doc}");
    assert!(h.core_events("started").is_empty(), "no core started");
}

#[test]
fn a_missing_engine_binary_starts_the_core_degraded_with_a_clear_message() {
    let h = Home::new(Some("rust"));
    let missing = h.root.join("missing").join(format!("plur1bus-engine{EXE}"));
    let missing = missing.display().to_string();
    let mut run = rust_run(&h, &[("PLUR1BUS_ENGINE_BIN", &missing)]);
    let ready = run.next_line();
    assert_eq!(ready["ready"], true);
    let err = run.stderr();
    assert!(
        err.contains("Rust engine is not started") && err.contains("engine-unavailable"),
        "{err}"
    );
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
}

#[cfg(unix)]
#[test]
fn sigterm_stops_the_core_first_and_then_the_engine() {
    for (sig, event) in [(libc::SIGTERM, "sigterm"), (libc::SIGHUP, "sighup")] {
        let h = Home::new(Some("rust"));
        let mut run = rust_run(&h, &[]);
        run.next_line();
        let engine_pid = engine_listening(&h);
        signal(run.pid(), sig);
        let status = run.wait_exit();
        assert_eq!(
            status.code(),
            Some(0),
            "the core's own exit: {}",
            run.stderr()
        );
        assert_eq!(
            h.core_events(event).len(),
            1,
            "{event} forwarded to the core"
        );
        let core_end = h.core_events("exiting")[0]["at"].as_u64().unwrap();
        let shutdown = &h.engine_events("shutdown");
        assert_eq!(shutdown.len(), 1, "engine.shutdown after the core");
        assert!(shutdown[0]["at"].as_u64().unwrap() >= core_end);
        assert!(!alive(engine_pid));
    }
}

#[cfg(unix)]
#[test]
fn sigint_does_not_end_the_wrapper_and_is_not_forwarded() {
    let h = Home::new(Some("rust"));
    let mut run = rust_run(&h, &[]);
    run.next_line();
    engine_listening(&h);
    signal(run.pid(), libc::SIGINT);
    // A round trip through the core: the wrapper, which a default SIGINT ends at once, still runs.
    core_client(&h.home)
        .call("core.status", json!({}))
        .expect("the core serves");
    assert!(run.child.try_wait().unwrap().is_none(), "the wrapper stays");
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
    assert!(
        h.core_events("sigint").is_empty(),
        "SIGINT is the terminal's to deliver"
    );
}

#[cfg(unix)]
#[test]
fn a_killed_core_still_stops_the_engine() {
    let h = Home::new(Some("rust"));
    let mut run = rust_run(&h, &[]);
    let core_pid = run.next_line()["pid"].as_u64().unwrap() as u32;
    let engine_pid = engine_listening(&h);
    signal(core_pid, libc::SIGKILL);
    let status = run.wait_exit();
    assert_eq!(status.code(), Some(130), "an end by a signal");
    assert_eq!(h.engine_events("shutdown").len(), 1);
    assert!(!alive(engine_pid));
}

#[test]
fn an_engine_that_ignores_shutdown_is_killed_after_the_deadline() {
    let h = Home::new(Some("rust"));
    let mut run = rust_run(
        &h,
        &[
            ("FAKE_ENGINE_MODE", "hang"),
            ("FAKE_ENGINE_IGNORE_SIGTERM", "1"),
        ],
    );
    run.next_line();
    let engine_pid = engine_listening(&h);
    let asked = Instant::now();
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
    let took = asked.elapsed();
    assert!(!alive(engine_pid), "killed");
    assert!(
        h.engine_events("exiting").is_empty(),
        "it never ended itself"
    );
    #[cfg(unix)]
    {
        assert_eq!(
            h.engine_events("sigterm").len(),
            1,
            "SIGTERM after the undelivered shutdown"
        );
        assert!(
            took >= Duration::from_millis(4_500),
            "the kill waits for the deadline: {took:?}"
        );
        let err = run.stderr();
        assert!(err.contains("did not stop within 5 s"), "{err}");
    }
    assert!(took < WAIT, "{took:?}");
}

#[test]
fn the_exit_code_of_the_core_is_passed_through() {
    let h = Home::new(Some("rust"));
    let mut run = rust_run(&h, &[("FAKE_CORE_MODE", "exit:7")]);
    assert_eq!(run.wait_exit().code(), Some(7), "{}", run.stderr());
    for started in h.engine_events("started") {
        assert!(
            !alive(started["pid"].as_u64().unwrap() as u32),
            "the engine ended too"
        );
    }
}

#[test]
fn an_engine_that_ends_while_the_core_runs_is_reported_and_not_restarted() {
    let h = Home::new(Some("rust"));
    let mut run = rust_run(&h, &[("FAKE_ENGINE_MODE", "crash-after:100")]);
    run.next_line();
    wait_until("the engine's crash", || {
        !h.engine_events("exiting").is_empty()
    });
    wait_until("the line on stderr", || {
        run.stderr().contains("does not restart it")
    });
    core_client(&h.home)
        .call("core.status", json!({}))
        .expect("the core keeps serving");
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0));
    assert_eq!(h.engine_events("started").len(), 1, "no restart");
}

/// The real engine (needs a build, given as PLUR1BUS_ENGINE_BIN, which is only run here) under `core run` with the
/// flat embedder: it serves `engine.status` with the core, and is gone when `core run` has ended.
#[test]
#[ignore = "needs a built plur1bus-engine in PLUR1BUS_ENGINE_BIN"]
fn the_real_engine_runs_under_core_run_and_ends_with_it() {
    let bin = std::env::var("PLUR1BUS_ENGINE_BIN").expect("PLUR1BUS_ENGINE_BIN");
    let h = Home::new(Some("rust"));
    let mut run = rust_run(
        &h,
        &[
            ("PLUR1BUS_ENGINE_BIN", &bin),
            ("PLUR1BUS_TEST_INTERNALS", "flat-embedder"),
            ("PLUR1BUS_ALLOW_TEST_INTERNALS", "1"),
        ],
    );
    run.next_line();
    let mut pid = 0;
    wait_until("the real engine serving engine.status", || {
        let Ok(token) = std::fs::read_to_string(h.home.join("run/engine.token")) else {
            return false;
        };
        let opts = ConnectOptions {
            connect_timeout: Duration::from_secs(2),
            call_timeout: Duration::from_secs(5),
            endpoint: Endpoint::Engine,
            expected_server_pid: None,
        };
        let Ok(mut c) = Client::connect(&address(&h.home, "engine"), token.trim(), opts) else {
            return false;
        };
        pid = c.hello()["pid"].as_u64().unwrap_or(0) as u32;
        c.call("engine.status", json!({})).is_ok()
    });
    assert!(alive(pid));
    shut_the_core_down(&h.home);
    assert_eq!(run.wait_exit().code(), Some(0), "{}", run.stderr());
    assert!(!alive(pid), "the real engine ended with core run");
    assert!(
        !h.home.join("run/engine.token").exists(),
        "its run files removed"
    );
}

/// The argv of this test binary's [`engine_lock_holder_for_core_run`].
fn lock_helper_argv() -> Vec<String> {
    vec![
        std::env::current_exe().unwrap().display().to_string(),
        "engine_lock_holder_for_core_run".into(),
        "--exact".into(),
        "--ignored".into(),
        "--nocapture".into(),
        "--test-threads=1".into(),
    ]
}

/// A process holding `run/engine.process.lock` with the OS lock (as a live engine does): killed when dropped.
struct LockHolder(Child);
impl LockHolder {
    fn start(path: &Path) -> Self {
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

/// Helper process for [`a_held_engine_lock_refuses_the_node_core`] (a no-op otherwise): holds the OS lock on
/// `ENGINE_LOCK_HOLDER_PATH` until its stdin closes.
#[test]
#[ignore = "helper process for the engine lock test; does nothing without ENGINE_LOCK_HOLDER_PATH"]
fn engine_lock_holder_for_core_run() {
    use std::io::Write;
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
