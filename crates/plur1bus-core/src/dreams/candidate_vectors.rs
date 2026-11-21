use super::*;
use serde_json::{json, Value};

#[test]
fn candidate_guards_replay_typescript() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/dreams/candidates.json"
    ))
    .unwrap();
    for row in fixture["hashes"].as_array().unwrap() {
        assert_eq!(
            json!(content_hash(row["text"].as_str().unwrap())),
            row["hash"]
        );
    }
    for row in fixture["gates"].as_array().unwrap() {
        let input = serde_json::from_value(row["input"].clone()).unwrap();
        let config = serde_json::from_value(row["config"].clone()).unwrap();
        let actual = evaluate(&input, row["now"].as_i64().unwrap(), config);
        assert_eq!(json!(actual), row["result"], "{}", row["name"]);
    }
    for row in fixture["fallback"].as_array().unwrap() {
        let input = serde_json::from_value(row["input"].clone()).unwrap();
        let actual = evaluate_fallback(&input, row["now"].as_f64().unwrap());
        assert_eq!(json!(actual), row["result"], "{}", row["name"]);
    }
}
