//! Matching a target against the tailnet view and the Tailscale part of `check_target` (transport choice spec §5.1,
//! §5.2 step 4, §5.3; package T3). Fakes only: no DNS, no Tailscale, no sockets.
use futures_util::future::BoxFuture;
use plur1bus_desktop::transport::{
    cgnat_candidate, check_target, match_target, parse_status, Category, CheckDeps, CheckedTarget,
    HostInput, PeerMatch, ProbeOutcome, Prober, Purpose, ResolveError, Resolver, Severity,
    TailnetView, TailscaleSource, TailscaleStatus, TailscaleView, TargetInput, Transport,
    TransportReport, UnavailableWhy,
};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const RUNNING: &[u8] = include_bytes!("fixtures/tailscale/running.json");
const PEER_OFFLINE: &[u8] = include_bytes!("fixtures/tailscale/peer-offline.json");
const PEER_EXPIRED: &[u8] = include_bytes!("fixtures/tailscale/peer-expired.json");
const SUBNET_ROUTER: &[u8] = include_bytes!("fixtures/tailscale/subnet-router.json");
const NO_MAGICDNS: &[u8] = include_bytes!("fixtures/tailscale/no-magicdns.json");

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

fn view(doc: &[u8]) -> TailnetView {
    match parse_status(true, doc) {
        TailscaleStatus::Running(view) => view,
        other => panic!("not running: {other:?}"),
    }
}

fn host(s: &str) -> HostInput {
    HostInput::parse(s).unwrap()
}

fn peer(label: &str, ips: &[&str], online: bool) -> PeerMatch {
    PeerMatch::Peer {
        label: label.into(),
        ips: ips.iter().map(|s| ip(s)).collect(),
        online,
    }
}

#[test]
fn ts_net_name_matches_with_trailing_dot_and_any_case() {
    let v = view(RUNNING);
    let nas = peer("nas", &["100.101.102.103", "fd7a:115c:a1e0::65"], true);
    assert_eq!(match_target(&v, &host("nas.example.ts.net."), &[]), nas);
    assert_eq!(match_target(&v, &host("NAS.Example.TS.net"), &[]), nas);
    // A hand-built upper-case name (bypassing the parser's lower-casing) matches too.
    let raw = HostInput::Name("NAS.EXAMPLE.TS.NET.".into());
    assert_eq!(match_target(&v, &raw, &[]), nas);
    // Another tailnet's name is not this peer.
    assert_eq!(
        match_target(&v, &host("nas.other.ts.net"), &[]),
        PeerMatch::None
    );
}

#[test]
fn short_name_matches_the_first_dns_label() {
    let v = view(RUNNING);
    assert_eq!(
        match_target(&v, &host("nas"), &[]),
        peer("nas", &["100.101.102.103", "fd7a:115c:a1e0::65"], true)
    );
    assert_eq!(
        match_target(&v, &host("LAPTOP"), &[]),
        peer("laptop", &["100.101.102.104", "fd7a:115c:a1e0::66"], true)
    );
    // The OS host name is not a match key, and a multi-label non-ts.net name is never matched by name.
    assert_eq!(match_target(&v, &host("nas-host"), &[]), PeerMatch::None);
    assert_eq!(
        match_target(&v, &host("nas.corp.example"), &[]),
        PeerMatch::None
    );
}

#[test]
fn address_matches_peer_then_self_then_subnet_route() {
    let v = view(RUNNING);
    let nas = peer("nas", &["100.101.102.103", "fd7a:115c:a1e0::65"], true);
    let h = host("100.101.102.103");
    assert_eq!(match_target(&v, &h, &[ip("100.101.102.103")]), nas);
    // IPv4-mapped is the IPv4 host.
    assert_eq!(
        match_target(
            &v,
            &host("::ffff:100.101.102.103"),
            &[ip("::ffff:100.101.102.103")]
        ),
        nas
    );
    assert_eq!(match_target(&v, &h, &[ip("fd7a:115c:a1e0::65")]), nas);
    assert_eq!(
        match_target(&v, &host("100.90.0.1"), &[ip("100.90.0.1")]),
        PeerMatch::SelfNode
    );
    let s = view(SUBNET_ROUTER);
    assert_eq!(
        match_target(&s, &host("192.168.10.5"), &[ip("192.168.10.5")]),
        PeerMatch::SubnetRoute {
            label: "router".into(),
            online: true
        }
    );
    // An offline router's route does not count.
    assert_eq!(
        match_target(&s, &host("192.168.20.5"), &[ip("192.168.20.5")]),
        PeerMatch::None
    );
    // A resolved name falls back to its addresses.
    assert_eq!(
        match_target(
            &v,
            &host("nas.corp.example"),
            &[ip("10.0.0.1"), ip("100.101.102.103")]
        ),
        nas
    );
}

