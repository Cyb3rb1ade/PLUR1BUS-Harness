// Tests fail immediately with diagnostics on invalid fixtures, RPC responses or cleanup; these panics are test-only.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod rpc_process_support;

use rpc_process_support::{
    assert_unauthorized, home, process_test, supervisor_token, EngineProcess, RawConnection, GRACE,
};
use serde_json::{json, Value};
use std::fs;
use std::io::ErrorKind;
use std::time::{Duration, Instant, UNIX_EPOCH};

const INSTANCE: &str = "00000000-0000-4000-8000-000000000081";

fn assert_process_status(status: &Value) {
    // The host store base is configured: recall, capture, journal, jobs and the schema marker
    // are composed (RE-D157), so the engine is ready; model warming degrades as at the pin.
    assert_eq!(status["ready"], true, "{status}");
    assert!(
        status["degraded"].is_null() || status["degraded"]["reason"] == "models-warming",
        "{status}"
    );
    assert_eq!(status["jobs"]["ledger"], "ok", "{status}");
    assert_eq!(status["storeSchema"]["expected"], "1", "{status}");
}

#[test]
fn auth_with_the_token_file_lists_the_engine_capabilities() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), Some(INSTANCE));
    let token = engine.token();
    assert_eq!(token.len(), 64, "the token encodes 32 random bytes");
    assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let pid_file = fs::read_to_string(home.path().join("run/engine.pid")).unwrap();
    let fields: Vec<_> = pid_file.split_whitespace().collect();
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0].parse::<u32>().unwrap(), engine.pid());
    assert_eq!(fields[1], INSTANCE);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, PermissionsExt};
        assert_eq!(
            fs::canonicalize(engine.address()).unwrap(),
            fs::canonicalize(home.path().join("run/engine.sock")).unwrap()
        );
        assert!(fs::metadata(engine.address())
            .unwrap()
            .file_type()
            .is_socket());
        for (path, mode) in [
            ("run", 0o700),
            ("run/engine.token", 0o600),
            ("run/engine.pid", 0o600),
            ("run/engine.sock", 0o600),
        ] {
            assert_eq!(
                fs::metadata(home.path().join(path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                mode,
                "{path}"
            );
        }
    }
    #[cfg(windows)]
    assert!(engine.address().starts_with(r"\\.\pipe\"));

    let mut client = engine.connect();
    let hello = client.hello();
    assert_eq!(hello["instanceId"], INSTANCE);
    assert_eq!(hello["pid"], engine.pid());
    assert_eq!(hello["rpc"], plur1bus_rpc::RPC_VERSION);
    assert!(hello["contract"]
        .as_str()
        .is_some_and(|version| !version.is_empty()));
    let expected = plur1bus_rpc::capabilities("engine", &[]);
    assert_eq!(hello["capabilities"]["methods"], expected["methods"]);
    assert_eq!(
        hello["capabilities"]["notifications"],
        expected["notifications"]
    );
    let methods = hello["capabilities"]["methods"].as_object().unwrap();
    assert!(methods.contains_key("engine.status"));
    assert!(methods.contains_key("engine.recall"));
    assert!(methods.contains_key("engine.capture"));
    assert!(methods.keys().all(|method| method.starts_with("engine.")));
    let contract = hello["contract"].clone();
    let status = client.call("engine.status", json!({})).unwrap();
    assert_process_status(&status);
    assert_eq!(status["contract"], contract);
    assert_eq!(
        client.call("engine.shutdown", json!({})).unwrap(),
        json!({})
    );
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
}

#[test]
fn a_wrong_token_is_refused_before_any_method() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None);
    let token_before = engine.token();
    let mut wrong_token = token_before.clone();
    wrong_token.replace_range(
        0..1,
        if token_before.starts_with('0') {
            "1"
        } else {
            "0"
        },
    );
    let destination = home.path().join("unauthorized-snapshot");
    let mut raw = RawConnection::connect(engine.address());
    // Pipeline a privileged write behind failed authentication. Its invalid params must never be validated or used.
    raw.send_batch(&[
        json!({"jsonrpc":"2.0", "id":1, "method":"engine.auth", "params":{"token":wrong_token, "clientId":"wrong-token"}}),
        json!({"jsonrpc":"2.0", "id":2, "method":"engine.snapshot.create", "params":{"out":destination, "unexpected":"private-marker-do-not-echo"}}),
    ]);
    let refusal = raw.response().unwrap().expect("auth refusal");
    assert_eq!(refusal["id"], 1);
    assert_unauthorized(&refusal);
    assert!(!refusal.to_string().contains("private-marker-do-not-echo"));
    match raw.response() {
        Ok(None) => {}
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::ConnectionReset | ErrorKind::BrokenPipe | ErrorKind::UnexpectedEof
            ) => {}
        result => {
            panic!("a failed auth must close before dispatching the next request: {result:?}")
        }
    }
    assert!(!destination.exists());
    assert_eq!(engine.token(), token_before);
    assert!(!engine.diagnostics().contains("private-marker-do-not-echo"));
    assert!(!engine.diagnostics().contains(&token_before));
    let mut client = engine.connect();
    assert_eq!(
        client.call("engine.status", json!({})).unwrap()["agents"],
        0
    );
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(engine.wait_for_exit().success());
}

