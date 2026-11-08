//! The front door (P4-10) as a process, against a fake legacy core that is this test binary itself (see
//! `front_door_support/fake_legacy.rs`): run files and their modes, authentication of every caller kind, the relay, the
//! native and completed methods, notifications, back-pressure, adoption and the lifeline, the stop paths, and that no
//! credential ever shows up in the front door's output or in an error.
//!
//! `harness = false`: `main` runs the fake when it is started as `fake-legacy`, else every test below in turn (a test name
//! argument filters them).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    clippy::needless_pass_by_value
)]

#[path = "front_door_support/fake_legacy.rs"]
mod fake_legacy;

use plur1bus_core::auth::Secret;
use plur1bus_rpc::transport::{self, Stream};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("fake-legacy") {
        fake_legacy::run(&args);
    }
    let filter: Vec<&String> = args
        .iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();
    let tests: &[(&str, fn())] = &[
        (
            "ready_line_run_files_and_modes",
            ready_line_run_files_and_modes,
        ),
        (
            "owner_handshake_and_a_byte_exact_relay",
            owner_handshake_and_a_byte_exact_relay,
        ),
        (
            "before_the_handshake_the_front_door_answers",
            before_the_handshake_the_front_door_answers,
        ),
        (
            "an_over_long_line_closes_the_connection",
            an_over_long_line_closes_the_connection,
        ),
        ("status_names_the_front_door", status_names_the_front_door),
        (
            "subscriptions_get_the_front_doors_core_state_and_a_shutdown_stops_cleanly",
            subscriptions_get_the_front_doors_core_state_and_a_shutdown_stops_cleanly,
        ),
        (
            "api_delegations_are_checked_here_and_forwarded",
            api_delegations_are_checked_here_and_forwarded,
        ),
        (
            "the_engine_authenticates_with_its_own_token",
            the_engine_authenticates_with_its_own_token,
        ),
        (
            "a_scoped_client_cannot_gain_identity_through_the_relay",
            a_scoped_client_cannot_gain_identity_through_the_relay,
        ),
        (
            "the_bridge_is_for_the_legacy_core_only",
            the_bridge_is_for_the_legacy_core_only,
        ),
        ("adoption_and_the_lifeline", adoption_and_the_lifeline),
        (
            "a_legacy_core_that_fails_to_start_decides_the_exit_code",
            a_legacy_core_that_fails_to_start_decides_the_exit_code,
        ),
        (
            "a_legacy_core_that_dies_ends_the_front_door",
            a_legacy_core_that_dies_ends_the_front_door,
        ),
        (
            "a_client_whose_link_cannot_open_sees_the_core_go_away",
            a_client_whose_link_cannot_open_sees_the_core_go_away,
        ),
        (
            "a_second_front_door_is_locked_out",
            a_second_front_door_is_locked_out,
        ),
        (
            "a_slow_client_is_disconnected_and_the_core_stays_up",
            a_slow_client_is_disconnected_and_the_core_stays_up,
        ),
        ("stale_and_live_sockets", stale_and_live_sockets),
        ("sigterm_stops_the_pair", sigterm_stops_the_pair),
        ("credentials_never_leak", credentials_never_leak),
        (
            "frames_serde_cannot_read_reach_the_client_as_written",
            frames_serde_cannot_read_reach_the_client_as_written,
        ),
        (
            "an_adoption_with_a_lone_surrogate_in_meta_attaches_the_lifeline",
            an_adoption_with_a_lone_surrogate_in_meta_attaches_the_lifeline,
        ),
        (
            "a_client_cannot_answer_the_front_doors_own_requests",
            a_client_cannot_answer_the_front_doors_own_requests,
        ),
        (
            "an_answer_that_is_no_object_is_refused_not_patched",
            an_answer_that_is_no_object_is_refused_not_patched,
        ),
        (
            "a_client_shutdown_reaches_every_subscriber_as_stopping_first",
            a_client_shutdown_reaches_every_subscriber_as_stopping_first,
        ),
        (
            "a_squatted_legacy_address_gets_nothing",
            a_squatted_legacy_address_gets_nothing,
        ),
        (
            "two_hundred_owners_under_the_launchd_descriptor_limit",
            two_hundred_owners_under_the_launchd_descriptor_limit,
        ),
        (
            "idle_sockets_cannot_crowd_out_an_owner_under_a_hard_limit",
            idle_sockets_cannot_crowd_out_an_owner_under_a_hard_limit,
        ),
        (
            "a_finite_hard_descriptor_limit_is_taken_whole",
            a_finite_hard_descriptor_limit_is_taken_whole,
        ),
        (
            "a_flood_of_silent_sockets_cannot_end_a_handshake_in_flight",
            a_flood_of_silent_sockets_cannot_end_a_handshake_in_flight,
        ),
        (
            "the_legacy_cores_own_stopping_reaches_every_subscriber_before_the_end",
            the_legacy_cores_own_stopping_reaches_every_subscriber_before_the_end,
        ),
        (
            "a_request_id_that_is_no_integer_or_string_is_an_invalid_request",
            a_request_id_that_is_no_integer_or_string_is_an_invalid_request,
        ),
        (
            "a_hung_legacy_core_dies_with_its_killed_front_door",
            a_hung_legacy_core_dies_with_its_killed_front_door,
        ),
        (
            "a_held_legacy_lock_is_reported_with_its_file_and_holder",
            a_held_legacy_lock_is_reported_with_its_file_and_holder,
        ),
        (
            "a_live_grace_change_applies_to_the_next_orphaning",
            a_live_grace_change_applies_to_the_next_orphaning,
        ),
        (
            "a_stop_without_the_control_link_ends_the_lifeline",
            a_stop_without_the_control_link_ends_the_lifeline,
        ),
        (
            "a_console_break_stops_the_pair_in_order",
            a_console_break_stops_the_pair_in_order,
        ),
        (
            "a_home_too_long_for_the_legacy_socket_is_refused_with_a_clear_message",
            a_home_too_long_for_the_legacy_socket_is_refused_with_a_clear_message,
        ),
        (
            "chatty_unauthenticated_sockets_stay_under_their_cap",
            chatty_unauthenticated_sockets_stay_under_their_cap,
        ),
    ];
    let mut failed = Vec::new();
    for (name, test) in tests {
        if !filter.is_empty() && !filter.iter().any(|f| name.contains(f.as_str())) {
            continue;
        }
        let started = Instant::now();
        let outcome = std::panic::catch_unwind(test);
        let verdict = if outcome.is_ok() { "ok" } else { "FAILED" };
        println!("test {name} ... {verdict} ({:?})", started.elapsed());
        if outcome.is_err() {
            failed.push(*name);
        }
    }
    println!(
        "\ntest result: {}. {} failed: {failed:?}",
        if failed.is_empty() { "ok" } else { "FAILED" },
        failed.len()
    );
    std::process::exit(i32::from(!failed.is_empty()));
}

/// A front door under test.
struct Door {
    child: Child,
    stdin: Option<ChildStdin>,
    home: tempfile::TempDir,
    ready: Value,
    stderr: Arc<Mutex<String>>,
}

#[derive(Default)]
struct Opts<'a> {
    mode: &'a str,
    lifeline: bool,
    instance: Option<&'a str>,
    prepare: Option<&'a dyn Fn(&Path)>,
    /// Starts the front door with this soft `RLIMIT_NOFILE` (Unix), as launchd starts processes with 256.
    open_files: Option<u64>,
    /// With `open_files`: this hard limit as well (the front door cannot raise beyond it).
    hard_open_files: Option<u64>,
    /// Unix: the front door leads a process group of its own (as the supervisor starts it), so a test can signal the
    /// whole group.
    own_group: bool,
}

