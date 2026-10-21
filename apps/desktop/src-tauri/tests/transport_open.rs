//! Opening a remote connection (transport choice spec §7.1, §9.2, package T4): no TCP connection to a public target
//! before the person confirmed, a target that became public needs a new confirmation, a reconnect re-checks and stops
//! on a worse category, the session-only confirmation of a read-only store, the acknowledgement invariants, the
//! superseded check and the log lines of a check. The flows mirror `pair_code`, `open_connection` and the events loop
//! over the same library calls; the mock harness counts every TCP connection it accepts.
use futures_util::future::BoxFuture;
use plur1bus_desktop::{
    client::HarnessClient,
    connections::{Connection, Kind, Origin, Store},
    events::{transport_reconnect, EventStream, TRANSPORT_ATTENTION},
    pair,
    secrets::{self, MemoryStore},
    transport::{
        parse_status, CheckDeps, ConnectPin, HostInput, LogSink, ProbeOutcome, Prober, PublicAck,
        Purpose, Recheck, ResolveError, Resolver, StoreMode, TailscaleSource, TailscaleStatus,
        TargetInput, Transport, TransportEntry, TransportError, TransportReport, TransportStore,
        Transports,
    },
    tray::{Badge, Language, TrayState},
};
use plur1bus_mock_harness::{tls::Identity, MockHandle, MockHarness, MockOptions};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Answers whatever the test set last, counts lookups; `None` is NXDOMAIN, an empty answer never resolves.
struct Scripted {
    answer: Mutex<Option<Vec<SocketAddr>>>,
    timeout: std::sync::atomic::AtomicBool,
    hang: std::sync::atomic::AtomicBool,
    calls: AtomicUsize,
}

impl Scripted {
    fn new(answer: Vec<SocketAddr>) -> Arc<Self> {
        Arc::new(Self {
            answer: Mutex::new(Some(answer)),
            timeout: Default::default(),
            hang: Default::default(),
            calls: AtomicUsize::new(0),
        })
    }
    fn set(&self, answer: Option<Vec<SocketAddr>>) {
        *self.answer.lock().unwrap() = answer;
    }
}

impl Resolver for Scripted {
    fn lookup<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            // Held while `hang` is set.
            while self.hang.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let timeout = self.timeout.load(Ordering::SeqCst);
            let answer = self.answer.lock().unwrap().clone();
            if timeout {
                return Err(ResolveError::Timeout);
            }
            answer.ok_or(ResolveError::NotFound)
        })
    }
}

struct Fixed(TailscaleStatus);
impl TailscaleSource for Fixed {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        let status = self.0.clone();
        Box::pin(async move { status })
    }
}

