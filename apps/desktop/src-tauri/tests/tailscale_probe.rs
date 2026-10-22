//! The TCP reachability probe (transport choice spec §5.2 step 5; package T3) against loopback listeners, and its
//! comparison with this device's Tailscale addresses inside `check_target`. The Tailscale status is a fake.
use futures_util::future::BoxFuture;
use plur1bus_desktop::transport::{
    check_target, CheckDeps, HostInput, PeerView, ProbeOutcome, Prober, Purpose, ResolveError,
    Resolver, TailnetView, TailscaleSource, TailscaleStatus, TargetInput, TcpProber, Transport,
    PROBE_ADDRESSES, PROBE_TIMEOUT,
};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, TcpListener};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct NoResolver;

impl Resolver for NoResolver {
    fn lookup<'a>(
        &'a self,
        _host: &'a str,
        _port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        panic!("a name matched to a peer must not be resolved")
    }
}

struct Fixed(TailscaleStatus);

impl TailscaleSource for Fixed {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        let status = self.0.clone();
        Box::pin(async move { status })
    }
}

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

/// The tailnet address of the `nas` peer. Package T4 probes only a matched peer's tailnet addresses, so the real
/// `TcpProber` reaches the loopback listener through [`LoopbackRelay`], which connects to 127.0.0.1 on the same port.
const NAS: &str = "100.101.102.103";

/// Runs the real [`TcpProber`] against 127.0.0.1 on each asked address's port (a loopback listener stands in for the
/// tailnet path) and records what `check_target` asked it to probe.
#[derive(Default)]
struct LoopbackRelay(std::sync::Mutex<Vec<Vec<SocketAddr>>>);

impl Prober for LoopbackRelay {
    fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        self.0.lock().unwrap().push(addrs.to_vec());
        Box::pin(async move {
            let relayed: Vec<SocketAddr> = addrs
                .iter()
                .map(|a| SocketAddr::new(ip("127.0.0.1"), a.port()))
                .collect();
            match TcpProber::default().probe(&relayed).await {
                ProbeOutcome::Connected { local, remote } => ProbeOutcome::Connected {
                    local,
                    remote: addrs[relayed.iter().position(|r| *r == remote).unwrap()],
                },
                other => other,
            }
        })
    }
}

/// A tailnet whose `nas` peer is [`NAS`].
fn loopback_tailnet(self_ips: &[&str]) -> TailscaleStatus {
    TailscaleStatus::Running(TailnetView {
        self_ips: self_ips.iter().map(|s| ip(s)).collect(),
        self_dns_name: "workstation.example.ts.net.".into(),
        magic_suffix: Some("example.ts.net".into()),
        peers: vec![PeerView {
            dns_name: "nas.example.ts.net.".into(),
            host_name: "nas-host".into(),
            ips: vec![ip(NAS)],
            online: true,
            expired: false,
            routes: vec![],
        }],
    })
}

fn deps(status: TailscaleStatus) -> CheckDeps {
    deps_with(status, Arc::new(LoopbackRelay::default()))
}

fn deps_with(status: TailscaleStatus, prober: Arc<LoopbackRelay>) -> CheckDeps {
    CheckDeps {
        resolver: Arc::new(NoResolver),
        tailscale: Arc::new(Fixed(status)),
        prober,
    }
}

fn target(port: u16) -> TargetInput {
    TargetInput {
        host: HostInput::parse("nas.example.ts.net").unwrap(),
        port,
        transport: Transport::Tailscale,
        purpose: Purpose::Ssh,
    }
}

fn codes(report: &plur1bus_desktop::transport::TransportReport) -> Vec<&'static str> {
    report.hints.iter().map(|h| h.code).collect()
}

fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

#[test]
fn limits_are_the_spec_values() {
    assert_eq!(PROBE_TIMEOUT, Duration::from_secs(3));
    assert_eq!(PROBE_ADDRESSES, 4);
}

#[tokio::test]
async fn connect_reports_local_and_remote_and_sends_nothing() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let remote = listener.local_addr().unwrap();
    let outcome = TcpProber::default().probe(&[remote]).await;
    let ProbeOutcome::Connected { local, remote: got } = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(got, remote);
    assert_eq!(local.ip(), ip("127.0.0.1"));
    // The probe closed its socket at once and wrote no byte: the accepted stream reads EOF.
    let (mut accepted, peer) = listener.accept().unwrap();
    assert_eq!(peer, local);
    accepted
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut buf = Vec::new();
    accepted.read_to_end(&mut buf).unwrap();
    assert!(buf.is_empty());
}

#[tokio::test]
async fn self_ip_loopback_is_ok_and_another_self_ip_is_route_mismatch() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = Arc::new(LoopbackRelay::default());
    let checked = check_target(
        &target(port),
        &deps_with(loopback_tailnet(&["127.0.0.1"]), relay.clone()),
        true,
    )
    .await
    .unwrap();
    assert_eq!(codes(&checked.report), vec!["tailscale-ok"]);
    // Only the peer's tailnet address was probed.
    assert_eq!(
        *relay.0.lock().unwrap(),
        vec![vec![SocketAddr::new(ip(NAS), port)]]
    );
    let checked = check_target(
        &target(port),
        &deps(loopback_tailnet(&["100.64.0.9"])),
        true,
    )
    .await
    .unwrap();
    assert_eq!(codes(&checked.report), vec!["tailscale-route-mismatch"]);
    drop(listener);
}

#[tokio::test]
async fn closed_port_is_refused_and_unreachable() {
    let port = closed_port();
    let addr = SocketAddr::new(ip("127.0.0.1"), port);
    assert_eq!(
        TcpProber::default().probe(&[addr]).await,
        ProbeOutcome::Refused
    );
    let checked = check_target(&target(port), &deps(loopback_tailnet(&["127.0.0.1"])), true)
        .await
        .unwrap();
    assert_eq!(codes(&checked.report), vec!["tailscale-unreachable"]);
}

#[tokio::test]
async fn unroutable_documentation_address_times_out_within_three_and_a_half_seconds() {
    let addr = SocketAddr::new(ip("192.0.2.1"), 9);
    let start = Instant::now();
    let outcome = TcpProber::default().probe(&[addr]).await;
    let took = start.elapsed();
    assert_eq!(outcome, ProbeOutcome::Timeout);
    assert!(took < Duration::from_millis(3_500), "{took:?}");
}

#[tokio::test]
async fn tries_at_most_four_addresses_in_order_and_stops_at_the_first_connect() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let open = listener.local_addr().unwrap();
    let closed: Vec<SocketAddr> = (0..4)
        .map(|_| SocketAddr::new(ip("127.0.0.1"), closed_port()))
        .collect();
    // The open address fifth: never tried.
    let mut addrs = closed.clone();
    addrs.push(open);
    assert_eq!(
        TcpProber::default().probe(&addrs).await,
        ProbeOutcome::Refused
    );
    // The open address second: connected, the rest not tried.
    let addrs = vec![closed[0], open, closed[1]];
    assert!(matches!(
        TcpProber::default().probe(&addrs).await,
        ProbeOutcome::Connected { remote, .. } if remote == open
    ));
    // Nothing to probe is not a success.
    assert_eq!(TcpProber::default().probe(&[]).await, ProbeOutcome::Refused);
}
