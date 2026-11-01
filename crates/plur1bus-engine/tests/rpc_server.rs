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
    assert_eq!(status["ready"], false, "{status}");
    assert!(
        status["degraded"]["reason"]
            .as_str()
            .is_some_and(|reason| matches!(reason, "models-warming" | "composition-pending")),
        "{status}"
    );
}

#[test]
fn auth_with_the_token_file_lists_the_engine_capabilities() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), Some(INSTANCE), false);
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
    let mut engine = EngineProcess::start(home.path(), None, false);
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
    let mut engine = EngineProcess::start(home.path(), None, false);
    let mut raw = RawConnection::connect(engine.address());
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
    let mut engine = EngineProcess::start(home.path(), None, false);
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
    let mut first = EngineProcess::start(home.path(), Some(INSTANCE), false);
    let token = fs::read(home.path().join("run/engine.token")).unwrap();
    let pid = fs::read(home.path().join("run/engine.pid")).unwrap();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(first.address()).unwrap().ino()
    };
    let mut second = EngineProcess::spawn(home.path(), None, false);
    assert_eq!(
        second.wait_for_exit().code(),
        Some(3),
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
    let mut first = EngineProcess::start(home.path(), Some(INSTANCE), false);
    let mut locks: Vec<_> = fs::read_dir(home.path().join("run"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "lock")
        })
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    locks.sort_by(|(left, _), (right, _)| left.cmp(right));
    assert!(
        !locks.is_empty(),
        "a live engine publishes its ownership lock"
    );
    for (path, _) in &locks {
        // Age metadata beyond the nonce protocol's hard ceiling without waiting or changing ownership bytes.
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
            .unwrap();
    }
    let mut second = EngineProcess::spawn(home.path(), None, false);
    assert_eq!(
        second.wait_for_exit().code(),
        Some(3),
        "{}",
        second.diagnostics()
    );
    for (path, bytes) in &locks {
        assert!(
            fs::read(path).is_ok_and(|after| &after == bytes),
            "the second engine changed or removed the live owner's lock: {}",
            path.display()
        );
    }
    let mut client = first.connect();
    assert_eq!(client.hello()["instanceId"], INSTANCE);
    assert_process_status(&client.call("engine.status", json!({})).unwrap());
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(first.wait_for_exit().success());
    first.assert_run_files_removed();
}

#[test]
fn stdin_eof_starts_the_configured_grace_then_exits_cleanly() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None, true);
    engine.close_stdin();
    engine.assert_running_for(Duration::from_millis(150));
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
}

#[test]
fn adoption_replaces_stdin_and_the_adopted_connection_becomes_the_lifeline() {
    let _serial = process_test();
    let home = home();
    let mut engine = EngineProcess::start(home.path(), None, true);
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
    let mut engine = EngineProcess::start(home.path(), None, true);
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
    assert!(embed("passage", "synthetic acceptance passage") <= Duration::from_millis(250));
    // Distinct texts keep the embedding cache from hiding either cold provider call.
    for text in ["synthetic cold query one", "synthetic cold query two"] {
        let elapsed = embed("query", text);
        assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
    }
    let warm = embed("query", "synthetic warm query three");
    assert!(warm <= Duration::from_millis(250), "{warm:?}");
    client.call("engine.shutdown", json!({})).unwrap();
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    engine.assert_run_files_removed();
}