fn spawn_door(home: &Path, o: &Opts<'_>) -> Child {
    let bin = env!("CARGO_BIN_EXE_plur1bus-core");
    let mut cmd = match o.open_files {
        Some(n) => {
            let mut sh = Command::new("/bin/sh");
            sh.arg("-c")
                .arg(match o.hard_open_files {
                    Some(hard) => {
                        format!(r#"ulimit -Sn {n} && ulimit -Hn {hard} && exec "$0" "$@""#)
                    }
                    None => format!(r#"ulimit -Sn {n} && exec "$0" "$@""#),
                })
                .arg(bin);
            sh
        }
        None => Command::new(bin),
    };
    #[cfg(unix)]
    if o.own_group {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // Windows: a console process group of its own (`CREATE_NEW_PROCESS_GROUP`), for Ctrl+Break.
    #[cfg(windows)]
    if o.own_group {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0200);
    }
    cmd.args(["serve", "--home"]).arg(home);
    if o.lifeline {
        cmd.args([
            "--lifeline",
            "stdin",
            "--instance",
            o.instance.unwrap_or("123E4567-E89B-12D3-A456-426614174000"),
        ]);
    } else if let Some(instance) = o.instance {
        cmd.args(["--instance", instance]);
    }
    cmd.env("PLUR1BUS_NODE", std::env::current_exe().unwrap())
        .env("PLUR1BUS_CORE_JS", "fake-legacy")
        .env("FAKE_LEGACY_MODE", o.mode)
        .env_remove("PLUR1BUS_TEST_INTERNALS")
        .env_remove("PLUR1BUS_RUN_ACL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn door(o: Opts<'_>) -> Door {
    let home = tempfile::tempdir().unwrap();
    if let Some(prepare) = o.prepare {
        prepare(home.path());
    }
    let mut child = spawn_door(home.path(), &o);
    let stderr = Arc::new(Mutex::new(String::new()));
    let mut err = child.stderr.take().unwrap();
    let sink = stderr.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = err.read(&mut buf) {
            if n == 0 {
                break;
            }
            sink.lock()
                .unwrap()
                .push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    });
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout);
        let mut first = String::new();
        let _ = lines.read_line(&mut first);
        let _ = tx.send(first);
        let mut rest = String::new();
        while lines.read_line(&mut rest).unwrap_or(0) > 0 {
            rest.clear();
        }
    });
    let line = rx.recv_timeout(Duration::from_secs(20)).unwrap_or_default();
    let ready = serde_json::from_str(&line).unwrap_or_else(|_| {
        let _ = child.kill();
        panic!(
            "no ready line: {line:?}; stderr: {}",
            stderr.lock().unwrap()
        )
    });
    let stdin = child.stdin.take();
    Door {
        child,
        stdin,
        home,
        ready,
        stderr,
    }
}

impl Door {
    fn path(&self, rel: &str) -> PathBuf {
        self.home.path().join(rel)
    }
    fn token(&self, name: &str) -> String {
        std::fs::read_to_string(self.path(&format!("run/{name}"))).unwrap()
    }
    fn address(&self) -> String {
        self.ready["address"].as_str().unwrap().to_owned()
    }
    fn pid(&self) -> u64 {
        self.ready["pid"].as_u64().unwrap()
    }
    fn client(&self) -> Client {
        Client::connect(&self.address())
    }
    fn owner(&self) -> Client {
        let mut c = self.client();
        let r = c.call("core.auth", json!({"token": self.token("core.token")}));
        assert!(r.get("result").is_some(), "{r}");
        c
    }
    fn wait(&mut self, within: Duration) -> Option<i32> {
        let until = Instant::now() + within;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            if Instant::now() > until {
                let _ = self.child.kill();
                panic!("the front door did not exit; stderr: {}", self.stderr());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }
    /// Waits until the front door's stderr contains `needle`; panics with the stderr when `within` passes first.
    #[cfg(unix)]
    fn await_stderr(&self, needle: &str, within: Duration) {
        let until = Instant::now() + within;
        while !self.stderr().contains(needle) {
            assert!(
                Instant::now() < until,
                "no {needle:?} within {within:?}; stderr: {}",
                self.stderr()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Door {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(pid) = std::fs::read_to_string(self.home.path().join("run/core-legacy.pid")) {
            if let Some(pid) = pid.split_whitespace().next() {
                kill(pid, "-KILL");
            }
        }
    }
}

fn kill(pid: &str, signal: &str) {
    if cfg!(windows) {
        let _ = Command::new("taskkill").args(["/F", "/PID", pid]).output();
    } else {
        let _ = Command::new("kill").args([signal, pid]).output();
    }
}

/// A raw NDJSON client.
struct Client {
    writer: Box<dyn Stream>,
    reader: BufReader<Box<dyn Stream>>,
    notes: Vec<Value>,
    next: u64,
}

impl Client {
    fn connect(address: &str) -> Client {
        let stream = transport::connect(address, Duration::from_secs(2)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let reader = BufReader::new(stream.try_clone_stream().unwrap());
        Client {
            writer: stream,
            reader,
            notes: Vec::new(),
            next: 1,
        }
    }
    fn send_line(&mut self, line: &str) {
        self.send_bytes(format!("{line}\n").as_bytes());
    }
    fn send_bytes(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).unwrap();
        self.writer.flush().unwrap();
    }
    /// The next line, or `None` at EOF (the server closed the connection). A lone surrogate is read as U+FFFD (JSON.parse
    /// takes it); a line nested deeper than serde_json reads is for [`Client::read_raw`].
    fn read(&mut self) -> Option<Value> {
        let line = self.read_raw()?;
        Some(
            plur1bus_core::peek::value_lossy(&line)
                .unwrap_or_else(|| panic!("not JSON: {line:.200}")),
        )
    }
    /// The next line exactly as it arrived, without its newline; `None` at EOF.
    fn read_raw(&mut self) -> Option<String> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim_end_matches('\n').to_owned()),
        }
    }
    /// Sends a request and returns its response; notifications on the way are kept in `notes`.
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send_line(
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
        );
        self.response(&json!(id))
    }
    /// Like [`Client::call`], `None` when the connection is closed (by a refusal) before the response.
    fn try_call(&mut self, method: &str, params: Value) -> Option<Value> {
        let id = self.next;
        self.next += 1;
        let line = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string();
        self.writer.write_all(format!("{line}\n").as_bytes()).ok()?;
        self.writer.flush().ok()?;
        loop {
            let msg = self.read()?;
            if msg.get("id") == Some(&json!(id)) && msg.get("method").is_none() {
                return Some(msg);
            }
            self.notes.push(msg);
        }
    }
    fn response(&mut self, id: &Value) -> Value {
        loop {
            let msg = self
                .read()
                .unwrap_or_else(|| panic!("connection closed before the response to {id}"));
            if msg.get("id") == Some(id) && msg.get("method").is_none() {
                return msg;
            }
            self.notes.push(msg);
        }
    }
    fn closed(&mut self) -> bool {
        loop {
            match self.read() {
                None => return true,
                Some(v) => self.notes.push(v),
            }
        }
    }
}

fn reason(v: &Value) -> &str {
    v.pointer("/error/data/reason")
        .and_then(Value::as_str)
        .unwrap_or("")
}
fn code(v: &Value) -> &str {
    v.pointer("/error/data/error")
        .and_then(Value::as_str)
        .unwrap_or("")
}

