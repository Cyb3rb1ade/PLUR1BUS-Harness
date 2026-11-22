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
