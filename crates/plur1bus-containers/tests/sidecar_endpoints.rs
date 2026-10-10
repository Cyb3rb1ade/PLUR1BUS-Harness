//! Sidecar endpoint rules beyond the cases in `sidecars.rs`: every branch of `resolve_endpoint`, the
//! config's closed shape, the probe's offline refusals, and the Valkey PING exchange against a
//! loopback fake server. Nothing here leaves the machine.
use plur1bus_containers::*;
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpListener},
    thread,
};

fn remote(url: &str) -> SidecarConfig {
    let mut c = SidecarConfig::off();
    c.mode = SidecarMode::Remote;
    c.url = Some(url.into());
    c
}

#[test]
fn bundled_mode_uses_the_bundled_endpoint_or_fails_closed() {
    let mut c = SidecarConfig::off();
    c.mode = SidecarMode::Bundled;
    c.url = Some("http://100.64.0.99:8080".into());
    // The configured url is ignored in bundled mode; only the bundled endpoint counts.
    assert_eq!(
        resolve_endpoint("searxng", &c, Some("http://plur1bus-searxng:8080"))
            .unwrap()
            .unwrap(),
        "http://plur1bus-searxng:8080"
    );
    assert!(resolve_endpoint("searxng", &c, None)
        .unwrap_err()
        .contains("bundled endpoint unavailable"));
}

#[test]
fn remote_mode_without_a_url_is_an_error_not_a_default() {
    let mut c = SidecarConfig::off();
    c.mode = SidecarMode::Remote;
    assert!(resolve_endpoint("searxng", &c, None)
        .unwrap_err()
        .contains("requires url"));
}

#[test]
fn off_mode_skips_endpoint_checks_but_still_validates_the_id() {
    let mut c = SidecarConfig::off();
    c.url = Some("file:///etc/passwd".into());
    c.timeout_ms = 0;
    assert_eq!(resolve_endpoint("searxng", &c, None).unwrap(), None);
    // An id that is not a plain resource name is refused even when the sidecar is off.
    assert!(resolve_endpoint("bad name", &c, None).is_err());
}

#[test]
fn timeout_bounds_are_inclusive_at_1_and_120000_ms() {
    let mut c = remote("http://100.64.0.1:8080");
    c.timeout_ms = 1;
    assert!(resolve_endpoint("searxng", &c, None).is_ok());
    c.timeout_ms = 120_000;
    assert!(resolve_endpoint("searxng", &c, None).is_ok());
    c.timeout_ms = 120_001;
    assert!(resolve_endpoint("searxng", &c, None)
        .unwrap_err()
        .contains("1..120000"));
}

#[test]
fn redis_scheme_is_valkey_only_and_valkey_takes_either_scheme() {
    assert!(resolve_endpoint("searxng", &remote("redis://100.64.0.2:6379/0"), None).is_err());
    assert!(resolve_endpoint("valkey", &remote("redis://100.64.0.2:6379/0"), None).is_ok());
    assert!(resolve_endpoint("valkey", &remote("valkey://100.64.0.2:6379/0"), None).is_ok());
}

#[test]
fn ca_bundle_and_fingerprint_both_require_https() {
    let mut c = remote("http://100.64.0.1:8080");
    c.ca_bundle = Some("/nonexistent/ca.pem".into());
    assert!(resolve_endpoint("searxng", &c, None)
        .unwrap_err()
        .contains("CA bundle requires HTTPS"));
    c.ca_bundle = None;
    c.fingerprint = Some(format!("sha256:{}", "a".repeat(64)));
    assert!(resolve_endpoint("searxng", &c, None)
        .unwrap_err()
        .contains("requires HTTPS"));
    c.url = Some("https://100.64.0.1:8443".into());
    assert!(resolve_endpoint("searxng", &c, None).is_ok());
}

#[test]
fn fingerprints_must_be_exactly_64_lowercase_hex_digits_after_sha256_prefix() {
    let mut c = remote("https://100.64.0.1:8443");
    for bad in [
        format!("sha256:{}", "A".repeat(64)),
        format!("sha256:{}", "a".repeat(63)),
        format!("sha256:{}", "a".repeat(65)),
        format!("sha512:{}", "a".repeat(64)),
        "a".repeat(64),
    ] {
        c.fingerprint = Some(bad.clone());
        assert!(
            resolve_endpoint("searxng", &c, None).is_err(),
            "accepted {bad}"
        );
    }
}

#[test]
fn config_json_is_camel_case_and_closed() {
    let ok: SidecarConfig = serde_json::from_str(
        r#"{"mode":"remote","url":"https://100.64.0.1:8443","timeoutMs":2500}"#,
    )
    .unwrap();
    assert_eq!(ok.mode, SidecarMode::Remote);
    assert_eq!(ok.timeout_ms, 2500);
    let extra = r#"{"mode":"off","timeoutMs":5000,"unexpected":true}"#;
    assert!(serde_json::from_str::<SidecarConfig>(extra).is_err());
}

#[test]
fn http_probe_refuses_bad_timeouts_and_valkey_pins_before_any_socket_is_opened() {
    let probe = HttpHealthProbe;
    let mut c = remote("http://100.64.0.1:8080");
    c.timeout_ms = 0;
    assert!(probe
        .check("http://100.64.0.1:8080", &c)
        .unwrap_err()
        .contains("invalid sidecar timeout"));
    let mut v = remote("valkey://100.64.0.2:6379/0");
    v.ca_bundle = Some("/nonexistent/ca.pem".into());
    assert!(probe
        .check("valkey://100.64.0.2:6379/0", &v)
        .unwrap_err()
        .contains("Valkey over Tailscale"));
}

/// One loopback connection: read exactly one PING (`*1\r\n$4\r\nPING\r\n`, 14 bytes), answer with
/// `reply`, then close. Waits on the socket rather than sleeping, so the test is as fast as the peer.
fn valkey_stub(reply: &'static [u8]) -> (u16, thread::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_nodelay(true).unwrap();
        let mut seen = vec![0; 14];
        socket.read_exact(&mut seen).unwrap();
        socket.write_all(reply).unwrap();
        socket.flush().unwrap();
        socket.shutdown(Shutdown::Both).ok();
        seen
    });
    (port, task)
}

#[test]
fn valkey_probe_accepts_only_an_unauthenticated_pong() {
    let (port, task) = valkey_stub(b"+PONG\r\n");
    let url = format!("valkey://127.0.0.1:{port}/0");
    let c = remote(&url);
    HttpHealthProbe.check(&url, &c).unwrap();
    assert_eq!(task.join().unwrap(), b"*1\r\n$4\r\nPING\r\n");
}

#[test]
fn valkey_probe_refuses_an_auth_challenge_as_not_healthy() {
    let (port, task) = valkey_stub(b"-NOAUTH");
    let url = format!("valkey://127.0.0.1:{port}/0");
    let c = remote(&url);
    let err = HttpHealthProbe.check(&url, &c).unwrap_err();
    assert!(err.contains("refused credential-free PING"), "{err}");
    task.join().unwrap();
}

#[test]
fn valkey_probe_reports_a_closed_port_as_unreachable() {
    // Bind then drop: the port is free again, so the connect is refused without any network.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let url = format!("valkey://127.0.0.1:{port}/0");
    let err = HttpHealthProbe.check(&url, &remote(&url)).unwrap_err();
    assert!(err.contains("unreachable"), "{err}");
}
