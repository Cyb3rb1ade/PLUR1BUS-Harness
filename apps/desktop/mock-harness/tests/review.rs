use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use plur1bus_mock_harness::{MockHarness, MockOptions};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[test]
fn standalone_cli_rejects_public_bind_without_stub_mode() {
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_plur1bus-mock-harness"))
        .args(["--bind", "0.0.0.0", "--port", "0"])
        .env_remove("PLUR1BUS_CONTAINER")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut still_running = true;
    for _ in 0..40 {
        if child.try_wait().unwrap().is_some() {
            still_running = false;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if still_running {
        child.kill().unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        !still_running,
        "standalone mock accepted wildcard bind: executable={}, stdout={}, stderr={}",
        env!("CARGO_BIN_EXE_plur1bus-mock-harness"),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("stub container mode"));
}

#[test]
fn stub_mode_rejects_any_public_bind_except_ipv4_wildcard() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_plur1bus-mock-harness"))
        .args(["--bind", "192.0.2.1", "--port", "0"])
        .env("PLUR1BUS_CONTAINER", "1")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("only 0.0.0.0"));
}

#[test]
fn stub_mode_starts_ipv4_wildcard_listener() {
    use std::io::BufRead;
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_plur1bus-mock-harness"))
        .args(["--bind", "0.0.0.0", "--port", "0"])
        .env("PLUR1BUS_CONTAINER", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::BufReader::new(stdout).read_line(&mut line);
        let _ = send.send(line);
    });
    let origin = receive.recv_timeout(std::time::Duration::from_secs(3));
    let _ = child.kill();
    child.wait().unwrap();
    reader.join().unwrap();
    assert!(origin.unwrap().starts_with("http://0.0.0.0:"));
}

