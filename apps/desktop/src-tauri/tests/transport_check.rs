//! Target check and gate (transport choice spec §4.3, §6, §8; package T2). Every dependency is a fake: no DNS, no
//! Tailscale, no sockets.
use futures_util::future::BoxFuture;
use plur1bus_desktop::transport::{
    check_target, gate, Category, CheckDeps, HostInput, ProbeOutcome, Prober, PublicAck, Purpose,
    ResolveError, Resolver, Severity, TailscaleSource, TailscaleStatus, TargetInput, Transport,
    TransportError, TransportReport,
};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct FakeResolver {
    answers: HashMap<String, Result<Vec<SocketAddr>, ResolveError>>,
    calls: Mutex<Vec<(String, u16)>>,
}

impl FakeResolver {
    fn with(host: &str, answer: Result<Vec<&str>, ResolveError>) -> Self {
        let mut r = Self::default();
        r.answers.insert(
            host.into(),
            answer.map(|v| {
                v.into_iter()
                    .map(|a| SocketAddr::new(a.parse().unwrap(), 9))
                    .collect()
            }),
        );
        r
    }
}

impl Resolver for FakeResolver {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        self.calls.lock().unwrap().push((host.into(), port));
        let answer = self
            .answers
            .get(host)
            .cloned()
            .unwrap_or(Err(ResolveError::NotFound));
        Box::pin(async move { answer })
    }
}

#[derive(Default)]
struct FakeTailscale {
    calls: AtomicUsize,
}

impl TailscaleSource for FakeTailscale {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { TailscaleStatus::NotInstalled })
    }
}

#[derive(Default)]
struct FakeProber {
    calls: AtomicUsize,
}

impl Prober for FakeProber {
    fn probe<'a>(&'a self, _addrs: &'a [SocketAddr]) -> BoxFuture<'a, ProbeOutcome> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { ProbeOutcome::Refused })
    }
}

struct Harness {
    resolver: Arc<FakeResolver>,
    deps: CheckDeps,
}

fn harness(resolver: FakeResolver) -> Harness {
    let resolver = Arc::new(resolver);
    let deps = CheckDeps {
        resolver: resolver.clone(),
        tailscale: Arc::new(FakeTailscale::default()),
        prober: Arc::new(FakeProber::default()),
    };
    Harness { resolver, deps }
}

fn input(host: &str, transport: Transport) -> TargetInput {
    TargetInput {
        host: HostInput::parse(host).unwrap(),
        port: 7443,
        transport,
        purpose: Purpose::Remote,
    }
}

fn sock(s: &str) -> SocketAddr {
    SocketAddr::new(s.parse::<IpAddr>().unwrap(), 7443)
}

fn codes(report: &TransportReport) -> Vec<&'static str> {
    report.hints.iter().map(|h| h.code).collect()
}

async fn check(
    host: &str,
    answer: Result<Vec<&str>, ResolveError>,
    transport: Transport,
) -> (
    Harness,
    Result<plur1bus_desktop::transport::CheckedTarget, TransportError>,
) {
    let h = harness(FakeResolver::with(host, answer));
    let got = check_target(&input(host, transport), &h.deps, false).await;
    (h, got)
}

#[tokio::test]
async fn private_only_is_private_and_needs_no_ack() {
    let (h, got) = check(
        "nas.corp.example",
        Ok(vec!["10.0.0.5", "192.168.1.2"]),
        Transport::Direct,
    )
    .await;
    let checked = got.unwrap();
    assert_eq!(checked.report.category, Some(Category::Private));
    assert!(!checked.report.needs_public_ack);
    assert!(
        checked.report.hints.is_empty(),
        "{:?}",
        checked.report.hints
    );
    assert_eq!(checked.report.classifier, "iana-special-2025-10-09");
    assert_eq!(checked.pin.host, "nas.corp.example");
    assert_eq!(
        checked.pin.addrs,
        vec![sock("10.0.0.5"), sock("192.168.1.2")]
    );
    assert_eq!(checked.report.addresses, vec!["10.0.0.5", "192.168.1.2"]);
    assert_eq!(
        *h.resolver.calls.lock().unwrap(),
        vec![("nas.corp.example".to_string(), 7443)]
    );
    assert!(gate(&checked.report, None).is_ok());
}

#[tokio::test]
async fn public_only_is_target_public_and_needs_ack() {
    let (_, got) = check("vps.example", Ok(vec!["8.8.8.8"]), Transport::Direct).await;
    let checked = got.unwrap();
    assert_eq!(checked.report.category, Some(Category::Public));
    assert!(checked.report.needs_public_ack);
    assert_eq!(codes(&checked.report), vec!["target-public"]);
    let hint = &checked.report.hints[0];
    assert_eq!(hint.severity, Severity::Warning);
    assert_eq!(
        hint.params.get("host").map(String::as_str),
        Some("vps.example")
    );
    assert_eq!(
        hint.params.get("addresses").map(String::as_str),
        Some("8.8.8.8")
    );
}

