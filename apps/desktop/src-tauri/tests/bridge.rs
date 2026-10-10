use plur1bus_desktop::{
    bridge::{self, KeyUnlock},
    connections::{Kind, Origin},
    secrets::{MemoryStore, SecretString, StoreKind, TokenError, TokenStore},
};
struct Persistent(MemoryStore);
impl TokenStore for Persistent {
    fn get(&self, a: &str) -> Result<Option<SecretString>, TokenError> {
        self.0.get(a)
    }
    fn set(&self, a: &str, v: &SecretString) -> Result<(), TokenError> {
        self.0.set(a, v)
    }
    fn delete(&self, a: &str) -> Result<(), TokenError> {
        self.0.delete(a)
    }
    fn kind(&self) -> StoreKind {
        StoreKind::Keychain
    }
}
fn keys() -> KeyUnlock {
    KeyUnlock::new(Box::new(Persistent(MemoryStore::default())))
}
#[test]
fn hello_lists_only_enabled_capabilities() {
    assert_eq!(
        bridge::hello(true)["capabilities"],
        serde_json::json!(["host.keyUnlock"])
    );
    assert_eq!(bridge::hello(false)["capabilities"], serde_json::json!([]));
}
#[test]
fn provision_creates_and_stores_a_key_once() {
    let s = keys();
    let k = s.call("installation", "provision", true).unwrap();
    assert_eq!(
        base64::Engine::decode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            k.expose()
        )
        .unwrap()
        .len(),
        32
    );
    assert_eq!(
        s.call("installation", "get", true).unwrap().expose(),
        k.expose()
    );
}
#[test]
fn provision_never_overwrites_an_existing_key() {
    let s = keys();
    let old = s.call("installation", "provision", true).unwrap();
    assert_eq!(
        s.call("installation", "provision", true).unwrap_err(),
        "E_EXISTS"
    );
    assert_eq!(
        s.call("installation", "get", true).unwrap().expose(),
        old.expose()
    );
}
#[test]
fn get_returns_the_stored_key() {
    let s = keys();
    let key = s.call("installation", "provision", true).unwrap();
    assert_eq!(
        s.call("installation", "get", true).unwrap().expose(),
        key.expose()
    );
    assert_eq!(s.call("other", "get", true).unwrap_err(), "E_NOT_FOUND");
}
#[test]
#[allow(non_snake_case)]
fn capability_off_answers_E_DENIED() {
    let s = keys();
    assert_eq!(
        s.call("installation", "get", false).unwrap_err(),
        "E_DENIED"
    );
    assert_eq!(
        s.call("installation", "provision", false).unwrap_err(),
        "E_DENIED"
    );
}
#[test]
fn memory_only_store_refuses_provision() {
    let s = KeyUnlock::new(Box::<MemoryStore>::default());
    assert_eq!(
        s.call("installation", "provision", true).unwrap_err(),
        "E_MEMORY_ONLY"
    );
}
#[test]
fn remote_connections_do_not_start_the_bridge_in_d1() {
    assert!(bridge::endpoint(
        Kind::Remote,
        &Origin::parse("https://harness.test").unwrap()
    )
    .is_none());
    assert!(bridge::endpoint(
        Kind::Local,
        &Origin::parse("http://127.0.0.1:18700").unwrap()
    )
    .is_none());
    assert_eq!(
        bridge::endpoint(
            Kind::Bundled,
            &Origin::parse("http://127.0.0.1:18700").unwrap()
        )
        .unwrap()
        .as_str(),
        "ws://127.0.0.1:18700/ws"
    );
    assert!(bridge::endpoint(
        Kind::Bundled,
        &Origin::parse("https://harness.test").unwrap()
    )
    .is_none());
}
#[test]
fn concurrent_provision_has_one_winner() {
    let s = std::sync::Arc::new(keys());
    let results = std::sync::Mutex::new(vec![]);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let s = s.clone();
            let r = &results;
            scope.spawn(move || {
                r.lock()
                    .unwrap()
                    .push(s.call("installation", "provision", true).is_ok());
            });
        }
    });
    assert_eq!(
        results
            .into_inner()
            .unwrap()
            .into_iter()
            .filter(|v| *v)
            .count(),
        1
    );
}
#[test]
fn reconnects_with_backoff() {
    let mut b = bridge::Backoff::default();
    assert_eq!(
        (0..8)
            .map(|_| b.next_delay(0.5).as_secs())
            .collect::<Vec<_>>(),
        vec![1, 2, 4, 8, 16, 30, 30, 30]
    );
    b.reset_backoff();
    assert_eq!(b.next_delay(0.5).as_secs(), 1);
}
#[test]
fn revoked_stops_and_requests_pairing() {
    assert!(bridge::needs_pairing(401));
    assert!(!bridge::needs_pairing(503));
}
#[tokio::test]
async fn bridge_transport_against_stub_preserves_the_key_after_restart_and_hands_revocation_to_pairing(
) {
    use plur1bus_desktop::client::HarnessClient;
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let mock = MockHarness::start(MockOptions::default()).await.unwrap();
    let client = HarnessClient::new(Origin::parse(&mock.origin).unwrap(), None);
    let code = mock.control.create_pair_code_with_grant(true);
    let redeemed = client.redeem(&code, "p1t-desktop").await.unwrap();
    let url = bridge::endpoint(Kind::Bundled, &Origin::parse(&mock.origin).unwrap()).unwrap();
    assert!(mock.control.secrets_locked());
    let key = std::sync::Arc::new(keys());
    for op in ["provision", "get"] {
        let worker_key = key.clone();
        let url = url.clone();
        let token = SecretString::new(redeemed.token.expose().into());
        let task = tokio::spawn(async move {
            let mut retry = bridge::Backoff::default();
            bridge::session(&url, &token, true, &mut retry, move |op| {
                std::future::ready(
                    worker_key
                        .call("installation", &op, true)
                        .map_err(str::to_owned),
                )
            })
            .await
        });
        let id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Ok(id) =
                    mock.control
                        .call_bridge(&redeemed.device_id, op, serde_json::json!({}))
                {
                    break id;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(v) = mock.control.take_bridge_result(&id) {
                    break v;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(result["ok"], true);
        assert!(!mock.control.secrets_locked());
        assert_eq!(
            result["value"].as_str().unwrap(),
            key.call("installation", "get", true).unwrap().expose()
        );
        task.abort();
        let _ = task.await;
        mock.control.set_status("ready", "locked");
        assert!(mock.control.secrets_locked());
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while mock.control.bridge_connection_count(&redeemed.device_id) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    let mut retry = bridge::Backoff::default();
    mock.control.revoke_device(&redeemed.device_id);
    assert_eq!(
        bridge::session(&url, &redeemed.token, true, &mut retry, |_| {
            std::future::ready(Err("E_DENIED".into()))
        })
        .await,
        bridge::Exit::Pairing
    );
}
#[tokio::test]
async fn disabled_bridge_negotiates_no_capability_with_the_stub() {
    use plur1bus_desktop::client::HarnessClient;
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let mock = MockHarness::start(MockOptions::default()).await.unwrap();
    let origin = Origin::parse(&mock.origin).unwrap();
    let client = HarnessClient::new(origin.clone(), None);
    let redeemed = client
        .redeem(
            &mock.control.create_pair_code_with_grant(true),
            "p1t-desktop",
        )
        .await
        .unwrap();
    let device = redeemed.device_id.clone();
    let url = bridge::endpoint(Kind::Bundled, &origin).unwrap();
    let task = tokio::spawn(async move {
        let mut retry = bridge::Backoff::default();
        bridge::session(&url, &redeemed.token, false, &mut retry, |_| async {
            panic!("disabled key callback")
        })
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(mock
        .control
        .call_bridge(&device, "provision", serde_json::json!({}))
        .is_err());
    assert!(!mock.control.provisioned());
    task.abort();
}
#[tokio::test]
async fn connected_revocation_stops_the_actual_websocket() {
    use plur1bus_desktop::client::HarnessClient;
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let mock = MockHarness::start(MockOptions::default()).await.unwrap();
    let origin = Origin::parse(&mock.origin).unwrap();
    let client = HarnessClient::new(origin.clone(), None);
    let redeemed = client
        .redeem(
            &mock.control.create_pair_code_with_grant(true),
            "p1t-desktop",
        )
        .await
        .unwrap();
    let device = redeemed.device_id.clone();
    let url = bridge::endpoint(Kind::Bundled, &origin).unwrap();
    let task = tokio::spawn(async move {
        let mut retry = bridge::Backoff::default();
        bridge::session(&url, &redeemed.token, true, &mut retry, |_| async {
            Err("E_DENIED".into())
        })
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while mock.control.bridge_connection_count(&device) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    mock.control.revoke_device(&device);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        bridge::Exit::Pairing
    );
}
#[tokio::test]
async fn approval_events_reach_the_native_projection_from_authenticated_sse() {
    use plur1bus_desktop::{client::HarnessClient, events::EventStream};
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let mock = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let tokens = MemoryStore::default();
    let connection = plur1bus_desktop::pair::pair_code(
        &mock.origin,
        &mock.control.create_pair_code(),
        "p1t-desktop",
        &tokens,
        &plur1bus_desktop::connections::Store::open(dir.path()),
        None,
    )
    .await
    .unwrap();
    let client = HarnessClient::from_connection(&connection).await.unwrap();
    let token = tokens
        .get(&plur1bus_desktop::secrets::token_account(connection.id))
        .unwrap()
        .unwrap();
    let (tx, stop) = tokio::sync::watch::channel(false);
    let cards = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
    let captured = cards.clone();
    let cancel = tx.clone();
    let mut stream = EventStream::default();
    stream.approval_sink(std::sync::Arc::new(move |name, value| {
        if name == "approval.requested" {
            captured
                .lock()
                .unwrap()
                .push(plur1bus_desktop::host_commands::project(&value).unwrap());
            cancel.send(true).unwrap();
        }
    }));
    let mut created = false;
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        stream.run(&client, &mock.installation_id, &token, stop, |update| {
            if update.connected && !created {
                created = true;
                mock.control.create_approval("request", "synthetic");
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        cards.lock().unwrap()[0].targets,
        vec!["/p1t/synthetic-target"]
    );
}