#[test]
fn unauthenticated_methods_are_refused_before_parameter_validation() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None);
    for (index, method) in [
        "engine.capture",
        "engine.shutdown",
        "engine.adopt",
        "host.secret.get",
        "unknown.private.method",
    ]
    .into_iter()
    .enumerate()
    {
        let mut raw = RawConnection::connect(engine.address());
        let response = raw.call(
            index as u64 + 1,
            method,
            json!(["private-marker-do-not-echo"]),
        );
        assert_unauthorized(&response);
        assert!(!response.to_string().contains("private-marker-do-not-echo"));
        assert!(!response.to_string().contains("invalid params"));
    }
    assert!(!engine.diagnostics().contains("private-marker-do-not-echo"));
    let mut client = engine.connect();
    assert_eq!(
        client.call("engine.status", json!({})).unwrap()["agents"],
        0
    );
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(engine.wait_for_exit().success());
}

#[test]
fn shutdown_closes_cleanly_and_removes_only_its_run_files() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None);
    let token = "a".repeat(64);
    supervisor_token(home.path(), &token);
    fs::write(home.path().join("run/keep.me"), "unrelated-run-file").unwrap();
    let mut client = engine.connect();
    assert_eq!(
        client
            .call("engine.shutdown", json!({"budgetMs":1000}))
            .unwrap(),
        json!({})
    );
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
    assert_eq!(
        fs::read_to_string(home.path().join("run/supervisor.token")).unwrap(),
        token
    );
    assert_eq!(
        fs::read_to_string(home.path().join("run/keep.me")).unwrap(),
        "unrelated-run-file"
    );
}

#[test]
fn a_second_engine_on_the_same_home_exits_3_without_removing_the_firsts_files() {
    let _serial = process_test();
    let home = home();
    let mut first = EngineProcess::start(home.path(), Some(INSTANCE));
    let token = fs::read(home.path().join("run/engine.token")).unwrap();
    let pid = fs::read(home.path().join("run/engine.pid")).unwrap();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(first.address()).unwrap().ino()
    };
    let mut second = EngineProcess::spawn(home.path(), None);
    assert_eq!(
        second.wait_for_exit().code(),
        Some(3),
        "{}",
        second.diagnostics()
    );
    let refusals: Vec<Value> = second
        .stderr()
        .lines()
        .map(|line| {
            plur1bus_log_schema::validate_line(line).unwrap();
            serde_json::from_str(line).unwrap()
        })
        .collect();
    assert!(
        refusals
            .iter()
            .any(|record| record["event"] == "engine.process.lifecycle"
                && record["attrs"]["reason"] == "process-lock-held"),
        "{}",
        second.diagnostics()
    );
    assert_eq!(
        fs::read(home.path().join("run/engine.token")).unwrap(),
        token
    );
    assert_eq!(fs::read(home.path().join("run/engine.pid")).unwrap(), pid);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(first.address()).unwrap().ino(), inode);
    }
    let mut client = first.connect();
    assert_eq!(client.hello()["instanceId"], INSTANCE);
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(first.wait_for_exit().success());
    first.assert_run_files_removed();
}