async fn paired(server: &plur1bus_mock_harness::MockHandle, scopes: &[&str]) -> Value {
    let code = server.control.create_pair_code_with_scopes(scopes);
    reqwest::Client::new()
        .post(format!("{}/api/v1/devices/redeem", server.origin))
        .json(&json!({"code":code,"name":"test desktop","kind":"desktop"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn test_control_routes_are_disabled_by_default() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    for route in ["/__test/pair", "/__test/revoke", "/__test/failure"] {
        let response = reqwest::Client::new()
            .post(format!("{}{route}", server.origin))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404, "{route}");
    }
}

#[tokio::test]
async fn session_ticket_has_32_random_bytes() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = paired(&server, &["ui.session"]).await;
    let body: Value = reqwest::Client::new()
        .post(format!("{}/api/v1/auth/session-ticket", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode(body["ticket"].as_str().unwrap())
            .unwrap()
            .len(),
        32
    );
}

#[cfg(unix)]
#[tokio::test]
async fn persisted_state_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let server = MockHarness::start(MockOptions {
        state_dir: Some(dir.path().into()),
        ..Default::default()
    })
    .await
    .unwrap();
    server.control.set_provisioned(true);
    let mode = std::fs::metadata(dir.path().join("mock-state.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[tokio::test]
async fn bridge_call_waits_for_client_accepted_hello() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = paired(&server, &["bridge.serve"]).await;
    let mut request = format!("{}/ws", server.origin.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", issued["token"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert!(server
        .control
        .call_bridge(issued["deviceId"].as_str().unwrap(), "get", json!({}))
        .is_err());
    drop(socket);
}

#[tokio::test]
async fn approval_topic_does_not_emit_harness_status() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = paired(&server, &["events.read"]).await;
    let mut response = reqwest::Client::new()
        .get(format!("{}/events?topics=approval", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    let first = tokio::time::timeout(std::time::Duration::from_millis(250), response.chunk()).await;
    assert!(
        first.is_err(),
        "approval-only subscription received a status event"
    );
    server.control.drop_sse();
}

#[tokio::test]
async fn test_control_rejects_unknown_scopes_and_omits_native_bridge_grant() {
    let server = MockHarness::start(MockOptions {
        test_control: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let unknown = client
        .post(format!("{}/__test/pair", server.origin))
        .json(&json!({"scopes":["root.admin"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 400);
    let native: Value = client
        .post(format!("{}/__test/pair", server.origin))
        .json(&json!({"scopes":["ui.session","events.read"],"grant_key_unlock":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let issued: Value = client
        .post(format!("{}/api/v1/devices/redeem", server.origin))
        .json(&json!({"code":native["code"],"name":"native","kind":"desktop"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let who: Value = client
        .get(format!("{}/api/v1/auth/whoami", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(who["scopes"], json!(["ui.session", "events.read"]));
    assert!(server
        .control
        .call_bridge(issued["deviceId"].as_str().unwrap(), "get", json!({}))
        .is_err());
}

#[tokio::test]
async fn approval_decisions_require_scope_and_debug_opt_in() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    server.control.create_approval("a1", "Synthetic request");
    let no_scope = paired(&server, &["events.read"]).await;
    let allowed = paired(&server, &["approvals.decide"]).await;
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/approvals?state=pending", server.origin);
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(no_scope["token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let listed: Value = client
        .get(&url)
        .bearer_auth(allowed["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["approvals"][0]["id"], "a1");
    let decision = client
        .post(format!("{}/api/v1/approvals/a1/decision", server.origin))
        .bearer_auth(allowed["token"].as_str().unwrap())
        .json(&json!({"decision":"approve","scope":"once"}))
        .send()
        .await
        .unwrap();
    assert_eq!(decision.status(), 403);

    let debug = MockHarness::start(MockOptions {
        approvals_decide: true,
        ..Default::default()
    })
    .await
    .unwrap();
    debug.control.create_approval("a2", "Synthetic request");
    let token = paired(&debug, &["approvals.decide"]).await;
    let overbroad = client
        .post(format!("{}/api/v1/approvals/a2/decision", debug.origin))
        .bearer_auth(token["token"].as_str().unwrap())
        .json(&json!({"decision":"approve","scope":"always"}))
        .send()
        .await
        .unwrap();
    assert_eq!(overbroad.status(), 400);
    let decision = client
        .post(format!("{}/api/v1/approvals/a2/decision", debug.origin))
        .bearer_auth(token["token"].as_str().unwrap())
        .json(&json!({"decision":"deny","scope":"once"}))
        .send()
        .await
        .unwrap();
    assert_eq!(decision.status(), 200);
    assert_eq!(decision.json::<Value>().await.unwrap()["state"], "deny");
}

#[tokio::test]
async fn status_reason_and_approval_topics_are_filtered() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = paired(&server, &["events.read"]).await;
    server
        .control
        .set_status_with_reason("degraded", "locked", Some("synthetic failure"));
    server.control.create_approval("a1", "Synthetic request");
    let client = reqwest::Client::new();
    let mut status = client
        .get(format!("{}/events?topics=harness.status", server.origin))
        .header("Last-Event-ID", "1")
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    let chunk = status.chunk().await.unwrap().unwrap();
    let text = std::str::from_utf8(&chunk).unwrap();
    assert!(text.contains("synthetic failure"));
    assert!(!text.contains("approval.requested"));
    let mut approval = client
        .get(format!("{}/events?topics=approval", server.origin))
        .header("Last-Event-ID", "1")
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    let chunk = approval.chunk().await.unwrap().unwrap();
    let text = std::str::from_utf8(&chunk).unwrap();
    assert!(text.contains("approval.requested"));
    assert!(!text.contains("harness.status"));
}

#[tokio::test]
async fn filtered_out_approval_does_not_forge_status_replay() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = paired(&server, &["events.read"]).await;
    server.control.set_status("ready", "locked"); // status id 2
    server.control.create_approval("a1", "Synthetic request"); // approval id 3
    let mut response = reqwest::Client::new()
        .get(format!("{}/events?topics=harness.status", server.origin))
        .header("Last-Event-ID", "2")
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(250), response.chunk())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_discovery_writer_uses_only_scratch_run_api_json() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let path = server
        .control
        .write_discovery_fixture(&scratch, 1234, "synthetic-instance")
        .unwrap();
    assert_eq!(path, scratch.path().join("run/api.json"));
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(doc["url"], server.origin);
    assert_eq!(doc["pid"], 1234);
    assert_eq!(doc["instanceId"], "synthetic-instance");
    assert_eq!(doc["installationId"], server.installation_id);
    assert_eq!(doc["apiVersion"], "1.0.0");
    assert!(!scratch.path().join("run/api.token").exists());
}

#[tokio::test]
async fn meta_override_and_key_unlock_toggle_are_observable() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    server.control.set_meta(Some("p1t-reported-id"), "2.0.0");
    let meta: Value = reqwest::get(format!("{}/api/v1/meta", server.origin))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(meta["installationId"], "p1t-reported-id");
    assert_eq!(meta["apiVersion"], "2.0.0");
    let issued = paired(&server, &["bridge.serve"]).await;
    server.control.set_key_unlock_enabled(false);
    let mut request = format!("{}/ws", server.origin.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", issued["token"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({"type":"bridge.hello","capabilities":["host.keyUnlock"]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let welcome: Value =
        serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(welcome["accepted"], json!([]));
    assert!(server
        .control
        .call_bridge(issued["deviceId"].as_str().unwrap(), "get", json!({}))
        .is_err());
}

#[tokio::test]
async fn drop_sse_control_closes_existing_subscription() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = paired(&server, &["events.read"]).await;
    let mut response = reqwest::Client::new()
        .get(format!("{}/events?topics=harness.status", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert!(response.chunk().await.unwrap().unwrap().starts_with(b"id:"));
    server.control.drop_sse();
    let end = tokio::time::timeout(std::time::Duration::from_secs(2), response.chunk())
        .await
        .unwrap()
        .unwrap();
    assert!(end.is_none());
}
