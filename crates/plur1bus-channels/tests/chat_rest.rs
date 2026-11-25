#![cfg(all(feature = "discord", feature = "slack"))]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_channels::discord::{Clock, Discord, Request};
use plur1bus_channels::slack::{Slack, Token};
use plur1bus_wire_fixtures::load_fixture;
use serde_json::{json, value::RawValue, Value};
use std::cell::{Cell, RefCell};
use std::time::Duration;

mod support;

const BOT: &str = "synthetic-slack-marker";
const APP: &str = "synthetic-slack-app-marker";
const DISCORD: &str = "synthetic-discord-marker";
const INTERACTION: &str = "synthetic-discord-interaction-marker";

fn text<'a>(input: &'a Value, name: &str) -> &'a str {
    input[name].as_str().unwrap()
}

struct TestClock {
    ms: Cell<u64>,
    waits: RefCell<Vec<u64>>,
}

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.ms.get()
    }

    fn random(&self) -> f64 {
        0.5
    }

    fn wait(&self, duration: Duration) -> bool {
        let ms = duration.as_millis() as u64;
        self.waits.borrow_mut().push(ms);
        self.ms.set(self.ms.get() + ms);
        true
    }
}

#[test]
fn replays_discord_rest_retries_and_token_routes() {
    let fixture = load_fixture("channels", "discord-api");
    let cases = fixture["scenarios"].as_array().unwrap();
    assert_eq!(cases.len(), 7);
    for case in cases {
        let replay = support::Replay::start(
            case,
            &[
                ("[FIXTURE:DISCORD]", DISCORD),
                ("[FIXTURE:INTERACTION]", INTERACTION),
            ],
        );
        let (http, base) = replay.connect();
        let input = &case["input"];
        let clock = TestClock {
            ms: Cell::new(100_000),
            waits: RefCell::new(Vec::new()),
        };
        let mut api = Discord::new(
            http,
            base,
            DISCORD,
            &clock,
            input["retries"].as_u64().unwrap_or(0) as u8,
        );
        let method = text(input, "method");
        let path = text(input, "path").replace("[FIXTURE:INTERACTION]", INTERACTION);
        let mut request = Request::new(method, &path);
        request.token_route = input["tokenRoute"] == true;
        if let Some(body) = input["json"].as_str() {
            request.json(serde_json::from_str::<&RawValue>(body).unwrap());
        }
        let observed = api.request(&request).map_or_else(
            |error| json!({"error": error}),
            |result| json!({"result": result}),
        );
        assert_eq!(observed, case["expected"], "{}", case["name"]);
        assert_eq!(
            json!(*clock.waits.borrow()),
            case["waits"],
            "{}",
            case["name"]
        );
        replay.verify(&case["name"]);
    }
}

#[test]
fn replays_slack_rest_forms_and_file_requests() {
    let fixture = load_fixture("channels", "slack-api");
    let cases = fixture["scenarios"].as_array().unwrap();
    assert_eq!(cases.len(), 12);
    for case in cases {
        let replay = support::Replay::start(
            case,
            &[("[FIXTURE:SLACK_BOT]", BOT), ("[FIXTURE:SLACK_APP]", APP)],
        );
        let (http, base) = replay.connect();
        let api = Slack::new(http, base.clone(), BOT, APP);
        let input = &case["input"];
        let json =
            serde_json::from_str::<&RawValue>(input["json"].as_str().unwrap_or("{}")).unwrap();
        let result = match text(input, "op") {
            "open" => api.open_socket_url().map(|url| json!(url)),
            "call" => api.call(text(input, "method"), json, Token::Bot, false),
            "form" => api.call(text(input, "method"), json, Token::Bot, true),
            "download" => {
                let url = base.join(text(input, "path")).unwrap();
                api.download(url.as_str(), input["limit"].as_u64().unwrap() as usize)
                    .map(|file| json!({"mimeType": file.mime_type, "data": file.data}))
            }
            "bytes" => {
                let url = base.join(text(input, "path")).unwrap();
                api.upload_bytes(url.as_str(), text(input, "text").as_bytes())
                    .map(|()| Value::Null)
            }
            op => panic!("unexpected operation {op}"),
        };
        let observed = result.map_or_else(
            |error| json!({"error": error}),
            |result| json!({"result": result}),
        );
        assert_eq!(observed, case["expected"], "{}", case["name"]);
        replay.verify(&case["name"]);
    }
}

