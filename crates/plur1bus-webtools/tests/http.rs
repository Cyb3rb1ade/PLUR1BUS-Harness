#![allow(clippy::unwrap_used, reason = "recorded loopback fixture")]

use std::{
    cell::Cell,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::sync_channel,
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use plur1bus_webtools::http::{self, Admission, Failure, Options, Redirects};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use ureq::http::HeaderMap;
use url::Url;

struct Pin {
    address: SocketAddr,
    seen: Mutex<Vec<String>>,
}

impl Admission for Pin {
    fn pin(&self, target: &Url, _: Instant) -> Result<SocketAddr, Failure> {
        self.seen.lock().unwrap().push(path(target));
        Ok(self.address)
    }
}

fn path(url: &Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    }
}

#[test]
fn guarded_web_requests_replay_typescript_over_the_pinned_connector() {
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/web/http.json")).unwrap();
    let agent = data["agent"].as_str().unwrap();
    let accept = data["accept"].as_str().unwrap();
    const MARKER: &str = "fixture-web-request-marker";
    for case in data["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input = &case["options"];
        let mut headers = HeaderMap::new();
        for (name, value) in input["headers"].as_object().into_iter().flatten() {
            let value = value.as_str().unwrap();
            let value = if value == "<credential>" {
                MARKER
            } else {
                value
            };
            headers.insert(
                name.parse::<ureq::http::HeaderName>().unwrap(),
                value.parse().unwrap(),
            );
        }
        let mut options = Options::get(
            &headers,
            agent,
            accept,
            Instant::now() + Duration::from_secs(4),
        );
        if let Some(method) = input["method"].as_str() {
            options.method = method.parse().unwrap();
        }
        options.body = input["body"].as_str().map(str::as_bytes);
        options.max_redirects = input["maxRedirects"]
            .as_u64()
            .map_or(options.max_redirects, |n| n as usize);
        options.max_bytes = input["maxBytes"]
            .as_u64()
            .map_or(options.max_bytes, |n| n as usize);
        options.error_body_bytes = input["errorBodyBytes"].as_u64().map_or(0, |n| n as usize);
        options.discard_body = input["discardBody"] == true;
        options.redirects = match input["redirect"].as_str() {
            Some("error") => Redirects::Refuse,
            Some("manual") => Redirects::Manual,
            _ => Redirects::Follow,
        };
        let server = FakeServer::start(case);
        let pin = Pin {
            address: server.addr,
            seen: Mutex::new(Vec::new()),
        };
        let url = format!(
            "http://{}{}",
            server.addr,
            case["requestPath"].as_str().unwrap()
        );
        let actual = match http::request(&url, &options, &pin, &|| false) {
            Ok(response) => {
                use base64::{engine::general_purpose::STANDARD, Engine as _};
                json!({
                    "status": response.status,
                    "path": path(&response.url),
                    "redirects": response.redirects.iter().map(path).collect::<Vec<_>>(),
                    "bodyBase64": STANDARD.encode(response.body),
                })
            }
            Err(failure) => json!({"code": failure.code()}),
        };
        assert_eq!(actual, case["expected"], "{name}");
        let exchanges = case["exchanges"].as_array().unwrap();
        let served = server.received();
        assert_eq!(served.len(), exchanges.len(), "{name}");
        let expected_paths = exchanges
            .iter()
            .map(|row| row["request"]["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(*pin.seen.lock().unwrap(), expected_paths, "{name}");
        for (received, row) in served.iter().zip(exchanges) {
            let expected = &row["request"];
            for key in ["method", "path", "bodyBase64"] {
                assert_eq!(received[key], expected[key], "{name}: {key}");
            }
            for (key, value) in expected["headers"].as_object().unwrap() {
                let expected = if value == "<credential>" {
                    json!(MARKER)
                } else {
                    value.clone()
                };
                assert_eq!(received["headers"][key], expected, "{name}: {key}");
            }
        }
        assert!(!actual.to_string().contains(MARKER), "{name}");
    }
}

#[test]
fn a_cancelled_request_does_not_call_admission() {
    struct Unreachable;
    impl Admission for Unreachable {
        fn pin(&self, _: &Url, _: Instant) -> Result<SocketAddr, Failure> {
            unreachable!("an expired request must not resolve");
        }
    }
    let headers = HeaderMap::new();
    let options = Options::get(
        &headers,
        "fixture-web-tools/1",
        "text/plain",
        Instant::now() + Duration::from_secs(1),
    );
    assert_eq!(
        http::request(
            "https://fixture.invalid/notes",
            &options,
            &Unreachable,
            &|| true
        )
        .err(),
        Some(Failure::Timeout)
    );
}

#[test]
fn a_partial_page_cannot_extend_the_original_body_deadline() {
    let case = json!({"transport":"http","exchanges":[{
        "request":{"method":"GET","path":"/notes"},
        "response":{"status":200,"headers":{"content-type":"text/plain"},
            "chunksBase64":["bm90ZXM=","bW9yZQ=="],"chunkGapMs":1500}
    }]});
    let server = FakeServer::start(&case);
    let pin = Pin {
        address: server.addr,
        seen: Mutex::default(),
    };
    let headers = HeaderMap::new();
    let options = Options::get(
        &headers,
        "fixture-web-tools/1",
        "text/plain",
        Instant::now() + Duration::from_secs(1),
    );
    assert_eq!(
        http::request(
            &format!("http://{}/notes", server.addr),
            &options,
            &pin,
            &|| false
        )
        .err(),
        Some(Failure::Timeout)
    );
    assert_eq!(server.received().len(), 1);
}

#[test]
fn cancellation_during_a_body_read_keeps_the_original_deadline() {
    for (gap_ms, budget_ms) in [(200, 1500), (1500, 900)] {
        let case = json!({"transport":"http","exchanges":[{
            "request":{"method":"GET","path":"/notes"},
            "response":{"status":200,"headers":{"content-type":"text/plain"},
                "chunksBase64":["bm90ZXM=","bW9yZQ=="],"chunkGapMs":gap_ms}
        }]});
        let server = FakeServer::start(&case);
        let pin = Pin {
            address: server.addr,
            seen: Mutex::default(),
        };
        let headers = HeaderMap::new();
        let reading_body = Cell::new(false);
        let accept = |_: Option<&str>| {
            reading_body.set(true);
            true
        };
        let deadline = Instant::now() + Duration::from_millis(budget_ms);
        let mut options = Options::get(&headers, "fixture-web-tools/1", "text/plain", deadline);
        options.accept_type = Some(&accept);
        let cancelled = AtomicBool::new(false);
        let (starting_read, start) = sync_channel(1);
        let signalled = Cell::new(false);
        thread::scope(|scope| {
            let cancellation = &cancelled;
            let canceller = scope.spawn(move || {
                start.recv_timeout(Duration::from_secs(2)).unwrap();
                thread::sleep(Duration::from_millis(25));
                cancellation.store(true, Ordering::Release);
            });
            let result = http::request(
                &format!("http://{}/notes", server.addr),
                &options,
                &pin,
                &|| {
                    if reading_body.get() && !signalled.replace(true) {
                        starting_read.send(()).unwrap();
                        return false;
                    }
                    cancelled.load(Ordering::Acquire)
                },
            );
            let returned_at = Instant::now();
            canceller.join().unwrap();
            assert!(cancelled.load(Ordering::Acquire));
            assert_eq!(result.err(), Some(Failure::Timeout));
            assert!(returned_at <= deadline + Duration::from_millis(300));
        });
        assert_eq!(server.received().len(), 1);
    }
}

#[test]
fn diagnostic_prefix_is_capped_even_when_the_caller_requests_more() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    const LIMIT: usize = 64 * 1024;
    for extra in [0, 1] {
        let bytes = vec![b'n'; LIMIT + extra];
        let case = json!({"transport":"http","exchanges":[{
            "request":{"method":"GET","path":"/notes"},
            "response":{"status":429,"headers":{"content-type":"text/plain"},
                "chunksBase64":[STANDARD.encode(&bytes)]}
        }]});
        let server = FakeServer::start(&case);
        let pin = Pin {
            address: server.addr,
            seen: Mutex::default(),
        };
        let headers = HeaderMap::new();
        let mut options = Options::get(
            &headers,
            "fixture-web-tools/1",
            "text/plain",
            Instant::now() + Duration::from_secs(3),
        );
        options.error_body_bytes = LIMIT + 1;
        let response = http::request(
            &format!("http://{}/notes", server.addr),
            &options,
            &pin,
            &|| false,
        )
        .unwrap();
        assert_eq!(response.status, 429);
        assert_eq!(response.body, bytes[..LIMIT]);
    }
}

#[test]
fn the_port_must_attest_the_requested_socket() {
    let case = json!({"transport":"http","exchanges":[{
        "request":{"method":"GET","path":"/notes"},
        "response":{"status":200,"body":"ordinary notes"}
    }]});
    let desired = FakeServer::start(&case);
    let separate = FakeServer::start(&case);
    let pin = Pin {
        address: separate.addr,
        seen: Mutex::default(),
    };
    let headers = HeaderMap::new();
    let options = Options::get(
        &headers,
        "fixture-web-tools/1",
        "text/plain",
        Instant::now() + Duration::from_secs(3),
    );
    assert_eq!(
        http::request(
            &format!("http://{}/notes", desired.addr),
            &options,
            &pin,
            &|| false
        )
        .err(),
        Some(Failure::EgressDenied)
    );
    assert!(desired.received().is_empty() && separate.received().is_empty());
}
