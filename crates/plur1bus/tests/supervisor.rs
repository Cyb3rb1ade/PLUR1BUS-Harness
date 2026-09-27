//! `plur1bus supervise --no-core`: the endpoint, the run files, `supervisor.auth`, `daemon.status|stop`, single
//! instance and stale run files. Every test uses its own temp home.
use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::{Client, ConnectOptions, Endpoint, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(10);

/// Kills the supervisor if a test ends before it exits.
struct Supervisor {
    child: Child,
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Supervisor {
    fn pid(&self) -> u32 {
        self.child.id()
    }
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

fn command(home: &Path) -> Command {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
    c.arg("--home")
        .arg(home)
        .args(["supervise", "--no-core"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env_remove("PLUR1BUS_SUPERVISOR_TIME_SCALE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    c
}

fn run_dir(home: &Path) -> PathBuf {
    home.join("run")
}

fn wait_for(path: &Path) {
    let deadline = Instant::now() + WAIT;
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "{} did not appear",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Starts `supervise --no-core` and waits for `run/supervisor.token`.
fn start(home: &Path) -> Supervisor {
    let child = command(home).spawn().unwrap();
    let s = Supervisor { child };
    wait_for(&run_dir(home).join("supervisor.token"));
    s
}

/// Same rule as `paths::supervisor_address` (the tempdir home is already absolute and normalised).
fn address(home: &Path) -> String {
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

fn token(home: &Path) -> String {
    std::fs::read_to_string(run_dir(home).join("supervisor.token"))
        .unwrap()
        .trim()
        .to_string()
}

fn opts() -> ConnectOptions {
    ConnectOptions {
        connect_timeout: Duration::from_secs(2),
        call_timeout: Duration::from_secs(5),
        endpoint: Endpoint::Supervisor,
        expected_server_pid: None,
    }
}

/// Connects and authenticates, retrying while the supervisor finishes binding (the token is written first).
fn client(home: &Path) -> Client {
    let deadline = Instant::now() + WAIT;
    loop {
        match Client::connect(&address(home), &token(home), opts()) {
            Ok(c) => return c,
            Err(e) if Instant::now() < deadline => {
                let _ = e;
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => panic!("cannot connect to the supervisor: {e}"),
        }
    }
}

fn validator(pointer: &str) -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
    let doc = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": format!("#/$defs/methods/{pointer}"),
        "$defs": schema["$defs"],
    });
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&doc)
        .unwrap()
}

fn assert_valid(pointer: &str, v: &Value) {
    let val = validator(pointer);
    let errors: Vec<String> = val.iter_errors(v).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{pointer}: {errors:?} in {v}");
}

fn call_error(e: RpcError) -> (ErrorCode, Option<String>) {
    match e {
        RpcError::Call { error, reason, .. } => (error, reason),
        other => panic!("expected a call error, got {other}"),
    }
}

/// A raw connection for tests that look below `Client` (the close after a refused auth).
#[cfg(unix)]
fn raw(home: &Path) -> Box<dyn ReadWrite> {
    let s = std::os::unix::net::UnixStream::connect(address(home)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    Box::new(s)
}
#[cfg(windows)]
fn raw(home: &Path) -> Box<dyn ReadWrite> {
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
trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn stop_files_gone(home: &Path) {
    for f in ["supervisor.token", "supervisor.pid"] {
        assert!(!run_dir(home).join(f).exists(), "{f} left behind");
    }
    #[cfg(unix)]
    assert!(
        !run_dir(home).join("supervisor.sock").exists(),
        "socket left behind"
    );
}

#[test]
fn supervise_writes_token_and_pid_and_answers_auth_with_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let sup = start(home);
    let c = client(home);

    let tok = token(home);
    assert_eq!(tok.len(), 64);
    assert!(
        tok.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "{tok}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(run_dir(home).join("supervisor.token")), 0o600);
        assert_eq!(mode(run_dir(home).join("supervisor.pid")), 0o600);
        assert_eq!(mode(run_dir(home)), 0o700);
        assert_eq!(mode(run_dir(home).join("supervisor.sock")), 0o600);
    }
    let pid_line = std::fs::read_to_string(run_dir(home).join("supervisor.pid")).unwrap();
    assert!(pid_line.ends_with('\n'));
    let mut parts = pid_line.split_whitespace();
    assert_eq!(parts.next().unwrap(), sup.pid().to_string());
    let instance = parts.next().unwrap();
    assert_eq!(instance.len(), 36, "{instance}");
    assert!(parts.next().is_none());

    let hello = c.hello();
    assert_valid("supervisor.auth/result", hello);
    assert_eq!(hello["rpc"], plur1bus_rpc::RPC_VERSION);
    assert_eq!(hello["pid"], sup.pid());
    assert_eq!(hello["instanceId"], instance);
    let methods = &hello["capabilities"]["methods"];
    assert!(methods.get("daemon.status").is_some(), "{hello}");
    assert!(methods.get("daemon.stop").is_some());
    assert!(methods.get("memory.recall").is_none());
    assert!(methods.get("module.install").is_some(), "{hello}");
    assert_eq!(
        hello["capabilities"]["features"],
        json!(["adoption", "config", "lifelines", "modules"])
    );

    let log = std::fs::read_to_string(home.join("logs").join("supervisor.log")).unwrap();
    assert!(
        log.lines()
            .any(|l| l.contains("\"msg\":\"supervisor ready\"")),
        "{log}"
    );
}

#[test]
fn a_wrong_token_is_refused_and_closed() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let _sup = start(home);
    drop(client(home)); // bound

    let wrong = "0".repeat(64);
    assert_ne!(wrong, token(home));
    let e = Client::connect(&address(home), &wrong, opts())
        .err()
        .expect("refused");
    assert_eq!(
        call_error(e),
        (ErrorCode::EUnauthorized, Some("bad-token".into()))
    );

    let mut s = raw(home);
    let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "supervisor.auth", "params": { "token": wrong } });
    s.write_all(format!("{req}\n").as_bytes()).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["error"]["data"]["error"], "E_UNAUTHORIZED");
    let mut rest = Vec::new();
    // The supervisor closes its side: the read ends (EOF, or a reset on Windows) instead of timing out.
    let n = r.read_to_end(&mut rest).unwrap_or(0);
    assert_eq!(n, 0, "connection still open after a refused auth");

    // A call before auth is refused but does not close the connection.
    let mut s = raw(home);
    let req = json!({ "jsonrpc": "2.0", "id": 7, "method": "daemon.status", "params": {} });
    s.write_all(format!("{req}\n").as_bytes()).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["error"]["data"]["reason"], "auth-required");
}

#[test]
fn daemon_status_validates_against_the_schema() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let sup = start(home);
    let mut c = client(home);
    let st = c.call("daemon.status", json!({})).unwrap();
    assert_valid("daemon.status/result", &st);
    assert_eq!(st["children"], json!([]));
    assert_eq!(st["supervisor"]["pid"], sup.pid());
    assert_eq!(st["supervisor"]["process"]["state"], "ready");
    assert_eq!(st["supervisor"]["instanceId"], c.hello()["instanceId"]);

    // Under --no-core there is nothing to start.
    let e = c.call("daemon.start", json!({})).unwrap_err();
    assert_eq!(
        call_error(e),
        (ErrorCode::ENotAvailable, Some("no-children".into()))
    );
    // An unknown method is method-not-found.
    let e = c.call("memory.recall", json!({})).unwrap_err();
    assert_eq!(
        call_error(e),
        (ErrorCode::EInternal, Some("method-not-found".into()))
    );
}

