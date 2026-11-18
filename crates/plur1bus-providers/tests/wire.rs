#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used)]

use plur1bus_providers::{
    Adapter, Config, Json, Ports, ProviderError, ToolRepair, ToolRepairInput, Wire,
};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, Value};
use std::net::SocketAddr;
use url::Url;

struct FixturePorts(SocketAddr, bool);

impl Ports for FixturePorts {
    fn pin(&self, uri: &Url) -> Result<SocketAddr, ProviderError> {
        assert_eq!(uri.host_str(), Some("fixture.invalid"));
        Ok(self.0)
    }

    fn credential(&self, wire: Wire) -> Result<Option<String>, ProviderError> {
        let value = if matches!(wire, Wire::ChatCompletions | Wire::CodexResponses) {
            "Bearer fixture-credential"
        } else {
            "fixture-credential"
        };
        Ok(Some(value.into()))
    }

    fn repair_tool_arguments(&self, input: ToolRepairInput<'_>) -> Option<ToolRepair> {
        if !self.1 {
            return None;
        }
        assert_eq!(input.name, "inspect");
        assert_eq!(input.id, "call_fixture");
        assert_eq!(input.arguments_raw, "{");
        assert_eq!(input.error, "arguments are not valid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)");
        assert_eq!(input.tool.unwrap()["name"].text(), "inspect");
        Some(ToolRepair::Object(
            Json::parse(r#"{"fixed":true}"#).unwrap(),
        ))
    }
}

const WIRES: [(Wire, &str); 4] = [
    (Wire::ChatCompletions, "chat-completions"),
    (Wire::AnthropicMessages, "anthropic-messages"),
    (Wire::CodexResponses, "codex-responses"),
    (Wire::Gemini, "gemini"),
];

fn replay(wire: Wire, recording: &Value, exchange: &Value) {
    let mut isolated = recording.clone();
    isolated["exchanges"] = json!([exchange]);
    let server = FakeServer::start(&isolated);
    let config = Config {
        allow_insecure_http: true,
        allow_missing_done: exchange["options"]["allowMissingDone"].as_bool().unwrap(),
        ..Config::default()
    };
    let adapter = Adapter::new(
        wire,
        &format!("http://fixture.invalid:{}/v1", server.addr.port()),
        config,
    )
    .unwrap();
    let call = Json::parse(exchange["requestJson"].as_str().unwrap()).unwrap();
    let ports = FixturePorts(
        server.addr,
        exchange["options"]["repair"].as_bool().unwrap_or(false),
    );
    let mut events = Vec::new();
    let outcome = if exchange["mode"] == "stream" {
        adapter
            .stream(&call, &ports, &mut |event| events.push(event))
            .map(|()| None)
    } else {
        adapter.complete(&call, &ports).map(Some)
    };
    let name = &exchange["name"];
    let seen = server.received();
    assert_eq!(seen.len(), 1, "{name}");
    let seen = &seen[0];
    for key in ["method", "path"] {
        assert_eq!(seen[key], exchange["request"][key], "{name}: {key}");
    }
    assert_eq!(
        seen["body"], exchange["request"]["bodyText"],
        "{name}: body bytes"
    );
    for (key, value) in exchange["request"]["headers"].as_object().unwrap() {
        assert_eq!(
            seen["headers"][key],
            value
                .as_str()
                .unwrap()
                .replace("[REDACTED:secret]", "fixture-credential"),
            "{name}: {key}"
        );
    }
    assert_eq!(
        json!(events),
        exchange["expected"]["events"],
        "{name}: events"
    );
    match outcome {
        Ok(result) => assert_eq!(
            json!(result),
            exchange["expected"]["result"],
            "{name}: result"
        ),
        Err(error) => assert_eq!(json!(error), exchange["expected"]["error"], "{name}: error"),
    }
}

#[test]
fn recorded_empty_bodies_agree_across_http_statuses() {
    for (wire, name) in WIRES {
        let recording = load_fixture("providers", &format!("{name}-bodyless"));
        let exchanges = recording["exchanges"].as_array().unwrap();
        assert_eq!(exchanges.len(), 24);
        for exchange in exchanges {
            if matches!(exchange["response"]["status"].as_u64(), Some(204 | 205)) {
                assert_eq!(exchange["expected-divergence"], "P4D-40");
                assert_eq!(
                    exchange["typescriptConstructor"],
                    json!({"throws": "TypeError"})
                );
            }
            replay(wire, &recording, exchange);
        }
    }
}

#[test]
fn each_wire_replays_complete_stream_and_truncation() {
    for (wire, name) in WIRES {
        let recording = load_fixture("providers", &format!("{name}-protocol"));
        for exchange in recording["exchanges"].as_array().unwrap() {
            replay(wire, &recording, exchange);
        }
    }
}

#[test]
fn response_size_is_checked_at_the_limit() {
    let recording = load_fixture("providers", "chat-completions-protocol");
    let mut exchange = recording["exchanges"][0].clone();
    exchange["response"]["chunksBase64"] = json!(["e30="]);
    let input = Json::parse(exchange["requestJson"].as_str().unwrap()).unwrap();
    for (limit, message) in [
        (1, "response body exceeds 1 bytes"),
        (
            2,
            "malformed chat_completions response: choices is missing or empty",
        ),
    ] {
        let server = FakeServer::start(&json!({"transport": "http", "exchanges": [exchange]}));
        let adapter = Adapter::new(
            Wire::ChatCompletions,
            &format!("http://fixture.invalid:{}/v1", server.addr.port()),
            Config {
                allow_insecure_http: true,
                max_body_bytes: limit,
                ..Config::default()
            },
        )
        .unwrap();
        let error = adapter
            .complete(&input, &FixturePorts(server.addr, false))
            .unwrap_err();
        assert_eq!(error.message.as_ref(), message);
    }
}

#[test]
fn timed_stream_keeps_its_idle_and_total_deadlines_separate() {
    use plur1bus_providers::{TimeoutPhase, Timeouts};
    use std::time::Duration;

    let recording = load_fixture("providers", "chat-completions-protocol");
    let exchange = recording["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|exchange| exchange["name"] == "stream-tools-and-usage")
        .unwrap();
    let input = Json::parse(exchange["requestJson"].as_str().unwrap()).unwrap();
    // Keep the inter-chunk gap comfortably within the idle limit in the success case.
    for (gap, idle, total, expected) in [
        (45, 300, 5000, None),
        (250, 40, 5000, Some(TimeoutPhase::Idle)),
        (250, 600, 100, Some(TimeoutPhase::Total)),
    ] {
        let mut exchange = exchange.clone();
        let chunks = exchange["response"]["chunksBase64"].as_array_mut().unwrap();
        chunks.splice(..0, std::iter::repeat_n(json!("OiBwaW5nCgo="), 10));
        exchange["response"]["chunkGapMs"] = json!(gap);
        let server = FakeServer::start(&json!({"transport": "http", "exchanges": [exchange]}));
        let adapter = Adapter::new(
            Wire::ChatCompletions,
            &format!("http://fixture.invalid:{}/v1", server.addr.port()),
            Config {
                allow_insecure_http: true,
                timeouts: Some(Timeouts {
                    headers: Some(Duration::from_secs(2)),
                    idle: Some(Duration::from_millis(idle)),
                    total: Some(Duration::from_millis(total)),
                }),
                ..Config::default()
            },
        )
        .unwrap();
        let result = adapter.stream(&input, &FixturePorts(server.addr, false), &mut |_| {});
        match expected {
            None => assert!(result.is_ok(), "{result:?}"),
            Some(phase) => assert_eq!(result.unwrap_err().timeout_phase, Some(phase)),
        }
    }
}

#[test]
fn credentialed_plain_http_is_refused_before_dialling() {
    let recording = load_fixture("providers", "chat-completions-protocol");
    let input = Json::parse(recording["exchanges"][0]["requestJson"].as_str().unwrap()).unwrap();
    let server = FakeServer::start(&recording);
    let adapter = Adapter::new(
        Wire::ChatCompletions,
        &format!("http://fixture.invalid:{}/v1", server.addr.port()),
        Config::default(),
    )
    .unwrap();
    let error = adapter
        .complete(&input, &FixturePorts(server.addr, false))
        .unwrap_err();
    assert_eq!(error.kind, plur1bus_providers::ErrorKind::InvalidRequest);
    assert!(server.received().is_empty());
}