#[test]
fn cgnat_address_without_peer_is_none_and_flags_the_cgnat_text() {
    let v = view(RUNNING);
    let addrs = [ip("100.70.0.1")];
    assert_eq!(
        match_target(&v, &host("100.70.0.1"), &addrs),
        PeerMatch::None
    );
    assert!(cgnat_candidate(&addrs));
    assert!(cgnat_candidate(&[ip("::ffff:100.70.0.1")]));
    // The Tailscale IPv6 range and NAT64 carrying 100.64/10 are not carrier-grade NAT.
    assert!(!cgnat_candidate(&[ip("fd7a:115c:a1e0::9")]));
    assert!(!cgnat_candidate(&[ip("64:ff9b::6446:1")]));
    assert!(!cgnat_candidate(&[ip("10.0.0.1")]));
}

#[test]
fn offline_or_expired_peer_matches_with_online_false() {
    let v = view(PEER_OFFLINE);
    assert_eq!(
        match_target(&v, &host("nas.example.ts.net"), &[]),
        peer("nas", &["100.101.102.103", "fd7a:115c:a1e0::65"], false)
    );
    let v = view(PEER_EXPIRED);
    assert_eq!(
        match_target(&v, &host("100.101.102.103"), &[ip("100.101.102.103")]),
        peer("nas", &["100.101.102.103"], false)
    );
}

// ---- check_target wiring ----------------------------------------------------------------------------------------

#[derive(Default)]
struct FakeResolver {
    answers: HashMap<String, Vec<SocketAddr>>,
    calls: Mutex<Vec<String>>,
}

impl Resolver for FakeResolver {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
        _port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        self.calls.lock().unwrap().push(host.into());
        let answer = self
            .answers
            .get(host)
            .cloned()
            .ok_or(ResolveError::NotFound);
        Box::pin(async move { answer })
    }
}

struct FakeTailscale {
    status: TailscaleStatus,
    calls: AtomicUsize,
}

impl TailscaleSource for FakeTailscale {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let status = self.status.clone();
        Box::pin(async move { status })
    }
}

struct FakeProber {
    outcome: ProbeOutcome,
    calls: Mutex<Vec<Vec<SocketAddr>>>,
}

impl Prober for FakeProber {
    fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        self.calls.lock().unwrap().push(addrs.to_vec());
        let outcome = self.outcome;
        Box::pin(async move { outcome })
    }
}

struct Harness {
    resolver: Arc<FakeResolver>,
    tailscale: Arc<FakeTailscale>,
    prober: Arc<FakeProber>,
    deps: CheckDeps,
}

fn harness(status: TailscaleStatus, answers: &[(&str, &[&str])], outcome: ProbeOutcome) -> Harness {
    let resolver = Arc::new(FakeResolver {
        answers: answers
            .iter()
            .map(|(h, a)| {
                (
                    h.to_string(),
                    a.iter().map(|s| SocketAddr::new(ip(s), 1)).collect(),
                )
            })
            .collect(),
        ..FakeResolver::default()
    });
    let tailscale = Arc::new(FakeTailscale {
        status,
        calls: AtomicUsize::new(0),
    });
    let prober = Arc::new(FakeProber {
        outcome,
        calls: Mutex::new(Vec::new()),
    });
    let deps = CheckDeps {
        resolver: resolver.clone(),
        tailscale: tailscale.clone(),
        prober: prober.clone(),
    };
    Harness {
        resolver,
        tailscale,
        prober,
        deps,
    }
}

const PORT: u16 = 7443;

fn sock(s: &str) -> SocketAddr {
    SocketAddr::new(ip(s), PORT)
}

fn target(h: &str, transport: Transport, purpose: Purpose) -> TargetInput {
    TargetInput {
        host: host(h),
        port: PORT,
        transport,
        purpose,
    }
}

