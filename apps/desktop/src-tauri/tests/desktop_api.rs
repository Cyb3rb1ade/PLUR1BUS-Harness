//! Current desktop pairing/ticket contract with a disposable credential store; legacy tests stay separate.
use axum::{
    routing::{get, post},
    Json, Router,
};
use plur1bus_desktop::{
    connections::Store,
    pair,
    secrets::{token_account, MemoryStore, TokenStore},
};
use serde_json::{json, Value};

#[tokio::test]
async fn real_contract_pairing_and_tickets_keep_credentials_native() {
    use base64::Engine;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3; 32]);
    let issued = token.clone();
    let app = Router::new()
        .route("/api/v1/meta", get(|| async { Json(json!({"version":"1.0.0", "capabilities":["desktop-pair-v1","desktop-ticket-v1"], "pairingRequired":true})) }))
        .route("/api/v1/desktop/pair", post(move |Json(body): Json<Value>| {
            let token = issued.clone();
            async move {
                assert_eq!(body["kind"], "desktop");
                assert_eq!(body["code"].as_str().unwrap().len(), 43);
                let public = body["publicKey"].as_str().unwrap();
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD.decode(public).unwrap();
                assert_eq!(&bytes[..12], &[0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]);
                assert_eq!(bytes.len(), 44);
                Json(json!({"schema":"desktop.pair/1","device":{"id":"dev_test"},"token":token,"expiresAt":4102444800000_u64}))
            }
        }))
        .route("/api/v1/desktop/redeem", post(move |Json(body): Json<Value>| {
            let token = token.clone();
            async move {
                assert_eq!(body["token"], token);
                Json(json!({"schema":"desktop.redeem/1","ticket":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9;32]),"deviceId":"dev_test","expiresAt":4102444800000_u64}))
            }
        }))
        .route("/api/v1/desktop/ticket", post(|Json(body): Json<Value>| async move {
            assert_eq!(body["deviceId"], "dev_test");
            ([ ("Set-Cookie", "sid=private-session; Path=/; HttpOnly; SameSite=Strict") ], Json(json!({"schema":"desktop.ticket/1"})))
        }))
        .route("/api/v1/extensions/upload", post(|headers: axum::http::HeaderMap, body: axum::body::Bytes| async move {
            assert!(headers["authorization"].to_str().unwrap().starts_with("Bearer "));
            assert!(headers["content-type"].to_str().unwrap().starts_with("multipart/form-data; boundary="));
            assert!(body.windows(7).any(|window| window == b"PK-test"));
            use sha2::Digest;
            Json(json!({"uploadId":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4;32]),
                "expiresAt":4102444800000_u64,"sha256":format!("{:x}",sha2::Sha256::digest(b"PK-test"))}))
        }))
        .route("/api/v1/extensions/inspect", post(|Json(body): Json<Value>| async move {
            assert!(body["source"]["upload"].is_string());
            assert!(body["source"].get("path").is_none());
            Json(json!({"inspectionId":"inspection-test"}))
        }))
        .route("/api/v1/import/snapshots", post(|headers: axum::http::HeaderMap, body: axum::body::Bytes| async move {
            assert!(headers["authorization"].to_str().unwrap().starts_with("Bearer "));
            assert!(body.windows(7).any(|window| window == b"archive"));
            use sha2::Digest;
            Json(json!({"snapshotId":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([5;32]),
                "expiresAt":4102444800000_u64,"sha256":format!("{:x}",sha2::Sha256::digest(b"archive"))}))
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let tokens = MemoryStore::default();
    let store = Store::open(dir.path());
    let mut row = pair::pair_code(&origin, &"c".repeat(43), "Desk", &tokens, &store, None)
        .await
        .unwrap();
    let secret = tokens.get(&token_account(row.id)).unwrap().unwrap();
    assert_eq!(
        secret.expose(),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3; 32])
    );
    let ticket = pair::session_ticket(&mut row, &tokens, &store)
        .await
        .unwrap();
    assert_eq!(
        ticket.ticket.expose(),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9; 32])
    );
    let client = plur1bus_desktop::client::HarnessClient::from_connection(&row)
        .await
        .unwrap();
    let inspection = client
        .upload_extension(&secret, b"PK-test".to_vec())
        .await
        .unwrap();
    assert_eq!(inspection, "inspection-test");
    let archive = dir.path().join("snapshot.tar.gz");
    std::fs::write(&archive, b"archive").unwrap();
    let snapshot = client
        .upload_snapshot_file(
            &secret,
            &archive,
            &format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"archive")),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.snapshot_id.len(), 43);
    let proxy = plur1bus_desktop::spa_proxy::SpaProxy::new(&row, client)
        .await
        .unwrap();
    let url = proxy.start_session(&ticket, &row.device_id).await.unwrap();
    assert_eq!(url.path(), "/");
    assert_eq!(url.fragment(), None);
    assert_eq!(url.query(), None);
    assert!(!proxy.session_jar_is_empty());
    proxy.retire();
    let disk = std::fs::read(dir.path().join("connections.json")).unwrap();
    assert!(!disk
        .windows(43)
        .any(|window| window == secret.expose().as_bytes()));
    let key_account = format!("device-key-{}", row.id);
    assert!(tokens.get(&key_account).unwrap().is_some());
    pair::remove_connection(&store, row.id, Some(&tokens), &tokens).unwrap();
    assert!(tokens.get(&key_account).unwrap().is_none());
    server.abort();
}
