mod common;
use plur1bus_desktop::{
    connections::{Connection, Kind, Origin, Store},
    discovery, pair,
    secrets::{token_account, MemoryStore, TokenStore},
};
use plur1bus_mock_harness::{MockHarness, MockOptions};
#[tokio::test]
async fn redeem_stores_the_token_in_the_token_store_only_and_revoked_removes_it() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let tokens = MemoryStore::default();
    let code = m.control.create_pair_code();
    let mut c = pair::pair_code(&m.origin, &code, "Desk", &tokens, &store, None)
        .await
        .unwrap();
    let token = tokens.get(&token_account(c.id)).unwrap().unwrap();
    common::assert_no_token_on_disk(dir.path(), token.expose());
    assert_eq!(c.id.get_version_num(), 7);
    m.control.revoke_device(&c.device_id);
    assert_eq!(
        pair::validate_connection(&mut c, &tokens, &store)
            .await
            .unwrap_err()
            .code(),
        "revoked"
    );
    assert!(tokens.get(&token_account(c.id)).unwrap().is_none());
    assert!(store.load().unwrap()[0].pairing_needed);
}
#[tokio::test]
async fn pair_code_rejects_insecure_remote_before_any_request() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        pair::pair_code(
            "http://harness.test",
            "invalid",
            "Desk",
            &MemoryStore::default(),
            &Store::open(dir.path()),
            None
        )
        .await
        .unwrap_err(),
        pair::PairError::InsecureOrigin
    );
}
#[test]
fn discover_ignores_stale_non_loopback_and_unknown_fields_and_never_opens_tokens() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("run")).unwrap();

    let mut value = serde_json::json!({"url":"http://127.0.0.1:18700","pid":123,"instanceId":"instance","installationId":"installation","apiVersion":"1.0.0"});
    let write = |v: &serde_json::Value| {
        std::fs::write(
            dir.path().join("run/api.json"),
            serde_json::to_vec(v).unwrap(),
        )
        .unwrap()
    };
    write(&value);
    assert!(discovery::discover(dir.path(), |_| false).is_none());
    assert!(discovery::discover(dir.path(), |pid| pid == 123).is_some());
    value["url"] = "https://harness.test".into();
    write(&value);
    assert!(discovery::discover(dir.path(), |_| true).is_none());
    value["url"] = "http://localhost".into();
    value["token"] = "unexpected".into();
    write(&value);
    assert!(discovery::discover(dir.path(), |_| true).is_none());
}
#[test]
fn the_pin_is_never_taken_from_a_typed_field() {
    let value = serde_json::json!({"origin":"https://harness.test","name":"Desk","code":"invalid","repairId":null,"certPin":"untrusted"});
    assert!(serde_json::from_value::<plur1bus_desktop::commands::PairCodeRequest>(value).is_err());
}
#[tokio::test]
async fn a_different_installation_at_the_origin_gets_no_code_or_token() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let tokens = MemoryStore::default();
    let row = Connection::new(
        "Desk".into(),
        Kind::Remote,
        Origin::parse(&m.origin).unwrap(),
        "different".into(),
        "device".into(),
        "hint".into(),
    );
    store.upsert(row.clone()).unwrap();
    let code = m.control.create_pair_code();
    assert_eq!(
        pair::pair_code(&m.origin, &code, "Desk", &tokens, &store, Some(row.id))
            .await
            .unwrap_err()
            .code(),
        "installation-mismatch"
    );
    assert!(m
        .control
        .recorded_requests()
        .iter()
        .all(|(p, auth)| p.ends_with("/meta") && !*auth));
}
struct FakeExecutor {
    denied: bool,
}
impl pair::PairExecutor for FakeExecutor {
    fn execute<'a>(
        &'a self,
        cli: &'a std::path::Path,
        args: Vec<String>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<pair::CliOutput, pair::PairError>> + Send + 'a>,
    > {
        Box::pin(async move {
            assert!(cli.is_absolute());
            assert_eq!(
                args,
                ["device", "pair", "--json", "--kind", "desktop", "--name", "Desk"]
            );
            let code: String = (0..8)
                .map(|i| {
                    plur1bus_desktop_contract::trust::CODE_ALPHABET
                        [(uuid::Uuid::now_v7().as_bytes()[i] as usize) & 31]
                        as char
                })
                .collect();
            let body = if self.denied {
                serde_json::json!({"schema":"error/1","code":"E_DENIED"})
            } else {
                serde_json::json!({"schema":"device.pair/1","code":format!("{}-{}",&code[..4],&code[4..]),"expiresAt":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()})
            };
            Ok(pair::CliOutput {
                success: !self.denied,
                bytes: zeroize::Zeroizing::new(serde_json::to_vec(&body).unwrap()),
            })
        })
    }
}
#[tokio::test]
async fn pair_local_spawns_fixed_args_and_parses_json_and_denied_falls_back() {
    let dir = tempfile::tempdir().unwrap();
    let cli = dir.path().join("plur1bus");
    let offer = pair::pair_local_with(&FakeExecutor { denied: false }, &cli, "Desk")
        .await
        .unwrap();
    assert_eq!(offer.schema, "device.pair/1");
    assert!(matches!(
        pair::pair_local_with(&FakeExecutor { denied: true }, &cli, "Desk").await,
        Err(pair::PairError::Denied)
    ));
}
#[tokio::test]
async fn revoked_during_trust_or_ack_and_ticket_clears_credentials() {
    for route in [
        plur1bus_desktop_contract::route::WHOAMI,
        plur1bus_desktop_contract::trust::TRUST,
        plur1bus_desktop_contract::route::SESSION_TICKET,
    ] {
        let m = MockHarness::start(MockOptions::default()).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path());
        let tokens = MemoryStore::default();
        let code = m.control.create_pair_code();
        let mut c = pair::pair_code(&m.origin, &code, "Desk", &tokens, &store, None)
            .await
            .unwrap();
        if route == plur1bus_desktop_contract::route::SESSION_TICKET {
            m.control.revoke_device(&c.device_id);
            assert!(pair::session_ticket(&mut c, &tokens, &store).await.is_err());
        } else {
            m.control.revoke_after_route(route);
            if route == plur1bus_desktop_contract::trust::TRUST {
                m.control.revoke_device(&c.device_id);
            }
            assert!(pair::validate_connection(&mut c, &tokens, &store)
                .await
                .is_err());
        }
        assert!(tokens.get(&token_account(c.id)).unwrap().is_none());
        assert!(store.load().unwrap()[0].pairing_needed);
    }
}
#[tokio::test]
async fn malformed_short_redemption_is_refused_without_persistence_or_secret_in_error() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    m.control.set_redemption_token_length(1);
    let dir = tempfile::tempdir().unwrap();
    let tokens = MemoryStore::default();
    let store = Store::open(dir.path());
    let code = m.control.create_pair_code();
    let error = pair::pair_code(&m.origin, &code, "Desk", &tokens, &store, None)
        .await
        .unwrap_err();
    assert_eq!(error.code(), "protocol");
    assert!(store.load().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn missing_desktop_session_ticket_is_refused_without_bearer() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let tokens = MemoryStore::default();
    let mut row = pair::pair_code(
        &m.origin,
        &m.control.create_pair_code(),
        "Desk",
        &tokens,
        &store,
        None,
    )
    .await
    .unwrap();
    m.control.set_session_ticket_capability(false);
    m.control.clear_requests();
    assert_eq!(
        pair::validate_connection(&mut row, &tokens, &store)
            .await
            .unwrap_err()
            .code(),
        "incompatible"
    );
    assert!(m
        .control
        .recorded_requests()
        .iter()
        .all(|(p, a)| p.ends_with("/meta") && !a));
}
#[tokio::test]
async fn a_different_installation_at_the_origin_gets_no_token_on_validate() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let tokens = MemoryStore::default();
    let mut row = pair::pair_code(
        &m.origin,
        &m.control.create_pair_code(),
        "Desk",
        &tokens,
        &store,
        None,
    )
    .await
    .unwrap();
    m.control.set_meta(Some("replacement"), "1.0.0");
    m.control.clear_requests();
    assert_eq!(
        pair::validate_connection(&mut row, &tokens, &store)
            .await
            .unwrap_err()
            .code(),
        "installation-mismatch"
    );
    assert!(store.load().unwrap()[0].pairing_needed);
    assert!(m
        .control
        .recorded_requests()
        .iter()
        .all(|(p, a)| p.ends_with("/meta") && !a));
}