/// Connects from this device's tailnet address (`running.json` Self).
struct FromTailnet;
impl Prober for FromTailnet {
    fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        let remote = addrs[0];
        Box::pin(async move {
            ProbeOutcome::Connected {
                local: "100.90.0.1:50000".parse().unwrap(),
                remote,
            }
        })
    }
}

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<String>>>);
impl Capture {
    fn sink(&self) -> LogSink {
        let lines = self.0.clone();
        Arc::new(move |line: &str| lines.lock().unwrap().push(line.to_owned()))
    }
    fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

const PUBLIC: Ipv4Addr = Ipv4Addr::new(9, 9, 9, 9);

struct Fixture {
    mock: MockHandle,
    port: u16,
    resolver: Arc<Scripted>,
    transports: Transports,
    log: Capture,
    dir: tempfile::TempDir,
    store: Store,
    tokens: MemoryStore,
}

impl Fixture {
    async fn new() -> Self {
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
        mock.control
            .set_origin(&format!("https://harness.test:{port}"));
        let resolver = Scripted::new(vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)]);
        let log = Capture::default();
        let transports = Transports::new(
            CheckDeps {
                resolver: resolver.clone(),
                tailscale: Arc::new(Fixed(TailscaleStatus::NotInstalled)),
                prober: Arc::new(FromTailnet),
            },
            log.sink(),
        );
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path());
        Self {
            mock,
            port,
            resolver,
            transports,
            log,
            dir,
            store,
            tokens: MemoryStore::default(),
        }
    }
    fn a(&self) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.port)
    }
    fn public(&self) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(PUBLIC), self.port)
    }
    fn tstore(&self) -> TransportStore {
        TransportStore::open(self.dir.path())
    }
    /// `pair_code`: check and gate first, then pair over the checked addresses, then record the path.
    async fn pair(&self, transport: Transport, public_ack: bool) -> Result<Connection, String> {
        let origin = Origin::parse(&format!("https://harness.test:{}", self.port)).unwrap();
        let checked = self
            .transports
            .check_pair(&origin, transport, public_ack)
            .await
            .map_err(|e| e.code().to_owned())?;
        let row = pair::pair_code_pinned(
            origin.as_str(),
            &self.mock.control.create_pair_code(),
            "Remote desk",
            &self.tokens,
            &self.store,
            None,
            Some(checked.pin.clone()),
        )
        .await
        .map_err(|e| e.public_message())?;
        let _ = self
            .transports
            .record_pairing(&self.tstore(), &row, transport, &checked.report);
        Ok(row)
    }
    /// `open_connection`: its gate (`Transports::open_check`, the production call) before any harness contact, then
    /// validate and issue a ticket pinned.
    async fn open(&self, row: &mut Connection) -> Result<ConnectPin, String> {
        let (listed, checked) = self
            .transports
            .open_check(&self.store, &self.tstore(), row.id)
            .await?;
        assert_eq!(listed.origin, row.origin);
        let (checked, _) = checked.expect("a remote row is checked");
        pair::validate_connection_pinned(row, &self.tokens, &self.store, Some(&checked.pin))
            .await
            .map_err(|e| e.public_message())?;
        pair::session_ticket_pinned(row, &self.tokens, &self.store, Some(&checked.pin))
            .await
            .map_err(|e| e.public_message())?;
        Ok(checked.pin)
    }
    async fn report_for(&self, row: &Connection, transport: Transport) -> serde_json::Value {
        let (host, port) = HostInput::from_origin(&row.origin).unwrap();
        let input = TargetInput {
            host,
            port,
            transport,
            purpose: Purpose::Remote,
        };
        let tstore = self.tstore();
        let report = self
            .transports
            .check_input(&input, Some((&tstore, row)))
            .await
            .unwrap();
        serde_json::to_value(report).unwrap()
    }
}

fn codes(report: &serde_json::Value) -> Vec<String> {
    report["hints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["code"].as_str().unwrap().to_owned())
        .collect()
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("transport open test exceeded 60s")
}

#[tokio::test]
async fn a_public_target_without_confirmation_gets_no_tcp_connection() {
    bounded(async {
        let f = Fixture::new().await;
        let mut row = f.pair(Transport::Direct, false).await.unwrap();
        // A connection made before this feature: no sidecar entry, derived default „Direkt“ (spec §3.2, Q-T2).
        f.tstore().remove(row.id).unwrap();
        assert_eq!(f.tstore().get(row.id), None);
        // The mock comes first: without the gate the client would connect to it.
        f.resolver.set(Some(vec![f.a(), f.public()]));
        let before = f.mock.control.accepted_connections();
        assert_eq!(
            f.open(&mut row).await.unwrap_err(),
            "transport-confirm-needed"
        );
        assert_eq!(
            f.mock.control.accepted_connections(),
            before,
            "a public target was contacted"
        );
        let report = f.report_for(&row, Transport::Direct).await;
        assert_eq!(codes(&report), ["target-mixed"]);
        assert_eq!(report["needsPublicAck"], true);
        assert_eq!(
            report["addresses"],
            serde_json::json!(["127.0.0.1", "9.9.9.9"])
        );
        // Only public: the same.
        f.resolver.set(Some(vec![f.public()]));
        assert_eq!(
            f.open(&mut row).await.unwrap_err(),
            "transport-confirm-needed"
        );
        assert_eq!(
            codes(&f.report_for(&row, Transport::Direct).await),
            ["target-public"]
        );
        assert_eq!(f.mock.control.accepted_connections(), before);

        // *Bestätigen und verbinden*: the confirmation is stored for the public target, then the open goes ahead
        // over exactly the checked addresses.
        f.resolver.set(Some(vec![f.a(), f.public()]));
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Direct, true)
            .await
            .unwrap();
        let stored = f.tstore().get(row.id).unwrap();
        assert_eq!(stored.transport, Transport::Direct);
        assert_eq!(
            stored.public_ack.unwrap().classifier,
            "iana-special-2025-10-09"
        );
        let view = f.transports.view(&f.tstore(), &row);
        assert!(view.public_ack && !view.store_read_only);
        let pin = f.open(&mut row).await.unwrap();
        assert_eq!(pin.addrs, vec![f.a(), f.public()]);
        assert!(f.mock.control.accepted_connections() > before);
    })
    .await;
}