#[test]
fn discord_outbound_disables_mentions_in_the_message_payload() {
    let admission = load_fixture("channels", "channel-admission");
    let outbound = &admission["discord"]["outbound"];
    let path = "/channels/123456/messages";
    let reply = json!({"name":"send","exchanges":[{
        "request": {
            "method": "POST", "path": format!("/v1{path}"),
            "bodyText": json!({"allowed_mentions":outbound, "content":"Reply"}).to_string(),
            "headers": {"authorization": "Bot test", "content-type": "application/json"},
        },
        "response":{"status":200,"body":{"id":"42"}},
    }]});
    let replay = support::Replay::start(&reply, &[]);
    let (http, base) = replay.connect();
    let clock = TestClock {
        ms: Cell::new(0),
        waits: Default::default(),
    };
    let mut api = Discord::new(http, base, "test", &clock, 0);
    let mut request = Request::new("POST", path);
    request.json(serde_json::from_str::<&RawValue>(r#"{"content":"Reply"}"#).unwrap());
    assert!(api.request(&request).is_ok());
    replay.verify(&reply["name"]);
}

#[test]
fn discord_checks_the_attachment_host_before_asking_the_egress_port() {
    use plur1bus_channels::http::{Http, HttpPorts};
    use std::net::SocketAddr;
    use std::time::Instant;
    use url::Url;

    #[derive(Default)]
    struct Deny(Cell<usize>);
    impl HttpPorts for Deny {
        fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
            self.0.set(self.0.get() + 1);
            None
        }
    }
    let ports = Deny::default();
    let clock = TestClock {
        ms: Cell::new(0),
        waits: Default::default(),
    };
    let client = Discord::new(
        Http::new(&ports, false),
        Url::parse("https://discord.com/api/v10").unwrap(),
        "test",
        &clock,
        0,
    );
    assert!(client
        .download("https://storage.example.invalid/report", &[], 16)
        .is_err());
    assert_eq!(ports.0.get(), 0);
    assert!(client
        .download("https://cdn.discordapp.com/report", &[], 16)
        .is_err());
    assert_eq!(ports.0.get(), 1);
}

#[test]
fn discord_refuses_ambiguous_paths_before_request_admission() {
    use plur1bus_channels::http::{Http, HttpPorts, Kind};
    use std::{net::SocketAddr, time::Instant};
    use url::Url;

    struct Offline(Cell<usize>);
    impl HttpPorts for Offline {
        fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
            self.0.set(self.0.get() + 1);
            None
        }
    }
    let ports = Offline(Cell::new(0));
    let clock = TestClock {
        ms: Cell::new(0),
        waits: Default::default(),
    };
    let mut api = Discord::new(
        Http::new(&ports, false),
        Url::parse("https://fixture.invalid/").unwrap(),
        "fixture",
        &clock,
        0,
    );
    for path in [
        "/edition/./page",
        "/edition/archive/../page",
        "/edition/%2E/page",
        "/edition//page",
    ] {
        assert_eq!(
            api.request(&Request::new("GET", path)).unwrap_err().kind,
            Kind::Protocol
        );
    }
    assert_eq!(ports.0.get(), 0);
}

#[test]
fn discord_projects_message_fields_at_each_supported_payload_position() {
    let safe = json!({"parse":[]});
    for (method, path, input, expected) in [
        (
            "PATCH",
            "/channels/42/messages/7",
            json!({}),
            json!({"allowed_mentions":safe}),
        ),
        (
            "PATCH",
            "/webhooks/42/fixture/messages/7",
            json!({}),
            json!({"allowed_mentions":safe}),
        ),
        (
            "POST",
            "/interactions/42/fixture/callback",
            json!({"type":4,"data":{}}),
            json!({"type":4,"data":{"allowed_mentions":safe}}),
        ),
        (
            "POST",
            "/fixture/preview",
            json!({"content":"Edition"}),
            json!({"content":"Edition","allowed_mentions":safe}),
        ),
        (
            "POST",
            "/fixture/thread",
            json!({"message":{"content":"Edition"}}),
            json!({"message":{"content":"Edition","allowed_mentions":safe}}),
        ),
        (
            "POST",
            "/fixture/callback",
            json!({"data":{"content":"Edition"}}),
            json!({"data":{"content":"Edition","allowed_mentions":safe}}),
        ),
    ] {
        let reply = json!({"name":path,"exchanges":[{
            "request":{"method":method,"path":format!("/v1{path}"),"bodyText":expected.to_string(),"headers":{"authorization":"Bot test","content-type":"application/json"}},
            "response":{"status":200,"body":{"id":"42"}}
        }]});
        let replay = support::Replay::start(&reply, &[]);
        let (http, base) = replay.connect();
        let clock = TestClock {
            ms: Cell::default(),
            waits: Default::default(),
        };
        let mut api = Discord::new(http, base, "test", &clock, 0);
        let payload = serde_json::value::to_raw_value(&input).unwrap();
        let mut request = Request::new(method, path);
        request.json(&payload);
        assert!(api.request(&request).is_ok(), "{path}");
        replay.verify(&reply["name"]);
    }
}

#[test]
fn discord_refuses_unprepared_uploads_and_invalid_file_metadata() {
    use plur1bus_channels::http::Kind;
    let replay = support::Replay::start(&json!({"exchanges":[]}), &[]);
    let (http, base) = replay.connect();
    let clock = TestClock {
        ms: Cell::default(),
        waits: Default::default(),
    };
    let mut api = Discord::new(http, base, "test", &clock, 0);
    let payload: &RawValue = serde_json::from_str(r#"{"content":"Edition"}"#).unwrap();
    let mut request = Request::new("POST", "/channels/42/messages");
    request
        .multipart("multipart/form-data; boundary=edition", b"")
        .unwrap();
    assert_eq!(api.request(&request).unwrap_err().kind, Kind::Protocol);
    for (name, bytes) in [
        ("Local edition.txt", b"Daily".as_slice()),
        ("daily.txt", b"--edition".as_slice()),
    ] {
        assert_eq!(
            request
                .message_file(payload, "edition", name, "text/plain", bytes)
                .unwrap_err()
                .kind,
            Kind::Protocol
        );
    }
    replay.verify(&json!("upload validation"));
}
