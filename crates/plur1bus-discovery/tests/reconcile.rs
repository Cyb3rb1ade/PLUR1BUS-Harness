#![allow(clippy::unwrap_used, reason = "checked TypeScript fixture")]

use plur1bus_discovery::reconcile::{self, Input, Metadata};
use serde_json::{json, Value};

#[test]
fn model_reconciliation_replays_the_typescript_catalog() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/reconcile.json"
    ))
    .unwrap();
    let table = Metadata::load(include_str!(
        "../../../packages/core/catalog/model-metadata.json"
    ))
    .unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let input: Input = serde_json::from_value(case["input"].clone()).unwrap();
        let actual = match reconcile::apply(&input, &table) {
            Ok(result) => serde_json::to_value(result).unwrap(),
            Err(error) => json!({"error":error.message()}),
        };
        assert_eq!(actual, case["expected"], "{}", case["name"]);
    }
}

#[test]
fn override_projection_and_conflicts_match_the_recorded_catalog() {
    use plur1bus_discovery::overrides::{self, Request};

    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/reconcile.json"
    ))
    .unwrap();
    let table = Metadata::load(include_str!(
        "../../../packages/core/catalog/model-metadata.json"
    ))
    .unwrap();
    for case in vectors["overrides"].as_array().unwrap() {
        let input = &case["input"];
        let catalog = serde_json::from_value(input["catalog"].clone()).unwrap();
        let request: Request = serde_json::from_value(input["request"].clone()).unwrap();
        let actual = match overrides::apply(
            &catalog,
            &request,
            input["now"].as_str().unwrap(),
            &table,
            input["vendor"].as_str(),
        ) {
            Ok(result) => serde_json::to_value(result).unwrap(),
            Err(error) => serde_json::to_value(error).unwrap(),
        };
        assert_eq!(actual, case["expected"], "{}", case["name"]);
    }
}