#[tokio::test]
async fn a_target_private_at_add_and_public_at_open_needs_a_new_confirmation() {
    bounded(async {
        let f = Fixture::new().await;
        let mut row = f.pair(Transport::Direct, false).await.unwrap();
        let entry = f.tstore().get(row.id).unwrap();
        assert_eq!(
            (entry.transport, entry.public_ack),
            (Transport::Direct, None)
        );
        f.open(&mut row).await.unwrap();
        f.resolver.set(Some(vec![f.a(), f.public()]));
        let before = f.mock.control.accepted_connections();
        assert_eq!(
            f.open(&mut row).await.unwrap_err(),
            "transport-confirm-needed"
        );
        assert_eq!(f.mock.control.accepted_connections(), before);
        let report = f.report_for(&row, Transport::Direct).await;
        assert_eq!(codes(&report), ["target-changed-public"]);
        assert_eq!(report["hints"][0]["params"]["host"], "harness.test");
        assert_eq!(
            f.transports.recheck(&f.tstore(), &row, false).await,
            Recheck::Attention("target-changed-public")
        );
        // A path the person is choosing anew is not "changed": it gets the plain public text.
        assert_eq!(
            codes(&f.report_for(&row, Transport::Tailscale).await),
            [
                "target-mixed",
                "tailscale-not-installed",
                "tailscale-not-tailnet-target"
            ]
        );
        let lines = f.log.lines();
        assert!(
            lines.iter().any(|l| l.starts_with(
                "TRANSPORT_CHECK purpose=open category=public codes=target-changed-public"
            ) && l.ends_with("result=transport-confirm-needed")),
            "{lines:?}"
        );
    })
    .await;
}

#[tokio::test]
async fn a_reconnect_re_checks_and_stops_when_the_target_turned_public() {
    bounded(async {
        let f = Fixture::new().await;
        let mut row = f.pair(Transport::Direct, false).await.unwrap();
        let pin = f.open(&mut row).await.unwrap();
        let client = HarnessClient::from_connection_pinned(&row, Some(pin))
            .await
            .unwrap();
        let token = secrets::load_token_or_pairing_needed(&f.tokens, row.id).unwrap();
        f.mock.control.set_status("ready", "unlocked");

        // Round 1: the stream drops, the fresh check is still private: reconnect over its addresses.
        // Round 2: the stream drops again, the name now points to a public address: stop, flag attention.
        let connected = AtomicUsize::new(0);
        let accepted_at_drop = Mutex::new(0u64);
        let attention = Mutex::new(None);
        let tray = Mutex::new(TrayState::default());
        let lookups_before = f.resolver.calls.load(Ordering::SeqCst);
        let (_stop, receiver) = tokio::sync::watch::channel(false);
        let earlier = std::sync::atomic::AtomicBool::new(true);
        let (fr, row_ref, client_ref, attention_ref, tray_ref, earlier_ref) =
            (&f, &row, &client, &attention, &tray, &earlier);
        let mut stream = EventStream::default();
        let run = stream.run_checked_with_timing(
            &client,
            &row.installation_id,
            &token,
            receiver,
            |update| {
                if update.connected && update.state == plur1bus_desktop::tray::HarnessState::Ready {
                    let round = connected.fetch_add(1, Ordering::SeqCst) + 1;
                    if round == 2 {
                        f.resolver.set(Some(vec![f.a(), f.public()]));
                    }
                    *accepted_at_drop.lock().unwrap() = f.mock.control.accepted_connections();
                    f.mock.control.drop_sse();
                }
                std::future::ready(())
            },
            || 0.5,
            |_| std::future::ready(()),
            // The production decision of `native::recheck_events`; native only shows its outcome.
            move || async move {
                let (next, outcome) = transport_reconnect(
                    &fr.transports,
                    &fr.tstore(),
                    row_ref,
                    client_ref,
                    earlier_ref,
                )
                .await;
                if let Some(outcome) = outcome {
                    outcome.apply(&mut tray_ref.lock().unwrap());
                    if let Some(event) = outcome.event() {
                        *attention_ref.lock().unwrap() = Some(event);
                    }
                }
                next
            },
        );
        tokio::time::timeout(Duration::from_secs(30), run)
            .await
            .unwrap();
        assert_eq!(connected.load(Ordering::SeqCst), 2);
        assert_eq!(
            *attention.lock().unwrap(),
            Some(serde_json::json!({ "id": row.id, "code": "target-changed-public" }))
        );
        assert_eq!(TRANSPORT_ATTENTION, "transport-attention");
        assert_eq!(
            f.mock.control.accepted_connections(),
            *accepted_at_drop.lock().unwrap(),
            "the stopped reconnect opened a connection"
        );
        assert_eq!(f.resolver.calls.load(Ordering::SeqCst), lookups_before + 2);
        let tray = tray.lock().unwrap().clone();
        assert_eq!(tray.badge(), Badge::Attention);
        assert!(Language::De
            .status(&tray, "Remote desk")
            .contains("· direkt, öffentlich"));
    })
    .await;
}