#[cfg(unix)]
fn mode(p: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

fn ready_line_run_files_and_modes() {
    let d = door(Opts {
        lifeline: true,
        ..Opts::default()
    });
    assert_eq!(d.pid(), u64::from(d.child.id()));
    assert_eq!(d.ready["ready"], true);
    assert_eq!(
        d.address(),
        plur1bus_core::run_files::address(d.home.path(), cfg!(windows))
    );
    let tokens: Vec<String> = ["core.token", "api-delegation.token", "core-legacy.token"]
        .iter()
        .map(|n| d.token(n))
        .collect();
    for t in &tokens {
        assert!(plur1bus_core::auth::is_hex64(t), "64 hex");
    }
    assert!(tokens[0] != tokens[1] && tokens[1] != tokens[2] && tokens[0] != tokens[2]);
    assert_eq!(
        d.token("core.pid"),
        format!("{} 123e4567-e89b-12d3-a456-426614174000\n", d.pid())
    );
    assert_eq!(
        d.token("core-legacy.mode"),
        "supervised",
        "--lifeline stdin: the legacy core reads the supervisor's config"
    );
    assert_eq!(
        d.token("core-legacy.pid").split_whitespace().nth(1),
        Some("123e4567-e89b-12d3-a456-426614174000"),
        "the legacy core runs as the front door's instance: the tools service binds it to run/core.pid by instance"
    );
    // As a TypeScript core writes them right before it listens, the public credential files appear only once the legacy
    // core is ready (a client or the API that sees them finds a core about to listen); the legacy core's own copy goes.
    assert_eq!(
        d.token("core-legacy.saw"),
        "core.token:absent api-delegation.token:absent"
    );
    assert!(!d.path("run/core-legacy.credentials").exists());
    #[cfg(unix)]
    {
        assert_eq!(mode(&d.path("run")), 0o700);
        for f in [
            "run/core.token",
            "run/api-delegation.token",
            "run/core-legacy.token",
            "run/core.pid",
            "run/core.sock",
            "state/core.lock",
        ] {
            assert_eq!(mode(&d.path(f)), 0o600, "{f}");
        }
        use std::os::unix::fs::FileTypeExt;
        assert!(std::fs::metadata(d.path("run/core.sock"))
            .unwrap()
            .file_type()
            .is_socket());
    }
    let standalone = door(Opts::default());
    assert_eq!(standalone.token("core-legacy.mode"), "standalone");
}

fn owner_handshake_and_a_byte_exact_relay() {
    let d = door(Opts::default());
    let mut c = d.client();
    let hello = c.call("core.auth", json!({"token": d.token("core.token")}));
    let r = &hello["result"];
    assert_eq!(
        r["pid"].as_u64(),
        Some(d.pid()),
        "the front door's pid, not the legacy core's"
    );
    assert_eq!(
        r["instanceId"].as_str(),
        d.token("core.pid").split_whitespace().nth(1)
    );
    assert_eq!(
        r["contract"], "9.9.9",
        "the engine contract the legacy core reports"
    );
    assert_eq!(r["rpc"], plur1bus_rpc::RPC_VERSION);
    assert_eq!(
        r["capabilities"],
        plur1bus_rpc::capabilities("core", &["events.harness"]),
        "native plus relayed: every core method"
    );
    // A relayed request reaches the legacy core as written: its id, `_meta`, number spellings and key order.
    let line = r#"{"jsonrpc":"2.0","id":"client-7","method":"memory.list","params":{"agentId":"bernd","n":1.0,"big":123456789012345680000,"_meta":{"traceparent":"00-x"}}}"#;
    c.send_line(line);
    let echo = c.response(&json!("client-7"));
    assert_eq!(echo["result"]["line"], line, "byte for byte");
    assert_eq!(echo["result"]["caller"], "owner");
}

fn before_the_handshake_the_front_door_answers() {
    let d = door(Opts::default());
    let mut c = d.client();
    let r = c.call("memory.list", json!({}));
    assert_eq!((code(&r), reason(&r)), ("E_UNAUTHORIZED", "auth-required"));
    c.send_line("{not json");
    let r = c.read().unwrap();
    assert_eq!(
        (code(&r), reason(&r), r["id"].clone()),
        ("E_INVALID_PARAMS", "parse-error", Value::Null)
    );
    assert_eq!(r["error"]["code"], -32700);
    // Invalid UTF-8 is replaced before parsing, as the TypeScript server's decoder does (P4D-3 is the lone surrogate only).
    c.send_bytes(b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"memory.list\",\"params\":{\"x\":\"\xff\xfe\"}}\n");
    let r = c.response(&json!(9));
    assert_eq!((code(&r), reason(&r)), ("E_UNAUTHORIZED", "auth-required"));
    c.send_line(r#"{"id":3,"method":"core.status"}"#);
    let r = c.read().unwrap();
    assert_eq!(
        (reason(&r), r["error"]["code"].as_i64()),
        ("invalid-request", Some(-32600))
    );
    // A bad API delegation is refused without closing (module-api errorReply), then an owner handshake works.
    let r = c.call("core.auth", json!({"token": d.token("core.token"), "api": {"clientId":"harness-api","token": Secret::fresh().unwrap().expose()}}));
    assert_eq!((code(&r), reason(&r)), ("E_UNAUTHORIZED", "api-delegation"));
    assert!(c
        .call("core.auth", json!({"token": d.token("core.token")}))
        .get("result")
        .is_some());
    // A link credential from a client is refused and closes the connection.
    let mut c = d.client();
    let r = c.call("core.auth", json!({"token": d.token("core.token"), "frontDoor": {"token": d.token("core-legacy.token"), "caller": "owner"}}));
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_UNAUTHORIZED", "front-door-link")
    );
    assert!(c.closed());
    // An unknown token is a scoped client's: the legacy core refuses it and the connection closes.
    let mut c = d.client();
    let r = c.call(
        "core.auth",
        json!({"token": Secret::fresh().unwrap().expose()}),
    );
    assert_eq!((code(&r), reason(&r)), ("E_UNAUTHORIZED", "client-token"));
    assert!(c.closed());
    let mut c = d.client();
    let r = c.call("core.auth", json!({"token": "short"}));
    assert_eq!(code(&r), "E_INVALID_PARAMS");
    assert!(c.closed(), "invalid handshake params close the connection");
}

fn an_over_long_line_closes_the_connection() {
    let d = door(Opts::default());
    let mut c = d.owner();
    let big = vec![b'x'; plur1bus_core::frame::MAX_LINE + 10];
    let _ = c.writer.write_all(&big);
    let _ = c.writer.flush();
    let r = c.read().unwrap();
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_INVALID_PARAMS", "line-too-long")
    );
    assert!(c.closed());
}

fn status_names_the_front_door() {
    let d = door(Opts::default());
    let mut c = d.owner();
    let s = c.call("core.status", json!({}));
    let r = &s["result"];
    assert_eq!(r["pid"].as_u64(), Some(d.pid()));
    assert_eq!(
        r["instanceId"].as_str(),
        d.token("core.pid").split_whitespace().nth(1)
    );
    assert_eq!(r["process"]["state"], "ready");
    assert_eq!(r["contract"], "9.9.9");
    assert!(r["uptimeMs"].is_u64());
    assert_eq!(
        r["agents"][0]["agentId"], "bernd",
        "the rest is the legacy core's"
    );
}

fn subscriptions_get_the_front_doors_core_state_and_a_shutdown_stops_cleanly() {
    let mut d = door(Opts::default());
    let mut c = d.owner();
    let s = c.call("events.subscribe", json!({}));
    assert!(s["result"]["subscriptionId"].is_string(), "{s}");
    let mut named = d.owner();
    named.call("events.subscribe", json!({"names": ["agent.activity"]}));
    let mut agent = d.owner();
    agent.call("events.subscribe", json!({"agentId": "bernd"}));
    c.call("agent.list", json!({}));
    let _ = c.call("core.status", json!({})); // the notifications were sent before this reply
    let methods: Vec<&str> = c
        .notes
        .iter()
        .filter_map(|n| n["method"].as_str())
        .collect();
    assert!(methods.contains(&"agent.activity"), "{methods:?}");
    assert!(
        !c.notes.iter().any(|n| n["method"] == "core.state"),
        "the legacy core's own core.state never reaches a client"
    );
    let r = c.call("core.shutdown", json!({"budgetMs": 2000}));
    assert_eq!(r["result"]["accepted"], true);
    assert!(c.closed());
    let states: Vec<&str> = c
        .notes
        .iter()
        .filter(|n| n["method"] == "core.state")
        .filter_map(|n| n["params"]["process"]["state"].as_str())
        .collect();
    assert_eq!(states, ["stopping"], "the front door's own core.state");
    assert!(named.closed() && agent.closed());
    assert!(
        !named
            .notes
            .iter()
            .chain(&agent.notes)
            .any(|n| n["method"] == "core.state"),
        "names and agent filters exclude it"
    );
    assert_eq!(d.wait(Duration::from_secs(10)), Some(0));
    for f in [
        "run/core.token",
        "run/api-delegation.token",
        "run/core-legacy.token",
        "run/core.pid",
        "run/core.sock",
    ] {
        assert!(!d.path(f).exists(), "{f} removed");
    }
    assert!(
        plur1bus_audit::lock::CoreLock::try_acquire(&d.path("state/core.lock"))
            .unwrap()
            .is_some(),
        "the lock is free"
    );
}

fn api_delegations_are_checked_here_and_forwarded() {
    let d = door(Opts::default());
    let mut c = d.client();
    let api = d.token("api-delegation.token");
    let principal = json!({"userId":"alice","kind":"person","role":"member"});
    let r = c.call("core.auth", json!({"token": d.token("core.token"), "api": {"clientId":"harness-api","token": api, "principal": principal}}));
    assert_eq!(r["result"]["apiPrincipal"], principal);
    let id = json!(77);
    c.send_line(&json!({"jsonrpc":"2.0","id":id,"method":"inbox.count","params":{},"api":{"clientId":"harness-api","token":api,"principal":principal}}).to_string());
    let echo = c.response(&id);
    assert_eq!(echo["result"]["caller"], "api");
    let r = c.call("inbox.count", json!({}));
    assert_eq!(
        r["result"]["caller"], "api",
        "the link's identity, whatever the request says"
    );
    // A request whose delegation does not carry the API's token is refused here, before the legacy core sees it.
    c.send_line(&json!({"jsonrpc":"2.0","id":78,"method":"inbox.count","params":{},"api":{"clientId":"harness-api","token":Secret::fresh().unwrap().expose()}}).to_string());
    let r = c.response(&json!(78));
    assert_eq!((code(&r), reason(&r)), ("E_UNAUTHORIZED", "api-delegation"));
    assert!(
        c.call("inbox.count", json!({})).get("result").is_some(),
        "and the connection stays"
    );
    // The API's token is no core token: a delegation without the core token is a bad token.
    let mut c = d.client();
    let r = c.call("core.auth", json!({"token": Secret::fresh().unwrap().expose(), "api": {"clientId":"harness-api","token": api}}));
    assert_eq!(reason(&r), "bad-token");
    assert!(c.closed());
}

fn the_engine_authenticates_with_its_own_token() {
    let engine = Secret::fresh().unwrap();
    let e = engine.expose().to_owned();
    let prepare = move |home: &Path| {
        std::fs::create_dir_all(home.join("run")).unwrap();
        std::fs::write(home.join("run/engine.token"), &e).unwrap();
    };
    let d = door(Opts {
        prepare: Some(&prepare),
        ..Opts::default()
    });
    let mut c = d.client();
    let r = c.call("core.auth", json!({"token": engine.expose(), "engine": {"clientId":"plur1bus-engine","token": engine.expose()}}));
    assert!(
        r["result"]["capabilities"]["features"]
            .as_array()
            .unwrap()
            .contains(&json!("engine")),
        "{r}"
    );
    assert_eq!(
        c.call("host.workspaceDir", json!({"agentId":"bernd"}))["result"]["caller"],
        "engine"
    );
    let mut c = d.client();
    let r = c.call("core.auth", json!({"token": d.token("core.token"), "engine": {"clientId":"plur1bus-engine","token": engine.expose()}}));
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_UNAUTHORIZED", "engine-delegation"),
        "token and engine.token must agree"
    );
    assert!(c.closed());
    let mut c = d.client();
    let other = Secret::fresh().unwrap();
    let r = c.call("core.auth", json!({"token": other.expose(), "engine": {"clientId":"plur1bus-engine","token": other.expose()}}));
    assert_eq!(reason(&r), "engine-delegation");
}

