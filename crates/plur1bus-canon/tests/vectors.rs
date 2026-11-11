//! Parity mode V: the dispatcher vectors that `scripts/parity/export-dispatcher.ts` recorded from the TypeScript core
//! (`fixtures/parity/dispatcher/`, never edited by hand). Every case must match byte for byte.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_canon::{action_hash, action_hash_input, canonical_json};
use serde_json::Value;
use std::path::PathBuf;

fn vectors(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/parity/dispatcher")
        .join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["schema"], "plur1bus.parity-vectors/1", "{name}");
    v
}

#[test]
fn canonical_json_matches_every_typescript_vector() {
    let v = vectors("canonical-json");
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 20, "the vector set is complete");
    let mut failures = Vec::new();
    for case in cases {
        let input: Value = serde_json::from_str(case["inputJson"].as_str().unwrap()).unwrap();
        let expected = case["canonical"].as_str().unwrap();
        let got = canonical_json(&input);
        if got != expected {
            failures.push(format!(
                "{}: expected {expected:?}, got {got:?}",
                case["name"]
            ));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn action_hash_matches_every_typescript_vector() {
    let v = vectors("action-hash");
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 10, "the vector set is complete");
    let mut failures = Vec::new();
    for case in cases {
        let args: Value = serde_json::from_str(case["argsJson"].as_str().unwrap()).unwrap();
        let targets: Vec<String> = case["targets"]
            .as_array()
            .map(|t| t.iter().map(|x| x.as_str().unwrap().to_owned()).collect())
            .unwrap_or_default();
        let capability = case["capability"].as_str().unwrap();
        let tool = case["tool"].as_str().unwrap();
        let extra = case["hashExtra"].as_str();
        let input = action_hash_input(capability, tool, &args, &targets, extra);
        if input != case["hashInput"].as_str().unwrap() {
            failures.push(format!(
                "{} input: expected {}, got {input}",
                case["name"], case["hashInput"]
            ));
        }
        let hash = action_hash(capability, tool, &args, &targets, extra);
        if hash != case["actionHash"].as_str().unwrap() {
            failures.push(format!(
                "{} hash: expected {}, got {hash}",
                case["name"], case["actionHash"]
            ));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The key-order pair in the vectors: the same arguments in another order hash the same.
#[test]
fn argument_key_order_does_not_change_the_hash() {
    let a: Value = serde_json::from_str(r#"{"q":1,"z":2}"#).unwrap();
    let b: Value = serde_json::from_str(r#"{"z":2,"q":1}"#).unwrap();
    assert_eq!(
        action_hash("net.submit", "demo.net", &a, &[], None),
        action_hash("net.submit", "demo.net", &b, &[], None)
    );
}

/// JavaScript's truthiness test (`c?.hashExtra ? {hashExtra} : {}`) leaves an empty `hashExtra` out of the hash input.
#[test]
fn an_empty_hash_extra_is_left_out_like_javascript_does() {
    let args: Value = serde_json::from_str(r#"{"q":"a"}"#).unwrap();
    assert_eq!(
        action_hash_input("net.submit", "demo.net", &args, &[], Some("")),
        action_hash_input("net.submit", "demo.net", &args, &[], None)
    );
}