#[tokio::test]
async fn a_read_only_store_holds_the_confirmation_for_the_session_only() {
    bounded(async {
        let f = Fixture::new().await;
        let mut row = f.pair(Transport::Direct, false).await.unwrap();
        let sidecar = f.dir.path().join("connection-transport.json");
        std::fs::write(&sidecar, br#"{"version":2,"connections":{}}"#).unwrap();
        let bytes = std::fs::read(&sidecar).unwrap();
        assert_eq!(f.tstore().mode(), StoreMode::ReadOnlyNewer);
        f.resolver.set(Some(vec![f.a(), f.public()]));
        assert_eq!(
            f.open(&mut row).await.unwrap_err(),
            "transport-confirm-needed"
        );
        let view = f.transports.view(&f.tstore(), &row);
        assert!(!view.public_ack && view.store_read_only);
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Direct, true)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&sidecar).unwrap(),
            bytes,
            "a read-only store was written"
        );
        let view = f.transports.view(&f.tstore(), &row);
        assert!(view.public_ack && view.store_read_only);
        f.open(&mut row).await.unwrap();
        // A path change cannot be kept and is refused; the session confirmation stays for the unchanged path.
        assert_eq!(
            f.transports
                .set_transport(&f.tstore(), &row, Transport::Tailscale, true)
                .await
                .unwrap_err(),
            "transport-store-readonly"
        );
        f.open(&mut row).await.unwrap();
        // The next app session (a new state) asks again.
        let restarted = Transports::new(
            CheckDeps {
                resolver: f.resolver.clone(),
                tailscale: Arc::new(Fixed(TailscaleStatus::NotInstalled)),
                prober: Arc::new(FromTailnet),
            },
            Capture::default().sink(),
        );
        assert_eq!(
            restarted
                .check_open(&f.tstore(), &row, "open", false)
                .await
                .unwrap_err(),
            TransportError::ConfirmNeeded
        );
    })
    .await;
}

#[tokio::test]
async fn a_confirmation_is_stored_only_for_a_public_target_and_a_change_clears_it() {
    bounded(async {
        let f = Fixture::new().await;
        let row = f.pair(Transport::Direct, false).await.unwrap();
        let ack = |f: &Fixture| f.tstore().get(row.id).and_then(|e| e.public_ack);
        // Private now: a ticked box stores nothing.
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Direct, true)
            .await
            .unwrap();
        assert_eq!(ack(&f), None);
        f.resolver.set(Some(vec![f.public()]));
        let before = f.tstore().get(row.id);
        assert_eq!(
            f.transports
                .set_transport(&f.tstore(), &row, Transport::Direct, false)
                .await
                .unwrap_err(),
            "transport-confirm-needed"
        );
        assert_eq!(
            f.tstore().get(row.id),
            before,
            "a refused change was written"
        );
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Direct, true)
            .await
            .unwrap();
        let first = ack(&f).unwrap();
        // The same path again keeps the valid confirmation.
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Direct, false)
            .await
            .unwrap();
        assert_eq!(ack(&f), Some(first.clone()));
        // A transport change clears it: without a new confirmation the change is refused.
        assert_eq!(
            f.transports
                .set_transport(&f.tstore(), &row, Transport::Tailscale, false)
                .await
                .unwrap_err(),
            "transport-confirm-needed"
        );
        assert_eq!(f.tstore().get(row.id).unwrap().transport, Transport::Direct);
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Tailscale, true)
            .await
            .unwrap();
        let entry = f.tstore().get(row.id).unwrap();
        assert_eq!(entry.transport, Transport::Tailscale);
        assert!(entry.public_ack.is_some());
        // Private again: the confirmation goes; public later means "changed".
        f.resolver.set(Some(vec![f.a()]));
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Tailscale, false)
            .await
            .unwrap();
        assert_eq!(ack(&f), None);
        f.resolver.set(Some(vec![f.public()]));
        assert_eq!(
            f.transports.recheck(&f.tstore(), &row, false).await,
            Recheck::Attention("target-changed-public")
        );
        // A confirmation under another classifier snapshot counts as none, and the target was public then.
        let mut old = TransportEntry::new(Transport::Tailscale);
        old.public_ack = Some(PublicAck {
            at_ms: 1,
            classifier: "iana-special-2020-01-01".into(),
        });
        f.tstore().set(row.id, old).unwrap();
        assert_eq!(
            f.transports.recheck(&f.tstore(), &row, false).await,
            Recheck::Attention("transport-confirm-needed")
        );
        assert!(!f.transports.view(&f.tstore(), &row).public_ack);
    })
    .await;
}

