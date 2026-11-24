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
    for count in [5_000, 5_001] {
        let replies = [json!({"data": vec![json!({"id":"example"}); count]})];
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
        if count == 5_000 {
            assert_eq!(result.unwrap().duplicates, 4_999);
        } else {
            assert_eq!(result.err().unwrap().reason, "too_many_entries");
        }
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
