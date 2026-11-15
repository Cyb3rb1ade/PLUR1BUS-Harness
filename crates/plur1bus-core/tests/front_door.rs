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
            "a_fifo_at_the_legacy_record_does_not_stop_the_start",
            a_fifo_at_the_legacy_record_does_not_stop_the_start,
        ),
        (
            "a_link_at_the_legacy_record_is_not_followed",
            a_link_at_the_legacy_record_is_not_followed,
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
            "the_front_doors_lines_are_in_the_core_log",
            the_front_doors_lines_are_in_the_core_log,
        ),
        (
            "the_first_native_methods_serve_the_owner_here_and_everyone_else_through_the_relay",
            the_first_native_methods_serve_the_owner_here_and_everyone_else_through_the_relay,
        ),
        (
            "a_disabled_or_demoted_local_owner_meets_the_native_guard",
            a_disabled_or_demoted_local_owner_meets_the_native_guard,
        ),
        (
            "a_persons_role_and_status_change_here_and_the_legacy_core_is_told",
            a_persons_role_and_status_change_here_and_the_legacy_core_is_told,
        ),
        (
            "no_client_reaches_the_legacy_namespace",
            no_client_reaches_the_legacy_namespace,
        ),
        (
            "an_api_connection_is_served_here_for_the_person_its_handshake_named",
            an_api_connection_is_served_here_for_the_person_its_handshake_named,
        ),
        (
            "a_change_stands_when_the_legacy_core_refuses_or_does_not_answer",
            a_change_stands_when_the_legacy_core_refuses_or_does_not_answer,
        ),
        (
            "nothing_is_changed_once_the_control_link_has_ended",
            nothing_is_changed_once_the_control_link_has_ended,
        ),
        (
            "two_processes_never_leave_the_installation_without_an_active_owner",
            two_processes_never_leave_the_installation_without_an_active_owner,
        ),
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
        (
            "a_refused_start_removes_only_what_it_wrote",
            a_refused_start_removes_only_what_it_wrote,
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
    /// `PLUR1BUS_P4_IDENTITY=ts`: the native methods of P4-12 go back to the relay.
    identity_ts: bool,
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
    if o.identity_ts {
        cmd.env("PLUR1BUS_P4_IDENTITY", "ts");
    } else {
        cmd.env_remove("PLUR1BUS_P4_IDENTITY");
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

/// P4D-7: the front door's lines are lines of `logs/core.log` as well (`src: "front-door"`), at the level config.json
/// names; stderr keeps every one of them.
fn the_front_doors_lines_are_in_the_core_log() {
    let front_lines = |d: &Door| -> Vec<Value> {
        std::fs::read_to_string(d.path("logs/core.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
            .filter(|l| l["src"] == "front-door")
            .collect()
    };
    let stop = |d: &mut Door| {
        let mut c = d.owner();
        let r = c.call("core.shutdown", json!({"budgetMs": 2000}));
        assert_eq!(r["result"]["accepted"], true, "{r}");
        assert_eq!(d.wait(Duration::from_secs(10)), Some(0), "{}", d.stderr());
    };
    let mut d = door(Opts::default());
    stop(&mut d);
    let lines = front_lines(&d);
    let messages: Vec<&str> = lines.iter().filter_map(|l| l["msg"].as_str()).collect();
    assert_eq!(messages.first(), Some(&"core ready"), "{messages:?}");
    assert_eq!(messages.last(), Some(&"core stopped"), "{messages:?}");
    assert!(messages.contains(&"core stopping"), "{messages:?}");
    let ready = &lines[0];
    assert_eq!(ready["level"], "info", "{ready}");
    assert_eq!(ready["role"], "core", "{ready}");
    assert_eq!(ready["address"], d.address(), "{ready}");
    assert_eq!(ready["supervised"], false, "{ready}");
    assert!(
        ready["at"].is_string() && ready.get("event").is_none(),
        "{ready}"
    );
    assert_eq!(lines.last().unwrap()["failed"], false);
    assert!(d.stderr().contains("core ready"), "{}", d.stderr());

    let quiet = |home: &Path| {
        let mut config = plur1bus_config::defaults();
        config["core"]["logLevel"] = json!("warn");
        std::fs::write(home.join("config.json"), config.to_string()).unwrap();
    };
    let mut d = door(Opts {
        prepare: Some(&quiet),
        ..Opts::default()
    });
    stop(&mut d);
    let lines = front_lines(&d);
    assert!(lines.iter().all(|l| l["level"] != "info"), "{lines:?}");
    assert!(d.stderr().contains("core ready"), "{}", d.stderr());
}

/// P4-12 flip A1: `breakglass.notices` and `identity.principals` are answered by the front door for the owner
/// connection (the fake legacy core would echo the line), by the legacy core for an API connection, and by the legacy
/// core for everyone with the switch at `ts`.
fn the_first_native_methods_serve_the_owner_here_and_everyone_else_through_the_relay() {
    let d = door(Opts {
        prepare: Some(&legacy_admin_store),
        ..Opts::default()
    });
    let mut c = d.owner();
    let r = c.call("breakglass.notices", json!({}));
    assert_eq!(r["result"], json!({"notices": []}), "{r}");
    // The fake legacy core creates no identity store, and the front door creates none: there is no identity service.
    let r = c.call("identity.principals", json!({}));
    assert_eq!(code(&r), "E_NOT_AVAILABLE", "{r}");
    assert_eq!(r["error"]["message"], "identity unavailable");
    assert!(!d.path("state/identity.sqlite").exists());
    // The parameters are checked against the schema before the guard and the method.
    let r = c.call("breakglass.notices", json!({"unknown": 1}));
    assert_eq!(code(&r), "E_INVALID_PARAMS", "{r}");
    let r = c.call("identity.principals", json!({"humanId": 7}));
    assert_eq!(code(&r), "E_INVALID_PARAMS", "{r}");
    // `_meta` is the transport's, not the method's.
    let r = c.call(
        "breakglass.notices",
        json!({"_meta": {"traceparent": "00-x-y-01"}}),
    );
    assert_eq!(r["result"], json!({"notices": []}), "{r}");
    assert!(
        !d.path("logs/audit.log").exists(),
        "an allowed call is not an audit event"
    );

    // An API connection's call is the legacy core's: its guard resolves the person behind the delegation.
    let mut api = d.client();
    let token = d.token("api-delegation.token");
    let principal = json!({"userId":"alice","kind":"person","role":"member"});
    let hello = api.call("core.auth", json!({"token": d.token("core.token"), "api": {"clientId":"harness-api","token": token, "principal": principal}}));
    assert!(hello.get("result").is_some(), "{hello}");
    for method in ["breakglass.notices", "identity.principals"] {
        let r = api.call(method, json!({}));
        assert_eq!(r["result"]["caller"], "api", "{method} relayed: {r}");
    }
    drop((c, api));

    let d = door(Opts {
        identity_ts: true,
        ..Opts::default()
    });
    let mut c = d.owner();
    for method in ["breakglass.notices", "identity.principals"] {
        let r = c.call(method, json!({}));
        assert_eq!(r["result"]["caller"], "owner", "{method} relayed: {r}");
    }
    assert!(!d.path("state/admin.sqlite").exists(), "nothing native ran");

    // Without the store the legacy core creates at its start, the front door serves nobody and creates nothing: a
    // store created here would make the local owner an Owner whatever the installation had stored.
    let d = door(Opts::default());
    let mut c = d.owner();
    let r = c.call("breakglass.notices", json!({}));
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_UNAUTHORIZED", "resolver-failed"),
        "{r}"
    );
    assert!(!d.path("state/admin.sqlite").exists());
}

/// `state/admin.sqlite` as the legacy core creates it at its start (the fake legacy core has none).
fn legacy_admin_store(home: &Path) {
    use plur1bus_core::identity::admin_store::AdminStore;
    drop(AdminStore::open(&home.join("state/admin.sqlite"), "local-owner", &|_| {}).unwrap());
}

/// The local owner is the person stored for it: disabled, it is nobody (and that is audited); demoted, it keeps what
/// every human role may do. Both are written here as the legacy core writes them, into the home's own store.
fn a_disabled_or_demoted_local_owner_meets_the_native_guard() {
    use plur1bus_core::identity::admin_store::AdminStore;
    let d = door(Opts {
        prepare: Some(&legacy_admin_store),
        ..Opts::default()
    });
    let mut c = d.owner();
    assert!(c
        .call("breakglass.notices", json!({}))
        .get("result")
        .is_some());
    let mut store =
        AdminStore::open(&d.path("state/admin.sqlite"), "local-owner", &|_| {}).unwrap();
    store.set_role("second", "owner", &mut || Ok(())).unwrap();
    store
        .set_role("local-owner", "viewer", &mut || Ok(()))
        .unwrap();
    let r = c.call("breakglass.notices", json!({}));
    assert_eq!(
        r["result"],
        json!({"notices": []}),
        "a viewer reads its own notices: {r}"
    );
    store
        .set_disabled("local-owner", true, "second", 1, &mut || Ok(()))
        .unwrap();
    for method in ["breakglass.notices", "identity.principals"] {
        let r = c.call(method, json!({}));
        assert_eq!(
            (code(&r), reason(&r)),
            ("E_UNAUTHORIZED", "no-principal"),
            "{method}: {r}"
        );
    }
    let lines: Vec<Value> = std::fs::read_to_string(d.path("logs/audit.log"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[0]["action"], "rbac.unauthenticated");
    assert_eq!(lines[0]["target"], "breakglass.notices");
    assert_eq!(lines[0]["detail"]["reason"], "no-principal");
    assert!(
        d.path("logs/audit-chain.jsonl").exists(),
        "and in the chain"
    );
    // The refusal has the TypeScript server's line in the front door's output.
    #[cfg(unix)]
    d.await_stderr("rpc error", Duration::from_secs(5));
    #[cfg(unix)]
    assert!(
        d.stderr().contains("\"reason\":\"no-principal\""),
        "{}",
        d.stderr()
    );
    // The connection stays, and a relayed call is still the legacy core's to judge.
    let r = c.call("memory.list", json!({"agentId": "bernd"}));
    assert_eq!(r["result"]["caller"], "owner", "{r}");
}

/// `state/admin.sqlite` as the legacy core creates it, with a second person (`second`, a Member).
fn legacy_admin_store_with_a_member(home: &Path) {
    use plur1bus_core::identity::admin_store::AdminStore;
    let mut store =
        AdminStore::open(&home.join("state/admin.sqlite"), "local-owner", &|_| {}).unwrap();
    store.set_role("second", "member", &mut || Ok(())).unwrap();
}

/// What the fake legacy core was called with under `legacy.*`, on any link.
fn legacy_calls(d: &Door) -> Vec<Value> {
    std::fs::read_to_string(d.path("run/core-legacy.legacy-calls"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn audit_log(d: &Door) -> Vec<Value> {
    std::fs::read_to_string(d.path("logs/audit.log"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// `(role, disabled)` as `state/admin.sqlite` has it now, read as another process reads it.
fn stored_person(d: &Door, id: &str) -> (String, bool) {
    use plur1bus_core::identity::admin_store::AdminStore;
    let store = AdminStore::open(&d.path("state/admin.sqlite"), "local-owner", &|_| {}).unwrap();
    let row = store
        .users()
        .unwrap()
        .into_iter()
        .find(|u| u.id == id)
        .unwrap_or_else(|| panic!("no person {id}"));
    (row.role, row.disabled)
}

/// P4-12 flip A2: `user.role.set`, `user.disable` and `user.enable` are served here for the owner connection: the
/// change is in the store, its audit event in the log and the chain, and the legacy core is asked over the control link
/// for what follows the TypeScript handler. Every other caller's call is the legacy core's, as is everyone's with the
/// switch at `ts`.
fn a_persons_role_and_status_change_here_and_the_legacy_core_is_told() {
    let d = door(Opts {
        prepare: Some(&legacy_admin_store_with_a_member),
        ..Opts::default()
    });
    assert_eq!(
        d.token("core-legacy.control"),
        "front-door",
        "the control link names itself"
    );
    let mut c = d.owner();
    let r = c.call(
        "user.role.set",
        json!({"userId": "second", "role": "admin"}),
    );
    assert_eq!(
        r["result"],
        json!({"userId": "second", "role": "admin"}),
        "{r}"
    );
    assert_eq!(stored_person(&d, "second"), ("admin".to_owned(), false));
    let asked = |user: &str, rights: bool, learning: bool| {
        json!({"control": true, "method": "legacy.account.changed",
            "params": {"userId": user, "rights": rights, "learning": learning}})
    };
    assert_eq!(legacy_calls(&d), vec![asked("second", true, true)]);

    let r = c.call(
        "user.disable",
        json!({"userId": "second", "reason": "left"}),
    );
    assert_eq!(
        r["result"],
        json!({"userId": "second", "disabled": true}),
        "{r}"
    );
    assert_eq!(stored_person(&d, "second"), ("admin".to_owned(), true));
    let r = c.call("user.enable", json!({"userId": "second"}));
    assert_eq!(
        r["result"],
        json!({"userId": "second", "disabled": false}),
        "{r}"
    );
    assert_eq!(stored_person(&d, "second"), ("admin".to_owned(), false));
    // Enabled again: no change, nothing to ask for.
    let r = c.call("user.enable", json!({"userId": "second"}));
    assert!(r.get("result").is_some(), "{r}");
    assert_eq!(
        legacy_calls(&d)[1..],
        [asked("second", true, true), asked("second", true, false)]
    );

    let lines = audit_log(&d);
    let actions: Vec<&str> = lines
        .iter()
        .map(|l| l["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        actions,
        ["user.role.set", "user.disabled", "user.enabled"],
        "{lines:?}"
    );
    assert_eq!(
        lines[0]["actor"],
        json!({"user": "local-owner", "host": "rpc"})
    );
    assert_eq!(
        lines[0]["detail"],
        json!({"previous": "member", "role": "admin"})
    );
    assert_eq!(
        lines[1]["detail"],
        json!({"role": "admin", "reason": "left"})
    );
    assert_ne!(
        lines[1]["target"], "second",
        "a status change names its people by hash"
    );
    let chained = std::fs::read_to_string(d.path("logs/audit-chain.jsonl")).unwrap();
    assert_eq!(chained.lines().count(), 3, "and each is in the chain");

    // The schema comes first; the handler's refusals are the TypeScript handler's.
    for (method, params) in [
        ("user.role.set", json!({"userId": "second", "role": "king"})),
        ("user.role.set", json!({"userId": "second"})),
        ("user.disable", json!({"userId": "second", "reason": 7})),
        (
            "user.enable",
            json!({"userId": "second", "reason": "no such member"}),
        ),
    ] {
        let r = c.call(method, params);
        assert_eq!(code(&r), "E_INVALID_PARAMS", "{method}: {r}");
    }
    let r = c.call(
        "user.role.set",
        json!({"userId": "second", "role": "owner"}),
    );
    assert_eq!((code(&r), reason(&r)), ("E_DENIED", "single-owner"), "{r}");
    let r = c.call(
        "user.role.set",
        json!({"userId": "local-owner", "role": "admin"}),
    );
    assert_eq!((code(&r), reason(&r)), ("E_CONFLICT", "last-owner"), "{r}");
    let r = c.call("user.disable", json!({"userId": "local-owner"}));
    assert_eq!((code(&r), reason(&r)), ("E_CONFLICT", "last-owner"), "{r}");
    assert_eq!(
        audit_log(&d).len(),
        3,
        "a refusal of the handler changes and audits nothing"
    );
    assert_eq!(legacy_calls(&d).len(), 3);
    assert_eq!(
        stored_person(&d, "local-owner"),
        ("owner".to_owned(), false)
    );

    // An API connection's call is the legacy core's (flip A3 serves those natively).
    let mut api = d.client();
    let principal = json!({"userId":"alice","kind":"person","role":"admin"});
    let hello = api.call("core.auth", json!({"token": d.token("core.token"), "api": {"clientId":"harness-api","token": d.token("api-delegation.token"), "principal": principal}}));
    assert!(hello.get("result").is_some(), "{hello}");
    for method in ["user.role.set", "user.disable", "user.enable"] {
        let r = api.call(method, json!({"userId": "second", "role": "viewer"}));
        assert_eq!(r["result"]["caller"], "api", "{method} relayed: {r}");
    }
    assert_eq!(stored_person(&d, "second"), ("admin".to_owned(), false));
    drop((c, api));

    let d = door(Opts {
        prepare: Some(&legacy_admin_store_with_a_member),
        identity_ts: true,
        ..Opts::default()
    });
    let mut c = d.owner();
    for method in ["user.role.set", "user.disable", "user.enable"] {
        let r = c.call(method, json!({"userId": "second", "role": "viewer"}));
        assert_eq!(r["result"]["caller"], "owner", "{method} relayed: {r}");
    }
    assert_eq!(stored_person(&d, "second"), ("member".to_owned(), false));
    assert!(legacy_calls(&d).is_empty());
}

/// One request with a request-level delegation (`api`), as harness-api sends every request of its connection.
fn call_as(c: &mut Client, id: u64, method: &str, params: Value, api: Option<&Value>) -> Value {
    let mut frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    if let Some(api) = api {
        frame["api"] = api.clone();
    }
    c.send_line(&frame.to_string());
    c.response(&json!(id))
}

/// P4-12 flip A3: a native method is served here for a person the harness API acts for, when the request's delegation
/// is the one the connection's handshake presented (same user, kind and transport). The person is the one the store
/// knows: the stored role decides, a disabled person is refused, an unknown one is nobody. Every other request of an
/// API connection (no delegation, another identity or transport, the API service itself, an agent principal) goes to
/// the legacy core as before; the fake legacy core echoes those, so a relayed request is visible as an echo.
fn an_api_connection_is_served_here_for_the_person_its_handshake_named() {
    use plur1bus_core::identity::admin_store::AdminStore;
    let prepare = |home: &Path| {
        let mut store =
            AdminStore::open(&home.join("state/admin.sqlite"), "local-owner", &|_| {}).unwrap();
        for (id, role) in [("alice", "admin"), ("bob", "admin"), ("second", "member")] {
            store.set_role(id, role, &mut || Ok(())).unwrap();
        }
    };
    let d = door(Opts {
        prepare: Some(&prepare),
        ..Opts::default()
    });
    let token = d.token("api-delegation.token");
    // What the API claims about the person's role counts for nothing: the store's does.
    let acting_for = |user: &str, kind: &str| {
        json!({"clientId":"harness-api","token": token,
            "principal": {"userId": user, "kind": kind, "role": "viewer"}})
    };
    let connect = |delegation: &Value| {
        let mut c = d.client();
        let r = c.call(
            "core.auth",
            json!({"token": d.token("core.token"), "api": delegation}),
        );
        assert!(r.get("result").is_some(), "{r}");
        c
    };
    let alice = acting_for("alice", "person");
    let mut c = connect(&alice);
    let change = |role: &str| json!({"userId": "second", "role": role});
    let relayed = |r: &Value| r["result"]["caller"] == "api" && r["result"]["echo"].is_object();

    // Served here: the change is stored, audited under her id, and the legacy core is asked for what follows.
    let r = call_as(&mut c, 1, "user.role.set", change("operator"), Some(&alice));
    assert_eq!(
        r["result"],
        json!({"userId": "second", "role": "operator"}),
        "{r}"
    );
    assert_eq!(stored_person(&d, "second"), ("operator".to_owned(), false));
    assert_eq!(legacy_calls(&d).len(), 1);
    let lines = audit_log(&d);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["actor"], json!({"user": "alice", "host": "rpc"}));
    let r = call_as(&mut c, 2, "breakglass.notices", json!({}), Some(&alice));
    assert_eq!(r["result"], json!({"notices": []}), "{r}");

    // Not the front door's to serve: relayed, and the legacy core answers (here: echoes). Nothing changes.
    let bob = acting_for("bob", "person");
    let remote = {
        let mut other = alice.clone();
        other["transport"] = json!("remote");
        other
    };
    let agent = acting_for("alice", "agent");
    let service = json!({"clientId":"harness-api","token": token});
    for (what, delegation) in [
        ("no delegation", None),
        ("another person", Some(&bob)),
        ("another transport", Some(&remote)),
        ("another kind", Some(&agent)),
        ("the service itself", Some(&service)),
    ] {
        let r = call_as(&mut c, 10, "user.role.set", change("viewer"), delegation);
        assert!(relayed(&r), "{what}: {r}");
    }
    assert_eq!(stored_person(&d, "second"), ("operator".to_owned(), false));
    assert_eq!(legacy_calls(&d).len(), 1);
    // A delegation that does not verify is refused here, as for a relayed request.
    let forged =
        json!({"clientId":"harness-api","token": "0".repeat(64), "principal": alice["principal"]});
    let r = call_as(&mut c, 11, "user.role.set", change("viewer"), Some(&forged));
    assert_eq!(reason(&r), "api-delegation", "{r}");
    // The request's shape is checked after the delegation, the parameters after that.
    c.send_line(&json!({"jsonrpc":"2.0","id":12,"method":"user.role.set","params":change("viewer"),"api":alice,"extra":1}).to_string());
    assert_eq!(reason(&c.response(&json!(12))), "invalid-request");
    let r = call_as(
        &mut c,
        13,
        "user.role.set",
        json!({"userId": "second", "role": "king"}),
        Some(&alice),
    );
    assert_eq!(code(&r), "E_INVALID_PARAMS", "{r}");
    assert_eq!(stored_person(&d, "second"), ("operator".to_owned(), false));

    // The person is read from the store for every request: disabled by another process, she is refused as disabled.
    let mut store =
        AdminStore::open(&d.path("state/admin.sqlite"), "local-owner", &|_| {}).unwrap();
    store
        .set_disabled("alice", true, "local-owner", 1, &mut || Ok(()))
        .unwrap();
    let r = call_as(&mut c, 20, "user.role.set", change("viewer"), Some(&alice));
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_DENIED", "person-disabled"),
        "{r}"
    );
    store
        .set_disabled("alice", false, "local-owner", 2, &mut || Ok(()))
        .unwrap();
    // Demoted by another process, she meets the guard as what she is now.
    store.set_role("alice", "member", &mut || Ok(())).unwrap();
    let r = call_as(&mut c, 21, "user.role.set", change("viewer"), Some(&alice));
    assert_eq!((code(&r), reason(&r)), ("E_DENIED", "role-denied"), "{r}");
    assert_eq!(stored_person(&d, "second"), ("operator".to_owned(), false));
    let lines = audit_log(&d);
    assert_eq!(
        lines.len(),
        2,
        "the disabled refusal is not audited, the denial is: {lines:?}"
    );
    assert_eq!(lines[1]["action"], "rbac.denied");
    assert_eq!(lines[1]["actor"]["user"], "alice");

    // A person the store does not know is nobody, whatever role the API claims, and never the local owner.
    let ghost = json!({"clientId":"harness-api","token": token,
        "principal": {"userId": "ghost", "kind": "person", "role": "owner"}});
    let mut g = connect(&ghost);
    let r = call_as(&mut g, 1, "user.role.set", change("viewer"), Some(&ghost));
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_UNAUTHORIZED", "no-principal"),
        "{r}"
    );
    // On the ghost's connection alice's delegation is another identity: relayed.
    let r = call_as(&mut g, 2, "user.role.set", change("viewer"), Some(&alice));
    assert!(relayed(&r), "{r}");

    // The API service's own connection and an agent's: the legacy core's, with or without a delegation.
    let mut s = connect(&service);
    for delegation in [Some(&service), Some(&alice), None] {
        let r = call_as(&mut s, 3, "user.role.set", change("viewer"), delegation);
        assert!(relayed(&r), "{r}");
    }
    let mut a = connect(&agent);
    let r = call_as(&mut a, 4, "user.role.set", change("viewer"), Some(&agent));
    assert!(relayed(&r), "{r}");
    // The kind is part of what the handshake bound: on the agent's connection a delegation for the person of the same
    // user id is another identity, not a way to be served as her.
    let r = call_as(&mut a, 5, "user.role.set", change("viewer"), Some(&alice));
    assert!(relayed(&r), "{r}");
    assert_eq!(stored_person(&d, "second"), ("operator".to_owned(), false));

    // The transport is part of what the handshake bound.
    let mut local = alice.clone();
    local["transport"] = json!("loopback");
    store.set_role("alice", "admin", &mut || Ok(())).unwrap();
    let mut l = connect(&local);
    let r = call_as(&mut l, 5, "user.role.set", change("member"), Some(&local));
    assert_eq!(
        r["result"],
        json!({"userId": "second", "role": "member"}),
        "{r}"
    );
    let r = call_as(&mut l, 6, "user.role.set", change("viewer"), Some(&alice));
    assert!(relayed(&r), "without the handshake's transport: {r}");
    assert_eq!(stored_person(&d, "second"), ("member".to_owned(), false));
    drop((c, g, s, a, l));

    // With the switch at `ts` every request of an API connection is the legacy core's.
    let d = door(Opts {
        prepare: Some(&prepare),
        identity_ts: true,
        ..Opts::default()
    });
    let token = d.token("api-delegation.token");
    let alice = json!({"clientId":"harness-api","token": token,
        "principal": {"userId": "alice", "kind": "person", "role": "admin"}});
    let mut c = d.client();
    let r = c.call(
        "core.auth",
        json!({"token": d.token("core.token"), "api": alice}),
    );
    assert!(r.get("result").is_some(), "{r}");
    let r = call_as(
        &mut c,
        1,
        "user.role.set",
        json!({"userId": "second", "role": "viewer"}),
        Some(&alice),
    );
    assert_eq!(r["result"]["caller"], "api", "{r}");
    assert_eq!(stored_person(&d, "second"), ("member".to_owned(), false));
}

/// P4-12 flip A2 (`docs/phase4/bridge.md`): `legacy.*` is the front door's own namespace on its control link. No
/// client's request under it reaches the legacy core, whoever the client is and whether the method exists; the answer
/// is a TypeScript core's for a method it does not serve.
fn no_client_reaches_the_legacy_namespace() {
    let engine = Secret::fresh().unwrap();
    let e = engine.expose().to_owned();
    let prepare = move |home: &Path| {
        legacy_admin_store_with_a_member(home);
        std::fs::create_dir_all(home.join("run")).unwrap();
        std::fs::write(home.join("run/engine.token"), &e).unwrap();
    };
    let d = door(Opts {
        prepare: Some(&prepare),
        ..Opts::default()
    });
    let owner = d.owner();
    let api_delegation = json!({"clientId":"harness-api","token": d.token("api-delegation.token"),
        "principal": {"userId":"local-owner","kind":"person","role":"owner"}});
    let mut api = d.client();
    let r = api.call(
        "core.auth",
        json!({"token": d.token("core.token"), "api": api_delegation}),
    );
    assert!(r.get("result").is_some(), "{r}");
    let mut service = d.client();
    let r = service.call(
        "core.auth",
        json!({"token": d.token("core.token"),
        "api": {"clientId":"harness-api","token": d.token("api-delegation.token")}}),
    );
    assert!(r.get("result").is_some(), "{r}");
    let mut scoped = d.client();
    let r = scoped.call("core.auth", json!({"token": "c".repeat(64)}));
    assert!(r.get("result").is_some(), "{r}");
    let mut machine = d.client();
    let r = machine.call("core.auth", json!({"token": engine.expose(), "engine": {"clientId":"plur1bus-engine","token": engine.expose()}}));
    assert!(r.get("result").is_some(), "{r}");

    let params = json!({"userId": "second", "rights": true, "learning": true});
    for (who, mut client) in [
        ("owner", owner),
        ("api", api),
        ("api service", service),
        ("scoped client", scoped),
        ("engine", machine),
    ] {
        for method in ["legacy.account.changed", "legacy.unknown", "legacy."] {
            let r = client.call(method, params.clone());
            assert_eq!(
                (r["error"]["code"].as_i64(), code(&r), reason(&r)),
                (Some(-32601), "E_INTERNAL", "method-not-found"),
                "{who} {method}: {r}"
            );
            assert_eq!(r["error"]["message"], format!("method not found: {method}"));
        }
        // The connection stays, and the rest of its calls go where they went before.
        let r = client.call("memory.list", json!({"agentId": "bernd"}));
        assert!(r["result"]["caller"].is_string(), "{who}: {r}");
    }
    // The name is what JSON.parse reads: escapes are resolved and the last of two `method` members counts, here as in
    // the legacy core.
    let mut c = d.owner();
    for (id, line) in [
        (
            21,
            r#"{"jsonrpc":"2.0","id":21,"method":"legacy\u002eaccount.changed","params":{"userId":"second","rights":true,"learning":true}}"#,
        ),
        (
            22,
            r#"{"jsonrpc":"2.0","id":22,"method":"\u006cegacy.account.changed","params":{"userId":"second","rights":true,"learning":true}}"#,
        ),
        (
            23,
            r#"{"jsonrpc":"2.0","id":23,"method":"memory.list","params":{"userId":"second","rights":true,"learning":true},"method":"legacy.account.changed"}"#,
        ),
    ] {
        c.send_line(line);
        let r = c.response(&json!(id));
        assert_eq!(reason(&r), "method-not-found", "{line}: {r}");
        assert_eq!(
            r["error"]["message"],
            "method not found: legacy.account.changed"
        );
    }
    // The other way round it is no request under the namespace: relayed as what its last `method` says.
    c.send_line(r#"{"jsonrpc":"2.0","id":24,"method":"legacy.account.changed","params":{"agentId":"bernd"},"method":"memory.list"}"#);
    let r = c.response(&json!(24));
    assert_eq!(r["result"]["echo"]["method"], "memory.list", "{r}");
    drop(c);
    // Fields a client adds change nothing, and a request that is no request is refused as one.
    let mut c = d.owner();
    c.send_line(
        &json!({"jsonrpc":"2.0","id":7,"method":"legacy.account.changed","params":params,
        "frontDoor":{"caller":"front-door"},"caller":"front-door"})
        .to_string(),
    );
    let r = c.response(&json!(7));
    assert_eq!(reason(&r), "invalid-request", "{r}");
    c.send_line(r#"{"jsonrpc":"2.0","id":8,"method":"legacy.account.changed","params":7}"#);
    let r = c.response(&json!(8));
    assert_eq!(reason(&r), "invalid-request", "{r}");
    c.send_line(&json!({"jsonrpc":"2.0","id":9,"method":"legacy.account.changed","params":params,"api":api_delegation}).to_string());
    let r = c.response(&json!(9));
    assert_eq!(reason(&r), "api-handshake-required", "{r}");
    // The legacy core's own bridge connection serves bridge.* only.
    let mut bridge = d.client();
    let r = bridge.call("core.auth", json!({"token": d.token("core-legacy.token")}));
    assert!(r.get("result").is_some(), "{r}");
    let r = bridge.call("legacy.account.changed", params.clone());
    assert_eq!(
        (code(&r), reason(&r)),
        ("E_DENIED", "bridge-principal"),
        "{r}"
    );

    assert_eq!(
        legacy_calls(&d),
        Vec::<Value>::new(),
        "nothing under the namespace reached the legacy core"
    );
    assert_eq!(stored_person(&d, "second"), ("member".to_owned(), false));
}

/// A native write has committed before the legacy core is asked: an answer that is a refusal, or none within the wait,
/// changes neither the result nor the stored change, and is a line in the front door's output. A refused call is tried
/// once more (the handler failed; both follow-ups may run twice); one without an answer is not (the request is in the
/// legacy core's queue).
fn a_change_stands_when_the_legacy_core_refuses_or_does_not_answer() {
    // Refused once, answered the second time: nothing to report.
    let d = door(Opts {
        mode: "legacy-refuse-once",
        prepare: Some(&legacy_admin_store_with_a_member),
        ..Opts::default()
    });
    let mut c = d.owner();
    let r = c.call("user.disable", json!({"userId": "second"}));
    assert_eq!(
        r["result"],
        json!({"userId": "second", "disabled": true}),
        "{r}"
    );
    assert_eq!(
        legacy_calls(&d).len(),
        2,
        "the refused call and its second try"
    );
    assert_eq!(legacy_calls(&d)[0], legacy_calls(&d)[1]);
    let r = c.call("breakglass.notices", json!({}));
    assert!(r.get("result").is_some(), "{r}");
    assert!(
        !d.stderr().contains("the legacy core was not told"),
        "{}",
        d.stderr()
    );
    drop(c);

    for (mode, why, calls) in [
        ("legacy-refuse", "refused:E_INTERNAL", 2),
        ("legacy-silent", "timeout", 1),
    ] {
        let d = door(Opts {
            mode,
            prepare: Some(&legacy_admin_store_with_a_member),
            ..Opts::default()
        });
        let mut c = d.owner();
        let started = Instant::now();
        let r = c.call(
            "user.role.set",
            json!({"userId": "second", "role": "viewer"}),
        );
        assert_eq!(
            r["result"],
            json!({"userId": "second", "role": "viewer"}),
            "{mode}: {r}"
        );
        if mode == "legacy-silent" {
            assert!(
                started.elapsed() >= Duration::from_secs(4),
                "{:?}",
                started.elapsed()
            );
        }
        assert!(
            started.elapsed() < Duration::from_secs(9),
            "{mode}: {:?}",
            started.elapsed()
        );
        assert_eq!(stored_person(&d, "second"), ("viewer".to_owned(), false));
        assert_eq!(legacy_calls(&d).len(), calls, "{mode}");
        assert_eq!(audit_log(&d).len(), 1, "{mode}");
        let until = Instant::now() + Duration::from_secs(5);
        while !d
            .stderr()
            .contains("the legacy core was not told of an account change")
        {
            assert!(Instant::now() < until, "{mode}: {}", d.stderr());
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            d.stderr().contains(&format!("\"reason\":\"{why}\"")),
            "{mode}: {}",
            d.stderr()
        );
        assert!(
            !d.stderr().contains("userId"),
            "the line names nobody: {}",
            d.stderr()
        );
        // The connection serves on, and a late answer is nobody's.
        let r = c.call("breakglass.notices", json!({}));
        assert!(r.get("result").is_some(), "{mode}: {r}");
    }
}

/// The control link only ends when the legacy core goes away. From then on a write is refused before anything is
/// stored or audited: what follows a change in the legacy core could not happen any more.
fn nothing_is_changed_once_the_control_link_has_ended() {
    let d = door(Opts {
        mode: "drop-control",
        prepare: Some(&legacy_admin_store_with_a_member),
        ..Opts::default()
    });
    let until = Instant::now() + Duration::from_secs(5);
    while !d.stderr().contains("the control link ended") {
        assert!(Instant::now() < until, "{}", d.stderr());
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut c = d.owner();
    for (method, params) in [
        (
            "user.role.set",
            json!({"userId": "second", "role": "admin"}),
        ),
        ("user.disable", json!({"userId": "second"})),
        ("user.enable", json!({"userId": "second"})),
    ] {
        let r = c.call(method, params);
        assert_eq!(
            (code(&r), reason(&r)),
            ("E_NOT_AVAILABLE", "stopping"),
            "{method}: {r}"
        );
    }
    assert_eq!(stored_person(&d, "second"), ("member".to_owned(), false));
    assert!(audit_log(&d).is_empty());
    assert!(legacy_calls(&d).is_empty());
    // What only reads is still served.
    let r = c.call("breakglass.notices", json!({}));
    assert_eq!(r["result"], json!({"notices": []}), "{r}");
}

/// Flip plan F1: the front door and the legacy core both write `state/admin.sqlite`. With two Owners, one process
/// demotes one while the other process demotes the other: the store's rule is checked under SQLite's write lock, so
/// exactly one of the two changes happens, round after round, and an active Owner always remains. The second process
/// here is this test, with the store's Rust port (what the TypeScript store does is replayed against it, P4-12 PR1).
fn two_processes_never_leave_the_installation_without_an_active_owner() {
    use plur1bus_core::identity::admin_store::{AdminError, AdminStore};
    let prepare = |home: &Path| {
        let mut store =
            AdminStore::open(&home.join("state/admin.sqlite"), "local-owner", &|_| {}).unwrap();
        store.set_role("boss", "owner", &mut || Ok(())).unwrap();
    };
    let d = door(Opts {
        prepare: Some(&prepare),
        ..Opts::default()
    });
    let mut c = d.owner();
    let mut other =
        AdminStore::open(&d.path("state/admin.sqlite"), "local-owner", &|_| {}).unwrap();
    // How long a native call takes here: the rival starts between at once and about one and a half such times after the front door's
    // call was sent, so both orders and the overlap in between all happen, on a fast machine and on a slow one.
    let started = Instant::now();
    for _ in 0..10 {
        assert!(c
            .call("breakglass.notices", json!({}))
            .get("result")
            .is_some());
    }
    let call = started.elapsed() / 10;
    let (mut here, mut there) = (0, 0);
    for round in 0..48_u32 {
        // Both Owners again (a promotion is the store's to allow; the handler's single-owner rule is not in the way here).
        other.set_role("boss", "owner", &mut || Ok(())).unwrap();
        other
            .set_role("local-owner", "owner", &mut || Ok(()))
            .unwrap();
        let go = Arc::new(std::sync::Barrier::new(2));
        let (start, store_path) = (go.clone(), d.path("state/admin.sqlite"));
        // The other process demotes the local owner; on odd rounds it disables it instead.
        let rival = std::thread::spawn(move || {
            let mut store = AdminStore::open(&store_path, "local-owner", &|_| {}).unwrap();
            start.wait();
            std::thread::sleep(call * (round % 12) / 8);
            let outcome = if round % 2 == 0 {
                store.set_role("local-owner", "admin", &mut || Ok(()))
            } else {
                store.set_disabled("local-owner", true, "boss", 1, &mut || Ok(()))
            };
            match outcome {
                Ok(()) => true,
                Err(AdminError::Rpc {
                    reason: Some("last-owner"),
                    ..
                }) => false,
                Err(e) => panic!("round {round}: {e}"),
            }
        });
        go.wait();
        let r = c.call("user.role.set", json!({"userId": "boss", "role": "admin"}));
        let rival_won = rival.join().unwrap();
        // Whoever came second met the rule, or met a caller that is no Owner any more (the guard reads the same store).
        let front_won = r.get("result").is_some();
        if !front_won {
            assert!(
                matches!(
                    (code(&r), reason(&r)),
                    ("E_CONFLICT", "last-owner")
                        | ("E_DENIED", "owner-only")
                        | ("E_UNAUTHORIZED", "no-principal")
                ),
                "round {round}: {r}"
            );
        }
        assert!(
            front_won != rival_won,
            "round {round}: exactly one change (front door {front_won}, rival {rival_won}): {r}"
        );
        let owners: Vec<_> = other
            .users()
            .unwrap()
            .into_iter()
            .filter(|u| u.role == "owner" && !u.disabled)
            .map(|u| u.id)
            .collect();
        assert_eq!(owners.len(), 1, "round {round}: {owners:?}");
        if front_won {
            here += 1
        } else {
            there += 1
        }
        // Undo a disable for the next round.
        other
            .set_disabled("local-owner", false, "boss", 1, &mut || Ok(()))
            .unwrap();
    }
    println!(
        "    front door won {here} rounds, the other process {there} (a native call: {call:?})"
    );
    assert!(
        here > 0 && there > 0,
        "both orders were tried: {here} and {there}"
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
    // The front door's lines in `logs/core.log` (P4D-7) are part of its output.
    let logged: String = std::fs::read_dir(d.path("logs"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("core.log"))
        .map(|e| String::from_utf8_lossy(&std::fs::read(e.path()).unwrap()).into_owned())
        .collect();
    assert!(logged.contains("\"src\":\"front-door\""), "{logged}");
    let all = format!("{} {} {logged}", d.stderr(), Value::Array(replies));
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
/// Re-review M-d: the fake legacy core reacts to console events as Node does (Ctrl+Break ends it without a drain), so
/// this holds only because the front door gives its legacy core a console of its own (`CREATE_NO_WINDOW`).
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

/// Final review FR-M1: a start refused before it wrote anything (something answers on `run/core.sock`) leaves every file
/// of whatever answers there byte for byte, the socket included; a start that fails later removes only what it wrote
/// itself, not the run files an earlier core left behind.
fn a_refused_start_removes_only_what_it_wrote() {
    #[cfg(unix)]
    {
        let snapshot = |run: &Path| -> Vec<(String, Vec<u8>)> {
            let mut all: Vec<_> = std::fs::read_dir(run)
                .unwrap()
                .map(|e| e.unwrap())
                .map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let bytes = if e.file_type().unwrap().is_file() {
                        std::fs::read(e.path()).unwrap()
                    } else {
                        b"(not a file)".to_vec()
                    };
                    (name, bytes)
                })
                .collect();
            all.sort();
            all
        };
        let theirs = [
            ("core.token", "their core token"),
            ("api-delegation.token", "their api token"),
            ("core.pid", "4242 5d0f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f\n"),
            ("core-legacy.token", "their link token"),
            ("core-legacy.credentials", "{\"core\":\"theirs\"}"),
            (
                "core-legacy.pid",
                "4243 5d0f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f\n",
            ),
        ];
        // Something answers on run/core.sock (a squatter, or a fixture that takes no lock), with its run files.
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join("run");
        std::fs::create_dir_all(&run).unwrap();
        let _squatter = std::os::unix::net::UnixListener::bind(run.join("core.sock")).unwrap();
        for (name, text) in theirs {
            std::fs::write(run.join(name), text).unwrap();
        }
        let before = snapshot(&run);
        let out = spawn_door(home.path(), &Opts::default())
            .wait_with_output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&out.stderr).contains("address in use"));
        assert_eq!(
            snapshot(&run),
            before,
            "a refused start touches no run file"
        );
        // A start that fails after it wrote (the legacy core exits before it is ready) removes what it wrote, and leaves
        // what it did not write: the stale tokens of an earlier core.
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join("run");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::write(run.join("core.token"), "an earlier core's token").unwrap();
        std::fs::write(run.join("api-delegation.token"), "an earlier api token").unwrap();
        let out = spawn_door(
            home.path(),
            &Opts {
                mode: "exit:1",
                ..Opts::default()
            },
        )
        .wait_with_output()
        .unwrap();
        assert_eq!(
            out.status.code(),
            Some(1),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let left: Vec<String> = snapshot(&run)
            .into_iter()
            .map(|(name, _)| name)
            .filter(|n| !n.ends_with(".lock"))
            .collect();
        assert_eq!(
            left,
            ["api-delegation.token", "core.token"],
            "only what this start wrote is gone"
        );
        assert_eq!(
            std::fs::read_to_string(run.join("core.token")).unwrap(),
            "an earlier core's token"
        );
    }
}

/// Final review FR-M2 (read hardening): `run/core-legacy.pid` is read as a regular file only. A FIFO there (no writer ever
/// opens it) must neither block the start nor be read: the start reaches `ready`, and the record the legacy core writes
/// replaces it.
#[cfg(unix)]
fn a_fifo_at_the_legacy_record_does_not_stop_the_start() {
    let prepare = |home: &Path| {
        std::fs::create_dir_all(home.join("run")).unwrap();
        let made = Command::new("mkfifo")
            .arg(home.join("run/core-legacy.pid"))
            .status()
            .unwrap();
        assert!(made.success(), "mkfifo");
    };
    let d = door(Opts {
        prepare: Some(&prepare),
        ..Opts::default()
    });
    assert_eq!(d.ready["ready"], true);
    let record = std::fs::metadata(d.path("run/core-legacy.pid")).unwrap();
    assert!(
        record.is_file(),
        "the legacy core's own record replaced the FIFO"
    );
}

#[cfg(not(unix))]
fn a_fifo_at_the_legacy_record_does_not_stop_the_start() {}

/// Final review FR-M2: a link at `run/core-legacy.pid` is never followed; the start reaches `ready` and the link's target
/// is unchanged.
#[cfg(unix)]
fn a_link_at_the_legacy_record_is_not_followed() {
    let target = tempfile::tempdir().unwrap();
    let victim = target.path().join("victim");
    let content = format!(
        "{} 5d0f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f\n",
        std::process::id()
    );
    std::fs::write(&victim, &content).unwrap();
    let prepare = |home: &Path| {
        std::fs::create_dir_all(home.join("run")).unwrap();
        std::os::unix::fs::symlink(&victim, home.join("run/core-legacy.pid")).unwrap();
    };
    let d = door(Opts {
        prepare: Some(&prepare),
        ..Opts::default()
    });
    assert_eq!(d.ready["ready"], true);
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), content);
    let record = std::fs::symlink_metadata(d.path("run/core-legacy.pid")).unwrap();
    assert!(record.is_file(), "a regular record replaced the link");
}

#[cfg(not(unix))]
fn a_link_at_the_legacy_record_is_not_followed() {}