#[tokio::test]
async fn private_and_public_is_target_mixed() {
    let (_, got) = check(
        "split.example",
        Ok(vec!["10.0.0.5", "2606:4700:4700::1111", "1.1.1.1"]),
        Transport::Direct,
    )
    .await;
    let checked = got.unwrap();
    assert_eq!(checked.report.category, Some(Category::Public));
    assert!(checked.report.needs_public_ack);
    assert_eq!(codes(&checked.report), vec!["target-mixed"]);
    let hint = &checked.report.hints[0];
    assert_eq!(hint.severity, Severity::Warning);
    assert_eq!(
        hint.params.get("addresses").map(String::as_str),
        Some("2606:4700:4700::1111, 1.1.1.1")
    );
}

#[tokio::test]
async fn unspecified_only_is_not_connectable() {
    let (_, got) = check("zero.example", Ok(vec!["0.0.0.0"]), Transport::Direct).await;
    let err = got.unwrap_err();
    assert_eq!(err, TransportError::NotConnectable);
    assert_eq!(err.code(), "target-not-connectable");
    // An unspecified literal is not connectable either, without a lookup.
    let h = harness(FakeResolver::default());
    let got = check_target(&input("0.0.0.0", Transport::Direct), &h.deps, false).await;
    assert_eq!(got.unwrap_err(), TransportError::NotConnectable);
    for literal in ["::", "224.0.0.1", "ff02::1", "255.255.255.255"] {
        let got = check_target(&input(literal, Transport::Direct), &h.deps, false).await;
        assert_eq!(
            got.unwrap_err(),
            TransportError::NotConnectable,
            "{literal}"
        );
    }
    assert!(h.resolver.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unspecified_plus_private_drops_the_unspecified_address() {
    let (_, got) = check(
        "half.example",
        Ok(vec!["0.0.0.0", "10.0.0.5"]),
        Transport::Direct,
    )
    .await;
    let checked = got.unwrap();
    assert_eq!(checked.report.category, Some(Category::Private));
    assert!(!checked.report.needs_public_ack);
    assert_eq!(codes(&checked.report), vec!["target-not-connectable"]);
    let hint = &checked.report.hints[0];
    assert_eq!(hint.severity, Severity::Notice);
    assert_eq!(
        hint.params.get("address").map(String::as_str),
        Some("0.0.0.0")
    );
    assert_eq!(checked.pin.addrs, vec![sock("10.0.0.5")]);
    assert_eq!(checked.report.addresses, vec!["10.0.0.5"]);
}

#[tokio::test]
async fn documentation_range_is_target_special() {
    let (_, got) = check(
        "doc.example",
        Ok(vec!["192.0.2.10", "10.0.0.1"]),
        Transport::Direct,
    )
    .await;
    let checked = got.unwrap();
    assert_eq!(checked.report.category, Some(Category::Special));
    assert!(!checked.report.needs_public_ack);
    assert_eq!(codes(&checked.report), vec!["target-special"]);
    let hint = &checked.report.hints[0];
    assert_eq!(hint.severity, Severity::Notice);
    assert_eq!(
        hint.params.get("address").map(String::as_str),
        Some("192.0.2.10")
    );
    // A special address next to a public one keeps its notice; the target is public.
    let (_, got) = check(
        "doc2.example",
        Ok(vec!["2001:db8::1", "8.8.8.8"]),
        Transport::Direct,
    )
    .await;
    let checked = got.unwrap();
    assert_eq!(checked.report.category, Some(Category::Public));
    assert_eq!(
        codes(&checked.report),
        vec!["target-mixed", "target-special"]
    );
}

#[tokio::test]
async fn resolver_timeout_is_target_dns_timeout() {
    let (_, got) = check(
        "slow.example",
        Err(ResolveError::Timeout),
        Transport::Direct,
    )
    .await;
    let err = got.unwrap_err();
    assert_eq!(err, TransportError::DnsTimeout);
    assert_eq!(err.code(), "target-dns-timeout");
}

#[tokio::test]
async fn nxdomain_and_empty_answers_are_target_unresolved() {
    let (_, got) = check(
        "gone.example",
        Err(ResolveError::NotFound),
        Transport::Direct,
    )
    .await;
    let err = got.unwrap_err();
    assert_eq!(err, TransportError::Unresolved);
    assert_eq!(err.code(), "target-unresolved");
    let (_, got) = check("empty.example", Ok(vec![]), Transport::Direct).await;
    assert_eq!(got.unwrap_err(), TransportError::Unresolved);
}

#[tokio::test]
async fn localhost_makes_no_resolver_call() {
    let h = harness(FakeResolver::default());
    let checked = check_target(&input("localhost", Transport::Direct), &h.deps, false)
        .await
        .unwrap();
    assert!(h.resolver.calls.lock().unwrap().is_empty());
    assert_eq!(checked.report.category, Some(Category::Loopback));
    assert_eq!(checked.pin.host, "localhost");
    assert_eq!(checked.pin.addrs, vec![sock("127.0.0.1"), sock("::1")]);
    assert!(checked.report.hints.is_empty());
}

#[tokio::test]
async fn ip_literal_makes_no_resolver_call() {
    let h = harness(FakeResolver::default());
    for (literal, category) in [
        ("10.1.2.3", Category::Private),
        ("[::1]", Category::Loopback),
        ("100.101.102.103", Category::Tailnet),
        ("8.8.4.4", Category::Public),
    ] {
        let checked = check_target(&input(literal, Transport::Direct), &h.deps, false)
            .await
            .unwrap();
        assert_eq!(checked.report.category, Some(category), "{literal}");
        assert_eq!(checked.pin.addrs.len(), 1, "{literal}");
        assert_eq!(checked.pin.addrs[0].port(), 7443);
    }
    assert!(h.resolver.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pin_addrs_equal_the_classified_set_exactly() {
    // Duplicates collapse (order kept), not-connectable addresses drop out, the port is the target's.
    let (_, got) = check(
        "many.example",
        Ok(vec![
            "10.0.0.5",
            "0.0.0.0",
            "10.0.0.5",
            "fd00::7",
            "ff02::1",
            "192.168.1.2",
            "::ffff:10.0.0.9",
        ]),
        Transport::Direct,
    )
    .await;
    let checked = got.unwrap();
    assert_eq!(
        checked.pin.addrs,
        vec![
            sock("10.0.0.5"),
            sock("fd00::7"),
            sock("192.168.1.2"),
            sock("::ffff:10.0.0.9"),
        ]
    );
    // The banner shows the addresses canonically (the mapped address as its IPv4 host).
    assert_eq!(
        checked.report.addresses,
        vec!["10.0.0.5", "fd00::7", "192.168.1.2", "10.0.0.9"]
    );
    let dropped = &checked.report.hints[0];
    assert_eq!(dropped.code, "target-not-connectable");
    assert_eq!(
        dropped.params.get("addresses").map(String::as_str),
        Some("0.0.0.0, ff02::1")
    );
}

#[tokio::test]
async fn at_most_32_addresses_are_used_and_8_reported() {
    let many: Vec<String> = (1..=40).map(|i| format!("10.0.0.{i}")).collect();
    let (_, got) = check(
        "big.example",
        Ok(many.iter().map(String::as_str).collect()),
        Transport::Direct,
    )
    .await;
    let checked = got.unwrap();
    assert_eq!(checked.pin.addrs.len(), 32);
    assert_eq!(checked.pin.addrs[31], sock("10.0.0.32"));
    assert_eq!(checked.report.addresses.len(), 8);
}

#[tokio::test]
async fn tailscale_with_a_public_target_reports_both_codes() {
    let (_, got) = check("vps.example", Ok(vec!["8.8.8.8"]), Transport::Tailscale).await;
    let checked = got.unwrap();
    assert!(checked.report.needs_public_ack);
    let mut got = codes(&checked.report);
    got.sort_unstable();
    assert_eq!(got, vec!["tailscale-not-tailnet-target", "target-public"]);
    let hint = checked
        .report
        .hints
        .iter()
        .find(|h| h.code == "tailscale-not-tailnet-target")
        .unwrap();
    assert_eq!(hint.severity, Severity::Notice);
    assert_eq!(
        hint.params.get("host").map(String::as_str),
        Some("vps.example")
    );
}

#[tokio::test]
async fn tailscale_hint_only_when_neither_ts_net_name_nor_tailnet_address() {
    // A tailnet address, a *.ts.net name and the direct path carry no such hint.
    let (_, got) = check("nas", Ok(vec!["100.101.102.103"]), Transport::Tailscale).await;
    assert!(codes(&got.unwrap().report).is_empty());
    let (_, got) = check(
        "nas.tail1234.ts.net",
        Ok(vec!["8.8.8.8"]),
        Transport::Tailscale,
    )
    .await;
    assert_eq!(codes(&got.unwrap().report), vec!["target-public"]);
    let (_, got) = check(
        "nas.corp.example",
        Ok(vec!["10.0.0.5"]),
        Transport::Tailscale,
    )
    .await;
    assert_eq!(
        codes(&got.unwrap().report),
        vec!["tailscale-not-tailnet-target"]
    );
    let (_, got) = check("vps.example", Ok(vec!["8.8.8.8"]), Transport::Direct).await;
    assert_eq!(codes(&got.unwrap().report), vec!["target-public"]);
}

fn ack() -> PublicAck {
    PublicAck::now()
}

#[tokio::test]
async fn gate_requires_an_ack_only_for_public_targets() {
    let (_, got) = check("vps.example", Ok(vec!["8.8.8.8"]), Transport::Direct).await;
    let public = got.unwrap().report;
    let err = gate(&public, None).unwrap_err();
    assert_eq!(err, TransportError::ConfirmNeeded);
    assert_eq!(err.code(), "transport-confirm-needed");
    // Ack given and the target still public: the confirmation stays valid.
    assert!(gate(&public, Some(&ack())).is_ok());
    // A non-public target never needs one; an ack does not hurt.
    let (_, got) = check("nas.corp.example", Ok(vec!["10.0.0.5"]), Transport::Direct).await;
    let private = got.unwrap().report;
    assert!(gate(&private, None).is_ok());
    assert!(gate(&private, Some(&ack())).is_ok());
}

#[test]
fn public_ack_carries_time_and_classifier_but_no_address() {
    let a = PublicAck::now();
    assert_eq!(a.classifier, "iana-special-2025-10-09");
    assert!(a.at_ms > 1_700_000_000_000);
    let json = serde_json::to_value(&a).unwrap();
    let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["atMs", "classifier"]);
}

#[test]
fn every_error_has_its_spec_code() {
    let cases = [
        (TransportError::NotConnectable, "target-not-connectable"),
        (TransportError::NonCanonicalIpv4, "host-ipv4-noncanonical"),
        (TransportError::Unresolved, "target-unresolved"),
        (TransportError::DnsTimeout, "target-dns-timeout"),
        (TransportError::ConfirmNeeded, "transport-confirm-needed"),
        (TransportError::Busy, "transport-check-busy"),
    ];
    for (err, code) in cases {
        assert_eq!(err.code(), code);
        assert_eq!(err.to_string(), code);
    }
}

#[tokio::test]
async fn report_serializes_camel_case_with_string_category() {
    let (_, got) = check(
        "split.example",
        Ok(vec!["10.0.0.5", "8.8.8.8"]),
        Transport::Direct,
    )
    .await;
    let json = serde_json::to_value(&got.unwrap().report).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "category": "public",
            "addresses": ["10.0.0.5", "8.8.8.8"],
            "hints": [{
                "code": "target-mixed",
                "severity": "warning",
                "params": { "addresses": "8.8.8.8", "host": "split.example" }
            }],
            "tailscale": null,
            "needsPublicAck": true,
            "classifier": "iana-special-2025-10-09"
        })
    );
    for (category, text) in [
        (Category::Loopback, "loopback"),
        (Category::Tailnet, "tailnet"),
        (Category::Private, "private"),
        (Category::Special, "special"),
        (Category::Public, "public"),
    ] {
        let report = TransportReport {
            category: Some(category),
            addresses: vec![],
            hints: vec![],
            tailscale: None,
            needs_public_ack: false,
            classifier: "iana-special-2025-10-09",
        };
        assert_eq!(serde_json::to_value(&report).unwrap()["category"], text);
    }
}

