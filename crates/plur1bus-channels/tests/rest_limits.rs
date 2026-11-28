#![cfg(all(feature = "discord", feature = "slack", feature = "telegram"))]
#![allow(clippy::unwrap_used)]

use plur1bus_channels::discord::{Clock, Discord, Request};
use plur1bus_channels::http::{Error, Kind};
use plur1bus_channels::slack::{Slack, Token};
use plur1bus_channels::telegram::{Method, Telegram};
use serde_json::{json, value::RawValue, Value};
use std::time::Duration;

#[allow(dead_code)]
mod support;

const JSON_LIMIT: usize = 1024 * 1024;
const DIAGNOSTIC_LIMIT: usize = 64 * 1024;

struct TestClock;

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        0
    }

    fn random(&self) -> f64 {
        0.5
    }

    fn wait(&self, _: Duration) -> bool {
        true
    }
}

fn reply(status: u16, body: &Value) -> support::Replay {
    let exchanges = [
        ("GET", "/v1/gateway"),
        ("POST", "/v1/auth.test"),
        ("POST", "/v1/bottest/getMe"),
    ]
    .map(|(method, path)| {
        json!({
            "request": {"method": method, "path": path},
            "response": {"status": status, "body": body, "headers": {"retry-after": "2"}}
        })
    });
    support::Replay::start(&json!({"exchanges": exchanges}), &[])
}

type Call = fn(&support::Replay) -> Result<Value, Error>;

fn discord(replay: &support::Replay) -> Result<Value, Error> {
    let (http, base) = replay.connect();
    Discord::new(http, base, "test", &TestClock, 0).request(&Request::new("GET", "/gateway"))
}

fn slack(replay: &support::Replay) -> Result<Value, Error> {
    let (http, base) = replay.connect();
    Slack::new(http, base, "test", "test").call(
        "auth.test",
        serde_json::from_str::<&RawValue>("{}").unwrap(),
        Token::Bot,
        false,
    )
}

fn telegram(replay: &support::Replay) -> Result<Value, Error> {
    let (http, base) = replay.connect();
    Telegram::new(http, base, "test", &[]).unwrap().call(
        Method::GetMe,
        serde_json::from_str::<&RawValue>("{}").unwrap(),
    )
}

fn check_json_boundary(call: Call) {
    for size in [JSON_LIMIT, JSON_LIMIT + 1] {
        let mut body = json!({"ok": true, "result": 42, "padding": ""});
        body["padding"] = json!("a".repeat(size - body.to_string().len()));
        let result = call(&reply(200, &body));
        if size == JSON_LIMIT {
            assert!(result.is_ok(), "expected response at limit: {result:?}");
        } else {
            assert_eq!(result.err().map(|error| error.kind), Some(Kind::Protocol));
        }
    }
}

fn diagnostic(status: u16, size: usize) -> support::Replay {
    let mut body = json!({
        "message": "invalid input",
        "description": "invalid input",
        "error": "invalid_arguments",
        "retry_after": 1,
        "parameters": {"retry_after": 1},
        "padding": "",
    });
    body["padding"] = json!("a".repeat(size - body.to_string().len()));
    reply(status, &body)
}

fn check_diagnostic_boundary(call: Call, detail: &str) {
    let exact = call(&diagnostic(400, DIAGNOSTIC_LIMIT)).unwrap_err();
    assert!(exact.message.contains(detail));
    assert_eq!(exact.status, Some(400));

    let oversized = call(&diagnostic(400, DIAGNOSTIC_LIMIT + 1)).unwrap_err();
    assert!(!oversized.message.contains(detail));
    assert_eq!(oversized.status, Some(400));

    let throttled = call(&diagnostic(429, DIAGNOSTIC_LIMIT + 1)).unwrap_err();
    assert_eq!(throttled.kind, Kind::RateLimited);
    assert_eq!(throttled.retry_after_ms, Some(2_000));
}

#[test]
fn discord_json_limit() {
    check_json_boundary(discord);
}

#[test]
fn discord_diagnostic_limit() {
    check_diagnostic_boundary(discord, "invalid input");
}

#[test]
fn slack_json_limit() {
    check_json_boundary(slack);
}

#[test]
fn slack_diagnostic_limit() {
    check_diagnostic_boundary(slack, "invalid_arguments");
}

#[test]
fn telegram_json_limit() {
    check_json_boundary(telegram);
}

#[test]
fn telegram_diagnostic_limit() {
    check_diagnostic_boundary(telegram, "invalid input");
}
