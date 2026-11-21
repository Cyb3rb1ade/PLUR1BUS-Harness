#![cfg(feature = "telegram")]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_channels::http::{Http, HttpPorts};
use plur1bus_channels::telegram::Telegram;
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, value::RawValue, Value};
use std::net::SocketAddr;
use url::Url;

const MARKER: &str = "synthetic-telegram-marker";

struct Loopback(SocketAddr);

impl HttpPorts for Loopback {
    fn pin(&self, endpoint: &Url) -> Option<SocketAddr> {
        (endpoint.host_str() == Some("127.0.0.1") && endpoint.port() == Some(self.0.port()))
            .then_some(self.0)
    }
}

#[test]
fn replays_telegram_api_requests_and_results() {
    let fixture = load_fixture("channels", "telegram-api");
    let cases = fixture["scenarios"].as_array().unwrap();
    assert_eq!(cases.len(), 13);
    for case in cases {
        let name = &case["name"];
        let exchanges: Value = serde_json::from_str(
            &case["exchanges"]
                .to_string()
                .replace("[FIXTURE:TELEGRAM]", MARKER),
        )
        .unwrap();
        let server = FakeServer::start(&json!({"transport": "http", "exchanges": exchanges}));
        let ports = Loopback(server.addr);
        let base = Url::parse(&format!("http://{}/v1", server.addr)).unwrap();
        let api = Telegram::new(Http::new(&ports, true), base, MARKER, &[]).unwrap();
        let input = &case["input"];
        let observed = match input["op"].as_str().unwrap() {
            "updates" => api.get_updates(input["offset"].as_u64(), input["wait"].as_u64().unwrap()),
            "send" => api
                .send_message(
                    input["chat"].as_str().unwrap(),
                    input["text"].as_str().unwrap(),
                    serde_json::from_str::<&RawValue>(input["extra"].as_str().unwrap_or("{}"))
                        .unwrap(),
                )
                .map(|id| json!(id)),
            "download" => api
                .download(
                    input["path"].as_str().unwrap(),
                    input["limit"].as_u64().unwrap() as usize,
                )
                .map(|file| json!({"mimeType": file.mime_type, "data": file.data})),
            op => panic!("unexpected operation {op}"),
        }
        .map_or_else(
            |error| json!({"error": error}),
            |result| json!({"result": result}),
        );
        assert_eq!(observed, case["expected"], "{name}");

        let received = server.received();
        let expected = exchanges.as_array().unwrap();
        assert_eq!(received.len(), expected.len(), "{name}");
        for (request, expected) in received.iter().zip(expected) {
            let expected = &expected["request"];
            assert_eq!(request["method"], expected["method"], "{name}");
            assert_eq!(request["path"], expected["path"], "{name}");
            assert_eq!(request["body"], expected["bodyText"], "{name}");
            for (key, value) in expected["headers"].as_object().unwrap() {
                assert_eq!(&request["headers"][key], value, "{name} {key}");
            }
        }
    }
}

#[test]
fn mismatched_pins_and_cancelled_requests_never_reach_loopback() {
    struct Untrusted {
        pin: SocketAddr,
        cancel: bool,
    }
    impl HttpPorts for Untrusted {
        fn pin(&self, _: &Url) -> Option<SocketAddr> {
            Some(self.pin)
        }
        fn cancelled(&self) -> bool {
            self.cancel
        }
    }
    let server = FakeServer::start(&json!({"transport": "http", "exchanges": []}));
    for (base, plain, cancel) in [
        (
            format!(
                "http://127.0.0.1:{}",
                if server.addr.port() == 80 { 81 } else { 80 }
            ),
            true,
            false,
        ),
        (
            format!("http://127.0.0.2:{}", server.addr.port()),
            true,
            false,
        ),
        (format!("http://{}", server.addr), false, false),
        (format!("http://{}", server.addr), true, true),
    ] {
        let ports = Untrusted {
            pin: server.addr,
            cancel,
        };
        let api = Telegram::new(
            Http::new(&ports, plain),
            Url::parse(&base).unwrap(),
            MARKER,
            &[],
        )
        .unwrap();
        let error = api.get_updates(None, 0).unwrap_err();
        assert_eq!(
            error.kind,
            if cancel {
                plur1bus_channels::http::Kind::Aborted
            } else {
                plur1bus_channels::http::Kind::Network
            }
        );
        assert!(server.received().is_empty());
    }
}
