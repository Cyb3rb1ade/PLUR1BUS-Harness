//! What of the tailnet status leaves Rust (transport choice spec §9.4; package T3): the serialized report carries the
//! state code, the matched peer's label and its online flag, and nothing else of the status. The transport module
//! writes no log lines at all, so no log output can carry status data either.
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

fn deps(doc: &[u8]) -> CheckDeps {
    CheckDeps {
        resolver: Arc::new(Answers(vec![(
            "nas.corp.example".into(),
            vec!["100.101.102.103:22".parse().unwrap()],
        )])),
        tailscale: Arc::new(Fixed(parse_status(true, doc))),
        prober: Arc::new(Connected),
    }
}

async fn report_json(doc: &[u8], host: &str, transport: Transport, purpose: Purpose) -> String {
    let input = TargetInput {
        host: HostInput::parse(host).unwrap(),
        port: 22,
        transport,
        purpose,
    };
    let checked = check_target(&input, &deps(doc), true).await.unwrap();
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
