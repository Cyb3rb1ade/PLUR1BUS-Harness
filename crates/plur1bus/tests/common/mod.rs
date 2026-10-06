//! Shared by `config_service.rs` and `cli.rs`: a `supervise --no-core` process in a temp home, an authenticated
//! `Client`, and a raw `config.watch` connection whose notifications a reader thread collects.
#![allow(dead_code)]
use plur1bus_rpc::{Client, ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const WAIT: Duration = Duration::from_secs(10);
/// `PLUR1BUS_SUPERVISOR_TIME_SCALE` of these tests: the watcher polls config.json every 1000 ms × 0.2.
pub const SCALE: &str = "0.2";
pub const TICK: Duration = Duration::from_millis(200);

/// Kills the supervisor if a test ends before it exits.
pub struct Supervisor {
    pub child: Child,
    pub home: PathBuf,
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        #[cfg(unix)]
        // SAFETY: plain signal to our own child; a stopped supervisor must continue to die.
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGCONT);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn wait_until(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Starts `plur1bus supervise --no-core` in `home` and waits until it answers `supervisor.auth`.
pub fn start(home: &Path) -> Supervisor {
    start_scaled(home, SCALE)
}

/// [`start`] at time scale `scale` (the watcher ticks every 1000 ms × `scale`).
pub fn start_scaled(home: &Path, scale: &str) -> Supervisor {
    let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(home)
        .args(["supervise", "--no-core"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", scale)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let s = Supervisor {
        child,
        home: home.to_path_buf(),
    };
    wait_until("run/supervisor.token", WAIT, || {
        home.join("run/supervisor.token").exists()
    });
    drop(client(home));
    s
}

/// `plur1bus supervise` in `home` with `tests/fixtures/fake-core.mjs` as its core (events appended to `events`), at
/// time scale `scale`, plus `env`; waits until it answers `supervisor.auth`.
pub fn start_with_core(
    home: &Path,
    events: &Path,
    scale: &str,
    env: &[(&str, &str)],
) -> Supervisor {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-core.mjs");
    let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(home)
        .arg("supervise")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", scale)
        .env("PLUR1BUS_CORE_JS", &fixture)
        .env("PLUR1BUS_NODE", "node")
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env("FAKE_CORE_EVENTS", events)
        .env("FAKE_CORE_GRACE_MS", "300")
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let s = Supervisor {
        child,
        home: home.to_path_buf(),
    };
    wait_until("run/supervisor.token", WAIT, || {
        home.join("run/supervisor.token").exists()
    });
    drop(client(home));
    LOG_HOME.with(|h| *h.borrow_mut() = Some(home.to_path_buf()));
    s
}

thread_local! {
    /// The home of the supervisor this test thread last started with a core ([`start_with_core`]), for [`log_tails`].
    static LOG_HOME: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Lines kept from the end of each log by [`log_tails`].
const TAIL_LINES: usize = 25;

/// For a failure message: the last lines of every module's own log and captured output (`logs/module-*`) and of
/// `logs/supervisor.log`, in the home this test thread last started a supervisor with a core in. A module that never
/// becomes ready leaves its reason there (CI runs cannot be inspected after the temp home is gone).
pub fn log_tails() -> String {
    let Some(home) = LOG_HOME.with(|h| h.borrow().clone()) else {
        return String::new();
    };
    let logs = home.join("logs");
    let mut names: Vec<String> = std::fs::read_dir(&logs)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("module-"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.push("supervisor.log".into());
    let mut out = String::new();
    for name in names {
        let text = match std::fs::read(logs.join(&name)) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => format!("(unreadable: {e})"),
        };
        let lines: Vec<&str> = text.lines().collect();
        let tail = &lines[lines.len().saturating_sub(TAIL_LINES)..];
        out.push_str(&format!(
            "\n--- logs/{name} (last {} of {} lines) ---\n",
            tail.len(),
            lines.len()
        ));
        for l in tail {
            out.push_str(l);
            out.push('\n');
        }
    }
    out
}

/// The fake core's events (one JSON object per line) named `name`.
pub fn fake_core_events(events: &Path, name: &str) -> Vec<Value> {
    std::fs::read_to_string(events)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|e| e["event"] == name)
        .collect()
}

/// `daemon.status`'s core child (validated), or null.
pub fn core_child(c: &mut Client) -> Value {
    let st = c.call("daemon.status", json!({})).unwrap();
    assert_valid("methods/daemon.status/result", &st);
    st["children"].get(0).cloned().unwrap_or(Value::Null)
}

/// Polls `daemon.status` until the core child satisfies `f`; returns it.
pub fn wait_child(
    c: &mut Client,
    what: &str,
    within: Duration,
    f: impl Fn(&Value) -> bool,
) -> Value {
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

/// Same rule as `paths::supervisor_address` (the tempdir home is already absolute and normalised).
pub fn address(home: &Path) -> String {
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

pub fn token(home: &Path) -> String {
    std::fs::read_to_string(home.join("run/supervisor.token"))
        .unwrap()
        .trim()
        .to_string()
}

/// Connects and authenticates, retrying while the supervisor finishes binding (the token is written first).
pub fn client(home: &Path) -> Client {
    let opts = ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None,
    };
    let deadline = Instant::now() + WAIT;
    loop {
        match Client::connect(&address(home), &token(home), opts.clone()) {
            Ok(c) => return c,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("cannot connect to the supervisor: {e}"),
        }
    }
}

pub trait ReadWrite: Read + Write + Send {}
impl<T: Read + Write + Send> ReadWrite for T {}

/// A raw connection to the supervisor.
#[cfg(unix)]
pub fn raw(home: &Path) -> Box<dyn ReadWrite> {
    Box::new(std::os::unix::net::UnixStream::connect(address(home)).unwrap())
}
#[cfg(windows)]
pub fn raw(home: &Path) -> Box<dyn ReadWrite> {
    use std::os::windows::fs::OpenOptionsExt;
    const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
    Box::new(
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(address(home))
            .unwrap(),
    )
}

/// Writes `supervisor.auth` (id 1) and `config.watch` (id 2) on a raw connection.
pub fn send_watch(conn: &mut dyn ReadWrite, home: &Path) {
    let lines = format!(
        "{}\n{}\n",
        json!({ "jsonrpc": "2.0", "id": 1, "method": "supervisor.auth", "params": { "token": token(home) } }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "config.watch", "params": {} }),
    );
    conn.write_all(lines.as_bytes()).unwrap();
    conn.flush().unwrap();
}

/// A `config.watch` connection. Everything is written before the reader thread starts (a synchronous Windows pipe
/// handle serialises reads and writes), so the thread only reads; every line it reads goes to `rx`.
pub struct Watch {
    rx: mpsc::Receiver<Value>,
    /// The `config.watch` result.
    pub result: Value,
}

impl Watch {
    /// Subscribes; panics unless `config.watch` succeeds.
    pub fn open(home: &Path) -> Watch {
        let (rx, reply) = Watch::raw_watch(home);
        assert!(
            reply.get("result").is_some(),
            "config.watch failed: {reply}"
        );
        Watch {
            rx,
            result: reply["result"].clone(),
        }
    }

    /// Sends auth and `config.watch`; returns the line receiver and the `config.watch` reply (result or error).
    pub fn raw_watch(home: &Path) -> (mpsc::Receiver<Value>, Value) {
        let mut conn = raw(home);
        send_watch(conn.as_mut(), home);
        let (tx, rx) = mpsc::channel();
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
        let auth = rx.recv_timeout(WAIT).expect("no supervisor.auth reply");
        assert_eq!(auth["id"], 1, "{auth}");
        assert!(auth.get("result").is_some(), "{auth}");
        let reply = rx.recv_timeout(WAIT).expect("no config.watch reply");
        assert_eq!(reply["id"], 2, "{reply}");
        (rx, reply)
    }

    /// The next `config.changed` params within `within`, or `None`.
    pub fn next_change(&self, within: Duration) -> Option<Value> {
        match self.rx.recv_timeout(within) {
            Ok(v) if v["method"] == "config.changed" => Some(v["params"].clone()),
            Ok(v) => panic!("unexpected line on the watch connection: {v}"),
            Err(_) => None,
        }
    }

    /// Every `config.changed` that arrives within `within`.
    pub fn changes_within(&self, within: Duration) -> Vec<Value> {
        let deadline = Instant::now() + within;
        let mut out = Vec::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match self.next_change(left) {
                Some(c) => out.push(c),
                None => break,
            }
        }
        out
    }
}

/// A validator for `#/$defs/<pointer>` of the RPC schema.
pub fn assert_valid(pointer: &str, v: &Value) {
    let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
    let doc = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": format!("#/$defs/{pointer}"),
        "$defs": schema["$defs"],
    });
    let val = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&doc)
        .unwrap();
    let errors: Vec<String> = val.iter_errors(v).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{pointer}: {errors:?} in {v}");
}

