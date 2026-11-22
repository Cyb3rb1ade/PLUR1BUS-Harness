#![allow(clippy::unwrap_used, reason = "recorded loopback fixture")]

use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use plur1bus_discovery::{
    http::{Admission, Http, Lease},
    scanners::{self, Error, Page, Result, Scanner},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use ureq::http::Uri;

struct Fixture(SocketAddr);
impl Admission for Fixture {
    fn endpoint(&self, _page: &Page<'_>) -> Result<Uri> {
        Ok(format!("http://{}/models", self.0).parse().unwrap())
    }

    fn redirect(&self, _from: &Uri, location: &str) -> Result<Uri> {
        Ok(format!("http://{}{location}", self.0).parse().unwrap())
    }

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
    let base = format!("http://{}/", server.addr).parse().unwrap();
    let mut http = Http::new(
        &host,
        &base,
        "fixture-discovery/1",
        Some(Lease::Bearer("fixture-header")),
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