#[test]
fn a_live_engine_lock_is_not_stolen_after_the_nonce_hard_ceiling() {
    let _serial = process_test();
    let home = home();
    let mut first = EngineProcess::start(home.path(), Some(INSTANCE));
    let run = home.path().join("run");
    let nonce = run.join("engine.lock");
    let process_lock = run.join("engine.process.lock");
    let nonce_bytes = fs::read(&nonce).unwrap();
    let assert_process_lock_held = || {
        let contender = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&process_lock)
            .unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(fs::TryLockError::WouldBlock)
        ));
    };
    assert_process_lock_held();
    for path in [&nonce, &process_lock] {
        // Age metadata beyond the nonce protocol's hard ceiling without waiting or changing ownership bytes.
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
            .unwrap();
    }
    let mut second = EngineProcess::spawn(home.path(), None);
    assert_eq!(
        second.wait_for_exit().code(),
        Some(3),
        "{}",
        second.diagnostics()
    );
    assert_process_lock_held();
    assert_eq!(
        fs::read(&nonce).unwrap(),
        nonce_bytes,
        "the live owner's nonce changed"
    );
    let mut client = first.connect();
    assert_eq!(client.hello()["instanceId"], INSTANCE);
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(first.wait_for_exit().success());
    first.assert_run_files_removed();
}

#[cfg(unix)]
#[test]
fn startup_refusals_distinguish_a_live_owner_from_the_stamp_age_rule() {
    let _serial = process_test();
    let mut live = nonce_for_pid(std::process::id());
    live["privateMarker"] = json!("PRIVATE-STAMP-CONTENT");
    for (stamp, aged, reason) in [
        (serde_json::to_vec(&live).unwrap(), true, "stamp-owner-live"),
        (b"{PRIVATE-STAMP-CONTENT".to_vec(), false, "stamp-age-rule"),
    ] {
        let home = home();
        let run = home.path().join("run");
        plur1bus_engine::store::paths::secure_dir(&run).unwrap();
        let path = run.join("engine.lock");
        fs::write(&path, &stamp).unwrap();
        plur1bus_engine::store::paths::secure_file(&path).unwrap();
        if aged {
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH))
                .unwrap();
        }
        let mut engine = EngineProcess::spawn(home.path(), None);
        assert_eq!(
            engine.wait_for_exit().code(),
            Some(3),
            "{}",
            engine.diagnostics()
        );
        assert_eq!(fs::read(&path).unwrap(), stamp);
        assert!(!engine.stderr().contains("PRIVATE-STAMP-CONTENT"));
        let records: Vec<Value> = engine
            .stderr()
            .lines()
            .map(|line| {
                plur1bus_log_schema::validate_line(line).unwrap();
                serde_json::from_str(line).unwrap()
            })
            .collect();
        assert!(
            records
                .iter()
                .any(|record| record["event"] == "engine.process.lifecycle"
                    && record["attrs"]["state"] == "stopped"
                    && record["attrs"]["reason"] == reason),
            "{}",
            engine.diagnostics()
        );
    }
}

#[cfg(unix)]
#[test]
fn startup_refuses_a_live_endpoint_with_a_content_free_reason() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    let _serial = process_test();
    let home = home();
    let run = home.path().join("run");
    plur1bus_engine::store::paths::secure_dir(&run).unwrap();
    let endpoint = run.join("engine.sock");
    let _listener = UnixListener::bind(&endpoint).unwrap();
    fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600)).unwrap();
    let mut engine = EngineProcess::spawn(home.path(), None);
    assert_eq!(
        engine.wait_for_exit().code(),
        Some(3),
        "{}",
        engine.diagnostics()
    );
    let stderr = engine.stderr();
    assert!(!stderr.contains(&home.path().to_string_lossy().to_string()));
    let records: Vec<Value> = stderr
        .lines()
        .map(|line| {
            plur1bus_log_schema::validate_line(line).unwrap();
            serde_json::from_str(line).unwrap()
        })
        .collect();
    assert!(
        records
            .iter()
            .any(|record| record["event"] == "engine.process.lifecycle"
                && record["attrs"]["state"] == "stopped"
                && record["attrs"]["reason"] == "endpoint-live"),
        "{stderr}"
    );
    assert!(
        UnixStream::connect(&endpoint).is_ok(),
        "the foreign endpoint must remain live"
    );
    assert!(!run.join("engine.pid").exists());
    assert!(!run.join("engine.token").exists());
}

#[cfg(unix)]
fn nonce_for_pid(pid: u32) -> Value {
    json!({
        "nonce":uuid::Uuid::new_v4().to_string(),
        "pid":pid,
        "host":plur1bus_rpc::process::hostname().unwrap(),
        "procStart":plur1bus_rpc::process::incarnation().unwrap(),
        "acquiredAt":"2020-01-01T00:00:00Z"
    })
}

