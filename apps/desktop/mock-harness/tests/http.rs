use futures_util::{SinkExt, StreamExt};
use plur1bus_mock_harness::{MockHarness, MockOptions};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

async fn device(server: &plur1bus_mock_harness::MockHandle, scopes: &[&str]) -> serde_json::Value {
    let code = server.control.create_pair_code_with_scopes(scopes);
    reqwest::Client::new()
        .post(format!("{}/api/v1/devices/redeem", server.origin))
        .json(&serde_json::json!({"code":code,"name":"test desktop","kind":"desktop"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn mock_meta_is_unauthenticated() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let response = reqwest::get(format!("{}/api/v1/meta", server.origin))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["installationId"], server.installation_id);
    assert_eq!(body["apiVersion"], "1.0.0");
    assert_eq!(
        body["capabilities"],
        serde_json::json!(["desktop.sessionTicket", "host.bridge", "test.mock"])
    );
}

#[tokio::test]
async fn redeem_is_single_use() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let code = server.control.create_pair_code();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/devices/redeem", server.origin);
    let first = client
        .post(&url)
        .json(&serde_json::json!({"code":code,"name":"test desktop","kind":"desktop"}))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    assert!(first.json::<serde_json::Value>().await.unwrap()["token"]
        .as_str()
        .is_some());
    let second = client
        .post(&url)
        .json(&serde_json::json!({"code":code,"name":"test desktop","kind":"desktop"}))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 401);
}

#[tokio::test]
async fn redeem_limits_bad_codes_per_minute() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/devices/redeem", server.origin);
    for _ in 0..10 {
        assert_eq!(
            client
                .post(&url)
                .json(
                    &serde_json::json!({"code":"AAAA-BBBB","name":"test desktop","kind":"desktop"})
                )
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }
    let blocked = client
        .post(&url)
        .json(&serde_json::json!({"code":"AAAA-BBBB","name":"test desktop","kind":"desktop"}))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked.status(), 429);
}

#[tokio::test]
async fn ticket_single_use_and_60s() {
    let clock = Arc::new(AtomicI64::new(1_700_000_000));
    let server = MockHarness::start(MockOptions {
        clock: clock.clone(),
        ..MockOptions::default()
    })
    .await
    .unwrap();
    let issued = device(&server, &["ui.session"]).await;
    let client = reqwest::Client::new();
    let issue = || {
        client
            .post(format!("{}/api/v1/auth/session-ticket", server.origin))
            .bearer_auth(issued["token"].as_str().unwrap())
    };
    let ticket = issue()
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["ticket"]
        .as_str()
        .unwrap()
        .to_owned();
    let redeem = || {
        client
            .post(format!("{}/api/v1/auth/ticket/redeem", server.origin))
            .json(&serde_json::json!({"ticket":ticket}))
    };
    let first = redeem().send().await.unwrap();
    assert_eq!(first.status(), 200);
    let cookie = first.headers().get("set-cookie").unwrap().to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));
    assert!(!cookie.contains("Max-Age"));
    assert!(!cookie.contains("Expires"));
    assert_eq!(redeem().send().await.unwrap().status(), 401);
    let expired = issue()
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["ticket"]
        .as_str()
        .unwrap()
        .to_owned();
    clock.store(1_700_000_061, Ordering::SeqCst);
    let late = client
        .post(format!("{}/api/v1/auth/ticket/redeem", server.origin))
        .json(&serde_json::json!({"ticket":expired}))
        .send()
        .await
        .unwrap();
    assert_eq!(late.status(), 401);
    assert_eq!(
        late.json::<serde_json::Value>().await.unwrap()["reason"],
        "ticket-invalid"
    );
}