#[test]
fn unknown_params_are_e_invalid_params() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let mut sup = start(home);
    let mut c = client(home);
    let e = c.call("daemon.stop", json!({ "x": 1 })).unwrap_err();
    assert_eq!(call_error(e).0, ErrorCode::EInvalidParams);
    let e = c
        .call("daemon.stop", json!({ "budgetMs": 120_001 }))
        .unwrap_err();
    assert_eq!(call_error(e).0, ErrorCode::EInvalidParams);
    let e = c
        .call("daemon.status", json!({ "verbose": true }))
        .unwrap_err();
    assert_eq!(call_error(e).0, ErrorCode::EInvalidParams);
    // Still serving: the refused stop did not stop anything.
    assert!(c.call("daemon.status", json!({})).is_ok());
    assert!(sup.child.try_wait().unwrap().is_none());
}

#[test]
fn daemon_stop_exits_zero_and_removes_run_files() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let mut sup = start(home);
    let mut c = client(home);
    let r = c.call("daemon.stop", json!({ "budgetMs": 1000 })).unwrap();
    assert_valid("daemon.stop/result", &r);
    assert_eq!(r, json!({ "accepted": true }));
    let status = sup.wait_exit(WAIT);
    assert_eq!(status.code(), Some(0));
    stop_files_gone(home);
    let log = std::fs::read_to_string(home.join("logs").join("supervisor.log")).unwrap();
    assert!(log.contains("\"msg\":\"supervisor stopped\""), "{log}");
}

