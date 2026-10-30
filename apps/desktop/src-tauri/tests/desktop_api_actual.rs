//! Actual TypeScript API/Core attach integration with memory-only native credentials and disposable HTTP state.
use plur1bus_desktop::{
    client::HarnessClient,
    connections::Store,
    pair,
    secrets::{token_account, MemoryStore, TokenStore},
    spa_proxy::SpaProxy,
};
use serde_json::Value;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[path = "support/controller.rs"]
mod support_controller;

#[tokio::test]
async fn bundled_auto_pairing_uses_the_current_cli_contract_and_does_not_inherit_privileged_grants()
{
    use plur1bus_desktop::{
        controller::{Controller, Resources},
        runtime::{ExecOutput, RuntimeKind},
    };
    use std::sync::Arc;
    use support_controller::{FakeRuntime, Healthy};
    let home = tempfile::tempdir().unwrap();
    let runtime = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    let controller = Controller::with_health(
        runtime.clone(),
        plur1bus_desktop::controller::bundle::embedded().clone(),
        home.path().join("bundle"),
        Arc::new(Healthy),
    )
    .with_test_namespace("actual-pair")
    .unwrap();
    let installed = controller
        .install(Resources::default(), |_| {})
        .await
        .unwrap();
    let mut child = tokio::process::Command::new("node")
        .args(["--experimental-strip-types", "--conditions=source"])
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/current-desktop-api.ts"),
        )
        .arg(home.path())
        .arg(installed.port.to_string())
        .arg("default")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap().take(16 * 1024));
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(15), lines.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    let grant = serde_json::to_vec(&ready["grant"]).unwrap();
    *runtime.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| {
        let stdout = match &argv[1..] {
            ["user", "create", "--owner", "--json"] => {
                br#"{"schema":"user.create/1","userId":"desktop-fixture-owner"}"#.to_vec()
            }
            ["device", "pair", "--json", "--kind", "desktop"] => grant.clone(),
            _ => panic!("unsupported current CLI arguments"),
        };
        ExecOutput {
            code: 0,
            stdout,
            stderr: vec![],
        }
    }));
    let tokens = MemoryStore::default();
    let store = Store::open(&home.path().join("connections"));
    let mut row = pair::pair_bundled(&controller, &tokens, &store, "Current bundled", |_| {})
        .await
        .unwrap();
    pair::session_ticket(&mut row, &tokens, &store)
        .await
        .unwrap();
    let token = tokens.get(&token_account(row.id)).unwrap().unwrap();
    let client = HarnessClient::from_connection(&row).await.unwrap();
    assert!(client
        .upload_extension(&token, b"no-implicit-privileged-grant".to_vec())
        .await
        .is_err());
    child.stdin.take();
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn actual_api_grants_person_bound_uploads_and_keeps_the_confirmation_session_native() {
    let home = tempfile::tempdir().unwrap();
    let entry =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/current-desktop-api.ts");
    let mut child = tokio::process::Command::new("node")
        .args(["--experimental-strip-types", "--conditions=source"])
        .arg(entry)
        .arg(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("Node 24.21.0 from docs/desktop.md is required");
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout.take(16 * 1024));
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(15), lines.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&line).expect("actual API private readiness line");
    let origin = ready["origin"].as_str().unwrap();
    let code = ready["code"].as_str().unwrap();
    let tokens = MemoryStore::default();
    let connections = Store::open(home.path());
    let mut row = pair::pair_code(
        origin,
        code,
        "Actual API fixture",
        &tokens,
        &connections,
        None,
    )
    .await
    .unwrap();
    let token = tokens.get(&token_account(row.id)).unwrap().unwrap();
    let client = HarnessClient::from_connection(&row).await.unwrap();
    assert_eq!(
        client
            .upload_extension(&token, b"PK-fixture".to_vec())
            .await
            .unwrap(),
        "actual-api-inspection"
    );
    let ticket = pair::session_ticket(&mut row, &tokens, &connections)
        .await
        .unwrap();
    let proxy = SpaProxy::new(&row, client.clone()).await.unwrap();
    let confirmation = proxy.start_session(&ticket, &row.device_id).await.unwrap();
    assert!(confirmation.fragment().is_none());
    assert!(confirmation.query().is_none());
    let whoami = reqwest::Client::new()
        .get(format!("{}/api/v1/whoami", proxy.origin().as_str()))
        .header("User-Agent", proxy.user_agent())
        .send()
        .await
        .unwrap();
    assert!(whoami.status().is_success());
    assert!(!whoami.headers().contains_key("set-cookie"));
    let identity: Value = whoami.json().await.unwrap();
    assert_eq!(identity["principal"]["id"], "desktop-fixture-owner");
    assert_eq!(identity["via"], "session");
    let stdin = child.stdin.as_mut().unwrap();
    stdin.write_all(b"demote\n").await.unwrap();
    line.clear();
    lines.read_line(&mut line).await.unwrap();
    assert!(client
        .upload_extension(&token, b"PK-fixture".to_vec())
        .await
        .is_err());
    stdin.write_all(b"revoke\n").await.unwrap();
    line.clear();
    lines.read_line(&mut line).await.unwrap();
    assert!(client
        .upload_extension(&token, b"PK-fixture".to_vec())
        .await
        .is_err());
    proxy.retire();
    child.stdin.take();
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
}
