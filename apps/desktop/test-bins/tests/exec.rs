use std::{fs, process::Command};

#[test]
fn fake_plur1bus_records_argv_and_returns_scenario_document() {
    let dir = tempfile::tempdir().unwrap();
    let scenario = dir.path().join("scenario.json");
    let record = dir.path().join("argv.jsonl");
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/daemon-status.json")).unwrap();
    fs::write(&scenario, serde_json::json!({"commands":[{"argv":["daemon","status","--json"],"exit":0,"stdout":fixture}]}).to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_fake-plur1bus"))
        .args(["daemon", "status", "--json"])
        .env("PLUR1BUS_FAKE_SCENARIO", &scenario)
        .env("PLUR1BUS_FAKE_RECORD", &record)
        .output()
        .unwrap();
    assert!(output.status.success());
    let doc: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(doc["schema"], "daemon.status/1");
    assert!(doc["supervisor"].is_object());
    assert!(doc["service"].is_object());
    let calls: Vec<serde_json::Value> = fs::read_to_string(record)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(
        calls,
        vec![serde_json::json!(["daemon", "status", "--json"])]
    );
}

#[test]
fn scenario_cannot_override_fake_plur1bus_argv_allowlist() {
    let dir = tempfile::tempdir().unwrap();
    let scenario = dir.path().join("scenario.json");
    fs::write(&scenario, r#"{"commands":[{"argv":["unknown","--json"],"exit":0,"stdout":{"schema":"unexpected/1"}}]}"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_fake-plur1bus"))
        .args(["unknown", "--json"])
        .env("PLUR1BUS_FAKE_SCENARIO", scenario)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let doc: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(doc["schema"], "error/1");
    assert_eq!(doc["code"], "E_ARGV");
}

#[test]
fn unknown_argv_is_explicit_error() {
    let dir = tempfile::tempdir().unwrap();
    for binary in [
        env!("CARGO_BIN_EXE_fake-plur1bus"),
        env!("CARGO_BIN_EXE_fake-container"),
    ] {
        let output = Command::new(binary)
            .arg("unknown")
            .env("PLUR1BUS_FAKE_RECORD", dir.path().join("argv.jsonl"))
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["schema"],
            "error/1"
        );
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("argv.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pair_and_revoke_share_mock_state_without_recording_token() {
    let dir = tempfile::tempdir().unwrap();
    let server = plur1bus_mock_harness::MockHarness::start(plur1bus_mock_harness::MockOptions {
        state_dir: Some(dir.path().join("state")),
        test_control: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let record = dir.path().join("argv.jsonl");
    let pair = Command::new(env!("CARGO_BIN_EXE_fake-plur1bus"))
        .args([
            "device",
            "pair",
            "--json",
            "--kind",
            "desktop",
            "--name",
            "test desktop",
            "--scope",
            "ui.session,events.read,bridge.serve",
            "--grant",
            "host.keyUnlock",
        ])
        .env("PLUR1BUS_FAKE_ORIGIN", &server.origin)
        .env("PLUR1BUS_FAKE_RECORD", &record)
        .output()
        .unwrap();
    assert!(pair.status.success());
    let code: serde_json::Value = serde_json::from_slice(&pair.stdout).unwrap();
    assert_eq!(code["schema"], "device.pair/1");
    let issued: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/api/v1/devices/redeem", server.origin))
        .json(&serde_json::json!({"code":code["code"],"name":"test desktop","kind":"desktop"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let revoke = Command::new(env!("CARGO_BIN_EXE_fake-plur1bus"))
        .args([
            "device",
            "revoke",
            issued["deviceId"].as_str().unwrap(),
            "--json",
        ])
        .env("PLUR1BUS_FAKE_ORIGIN", &server.origin)
        .env("PLUR1BUS_FAKE_RECORD", &record)
        .output()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&revoke.stdout).unwrap()["ok"],
        true
    );
    let check = reqwest::Client::new()
        .get(format!("{}/api/v1/auth/whoami", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(check.status(), 401);
    assert!(!fs::read_to_string(record)
        .unwrap()
        .contains(issued["token"].as_str().unwrap()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_pair_exec_cannot_gain_bridge_scope_or_key_grant() {
    let scratch = tempfile::tempdir().unwrap();
    let server = plur1bus_mock_harness::MockHarness::start(plur1bus_mock_harness::MockOptions {
        test_control: true,
        state_dir: Some(scratch.path().to_path_buf()),
        ..Default::default()
    })
    .await
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_fake-plur1bus"))
        .args(plur1bus_desktop_contract::exec::native_pair(
            "native desktop",
        ))
        .env("PLUR1BUS_FAKE_ORIGIN", &server.origin)
        .output()
        .unwrap();
    assert!(output.status.success());
    let code: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let issued: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/api/v1/devices/redeem", server.origin))
        .json(&serde_json::json!({"code":code["code"],"name":"native","kind":"desktop"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let who: serde_json::Value = reqwest::Client::new()
        .get(format!("{}/api/v1/auth/whoami", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        who["scopes"],
        serde_json::json!(["ui.session", "events.read"])
    );
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(scratch.path().join("mock-state.json")).unwrap()).unwrap();
    let id = issued["deviceId"].as_str().unwrap();
    assert_eq!(state["devices"][id]["grant_key_unlock"], false);
    assert!(server
        .control
        .call_bridge(
            issued["deviceId"].as_str().unwrap(),
            "get",
            serde_json::json!({})
        )
        .is_err());
}

#[test]
fn fake_container_scenario_controls_exit_status() {
    let dir = tempfile::tempdir().unwrap();
    let scenario = dir.path().join("scenario.json");
    fs::write(&scenario, r#"{"commands":[{"argv":["inspect","p1t-test"],"exit":7,"stdout":{"schema":"error/1","code":"E_TEST"}}]}"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_fake-container"))
        .args(["inspect", "p1t-test"])
        .env("PLUR1BUS_FAKE_SCENARIO", scenario)
        .env("PLUR1BUS_FAKE_RECORD", dir.path().join("argv.jsonl"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["code"],
        "E_TEST"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_pairing_client_spawns_known_binary_fixed_argv_and_never_records_token() {
    let scratch = tempfile::tempdir().unwrap();
    let server = plur1bus_mock_harness::MockHarness::start(plur1bus_mock_harness::MockOptions {
        test_control: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let record = scratch.path().join("calls.jsonl");
    let offer = plur1bus_desktop::pair::pair_local_in_scratch(
        std::path::Path::new(env!("CARGO_BIN_EXE_fake-plur1bus")),
        "Desk",
        vec![
            ("PLUR1BUS_FAKE_ORIGIN".into(), server.origin.clone().into()),
            (
                "PLUR1BUS_FAKE_RECORD".into(),
                record.clone().into_os_string(),
            ),
        ],
    )
    .await
    .unwrap();
    assert_eq!(offer.schema, "device.pair/1");
    let calls = std::fs::read_to_string(record).unwrap();
    let args: serde_json::Value = serde_json::from_str(calls.trim()).unwrap();
    assert_eq!(
        args,
        serde_json::json!(["device", "pair", "--json", "--kind", "desktop", "--name", "Desk"])
    );
    assert!(!calls.contains(&offer.code));
    let tokens = plur1bus_desktop::secrets::MemoryStore::default();
    let store = plur1bus_desktop::connections::Store::open(scratch.path());
    let row = plur1bus_desktop::pair::pair(
        plur1bus_desktop::connections::Origin::parse(&server.origin).unwrap(),
        &offer.code,
        "Desk",
        plur1bus_desktop::connections::Kind::Local,
        Some(&server.installation_id),
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    assert_eq!(row.kind, plur1bus_desktop::connections::Kind::Local);
}