#[test]
fn discover_never_opens_token_files() {
    let dir = tempfile::tempdir().unwrap();
    let record = br#"{"url":"http://127.0.0.1:18700","pid":123,"instanceId":"instance","installationId":"installation","apiVersion":"1.0.0"}"#;
    assert!(discovery::discover_with_opener(
        dir.path(),
        |_| true,
        |path| {
            assert_eq!(
                path,
                dir.path().join("run/api.json"),
                "only public discovery may be opened"
            );
            Ok(std::io::Cursor::new(record))
        }
    )
    .is_some());
}
#[tokio::test]
async fn repairing_local_connection_preserves_kind() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let tokens = MemoryStore::default();
    let row = pair::pair(
        Origin::parse(&m.origin).unwrap(),
        &m.control.create_pair_code(),
        "Desk",
        Kind::Local,
        None,
        None,
        &tokens,
        &store,
    )
    .await
    .unwrap();
    let repaired = pair::pair_code(
        &m.origin,
        &m.control.create_pair_code(),
        "Desk",
        &tokens,
        &store,
        Some(row.id),
    )
    .await
    .unwrap();
    assert_eq!(repaired.kind, Kind::Local);
}

struct NoLookup;
impl plur1bus_desktop::transport::Resolver for NoLookup {
    fn lookup<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<Vec<std::net::SocketAddr>, plur1bus_desktop::transport::ResolveError>,
    > {
        panic!("an IP literal is never resolved")
    }
}
struct NoTailscale;
impl plur1bus_desktop::transport::TailscaleSource for NoTailscale {
    fn status(
        &self,
    ) -> futures_util::future::BoxFuture<'_, plur1bus_desktop::transport::TailscaleStatus> {
        panic!("a direct loopback target runs no Tailscale check")
    }
}
struct NoProbe;
impl plur1bus_desktop::transport::Prober for NoProbe {
    fn probe<'a>(
        &'a self,
        _addrs: &'a [std::net::SocketAddr],
    ) -> futures_util::future::BoxFuture<'a, plur1bus_desktop::transport::ProbeOutcome> {
        panic!("pairing never probes")
    }
}

