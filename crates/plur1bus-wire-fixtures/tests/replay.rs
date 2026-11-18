//! Parity mode W: request/response round trips against the Rust fake server, from the fixtures recorded off the
//! TypeScript fake servers (`fixtures/parity/wire/`). Loopback only.
#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_wire_fixtures::client::{http, Ws};
use plur1bus_wire_fixtures::{fixture, FakeServer};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

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
    for path in ["/v1/not-recorded", "/v1/responses"] {
        let (status, reply) = http(server.addr, "GET", path, None);
        assert_eq!(status, 501);
        assert_eq!(
            reply,
            json!({"fake": format!("no recorded exchange for GET {path}")})
        );
    }
}

/// The fake's `Sec-WebSocket-Accept` is checked against the one the TypeScript fake computed with node:crypto for the
/// same key, so a wrong GUID or digest here cannot hide behind the client using the same function.
#[test]
fn the_websocket_accept_key_is_the_one_the_typescript_fake_computes() {
    let handshake = &fixture("voice-ws")["handshake"];
    assert_eq!(
        plur1bus_wire_fixtures::ws_accept(handshake["key"].as_str().unwrap()),
        handshake["accept"].as_str().unwrap()
    );
}

#[test]
fn the_recorded_websocket_conversation_round_trips_from_the_fixture() {
    replay_websocket("voice-ws");
}

#[test]
fn a_recorded_server_first_websocket_exchange_precedes_client_messages() {
    replay_websocket("voice-ws-server-first");
}

fn replay_websocket(name: &str) {
    let recorded = fixture(name);
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

#[test]
fn sse_replays_recorded_response_chunks_and_captures_request_bytes() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let recorded = fixture("openai-sse");
    let exchange = &recorded["exchanges"][0];
    let request = &exchange["request"];
    let body = request["bodyText"].as_str().unwrap();
    let server = FakeServer::start(&recorded);
    let sent = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: {}\r\nAccept: {}\r\nContent-Length: {}\r\n\r\n{body}",
        request["path"].as_str().unwrap(),
        server.addr,
        request["headers"]["content-type"].as_str().unwrap(),
        request["headers"]["accept"].as_str().unwrap(),
        body.len()
    );
    let bytes = raw_http(server.addr, sent.as_bytes());
    let head_end = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    let head = std::str::from_utf8(&bytes[..head_end]).unwrap();
    assert!(head.starts_with("HTTP/1.1 200 "));
    assert!(head.contains("content-type: text/event-stream; charset=utf-8\r\n"));
    assert!(head.contains("cache-control: no-cache\r\n"));
    assert!(head.contains("transfer-encoding: chunked\r\n"));
    let mut expected = Vec::new();
    for chunk in exchange["response"]["chunksBase64"].as_array().unwrap() {
        let chunk = STANDARD.decode(chunk.as_str().unwrap()).unwrap();
        write!(expected, "{:x}\r\n", chunk.len()).unwrap();
        expected.extend(chunk);
        expected.extend(b"\r\n");
    }
    expected.extend(b"0\r\n\r\n");
    assert_eq!(&bytes[head_end..], expected);

    let got = &server.received()[0];
    assert_eq!(got["method"], request["method"]);
    assert_eq!(got["path"], request["path"]);
    assert_eq!(got["bodyBase64"], STANDARD.encode(body.as_bytes()));
    for (name, value) in request["headers"].as_object().unwrap() {
        assert_eq!(&got["headers"][name], value, "{name}");
    }
}

fn connect(addr: SocketAddr) -> TcpStream {
    let socket = TcpStream::connect(addr).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    socket
}

fn raw_http(addr: SocketAddr, request: &[u8]) -> Vec<u8> {
    let mut socket = connect(addr);
    socket.write_all(request).unwrap();
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).unwrap();
    bytes
}

#[test]
fn ambiguous_or_oversized_http_bodies_do_not_consume_a_recording() {
    let server = FakeServer::start(&fixture("openai-http"));
    let request_line = "GET /v1/models HTTP/1.1\r\n";
    for headers in [
        "Content-Length: 1048577\r\n",
        "Content-Length: missing\r\n",
        "Transfer-Encoding: chunked\r\n",
    ] {
        let request = format!("{request_line}{headers}\r\n");
        assert!(
            raw_http(server.addr, request.as_bytes()).is_empty(),
            "{headers}"
        );
    }
    assert!(server.received().is_empty());
    assert_eq!(http(server.addr, "GET", "/v1/models", None).0, 200);
}

#[test]
fn a_body_at_the_http_limit_is_captured_without_text_normalization() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let server = FakeServer::start(&fixture("openai-http"));
    assert!(server.addr.ip().is_loopback());
    let mut body = vec![0xff; 1048576];
    body[..3].copy_from_slice(b"\r\n\0");
    let mut request = format!(
        "GET /v1/models HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(&body);
    assert!(raw_http(server.addr, &request).starts_with(b"HTTP/1.1 200 "));
    assert_eq!(server.received()[0]["bodyBase64"], STANDARD.encode(body));
}

#[test]
fn dropping_the_server_closes_idle_clients() {
    let server = FakeServer::start(&fixture("openai-http"));
    let mut idle = connect(server.addr);
    // Leave the first client waiting to finish its HTTP headers while the second gets a reply.
    idle.write_all(b"GET /v1/models HTTP/1.1\r\n").unwrap();
    assert_eq!(http(server.addr, "GET", "/v1/models", None).0, 200);
    drop(server);
    assert_eq!(idle.read(&mut [0]).unwrap(), 0);
}
