//! Check-then-connect (transport choice spec §2 T7, §9.2): every HTTP, SSE and WebSocket request of an open goes to
//! exactly the addresses the check classified. The fake resolver answers A (the mock harness on 127.0.0.1) at check
//! time and B (a second listener on [::1], or 127.0.0.2, same port) afterwards; B must never see a connection, and
//! nothing may resolve the host a second time.
use futures_util::{future::BoxFuture, SinkExt, StreamExt};
use plur1bus_desktop::{
    client::HarnessClient,
    connections::Store,
    events::EventStream,
    pair,
    secrets::{self, MemoryStore},
    spa_proxy::SpaProxy,
    transport::{
        check_target, CheckDeps, ConnectPin, HostInput, ProbeOutcome, Prober, Purpose,
        ResolveError, Resolver, TailscaleSource, TailscaleStatus, TargetInput, Transport,
    },
};
use plur1bus_mock_harness::{tls::Identity, MockHandle, MockHarness, MockOptions};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// Answers `first` until flipped, `later` afterwards, and counts every lookup.
struct Switch {
    first: Vec<SocketAddr>,
    later: Vec<SocketAddr>,
    flipped: AtomicBool,
    calls: AtomicUsize,
}

impl Resolver for Switch {
    fn lookup<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let answer = if self.flipped.load(Ordering::SeqCst) {
            self.later.clone()
        } else {
            self.first.clone()
        };
        Box::pin(async move { Ok(answer) })
    }
}

struct NotInstalled;
impl TailscaleSource for NotInstalled {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        Box::pin(async { TailscaleStatus::NotInstalled })
    }
}

struct NoProbe;
impl Prober for NoProbe {
    fn probe<'a>(&'a self, _addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        panic!("a direct private target is never probed")
    }
}

/// A listener that only counts the connections it accepts.
struct Decoy {
    addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Decoy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The mock harness on 127.0.0.1:P under the name `harness.test`, and the decoy on another loopback address, port P.
async fn a_and_b() -> (MockHandle, u16, Decoy) {
    for _ in 0..20 {
        let mock = MockHarness::start_tls(
            MockOptions {
                bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
                ..Default::default()
            },
            Identity::self_signed(),
        )
        .await
        .unwrap();
        let port = url::Url::parse(&mock.origin).unwrap().port().unwrap();
        // B on the IPv6 loopback, or (a host without it) on 127.0.0.2, which Windows and Linux route to loopback.
        let mut decoy = None;
        for ip in [
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)),
        ] {
            if let Ok(listener) = tokio::net::TcpListener::bind(SocketAddr::new(ip, port)).await {
                decoy = Some(listener);
                break;
            }
        }
        let Some(listener) = decoy else {
            continue;
        };
        let b = listener.local_addr().unwrap();
        mock.control
            .set_origin(&format!("https://harness.test:{port}"));
        let accepted = Arc::new(AtomicUsize::new(0));
        let seen = accepted.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                seen.fetch_add(1, Ordering::SeqCst);
                drop(stream);
            }
        });
        return (
            mock,
            port,
            Decoy {
                addr: b,
                accepted,
                task,
            },
        );
    }
    panic!("no port free on both loopback families");
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("transport pin test exceeded 60s")
}

