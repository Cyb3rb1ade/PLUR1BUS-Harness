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

fn a(n: usize) -> String {
    "a".repeat(n)
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
        ("[::1]", HostInput::Ip(ip("::1"))),
        ("::1", HostInput::Ip(ip("::1"))),
        ("fe80::1", HostInput::Ip(ip("fe80::1"))),
        (
            "[fd7a:115c:a1e0::1]",
            HostInput::Ip(ip("fd7a:115c:a1e0::1")),
        ),
        ("::ffff:10.0.0.1", HostInput::Ip(ip("::ffff:10.0.0.1"))),
        // Valid syntax that the check refuses later with target-not-connectable (spec §4.3), not host-invalid.
        ("0.0.0.0", HostInput::Ip(ip("0.0.0.0"))),
        ("::", HostInput::Ip(ip("::"))),
        ("224.0.0.1", HostInput::Ip(ip("224.0.0.1"))),
        ("ff02::1", HostInput::Ip(ip("ff02::1"))),
        ("255.255.255.255", HostInput::Ip(ip("255.255.255.255"))),
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
fn name_length_limits() {
    // 63 bytes per label, 253 bytes for the name without its optional trailing dot.
    let exact253 = format!("{}.{}.{}.{}", a(63), a(63), a(63), a(61));
    assert_eq!(exact253.len(), 253);
    assert!(HostInput::parse(&format!("{}.example", a(63))).is_ok());
    assert!(HostInput::parse(&exact253).is_ok(), "{exact253}");
    assert!(HostInput::parse(&format!("{exact253}.")).is_ok());
}

#[test]
fn noncanonical_ipv4_spellings_are_refused_with_their_code() {
    for input in [
        // Legacy inet_aton spellings.
        "127.1",
        "0x7f000001",
        "017700000001",
        "2130706433",
        "0x7f.0.0.1",
        "127.0.0.01",
        "10.1",
        // Spellings the URL host parser maps to an IPv4 address: a trailing dot, full-width digits and dots.
        "1.2.3.4.",
        "１２７.０.０.１",
        "127。0。0。1",
    ] {
        let got = HostInput::parse(input);
        assert_eq!(got, Err(TransportError::NonCanonicalIpv4), "{input}");
        assert_eq!(got.unwrap_err().code(), "host-ipv4-noncanonical", "{input}");
    }
}

#[test]
fn malformed_hosts_are_refused_with_host_invalid() {
    let label64 = format!("{}.example", a(64));
    let over254 = format!("{}.{}.{}.{}", a(63), a(63), a(63), a(62));
    let over255 = format!("{}.{}.{}.{}", a(63), a(63), a(63), a(63));
    let raw1025 = a(1025);
    let classes: Vec<(&str, Vec<&str>)> = vec![
        ("empty or over 1024 bytes", vec!["", raw1025.as_str()]),
        (
            "white space, control characters, U+FEFF",
            vec![
                " ",
                "a b.example",
                " example.com",
                "example.com ",
                "exa\tmple.com",
                "exa\u{0}mple.com",
                "exa\u{85}mple.com",
                "\u{FEFF}example.com",
            ],
        ),
        (
            "% (zone ids, percent-encoding)",
            vec![
                "fe80::1%en0",
                "[fe80::1%en0]",
                "fe80::1%25en0",
                "%6c%6fcalhost",
                "100%.example",
            ],
        ),
        (
            "[ or : but not a strict IPv6 literal",
            vec![
                "[192.168.1.1]",
                "host:22",
                "[::1]:22",
                "[::1",
                "::1]",
                "1::2::3",
                "[]",
                "[nas.example]",
                "::ffff:127.1",
            ],
        ),
        (
            "url host errors",
            vec![
                "user@host",
                "host/path",
                "a<b.example",
                "foo.123",
                "999.1.1.1",
                "xn--a.example",
            ],
        ),
        (
            "LDH failures after IDNA",
            vec![
                "a_b.example",
                "_ssh.example",
                "-a.example",
                "a-.example",
                "a..b",
                ".example",
                "..",
                ".",
                "a*b.example",
                label64.as_str(),
                over254.as_str(),
                over255.as_str(),
            ],
        ),
    ];
    for (class, inputs) in classes {
        for input in inputs {
            let got = HostInput::parse(input);
            assert_eq!(got, Err(TransportError::HostInvalid), "{class}: {input:?}");
            assert_eq!(got.unwrap_err().code(), "host-invalid");
        }
    }
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
        assert_eq!(
            HostInput::from_origin(&origin),
            Ok((host, port)),
            "{origin:?}"
        );
    }
}

#[test]
fn from_origin_applies_the_host_rules_to_stored_origins() {
    // `Origin::parse` admits these hosts; spec §4.4 does not, so a stored row with one is refused.
    let label64 = format!("https://{}.example", a(64));
    let over253 = format!("https://{}.{}.{}.{}", a(63), a(63), a(63), a(62));
    for origin in ["https://a_b.example", label64.as_str(), over253.as_str()] {
        let parsed = Origin::parse(origin).unwrap_or_else(|e| panic!("{origin}: {e}"));
        assert_eq!(
            HostInput::from_origin(&parsed),
            Err(TransportError::HostInvalid),
            "{origin}"
        );
    }
}
