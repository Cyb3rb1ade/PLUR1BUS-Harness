use axum::{
    body::Body,
    extract::{State, WebSocketUpgrade},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use plur1bus_desktop::{
    client::HarnessClient,
    connections::{Connection, Kind, Origin},
    spa_proxy::SpaProxy,
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<(String, HeaderMap)>>>);
async fn upstream(
    State(seen): State<Seen>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    req: Request<Body>,
) -> Response {
    let path = req.uri().path().to_owned();
    seen.0
        .lock()
        .unwrap()
        .push((path.clone(), req.headers().clone()));
    match path.as_str() {
        "/api/v1/meta"=>axum::Json(json!({"apiVersion":"1.0.0","version":"0.1.0","installationId":"test-installation","capabilities":["desktop.sessionTicket"]})).into_response(),
        "/csp"=>([("content-security-policy","script-src 'self' 'nonce-kept'; style-src 'sha256-kept'; Report-Uri https://foreign.test/report; report-to foreign"),("report-to","{\"group\":\"foreign\"}"),("reporting-endpoints","foreign=\"https://foreign.test/report\""),("nel","{}")],"csp").into_response(),
        "/cookie"=>([("set-cookie","session=one; HttpOnly; SameSite=Lax; Path=/")],"cookie").into_response(),
        "/same"=>(StatusCode::FOUND,[("location","/echo?next=1")]).into_response(),
        "/foreign"=>(StatusCode::FOUND,[("location","http://127.0.0.1:9/never")]).into_response(),
        "/sse"=>{
            let stream=futures_util::stream::once(async{Ok::<_,std::convert::Infallible>("data: first\n\n")}).chain(futures_util::stream::once(async{tokio::time::sleep(Duration::from_secs(11)).await;Ok("data: second\n\n")}));
            ([("content-type","text/event-stream")],Body::from_stream(stream)).into_response()
        },
        "/ws"=>ws.unwrap().on_upgrade(|mut socket|async move {while let Some(Ok(message))=socket.recv().await {if socket.send(message).await.is_err(){break}}}).into_response(),
        "/ws-protocol"=>ws.unwrap().protocols(["pluribus.v1"]).on_upgrade(|mut socket|async move {while let Some(Ok(message))=socket.recv().await {if socket.send(message).await.is_err(){break}}}).into_response(),
        "/ws-protocol-unoffered"=>ws.unwrap().protocols(["unoffered.v1"]).on_upgrade(|mut socket|async move {while let Some(Ok(message))=socket.recv().await {if socket.send(message).await.is_err(){break}}}).into_response(),
        "/large"=>vec![b'x';10*1024*1024].into_response(),
        _=>"ok".into_response()
    }
}
struct Fixture {
    proxy: SpaProxy,
    seen: Seen,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.proxy.retire();
        self.task.abort();
    }
}
async fn fixture(kind: Kind) -> Fixture {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = Origin::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let seen = Seen::default();
    let router = Router::new()
        .fallback(any(upstream))
        .with_state(seen.clone());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let connection = Connection::new(
        "Test".into(),
        kind,
        origin,
        "test-installation".into(),
        "test-device".into(),
        "test".into(),
    );
    let client = HarnessClient::from_connection(&connection).await.unwrap();
    let proxy = SpaProxy::new(&connection, client).await.unwrap();
    Fixture { proxy, seen, task }
}
fn request(proxy: &SpaProxy, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .get(format!("{}{path}", proxy.origin().as_str()))
        .header("user-agent", proxy.user_agent())
}
#[tokio::test]
async fn only_the_spa_webview_is_served_others_get_403() {
    let f = fixture(Kind::Local).await;
    let url = format!("{}/echo", f.proxy.origin().as_str());
    let c = reqwest::Client::new();
    for req in [
        c.get(&url),
        c.get(&url).header("user-agent", "wrong"),
        c.get(&url)
            .header("user-agent", f.proxy.user_agent())
            .header("host", "foreign.test"),
        c.get(&url)
            .header("user-agent", f.proxy.user_agent())
            .header("origin", "https://foreign.test"),
        c.get(&url)
            .header("user-agent", f.proxy.user_agent())
            .header("origin", "null"),
        c.get(&url)
            .header("user-agent", f.proxy.user_agent())
            .header("origin", f.proxy.origin().as_str())
            .header("origin", "https://foreign.test"),
    ] {
        assert_eq!(req.send().await.unwrap().status(), 403);
    }
    assert!(f.seen.0.lock().unwrap().is_empty());
    assert_eq!(
        request(&f.proxy, "/echo").send().await.unwrap().status(),
        200
    );
}
#[tokio::test]
async fn forwards_only_to_the_connection_origin_even_after_a_redirect() {
    let f = fixture(Kind::Local).await;
    let c = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let same = c
        .get(format!("{}/same", f.proxy.origin().as_str()))
        .header("user-agent", f.proxy.user_agent())
        .send()
        .await
        .unwrap();
    assert_eq!(same.status(), 302);
    assert_eq!(
        same.headers()["location"],
        format!("{}/echo?next=1", f.proxy.origin().as_str())
    );
    assert_eq!(
        request(&f.proxy, "/foreign").send().await.unwrap().status(),
        502
    );
    assert!(f.seen.0.lock().unwrap().iter().all(|(p, _)| p != "/never"));
}
#[tokio::test]
async fn never_adds_authorization_or_the_device_token() {
    let f = fixture(Kind::Local).await;
    request(&f.proxy, "/echo").send().await.unwrap();
    assert!(f
        .seen
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|(_, h)| !h.contains_key("authorization") && !h.contains_key("user-agent")));
}
#[tokio::test]
async fn page_cookies_and_authorization_are_dropped() {
    let f = fixture(Kind::Local).await;
    request(&f.proxy, "/echo")
        .header("cookie", "page=untrusted")
        .header("authorization", "Bearer untrusted")
        .send()
        .await
        .unwrap();
    let records = f.seen.0.lock().unwrap();
    let (_, h) = records.iter().find(|(p, _)| p == "/echo").unwrap();
    assert!(!h.contains_key("cookie"));
    assert!(!h.contains_key("authorization"));
}
#[tokio::test]
async fn set_cookie_stays_in_the_jar_and_the_webview_store_is_empty() {
    let f = fixture(Kind::Local).await;
    let response = request(&f.proxy, "/cookie").send().await.unwrap();
    assert!(!response.headers().contains_key("set-cookie"));
    request(&f.proxy, "/echo")
        .header("cookie", "page=untrusted")
        .send()
        .await
        .unwrap();
    let records = f.seen.0.lock().unwrap();
    let (_, h) = records.iter().find(|(p, _)| p == "/echo").unwrap();
    assert_eq!(h["cookie"], "session=one");
}
#[tokio::test]
async fn origin_and_host_are_the_connection_origin() {
    let f = fixture(Kind::Local).await;
    request(&f.proxy, "/echo")
        .header("referer", "https://foreign.test/secret")
        .send()
        .await
        .unwrap();
    let records = f.seen.0.lock().unwrap();
    let (_, h) = records.iter().find(|(p, _)| p == "/echo").unwrap();
    let origin = h["origin"].to_str().unwrap();
    assert_eq!(h["host"], origin.strip_prefix("http://").unwrap());
    assert_eq!(h["referer"], format!("{origin}/"));
}
#[tokio::test]
async fn sse_events_stream_without_buffering() {
    let f = fixture(Kind::Local).await;
    let started = std::time::Instant::now();
    let mut response = request(&f.proxy, "/sse").send().await.unwrap();
    let first = tokio::time::timeout(Duration::from_secs(2), response.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(first.starts_with(b"data: first"));
    let second = tokio::time::timeout(Duration::from_secs(13), response.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(second.starts_with(b"data: second"));
    assert!(started.elapsed() > Duration::from_secs(10));
}
#[tokio::test]
async fn websocket_upgrade_is_forwarded() {
    let f = fixture(Kind::Local).await;
    let url = format!("{}/ws", f.proxy.origin().as_str().replacen("http", "ws", 1));
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert("user-agent", f.proxy.user_agent().parse().unwrap());
    req.headers_mut()
        .insert("origin", f.proxy.origin().as_str().parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text("echo".into()))
        .await
        .unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        "echo"
    );
    ws.close(None).await.unwrap();
    assert!(f
        .seen
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|(_, h)| !h.contains_key("authorization") && !h.contains_key("user-agent")));
}