#[cfg(unix)]
fn assert_aged_stamp_recovers_and_stops_on_sigterm(stamp: &[u8]) {
    let _serial = process_test();
    let home = home();
    let run = home.path().join("run");
    plur1bus_engine::store::paths::secure_dir(&run).unwrap();
    let path = run.join("engine.lock");
    fs::write(&path, stamp).unwrap();
    plur1bus_engine::store::paths::secure_file(&path).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
        .unwrap();
    let mut engine = EngineProcess::start(home.path(), Some(INSTANCE));
    assert_ne!(fs::read(&path).unwrap(), stamp);
    let mut client = engine.connect();
    assert_eq!(client.hello()["instanceId"], INSTANCE);
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    // SAFETY: this positive PID names only the child held and reaped by EngineProcess.
    assert_eq!(
        unsafe { libc::kill(engine.pid().try_into().unwrap(), libc::SIGTERM) },
        0
    );
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
    assert!(!engine.diagnostics().contains("PRIVATE-STAMP-CONTENT"));
}

#[cfg(unix)]
#[test]
fn aged_foreign_host_stamp_recovers_and_stops_cleanly() {
    let mut stamp = nonce_for_pid(std::process::id());
    stamp["host"] = json!(format!(
        "{}-previous-container",
        stamp["host"].as_str().unwrap()
    ));
    assert_aged_stamp_recovers_and_stops_on_sigterm(&serde_json::to_vec(&stamp).unwrap());
}

#[cfg(unix)]
#[test]
fn aged_empty_stamp_recovers_and_stops_cleanly() {
    assert_aged_stamp_recovers_and_stops_on_sigterm(b"");
}

