#![allow(clippy::unwrap_used, reason = "deterministic fixture assertions")]

use plur1bus_voice_providers::{
    catalog::{Catalog, Vendor},
    http::{Client, Error, Ports},
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;

struct RetryPort {
    address: SocketAddr,
    now: SystemTime,
    waits: Mutex<Vec<u64>>,
}

impl Ports for RetryPort {
    fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
        Some(self.address)
    }

    fn wall_time(&self) -> SystemTime {
        self.now
    }

    fn wait_retry(&self, delay: Duration, _: Instant) -> Result<(), Error> {
        self.waits.lock().unwrap().push(delay.as_millis() as u64);
        Ok(())
    }
}

#[test]
fn retries_match_recorded_delays_and_statuses() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/voice/http-retry.json"
    ))
    .unwrap();
    for case in fixture["scenarios"].as_array().unwrap() {
        let server =
            FakeServer::start(&json!({"transport": "http", "exchanges": case["exchanges"]}));
        let ports = RetryPort {
            address: server.addr,
            now: UNIX_EPOCH + Duration::from_millis(fixture["nowMs"].as_u64().unwrap()),
            waits: Mutex::new(Vec::new()),
        };
        let client = Client::new(&ports).with_loopback_http();
        let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
        let catalog = Catalog::new(client, base, Vendor::ElevenLabs).unwrap();
        let outcome =
            match catalog.list_models("synthetic-voice-credential", Duration::from_secs(60)) {
                Ok(models) => json!({"models": models}),
                Err(error) => json!({"code":error.code(),"retryAfterMs":error.retry_after_ms()}),
            };
        assert_eq!(outcome, case["expected"]);
        assert_eq!(json!(*ports.waits.lock().unwrap()), case["waits"]);
        assert_eq!(
            server.received().len(),
            case["exchanges"].as_array().unwrap().len()
        );
    }
}

#[test]
fn a_retry_that_cannot_fit_the_request_deadline_is_refused() {
    let server = FakeServer::start(&json!({
        "transport":"http", "exchanges": [{
            "request":{"method":"GET","path":"/models"},
            "response":{"status":429,"headers":{"retry-after":"30"},"body":{}}
        }]
    }));
    let ports = RetryPort {
        address: server.addr,
        now: UNIX_EPOCH,
        waits: Mutex::new(Vec::new()),
    };
    let client = Client::new(&ports).with_loopback_http();
    let url = Url::parse(&format!("http://{}/models", server.addr)).unwrap();

    assert_eq!(
        client.json(&url, "GET", &[], b"", Duration::from_secs(2)),
        Err(Error::Timeout)
    );
    assert!(ports.waits.lock().unwrap().is_empty());
    assert_eq!(server.received().len(), 1);
}

#[test]
fn synthesis_post_retries_only_an_explicit_preprocessing_refusal() {
    for (status, retry_after, retries) in [
        (429, None, false),
        (503, None, false),
        (502, Some("0"), false),
        (429, Some("0"), true),
        (503, Some("0"), true),
    ] {
        let mut headers = json!({});
        if let Some(value) = retry_after {
            headers["retry-after"] = json!(value);
        }
        let server = FakeServer::start(&json!({"transport":"http","exchanges":[
            {"request":{"method":"POST","path":"/synthesis"},"response":{"status":status,"headers":headers,"body":{}}},
            {"request":{"method":"POST","path":"/synthesis"},"response":{"status":200,"body":{"ok":true}}}
        ]}));
        let ports = RetryPort {
            address: server.addr,
            now: UNIX_EPOCH,
            waits: Mutex::new(Vec::new()),
        };
        let client = Client::new(&ports).with_loopback_http();
        let endpoint = Url::parse(&format!("http://{}/synthesis", server.addr)).unwrap();
        let reply = client.json(
            &endpoint,
            "POST",
            &[("content-type", "application/json")],
            b"{}",
            Duration::from_secs(2),
        );
        assert_eq!(
            reply.is_ok(),
            retries,
            "status {status}, retry-after {retry_after:?}"
        );
        assert_eq!(server.received().len(), 1 + usize::from(retries));
        assert_eq!(ports.waits.lock().unwrap().len(), usize::from(retries));
    }
}