/// Transport choice T4: `pair_code` with `transport` and `publicAck`. The request round-trips, Rust's own check gates
/// and pins the pairing, the sidecar entry is written after the row exists (the confirmation only where the check
/// needs it), and `connections.json` is byte-identical to what the pre-feature writer produces for the same row.
#[tokio::test]
async fn pair_code_with_a_path_writes_the_sidecar_and_leaves_connections_json_unchanged() {
    use plur1bus_desktop::commands::PairCodeRequest;
    use plur1bus_desktop::transport::{CheckDeps, Transport, TransportStore, Transports};
    use std::sync::Arc;
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let tokens = MemoryStore::default();
    for public_ack in [false, true] {
        let request: PairCodeRequest = serde_json::from_value(serde_json::json!({
            "origin": m.origin, "name": "Desk", "code": m.control.create_pair_code(),
            "repairId": null, "linkId": null, "transport": "direct", "publicAck": public_ack,
        }))
        .unwrap();
        assert_eq!(request.transport, Transport::Direct);
        assert_eq!(request.public_ack, public_ack);
        let transports = Transports::new(
            CheckDeps {
                resolver: Arc::new(NoLookup),
                tailscale: Arc::new(NoTailscale),
                prober: Arc::new(NoProbe),
            },
            Arc::new(|_: &str| {}),
        );
        let origin = Origin::parse(&request.origin).unwrap();
        let checked = transports
            .check_pair(&origin, request.transport, request.public_ack)
            .await
            .unwrap();
        assert!(!checked.report.needs_public_ack);
        let row = pair::pair_code_pinned(
            &request.origin,
            &request.code,
            &request.name,
            &tokens,
            &store,
            request.repair_id,
            Some(checked.pin),
        )
        .await
        .unwrap();
        let tstore = TransportStore::open(dir.path());
        transports
            .record_pairing(&tstore, &row, request.transport, &checked.report)
            .unwrap();
        let sidecar: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join("connection-transport.json")).unwrap(),
        )
        .unwrap();
        // A loopback target needs no confirmation: a ticked box stores none.
        assert_eq!(
            sidecar["connections"][row.id.to_string()],
            serde_json::json!({ "transport": "direct" })
        );
        // The pre-feature writer, same rows: identical bytes.
        let before = tempfile::tempdir().unwrap();
        let reference = Store::open(before.path());
        for row in store.load().unwrap() {
            reference.upsert(row).unwrap();
        }
        assert_eq!(
            std::fs::read(dir.path().join("connections.json")).unwrap(),
            std::fs::read(before.path().join("connections.json")).unwrap()
        );
    }
}