#[cfg(unix)]
#[test]
fn aged_broken_json_stamp_recovers_and_stops_cleanly() {
    assert_aged_stamp_recovers_and_stops_on_sigterm(br#"{"PRIVATE-STAMP-CONTENT":"#);
}

#[cfg(unix)]
#[test]
fn aged_invalid_utf8_stamp_recovers_and_stops_cleanly() {
    assert_aged_stamp_recovers_and_stops_on_sigterm(&[b'{', b'"', 0xff, b'"', b':']);
}

#[cfg(unix)]
#[test]
fn aged_stamp_for_another_users_pid_recovers_and_stops_cleanly() {
    use plur1bus_rpc::process::{alive, Liveness};

    // Root can probe every UID, so the ruling scopes this process case to non-root runners.
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let pid = (alive(1) == Liveness::OtherUser).then_some(1);
    #[cfg(target_os = "linux")]
    let pid = pid.or_else(|| {
        fs::read_dir("/proc")
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .find(|candidate| alive(*candidate) == Liveness::OtherUser)
    });
    let pid = pid.expect("a non-root process test needs a live foreign UID (normally PID1)");
    assert_eq!(alive(pid), Liveness::OtherUser);
    // Current boot prevents the earlier boot-mismatch branch from masking this EPERM case.
    let stamp = nonce_for_pid(pid);
    assert_aged_stamp_recovers_and_stops_on_sigterm(&serde_json::to_vec(&stamp).unwrap());
}

#[test]
fn a_crashed_engine_is_restarted_immediately_on_the_same_home() {
    let _serial = process_test();
    let home = home();
    let mut first = EngineProcess::start(home.path(), Some(INSTANCE));
    let previous_pid = first.pid();
    let previous_nonce = fs::read(home.path().join("run/engine.lock")).unwrap();
    assert!(!first.kill_and_wait().success());
    assert!(home.path().join("run/engine.token").exists());
    assert!(home.path().join("run/engine.lock").exists());

    // Leave the fresh nonce untouched: restart must use the dead owner's identity, rather than its age.
    let restarted_instance = "00000000-0000-4000-8000-000000000082";
    let mut restarted = EngineProcess::start(home.path(), Some(restarted_instance));
    assert_ne!(restarted.pid(), previous_pid);
    assert_ne!(
        fs::read(home.path().join("run/engine.lock")).unwrap(),
        previous_nonce
    );
    let mut client = restarted.connect();
    assert_eq!(client.hello()["instanceId"], restarted_instance);
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(restarted.wait_for_exit().success());
    restarted.assert_run_files_removed();
}

#[cfg(unix)]
#[test]
fn a_crashed_engine_restarts_immediately_with_child_umask_022_and_private_nonces() {
    use std::os::unix::fs::PermissionsExt;

    let _serial = process_test();
    let home = home();
    let mut first = EngineProcess::start_with_umask_022(home.path(), Some(INSTANCE));
    let path = home.path().join("run/engine.lock");
    let first_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert!(!first.kill_and_wait().success());
    assert!(path.exists());

    // Exercise recovery before checking the recorded mode, so the old 0644
    // creation bug fails at the real immediate restart rather than a fixture assertion.
    let restarted_instance = "00000000-0000-4000-8000-000000000083";
    let mut restarted = EngineProcess::start_with_umask_022(home.path(), Some(restarted_instance));
    assert_eq!(first_mode, 0o600);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let mut client = restarted.connect();
    assert_eq!(client.hello()["instanceId"], restarted_instance);
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(restarted.wait_for_exit().success());
    restarted.assert_run_files_removed();
}

#[cfg(unix)]
#[test]
fn a_crashed_engine_with_a_legacy_0644_nonce_restarts_immediately() {
    use std::os::unix::fs::PermissionsExt;

    let _serial = process_test();
    let home = home();
    let mut first = EngineProcess::start_with_umask_022(home.path(), Some(INSTANCE));
    let path = home.path().join("run/engine.lock");
    let original = fs::read(&path).unwrap();
    // This is the known child we started, reproducing metadata written by the previous release.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!first.kill_and_wait().success());
    let restarted_instance = "00000000-0000-4000-8000-000000000084";
    let mut restarted = EngineProcess::start_with_umask_022(home.path(), Some(restarted_instance));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_ne!(fs::read(&path).unwrap(), original);
    let mut client = restarted.connect();
    assert_eq!(client.hello()["instanceId"], restarted_instance);
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(restarted.wait_for_exit().success());
    restarted.assert_run_files_removed();
}

#[cfg(unix)]
fn signal_closes_the_engine_and_removes_its_run_files(signal: libc::c_int) {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None);
    let mut client = engine.connect();
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    let token = engine.token();
    let private_marker = "private-memory-signal-canary";
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/rpc-schema/fixtures/methods/engine.recall.json"
    ))
    .unwrap();
    let mut params = fixture["params"].clone();
    params["query"]["query"] = json!(private_marker);
    // Recall is served (RE-D150); the call only carries a private marker into the process.
    assert!(client.call("engine.recall", params.clone()).is_ok());
    // SAFETY: this positive PID names the live child held and reaped by EngineProcess.
    assert_eq!(
        unsafe { libc::kill(engine.pid().try_into().unwrap(), signal) },
        0
    );
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
    // Nothing is served after the signal: the open connection answers no further call.
    assert!(client.call("engine.recall", params).is_err());
    let stderr = engine.stderr();
    let records: Vec<Value> = stderr
        .lines()
        .map(|line| {
            assert!(
                plur1bus_log_schema::validate_line(line).is_ok(),
                "unregistered process diagnostic: {line}"
            );
            serde_json::from_str(line).unwrap()
        })
        .collect();
    for (state, reason) in [
        ("started", "ready"),
        ("stopping", "signal"),
        ("stopped", "signal"),
    ] {
        assert!(
            records.iter().any(|record| {
                record["event"] == "engine.process.lifecycle"
                    && record["source"]["id"] == "engine"
                    && record["attrs"]["pid"] == engine.pid()
                    && record["attrs"]["state"] == state
                    && record["attrs"]["reason"] == reason
            }),
            "missing lifecycle {state}/{reason}: {stderr}"
        );
    }
    assert!(!stderr.contains(private_marker));
    assert!(!stderr.contains(&token));
}

#[cfg(unix)]
#[test]
fn sigterm_closes_the_engine_and_removes_its_run_files() {
    signal_closes_the_engine_and_removes_its_run_files(libc::SIGTERM);
}

#[cfg(unix)]
#[test]
fn sigint_closes_the_engine_and_removes_its_run_files() {
    signal_closes_the_engine_and_removes_its_run_files(libc::SIGINT);
}

#[test]
fn a_hand_started_engine_has_no_implicit_stdin_lifeline() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start_without_lifeline(home.path());
    engine.close_stdin();
    engine.assert_running_for(GRACE + Duration::from_millis(350));
    let mut client = engine.connect();
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(engine.wait_for_exit().success());
    engine.assert_run_files_removed();
}

#[test]
fn stdin_eof_starts_the_configured_grace_then_exits_cleanly() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None);
    engine.close_stdin();
    engine.assert_running_for(Duration::from_millis(150));
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
}

#[test]
fn adoption_replaces_stdin_and_the_adopted_connection_becomes_the_lifeline() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None);
    let nonce = "b".repeat(64);
    supervisor_token(home.path(), &nonce);
    let mut supervisor = engine.connect();
    let adoption = supervisor
        .call("engine.adopt", json!({"nonce":nonce}))
        .unwrap();
    assert_process_status(&adoption["status"]);
    // An EOF from the supervisor that started us must not orphan the newly adopted engine.
    engine.close_stdin();
    engine.assert_running_for(GRACE + Duration::from_millis(350));
    assert_process_status(&supervisor.call("engine.status", json!({})).unwrap());
    drop(supervisor);
    engine.assert_running_for(Duration::from_millis(150));
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
}

