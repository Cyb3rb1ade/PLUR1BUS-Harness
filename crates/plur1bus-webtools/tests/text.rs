#![allow(clippy::unwrap_used, reason = "recorded source fixtures")]

use plur1bus_webtools::text::{decode_body, decode_entities, split_sections};
use serde_json::Value;

#[test]
fn content_decoding_and_sections_match_the_recorded_typescript() {
    let data: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/webtools/text.json")).unwrap();
    for case in data["encodings"].as_array().unwrap() {
        let bytes: Vec<u8> = serde_json::from_value(case["bytes"].clone()).unwrap();
        assert_eq!(
            decode_body(&bytes, case["contentType"].as_str()),
            case["output"].as_str().unwrap()
        );
    }
    for case in data["entities"].as_array().unwrap() {
        assert_eq!(
            decode_entities(case["input"].as_str().unwrap()),
            case["output"].as_str().unwrap()
        );
    }
    for case in data["sections"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(split_sections(case["input"].as_str().unwrap())).unwrap(),
            case["output"]
        );
    }
}