#[tokio::test]
async fn an_unresolved_name_is_a_notice_when_adding_and_an_error_when_connecting() {
    bounded(async {
        let f = Fixture::new().await;
        let mut row = f.pair(Transport::Direct, false).await.unwrap();
        let origin = Origin::parse(&format!("https://harness.test:{}", f.port)).unwrap();
        let (host, port) = HostInput::from_origin(&origin).unwrap();
        let input = TargetInput {
            host,
            port,
            transport: Transport::Direct,
            purpose: Purpose::Remote,
        };
        for (code, timeout) in [("target-unresolved", false), ("target-dns-timeout", true)] {
            f.resolver.set(None);
            f.resolver.timeout.store(timeout, Ordering::SeqCst);
            let report =
                serde_json::to_value(f.transports.check_input(&input, None).await.unwrap())
                    .unwrap();
            assert_eq!(report["category"], serde_json::Value::Null);
            assert_eq!(report["hints"][0]["code"], code);
            assert_eq!(report["hints"][0]["severity"], "notice");
            assert_eq!(report["hints"][0]["params"]["host"], "harness.test");
            assert_eq!(
                f.transports
                    .check_pair(&origin, Transport::Direct, false)
                    .await
                    .unwrap_err()
                    .code(),
                code
            );
            assert_eq!(f.open(&mut row).await.unwrap_err(), code);
            assert_eq!(
                f.transports.recheck(&f.tstore(), &row, false).await,
                Recheck::Retry
            );
        }
    })
    .await;
}

#[tokio::test]
async fn a_newer_check_supersedes_the_older_one_of_the_same_window() {
    bounded(async {
        let f = Fixture::new().await;
        let input = |name: &str| TargetInput {
            host: HostInput::parse(name).unwrap(),
            port: 443,
            transport: Transport::Direct,
            purpose: Purpose::Remote,
        };
        let slow = input("slow.harness.test");
        let fast = input("fast.harness.test");
        f.resolver.hang.store(true, Ordering::SeqCst);
        let older = f
            .transports
            .check_for_window("shell", f.transports.check_input(&slow, None));
        let newer = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            f.resolver.hang.store(false, Ordering::SeqCst);
            f.transports
                .check_for_window("shell", f.transports.check_input(&fast, None))
                .await
        };
        let other = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            f.transports
                .check_for_window("other", f.transports.check_input(&fast, None))
                .await
        };
        let (older, newer, other) = tokio::join!(older, newer, other);
        let older = older.unwrap_err();
        assert_eq!(older, TransportError::Busy);
        assert_eq!(older.code(), "transport-check-busy");
        assert!(newer.is_ok());
        assert!(other.is_ok(), "another window does not supersede");
    })
    .await;
}

/// Every name, user, address and identifier of `running.json`, the matched peer's included: a log line carries the
/// category and codes only (spec §9.4).
const TAILNET_DATA: &[&str] = &[
    "nas",
    "workstation",
    "laptop",
    "router",
    "-host",
    "alice",
    "bob",
    "Alice",
    "Bob",
    "example",
    "100.",
    "fd7a",
    "192.168",
    "peer-nas",
    "peer-laptop",
    "peer-router",
    "self-node",
    "1001",
    "1002",
    "macOS",
    "linux",
    "windows",
    "synthetic",
    "ts.net",
];