async fn run(h: &Harness, t: &TargetInput, probe: bool) -> CheckedTarget {
    check_target(t, &h.deps, probe).await.unwrap()
}

fn codes(report: &TransportReport) -> Vec<&'static str> {
    report.hints.iter().map(|h| h.code).collect()
}

fn param<'a>(report: &'a TransportReport, code: &str, key: &str) -> Option<&'a str> {
    report
        .hints
        .iter()
        .find(|h| h.code == code)
        .and_then(|h| h.params.get(key))
        .map(String::as_str)
}

fn connected(local: &str) -> ProbeOutcome {
    ProbeOutcome::Connected {
        local: SocketAddr::new(ip(local), 50000),
        remote: sock("100.101.102.103"),
    }
}

#[tokio::test]
async fn ts_net_name_match_uses_the_peer_ips_and_never_the_resolver() {
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[("nas.example.ts.net", &["203.0.113.9"])],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("nas.example.ts.net", Transport::Tailscale, Purpose::Remote),
        true,
    )
    .await;
    assert!(h.resolver.calls.lock().unwrap().is_empty());
    assert_eq!(
        checked.pin.addrs,
        vec![sock("100.101.102.103"), sock("fd7a:115c:a1e0::65")]
    );
    assert_eq!(checked.pin.host, "nas.example.ts.net");
    assert_eq!(checked.report.category, Some(Category::Tailnet));
    assert_eq!(codes(&checked.report), vec!["tailscale-ok"]);
    assert_eq!(checked.report.hints[0].severity, Severity::Info);
    assert_eq!(param(&checked.report, "tailscale-ok", "peer"), Some("nas"));
    assert_eq!(
        checked.report.tailscale,
        Some(TailscaleView {
            state: "tailscale-ok",
            peer: Some("nas".into()),
            online: Some(true)
        })
    );
    // The probe got the connect set.
    assert_eq!(
        *h.prober.calls.lock().unwrap(),
        vec![vec![sock("100.101.102.103"), sock("fd7a:115c:a1e0::65")]]
    );
    assert_eq!(h.tailscale.calls.load(Ordering::SeqCst), 1);
    // The direct path with a *.ts.net name runs the check as well (spec §5.1) and skips the resolver the same way.
    let checked = run(
        &h,
        &target("nas.example.ts.net.", Transport::Direct, Purpose::Ssh),
        true,
    )
    .await;
    assert!(h.resolver.calls.lock().unwrap().is_empty());
    assert_eq!(checked.pin.host, "nas.example.ts.net.");
    assert_eq!(codes(&checked.report), vec!["tailscale-ok"]);
}

#[tokio::test]
async fn short_name_match_on_the_tailscale_path_skips_the_resolver_and_suggests_the_full_name() {
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("nas", Transport::Tailscale, Purpose::Remote),
        true,
    )
    .await;
    assert!(h.resolver.calls.lock().unwrap().is_empty());
    assert_eq!(
        checked.pin.addrs,
        vec![sock("100.101.102.103"), sock("fd7a:115c:a1e0::65")]
    );
    assert_eq!(
        codes(&checked.report),
        vec!["tailscale-ok", "tailscale-short-name"]
    );
    let hint = checked
        .report
        .hints
        .iter()
        .find(|h| h.code == "tailscale-short-name")
        .unwrap();
    assert_eq!(hint.severity, Severity::Info);
    assert_eq!(
        param(&checked.report, "tailscale-short-name", "suggestion"),
        Some("nas.example.ts.net")
    );
    // SSH needs no full name.
    let checked = run(&h, &target("nas", Transport::Tailscale, Purpose::Ssh), true).await;
    assert_eq!(codes(&checked.report), vec!["tailscale-ok"]);
}

#[tokio::test]
async fn without_magicdns_a_short_name_is_never_name_matched_and_goes_to_the_resolver() {
    let v = view(NO_MAGICDNS);
    assert_eq!(match_target(&v, &host("nas"), &[]), PeerMatch::None);
    let h = harness(
        TailscaleStatus::Running(v),
        &[("nas", &["100.101.102.103"])],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("nas", Transport::Tailscale, Purpose::Remote),
        true,
    )
    .await;
    assert_eq!(*h.resolver.calls.lock().unwrap(), vec!["nas".to_string()]);
    // The resolver's tailnet answer still finds the peer by address, but an address match suggests no name.
    assert_eq!(codes(&checked.report), vec!["tailscale-ok"]);
}

