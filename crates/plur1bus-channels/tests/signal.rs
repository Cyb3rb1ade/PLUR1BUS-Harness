#![cfg(feature = "signal")]
#![allow(clippy::unwrap_used)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_channels::signal::{Event, JsonRpc};
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[test]
fn replays_out_of_order_rpc_and_bounds_incoming_lines() {
    for name in ["signal-rpc", "signal-oversize"] {
        let fixture = load_fixture("channels", name);
        let server = FakeServer::start(&fixture);
        let mut stream = TcpStream::connect_timeout(&server.addr, Duration::from_secs(1)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut rpc = JsonRpc::new(fixture["maxLineBytes"].as_u64().unwrap() as usize);
        let mut sent = Vec::new();
        for call in fixture["calls"].as_array().unwrap() {
            let method = call["method"].as_str().unwrap();
            let params = serde_json::from_str(call["paramsJson"].as_str().unwrap()).unwrap();
            let request = rpc
                .call(method, params, 0, call["timeout"].as_u64().unwrap())
                .unwrap();
            stream.write_all(&request.bytes).unwrap();
            sent.push(json!(STANDARD.encode(request.bytes)));
        }

        let mut outcomes = Vec::new();
        let mut notifications = Vec::new();
        let mut closures = Vec::new();
        let mut record = |event, stream: &mut TcpStream| match event {
            Event::Reply { id, result } => outcomes.push(result.map_or_else(
                |error| json!({"id": id, "error": error}),
                |data| json!({"id": id, "result": data}),
            )),
            Event::Notification { method, params } => {
                notifications.push(json!({"method": method, "params": params}))
            }
            Event::Closed(reason) => closures.push(reason),
            Event::Write(bytes) => {
                stream.write_all(&bytes).unwrap();
                sent.push(json!(STANDARD.encode(bytes)));
            }
        };
        for chunk in fixture["exchanges"][0]["receiveChunksBase64"]
            .as_array()
            .unwrap()
        {
            let expected = STANDARD.decode(chunk.as_str().unwrap()).unwrap();
            let mut received = vec![0; expected.len()];
            stream.read_exact(&mut received).unwrap();
            assert_eq!(received, expected);
            for event in rpc.feed(&received) {
                record(event, &mut stream);
            }
        }
        for event in rpc.expire(2000) {
            record(event, &mut stream);
        }
        let mut end = [0u8; 1];
        assert_eq!(stream.read(&mut end).unwrap(), 0, "{name}");
        assert_eq!(server.received(), sent);
        let recorded: Vec<Value> = fixture["exchanges"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|e| e["sendBase64"].as_array().unwrap().iter().cloned())
            .collect();
        assert_eq!(sent, recorded);
        assert_eq!(
            json!({"outcomes":outcomes, "notifications":notifications, "closures":closures}),
            fixture["expected"],
            "{name}"
        );
    }
}