/// Runs `cmd` with its stdout a pipe whose reader is already gone (`plur1bus … | head -1` after `head` exited), so
/// every write to stdout fails with a broken pipe from the first byte on. Hard 60 s timeout (the child is killed).
/// Returns the exit code (`None` if killed by a signal or the timeout) and stderr.
pub fn run_closed_stdout(cmd: &mut Command) -> (Option<i32>, String) {
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let mut child = cmd
        .stdout(Stdio::from(writer))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break st.code();
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    (status, t.join().unwrap())
}

/// Leaves a socket file at `path` with nothing listening behind it, and proves the connect is refused.
///
/// `UnixListener::bind` + `drop` is not enough on macOS: std sets `FD_CLOEXEC` after `socket()`, so a child another
/// test thread spawns in that window inherits the listening fd and keeps the "dead" socket alive until it exits. A
/// connect then succeeds (and is closed by the child) instead of being refused. The inheriting child holds the old
/// inode, so removing the file and binding a fresh socket escapes it; the connect check makes the precondition
/// explicit instead of assumed.
#[cfg(unix)]
pub fn dead_socket(path: &std::path::Path) {
    use std::os::unix::net::{UnixListener, UnixStream};
    for _ in 0..100 {
        let _ = std::fs::remove_file(path);
        drop(UnixListener::bind(path).unwrap());
        match UnixStream::connect(path) {
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => return,
            _ => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }
    panic!("{}: could not leave a refused socket", path.display());
}

/// Runs `cmd` with stdout a regular file in a temp dir that cannot grow (`RLIMIT_FSIZE` at its size, `SIGXFSZ` ignored), so
/// every stdout write fails with `EFBIG`: a real write error, portable to macOS (no `/dev/full`; std also ignores
/// `EBADF` on stdout, so a read-only descriptor does not count). Returns the exit code and stderr.
#[cfg(unix)]
pub fn run_stdout_write_error(cmd: &mut Command) -> (Option<i32>, String) {
    use std::os::unix::process::CommandExt;
    let dir = tempfile::tempdir().unwrap();
    // The limit is a few KiB, not 0, so the command's own small files still work; stdout is pre-filled to the limit.
    const LIMIT: u64 = 256 * 1024;
    let path = dir.path().join("stdout");
    std::fs::write(&path, vec![0u8; LIMIT as usize]).unwrap();
    let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    std::io::Seek::seek(&mut file, std::io::SeekFrom::End(0)).unwrap();
    // SAFETY: only async-signal-safe libc calls between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
            let lim = libc::rlimit {
                rlim_cur: LIMIT as libc::rlim_t,
                rlim_max: LIMIT as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &lim) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let out = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}
