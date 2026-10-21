//! Host input validation (transport choice spec §4.4, package T2).
use plur1bus_desktop::connections::Origin;
use plur1bus_desktop::transport::{HostInput, TransportError};
use std::net::IpAddr;

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

fn name(s: &str) -> HostInput {
    HostInput::Name(s.into())
}

#[test]
fn accepted_host_inputs() {
    let cases: Vec<(&str, HostInput)> = vec![
        // DNS names: IDNA to punycode, lower case, trailing dot kept as written.
        ("Bücher.example", name("xn--bcher-kva.example")),
        ("BÜCHER.Example", name("xn--bcher-kva.example")),
        ("Harness.Corp.Example", name("harness.corp.example")),
        ("nas.tail1234.ts.net", name("nas.tail1234.ts.net")),
        ("nas.tail1234.ts.net.", name("nas.tail1234.ts.net.")),
        ("nas", name("nas")),
        ("a-b.example", name("a-b.example")),
        ("xn--bcher-kva.example", name("xn--bcher-kva.example")),
        ("123.example", name("123.example")),
        // Canonical IPv4, IPv6 with or without brackets.
        ("192.168.1.10", HostInput::Ip(ip("192.168.1.10"))),
        ("0.0.0.0", HostInput::Ip(ip("0.0.0.0"))),
        ("[::1]", HostInput::Ip(ip("::1"))),
        ("::1", HostInput::Ip(ip("::1"))),
        ("fe80::1", HostInput::Ip(ip("fe80::1"))),
        (
            "[fd7a:115c:a1e0::1]",
            HostInput::Ip(ip("fd7a:115c:a1e0::1")),
        ),
        ("::ffff:10.0.0.1", HostInput::Ip(ip("::ffff:10.0.0.1"))),
        // localhost is loopback without DNS (RFC 6761).
        ("localhost", HostInput::Localhost),
        ("LocalHost", HostInput::Localhost),
        ("localhost.", HostInput::Localhost),
    ];
    for (input, want) in cases {
        assert_eq!(HostInput::parse(input), Ok(want), "{input}");
    }
}

#[test]
fn noncanonical_ipv4_spellings_are_refused_with_their_code() {
    for input in [
        "127.1",
        "0x7f000001",
        "017700000001",
        "2130706433",
        "0x7f.0.0.1",
        "127.0.0.01",
        "10.1",
        "1.2.3.4.",
    ] {
        let got = HostInput::parse(input);
        assert_eq!(got, Err(TransportError::NonCanonicalIpv4), "{input}");
        assert_eq!(got.unwrap_err().code(), "host-ipv4-noncanonical", "{input}");
    }
}

#[test]
fn invalid_host_inputs_are_refused() {
    let label64 = format!("{}.example", "a".repeat(64));
    let label63 = format!("{}.example", "a".repeat(63));
    let a = |n: usize| "a".repeat(n);
    // 253 bytes is the limit for the name without its optional trailing dot.
    let exact253 = format!("{}.{}.{}.{}", a(63), a(63), a(63), a(61));
    let over254 = format!("{}.{}.{}.{}", a(63), a(63), a(63), a(62));
    let long = format!("{}.{}.{}.{}", a(63), a(63), a(63), a(63));
    assert_eq!(exact253.len(), 253);
    assert_eq!(over254.len(), 254);
    assert!(HostInput::parse(&label63).is_ok());
    assert!(HostInput::parse(&exact253).is_ok(), "{exact253}");
    assert!(HostInput::parse(&format!("{exact253}.")).is_ok());
    assert!(HostInput::parse(&over254).is_err());
    let oversized_raw = "a".repeat(5000);
    for input in [
        "",
        " ",
        "fe80::1%en0",
        "[fe80::1%en0]",
        "fe80::1%25en0",
        "a_b.example",
        "_ssh.example",
        "a b.example",
        " example.com",
        "example.com ",
        "exa\tmple.com",
        "-a.example",
        "a-.example",
        "a..b",
        ".example",
        "..",
        ".",
        "%6c%6fcalhost",
        "user@host",
        "host/path",
        "host:22",
        "[192.168.1.1]",
        "[::1",
        "::1]",
        "1::2::3",
        "999.1.1.1",
        "foo.123",
        "exa\u{0}mple.com",
        label64.as_str(),
        long.as_str(),
        oversized_raw.as_str(),
    ] {
        let got = HostInput::parse(input);
        assert!(got.is_err(), "{input:?} gave {got:?}");
    }
}

#[test]
fn invalid_host_syntax_uses_the_not_connectable_code() {
    assert_eq!(
        HostInput::parse("a_b.example").unwrap_err().code(),
        "target-not-connectable"
    );
    assert_eq!(
        HostInput::parse("fe80::1%en0").unwrap_err().code(),
        "target-not-connectable"
    );
}

#[test]
fn ts_net_names_are_recognised() {
    for input in [
        "nas.tail1234.ts.net",
        "NAS.Tail1234.TS.NET",
        "nas.tail1234.ts.net.",
    ] {
        assert!(HostInput::parse(input).unwrap().is_ts_net(), "{input}");
    }
    for input in ["ts.net", "nas.ts.network", "nasts.net", "nas", "100.64.0.1"] {
        assert!(!HostInput::parse(input).unwrap().is_ts_net(), "{input}");
    }
}

#[test]
fn display_is_the_connect_host() {
    assert_eq!(
        HostInput::parse("Bücher.example").unwrap().to_string(),
        "xn--bcher-kva.example"
    );
    assert_eq!(HostInput::parse("[::1]").unwrap().to_string(), "::1");
    assert_eq!(
        HostInput::parse("10.0.0.1").unwrap().to_string(),
        "10.0.0.1"
    );
    assert_eq!(HostInput::Localhost.to_string(), "localhost");
}

#[test]
fn from_origin_takes_host_and_effective_port() {
    let cases: Vec<(&str, HostInput, u16)> = vec![
        (
            "https://nas.tail1234.ts.net",
            name("nas.tail1234.ts.net"),
            443,
        ),
        (
            "https://100.101.1.2:7443",
            HostInput::Ip(ip("100.101.1.2")),
            7443,
        ),
        (
            "https://harness.corp.example",
            name("harness.corp.example"),
            443,
        ),
        (
            "https://Bücher.example:8443",
            name("xn--bcher-kva.example"),
            8443,
        ),
        (
            "https://[fd7a:115c:a1e0::1]:8443",
            HostInput::Ip(ip("fd7a:115c:a1e0::1")),
            8443,
        ),
        (
            "http://127.0.0.1:18700",
            HostInput::Ip(ip("127.0.0.1")),
            18700,
        ),
        ("http://[::1]", HostInput::Ip(ip("::1")), 80),
        ("http://localhost:3000", HostInput::Localhost, 3000),
    ];
    for (origin, host, port) in cases {
        let origin = Origin::parse(origin).unwrap();
        assert_eq!(HostInput::from_origin(&origin), (host, port), "{origin:?}");
    }
}
