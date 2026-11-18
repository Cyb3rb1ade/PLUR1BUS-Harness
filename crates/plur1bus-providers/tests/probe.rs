#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_providers::local::{probe_endpoint, Dialect, ProbeOptions};
use plur1bus_providers::{Ports, ProviderError, Wire};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::json;
use std::net::SocketAddr;
use url::Url;

struct Local(SocketAddr);

impl Ports for Local {
    fn pin(&self, uri: &Url) -> Result<SocketAddr, ProviderError> {
        assert_eq!(uri.host_str(), Some("127.0.0.1"));
        Ok(self.0)
    }

    fn credential(&self, _: Wire) -> Result<Option<String>, ProviderError> {
        panic!("model probes must never look up credentials")
    }
}

#[test]
fn replays_keyless_local_dialect_selection() {
    let fixture = load_fixture("provider-local", "http-probe");
    for case in fixture["cases"].as_array().unwrap() {
        let server =
            FakeServer::start(&json!({"transport": "http", "exchanges": case["exchanges"]}));
        let origin = format!("http://{}", server.addr);
        let dialects = case["dialects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| match name.as_str().unwrap() {
                "ollama" => Dialect::Ollama,
                "openai" => Dialect::OpenAi,
                _ => panic!("unknown recorded probe dialect"),
            })
            .collect::<Vec<_>>();
        let result = probe_endpoint(
            &origin,
            &dialects,
            ProbeOptions::default(),
            &Local(server.addr),
        )
        .unwrap();
        let mut expected = case["expected"].clone();
        expected["baseUrl"] = json!(expected["baseUrl"]
            .as_str()
            .unwrap()
            .replace("@origin@", &origin));
        assert_eq!(json!(result), expected, "{}", case["name"]);
        let expected_requests = case["exchanges"].as_array().unwrap();
        let requests = server.received();
        assert_eq!(requests.len(), expected_requests.len());
        for (seen, exchange) in requests.iter().zip(expected_requests) {
            let wanted = &exchange["request"];
            assert_eq!(seen["path"], wanted["path"]);
            assert_eq!(seen["method"], wanted["method"]);
            assert_eq!(seen["body"], wanted["bodyText"]);
            assert_eq!(seen["headers"]["accept"], wanted["accept"]);
            assert!(seen["headers"].get("authorization").is_none());
        }
    }
}
