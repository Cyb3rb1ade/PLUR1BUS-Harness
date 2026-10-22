//! What of the tailnet status leaves Rust (transport choice spec §9.4; package T3): the serialized report carries the
//! state code, the matched peer's label and its online flag, and nothing else of the status. The transport module
//! prints nothing itself; its one line per check goes through the injected log sink and carries purpose, category and
//! codes only (captured and checked against this fixture in `transport_open.rs`, package T4).
use futures_util::future::BoxFuture;
use plur1bus_desktop::transport::{
    check_target, parse_status, CheckDeps, HostInput, ProbeOutcome, Prober, Purpose, ResolveError,
    Resolver, TailscaleSource, TailscaleStatus, TargetInput, Transport,
};
use std::net::SocketAddr;
use std::sync::Arc;

const RUNNING: &[u8] = include_bytes!("fixtures/tailscale/running.json");
const SUBNET_ROUTER: &[u8] = include_bytes!("fixtures/tailscale/subnet-router.json");

struct Answers(Vec<(String, Vec<SocketAddr>)>);

impl Resolver for Answers {
    fn lookup<'a>(
        &'a self,
        host: &'a str,
        _port: u16,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, ResolveError>> {
        let answer = self
            .0
            .iter()
            .find(|(h, _)| h == host)
            .map(|(_, a)| a.clone())
            .ok_or(ResolveError::NotFound);
        Box::pin(async move { answer })
    }
}

struct Fixed(TailscaleStatus);

impl TailscaleSource for Fixed {
    fn status(&self) -> BoxFuture<'_, TailscaleStatus> {
        let status = self.0.clone();
        Box::pin(async move { status })
    }
}

struct Connected;

impl Prober for Connected {
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

fn deps(status: TailscaleStatus) -> CheckDeps {
    CheckDeps {
        resolver: Arc::new(Answers(vec![(
            "nas.corp.example".into(),
            vec!["100.101.102.103:22".parse().unwrap()],
        )])),
        tailscale: Arc::new(Fixed(status)),
        prober: Arc::new(Connected),
    }
}

async fn report_json(doc: &[u8], host: &str, transport: Transport, purpose: Purpose) -> String {
    report_json_for(parse_status(true, doc), host, transport, purpose).await
}

async fn report_json_for(
    status: TailscaleStatus,
    host: &str,
    transport: Transport,
    purpose: Purpose,
) -> String {
    let input = TargetInput {
        host: HostInput::parse(host).unwrap(),
        port: 22,
        transport,
        purpose,
    };
    let checked = check_target(&input, &deps(status), true).await.unwrap();
    serde_json::to_string(&checked.report).unwrap()
}

/// Every name, user, address and identifier in `running.json` that is not the matched `nas` peer's.
const RUNNING_SECRETS: &[&str] = &[
    "workstation",
    "laptop",
    "router",
    "-host",
    "alice",
    "bob",
    "Alice Example",
    "Bob Example",
    "example.com",
    "100.90.0.1",
    "fd7a:115c:a1e0::1\"",
    "100.101.102.104",
    "100.101.102.105",
    "fd7a:115c:a1e0::66",
    "192.168.10",
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
];

#[tokio::test]
async fn report_carries_only_the_matched_peer_label() {
    for (host, transport, purpose) in [
        ("nas", Transport::Tailscale, Purpose::Ssh),
        ("100.101.102.103", Transport::Direct, Purpose::Ssh),
        ("nas.corp.example", Transport::Direct, Purpose::SshJump),
    ] {
        let json = report_json(RUNNING, host, transport, purpose).await;
        assert!(json.contains("\"peer\":\"nas\""), "{json}");
        for secret in RUNNING_SECRETS {
            assert!(!json.contains(secret), "{secret} leaked for {host}: {json}");
        }
        // The full peer name is never echoed unless the person typed it, and the tailnet suffix not at all.
        assert!(!json.contains("example.ts.net"), "{json}");
        assert!(!json.contains("nas-host"), "{json}");
    }
}

#[tokio::test]
async fn a_typed_ts_net_name_is_echoed_but_nothing_else_of_the_tailnet() {
    let json = report_json(
        RUNNING,
        "nas.example.ts.net",
        Transport::Tailscale,
        Purpose::Remote,
    )
    .await;
    for secret in RUNNING_SECRETS {
        assert!(!json.contains(secret), "{secret} leaked: {json}");
    }
}

/// The one place the report carries a full peer name: `tailscale-short-name` for a remote short name matched by name,
/// with exactly the matched peer's own DNS name (spec §9.4 as amended). Nothing of other peers or other tailnets.
#[tokio::test]
async fn remote_short_name_suggests_only_the_matched_peers_own_name() {
    let TailscaleStatus::Running(mut view) = parse_status(true, RUNNING) else {
        panic!("running")
    };
    // Shared nodes from other tailnets, one with the same first label, listed before the own `nas`.
    let mut other_nas = view.peers[0].clone();
    other_nas.dns_name = "nas.other-tailnet.ts.net.".into();
    other_nas.ips = vec!["100.101.102.198".parse().unwrap()];
    let mut printer = view.peers[0].clone();
    printer.dns_name = "printer.shared-tailnet.ts.net.".into();
    printer.ips = vec!["100.101.102.199".parse().unwrap()];
    view.peers.insert(0, other_nas);
    view.peers.push(printer);
    let json = report_json_for(
        TailscaleStatus::Running(view),
        "nas",
        Transport::Tailscale,
        Purpose::Remote,
    )
    .await;
    let report: serde_json::Value = serde_json::from_str(&json).unwrap();
    let hint = report["hints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["code"] == "tailscale-short-name")
        .unwrap_or_else(|| panic!("{json}"));
    assert_eq!(
        hint["params"],
        serde_json::json!({ "suggestion": "nas.example.ts.net" })
    );
    assert_eq!(report["tailscale"]["peer"], "nas");
    assert_eq!(
        report["addresses"],
        serde_json::json!(["100.101.102.103", "fd7a:115c:a1e0::65"])
    );
    // The suggestion is the only occurrence of the tailnet name.
    assert_eq!(json.matches("example.ts.net").count(), 1, "{json}");
    for secret in RUNNING_SECRETS.iter().chain(&[
        "other-tailnet",
        "shared-tailnet",
        "printer",
        "100.101.102.198",
        "100.101.102.199",
    ]) {
        assert!(!json.contains(secret), "{secret} leaked: {json}");
    }
}

#[tokio::test]
async fn subnet_route_report_names_only_the_router_label() {
    let json = report_json(
        SUBNET_ROUTER,
        "192.168.10.5",
        Transport::Tailscale,
        Purpose::Ssh,
    )
    .await;
    assert!(json.contains("\"peer\":\"router\""), "{json}");
    for secret in [
        "oldrouter",
        "100.101.102.105",
        "100.101.102.106",
        "192.168.20",
        "router-host",
        "router.example",
        "alice",
        "100.90.0.1",
    ] {
        assert!(!json.contains(secret), "{secret} leaked: {json}");
    }
}

#[test]
fn transport_module_writes_no_log_lines() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/transport");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        for macro_name in [
            "println!",
            "eprintln!",
            "print!",
            "eprint!",
            "dbg!",
            "log::",
            "tracing::",
            "emit_named",
            "logging::",
        ] {
            assert!(
                !source.contains(macro_name),
                "{} uses {macro_name}",
                path.display()
            );
        }
        checked += 1;
    }
    assert!(checked >= 7, "{checked}");
}
