#![allow(
    clippy::panic,
    clippy::unwrap_used,
    reason = "recorded loopback fixture"
)]

use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use plur1bus_discovery::{
    http::{Admission, CredentialHeader, Http, Lease},
    scanners::{self, Error, Result, Scanner},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use ureq::http::Uri;
use url::Url;

struct Fixture(SocketAddr);
impl Admission for Fixture {
    fn pin(&self, _uri: &Uri, _deadline: Instant) -> Result<SocketAddr> {
        Ok(self.0)
    }

    fn now_ms(&self) -> i64 {
        10_000
    }
}

#[test]
fn replay_one_recorded_openai_list_through_the_pinned_http_transport() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/scanners.json"
    ))
    .unwrap();
    let case = &fixture["cases"][0];
    let server = FakeServer::start(&json!({
        "transport":"http","exchanges":[{
            "name":"recorded-openai-list",
            "request":{"method":"GET","path":"/models"},
            "response":{"status":200,"body":case["responses"][0]},
        }]
    }));
    let host = Fixture(server.addr);
    let base = Url::parse(&format!("http://{}/", server.addr)).unwrap();
    let uri = base.as_str().parse().unwrap();
    let mut http = Http::new(
        &host,
        &uri,
        "fixture-discovery/1",
        Some(Lease {
            origin: &base,
            header: CredentialHeader::Bearer("fixture-header"),
        }),
        true,
    )
    .unwrap();
    let output = scanners::scan(
        Scanner::OpenAi,
        false,
        &mut http,
        Instant::now() + Duration::from_secs(5),
        &|| false,
    )
    .unwrap();
    assert_eq!(serde_json::to_value(output).unwrap(), case["expected"]);
    let seen = server.received();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["method"], "GET");
    assert_eq!(seen[0]["path"], "/models");
    assert_eq!(seen[0]["headers"]["authorization"], "fixture-header");
}

#[test]
fn retry_after_stays_numeric_and_is_capped() {
    assert_eq!(Error::http_status(429).retry_after_ms, None);
    assert_eq!(
        plur1bus_discovery::http::retry_after("2", 10_000),
        Some(2000)
    );
    assert_eq!(
        plur1bus_discovery::http::retry_after("Thu, 01 Jan 1970 00:00:12 GMT", 10_000),
        Some(2000)
    );
    assert_eq!(
        plur1bus_discovery::http::retry_after("4000000", 0),
        Some(86_400_000)
    );
}

struct WireHost {
    address: SocketAddr,
}

impl Admission for WireHost {
    fn pin(&self, uri: &Uri, _deadline: Instant) -> Result<SocketAddr> {
        assert_eq!(
            uri.host(),
            Some("127.0.0.1"),
            "the fixture authorizes its own listener"
        );
        Ok(self.address)
    }

    fn now_ms(&self) -> i64 {
        10_000
    }
}

#[test]
fn replay_recorded_scanner_http_with_real_parser_and_pinned_transport() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/discovery/http.json")).unwrap();
    const MARKER: &str = "fixture-discovery-marker";
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let server = FakeServer::start(case);
        let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
        let uri = base.as_str().parse().unwrap();
        let host = WireHost {
            address: server.addr,
        };
        let header = match case["headerName"].as_str() {
            Some("authorization") => Some(CredentialHeader::Bearer(MARKER)),
            Some("x-api-key") => Some(CredentialHeader::Anthropic(MARKER)),
            Some("x-goog-api-key") => Some(CredentialHeader::Google(MARKER)),
            None => None,
            other => panic!("unexpected fixture credential header {other:?}"),
        };
        let lease = header.map(|header| Lease {
            origin: &base,
            header,
        });
        let mut http = Http::new(&host, &uri, "fixture-discovery/1", lease, true).unwrap();
        let scanner = case["scanner"].as_str().unwrap().parse().unwrap();
        let value = match scanners::scan(
            scanner,
            false,
            &mut http,
            Instant::now() + Duration::from_secs(4),
            &|| false,
        ) {
            Ok(output) => serde_json::to_value(output).unwrap(),
            Err(error) => serde_json::to_value(error).unwrap(),
        };
        assert_eq!(value, case["expected"], "{name}");
        assert!(!value.to_string().contains(MARKER), "{name}");
        let received = server.received();
        let exchanges = case["exchanges"].as_array().unwrap();
        assert_eq!(received.len(), exchanges.len(), "{name}");
        for (actual, exchange) in received.iter().zip(exchanges) {
            let request = &exchange["request"];
            assert_eq!(actual["method"], request["method"], "{name}");
            assert_eq!(actual["path"], request["path"], "{name}");
            for (name, value) in request["headers"].as_object().unwrap() {
                let expected = if value == "<credential>" {
                    &json!(MARKER)
                } else {
                    value
                };
                assert_eq!(&actual["headers"][name], expected, "{name}");
            }
        }
    }
}

