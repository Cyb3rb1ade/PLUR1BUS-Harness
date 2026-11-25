#![cfg(all(feature = "discord", feature = "slack"))]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_channels::discord::gateway::{Event, Gateway, Session};
use plur1bus_channels::slack::socket::{Outcome, SocketMode};
use plur1bus_channels::websocket::{Error, Limits, Peer, Socket};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use url::Url;

#[path = "support/socket.rs"]
mod socket;
use socket::Loopback;

fn connect(port: &Loopback, limits: Limits) -> Socket<'_> {
    let endpoint = Url::parse(&format!("ws://{}/gateway", port.0)).unwrap();
    Socket::connect(&endpoint, &[], port, limits, true).unwrap()
}

fn read_text(socket: &mut Socket<'_>) -> String {
    let Peer::Text(text) = socket.receive(Duration::from_secs(1)).unwrap() else {
        panic!("expected text frame");
    };
    text
}

#[test]
fn discord_identifies_and_resumes_then_uses_sequence_in_heartbeat() {
    const CREDENTIAL: &str = "synthetic-discord-marker";
    for name in ["discord-identify", "discord-resume"] {
        let mut fixture = load_fixture("channels", name);
        fixture["exchanges"] = serde_json::from_str::<Value>(
            &fixture["exchanges"]
                .to_string()
                .replace("[FIXTURE:DISCORD]", CREDENTIAL),
        )
        .unwrap();
        let server = FakeServer::start(&fixture);
        let port = Loopback(server.addr);
        let mut socket = connect(&port, Limits::default());
        let initial: Option<Session> =
            serde_json::from_value(fixture["initialSession"].clone()).unwrap();
        let mut gateway = Gateway::new(CREDENTIAL, 513, "fixture-os", "42", initial);
        let endpoint = Url::parse("wss://gateway.discord.gg").unwrap();
        gateway.open(0);
        let mut now = 0;
        let mut observed = Vec::new();
        let mut close = Value::Null;
        for step in fixture["steps"].as_array().unwrap() {
            let events = if let Some(advance) = step["advance"].as_u64() {
                now += advance;
                gateway.tick(now).into_iter().collect()
            } else {
                let raw = read_text(&mut socket);
                assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), step["frame"]);
                gateway.receive(&raw, now, 0.5, &endpoint)
            };
            let mut sent = Vec::new();
            for event in events {
                match event {
                    Event::Send(raw) => {
                        socket.send_text(&raw).unwrap();
                        sent.push(raw.replace(CREDENTIAL, "[FIXTURE:DISCORD]"));
                    }
                    Event::Dispatch(name, data) => {
                        observed.push(json!({"dispatch": name, "data": data}))
                    }
                    Event::Ready {
                        session_id,
                        resumed,
                        ..
                    } => observed.push(json!({"ready": session_id, "resumed": resumed})),
                    Event::Close { code, reason } => {
                        close = json!({"code": code, "reason": reason});
                    }
                    Event::Persist => {}
                }
            }
            assert_eq!(json!(sent), step["sent"], "{name}");
        }
        socket.close(1000, "test finished").unwrap();
        assert!(matches!(
            socket.receive(Duration::from_secs(1)),
            Ok(Peer::Closed(_))
        ));
        assert_eq!(server.received().len(), 3);
        assert_eq!(
            json!({"events": observed, "close": close, "session": gateway.session()}),
            fixture["expected"]
        );
    }
}

#[test]
fn slack_reacks_duplicates_without_redispatch() {
    let fixture = load_fixture("channels", "slack-socket");
    let server = FakeServer::start(&fixture);
    let port = Loopback(server.addr);
    let mut socket = connect(&port, Limits::default());
    let mut mode = SocketMode::default();
    let mut connection = mode.new_connection();
    let mut observed = Vec::new();
    let mut ack_count = 0;
    for step in fixture["steps"].as_array().unwrap() {
        let text = read_text(&mut socket);
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), step["frame"]);
        let mut sent = Vec::new();
        let event = mode.receive(&mut connection, &text, |ack| {
            socket.send_text(ack).unwrap();
            sent.push(ack.to_owned());
            ack_count += 1;
            Ok(())
        });
        match event {
            Outcome::Hello => observed.push(json!({"connected": true})),
            Outcome::Envelope { value, acked } => {
                assert!(acked);
                observed.push(json!({"received": value["envelope_id"], "ackCount": ack_count}));
            }
            Outcome::Fatal(code) => observed.push(json!({"fatal": code})),
            Outcome::Ignored | Outcome::Refresh | Outcome::Closed => {}
        }
        assert_eq!(json!(sent), step["sent"]);
    }
    assert_eq!(server.received().len(), 3);
    assert_eq!(json!({"events": observed}), fixture["expected"]);
}