#[tokio::test]
async fn check_makes_no_tailscale_or_probe_call_on_direct_paths() {
    let h = harness(FakeResolver::with("nas.corp.example", Ok(vec!["10.0.0.5"])));
    let tailscale = Arc::new(FakeTailscale::default());
    let prober = Arc::new(FakeProber::default());
    let deps = CheckDeps {
        resolver: h.deps.resolver.clone(),
        tailscale: tailscale.clone(),
        prober: prober.clone(),
    };
    check_target(&input("nas.corp.example", Transport::Direct), &deps, true)
        .await
        .unwrap();
    assert_eq!(tailscale.calls.load(Ordering::SeqCst), 0);
    assert_eq!(prober.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn check_future_is_send() {
    fn assert_send<T: Send>(_: &T) {}
    let h = harness(FakeResolver::default());
    let target = input("localhost", Transport::Direct);
    let fut = check_target(&target, &h.deps, false);
    assert_send(&fut);
}

#[test]
fn transport_and_purpose_wire_names() {
    assert_eq!(
        serde_json::to_value(Transport::Tailscale).unwrap(),
        "tailscale"
    );
    assert_eq!(serde_json::to_value(Transport::Direct).unwrap(), "direct");
    assert_eq!(serde_json::to_value(Purpose::Remote).unwrap(), "remote");
    assert_eq!(serde_json::to_value(Purpose::Ssh).unwrap(), "ssh");
    assert_eq!(serde_json::to_value(Purpose::SshJump).unwrap(), "ssh-jump");
    assert!(serde_json::from_value::<Transport>(serde_json::json!("Tailscale")).is_err());
}