#[test]
fn scanner_credentials_must_belong_to_the_configured_origin() {
    struct NoNetwork;
    impl Admission for NoNetwork {
        fn pin(&self, _: &Uri, _: Instant) -> Result<SocketAddr> {
            panic!("transport construction must not resolve an address");
        }

        fn now_ms(&self) -> i64 {
            panic!("transport construction must not ask for the clock");
        }
    }

    const MARKER: &str = "fixture-credential-origin-marker";
    let selected = "https://blue.example.invalid/v1".parse().unwrap();
    let origin = Url::parse("https://green.example.invalid/").unwrap();
    let wrong_origin = Http::new(
        &NoNetwork,
        &selected,
        "fixture-discovery/1",
        Some(Lease {
            origin: &origin,
            header: CredentialHeader::Bearer(MARKER),
        }),
        false,
    );
    let error = wrong_origin.err().unwrap();
    assert_eq!(error.result, "failed:invalid");
    assert_eq!(error.reason, "credential_origin");
    assert!(!format!("{error:?}").contains(MARKER));

    let matching_origin = Url::parse("https://blue.example.invalid:443/another-path").unwrap();
    assert!(Http::new(
        &NoNetwork,
        &selected,
        "fixture-discovery/1",
        Some(Lease {
            origin: &matching_origin,
            header: CredentialHeader::Bearer(MARKER)
        }),
        false,
    )
    .is_ok());
}

#[test]
fn failed_scans_keep_credentials_and_response_details_out_of_diagnostics() {
    use std::sync::{Arc, Mutex};

    const HEADER: &str = "fixture-discovery-private-header";
    const BODY: &str = "fixture-discovery-private-body";
    const CONTROL: &str = "synthetic discovery logger control";

    struct Records(Arc<Mutex<Vec<String>>>);
    impl log::Log for Records {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            self.0.lock().unwrap().push(record.args().to_string());
        }
        fn flush(&self) {}
    }

    let records = Arc::new(Mutex::new(Vec::new()));
    plur1bus_wire_log::install(Records(Arc::clone(&records))).unwrap();
    log::set_max_level(log::LevelFilter::Debug);
    log::debug!(target: "plur1bus_discovery", "{CONTROL}");

    let server = FakeServer::start(&json!({
        "transport": "http",
        "exchanges": [{
            "name": "normal-expired-credential",
            "request": {"method":"GET","path":"/models"},
            "response": {"status":401,"body":{"message":BODY}}
        }],
    }));
    let origin = Url::parse(&format!("http://{}/", server.addr)).unwrap();
    let uri = origin.as_str().parse().unwrap();
    let host = Fixture(server.addr);
    let lease = Lease {
        origin: &origin,
        header: CredentialHeader::Bearer(HEADER),
    };
    let mut http = Http::new(&host, &uri, "fixture-discovery/1", Some(lease), true).unwrap();
    let error = scanners::scan(
        Scanner::OpenAi,
        false,
        &mut http,
        Instant::now() + Duration::from_secs(5),
        &|| false,
    )
    .err()
    .unwrap();

    assert_eq!(server.received()[0]["headers"]["authorization"], HEADER);
    assert_eq!(error, Error::http_status(401));
    let diagnostics = format!("{error:?} {}", serde_json::to_string(&error).unwrap());
    let records = records.lock().unwrap();
    assert!(records.iter().any(|record| record == CONTROL));
    for marker in [HEADER, BODY] {
        assert!(!diagnostics.contains(marker));
        assert!(records.iter().all(|record| !record.contains(marker)));
    }
}

#[test]
fn a_partial_scanner_page_respects_its_deadline_and_cancellation() {
    let fixture = json!({"transport":"http","exchanges":[{
        "request":{"method":"GET","path":"/models"},
        "response":{"status":200,"headers":{"content-type":"application/json"},
            "chunksBase64":["eyJkYXRhIjo=","W119"],"chunkGapMs":400}
    }]});
    for (cancel, reason) in [(false, "request_timeout"), (true, "aborted")] {
        let server = FakeServer::start(&fixture);
        let uri = format!("http://{}/", server.addr).parse().unwrap();
        let host = Fixture(server.addr);
        let mut http = Http::new(&host, &uri, "fixture-discovery/1", None, true).unwrap();
        let start = Instant::now();
        let result = scanners::scan(
            Scanner::OpenAi,
            false,
            &mut http,
            start + Duration::from_millis(200),
            &|| cancel && start.elapsed() >= Duration::from_millis(100),
        );
        assert_eq!(result.err(), Some(Error::network(reason)));
        assert_eq!(server.received().len(), 1);
        assert!(start.elapsed() < Duration::from_millis(350));
    }
}

