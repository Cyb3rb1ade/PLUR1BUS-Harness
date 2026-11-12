//! Actual frozen outcome decisions, including opaque identifiers and partial partitions.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::{
    contract::Cancel,
    jobs::outcome::rem,
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};

#[test]
fn seventy_six_actual_node_partition_decisions_match_exact_json() {
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/rem-outcome.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let input = parse_json(case["inputJson"].as_str().unwrap()).unwrap();
        let runs = match input {
            Json::Array(runs) => Some(runs),
            _ => None,
        }
        .expect("fixture array");
        let result = rem(
            &runs,
            case["options"]["narrativeExpected"].as_bool().unwrap(),
            case["options"]["dryRun"].as_bool().unwrap(),
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            write_json(&result),
            case["outputJson"].as_str().unwrap(),
            "{}",
            case["inputJson"]
        );
    }
}

#[test]
fn oversized_cancelled_and_ambiguous_inputs_are_refused_without_results() {
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(rem(&[], true, false, &cancel).is_err());
    assert!(rem(&vec![Json::Null; 1025], true, false, &Cancel::never()).is_err());
    let ambiguous = parse_json(r#"{"result":{},"result":null}"#).unwrap();
    assert!(rem(&[ambiguous], true, false, &Cancel::never()).is_err());
    let huge = Json::String("a".repeat(1_048_577).as_str().into());
    assert!(rem(&[huge], true, false, &Cancel::never()).is_err());
}
