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