#[tokio::test]
async fn ticket_expires_at_exact_60_second_boundary() {
    let clock = Arc::new(AtomicI64::new(1_700_000_000));
    let server = MockHarness::start(MockOptions {
        clock: clock.clone(),
        ..MockOptions::default()
    })
    .await
    .unwrap();
    let issued = device(&server, &["ui.session"]).await;
    let ticket: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/api/v1/auth/session-ticket", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    clock.store(1_700_000_060, Ordering::SeqCst);
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1/auth/ticket/redeem", server.origin))
        .json(&serde_json::json!({"ticket":ticket["ticket"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn standalone_default_clock_advances_for_new_tickets() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = device(&server, &["ui.session"]).await;
    tokio::time::sleep(std::time::Duration::from_millis(2_100)).await;
    let body: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/api/v1/auth/session-ticket", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let expires = chrono::DateTime::parse_from_rfc3339(body["expiresAt"].as_str().unwrap())
        .unwrap()
        .timestamp();
    assert!(expires >= chrono::Utc::now().timestamp() + 59);
}

#[tokio::test]
async fn events_requires_events_read() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = device(&server, &["ui.session"]).await;
    let response = reqwest::Client::new()
        .get(format!("{}/events?topics=harness.status", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn events_replay_after_last_event_id() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = device(&server, &["events.read"]).await;
    server.control.set_status("starting", "locked");
    server.control.set_status("ready", "unlocked");
    let mut response = reqwest::Client::new()
        .get(format!("{}/events?topics=harness.status", server.origin))
        .header("Last-Event-ID", "1")
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut text = String::new();
    while !text.contains("id: 3") {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        text.push_str(std::str::from_utf8(&chunk).unwrap());
    }
    assert!(text.contains("id: 2"));
    assert!(text.contains("starting"));
    assert!(text.contains("ready"));
}

#[tokio::test]
async fn events_send_current_state_after_server_restart() {
    let dir = tempfile::tempdir().unwrap();
    let opts = MockOptions {
        state_dir: Some(dir.path().into()),
        ..MockOptions::default()
    };
    let server = MockHarness::start(opts.clone()).await.unwrap();
    let issued = device(&server, &["events.read"]).await;
    server.control.set_status("degraded", "locked");
    drop(server);
    let restarted = MockHarness::start(opts).await.unwrap();
    let mut response = reqwest::Client::new()
        .get(format!("{}/events?topics=harness.status", restarted.origin))
        .header("Last-Event-ID", "99")
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), response.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(std::str::from_utf8(&chunk).unwrap().contains("degraded"));
}

#[tokio::test]
async fn bridge_requires_bridge_serve() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = device(&server, &["ui.session"]).await;
    let mut request = format!("{}/ws", server.origin.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", issued["token"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    let error = tokio_tungstenite::connect_async(request).await.unwrap_err();
    assert!(error.to_string().contains("403"));
}

#[tokio::test]
async fn bridge_welcome_respects_device_grant() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let code = server.control.create_pair_code_with_grant(false);
    let issued: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/api/v1/devices/redeem", server.origin))
        .json(&serde_json::json!({"code":code,"name":"test desktop","kind":"desktop"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
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
        .send(Message::Text(
            serde_json::json!({"type":"bridge.hello","capabilities":["host.keyUnlock"]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let reply = socket.next().await.unwrap().unwrap().into_text().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&reply).unwrap()["accepted"],
        serde_json::json!([])
    );
}

#[tokio::test]
async fn bridge_call_result_roundtrip_uses_only_key_unlock_ops() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = device(&server, &["bridge.serve"]).await;
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
        .send(Message::Text(
            serde_json::json!({"type":"bridge.hello","capabilities":["host.keyUnlock"]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let _welcome = socket.next().await.unwrap().unwrap();
    assert!(server
        .control
        .call_bridge(
            issued["deviceId"].as_str().unwrap(),
            "run",
            serde_json::json!({})
        )
        .is_err());
    let call_id = server
        .control
        .call_bridge(
            issued["deviceId"].as_str().unwrap(),
            "get",
            serde_json::json!({}),
        )
        .unwrap();
    let call = socket.next().await.unwrap().unwrap().into_text().unwrap();
    let call: serde_json::Value = serde_json::from_str(&call).unwrap();
    assert_eq!(call["type"], "bridge.call");
    assert_eq!(call["callId"], call_id);
    assert_eq!(call["capability"], "host.keyUnlock");
    socket.send(Message::Text(serde_json::json!({"type":"bridge.result","callId":call_id,"ok":true,"value":{"provisioned":true}}).to_string().into())).await.unwrap();
    for _ in 0..20 {
        if let Some(result) = server.control.take_bridge_result(&call_id) {
            assert_eq!(result["value"]["provisioned"], true);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("bridge result was not received");
}

#[tokio::test]
async fn frames_over_64k_close() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = device(&server, &["bridge.serve"]).await;
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
    let frame =
        serde_json::json!({"type":"bridge.hello","capabilities":[],"pad":"x".repeat(65_537)})
            .to_string();
    assert!(frame.len() > 65_536);
    socket.send(Message::Text(frame.into())).await.unwrap();
    let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
        .await
        .unwrap();
    match message {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(u16::from(frame.code), 1009),
        Some(Err(tokio_tungstenite::tungstenite::Error::Io(error)))
            if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        // Windows 11 ARM may report the oversized-frame abort as Winsock 10053.
        Some(Err(tokio_tungstenite::tungstenite::Error::Io(error)))
            if cfg!(windows)
                && error.kind() == std::io::ErrorKind::ConnectionAborted
                && error.raw_os_error() == Some(10053) => {}
        Some(Err(tokio_tungstenite::tungstenite::Error::Protocol(
            tokio_tungstenite::tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
        ))) => {}
        other => panic!("oversized frame must be rejected by close 1009, a reset, or Windows abort 10053, got {other:?}"),
    }
}

#[tokio::test]
async fn revoked_device_gets_401_device_revoked() {
    let server = MockHarness::start(MockOptions::default()).await.unwrap();
    let issued = device(&server, &["ui.session"]).await;
    assert!(server
        .control
        .revoke_device(issued["deviceId"].as_str().unwrap()));
    let response = reqwest::Client::new()
        .get(format!("{}/api/v1/auth/whoami", server.origin))
        .bearer_auth(issued["token"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["reason"],
        "device-revoked"
    );
}

#[tokio::test]
async fn persisted_state_contains_hashes_but_no_token() {
    let dir = tempfile::tempdir().unwrap();
    let server = MockHarness::start(MockOptions {
        state_dir: Some(dir.path().into()),
        ..MockOptions::default()
    })
    .await
    .unwrap();
    let issued = device(&server, &["ui.session"]).await;
    server.control.set_provisioned(true);
    let saved = std::fs::read_to_string(dir.path().join("mock-state.json")).unwrap();
    assert!(!saved.contains(issued["token"].as_str().unwrap()));
    let id = server.installation_id.clone();
    drop(server);
    let restarted = MockHarness::start(MockOptions {
        state_dir: Some(dir.path().into()),
        ..MockOptions::default()
    })
    .await
    .unwrap();
    assert_eq!(id, restarted.installation_id);
    assert!(restarted.control.provisioned());
}

#[tokio::test]
async fn upgrade_failure_control_is_visible_to_fake_exec() {
    let server = MockHarness::start(MockOptions {
        test_control: true,
        ..Default::default()
    })
    .await
    .unwrap();
    server.control.inject_upgrade_failure(Some("smoke"));
    let response = reqwest::Client::new()
        .post(format!("{}/__test/failure", server.origin))
        .json(&serde_json::json!({"step":"smoke"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["fail"],
        true
    );
}