#[tokio::test]
async fn every_request_of_an_open_reaches_the_checked_address_only() {
    bounded(async {
        let (mock, port, decoy) = a_and_b().await;
        let origin = format!("https://harness.test:{port}");
        let a = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let b = decoy.addr;
        let resolver = Arc::new(Switch {
            first: vec![a],
            later: vec![b],
            flipped: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
        });
        let deps = CheckDeps {
            resolver: resolver.clone(),
            tailscale: Arc::new(NotInstalled),
            prober: Arc::new(NoProbe),
        };
        let input = TargetInput {
            host: HostInput::parse("harness.test").unwrap(),
            port,
            transport: Transport::Direct,
            purpose: Purpose::Remote,
        };
        let checked = check_target(&input, &deps, false).await.unwrap();
        assert_eq!(
            checked.pin,
            ConnectPin {
                host: "harness.test".into(),
                addrs: vec![a]
            }
        );
        // From here on the name points elsewhere: only the pin may be used.
        resolver.flipped.store(true, Ordering::SeqCst);

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path());
        let tokens = MemoryStore::default();
        let mut connection = pair::pair_code_pinned(
            &origin,
            &mock.control.create_pair_code(),
            "Pinned",
            &tokens,
            &store,
            None,
            Some(checked.pin.clone()),
        )
        .await
        .unwrap();
        pair::validate_connection_pinned(&mut connection, &tokens, &store, Some(&checked.pin))
            .await
            .unwrap();
        let ticket =
            pair::session_ticket_pinned(&mut connection, &tokens, &store, Some(&checked.pin))
                .await
                .unwrap();

        // SPA: HTTP and WebSocket through the proxy's pinned client.
        let client = HarnessClient::from_connection_pinned(&connection, Some(checked.pin.clone()))
            .await
            .unwrap();
        assert_eq!(client.pin(), Some(&checked.pin));
        let proxy = SpaProxy::new(&connection, client.clone()).await.unwrap();
        let browser = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();
        let redeemed = browser
            .post(format!(
                "{}/api/v1/auth/ticket/redeem",
                proxy.origin().as_str()
            ))
            .header("user-agent", proxy.user_agent())
            .header("origin", proxy.origin().as_str())
            .json(&serde_json::json!({"ticket": ticket.ticket.expose()}))
            .send()
            .await
            .unwrap();
        assert_eq!(redeemed.status(), 200);
        let page = browser
            .get(proxy.origin().as_str())
            .header("user-agent", proxy.user_agent())
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200);
        let mut ws = format!("{}/ws", proxy.origin().as_str().replacen("http", "ws", 1))
            .into_client_request()
            .unwrap();
        ws.headers_mut()
            .insert("user-agent", proxy.user_agent().parse().unwrap());
        ws.headers_mut()
            .insert("origin", proxy.origin().as_str().parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(ws).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text("echo".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "echo"
        );
        socket.close(None).await.unwrap();

        // The native WebSocket path itself, with the device token.
        let token = secrets::load_token_or_pairing_needed(&tokens, connection.id).unwrap();
        let mut bridge = format!("wss://harness.test:{port}/ws")
            .into_client_request()
            .unwrap();
        bridge.headers_mut().insert(
            "authorization",
            format!("Bearer {}", token.expose()).parse().unwrap(),
        );
        let (bridge, _) = client.websocket_connect(bridge).await.unwrap();
        drop(bridge);
        // A request for another host is refused before any connection.
        assert!(client
            .websocket_connect("wss://other.test/ws")
            .await
            .is_err());

        // SSE: the native status stream until its first update.
        mock.control.set_status("ready", "unlocked");
        let (stop, receiver) = tokio::sync::watch::channel(false);
        let mut stream = EventStream::default();
        let mut updates = Vec::new();
        let run = stream.run(
            &client,
            &connection.installation_id,
            &token,
            receiver,
            |u| {
                updates.push(u);
                if u.connected {
                    let _ = stop.send(true);
                }
            },
        );
        tokio::time::timeout(Duration::from_secs(20), run)
            .await
            .unwrap();
        assert!(updates.iter().any(|u| u.connected));
        proxy.retire();

        assert!(mock.control.accepted_connections() > 0);
        assert_eq!(
            decoy.accepted.load(Ordering::SeqCst),
            0,
            "B saw a connection"
        );
        assert_eq!(
            resolver.calls.load(Ordering::SeqCst),
            1,
            "the host was resolved again"
        );
        let routes: Vec<String> = mock
            .control
            .recorded_requests()
            .into_iter()
            .map(|(route, _)| route)
            .collect();
        for route in ["/api/v1/meta", "/api/v1/auth/whoami", "/events"] {
            assert!(
                routes.iter().any(|r| r.starts_with(route)),
                "{route} missing: {routes:?}"
            );
        }
    })
    .await;
}

#[tokio::test]
async fn a_pin_for_another_host_fails_closed() {
    bounded(async {
        let (mock, port, decoy) = a_and_b().await;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path());
        let tokens = MemoryStore::default();
        let wrong = ConnectPin {
            host: "elsewhere.test".into(),
            addrs: vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)],
        };
        let paired = pair::pair_code_pinned(
            &format!("https://harness.test:{port}"),
            &mock.control.create_pair_code(),
            "Wrong pin",
            &tokens,
            &store,
            None,
            Some(wrong),
        )
        .await;
        assert!(paired.is_err());
        assert_eq!(mock.control.accepted_connections(), 0);
        assert_eq!(decoy.accepted.load(Ordering::SeqCst), 0);
    })
    .await;
}
