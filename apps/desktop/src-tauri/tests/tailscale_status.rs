//! `tailscale status --json` parsing, the status cache and the debug seams (transport choice spec §5.2 steps 1-3,
//! §5.4; package T3). The documents are the synthetic fixtures under `fixtures/tailscale/`; nothing here runs a real
//! `tailscale` binary.
use plur1bus_desktop::transport::{
    parse_status, CliTailscale, TailnetView, TailscaleSource, TailscaleStatus, UnavailableWhy,
    MAX_STATUS_BYTES,
};
use std::net::IpAddr;
use std::sync::Mutex;

/// Serialises the tests that change the process environment (`FLATPAK_ID`, the two seams).
static ENV: Mutex<()> = Mutex::new(());

const RUNNING: &[u8] = include_bytes!("fixtures/tailscale/running.json");
const NEEDS_LOGIN: &[u8] = include_bytes!("fixtures/tailscale/needs-login.json");
const STOPPED: &[u8] = include_bytes!("fixtures/tailscale/stopped.json");
const PEER_OFFLINE: &[u8] = include_bytes!("fixtures/tailscale/peer-offline.json");
const PEER_EXPIRED: &[u8] = include_bytes!("fixtures/tailscale/peer-expired.json");
const SUBNET_ROUTER: &[u8] = include_bytes!("fixtures/tailscale/subnet-router.json");
const NO_MAGICDNS: &[u8] = include_bytes!("fixtures/tailscale/no-magicdns.json");
const UNKNOWN_FIELDS: &[u8] = include_bytes!("fixtures/tailscale/unknown-fields.json");

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

fn running(doc: &[u8]) -> TailnetView {
    match parse_status(true, doc) {
        TailscaleStatus::Running(view) => view,
        other => panic!("not running: {other:?}"),
    }
}

#[test]
fn running_fixture_parses_into_the_minimal_view() {
    let view = running(RUNNING);
    assert_eq!(
        view.self_ips,
        vec![ip("100.90.0.1"), ip("fd7a:115c:a1e0::1")]
    );
    assert_eq!(view.self_dns_name, "workstation.example.ts.net.");
    assert_eq!(view.magic_suffix.as_deref(), Some("example.ts.net"));
    assert_eq!(view.peers.len(), 3);
    let nas = view
        .peers
        .iter()
        .find(|p| p.dns_name == "nas.example.ts.net.")
        .unwrap();
    assert_eq!(nas.host_name, "nas-host");
    assert_eq!(
        nas.ips,
        vec![ip("100.101.102.103"), ip("fd7a:115c:a1e0::65")]
    );
    assert!(nas.online);
    assert!(!nas.expired);
    assert!(nas.routes.is_empty());
    let router = view
        .peers
        .iter()
        .find(|p| p.dns_name == "router.example.ts.net.")
        .unwrap();
    assert_eq!(router.routes.len(), 1);
    assert_eq!(router.routes[0].addr, ip("192.168.10.0"));
    assert_eq!(router.routes[0].prefix, 24);
}