#[tokio::test]
async fn the_log_lines_of_checks_and_opens_carry_no_tailnet_data() {
    bounded(async {
        let log = Capture::default();
        // A tailnet address no peer has: names that are not matched by name resolve to it.
        let resolver = Scripted::new(vec!["100.101.102.200:443".parse().unwrap()]);
        let transports = Transports::new(
            CheckDeps {
                resolver,
                tailscale: Arc::new(Fixed(parse_status(
                    true,
                    include_bytes!("fixtures/tailscale/running.json"),
                ))),
                prober: Arc::new(FromTailnet),
            },
            log.sink(),
        );
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path());
        let tstore = TransportStore::open(dir.path());
        let row = Connection::new(
            "NAS".into(),
            Kind::Remote,
            Origin::parse("https://nas.example.ts.net:8443").unwrap(),
            "installation".into(),
            "device".into(),
            "hint".into(),
        );
        store.upsert(row.clone()).unwrap();
        tstore
            .set(row.id, TransportEntry::new(Transport::Tailscale))
            .unwrap();
        for (host, transport) in [
            ("nas.example.ts.net", Transport::Tailscale),
            ("nas", Transport::Tailscale),
            ("100.101.102.103", Transport::Direct),
            ("laptop.corp.example", Transport::Direct),
            ("router.example.ts.net", Transport::Direct),
            ("unknown.example.ts.net", Transport::Tailscale),
        ] {
            let input = TargetInput {
                host: HostInput::parse(host).unwrap(),
                port: 8443,
                transport,
                purpose: Purpose::Remote,
            };
            transports.check_input(&input, None).await.unwrap();
        }
        transports
            .check_pair(&row.origin, Transport::Tailscale, false)
            .await
            .unwrap();
        let opened = transports
            .check_open(&tstore, &row, "open", false)
            .await
            .unwrap();
        assert_eq!(
            opened.report.tailscale.as_ref().map(|t| t.state),
            Some("tailscale-ok")
        );
        assert!(matches!(
            transports.recheck(&tstore, &row, true).await,
            Recheck::Pinned(_)
        ));
        transports
            .set_transport(&tstore, &row, Transport::Tailscale, false)
            .await
            .unwrap();
        let lines = log.lines();
        assert_eq!(lines.len(), 10, "{lines:?}");
        for line in &lines {
            assert!(line.starts_with("TRANSPORT_CHECK purpose="), "{line}");
            for data in TAILNET_DATA {
                assert!(!line.contains(data), "{data} logged: {line}");
            }
        }
        assert!(
            lines.iter().any(|l| l.contains("tailscale=tailscale-ok")),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|l| l.contains("codes=tailscale-peer-unknown")),
            "{lines:?}"
        );
    })
    .await;
}

/// Records every address it is asked to probe. A loopback address gets a real TCP connect (so the mock harness counts
/// it); any other answers as connected from this device's tailnet address without touching the network.
#[derive(Clone, Default)]
struct Recording(Arc<Mutex<Vec<Vec<SocketAddr>>>>);
impl Prober for Recording {
    fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        self.0.lock().unwrap().push(addrs.to_vec());
        Box::pin(async move {
            for addr in addrs {
                if addr.ip().is_loopback() {
                    let _ = tokio::net::TcpStream::connect(addr).await;
                }
            }
            ProbeOutcome::Connected {
                local: "100.90.0.1:50000".parse().unwrap(),
                remote: addrs[0],
            }
        })
    }
}
impl Recording {
    fn seen(&self) -> Vec<Vec<SocketAddr>> {
        self.0.lock().unwrap().clone()
    }
}

/// A row of `connections.json` for the mock under `harness.test`, never paired (so the mock counts nothing yet).
struct ProbeFixture {
    mock: MockHandle,
    port: u16,
    transports: Transports,
    prober: Recording,
    dir: tempfile::TempDir,
    store: Store,
    row: Connection,
}