#[test]
fn a_short_name_matches_only_inside_the_own_magicdns_suffix() {
    let mut v = view(RUNNING);
    let mut shared = v.peers[0].clone();
    shared.dns_name = "printer.other-tailnet.ts.net.".into();
    shared.ips = vec![ip("100.101.102.199")];
    v.peers.push(shared);
    // Same first label, other suffix: no short-name match, but the full name matches.
    assert_eq!(match_target(&v, &host("printer"), &[]), PeerMatch::None);
    assert_eq!(
        match_target(&v, &host("printer.other-tailnet.ts.net"), &[]),
        peer("printer", &["100.101.102.199"], true)
    );
    // With a `nas` in another tailnet listed first, the short name still picks the own tailnet's `nas`.
    let mut v = view(RUNNING);
    let mut other_nas = v.peers[0].clone();
    other_nas.dns_name = "nas.other-tailnet.ts.net.".into();
    other_nas.ips = vec![ip("100.101.102.198")];
    v.peers.insert(0, other_nas);
    assert_eq!(
        match_target(&v, &host("nas"), &[]),
        peer("nas", &["100.101.102.103", "fd7a:115c:a1e0::65"], true)
    );
}

#[tokio::test]
async fn an_address_match_of_a_short_name_never_suggests_a_name() {
    // Direct + remote + `nas`, but the resolver answers the laptop's address: matched by address, no suggestion.
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[("nas", &["100.101.102.104"])],
        connected("100.90.0.1"),
    );
    let checked = run(&h, &target("nas", Transport::Direct, Purpose::Remote), true).await;
    assert_eq!(*h.resolver.calls.lock().unwrap(), vec!["nas".to_string()]);
    assert_eq!(codes(&checked.report), vec!["tailscale-ok"]);
    assert_eq!(
        checked.report.tailscale.as_ref().unwrap().peer.as_deref(),
        Some("laptop")
    );
}

#[tokio::test]
async fn own_magicdns_name_is_self_without_a_lookup() {
    let v = view(RUNNING);
    assert_eq!(
        match_target(&v, &host("workstation.example.ts.net."), &[]),
        PeerMatch::SelfNode
    );
    assert_eq!(
        match_target(&v, &host("WORKSTATION"), &[]),
        PeerMatch::SelfNode
    );
    let h = harness(TailscaleStatus::Running(v), &[], connected("100.90.0.1"));
    for name in ["workstation.example.ts.net", "workstation"] {
        let checked = run(
            &h,
            &target(name, Transport::Tailscale, Purpose::Remote),
            true,
        )
        .await;
        assert_eq!(codes(&checked.report), vec!["tailscale-self"], "{name}");
        assert_eq!(
            checked.pin.addrs,
            vec![sock("100.90.0.1"), sock("fd7a:115c:a1e0::1")]
        );
    }
    assert!(h.resolver.calls.lock().unwrap().is_empty());
    assert!(h.prober.calls.lock().unwrap().is_empty());
}

#[test]
fn an_expired_router_is_no_subnet_route() {
    let mut s = view(SUBNET_ROUTER);
    let router = s
        .peers
        .iter_mut()
        .find(|p| p.host_name == "router-host")
        .unwrap();
    router.expired = true;
    assert_eq!(
        match_target(&s, &host("192.168.10.5"), &[ip("192.168.10.5")]),
        PeerMatch::None
    );
}