#[test]
fn a_restarted_supervisor_can_adopt_during_the_stdin_eof_grace() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None);
    engine.close_stdin();
    engine.assert_running_for(Duration::from_millis(100));
    let nonce = "c".repeat(64);
    supervisor_token(home.path(), &nonce);
    let mut supervisor = engine.connect();
    assert_process_status(
        &supervisor
            .call("engine.adopt", json!({"nonce":nonce}))
            .unwrap()["status"],
    );
    engine.assert_running_for(GRACE + Duration::from_millis(350));
    assert_process_status(&supervisor.call("engine.status", json!({})).unwrap());
    drop(supervisor);
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
}

#[test]
fn the_binary_refuses_a_cli_seam_without_the_explicit_allow_flag() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::spawn_with_seam(home.path(), "flat-embedder", false);
    assert_eq!(engine.wait_for_exit().code(), Some(2));
    assert!(
        engine
            .diagnostics()
            .contains("PLUR1BUS_ALLOW_TEST_INTERNALS=1"),
        "{}",
        engine.diagnostics()
    );
    engine.assert_run_files_removed();
    assert!(!home.path().join("run").exists());
}

#[test]
fn the_allowed_cold_cli_seam_delays_only_the_first_two_query_calls_over_rpc() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start_with_seam(home.path(), "flat-embedder-cold");
    let mut client = engine.connect();
    let identities = client
        .call("engine.embedding.identities", json!({}))
        .unwrap();
    let identity = identities.as_array().unwrap().first().unwrap();
    let dimensions = usize::try_from(identity["dimensions"].as_u64().unwrap()).unwrap();
    assert!(dimensions > 0);
    let mut embed = |kind: &str, text: &str| {
        let started = Instant::now();
        let result = client
            .call(
                "engine.embedding.embed",
                json!({"texts":[text],"kind":kind,"identity":identity}),
            )
            .unwrap();
        let elapsed = started.elapsed();
        let vectors = result.as_array().unwrap();
        assert_eq!(vectors.len(), 1);
        let vector = vectors[0].as_array().unwrap();
        assert_eq!(vector.len(), dimensions);
        assert_eq!(vector[0].as_f64(), Some(1.0));
        assert!(vector[1..].iter().all(|value| value.as_f64() == Some(0.0)));
        elapsed
    };
    let passage = embed("passage", "synthetic acceptance passage");
    // Distinct texts keep the embedding cache from hiding either cold provider call.
    let mut cold = Duration::ZERO;
    for text in ["synthetic cold query one", "synthetic cold query two"] {
        let elapsed = embed("query", text);
        assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
        cold += elapsed;
    }
    let warm = embed("query", "synthetic warm query three");
    assert!(
        cold.saturating_sub(passage + warm) >= Duration::from_millis(400),
        "cold queries {cold:?}, passage {passage:?}, warm query {warm:?}"
    );
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
}

/// Pin `engine/create-engine.js` (`baseDbPathIsFreshStore`): a missing or empty `baseDbPath` starts at schema 1 at
/// engine creation, so `admin.migrate {0 -> 1}` answers `conflict` and `{1 -> 1}` is `applied: false`. Rust answers
/// the same without writing anything to the store base (a store is initialised when it is first created).
#[test]
fn migration_on_a_fresh_store_base_conflicts_like_the_pin_and_writes_nothing() {
    fn listing(dir: &std::path::Path) -> Vec<String> {
        fn walk(dir: &std::path::Path, prefix: &str, out: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let entry = entry.unwrap();
                let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
                out.push(name.clone());
                if entry.path().is_dir() {
                    walk(&entry.path(), &name, out);
                }
            }
        }
        let mut out = vec![];
        walk(dir, "", &mut out);
        out.sort();
        out
    }
    for empty_dir in [false, true] {
        let _serial = process_test();
        let home = home();
        let base = home.path().join("state/lancedb");
        if empty_dir {
            fs::create_dir_all(&base).unwrap();
        }
        let mut engine = EngineProcess::start_with_seam(home.path(), "flat-embedder");
        let mut peer = RawConnection::connect(engine.address());
        peer.call(
            1,
            "engine.auth",
            json!({"token":engine.token(),"clientId":"core-fixture"}),
        );
        let pid_file = home.path().join("run/core.pid");
        fs::write(&pid_file, format!("{} {INSTANCE}\n", std::process::id())).unwrap();
        plur1bus_engine::store::paths::secure_file(&pid_file).unwrap();
        let before = listing(&base);
        let migrate = |peer: &mut RawConnection, id, from: &str, to: &str| {
            peer.call(id, "engine.admin.migrate", json!({"from":from,"to":to}))
        };
        let conflict = migrate(&mut peer, 2, "0", "1");
        assert_eq!(
            conflict["error"]["data"]["reason"], "conflict",
            "{conflict}"
        );
        let same = migrate(&mut peer, 3, "1", "1");
        assert_eq!(
            same["result"],
            json!({"from":"1","to":"1","applied":false}),
            "{same}"
        );
        assert_eq!(listing(&base), before, "empty_dir: {empty_dir}");
        assert_eq!(base.exists(), empty_dir, "empty_dir: {empty_dir}");
        drop(peer);
        engine.close_stdin();
        assert!(engine.wait_for_exit().success());
    }
}

