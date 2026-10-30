//! Actual API/browser MFA approval; native secrets use a memory-only store and never cross the public metadata boundary.
use plur1bus_desktop::{
    client::{HarnessClient, StepUpPurpose, StepUpStatus},
    connections::Store,
    pair,
    secrets::{token_account, MemoryStore, SecretString, TokenStore},
    spa_proxy::SpaProxy,
};
use serde_json::Value;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn actual_mfa_approval_upload_inspection_and_cookie_keep_every_secret_native() {
    let home = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut child = tokio::process::Command::new("node")
        .args(["--experimental-strip-types", "--conditions=source"])
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/current-desktop-api.ts"),
        )
        .arg(home.path())
        .arg(port.to_string())
        .arg("mfa")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap().take(64 * 1024));
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(15), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    let tokens = MemoryStore::default();
    let store = Store::open(home.path());
    let mut row = pair::pair_code(
        ready["origin"].as_str().unwrap(),
        ready["code"].as_str().unwrap(),
        "MFA native fixture",
        &tokens,
        &store,
        None,
    )
    .await
    .unwrap();
    let token = tokens.get(&token_account(row.id)).unwrap().unwrap();
    let client = HarnessClient::from_connection(&row).await.unwrap();
    assert!(client
        .upload_extension(&token, b"PK-fixture".to_vec())
        .await
        .is_err());
    let challenge = client
        .begin_step_up(&token, StepUpPurpose::Extensions)
        .await
        .unwrap();
    assert_eq!(challenge.state, StepUpStatus::Pending);
    assert_eq!(
        challenge.verification_uri,
        format!("{}/#/desktop/approve", row.origin.as_str())
    );
    let public = serde_json::to_string(&challenge).unwrap();
    for forbidden in [token.expose(), "challengeId", "proofToken", "authorization"] {
        assert!(!public.contains(forbidden));
    }
    assert!(client
        .poll_step_up(&SecretString::new("Z".repeat(43)), &challenge.handle)
        .await
        .is_err());
    assert_eq!(
        client
            .poll_step_up(&token, &challenge.handle)
            .await
            .unwrap()
            .state,
        StepUpStatus::Pending
    );
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("approve {}\n", challenge.user_code).as_bytes())
        .await
        .unwrap();
    line.clear();
    output.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "ok");
    let approved = client
        .poll_step_up(&token, &challenge.handle)
        .await
        .unwrap();
    assert_eq!(approved.state, StepUpStatus::Approved);
    assert!(!serde_json::to_string(&approved)
        .unwrap()
        .contains("proofToken"));
    assert_eq!(
        client
            .upload_extension(&token, b"PK-fixture".to_vec())
            .await
            .unwrap(),
        "actual-api-inspection"
    );
    let ticket = pair::session_ticket(&mut row, &tokens, &store)
        .await
        .unwrap();
    let proxy = SpaProxy::new(&row, client.clone()).await.unwrap();
    let target = proxy.start_session(&ticket, &row.device_id).await.unwrap();
    assert!(target.query().is_none());
    assert!(target.fragment().is_none());
    let whoami = reqwest::Client::new()
        .get(format!("{}/api/v1/whoami", proxy.origin().as_str()))
        .header("User-Agent", proxy.user_agent())
        .send()
        .await
        .unwrap();
    assert!(whoami.status().is_success());
    let identity: Value = whoami.json().await.unwrap();
    assert_eq!(identity["via"], "session");
    let stored = std::fs::read_to_string(home.path().join("connections.json")).unwrap();
    assert!(!stored.contains(token.expose()));
    assert!(!stored.contains("proofToken"));
    assert!(!stored.contains("challengeId"));
    let declined = client
        .begin_step_up(&token, StepUpPurpose::Imports)
        .await
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("decline {}\n", declined.user_code).as_bytes())
        .await
        .unwrap();
    line.clear();
    output.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "ok");
    assert_eq!(
        client
            .poll_step_up(&token, &declined.handle)
            .await
            .unwrap()
            .state,
        StepUpStatus::Declined
    );
    let expiring = client
        .begin_step_up(&token, StepUpPurpose::Session)
        .await
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("approve {}\n", expiring.user_code).as_bytes())
        .await
        .unwrap();
    line.clear();
    output.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "ok");
    assert_eq!(
        client
            .poll_step_up(&token, &expiring.handle)
            .await
            .unwrap()
            .state,
        StepUpStatus::Approved
    );
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"expire\n")
        .await
        .unwrap();
    line.clear();
    output.read_line(&mut line).await.unwrap();
    assert!(matches!(
        client.session_ticket(&row.installation_id, &token).await,
        Err(plur1bus_desktop::client::ClientError::SecondFactorRequired)
    ));
    assert!(client.step_up_info(&token, &expiring.handle).is_err());
    proxy.retire();
    child.stdin.take();
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_refused_native_poll_discards_its_private_challenge() {
    let home = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut child = tokio::process::Command::new("node")
        .args(["--experimental-strip-types", "--conditions=source"])
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/current-desktop-api.ts"),
        )
        .arg(home.path())
        .arg(port.to_string())
        .arg("mfa")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap().take(16 * 1024));
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(15), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    let tokens = MemoryStore::default();
    let store = Store::open(home.path());
    let row = pair::pair_code(
        ready["origin"].as_str().unwrap(),
        ready["code"].as_str().unwrap(),
        "Refused poll fixture",
        &tokens,
        &store,
        None,
    )
    .await
    .unwrap();
    let token = tokens.get(&token_account(row.id)).unwrap().unwrap();
    let client = HarnessClient::from_connection(&row).await.unwrap();
    let pending = client
        .begin_step_up(&token, StepUpPurpose::Session)
        .await
        .unwrap();
    assert!(client.step_up_info(&token, &pending.handle).is_ok());
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"revoke\n")
        .await
        .unwrap();
    line.clear();
    output.read_line(&mut line).await.unwrap();
    assert!(client.poll_step_up(&token, &pending.handle).await.is_err());
    assert!(client.step_up_info(&token, &pending.handle).is_err());
    child.stdin.take();
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn default_authentication_budget_keeps_mfa_grants_until_upload_and_confirmation_finish() {
    let home = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut child = tokio::process::Command::new("node")
        .args(["--experimental-strip-types", "--conditions=source"])
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/current-desktop-api.ts"),
        )
        .arg(home.path())
        .arg(port.to_string())
        .arg("mfa-production")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap().take(16 * 1024));
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(15), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    let tokens = MemoryStore::default();
    let store = Store::open(home.path());
    let row = pair::pair_code(
        ready["origin"].as_str().unwrap(),
        ready["code"].as_str().unwrap(),
        "Default auth budget",
        &tokens,
        &store,
        None,
    )
    .await
    .unwrap();
    let token = tokens.get(&token_account(row.id)).unwrap().unwrap();
    let client = HarnessClient::from_connection(&row).await.unwrap();
    let pending = client
        .begin_step_up(&token, StepUpPurpose::Extensions)
        .await
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("approve {}\n", pending.user_code).as_bytes())
        .await
        .unwrap();
    line.clear();
    output.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "ok");
    assert_eq!(
        client
            .poll_step_up(&token, &pending.handle)
            .await
            .unwrap()
            .state,
        StepUpStatus::Approved
    );
    assert_eq!(
        client
            .upload_extension(&token, b"PK-default-auth".to_vec())
            .await
            .unwrap(),
        "actual-api-inspection"
    );
    let ticket = client
        .session_ticket(&row.installation_id, &token)
        .await
        .unwrap();
    let headers = client
        .desktop_cookie(&ticket, &row.device_id)
        .await
        .unwrap();
    assert!(headers.contains_key(reqwest::header::SET_COOKIE));
    assert!(
        client.step_up_info(&token, &pending.handle).is_ok(),
        "rate limiting cannot discard a still-live fixed grant"
    );
    child.stdin.take();
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
}