#[tokio::test]
async fn direct_short_name_resolves_first_and_runs_the_check_only_for_tailnet_answers() {
    // A tailnet answer: the check runs and matches by address.
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[("nas", &["100.101.102.103"]), ("printer", &["192.168.1.9"])],
        connected("100.90.0.1"),
    );
    let checked = run(&h, &target("nas", Transport::Direct, Purpose::Ssh), true).await;
    assert_eq!(*h.resolver.calls.lock().unwrap(), vec!["nas".to_string()]);
    assert_eq!(checked.pin.addrs, vec![sock("100.101.102.103")]);
    assert_eq!(codes(&checked.report), vec!["tailscale-ok"]);
    // A private answer on the direct path never asks Tailscale.
    let checked = run(
        &h,
        &target("printer", Transport::Direct, Purpose::Ssh),
        true,
    )
    .await;
    assert!(checked.report.tailscale.is_none());
    assert!(codes(&checked.report).is_empty());
    assert_eq!(h.tailscale.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unmatched_ts_net_name_falls_back_to_the_resolver_with_peer_unknown() {
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[("ghost.example.ts.net", &["100.101.102.200"])],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target(
            "ghost.example.ts.net",
            Transport::Tailscale,
            Purpose::Remote,
        ),
        true,
    )
    .await;
    assert_eq!(
        *h.resolver.calls.lock().unwrap(),
        vec!["ghost.example.ts.net".to_string()]
    );
    assert_eq!(checked.pin.addrs, vec![sock("100.101.102.200")]);
    assert_eq!(codes(&checked.report), vec!["tailscale-peer-unknown"]);
    let hint = &checked.report.hints[0];
    assert_eq!(hint.severity, Severity::Notice);
    assert_eq!(
        hint.params.get("host").map(String::as_str),
        Some("ghost.example.ts.net")
    );
    assert_eq!(hint.params.get("note").map(String::as_str), Some("cgnat"));
    assert!(h.prober.calls.lock().unwrap().is_empty());
    assert_eq!(
        checked.report.tailscale,
        Some(TailscaleView {
            state: "tailscale-peer-unknown",
            peer: None,
            online: None
        })
    );
}