#[test]
fn schema_migration_requires_the_live_core_peer_and_audits_the_actual_change() {
    let _serial = process_test();
    let home = home();
    let base = home.path().join("state/lancedb");
    let marker = base.join("_schema.json");
    fs::create_dir_all(&base).unwrap();
    fs::write(&marker, b"{\"schemaVersion\":\"0\"}").unwrap();
    let mut engine = EngineProcess::start_with_seam(home.path(), "flat-embedder");
    let mut peer = RawConnection::connect(engine.address());
    let hello = peer.call(
        1,
        "engine.auth",
        json!({"token":engine.token(),"clientId":"core-fixture"}),
    );
    assert_eq!(hello["result"]["pid"], engine.pid());

    let migrate = |peer: &mut RawConnection, id, from: &str, to: &str| {
        peer.call(id, "engine.admin.migrate", json!({"from":from,"to":to}))
    };
    let audit_path = home.path().join("state/engine-maintenance.jsonl");
    let no_core = migrate(&mut peer, 2, "0", "1");
    assert_unauthorized(&no_core);
    assert_eq!(no_core["error"]["data"]["reason"], "core-link-required");

    let pid_file = home.path().join("run/core.pid");
    let publish = |pid| {
        fs::write(&pid_file, format!("{pid} {INSTANCE}\n")).unwrap();
        plur1bus_engine::store::paths::secure_file(&pid_file).unwrap();
    };
    publish(engine.pid());
    let wrong_peer = migrate(&mut peer, 3, "0", "1");
    assert_unauthorized(&wrong_peer);
    assert!(!audit_path.exists());
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        "{\"schemaVersion\":\"0\"}"
    );

    // The Core can establish the EngineClient before publishing its own run files.
    // The first authorized maintenance call uses the same authenticated socket.
    publish(std::process::id());
    let result = migrate(&mut peer, 4, "0", "1");
    assert_eq!(
        result["result"],
        json!({"from":"0","to":"1","applied":true}),
        "{result}"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&marker).unwrap()).unwrap()["schemaVersion"],
        "1"
    );
    let conflict = migrate(&mut peer, 5, "0", "1");
    assert_eq!(conflict["error"]["data"]["reason"], "conflict");
    let empty_status = peer.call(6, "engine.admin.reembedding.status", json!({}));
    assert_eq!(
        empty_status["error"]["data"]["reason"],
        "operation-unavailable"
    );
    let targeted_status = peer.call(
        7,
        "engine.admin.reembedding.status",
        json!({"id":"fixture"}),
    );
    // Re-embedding is served over the same grant (RE-D166): an unknown migration has no record.
    assert_eq!(targeted_status["result"], Value::Null, "{targeted_status}");
    fs::remove_file(&pid_file).unwrap();
    assert_unauthorized(&migrate(&mut peer, 8, "1", "1"));
    let entries: Vec<Value> = fs::read_to_string(&audit_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 3);
    // The targeted status is audited like every served maintenance call; the empty one was
    // refused at the wire before reaching the grant.
    assert_eq!(entries[2]["method"], "engine.admin.reembedding.status");
    assert_eq!(entries[2]["target"], json!({"id":"fixture"}));
    assert_eq!(entries[2]["actor"], "core-maintenance");
    for entry in entries.into_iter().take(2) {
        assert_eq!(entry["method"], "engine.admin.migrate");
        assert_eq!(entry["actor"], "core-maintenance");
        assert!(entry["coreLink"].as_str().unwrap().starts_with(INSTANCE));
        assert_eq!(entry["target"], json!({"from":"0","to":"1"}));
        assert!(entry.get("token").is_none());
        assert!(entry.get("principal").is_none());
    }
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