#[test]
fn backend_states_map_to_the_spec_states() {
    assert_eq!(parse_status(true, NEEDS_LOGIN), TailscaleStatus::NeedsLogin);
    assert_eq!(parse_status(true, STOPPED), TailscaleStatus::Stopped);
    let machine_auth = br#"{"BackendState":"NeedsMachineAuth"}"#;
    assert_eq!(
        parse_status(true, machine_auth),
        TailscaleStatus::NeedsLogin
    );
    for other in ["Starting", "NoState", "InUseOtherUser", ""] {
        let doc = format!(r#"{{"BackendState":"{other}"}}"#);
        assert_eq!(
            parse_status(true, doc.as_bytes()),
            TailscaleStatus::Stopped,
            "{other}"
        );
    }
}

#[test]
fn offline_expired_subnet_and_no_magicdns_fixtures() {
    let view = running(PEER_OFFLINE);
    let nas = view
        .peers
        .iter()
        .find(|p| p.host_name == "nas-host")
        .unwrap();
    assert!(!nas.online && !nas.expired);
    let view = running(PEER_EXPIRED);
    assert!(view.peers[0].online && view.peers[0].expired);
    let view = running(SUBNET_ROUTER);
    assert_eq!(view.peers.len(), 2);
    let router = view
        .peers
        .iter()
        .find(|p| p.host_name == "router-host")
        .unwrap();
    // An unparseable route is dropped, the valid one kept.
    assert_eq!(router.routes.len(), 1);
    let view = running(NO_MAGICDNS);
    assert_eq!(view.magic_suffix, None);
    assert_eq!(view.peers.len(), 1);
}

#[test]
fn unknown_fields_are_ignored_and_bad_addresses_dropped() {
    let view = running(UNKNOWN_FIELDS);
    // A trailing dot on the suffix is dropped; `CurrentTailnet` wins over the top-level field either way.
    assert_eq!(view.magic_suffix.as_deref(), Some("example.ts.net"));
    assert_eq!(view.self_ips, vec![ip("100.90.0.1")]);
    assert_eq!(view.peers.len(), 1);
    assert_eq!(view.peers[0].ips, vec![ip("100.101.102.103")]);
    assert!(view.peers[0].routes.is_empty());
}

#[test]
fn missing_peer_map_is_empty_peers() {
    let doc = br#"{"BackendState":"Running","Self":{"TailscaleIPs":["100.90.0.1"]}}"#;
    let view = running(doc);
    assert!(view.peers.is_empty());
    assert_eq!(view.self_ips, vec![ip("100.90.0.1")]);
    assert_eq!(view.magic_suffix, None);
    // `Peer: null` and a missing `Self` are fine too.
    let view = running(br#"{"BackendState":"Running","Peer":null}"#);
    assert!(view.peers.is_empty() && view.self_ips.is_empty());
}

#[test]
fn oversized_document_is_too_large() {
    // 9 MiB: a valid document padded with white space, so only the size can make it fail.
    let mut doc = Vec::from(&b"{\"BackendState\":\"Running\"}"[..]);
    doc.resize(9 * 1024 * 1024, b' ');
    assert!(doc.len() > MAX_STATUS_BYTES);
    assert_eq!(
        parse_status(true, &doc),
        TailscaleStatus::Unavailable(UnavailableWhy::TooLarge)
    );
    // Exactly at the cap still parses.
    doc.truncate(MAX_STATUS_BYTES);
    assert!(matches!(
        parse_status(true, &doc),
        TailscaleStatus::Running(_)
    ));
}

#[test]
fn garbage_and_shapeless_documents_are_unparseable() {
    for doc in [
        &b"not json at all"[..],
        b"",
        b"[]",
        b"{}",
        b"{\"BackendState\":7}",
        b"{\"BackendState\":\"Running\",\"Peer\":[1,2]}",
        b"\xff\xfe",
    ] {
        assert_eq!(
            parse_status(true, doc),
            TailscaleStatus::Unavailable(UnavailableWhy::Unparseable),
            "{:?}",
            String::from_utf8_lossy(doc)
        );
    }
}

#[test]
fn non_zero_exit_is_daemon_down() {
    assert_eq!(parse_status(false, b""), TailscaleStatus::DaemonDown);
    // Whatever the output says.
    assert_eq!(parse_status(false, RUNNING), TailscaleStatus::DaemonDown);
}

/// A source created while `vars` are set; the environment is read only at creation, under the lock.
fn source_with(vars: &[(&str, &std::ffi::OsStr)]) -> CliTailscale {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    for (name, value) in vars {
        std::env::set_var(name, value);
    }
    let source = CliTailscale::new();
    for (name, _) in vars {
        std::env::remove_var(name);
    }
    source
}

#[tokio::test]
async fn flatpak_is_unavailable_without_running_anything() {
    let source = source_with(&[("FLATPAK_ID", "org.example.Synthetic".as_ref())]);
    assert_eq!(
        source.status().await,
        TailscaleStatus::Unavailable(UnavailableWhy::Flatpak)
    );
}

/// DR19: both seams are honoured in a debug build and ignored in a release build. Run in release with
/// `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1 cargo test --release -p plur1bus-desktop --test tailscale_status`.
/// Neither branch runs a Tailscale binary: the release branch only inspects the chosen source.
#[test]
fn seams_are_debug_only() {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let fixture = dir.path().join("status.json");
    std::fs::write(&fixture, RUNNING).unwrap();
    std::env::set_var("PLUR1BUS_DESKTOP_TAILSCALE_STATUS", &fixture);
    let with_status = CliTailscale::new().uses_debug_seam();
    std::env::remove_var("PLUR1BUS_DESKTOP_TAILSCALE_STATUS");
    std::env::set_var("PLUR1BUS_DESKTOP_TAILSCALE_BIN", dir.path().join("fake"));
    let with_bin = CliTailscale::new().uses_debug_seam();
    std::env::remove_var("PLUR1BUS_DESKTOP_TAILSCALE_BIN");
    let without = CliTailscale::new().uses_debug_seam();
    assert!(!without);
    if cfg!(debug_assertions) {
        assert!(with_status && with_bin);
    } else {
        assert!(
            !with_status && !with_bin,
            "a release build must ignore both seams"
        );
    }
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn status_seam_reads_the_fixture_and_caches_it_for_ten_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = dir.path().join("status.json");
    std::fs::write(&fixture, RUNNING).unwrap();
    let seam = [("PLUR1BUS_DESKTOP_TAILSCALE_STATUS", fixture.as_os_str())];
    let source = source_with(&seam);
    assert!(source.uses_debug_seam());
    let first = source.status().await;
    assert!(matches!(first, TailscaleStatus::Running(ref v) if v.peers.len() == 3));
    // Within 10 s the cached status answers, even though the source changed.
    std::fs::write(&fixture, STOPPED).unwrap();
    assert_eq!(source.status().await, first);
    // Concurrent callers share one run and one answer.
    let (a, b) = tokio::join!(source.status(), source.status());
    assert_eq!(a, first);
    assert_eq!(b, first);
    // A fresh source (no cache) sees the new document; an oversized one is refused.
    let fresh = source_with(&seam);
    std::fs::write(&fixture, vec![b' '; MAX_STATUS_BYTES + 1]).unwrap();
    let huge = source_with(&seam);
    assert_eq!(
        huge.status().await,
        TailscaleStatus::Unavailable(UnavailableWhy::TooLarge)
    );
    std::fs::write(&fixture, STOPPED).unwrap();
    assert_eq!(fresh.status().await, TailscaleStatus::Stopped);
}

#[cfg(debug_assertions)]
#[tokio::test(start_paused = true)]
async fn cache_expires_after_ten_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = dir.path().join("status.json");
    std::fs::write(&fixture, RUNNING).unwrap();
    let source = source_with(&[("PLUR1BUS_DESKTOP_TAILSCALE_STATUS", fixture.as_os_str())]);
    assert!(source.uses_debug_seam());
    assert!(matches!(source.status().await, TailscaleStatus::Running(_)));
    std::fs::write(&fixture, STOPPED).unwrap();
    tokio::time::advance(std::time::Duration::from_millis(9_900)).await;
    assert!(matches!(source.status().await, TailscaleStatus::Running(_)));
    tokio::time::advance(std::time::Duration::from_millis(200)).await;
    assert_eq!(source.status().await, TailscaleStatus::Stopped);
}