async fn probe_fixture(status: &[u8], answer: impl Fn(u16) -> Vec<SocketAddr>) -> ProbeFixture {
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
    let prober = Recording::default();
    let transports = Transports::new(
        CheckDeps {
            resolver: Scripted::new(answer(port)),
            tailscale: Arc::new(Fixed(parse_status(true, status))),
            prober: Arc::new(prober.clone()),
        },
        Capture::default().sink(),
    );
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let row = Connection::new(
        "Remote desk".into(),
        Kind::Remote,
        Origin::parse(&format!("https://harness.test:{port}")).unwrap(),
        "installation".into(),
        "device".into(),
        "hint".into(),
    );
    store.upsert(row.clone()).unwrap();
    ProbeFixture {
        mock,
        port,
        transports,
        prober,
        dir,
        store,
        row,
    }
}

impl ProbeFixture {
    fn tstore(&self) -> TransportStore {
        TransportStore::open(self.dir.path())
    }
    async fn panel(&self, transport: Transport) -> TransportReport {
        let (host, port) = HostInput::from_origin(&self.row.origin).unwrap();
        let input = TargetInput {
            host,
            port,
            transport,
            purpose: Purpose::Remote,
        };
        let tstore = self.tstore();
        self.transports
            .check_for_window(
                "shell",
                self.transports
                    .check_input(&input, Some((&tstore, &self.row))),
            )
            .await
            .unwrap()
    }
}

/// Review Important 1: a mixed answer [mock, public, online peer] must not get a probe to the public (or any
/// non-tailnet) address, neither before the confirmation (no probe at all) nor after it (only the peer's tailnet
/// address) — for the open gate, the reconnect re-check and the check panel.
#[tokio::test]
async fn the_probe_never_connects_to_a_public_or_non_tailnet_address() {
    bounded(async {
        let peer = |port| SocketAddr::new("100.101.102.103".parse().unwrap(), port);
        let f = probe_fixture(include_bytes!("fixtures/tailscale/running.json"), |port| {
            vec![
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                SocketAddr::new(IpAddr::V4(PUBLIC), port),
                peer(port),
            ]
        })
        .await;
        // Before the confirmation: refused, and nothing probed.
        assert_eq!(
            f.transports
                .open_check(&f.store, &f.tstore(), f.row.id)
                .await
                .unwrap_err(),
            "transport-confirm-needed"
        );
        assert_eq!(
            f.transports
                .recheck_shared(&f.tstore(), &f.row, false)
                .await,
            Recheck::Attention("transport-confirm-needed")
        );
        let panel = f.panel(Transport::Direct).await;
        assert!(panel.needs_public_ack);
        assert_eq!(
            panel.tailscale.as_ref().map(|t| t.state),
            Some("tailscale-peer-online"),
            "unprobed: nothing claims reachability"
        );
        assert_eq!(f.prober.seen(), Vec::<Vec<SocketAddr>>::new());
        assert_eq!(f.mock.control.accepted_connections(), 0);

        // After the confirmation: only the matched peer's tailnet address is probed.
        f.transports
            .set_transport(&f.tstore(), &f.row, Transport::Direct, true)
            .await
            .unwrap();
        let (_, opened) = f
            .transports
            .open_check(&f.store, &f.tstore(), f.row.id)
            .await
            .unwrap();
        let (checked, _) = opened.unwrap();
        assert_eq!(
            checked.report.tailscale.as_ref().map(|t| t.state),
            Some("tailscale-ok")
        );
        assert_eq!(checked.pin.addrs.len(), 3, "the connect set is unchanged");
        assert!(matches!(
            f.transports
                .recheck_shared(&f.tstore(), &f.row, false)
                .await,
            Recheck::Pinned(_)
        ));
        let panel = f.panel(Transport::Direct).await;
        assert_eq!(
            panel.tailscale.as_ref().map(|t| t.state),
            Some("tailscale-ok")
        );
        let seen = f.prober.seen();
        assert_eq!(seen, vec![vec![peer(f.port)]; 3]);
        assert_eq!(f.mock.control.accepted_connections(), 0);
        // A path the person is choosing anew has no confirmation yet: no probe.
        let fresh = f.panel(Transport::Tailscale).await;
        assert!(fresh.needs_public_ack);
        assert_eq!(f.prober.seen().len(), 3);
    })
    .await;
}

