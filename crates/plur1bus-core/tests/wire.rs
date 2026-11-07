//! Parity mode W: request/response round trips against the Rust fake server, from the fixtures recorded off the
//! TypeScript fake servers (`fixtures/parity/wire/`). Loopback only.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use serde_json::{json, Value};
use support::client::{http, Ws};
use support::{fixture, FakeServer};

#[test]
fn every_recorded_http_exchange_round_trips_from_the_fixture() {
    let recorded = fixture("openai-http");
    let server = FakeServer::start(&recorded);
    let exchanges = recorded["exchanges"].as_array().unwrap();
    assert!(exchanges.len() >= 5);
    for exchange in exchanges {
        let request = &exchange["request"];
        let body = request.get("json").or_else(|| request.get("form"));
        let (status, reply) = http(
            server.addr,
            request["method"].as_str().unwrap(),
            request["path"].as_str().unwrap(),
            body,
        );
        assert_eq!(
            u64::from(status),
            exchange["response"]["status"],
            "{}",
            exchange["name"]
        );
        assert_eq!(reply, exchange["response"]["body"], "{}", exchange["name"]);
    }
    // The server saw exactly the recorded requests, in order.
    let seen = server.received();
    assert_eq!(seen.len(), exchanges.len());
    for (got, exchange) in seen.iter().zip(exchanges) {
        assert_eq!(got["method"], exchange["request"]["method"]);
        assert_eq!(got["path"], exchange["request"]["path"]);
        if let Some(json) = exchange["request"].get("json") {
            let sent: Value = serde_json::from_str(got["body"].as_str().unwrap()).unwrap();
            assert_eq!(&sent, json);
        }
    }
}

#[test]
fn an_unrecorded_route_is_named_instead_of_answered() {
    let server = FakeServer::start(&fixture("openai-http"));
    let (status, reply) = http(server.addr, "GET", "/v1/not-recorded", None);
    assert_eq!(status, 501);
    assert_eq!(
        reply,
        json!({"fake": "no recorded exchange for GET /v1/not-recorded"})
    );
}

/// The fake's `Sec-WebSocket-Accept` is checked against the one the TypeScript fake computed with node:crypto for the
/// same key, so a wrong GUID or digest here cannot hide behind the client using the same function.
#[test]
fn the_websocket_accept_key_is_the_one_the_typescript_fake_computes() {
    let handshake = &fixture("voice-ws")["handshake"];
    assert_eq!(
        support::ws_accept(handshake["key"].as_str().unwrap()),
        handshake["accept"].as_str().unwrap()
    );
}

#[test]
fn the_recorded_websocket_conversation_round_trips_from_the_fixture() {
    let recorded = fixture("voice-ws");
    let server = FakeServer::start(&recorded);
    let mut ws = Ws::connect(server.addr, "/");
    let exchanges = recorded["exchanges"].as_array().unwrap();
    for exchange in exchanges {
        for frame in exchange["send"].as_array().unwrap() {
            ws.send(frame);
        }
        for expected in exchange["receive"].as_array().unwrap() {
            let (opcode, payload) = ws.read();
            assert_eq!(opcode, 0x1, "{}: a text frame", exchange["name"]);
            let got: Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(&got, expected, "{}", exchange["name"]);
        }
    }
    assert_eq!(ws.close(), 0x8, "the server answers a close with a close");
    let sent: Vec<Value> = exchanges
        .iter()
        .flat_map(|e| e["send"].as_array().unwrap().clone())
        .collect();
    assert_eq!(server.received(), sent);
}

#[test]
fn a_websocket_frame_off_the_recording_ends_the_conversation() {
    let server = FakeServer::start(&fixture("voice-ws"));
    let mut ws = Ws::connect(server.addr, "/");
    ws.send(&json!({"type": "not.recorded"}));
    let (opcode, payload) = ws.read();
    assert_eq!(opcode, 0x8);
    assert_eq!(payload, 1008u16.to_be_bytes());
}