/// An authenticated Core peer with a live core pid file (the maintenance grant of the pin).
fn core_peer(engine: &EngineProcess, home: &std::path::Path) -> RawConnection {
    let mut peer = RawConnection::connect(engine.address());
    let hello = peer.call(
        1,
        "engine.auth",
        json!({"token":engine.token(),"clientId":"core-fixture"}),
    );
    assert!(hello["result"].is_object(), "{hello}");
    let pid_file = home.join("run/core.pid");
    fs::write(&pid_file, format!("{} {INSTANCE}\n", std::process::id())).unwrap();
    plur1bus_engine::store::paths::secure_file(&pid_file).unwrap();
    peer
}

fn status_schema(peer: &mut RawConnection, id: u64) -> Value {
    let status = peer.call(id, "engine.status", json!({}));
    status["result"]["storeSchema"].clone()
}

/// RE-D175 (fix2): the pin reports `storeMigrator.current()` (`status-reporter.js:159`), the marker written at
/// engine creation for a fresh base, so status and `admin.migrate` never disagree. A base with content but no
/// marker is a legacy store: schema 0 in both, and the migration applies.
#[test]
fn status_and_migrate_read_a_fresh_store_base_alike() {
    for empty_dir in [false, true] {
        let _serial = process_test();
        let home = home();
        let base = home.path().join("state/lancedb");
        if empty_dir {
            fs::create_dir_all(&base).unwrap();
        }
        let mut engine = EngineProcess::start_with_seam(home.path(), "flat-embedder");
        let mut peer = core_peer(&engine, home.path());
        assert_eq!(
            status_schema(&mut peer, 2),
            json!({"current":"1","expected":"1"}),
            "empty_dir: {empty_dir}"
        );
        let conflict = peer.call(3, "engine.admin.migrate", json!({"from":"0","to":"1"}));
        assert_eq!(
            conflict["error"]["data"]["reason"], "conflict",
            "{conflict}"
        );
        assert_eq!(base.exists(), empty_dir, "status wrote nothing");
        drop(peer);
        engine.close_stdin();
        assert!(engine.wait_for_exit().success());
    }
}

#[test]
fn status_and_migrate_read_a_legacy_store_base_without_a_marker_as_schema_zero() {
    let _serial = process_test();
    let home = home();
    let base = home.path().join("state/lancedb");
    fs::create_dir_all(base.join("a1")).unwrap();
    let mut engine = EngineProcess::start_with_seam(home.path(), "flat-embedder");
    let mut peer = core_peer(&engine, home.path());
    assert_eq!(
        status_schema(&mut peer, 2),
        json!({"current":"0","expected":"1"})
    );
    let applied = peer.call(3, "engine.admin.migrate", json!({"from":"0","to":"1"}));
    assert_eq!(
        applied["result"],
        json!({"from":"0","to":"1","applied":true}),
        "{applied}"
    );
    assert_eq!(
        status_schema(&mut peer, 4),
        json!({"current":"1","expected":"1"})
    );
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

/// RE-D175 (fix2, finding 2): a real job run on a home without any store creates `_jobs` inside the base. The
/// pin writes the marker at engine start, before any such access, so a new installation always carries it.
#[test]
fn a_job_run_before_the_first_store_leaves_the_base_at_the_current_schema() {
    let _serial = process_test();
    let home = home();
    let base = home.path().join("state/lancedb");
    // The native embedding drain is installed only while the neo engine is off (F13).
    let config_path = home.path().join("config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["engine"]["neo"] = json!({"enabled": false});
    fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let mut engine = EngineProcess::start_with_seam(home.path(), "flat-embedder");
    let mut peer = core_peer(&engine, home.path());
    let run = peer.call(
        2,
        "engine.jobs.run",
        json!({"job":"embedding-drain","agentId":"a1","trigger":"manual","dryRun":false}),
    );
    assert!(run["result"].is_object(), "{run}");
    assert!(
        base.join("_jobs").is_dir(),
        "the run created its ledger root"
    );
    assert!(base.join("_schema.json").is_file(), "{run}");
    assert_eq!(
        status_schema(&mut peer, 3),
        json!({"current":"1","expected":"1"}),
        "{run}"
    );
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}