#[test]
fn discord_gateway_delivers_the_same_message_ids_as_the_channel() {
    let fixture = load_fixture("channels", "channel-admission");
    let discord = &fixture["discord"];
    let mut gateway = Gateway::new("test", 0, "test", discord["botId"].as_str().unwrap(), None);
    let endpoint = Url::parse("wss://gateway.discord.gg").unwrap();
    let mut delivered = Vec::new();
    for message in discord["messages"].as_array().unwrap() {
        let frame = json!({"op": 0, "t": "MESSAGE_CREATE", "d": message});
        for event in gateway.receive(&frame.to_string(), 0, 0.5, &endpoint) {
            if let Event::Dispatch(_, data) = event {
                delivered.push(data["id"].clone());
            }
        }
    }
    assert_eq!(json!(delivered), discord["delivered"]);
}

#[test]
fn slack_socket_acks_filtered_messages_without_dispatching_them() {
    let fixture = load_fixture("channels", "channel-admission");
    let slack = &fixture["slack"];
    let mut mode = SocketMode::with_bot_user_id(slack["botId"].as_str().unwrap().to_owned());
    let mut connection = mode.new_connection();
    mode.receive(&mut connection, r#"{"type":"hello"}"#, |_| Ok(()));
    let mut delivered = Vec::new();
    for envelope in slack["envelopes"].as_array().unwrap() {
        let mut acked = false;
        if let Outcome::Envelope { value, .. } =
            mode.receive(&mut connection, &envelope.to_string(), |_| {
                acked = true;
                Ok(())
            })
        {
            delivered.push(value["payload"]["event"]["ts"].clone());
        }
        assert!(acked);
    }
    assert_eq!(json!(delivered), slack["delivered"]);
}

#[test]
fn a_silent_peer_hits_the_read_deadline() {
    let server = FakeServer::start(&json!({"transport":"websocket", "exchanges":[]}));
    let port = Loopback(server.addr);
    let mut socket = connect(&port, Limits::default());
    let before = Instant::now();
    assert!(matches!(
        socket.receive(Duration::from_millis(35)),
        Err(Error::Timeout)
    ));
    assert!(before.elapsed() < Duration::from_secs(1));
}

#[test]
fn the_text_frame_byte_limit_is_inclusive() {
    // The string's two JSON quote bytes count toward the frame's payload.
    for text in ["123456", "1234567"] {
        let fixture = json!({"transport":"websocket", "exchanges":[{"send":[],"receive":[text]}]});
        let server = FakeServer::start(&fixture);
        let port = Loopback(server.addr);
        let mut socket = connect(
            &port,
            Limits {
                message_bytes: 64,
                frame_bytes: 8,
                ..Limits::default()
            },
        );
        let result = socket.receive(Duration::from_secs(1));
        if text.len() == 6 {
            assert!(matches!(result, Ok(Peer::Text(_))));
        } else {
            assert!(matches!(result, Err(Error::Capacity)));
        }
    }
}

#[test]
fn a_fragmented_message_has_its_own_limit() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use plur1bus_wire_fixtures::frame;
    for last in [b"5678".as_slice(), b"56789".as_slice()] {
        let mut first = frame(0x1, b"1234", None);
        first[0] &= 0x7f; // Followed by a final continuation frame.
        let last_frame = frame(0x0, last, None);
        let fixture = json!({"transport":"websocket", "exchanges":[{
            "send":[], "receive":[], "rawFramesBase64":[STANDARD.encode(first), STANDARD.encode(last_frame)]
        }]});
        let server = FakeServer::start(&fixture);
        let port = Loopback(server.addr);
        let mut socket = connect(
            &port,
            Limits {
                message_bytes: 8,
                frame_bytes: 6,
                ..Limits::default()
            },
        );
        let result = socket.receive(Duration::from_secs(1));
        if last.len() == 4 {
            assert!(matches!(result, Ok(Peer::Text(ref text)) if text == "12345678"));
        } else {
            assert!(matches!(result, Err(Error::Capacity)));
        }
    }
}

#[test]
fn websocket_handshake_limits_the_retry_interval_to_one_hour() {
    use std::io::{BufRead, BufReader, Write};
    let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let addr = server.local_addr().unwrap();
    let thread = std::thread::spawn(move || {
        let (mut peer, _) = server.accept().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        for line in BufReader::new(&peer).lines() {
            if line.unwrap().is_empty() {
                break;
            }
        }
        peer.write_all(
            b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3601\r\nContent-Length: 0\r\n\r\n",
        )
        .unwrap();
    });
    let ports = Loopback(addr);
    let url = Url::parse(&format!("ws://{addr}/gateway")).unwrap();
    assert!(matches!(
        Socket::connect(&url, &[], &ports, Limits::default(), true),
        Err(Error::Handshake {
            status: 429,
            retry_after_ms: Some(3_600_000)
        })
    ));
    thread.join().unwrap();
}