fn a_scoped_client_cannot_gain_identity_through_the_relay() {
    let d = door(Opts::default());
    let mut c = d.client();
    let r = c.call("core.auth", json!({"token": "c".repeat(64)}));
    assert!(
        r.get("result").is_some(),
        "the legacy core verified the scoped token: {r}"
    );
    // Fields a client adds never change who the link is: the legacy core bound the identity at the handshake.
    let owner_api = json!({"clientId":"harness-api","token": d.token("api-delegation.token"),"principal":{"userId":"local-owner","kind":"person","role":"owner"}});
    c.send_line(
        &json!({"jsonrpc":"2.0","id":5,"method":"memory.list","params":{},"api": owner_api})
            .to_string(),
    );
    assert_eq!(c.response(&json!(5))["result"]["caller"], "client");
    c.send_line(r#"{"jsonrpc":"2.0","id":6,"method":"memory.list","params":{"caller":{"channel":"cli"}},"principal":"owner"}"#);
    assert_eq!(c.response(&json!(6))["result"]["caller"], "client");
    // A scoped client cannot re-authenticate as the owner on the same connection.
    let r = c.call("core.auth", json!({"token": d.token("core.token")}));
    assert_eq!(code(&r), "E_DENIED");
    assert!(c.closed());
}

fn the_bridge_is_for_the_legacy_core_only() {
    let d = door(Opts::default());
    let mut owner = d.owner();
    let r = owner.call("bridge.hello", json!({}));
    assert_eq!((code(&r), reason(&r)), ("E_DENIED", "bridge-principal"));
    let mut bridge = d.client();
    let r = bridge.call("core.auth", json!({"token": d.token("core-legacy.token")}));
    assert_eq!(r["result"]["pid"].as_u64(), Some(d.pid()));
    assert_eq!(
        r["result"]["capabilities"],
        plur1bus_rpc::capabilities("bridge", &[])
    );
    let hello = bridge.call("bridge.hello", json!({}));
    assert_eq!(
        hello["result"],
        json!({"rpc": plur1bus_rpc::RPC_VERSION, "instanceId": r["result"]["instanceId"], "pid": d.pid()})
    );
    assert_eq!(
        code(&bridge.call("bridge.hello", json!({"x": 1}))),
        "E_INVALID_PARAMS"
    );
    let r = bridge.call("memory.list", json!({}));
    assert_eq!((code(&r), reason(&r)), ("E_DENIED", "bridge-principal"));
    let r = bridge.call("core.auth", json!({"token": d.token("core.token")}));
    assert_eq!(
        reason(&r),
        "bridge-principal",
        "the bridge connection cannot become the owner"
    );
}

fn adoption_and_the_lifeline() {
    let supervisor = Secret::fresh().unwrap();
    let s = supervisor.expose().to_owned();
    let prepare = move |home: &Path| {
        std::fs::create_dir_all(home.join("run")).unwrap();
        std::fs::write(home.join("run/supervisor.token"), &s).unwrap();
        std::fs::write(
            home.join("config.json"),
            r#"{"supervisor":{"graceMs":1500}}"#,
        )
        .unwrap();
    };
    let mut d = door(Opts {
        lifeline: true,
        prepare: Some(&prepare),
        ..Opts::default()
    });
    let mut c = d.owner();
    let r = c.call(
        "core.adopt",
        json!({"nonce": Secret::fresh().unwrap().expose()}),
    );
    assert_eq!(reason(&r), "adopt-nonce");
    drop(d.stdin.take()); // the supervisor is gone
    let state = |c: &mut Client| {
        c.call("core.status", json!({}))["result"]["process"]["state"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let until = Instant::now() + Duration::from_secs(5);
    while state(&mut c) != "orphaned" {
        assert!(Instant::now() < until, "never orphaned");
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut adopter = d.owner();
    let r = adopter.call(
        "core.adopt",
        json!({"nonce": supervisor.expose().to_uppercase()}),
    );
    assert_eq!(r["result"]["status"]["process"]["state"], "ready", "{r}");
    assert_eq!(r["result"]["status"]["pid"].as_u64(), Some(d.pid()));
    std::thread::sleep(Duration::from_millis(1700));
    assert_eq!(state(&mut c), "ready", "an adoption cancelled the grace");
    drop(adopter); // the adopting connection is the lifeline now
    assert_eq!(
        d.wait(Duration::from_secs(10)),
        Some(0),
        "the grace ran out: a clean stop"
    );
    // The legacy core is stopped through its own lifeline, so it takes the TypeScript core's grace-expiry path and
    // `logs/core.log` records "orphan grace expired" as for a TypeScript core (tests/system kill-soak checks it).
    assert_eq!(d.token("core-legacy.stopped"), "lifeline");
}

fn a_legacy_core_that_fails_to_start_decides_the_exit_code() {
    for (mode, expected) in [
        ("exit:2", 2),
        ("exit:4", 4),
        ("exit:1", 1),
        ("bad-ready", 1),
    ] {
        let home = tempfile::tempdir().unwrap();
        let out = spawn_door(
            home.path(),
            &Opts {
                mode,
                ..Opts::default()
            },
        )
        .wait_with_output()
        .unwrap();
        assert_eq!(
            out.status.code(),
            Some(expected),
            "{mode}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stdout.is_empty(), "no ready line");
        for f in [
            "core.token",
            "api-delegation.token",
            "core-legacy.token",
            "core.pid",
            "core.sock",
        ] {
            assert!(
                !home.path().join("run").join(f).exists(),
                "{mode}: {f} left behind"
            );
        }
        if mode == "bad-ready" {
            if let Ok(pid) = std::fs::read_to_string(home.path().join("run/core-legacy.pid")) {
                kill(pid.split_whitespace().next().unwrap(), "-KILL");
            }
        }
    }
}

fn a_legacy_core_that_dies_ends_the_front_door() {
    let mut d = door(Opts::default());
    let mut c = d.owner();
    let pid = d.token("core-legacy.pid");
    kill(pid.split_whitespace().next().unwrap(), "-KILL");
    assert!(c.closed(), "its link died with it");
    assert_eq!(d.wait(Duration::from_secs(10)), Some(1));
    assert!(!d.path("run/core.token").exists() && !d.path("run/core.sock").exists());
    // Security review L5: a killed legacy core cannot remove its record; the front door that reaped it does, so no
    // stale record of the current instance is left for a reused pid to match.
    assert!(
        !d.path("run/core-legacy.pid").exists(),
        "the reaped legacy core's record is gone"
    );
}

fn a_client_whose_link_cannot_open_sees_the_core_go_away() {
    let d = door(Opts {
        mode: "one-link",
        ..Opts::default()
    });
    // No reply, the connection just ends: what a client of a TypeScript core that goes away sees (module-api's
    // `closed`, the CLI's unavailable core), which the CLI and the API treat like an unreachable core (a capture is
    // journaled, a recall degrades, the import maintenance fallback is admitted), never a refusal of their own.
    let mut c = d.client();
    assert_eq!(
        c.try_call("core.auth", json!({"token": d.token("core.token")})),
        None,
        "{:?}",
        c.notes
    );
    assert!(c.notes.is_empty(), "{:?}", c.notes);
}

fn a_second_front_door_is_locked_out() {
    let d = door(Opts::default());
    let token = d.token("core.token");
    let out = spawn_door(d.home.path(), &Opts::default())
        .wait_with_output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("another core holds the lock"));
    assert_eq!(
        d.token("core.token"),
        token,
        "the running core's token is untouched"
    );
    assert!(d
        .owner()
        .call("core.status", json!({}))
        .get("result")
        .is_some());
}

fn a_slow_client_is_disconnected_and_the_core_stays_up() {
    let d = door(Opts::default());
    let mut slow = d.owner();
    slow.send_line(r#"{"jsonrpc":"2.0","id":1,"method":"fake.flood","params":{}}"#);
    let until = Instant::now() + Duration::from_secs(20);
    while !d.stderr().contains("client not reading") {
        assert!(Instant::now() < until, "not disconnected: {}", d.stderr());
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        d.owner()
            .call("core.status", json!({}))
            .get("result")
            .is_some(),
        "others are served"
    );
}

fn stale_and_live_sockets() {
    #[cfg(unix)]
    {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("run")).unwrap();
        let sock = home.path().join("run/core.sock");
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap()); // a stale socket file stays behind
        let live =
            std::os::unix::net::UnixListener::bind(home.path().join("run/other.sock")).unwrap();
        drop(live);
        let mut child = spawn_door(home.path(), &Opts::default());
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert!(
            line.contains("\"ready\":true"),
            "a stale socket is replaced: {line}"
        );
        let _ = child.kill();
        let _ = child.wait();
        if let Ok(pid) = std::fs::read_to_string(home.path().join("run/core-legacy.pid")) {
            kill(pid.split_whitespace().next().unwrap(), "-KILL");
        }
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("run")).unwrap();
        let _live =
            std::os::unix::net::UnixListener::bind(home.path().join("run/core.sock")).unwrap();
        let out = spawn_door(home.path(), &Opts::default())
            .wait_with_output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&out.stderr).contains("address in use"));
    }
}