#[test]
fn decoded_gzip_respects_the_page_size_limit() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use flate2::{write::GzEncoder, Compression};
    use plur1bus_discovery::scanners::{Page, Port};
    use std::io::Write;

    let bytes =
        serde_json::to_vec(&json!({"data":[{"id":"sample","description":"a".repeat(200)}]}))
            .unwrap();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&bytes).unwrap();
    let compressed = encoder.finish().unwrap();
    assert!(compressed.len() < bytes.len() - 1);
    for maximum in [bytes.len(), bytes.len() - 1] {
        let server = FakeServer::start(&json!({
            "transport": "http", "exchanges": [{
                "request": {"method": "GET", "path": "/models"},
                "response": {"status": 200, "headers": {"content-type": "application/json", "content-encoding": "gzip"},
                    "chunksBase64": [STANDARD.encode(&compressed)]}
            }]
        }));
        let host = WireHost {
            address: server.addr,
        };
        let base: Uri = format!("http://{}", server.addr).parse().unwrap();
        let mut http = Http::new(&host, &base, "fixture", None, true).unwrap();
        let result = http.get(Page {
            path: "/models",
            query: vec![],
            headers: Default::default(),
            max_bytes: maximum,
            deadline: Instant::now() + Duration::from_secs(2),
        });
        if maximum == bytes.len() {
            assert_eq!(result.unwrap(), bytes);
        } else {
            assert_eq!(result.unwrap_err().reason, "response_too_large");
        }
    }
}

#[test]
fn scanner_cancellation_interrupts_a_wait_for_headers_or_body() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::OnceLock;

    let limit = Duration::from_millis(500);
    for headers in [
        &b""[..],
        &b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"[..],
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = Fixture(listener.local_addr().unwrap());
        let base = format!("http://{}/", host.0).parse().unwrap();
        let mut http = Http::new(&host, &base, "fixture", None, true).unwrap();
        let cancelled_at = OnceLock::new();
        let (result, elapsed) = std::thread::scope(|scope| {
            scope.spawn(|| {
                let (socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(4)))
                    .unwrap();
                let mut socket = BufReader::new(socket);
                let mut line = String::new();
                loop {
                    line.clear();
                    assert_ne!(socket.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                socket.get_mut().write_all(headers).unwrap();
                std::thread::sleep(Duration::from_millis(150));
                cancelled_at.set(Instant::now()).unwrap();
                // Hold the response open until the cancelled client closes it.
                assert_eq!(socket.read(&mut [0; 1]).unwrap(), 0);
            });
            let result = scanners::scan(
                Scanner::OpenAi,
                false,
                &mut http,
                Instant::now() + Duration::from_secs(2),
                &|| cancelled_at.get().is_some(),
            );
            (result, cancelled_at.get().unwrap().elapsed())
        });
        assert_eq!(result.err(), Some(Error::network("aborted")));
        assert!(
            elapsed < limit,
            "headers={} elapsed={elapsed:?}",
            !headers.is_empty()
        );
    }
}

#[test]
fn remote_cleartext_requires_manual_configuration_and_no_lease() {
    struct Configured;
    impl Admission for Configured {
        fn pin(&self, _: &Uri, _: Instant) -> Result<SocketAddr> {
            panic!("configuration checks must run before network admission");
        }
        fn configured_cleartext(&self, base: &Uri) -> bool {
            matches!(
                base.host(),
                Some(
                    "models.example.invalid"
                        | "localhost"
                        | "127.0.0.1"
                        | "127.1"
                        | "[::ffff:127.0.0.1]"
                )
            )
        }
        fn now_ms(&self) -> i64 {
            0
        }
    }
    let manual: Uri = "http://models.example.invalid:11434".parse().unwrap();
    assert!(Http::new(&Configured, &manual, "fixture", None, false).is_ok());

    let unauthorized: Uri = "http://discovered.example.invalid:11434".parse().unwrap();
    let origin = Url::parse(&manual.to_string()).unwrap();
    let lease = Lease {
        origin: &origin,
        header: CredentialHeader::Bearer("fixture"),
    };
    for (uri, lease) in [(&unauthorized, None), (&manual, Some(lease))] {
        let error = Http::new(&Configured, uri, "fixture", lease, true)
            .err()
            .unwrap();
        assert_eq!(error.reason, "insecure_transport");
    }
    for host in ["localhost", "127.0.0.1"] {
        let base = format!("http://{host}:11434");
        let uri: Uri = base.parse().unwrap();
        let origin = Url::parse(&base).unwrap();
        let lease = Lease {
            origin: &origin,
            header: CredentialHeader::Bearer("fixture"),
        };
        for supplied in [None, Some(lease)] {
            assert_eq!(
                Http::new(&Configured, &uri, "fixture", supplied, false)
                    .err()
                    .unwrap()
                    .reason,
                "insecure_transport"
            );
        }
    }
    for raw in ["http://127.1:11434", "http://[::ffff:127.0.0.1]:11434"] {
        let uri = raw.parse().unwrap();
        let error = Http::new(&Configured, &uri, "fixture", None, true)
            .err()
            .unwrap();
        assert_eq!(error.reason, "insecure_transport");
    }
}