#[test]
fn a_second_supervisor_on_the_same_home_exits_3() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let first = start(home);
    let before = token(home);
    drop(client(home));

    let out = command(home).output().unwrap();
    assert_eq!(out.status.code(), Some(3));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains(&format!("supervisor already running (pid {})", first.pid())),
        "{stderr}"
    );
    // The loser touched nothing: the first supervisor still answers with the same token and pid file.
    assert_eq!(token(home), before);
    let mut c = client(home);
    assert_eq!(
        c.call("daemon.status", json!({})).unwrap()["supervisor"]["pid"],
        first.pid()
    );
}

#[test]
fn a_second_supervisor_under_launchd_exits_0_with_the_message() {
    // Ruling B16: under launchd (`KeepAlive.SuccessfulExit = false`), the loser's non-transient exit 3 must become
    // 0, or launchd loops restarting a supervisor that can never win the lock.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let first = start(home);
    drop(client(home));

    let out = command(home)
        .env("PLUR1BUS_SERVICE_MANAGER", "launchd")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains(&format!("supervisor already running (pid {})", first.pid())),
        "{stderr}"
    );
    assert!(stderr.contains("exiting 0 instead of 3"), "{stderr}");
    // The message also lands in logs/supervisor.log, opened ad hoc since fail(3) precedes the real Log::open.
    let log = std::fs::read_to_string(home.join("logs").join("supervisor.log")).unwrap();
    assert!(log.contains("exiting 0 instead of 3"), "{log}");
    // The winner is unaffected: still the one supervisor answering for this home.
    let mut c = client(home);
    assert_eq!(
        c.call("daemon.status", json!({})).unwrap()["supervisor"]["pid"],
        first.pid()
    );
}

/// Holds `run/supervisor.lock` the way `commands::module::offline_lock` does for an offline `module install`:
/// same file, same exclusive `try_lock`, no supervisor endpoint behind it.
fn hold_lock_like_an_offline_install(home: &Path) -> std::fs::File {
    std::fs::create_dir_all(run_dir(home)).unwrap();
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(run_dir(home).join("supervisor.lock"))
        .unwrap();
    f.try_lock().unwrap();
    f
}

#[test]
fn a_supervisor_under_launchd_that_finds_the_lock_held_by_an_offline_install_exits_1() {
    // Final review I1: nobody answers on the address, so this is not "another supervisor runs" (3, mapped to 0
    // under launchd, which KeepAlive{SuccessfulExit:false} would never restart). It must exit 1, which launchd
    // retries once the offline mutation has released the lock.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let lock = hold_lock_like_an_offline_install(home);

    let out = command(home)
        .env("PLUR1BUS_SERVICE_MANAGER", "launchd")
        .output()
        .unwrap();
    drop(lock);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("no supervisor answered"), "{stderr}");
    assert!(!stderr.contains("exiting 0 instead of"), "{stderr}");
    // It never became a supervisor: no token, no pid file.
    assert!(!run_dir(home).join("supervisor.token").exists());
    assert!(!run_dir(home).join("supervisor.pid").exists());
}