#[tokio::test]
async fn cgnat_literal_without_peer_names_cgnat_and_v6_does_not() {
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("100.70.0.1", Transport::Direct, Purpose::Ssh),
        true,
    )
    .await;
    assert_eq!(codes(&checked.report), vec!["tailscale-peer-unknown"]);
    assert_eq!(
        param(&checked.report, "tailscale-peer-unknown", "note"),
        Some("cgnat")
    );
    assert_eq!(
        param(&checked.report, "tailscale-peer-unknown", "host"),
        Some("100.70.0.1")
    );
    let checked = run(
        &h,
        &target("fd7a:115c:a1e0::99", Transport::Direct, Purpose::Ssh),
        true,
    )
    .await;
    assert_eq!(codes(&checked.report), vec!["tailscale-peer-unknown"]);
    assert_eq!(
        param(&checked.report, "tailscale-peer-unknown", "note"),
        None
    );
    assert!(h.prober.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn offline_and_expired_peers_are_peer_offline_without_a_probe() {
    for doc in [PEER_OFFLINE, PEER_EXPIRED] {
        let h = harness(
            TailscaleStatus::Running(view(doc)),
            &[],
            connected("100.90.0.1"),
        );
        let checked = run(
            &h,
            &target("nas.example.ts.net", Transport::Tailscale, Purpose::Ssh),
            true,
        )
        .await;
        assert_eq!(codes(&checked.report), vec!["tailscale-peer-offline"]);
        assert_eq!(checked.report.hints[0].severity, Severity::Notice);
        assert_eq!(
            param(&checked.report, "tailscale-peer-offline", "peer"),
            Some("nas")
        );
        assert_eq!(
            checked.report.tailscale,
            Some(TailscaleView {
                state: "tailscale-peer-offline",
                peer: Some("nas".into()),
                online: Some(false)
            })
        );
        assert!(h.prober.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn self_address_is_tailscale_self() {
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("100.90.0.1", Transport::Tailscale, Purpose::Ssh),
        true,
    )
    .await;
    assert_eq!(codes(&checked.report), vec!["tailscale-self"]);
    assert_eq!(checked.report.hints[0].severity, Severity::Info);
    assert_eq!(
        checked.report.tailscale.as_ref().unwrap().state,
        "tailscale-self"
    );
    assert!(h.prober.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn subnet_route_is_info_when_probed_through_the_tailnet_and_notice_unprobed() {
    let h = harness(
        TailscaleStatus::Running(view(SUBNET_ROUTER)),
        &[],
        connected("100.90.0.1"),
    );
    let t = target("192.168.10.5", Transport::Tailscale, Purpose::Ssh);
    let checked = run(&h, &t, true).await;
    assert_eq!(checked.report.category, Some(Category::Private));
    // Reached through the tailnet: no `tailscale-not-tailnet-target` beside it.
    assert_eq!(codes(&checked.report), vec!["tailscale-subnet-route"]);
    assert_eq!(checked.report.hints[0].severity, Severity::Info);
    assert_eq!(
        param(&checked.report, "tailscale-subnet-route", "peer"),
        Some("router")
    );
    assert_eq!(
        checked.report.tailscale,
        Some(TailscaleView {
            state: "tailscale-subnet-route",
            peer: Some("router".into()),
            online: Some(true)
        })
    );
    let checked = run(&h, &t, false).await;
    assert_eq!(checked.report.hints[0].code, "tailscale-subnet-route");
    assert_eq!(checked.report.hints[0].severity, Severity::Notice);
    assert_eq!(h.prober.calls.lock().unwrap().len(), 1);
    // A probe from a non-tailnet local address: the route is not taken.
    let h = harness(
        TailscaleStatus::Running(view(SUBNET_ROUTER)),
        &[],
        connected("192.168.10.77"),
    );
    let checked = run(&h, &t, true).await;
    assert_eq!(codes(&checked.report), vec!["tailscale-route-mismatch"]);
    assert_eq!(
        param(&checked.report, "tailscale-route-mismatch", "host"),
        Some("192.168.10.5")
    );
}

#[tokio::test]
async fn online_peer_probe_outcomes() {
    let t = target("nas.example.ts.net", Transport::Tailscale, Purpose::Ssh);
    // Refused and timed out are both unreachable, with the peer and the port.
    for outcome in [ProbeOutcome::Refused, ProbeOutcome::Timeout] {
        let h = harness(TailscaleStatus::Running(view(RUNNING)), &[], outcome);
        let checked = run(&h, &t, true).await;
        assert_eq!(codes(&checked.report), vec!["tailscale-unreachable"]);
        assert_eq!(checked.report.hints[0].severity, Severity::Notice);
        assert_eq!(
            param(&checked.report, "tailscale-unreachable", "peer"),
            Some("nas")
        );
        assert_eq!(
            param(&checked.report, "tailscale-unreachable", "port"),
            Some("7443")
        );
        assert_eq!(
            checked.report.tailscale.as_ref().unwrap().online,
            Some(true)
        );
    }
    // A local address that is not one of this device's tailnet addresses (an IPv4-mapped self address is one).
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[],
        connected("10.0.0.2"),
    );
    let checked = run(&h, &t, true).await;
    assert_eq!(codes(&checked.report), vec!["tailscale-route-mismatch"]);
    assert_eq!(
        param(&checked.report, "tailscale-route-mismatch", "host"),
        Some("nas.example.ts.net")
    );
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[],
        connected("::ffff:100.90.0.1"),
    );
    assert_eq!(codes(&run(&h, &t, true).await.report), vec!["tailscale-ok"]);
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[],
        connected("fd7a:115c:a1e0::1"),
    );
    assert_eq!(codes(&run(&h, &t, true).await.report), vec!["tailscale-ok"]);
}

#[tokio::test]
async fn without_a_probe_an_online_peer_is_never_reported_reachable() {
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("nas.example.ts.net", Transport::Tailscale, Purpose::Ssh),
        false,
    )
    .await;
    assert!(h.prober.calls.lock().unwrap().is_empty());
    assert!(
        codes(&checked.report).is_empty(),
        "{:?}",
        checked.report.hints
    );
    assert_eq!(
        checked.report.tailscale,
        Some(TailscaleView {
            state: "tailscale-peer-online",
            peer: Some("nas".into()),
            online: Some(true)
        })
    );
}

#[tokio::test]
async fn the_probe_gets_at_most_four_addresses() {
    let mut v = view(RUNNING);
    v.peers[0].ips = (1..=6).map(|i| ip(&format!("100.101.0.{i}"))).collect();
    let label = v.peers[0].dns_name.split('.').next().unwrap().to_string();
    let h = harness(TailscaleStatus::Running(v), &[], connected("100.90.0.1"));
    let checked = run(
        &h,
        &target(&label, Transport::Tailscale, Purpose::Ssh),
        true,
    )
    .await;
    assert_eq!(checked.pin.addrs.len(), 6);
    assert_eq!(h.prober.calls.lock().unwrap()[0].len(), 4);
}

#[tokio::test]
async fn non_running_states_are_their_notice_and_fall_back_to_the_resolver() {
    let cases = [
        (
            TailscaleStatus::NotInstalled,
            "tailscale-not-installed",
            None,
        ),
        (
            TailscaleStatus::Unavailable(UnavailableWhy::Timeout),
            "tailscale-check-unavailable",
            None,
        ),
        (
            TailscaleStatus::Unavailable(UnavailableWhy::Flatpak),
            "tailscale-check-unavailable",
            Some("flatpak"),
        ),
        (TailscaleStatus::DaemonDown, "tailscale-daemon-down", None),
        (TailscaleStatus::NeedsLogin, "tailscale-needs-login", None),
        (TailscaleStatus::Stopped, "tailscale-stopped", None),
    ];
    for (status, code, note) in cases {
        let h = harness(
            status,
            &[("nas.example.ts.net", &["100.101.102.103"])],
            connected("100.90.0.1"),
        );
        let checked = run(
            &h,
            &target("nas.example.ts.net", Transport::Tailscale, Purpose::Remote),
            true,
        )
        .await;
        assert_eq!(codes(&checked.report), vec![code]);
        assert_eq!(checked.report.hints[0].severity, Severity::Notice);
        assert_eq!(param(&checked.report, code, "note"), note);
        assert_eq!(
            checked.report.tailscale,
            Some(TailscaleView {
                state: code,
                peer: None,
                online: None
            })
        );
        assert_eq!(
            *h.resolver.calls.lock().unwrap(),
            vec!["nas.example.ts.net".to_string()]
        );
        assert!(h.prober.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn tailscale_path_to_a_non_tailnet_target_keeps_the_not_tailnet_hint() {
    let h = harness(
        TailscaleStatus::Running(view(RUNNING)),
        &[("vps.example", &["8.8.8.8"])],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("vps.example", Transport::Tailscale, Purpose::Remote),
        true,
    )
    .await;
    assert_eq!(
        codes(&checked.report),
        vec!["target-public", "tailscale-not-tailnet-target"]
    );
    assert_eq!(
        checked.report.tailscale,
        Some(TailscaleView {
            state: "tailscale-not-tailnet-target",
            peer: None,
            online: None
        })
    );
    assert!(h.prober.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_name_matched_peer_without_addresses_falls_back_to_the_resolver() {
    let mut v = view(RUNNING);
    v.peers.iter_mut().for_each(|p| p.ips.clear());
    let h = harness(
        TailscaleStatus::Running(v),
        &[("nas.example.ts.net", &["100.101.102.103"])],
        connected("100.90.0.1"),
    );
    let checked = run(
        &h,
        &target("nas.example.ts.net", Transport::Tailscale, Purpose::Ssh),
        true,
    )
    .await;
    assert_eq!(
        *h.resolver.calls.lock().unwrap(),
        vec!["nas.example.ts.net".to_string()]
    );
    assert_eq!(checked.pin.addrs, vec![sock("100.101.102.103")]);
}

#[tokio::test]
async fn peer_addresses_go_through_the_classifier() {
    // A forged peer list cannot smuggle an unspecified or multicast address into the pin.
    let mut v = view(RUNNING);
    v.peers[0].ips = vec![ip("0.0.0.0"), ip("ff02::1"), ip("100.101.102.103")];
    let label = v.peers[0].dns_name.trim_end_matches('.').to_string();
    let h = harness(TailscaleStatus::Running(v), &[], connected("100.90.0.1"));
    let checked = run(
        &h,
        &target(&label, Transport::Tailscale, Purpose::Ssh),
        true,
    )
    .await;
    assert_eq!(checked.pin.addrs, vec![sock("100.101.102.103")]);
    assert_eq!(codes(&checked.report)[0], "target-not-connectable");
    // A peer list of public addresses makes a public target that needs the confirmation.
    let mut v = view(RUNNING);
    v.peers[0].ips = vec![ip("8.8.8.8")];
    let label = v.peers[0].dns_name.trim_end_matches('.').to_string();
    let h = harness(TailscaleStatus::Running(v), &[], connected("100.90.0.1"));
    let checked = run(
        &h,
        &target(&label, Transport::Tailscale, Purpose::Ssh),
        true,
    )
    .await;
    assert_eq!(checked.report.category, Some(Category::Public));
    assert!(checked.report.needs_public_ack);
}