#[tokio::test]
async fn websocket_selected_subprotocol_is_mirrored_to_the_browser() {
    let f = fixture(Kind::Local).await;
    let url = format!(
        "{}/ws-protocol",
        f.proxy.origin().as_str().replacen("http", "ws", 1)
    );
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert("user-agent", f.proxy.user_agent().parse().unwrap());
    req.headers_mut()
        .insert("origin", f.proxy.origin().as_str().parse().unwrap());
    req.headers_mut()
        .insert("sec-websocket-protocol", "pluribus.v1".parse().unwrap());
    let (mut ws, response) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "pluribus.v1");
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        "protocol-echo".into(),
    ))
    .await
    .unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        "protocol-echo"
    );
    ws.close(None).await.unwrap();
}
#[tokio::test]
async fn websocket_unoffered_subprotocol_fails_closed() {
    let f = fixture(Kind::Local).await;
    let url = format!(
        "{}/ws-protocol-unoffered",
        f.proxy.origin().as_str().replacen("http", "ws", 1)
    );
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert("user-agent", f.proxy.user_agent().parse().unwrap());
    req.headers_mut()
        .insert("origin", f.proxy.origin().as_str().parse().unwrap());
    req.headers_mut()
        .insert("sec-websocket-protocol", "pluribus.v1".parse().unwrap());
    let result = tokio_tungstenite::connect_async(req).await;
    match result {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), reqwest::StatusCode::BAD_GATEWAY);
        }
        other => panic!("unexpected websocket result: {other:?}"),
    }
}
#[tokio::test]
async fn bundled_local_and_remote_use_the_same_path() {
    for kind in [Kind::Bundled, Kind::Local, Kind::Remote] {
        let f = fixture(kind).await;
        let bytes = request(&f.proxy, "/large")
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(bytes.len(), 10 * 1024 * 1024);
        assert!(bytes.iter().all(|b| *b == b'x'));
    }
}
#[tokio::test]
async fn pinned_origin_with_a_changed_certificate_fails_closed() {
    use plur1bus_desktop::connections::CertPin;
    use plur1bus_mock_harness::{tls::Identity, MockHarness, MockOptions};
    let cert = Identity::self_signed();
    let pin = CertPin::parse(&cert.pin()).unwrap();
    let m = MockHarness::start_tls(MockOptions::default(), cert)
        .await
        .unwrap();
    let mut c = Connection::new(
        "TLS".into(),
        Kind::Remote,
        Origin::parse(&m.origin).unwrap(),
        m.installation_id.clone(),
        "device".into(),
        "test".into(),
    );
    c.cert_pin = Some(pin);
    let client = HarnessClient::from_connection(&c).await.unwrap();
    let proxy = SpaProxy::new(&c, client).await.unwrap();
    m.control.renew_leaf(Identity::self_signed());
    m.control.clear_requests();
    assert_eq!(request(&proxy, "/").send().await.unwrap().status(), 502);
    assert!(m.control.recorded_requests().is_empty());
    proxy.retire();
}
#[tokio::test]
async fn retired_listener_rejects_old_secret_and_reserves_port() {
    let f = fixture(Kind::Local).await;
    f.proxy.retire();
    assert_eq!(
        request(&f.proxy, "/echo").send().await.unwrap().status(),
        403
    );
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, f.proxy.port())).is_err());
}

