use plur1bus_desktop::{
    client::{ClientError, HarnessClient},
    connections::Origin,
    secrets::SecretString,
};
use plur1bus_mock_harness::{MockHarness, MockOptions};
#[tokio::test]
async fn meta_and_installation_identity_gate_bearer() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let c = HarnessClient::new(Origin::parse(&m.origin).unwrap(), None).with_trusted_roots(vec![
        plur1bus_mock_harness::tls::Identity::self_signed().leaf,
    ]);
    assert_eq!(c.meta().await.unwrap().installation_id, m.installation_id);
    let code = m.control.create_pair_code();
    let redeemed = c.redeem(&code, "Desk").await.unwrap();
    assert_eq!(
        c.whoami("different", &redeemed.token).await.unwrap_err(),
        ClientError::InstallationMismatch
    );
    c.whoami(&m.installation_id, &redeemed.token).await.unwrap();
    m.control.revoke_device(&redeemed.device_id);
    assert_eq!(
        c.whoami(&m.installation_id, &redeemed.token)
            .await
            .unwrap_err(),
        ClientError::Revoked
    );
    assert!(!format!("{:?}", SecretString::new(code)).contains('-'));
}
#[tokio::test]
async fn unsupported_api_is_refused_before_bearer_and_errors_do_not_echo_server_data() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let c = HarnessClient::new(Origin::parse(&m.origin).unwrap(), None).with_trusted_roots(vec![
        plur1bus_mock_harness::tls::Identity::self_signed().leaf,
    ]);
    m.control.set_meta(None, "2.0.0");
    assert_eq!(
        c.meta().await.unwrap_err(),
        ClientError::Incompatible {
            server: "2.0.0".into(),
            client: "1.0.0"
        }
    );
    assert!(m.control.recorded_requests().iter().all(|(_, auth)| !*auth));
}
#[tokio::test]
async fn redirects_are_not_followed_and_bodies_are_bounded() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for body in [
        "HTTP/1.1 302 Found\r\nLocation: http://harness.test/secret\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n",
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf).await;
            stream.write_all(body.as_bytes()).await.unwrap();
        });
        let c = HarnessClient::new(Origin::parse(&format!("http://{addr}")).unwrap(), None)
            .with_trusted_roots(vec![
                plur1bus_mock_harness::tls::Identity::self_signed().leaf,
            ]);
        assert_eq!(c.meta().await.unwrap_err(), ClientError::Protocol);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn incompatible_error_reports_public_versions_without_echoing_arbitrary_server_data() {
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let c = HarnessClient::new(Origin::parse(&m.origin).unwrap(), None);
    m.control.set_meta(None, "2.3.4");
    let error = plur1bus_desktop::pair::PairError::from(c.meta().await.unwrap_err());
    assert_eq!(error.public_message(), "incompatible:2.3.4:1.0.0");
    let payload = uuid::Uuid::now_v7().to_string();
    m.control.set_meta(None, &payload);
    assert_eq!(c.meta().await.unwrap_err(), ClientError::Protocol);
}