fn sigterm_stops_the_pair() {
    #[cfg(unix)]
    {
        let mut d = door(Opts {
            mode: "slow-stop",
            ..Opts::default()
        });
        let legacy = d.token("core-legacy.pid");
        let legacy = legacy.split_whitespace().next().unwrap().to_owned();
        kill(&d.pid().to_string(), "-TERM");
        assert_eq!(d.wait(Duration::from_secs(10)), Some(0), "{}", d.stderr());
        let alive = Command::new("kill")
            .args(["-0", &legacy])
            .output()
            .unwrap()
            .status
            .success();
        assert!(!alive, "the legacy core stopped first");
        assert_eq!(
            d.token("core-legacy.stopped"),
            "shutdown",
            "a stop request drains through core.shutdown (ADR-012 §3)"
        );
        assert!(!d.path("run/core.token").exists());
        assert!(d.stderr().contains("core stopping"), "{}", d.stderr());

        // Task review L4: the supervisor's terminate and a terminal's Ctrl+C reach the whole process group, so the legacy
        // core gets the signal too and may exit before the front door's own stop request is read; the pair still ends as
        // a requested stop (exit 0), not as a legacy core that died on its own (exit 1).
        let mut d = door(Opts {
            own_group: true,
            ..Opts::default()
        });
        let legacy = d.token("core-legacy.pid");
        let legacy = legacy.split_whitespace().next().unwrap().to_owned();
        let group = format!("-{}", d.pid());
        let sent = Command::new("kill")
            .args(["-TERM", "--", &group])
            .status()
            .unwrap();
        assert!(sent.success());
        assert_eq!(d.wait(Duration::from_secs(10)), Some(0), "{}", d.stderr());
        let alive = Command::new("kill")
            .args(["-0", &legacy])
            .output()
            .unwrap()
            .status
            .success();
        assert!(!alive, "the legacy core is gone");
    }
}

