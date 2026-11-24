#![allow(clippy::unwrap_used, reason = "checked TypeScript fixture")]

use std::time::{Duration, Instant};

use plur1bus_discovery::scanners::{self, Error, Page, Port, Result};
use serde_json::{json, Value};

struct Fixture<'a> {
    replies: &'a [Value],
    requests: Vec<Value>,
    deadline: Instant,
}

impl Port for Fixture<'_> {
    fn get(&mut self, page: Page<'_>) -> Result<Vec<u8>> {
        assert!(page.deadline <= self.deadline);
        assert!(page.max_bytes <= 4 * 1024 * 1024);
        let value = &self.replies[self.requests.len()];
        self.requests.push(serde_json::to_value(page).unwrap());
        if let Some(status) = value["error"]["status"].as_u64() {
            return Err(Error::http_status(u16::try_from(status).unwrap()));
        }
        Ok(serde_json::to_vec(value).unwrap())
    }
}

#[test]
fn recorded_pages_replay_each_scanner_and_its_provider_request() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/scanners.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mut port = Fixture {
            replies: case["responses"].as_array().unwrap(),
            requests: Vec::new(),
            deadline: Instant::now() + Duration::from_secs(10),
        };
        let deadline = port.deadline;
        let result = scanners::scan(
            case["scanner"].as_str().unwrap().parse().unwrap(),
            case["apple"].as_bool().unwrap_or(false),
            &mut port,
            deadline,
            &|| false,
        );
        let actual = match result {
            Ok(output) => serde_json::to_value(output).unwrap(),
            Err(error) => serde_json::to_value(error).unwrap(),
        };
        assert_eq!(actual, case["expected"], "{}", case["scanner"]);
        assert_eq!(
            json!(port.requests),
            case["requests"],
            "{}",
            case["scanner"]
        );
    }
}

#[test]
fn entry_interpretation_stops_at_its_inclusive_limit() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/scanners.json"
    ))
    .unwrap();
    for case in fixture["entryLimit"].as_array().unwrap() {
        let count = case["count"].as_u64().unwrap() as usize;
        let replies = [json!({"data": vec![case["sample"].clone(); count]})];
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut port = Fixture {
            replies: &replies,
            requests: vec![],
            deadline,
        };
        let result = scanners::scan(
            scanners::Scanner::OpenAi,
            false,
            &mut port,
            deadline,
            &|| false,
        );
        let observed = match result {
            Ok(output) => json!({"duplicates": output.duplicates}),
            Err(error) => json!({"reason": error.reason}),
        };
        assert_eq!(observed, case["expected"]);
    }
}

#[test]
fn each_page_receives_a_deadline_of_at_most_fifteen_seconds() {
    use std::cell::Cell;
    struct PageClock(Cell<Option<Instant>>);

    impl Port for PageClock {
        fn get(&mut self, page: Page<'_>) -> Result<Vec<u8>> {
            self.0.set(Some(page.deadline));
            Ok(br#"{"data":[{"id":"sample"}]}"#.to_vec())
        }
    }
    let mut port = PageClock(Cell::new(None));
    let now = Instant::now();
    let result = scanners::scan(
        scanners::Scanner::OpenAi,
        false,
        &mut port,
        now + Duration::from_secs(45),
        &|| false,
    );
    assert!(result.is_ok());
    let deadline = port.0.get().unwrap();
    assert!(deadline >= now + Duration::from_secs(15));
    assert!(deadline <= Instant::now() + Duration::from_secs(15));
}

#[test]
fn model_labels_strip_controls_and_apply_a_display_limit() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/scanners.json"
    ))
    .unwrap();
    let display = &fixture["display"];
    let mut replay = display["input"].clone();
    let raw = display["observed"]["entries"][0]["displayName"].clone();
    assert_eq!(replay["data"][0]["name"], raw);

    for (label, expected) in [
        (raw.as_str().unwrap().to_owned(), "ReportA".to_owned()),
        ("a".repeat(600), "a".repeat(512)),
        ("Line\nTwo".into(), "LineTwo".into()),
    ] {
        replay["data"][0]["name"] = json!(label);
        let responses = [replay.clone()];
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut fixture = Fixture {
            replies: &responses,
            requests: Vec::new(),
            deadline,
        };
        let output = scanners::scan(
            scanners::Scanner::OpenAi,
            false,
            &mut fixture,
            deadline,
            &|| false,
        )
        .unwrap();
        let observed = serde_json::to_value(output).unwrap();
        assert_eq!(observed["entries"][0]["displayName"], expected);
    }
}