#[tokio::test]
async fn installation_replacement_gets_no_saved_cookie_or_websocket() {
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let c = Connection::new(
        "Test".into(),
        Kind::Local,
        Origin::parse(&m.origin).unwrap(),
        m.installation_id.clone(),
        "device".into(),
        "test".into(),
    );
    let native = HarnessClient::from_connection(&c).await.unwrap();
    let credential = native
        .redeem(&m.control.create_pair_code(), "Test")
        .await
        .unwrap();
    let ticket = native
        .session_ticket(&m.installation_id, &credential.token)
        .await
        .unwrap();
    let proxy = SpaProxy::new(&c, native).await.unwrap();
    assert_eq!(
        reqwest::Client::new()
            .post(format!(
                "{}/api/v1/auth/ticket/redeem",
                proxy.origin().as_str()
            ))
            .header("user-agent", proxy.user_agent())
            .json(&json!({"ticket":ticket.ticket.expose()}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        request(&proxy, "/api/v1/auth/whoami")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    m.control.set_meta(Some("replacement"), "1.0.0");
    m.control.clear_requests();
    assert_eq!(
        request(&proxy, "/api/v1/auth/whoami")
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
    let mut ws = format!("{}/ws", proxy.origin().as_str().replacen("http", "ws", 1))
        .into_client_request()
        .unwrap();
    ws.headers_mut()
        .insert("user-agent", proxy.user_agent().parse().unwrap());
    assert!(tokio_tungstenite::connect_async(ws).await.is_err());
    assert!(m
        .control
        .recorded_requests()
        .iter()
        .all(|(path, auth)| path.ends_with("/meta") && !auth));
    m.control.set_meta(None, "1.0.0");
    assert_eq!(
        request(&proxy, "/api/v1/auth/whoami")
            .send()
            .await
            .unwrap()
            .status(),
        401,
        "mismatch erased saved cookies"
    );
    proxy.retire();
}

#[tokio::test]
async fn launch_carrier_is_not_forwarded_in_targets_or_arbitrary_headers() {
    let f = fixture(Kind::Local).await;
    let mut nonce = String::new();
    f.proxy.register_launch_secret(|s| nonce = s.to_owned());
    assert_eq!(
        request(&f.proxy, &format!("/echo?leak={nonce}"))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    request(&f.proxy, "/echo")
        .header("x-reflected-agent", f.proxy.user_agent())
        .send()
        .await
        .unwrap();
    assert!(f
        .seen
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|(p, h)| !p.contains(&nonce)
            && h.values()
                .all(|v| !v.to_str().unwrap_or_default().contains(&nonce))));
}

#[tokio::test]
async fn streams_reuse_leaf_ca_os_and_staged_trust() {
    use plur1bus_mock_harness::{
        tls::{CompanyCa, Identity},
        MockHarness, MockOptions,
    };
    for mode in 0..5 {
        let ca = CompanyCa::new();
        let initial = if mode == 1 || mode == 2 {
            ca.issue()
        } else {
            Identity::self_signed()
        };
        let root = initial.ca.clone();
        let m = MockHarness::start_tls(MockOptions::default(), initial)
            .await
            .unwrap();
        let mut pairing = HarnessClient::new(Origin::parse(&m.origin).unwrap(), None)
            .with_trusted_roots(if mode == 2 {
                vec![root.unwrap()]
            } else {
                vec![Identity::self_signed().leaf]
            });
        pairing
            .establish_pairing_trust(&m.control.create_pair_code())
            .await
            .unwrap();
        let code = m.control.create_pair_code();
        let credentials = pairing.redeem(&code, "Test").await.unwrap();
        let mut c = Connection::new(
            "Test".into(),
            Kind::Remote,
            Origin::parse(&m.origin).unwrap(),
            m.installation_id.clone(),
            credentials.device_id,
            "test".into(),
        );
        pairing.apply_pairing_trust(&mut c);
        if mode >= 3 {
            m.control.stage_trust(if mode == 3 {
                Identity::self_signed()
            } else {
                ca.issue()
            });
            pairing
                .refresh_trust(&mut c, &credentials.token)
                .await
                .unwrap();
        }
        let client = HarnessClient::from_connection_with_roots(
            &c,
            if mode == 2 {
                vec![ca.issue().ca.unwrap()]
            } else {
                vec![Identity::self_signed().leaf]
            },
        )
        .await
        .unwrap();
        let ticket = client
            .session_ticket(&m.installation_id, &credentials.token)
            .await
            .unwrap();
        let proxy = SpaProxy::new(&c, client).await.unwrap();
        if mode >= 3 {
            m.control.switch_trust();
        }
        let redeemed = reqwest::Client::new()
            .post(format!(
                "{}/api/v1/auth/ticket/redeem",
                proxy.origin().as_str()
            ))
            .header("user-agent", proxy.user_agent())
            .json(&json!({"ticket":ticket.ticket.expose()}))
            .send()
            .await
            .unwrap();
        assert_eq!(redeemed.status(), 200, "mode {mode}");
        assert!(!redeemed.headers().contains_key("set-cookie"));
        let mut events = request(&proxy, "/events").send().await.unwrap();
        assert_eq!(events.status(), 200);
        assert!(tokio::time::timeout(Duration::from_secs(2), events.chunk())
            .await
            .unwrap()
            .unwrap()
            .is_some());
        let mut req = format!("{}/ws", proxy.origin().as_str().replacen("http", "ws", 1))
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("user-agent", proxy.user_agent().parse().unwrap());
        req.headers_mut()
            .insert("origin", proxy.origin().as_str().parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            "trust-echo".into(),
        ))
        .await
        .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_text().unwrap(),
            "trust-echo"
        );
        ws.close(None).await.unwrap();
        proxy.retire();
    }
}

mod common;
async fn memory_open_close(dir: &std::path::Path) -> String {
    use plur1bus_desktop::{
        connections::Store,
        pair,
        secrets::{token_account, MemoryStore, TokenStore},
    };
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let tokens = MemoryStore::default();
    let store = Store::open(dir);
    let code = m.control.create_pair_code();
    let mut c = pair::pair_code(&m.origin, &code, "Scratch", &tokens, &store, None)
        .await
        .unwrap();
    let token = tokens.get(&token_account(c.id)).unwrap().unwrap();
    let ticket = pair::session_ticket(&mut c, &tokens, &store).await.unwrap();
    let proxy = SpaProxy::new(&c, HarnessClient::from_connection(&c).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        reqwest::Client::new()
            .post(format!(
                "{}/api/v1/auth/ticket/redeem",
                proxy.origin().as_str()
            ))
            .header("user-agent", proxy.user_agent())
            .json(&json!({"ticket":ticket.ticket.expose()}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        request(&proxy, "/api/v1/auth/whoami")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    proxy.retire();
    assert_eq!(
        request(&proxy, "/api/v1/auth/whoami")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    common::assert_no_token_on_disk(dir, proxy.user_agent());
    token.expose().to_owned()
}
#[tokio::test]
async fn no_cookie_database_in_app_dirs() {
    let dir = tempfile::tempdir().unwrap();
    let _ = memory_open_close(dir.path()).await;
    fn scan(dir: &std::path::Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                scan(&entry.path())
            } else {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                assert!(
                    !name.contains("cookie"),
                    "cookie database in scratch app dirs"
                );
            }
        }
    }
    scan(dir.path());
}
#[tokio::test]
async fn assert_no_token_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let token = memory_open_close(dir.path()).await;
    common::assert_no_token_on_disk(dir.path(), &token);
}

#[tokio::test]
async fn paired_proxy_overhead_p95_is_below_5ms() {
    let f = fixture(Kind::Local).await;
    request(&f.proxy, "/echo").send().await.unwrap();
    let origin = f
        .seen
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(p, _)| p == "/echo")
        .unwrap()
        .1["origin"]
        .to_str()
        .unwrap()
        .to_owned();
    let client = reqwest::Client::new();
    let mut samples = Vec::new();
    for _ in 0..100 {
        let baseline = std::time::Instant::now();
        client
            .get(format!("{origin}/echo"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let direct = baseline.elapsed();
        let started = std::time::Instant::now();
        client
            .get(format!("{}/echo", f.proxy.origin().as_str()))
            .header("user-agent", f.proxy.user_agent())
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        samples.push(started.elapsed().saturating_sub(direct).as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let p95 = samples[94];
    println!("paired100 production proxy overhead p95: {p95:.3}ms");
    assert!(p95 <= 5.0);
}

#[tokio::test]
async fn error_page_uses_saved_shell_preferences_without_inline_script() {
    use plur1bus_desktop::settings::{Locale, Settings, Theme};
    let f = fixture(Kind::Local).await;
    f.proxy.set_error_settings(Settings {
        theme: Theme::Dark,
        locale: Locale::De,
    });
    let page = request(&f.proxy, "/__shell/ticket-error")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("data-theme=\"dark\""));
    assert!(page.contains("data-locale=\"de\""));
    assert!(!page.contains("<script>"));
}

#[tokio::test]
async fn dropped_proxy_fails_closed_and_secret_is_rejected_in_external_targets() {
    let f = fixture(Kind::Local).await;
    let proxy = f.proxy.clone();
    let mut nonce = String::new();
    proxy.register_launch_secret(|s| nonce = s.into());
    assert!(proxy.has_launch_secret_in_target(&format!("https://foreign.test/?value={nonce}")));
    let encoded = format!("%{:02X}{}", nonce.as_bytes()[0], &nonce[1..]);
    assert!(proxy.has_launch_secret_in_target(&format!("https://foreign.test/?value={encoded}")));
    assert!(!proxy.has_launch_secret_in_target("https://foreign.test/"));
    let ua = proxy.user_agent().to_owned();
    let url = proxy.origin().as_str().to_owned();
    let port = proxy.port();
    drop(proxy);
    drop(f);
    assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_err());
    assert_eq!(
        reqwest::Client::new()
            .get(url)
            .header("user-agent", ua)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
}

#[tokio::test]
async fn csp_nonce_hash_are_preserved_and_foreign_reporting_is_removed() {
    let f = fixture(Kind::Local).await;
    let response = request(&f.proxy, "/csp").send().await.unwrap();
    let policies = response
        .headers()
        .get_all("content-security-policy")
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(policies.len(), 2);
    assert!(policies[0].contains("'nonce-kept'"));
    assert!(policies[0].contains("'sha256-kept'"));
    assert!(!policies[0].to_lowercase().contains("report-uri"));
    assert!(!policies[0].contains("report-to"));
    assert!(!response.headers().contains_key("report-to"));
    assert!(!response.headers().contains_key("reporting-endpoints"));
    assert!(!response.headers().contains_key("nel"));
    assert!(policies[1].contains("frame-src 'none'"));
    assert!(policies[1].contains("default-src 'none'"));
}