/// The subnet-route variant: only the private addresses inside the matched router's route are probed.
#[tokio::test]
async fn a_subnet_route_probe_touches_only_the_private_addresses_inside_the_route() {
    bounded(async {
        let routed = |port| SocketAddr::new("192.168.10.5".parse().unwrap(), port);
        let f = probe_fixture(
            include_bytes!("fixtures/tailscale/subnet-router.json"),
            |port| vec![SocketAddr::new(IpAddr::V4(PUBLIC), port), routed(port)],
        )
        .await;
        f.tstore()
            .set(f.row.id, TransportEntry::new(Transport::Tailscale))
            .unwrap();
        assert_eq!(
            f.transports
                .open_check(&f.store, &f.tstore(), f.row.id)
                .await
                .unwrap_err(),
            "transport-confirm-needed"
        );
        f.panel(Transport::Tailscale).await;
        assert_eq!(f.prober.seen(), Vec::<Vec<SocketAddr>>::new());
        f.transports
            .set_transport(&f.tstore(), &f.row, Transport::Tailscale, true)
            .await
            .unwrap();
        let (_, opened) = f
            .transports
            .open_check(&f.store, &f.tstore(), f.row.id)
            .await
            .unwrap();
        assert_eq!(
            opened.unwrap().0.report.tailscale.unwrap().state,
            "tailscale-subnet-route"
        );
        assert_eq!(f.prober.seen(), vec![vec![routed(f.port)]]);
    })
    .await;
}

/// Spec §5.4: the status and trust streams share one re-check per connection.
#[tokio::test]
async fn concurrent_reconnects_share_one_re_check() {
    bounded(async {
        let f = Fixture::new().await;
        let row = f.pair(Transport::Direct, false).await.unwrap();
        let before = f.resolver.calls.load(Ordering::SeqCst);
        // The status stream's re-check is in flight (its lookup held); the trust stream's arrives meanwhile.
        f.resolver.hang.store(true, Ordering::SeqCst);
        let tstore = f.tstore();
        let first = f.transports.recheck_shared(&tstore, &row, true);
        let second = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            f.transports.recheck_shared(&f.tstore(), &row, true).await
        };
        let release = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(f.resolver.calls.load(Ordering::SeqCst), before + 1);
            f.resolver.hang.store(false, Ordering::SeqCst);
        };
        let (first, second, ()) = tokio::join!(first, second, release);
        assert!(matches!(first, Recheck::Pinned(_)));
        assert_eq!(first, second, "the second waiter takes the first's result");
        assert_eq!(f.resolver.calls.load(Ordering::SeqCst), before + 1);
        // Two callers at the same time: one lookup, one result for both.
        f.resolver.hang.store(true, Ordering::SeqCst);
        let (a, b, ()) = tokio::join!(
            f.transports.recheck_shared(&tstore, &row, true),
            f.transports.recheck_shared(&tstore, &row, true),
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                f.resolver.hang.store(false, Ordering::SeqCst);
            }
        );
        assert_eq!(a, b);
        assert_eq!(f.resolver.calls.load(Ordering::SeqCst), before + 2);
        // The next reconnect checks again.
        f.transports.recheck_shared(&f.tstore(), &row, true).await;
        assert_eq!(f.resolver.calls.load(Ordering::SeqCst), before + 3);
    })
    .await;
}

/// Review Minor 2: a name that does not resolve keeps an unchanged path's entry (and its confirmation) as it is.
#[tokio::test]
async fn an_unresolved_set_keeps_the_confirmation_of_an_unchanged_path() {
    bounded(async {
        let f = Fixture::new().await;
        let row = f.pair(Transport::Direct, false).await.unwrap();
        f.resolver.set(Some(vec![f.public()]));
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Direct, true)
            .await
            .unwrap();
        let confirmed = f.tstore().get(row.id).unwrap();
        assert!(confirmed.public_ack.is_some());
        for timeout in [false, true] {
            f.resolver.set(None);
            f.resolver.timeout.store(timeout, Ordering::SeqCst);
            let report = f
                .transports
                .set_transport(&f.tstore(), &row, Transport::Direct, false)
                .await
                .unwrap();
            assert_eq!(report.category, None);
            assert_eq!(
                f.tstore().get(row.id),
                Some(confirmed.clone()),
                "unchanged path rewritten"
            );
        }
        // A changed path is stored, without a confirmation.
        f.transports
            .set_transport(&f.tstore(), &row, Transport::Tailscale, false)
            .await
            .unwrap();
        let entry = f.tstore().get(row.id).unwrap();
        assert_eq!(
            (entry.transport, entry.public_ack),
            (Transport::Tailscale, None)
        );
    })
    .await;
}