#[test]
fn a_supervisor_that_finds_the_lock_released_during_its_probe_wait_starts() {
    // The offline mutation ends within the 3 s probe wait: the second try_lock wins and this process serves.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let lock = hold_lock_like_an_offline_install(home);
    let child = command(home)
        .env("PLUR1BUS_SERVICE_MANAGER", "launchd")
        .spawn()
        .unwrap();
    let mut sup = Supervisor { child };
    std::thread::sleep(Duration::from_millis(1000));
    drop(lock);
    wait_for(&run_dir(home).join("supervisor.token"));
    let mut c = client(home);
    assert_eq!(
        c.call("daemon.status", json!({})).unwrap()["supervisor"]["pid"],
        sup.pid()
    );
    c.call("daemon.stop", json!({ "budgetMs": 1000 })).unwrap();
    assert_eq!(sup.wait_exit(WAIT).code(), Some(0));
}

#[test]
fn two_supervisors_starting_at_once_leave_exactly_one() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let mut a = command(home).spawn().unwrap();
    let mut b = command(home).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    wait_for(&run_dir(home).join("supervisor.token"));
    let mut c = client(home);
    let pid = c.call("daemon.status", json!({})).unwrap()["supervisor"]["pid"]
        .as_u64()
        .unwrap() as u32;
    let (winner, loser) = if pid == a.id() {
        (&mut a, &mut b)
    } else {
        (&mut b, &mut a)
    };
    let status = {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(s) = loser.try_wait().unwrap() {
                break s;
            }
            assert!(Instant::now() < deadline, "the loser did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    assert_eq!(status.code(), Some(3));
    assert!(winner.try_wait().unwrap().is_none(), "the winner exited");
    // The winner's token is still the one on disk (a fresh connection authenticates).
    drop(client(home));
    let _ = winner.kill();
    let _ = winner.wait();
}

#[cfg(unix)]
#[test]
fn stale_supervisor_socket_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    std::fs::create_dir_all(run_dir(home)).unwrap();
    // A power loss leaves the socket file, the token and the pid file with no process behind them.
    drop(std::os::unix::net::UnixListener::bind(run_dir(home).join("supervisor.sock")).unwrap());
    assert!(run_dir(home).join("supervisor.sock").exists());
    std::fs::write(
        run_dir(home).join("supervisor.pid"),
        "999999 00000000-0000-4000-8000-000000000000\n",
    )
    .unwrap();
    std::fs::write(run_dir(home).join("supervisor.token"), "a".repeat(64)).unwrap();

    let sup = start(home);
    // start() returned on the stale token; wait for the fresh one.
    let deadline = Instant::now() + WAIT;
    while token(home) == "a".repeat(64) {
        assert!(Instant::now() < deadline, "token not replaced");
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut c = client(home);
    assert_eq!(c.hello()["pid"], sup.pid());
    assert_eq!(
        c.call("daemon.status", json!({})).unwrap()["supervisor"]["pid"],
        sup.pid()
    );
    let pid_line = std::fs::read_to_string(run_dir(home).join("supervisor.pid")).unwrap();
    assert!(
        pid_line.starts_with(&format!("{} ", sup.pid())),
        "{pid_line}"
    );
}

#[cfg(unix)]
#[test]
fn sigterm_stops_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let mut sup = start(home);
    drop(client(home));
    // SAFETY: plain kill(2) on our own child.
    assert_eq!(unsafe { libc::kill(sup.pid() as i32, libc::SIGTERM) }, 0);
    assert_eq!(sup.wait_exit(WAIT).code(), Some(0));
    stop_files_gone(home);
}

#[test]
fn no_core_without_test_internals_exits_2() {
    let dir = tempfile::tempdir().unwrap();
    let out = command(dir.path())
        .env_remove("PLUR1BUS_ALLOW_TEST_INTERNALS")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!run_dir(dir.path()).join("supervisor.token").exists());
}

#[test]
fn an_invalid_time_scale_exits_2() {
    let dir = tempfile::tempdir().unwrap();
    for bad in ["0", "-1", "NaN", "inf"] {
        let out = command(dir.path())
            .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", bad)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{bad}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("PLUR1BUS_SUPERVISOR_TIME_SCALE"));
    }
}
