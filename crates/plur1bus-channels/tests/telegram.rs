#![cfg(feature = "telegram")]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_channels::http::{Http, HttpPorts};
use plur1bus_channels::telegram::Telegram;
use plur1bus_wire_fixtures::{load_fixture, FakeServer};
use serde_json::{json, value::RawValue};
use std::net::SocketAddr;
use url::Url;

const MARKER: &str = "synthetic-telegram-marker";

mod support;

#[test]
fn replays_telegram_api_requests_and_results() {
    let fixture = load_fixture("channels", "telegram-api");
    let cases = fixture["scenarios"].as_array().unwrap();
    assert_eq!(cases.len(), 13);
    for case in cases {
        let name = &case["name"];
        let replay = support::Replay::start(case, &[("[FIXTURE:TELEGRAM]", MARKER)]);
        let (http, base) = replay.connect();
        let api = Telegram::new(http, base, MARKER, &[]).unwrap();
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

        replay.verify(name);
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