/// No credential appears in the front door's own output or in any reply it makes, on every refusal path and a clean
/// stop (the token is compared, never echoed or logged).
fn credentials_never_leak() {
    let mut d = door(Opts {
        lifeline: true,
        ..Opts::default()
    });
    let secrets: Vec<String> = ["core.token", "api-delegation.token", "core-legacy.token"]
        .iter()
        .map(|n| d.token(n))
        .collect();
    let mut replies = Vec::new();
    let fresh = || Secret::fresh().unwrap().expose().to_owned();
    for params in [
        json!({"token": fresh()}),
        json!({"token": secrets[0], "frontDoor": {"token": secrets[2], "caller": "owner"}}),
        json!({"token": secrets[0], "api": {"clientId": "harness-api", "token": fresh()}}),
        json!({"token": fresh(), "api": {"clientId": "harness-api", "token": secrets[1]}}),
        json!({"token": secrets[0], "engine": {"clientId": "plur1bus-engine", "token": fresh()}}),
        json!({"token": secrets[0]}),
        json!({"token": secrets[2]}),
    ] {
        let mut c = d.client();
        for (method, p) in [
            ("core.auth", params),
            ("core.status", json!({})),
            ("bridge.hello", json!({})),
        ] {
            replies.extend(c.try_call(method, p));
        }
        replies.append(&mut c.notes);
    }
    // Shapes whose validation finding would quote the value (security review L2): an array envelope, an object id, and
    // mistyped `api.token` / `engine.token` / `engine`. The `detail` names where and which rule, never the value. (An id
    // comes back as the client sent it, the JSON-RPC rule both cores follow, so it is left out of the check.)
    for line in [
        json!([{"jsonrpc":"2.0","id":1,"method":"core.auth","params":{"token": secrets[0]}}]),
        json!({"jsonrpc":"2.0","id":{"x": secrets[0]},"method":"core.auth","params":{"token": secrets[0]}}),
        json!({"jsonrpc":"2.0","id":3,"method":"core.auth","params":{"token": secrets[0], "api": {"clientId": "harness-api", "token": [secrets[1]]}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"core.auth","params":{"token": secrets[0], "engine": {"clientId": "plur1bus-engine", "token": [secrets[0]]}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"core.auth","params":{"token": secrets[0], "engine": secrets[0]}}),
        json!({"jsonrpc":"2.0","id":6,"method":"core.auth","params":{"token": [secrets[2]]}}),
    ] {
        let mut c = d.client();
        c.send_line(&line.to_string());
        let mut r = c.read().unwrap();
        assert!(
            r.pointer("/error/data/error").is_some(),
            "every malformed handshake is refused"
        );
        if let Some(map) = r.as_object_mut() {
            map.remove("id");
        }
        replies.push(r);
    }
    let mut c = d.owner();
    replies.push(c.call("core.adopt", json!({"nonce": secrets[0]})));
    replies.push(c.call("core.shutdown", json!({})));
    assert_eq!(d.wait(Duration::from_secs(10)), Some(0));
    let all = format!("{} {}", d.stderr(), Value::Array(replies));
    for (i, secret) in secrets.iter().enumerate() {
        assert!(!all.contains(secret.as_str()), "credential {i} leaked");
        assert!(
            !all.contains(&secret[..16]),
            "a prefix of credential {i} leaked"
        );
    }
}

/// Security review M1: what JSON.stringify writes and serde_json refuses (a lone surrogate escape, nesting deeper than
/// 128) reaches the client byte for byte, its connection stays, and a broadcast carrying it disconnects no subscriber.
fn frames_serde_cannot_read_reach_the_client_as_written() {
    let d = door(Opts::default());
    let mut watcher = d.owner();
    assert!(watcher.call("events.subscribe", json!({}))["result"]["subscriptionId"].is_string());
    let mut c = d.owner();
    assert!(
        c.call("events.subscribe", json!({"names": ["agent.activity"]}))["result"]
            ["subscriptionId"]
            .is_string()
    );
    c.send_line(r#"{"jsonrpc":"2.0","id":31,"method":"fake.surrogate","params":{}}"#);
    assert_eq!(
        c.read_raw().as_deref(),
        Some(fake_legacy::surrogate_reply(&json!(31)).as_str()),
        "a result with a lone surrogate, byte for byte"
    );
    assert!(
        c.call("core.status", json!({})).get("result").is_some(),
        "and the connection stays"
    );
    c.send_line(r#"{"jsonrpc":"2.0","id":"deep","method":"fake.deep","params":{}}"#);
    assert_eq!(
        c.read_raw().as_deref(),
        Some(fake_legacy::deep_reply(&json!("deep")).as_str()),
        "a result nested 200 deep, byte for byte"
    );
    assert!(c.call("core.status", json!({})).get("result").is_some());
    c.send_line(r#"{"jsonrpc":"2.0","id":33,"method":"fake.notify-surrogate","params":{}}"#);
    assert_eq!(
        c.read_raw().as_deref(),
        Some(fake_legacy::SURROGATE_NOTE),
        "a notification with a lone surrogate, byte for byte"
    );
    assert_eq!(c.response(&json!(33))["result"], json!({}));
    assert_eq!(
        watcher.read_raw().as_deref(),
        Some(fake_legacy::SURROGATE_NOTE),
        "another owner subscriber gets the broadcast"
    );
    assert!(
        watcher
            .call("core.status", json!({}))
            .get("result")
            .is_some(),
        "and stays connected"
    );
    assert!(c.call("core.status", json!({})).get("result").is_some());
}

/// Security review L3: a request the front door completes is routed by its method even when serde_json cannot read the
/// rest (a lone surrogate in `_meta`): the adoption attaches the lifeline, and the legacy core gets the request as written.
fn an_adoption_with_a_lone_surrogate_in_meta_attaches_the_lifeline() {
    let supervisor = Secret::fresh().unwrap();
    let s = supervisor.expose().to_owned();
    let prepare = move |home: &Path| {
        std::fs::create_dir_all(home.join("run")).unwrap();
        std::fs::write(home.join("run/supervisor.token"), &s).unwrap();
        std::fs::write(
            home.join("config.json"),
            r#"{"supervisor":{"graceMs":1500}}"#,
        )
        .unwrap();
    };
    let mut d = door(Opts {
        lifeline: true,
        prepare: Some(&prepare),
        ..Opts::default()
    });
    let mut c = d.owner();
    drop(d.stdin.take());
    let state = |c: &mut Client| {
        c.call("core.status", json!({}))["result"]["process"]["state"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let until = Instant::now() + Duration::from_secs(5);
    while state(&mut c) != "orphaned" {
        assert!(Instant::now() < until, "never orphaned");
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut adopter = d.owner();
    adopter.send_line(&format!(
        r#"{{"jsonrpc":"2.0","id":5,"method":"core.adopt","params":{{"nonce":"{}","_meta":{{"x":"\ud800"}}}}}}"#,
        supervisor.expose()
    ));
    let r = adopter.response(&json!(5));
    assert_eq!(
        r["result"]["status"]["pid"].as_u64(),
        Some(d.pid()),
        "completed by the front door: {r}"
    );
    assert_eq!(r["result"]["status"]["process"]["state"], "ready");
    std::thread::sleep(Duration::from_millis(1700));
    assert_eq!(state(&mut c), "ready", "the adoption cancelled the grace");
    drop(adopter);
    assert_eq!(
        d.wait(Duration::from_secs(10)),
        Some(0),
        "the adopting connection was the lifeline"
    );
}

/// Security review L1: an id in the front door's own space (`fd-<link nonce>-<n>`) is refused from a client, on a frame
/// serde_json reads and on one it does not, so a client that learnt a link nonce cannot answer the front door's pending
/// request itself (here: make a refused `core.shutdown` look accepted).
fn a_client_cannot_answer_the_front_doors_own_requests() {
    let mut d = door(Opts {
        mode: "slow-refuse-shutdown",
        ..Opts::default()
    });
    let mut c = d.owner();
    c.send_line(r#"{"jsonrpc":"2.0","id":2,"method":"core.shutdown","params":{}}"#);
    let leaked = d.path("run/core-legacy.shutdown-id");
    let until = Instant::now() + Duration::from_secs(5);
    while !leaked.exists() {
        assert!(
            Instant::now() < until,
            "the legacy core never saw the shutdown"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let own = std::fs::read_to_string(&leaked).unwrap();
    assert!(own.starts_with("fd-"), "{own}");
    c.send_line(&json!({"jsonrpc":"2.0","id":own,"method":"fake.accept","params":{}}).to_string());
    let r = c.response(&json!(own));
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_INVALID_PARAMS", "front-door-id"),
        "{r}"
    );
    // The same on a frame serde_json cannot read (a lone surrogate in its params).
    c.send_line(&format!(
        r#"{{"jsonrpc":"2.0","id":"{own}","method":"fake.accept","params":{{"t":"\ud800"}}}}"#
    ));
    let r = c.response(&json!(own));
    assert_eq!(reason(&r), "front-door-id", "{r}");
    let refused = c.response(&json!(2));
    assert_eq!(
        (code(&refused), reason(&refused)),
        ("E_DENIED", "role-required"),
        "the client gets the legacy core's own answer"
    );
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        d.child.try_wait().unwrap(),
        None,
        "the front door keeps running"
    );
    assert!(c.call("core.status", json!({})).get("result").is_some());
    let spoofed = json!({"jsonrpc":"2.0","id":"fd-0-1","method":"memory.list","params":{}});
    c.send_line(&spoofed.to_string());
    assert_eq!(
        reason(&c.response(&json!("fd-0-1"))),
        "front-door-id",
        "whatever the nonce"
    );
}

/// Security review L1: an answer the front door completes is checked to be an object before it is patched, so a legacy
/// answer of another shape is a `result-schema` refusal, not a panic of the link's thread.
fn an_answer_that_is_no_object_is_refused_not_patched() {
    let supervisor = Secret::fresh().unwrap();
    let s = supervisor.expose().to_owned();
    let prepare = move |home: &Path| {
        std::fs::create_dir_all(home.join("run")).unwrap();
        std::fs::write(home.join("run/supervisor.token"), &s).unwrap();
    };
    let d = door(Opts {
        mode: "odd-results",
        prepare: Some(&prepare),
        ..Opts::default()
    });
    let mut c = d.owner();
    let r = c.call("core.adopt", json!({"nonce": supervisor.expose()}));
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_INTERNAL", "result-schema"),
        "{r}"
    );
    assert!(
        c.call("core.status", json!({})).get("result").is_some(),
        "the connection and its link are still served"
    );
}

/// Task review M2 (ADR-012 §3, G17): the supervisor's own stop is a `core.shutdown` on its connection. The front door is
/// `stopping`, and says so to every owner subscriber, before the accepted answer goes on, so a legacy core that ends every
/// link right after answering cannot cut a subscriber off before it saw `stopping`.
fn a_client_shutdown_reaches_every_subscriber_as_stopping_first() {
    let mut d = door(Opts {
        mode: "close-on-shutdown",
        ..Opts::default()
    });
    let mut a = d.owner();
    assert!(a.call("events.subscribe", json!({}))["result"]["subscriptionId"].is_string());
    let mut b = d.owner();
    assert!(
        b.call("events.subscribe", json!({"names": ["core.state"]}))["result"]["subscriptionId"]
            .is_string()
    );
    let mut c = d.owner();
    assert!(c.call("events.subscribe", json!({}))["result"]["subscriptionId"].is_string());
    c.send_line(
        r#"{"jsonrpc":"2.0","id":"stop","method":"core.shutdown","params":{"budgetMs":2000}}"#,
    );
    // The requester's own stream: `stopping` is queued before the answer (both on this connection's one writer).
    let first = c.read().unwrap();
    assert_eq!(
        (
            first["method"].as_str(),
            first["params"]["process"]["state"].as_str()
        ),
        (Some("core.state"), Some("stopping")),
        "stopping before the answer: {first}"
    );
    assert_eq!(c.response(&json!("stop"))["result"]["accepted"], true);
    for (name, s) in [("a", &mut a), ("b", &mut b)] {
        assert!(s.closed(), "{name}: the connection ends");
        let states: Vec<&str> = s
            .notes
            .iter()
            .filter(|n| n["method"] == "core.state")
            .filter_map(|n| n["params"]["process"]["state"].as_str())
            .collect();
        assert_eq!(
            states,
            ["stopping"],
            "{name} saw stopping before the end, once"
        );
    }
    assert!(c.closed());
    assert_eq!(d.wait(Duration::from_secs(10)), Some(0), "{}", d.stderr());
}

/// Task review M4 (the squatting containment of P4D-6 and ADR-012 R4): before a link sends anything, the process serving
/// the legacy address must be the legacy core (`relay::Link::connect`, the OS's peer pid). A process that took over
/// `run/core-legacy.sock` receives not one byte (no client credential, no link token), and the client's connection ends
/// as with a core that went away.
///
/// Unix only: on Windows the squatter would have to serve the `-core-legacy` pipe from another process while the legacy
/// core holds the name; that case is named in the Windows gating job (task P4-10 fix brief A1) as a `cfg(unix)` gap.
fn a_squatted_legacy_address_gets_nothing() {
    #[cfg(unix)]
    {
        let d = door(Opts::default());
        let address = d.path("run/core-legacy.sock");
        std::fs::remove_file(&address).unwrap();
        let squatter = std::os::unix::net::UnixListener::bind(&address).unwrap();
        squatter.set_nonblocking(true).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match squatter.accept() {
                    Ok(pair) => break pair,
                    Err(_) if Instant::now() < until => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            };
            // macOS refuses socket options on a connection its peer already shut down (EINVAL); a read then ends at once.
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
            }
            let _ = tx.send(got.len());
        });
        let mut c = d.client();
        assert_eq!(
            c.try_call("core.auth", json!({"token": d.token("core.token")})),
            None,
            "no reply: the connection ends"
        );
        assert!(c.notes.is_empty());
        let received = rx
            .recv_timeout(Duration::from_secs(8))
            .expect("the front door connected to the squatter and checked it");
        assert_eq!(received, 0, "the squatter read nothing");
        assert!(d.stderr().contains("cannot open a link"), "{}", d.stderr());
    }
    // P4-10 ruling A1/T-M4: a named gap on Windows. The fake legacy core's open control link keeps its `-core-legacy` pipe
    // name alive, so a second process can only add pipe instances, and which instance a client meets is not
    // deterministic. The check itself (`relay.rs`, `GetNamedPipeServerProcessId` on Windows) runs on every link opened in
    // the other scenarios.
    #[cfg(not(unix))]
    println!("  (skipped: Unix only; the Windows squat is a named gap, see the comment)");
}

/// Security review M2: started with launchd's soft descriptor limit (256), the front door raises it as Node does, serves
/// 200 authenticated owners at once, and 100 idle unauthenticated sockets do not keep an owner from its handshake (they
/// are capped; the oldest is ended to make room).
fn two_hundred_owners_under_the_launchd_descriptor_limit() {
    #[cfg(unix)]
    {
        // This test process holds two descriptors per client.
        plur1bus_rpc::limits::raise_open_files();
        let d = door(Opts {
            open_files: Some(256),
            ..Opts::default()
        });
        let idle: Vec<Client> = (0..100).map(|_| d.client()).collect();
        let owners: Vec<Client> = (0..200)
            .map(|i| {
                let mut c = d.client();
                let r = c
                    .try_call("core.auth", json!({"token": d.token("core.token")}))
                    .unwrap_or_else(|| panic!("owner {i} was cut off; stderr: {}", d.stderr()));
                assert!(r.get("result").is_some(), "owner {i}: {r}");
                c
            })
            .collect();
        let more_idle: Vec<Client> = (0..100).map(|_| d.client()).collect();
        let mut late = d.client();
        let r = late
            .try_call("core.auth", json!({"token": d.token("core.token")}))
            .expect("an owner gets through 100 idle sockets");
        assert!(r.get("result").is_some(), "{r}");
        for (i, mut c) in owners.into_iter().enumerate().step_by(40) {
            assert!(
                c.call("core.status", json!({})).get("result").is_some(),
                "owner {i} is still served"
            );
        }
        assert!(
            !d.stderr().contains("Too many open files"),
            "{}",
            d.stderr()
        );
        assert!(
            d.stderr()
                .contains("unauthenticated connections at their limit"),
            "the idle sockets were capped: {}",
            d.stderr()
        );
        drop((idle, more_idle));
    }
}

/// Security review M2, where the limit cannot be raised (hard 256): the front door sizes its connections to the
/// descriptors (48 at 256) and keeps at most half of them for connections before their handshake, ending the oldest, so
/// 100 idle sockets (which used to exhaust the 256 descriptors on their own) neither exhaust it nor keep an owner out.
fn idle_sockets_cannot_crowd_out_an_owner_under_a_hard_limit() {
    #[cfg(unix)]
    {
        plur1bus_rpc::limits::raise_open_files();
        let d = door(Opts {
            open_files: Some(256),
            hard_open_files: Some(256),
            ..Opts::default()
        });
        let until = Instant::now() + Duration::from_secs(5);
        while !d.stderr().contains("core ready") {
            assert!(Instant::now() < until, "{}", d.stderr());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            d.stderr().contains(r#""maxConnections":48"#)
                && d.stderr().contains(r#""openFiles":256"#),
            "{}",
            d.stderr()
        );
        // No pauses: the accounting must hold while the bursts are still being accepted (fix round 1b F2).
        let idle: Vec<Client> = (0..100).map(|_| d.client()).collect();
        let owners: Vec<Client> = (0..20).map(|_| d.owner()).collect();
        let more_idle: Vec<Client> = (0..100).map(|_| d.client()).collect();
        let mut late = d.client();
        let r = late
            .try_call("core.auth", json!({"token": d.token("core.token")}))
            .unwrap_or_else(|| panic!("an owner gets through idle sockets: {}", d.stderr()));
        assert!(r.get("result").is_some(), "{r}");
        assert!(late.call("core.status", json!({})).get("result").is_some());
        assert!(
            !d.stderr().contains("Too many open files"),
            "{}",
            d.stderr()
        );
        drop((idle, owners, more_idle));
    }
}

/// Fix round 1b F1: with a finite hard limit (GitHub's ubuntu runners, systemd user units) the soft limit is raised to
/// it, as Node does; started under launchd's soft 256 with a hard 4096 the front door takes 4096.
fn a_finite_hard_descriptor_limit_is_taken_whole() {
    #[cfg(unix)]
    {
        let d = door(Opts {
            open_files: Some(256),
            hard_open_files: Some(4096),
            ..Opts::default()
        });
        let until = Instant::now() + Duration::from_secs(5);
        while !d.stderr().contains("core ready") {
            assert!(Instant::now() < until, "{}", d.stderr());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            d.stderr().contains(r#""openFiles":4096"#)
                && d.stderr().contains(r#""maxConnections":512"#),
            "{}",
            d.stderr()
        );
    }
}

/// Fix round 1b F5: a connection that has sent a complete frame (its handshake is under way) is never the one ended to make
/// room; only connections that have not sent a single frame are. A same-user loop of silent connections therefore cannot
/// end an owner's handshake while the legacy core verifies it (here it takes a second), and the silent ones stay capped.
/// No descriptor limit is set, so this runs on every platform (review I5).
fn a_flood_of_silent_sockets_cannot_end_a_handshake_in_flight() {
    let d = door(Opts {
        mode: "slow-auth",
        ..Opts::default()
    });
    let mut owner = d.client();
    owner.send_line(
        &json!({"jsonrpc":"2.0","id":1,"method":"core.auth","params":{"token": d.token("core.token")}})
            .to_string(),
    );
    std::thread::sleep(Duration::from_millis(100)); // the handshake is with the legacy core now
    let silent: Vec<Client> = (0..100).map(|_| d.client()).collect();
    let r = owner.response(&json!(1));
    assert!(r.get("result").is_some(), "{r}");
    assert!(owner.call("core.status", json!({})).get("result").is_some());
    let until = Instant::now() + Duration::from_secs(5);
    while !d
        .stderr()
        .contains("unauthenticated connections at their limit")
    {
        assert!(
            Instant::now() < until,
            "the silent sockets are still capped: {}",
            d.stderr()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(silent);
}

/// Fix round 1b F7: when the legacy core stops (here on its own, as after a signal that reached it directly), its
/// `core.state stopping` on an owner subscriber's link puts the front door into `stopping` before that link's end is read,
/// so every owner subscriber sees the front door's `stopping` before its connection ends, whichever link ends first. Lines
/// on one link are handled in order; no thread timing is involved.
fn the_legacy_cores_own_stopping_reaches_every_subscriber_before_the_end() {
    let mut d = door(Opts::default());
    let mut a = d.owner();
    assert!(a.call("events.subscribe", json!({}))["result"]["subscriptionId"].is_string());
    let mut b = d.owner();
    assert!(
        b.call("events.subscribe", json!({"names": ["core.state"]}))["result"]["subscriptionId"]
            .is_string()
    );
    let mut trigger = d.owner();
    trigger.send_line(r#"{"jsonrpc":"2.0","id":1,"method":"fake.stop-self","params":{}}"#);
    for (name, s) in [("a", &mut a), ("b", &mut b)] {
        assert!(s.closed(), "{name}: the connection ends");
        let states: Vec<&str> = s
            .notes
            .iter()
            .filter(|n| n["method"] == "core.state")
            .filter_map(|n| n["params"]["process"]["state"].as_str())
            .collect();
        assert_eq!(
            states,
            ["stopping"],
            "{name}: the front door's stopping, once, before the end"
        );
        assert!(
            s.notes.iter().all(|n| n["params"]["process"]["since"] != 1),
            "{name}: never the legacy core's own core.state"
        );
    }
    assert!(trigger.closed());
    assert_eq!(
        d.wait(Duration::from_secs(10)),
        Some(1),
        "the legacy core exited on its own"
    );
}

/// Fix round 1b F8: a request id that is neither an integer nor a string (`$defs/Id`) is refused as the TypeScript core
/// refuses it (`E_INVALID_PARAMS`, `invalid-request`, −32600, the id echoed), on a route the front door completes
/// (`core.status`) as on a relayed one (`memory.list`); it never reaches the front door's own bookkeeping. JavaScript's
/// integers (`1.0`, `1e3`) are integers.
fn a_request_id_that_is_no_integer_or_string_is_an_invalid_request() {
    let d = door(Opts::default());
    let mut c = d.owner();
    for id in [r#"{"x":1}"#, "[1]", "1.5", "true", "[]"] {
        for method in ["core.status", "memory.list"] {
            c.send_line(&format!(
                r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{{}}}}"#
            ));
            let r = c.read().unwrap();
            assert_eq!(
                (code(&r), reason(&r), r["error"]["code"].as_i64()),
                ("E_INVALID_PARAMS", "invalid-request", Some(-32600)),
                "{method} with id {id}: {r}"
            );
            assert_eq!(
                r["id"],
                serde_json::from_str::<Value>(id).unwrap(),
                "the id as sent"
            );
            assert!(
                r.pointer("/error/data/detail")
                    .and_then(Value::as_str)
                    .is_some_and(|d| d.contains("/id")),
                "{r}"
            );
        }
    }
    for (raw, as_read) in [("1.0", json!(1.0)), ("1e3", json!(1000.0))] {
        c.send_line(&format!(
            r#"{{"jsonrpc":"2.0","id":{raw},"method":"core.status","params":{{}}}}"#
        ));
        let r = c.response(&as_read);
        assert_eq!(
            r["result"]["pid"].as_u64(),
            Some(d.pid()),
            "{raw} is an integer: completed here"
        );
    }
    // An API connection's refusal comes from the legacy core (module-api's checks before validateRequest decide there).
    let mut api = d.client();
    let delegation = json!({"clientId":"harness-api","token": d.token("api-delegation.token")});
    let r = api.call(
        "core.auth",
        json!({"token": d.token("core.token"), "api": delegation}),
    );
    assert!(r.get("result").is_some(), "{r}");
    api.send_line(
        &json!({"jsonrpc":"2.0","id":{"x":1},"method":"core.status","params":{},"api":delegation})
            .to_string(),
    );
    let r = api.read().unwrap();
    assert_eq!(reason(&r), "invalid-request", "{r}");
    assert!(
        c.call("core.status", json!({})).get("result").is_some(),
        "the connection stays"
    );
}

/// Security review M4: the legacy core lives no longer than its front door, also when the front door is killed and the
/// legacy core is hung (it notices neither its lifeline nor SIGTERM, fake mode `hang`). Linux: `PR_SET_PDEATHSIG` in
/// the legacy core's `pre_exec`; Windows: a job object that kills on close. macOS has neither: there the supervisor's
/// and 1staid's kill paths kill the pid in `run/core-legacy.pid` (`crates/plur1bus` `adopt::legacy_core_of`), so this
/// scenario does nothing on macOS (a named `cfg` gap; the Linux leg and the Windows job run it).
fn a_hung_legacy_core_dies_with_its_killed_front_door() {
    if !cfg!(any(target_os = "linux", windows)) {
        println!("  (skipped: no parent-death binding on this OS)");
        return;
    }
    let mut d = door(Opts {
        mode: "hang",
        ..Opts::default()
    });
    let legacy: u32 = d
        .token("core-legacy.pid")
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    d.child.kill().unwrap(); // SIGKILL / TerminateProcess: no stop path of the front door runs
    let _ = d.child.wait();
    let until = Instant::now() + Duration::from_secs(1);
    while plur1bus_rpc::process::alive(legacy) != plur1bus_rpc::process::Liveness::Gone {
        assert!(
            Instant::now() < until,
            "the hung legacy core {legacy} outlived its front door by a second"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Security review M4: a legacy core that exits 3 finds `run/core-legacy.lock` held by an older legacy core. The front
/// door names that file and the holder `run/core-legacy.pid` records, not `state/core.lock` (which it holds itself).
fn a_held_legacy_lock_is_reported_with_its_file_and_holder() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("run")).unwrap();
    // The record of an older legacy core that outlived its front door (a live process: this test).
    std::fs::write(
        home.path().join("run/core-legacy.pid"),
        format!(
            "{} 5d0f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f\n",
            std::process::id()
        ),
    )
    .unwrap();
    let mut child = spawn_door(
        home.path(),
        &Opts {
            mode: "exit:3",
            ..Opts::default()
        },
    );
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let until = Instant::now() + Duration::from_secs(10);
    let mut seen = Vec::new();
    let line = loop {
        let left = until.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) if line.contains("core-legacy.lock") => break line,
            Ok(line) => seen.push(line),
            Err(_) => {
                let _ = child.kill();
                panic!("no line names run/core-legacy.lock: {seen:?}");
            }
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        line.contains(&format!("\"holderPid\":{}", std::process::id())),
        "{line}"
    );
    assert!(
        line.contains("5d0f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f"),
        "{line}"
    );
    assert!(!line.contains("state/core.lock"), "{line}");
}

/// Task review M1: `supervisor.graceMs` (and `core.shutdownBudgetMs`) are `x-restart: live`. The supervisor is
/// `config.json`'s only writer; a change made while the front door runs applies to the next orphaning, as the TypeScript
/// core applies it at once (`setGraceMs`). Started with the default 60 s grace, lowered to 1.5 s, the lifeline dropped:
/// the front door stops within 5 s.
fn a_live_grace_change_applies_to_the_next_orphaning() {
    let prepare = |home: &Path| {
        std::fs::write(
            home.join("config.json"),
            r#"{"supervisor":{"graceMs":60000}}"#,
        )
        .unwrap();
    };
    let mut d = door(Opts {
        lifeline: true,
        prepare: Some(&prepare),
        ..Opts::default()
    });
    std::fs::write(d.path("config.json"), r#"{"supervisor":{"graceMs":1500}}"#).unwrap();
    drop(d.stdin.take()); // the supervisor is gone
    assert_eq!(
        d.wait(Duration::from_secs(5)),
        Some(0),
        "the grace in force when the lifeline went is the one applied"
    );
    assert_eq!(d.token("core-legacy.stopped"), "lifeline");
}

/// Task review L1: when the control link is gone at a stop, `core.shutdown` cannot reach the legacy core, so the front door
/// ends its lifeline instead, and the legacy core stops on it (no grace behind a front door) well inside the budget,
/// rather than being killed without a drain after budget + 5 s.
fn a_stop_without_the_control_link_ends_the_lifeline() {
    #[cfg(unix)]
    {
        let mut d = door(Opts {
            mode: "drop-control",
            ..Opts::default()
        });
        // Re-review M-e: the control link ends 300 ms after its handshake; the stop begins once the front door has read
        // its end (it logs that after setting the flag `stop` reads), not after a fixed sleep.
        d.await_stderr("the control link ended", Duration::from_secs(5));
        kill(&d.pid().to_string(), "-TERM");
        assert_eq!(d.wait(Duration::from_secs(5)), Some(0), "{}", d.stderr());
        assert_eq!(d.token("core-legacy.stopped"), "lifeline");
        assert!(
            d.stderr().contains("the control link is gone"),
            "{}",
            d.stderr()
        );
    }
}

/// Task review L5 (Windows only, runs in the `front-door-windows` job): Ctrl+Break (and Ctrl+C, closing the console) on
/// `plur1bus core run` takes the ordered stop, with SIGINT's code 130, instead of the default handler's instant exit
/// that left `stopping`, the legacy core's drain and the run files behind. Unix has its signals (`sigterm_stops_the_pair`).
fn a_console_break_stops_the_pair_in_order() {
    #[cfg(windows)]
    {
        let mut d = door(Opts {
            own_group: true,
            ..Opts::default()
        });
        let group = u32::try_from(d.pid()).unwrap();
        if let Err(e) = plur1bus_rpc::win::send_ctrl_break(group) {
            println!("  (skipped: no console to send Ctrl+Break on: {e})");
            return;
        }
        assert_eq!(d.wait(Duration::from_secs(10)), Some(130), "{}", d.stderr());
        assert!(d.stderr().contains("CTRL_BREAK"), "{}", d.stderr());
        assert_eq!(
            d.token("core-legacy.stopped"),
            "shutdown",
            "the legacy core drained through core.shutdown"
        );
        assert!(!d.path("run/core.token").exists(), "run files removed");
    }
}

/// P4D-10 (security review I3): `run/core-legacy.sock` is 7 bytes longer than `run/core.sock`, so a home that fits a
/// TypeScript core alone can be too long for the front door's legacy core. The front door says so and stops before it
/// writes anything, instead of a bind error of the legacy core.
fn a_home_too_long_for_the_legacy_socket_is_refused_with_a_clear_message() {
    #[cfg(unix)]
    {
        let limit = if cfg!(target_os = "linux") { 108 } else { 104 };
        let base = tempfile::tempdir().unwrap();
        // A home of `limit - 18` bytes: run/core-legacy.sock (+21) does not fit, run/core.sock (+14) does.
        let want = limit - 18;
        let have = base.path().to_string_lossy().len() + 1;
        if have >= want {
            println!("  (skipped: the temporary directory is already too long)");
            return;
        }
        let home = base.path().join("h".repeat(want - have));
        std::fs::create_dir(&home).unwrap();
        let out = spawn_door(&home, &Opts::default())
            .wait_with_output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(1), "{stderr}");
        assert!(
            stderr.contains("core-legacy.sock") && stderr.contains("too long"),
            "{stderr}"
        );
        assert!(!home.join("run").exists(), "nothing was written");
    }
}

/// Re-review 1b N1: only a `core.auth` that reached the credential check exempts a connection from the unauthenticated
/// cap and from being ended to make room (F5). A socket that sends any other line before its handshake (it gets
/// `auth-required` and stays open, as on the TypeScript server) still counts and can be ended: 60 of them under a
/// descriptor limit of 256 (48 connections) do not keep an owner from its handshake.
fn chatty_unauthenticated_sockets_stay_under_their_cap() {
    #[cfg(unix)]
    {
        plur1bus_rpc::limits::raise_open_files();
        let d = door(Opts {
            open_files: Some(256),
            hard_open_files: Some(256),
            ..Opts::default()
        });
        let until = Instant::now() + Duration::from_secs(5);
        while !d.stderr().contains("core ready") {
            assert!(Instant::now() < until, "{}", d.stderr());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            d.stderr().contains(r#""maxConnections":48"#),
            "{}",
            d.stderr()
        );
        let chatty: Vec<Client> = (0..60)
            .map(|_| {
                let mut c = d.client();
                c.send_line(r#"{"jsonrpc":"2.0","id":1,"method":"core.status","params":{}}"#);
                c
            })
            .collect();
        std::thread::sleep(Duration::from_millis(200)); // every one has had its auth-required
        let mut owner = d.client();
        let r = owner
            .try_call("core.auth", json!({"token": d.token("core.token")}))
            .unwrap_or_else(|| panic!("an owner gets through chatty sockets: {}", d.stderr()));
        assert!(r.get("result").is_some(), "{r}");
        assert!(owner.call("core.status", json!({})).get("result").is_some());
        drop(chatty);
    }
}
