#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline parity assertions"
)]
use plur1bus_engine::{
    capture::interference::{plan, search_request, InterferenceOptions},
    contract::Cancel,
    text::json::parse_json,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[test]
fn actual_node_selection_and_decay_match_without_writing_sources() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/interference.json")).unwrap();
    let exceptions: Value = serde_json::from_str(include_str!(
        "fixtures/capture/interference-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        exceptions["nodeGoldenSha256"],
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/interference.json"))
        )
    );
    for case in golden["cases"].as_array().unwrap() {
        if case.get("failSearch").is_some() || case.get("failUpdate").is_some() {
            continue;
        }
        let options: InterferenceOptions = serde_json::from_value(case["options"].clone()).unwrap();
        let source = parse_json(&case["source"].to_string()).unwrap();
        let exception = exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == case["name"]);
        let request = search_request(&source, options, &Cancel::never());
        if exception.is_some_and(|e| e["stage"] == "search") {
            assert!(request.is_err(), "{}", case["name"]);
            continue;
        }
        let request = request.unwrap();
        let expected = case["calls"].as_array().unwrap();
        let Some(request) = request else {
            assert!(expected.is_empty(), "{}", case["name"]);
            continue;
        };
        assert_eq!(
            request.vector,
            expected[0]["vector"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(request.limit as u64, expected[0]["limit"].as_u64().unwrap());
        assert_eq!(
            request.threshold,
            expected[0]["threshold"].as_f64().unwrap()
        );
        let candidates = case["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| parse_json(&v.to_string()).unwrap())
            .collect::<Vec<_>>();
        let original = candidates.clone();
        let result = plan(
            &source,
            &candidates,
            golden["now"].as_i64().unwrap(),
            options,
            &Cancel::never(),
        );
        if exception.is_some_and(|e| e["stage"] == "plan") {
            assert!(result.is_err(), "{}", case["name"]);
            continue;
        }
        let result = result.unwrap();
        assert_eq!(result.len(), expected.len() - 1, "{}", case["name"]);
        for (effect, observed) in result.iter().zip(&expected[1..]) {
            assert_eq!(effect.id.to_utf8_lossy(), observed["id"].as_str().unwrap());
            assert!(
                (effect.memory_strength - observed["patch"]["memoryStrength"].as_f64().unwrap())
                    .abs()
                    < 1e-12,
                "{}",
                case["name"]
            );
            assert_eq!(
                effect.last_dynamics_at,
                observed["patch"]["lastDynamicsAt"].as_i64().unwrap()
            );
        }
        assert_eq!(candidates, original);
    }
}
#[test]
fn native_plan_refuses_ambiguous_duplicates_bounds_and_cancellation() {
    let source = parse_json(r#"{"id":"new","vector":[1,0]}"#).unwrap();
    let candidate = parse_json(r#"{"id":"old","memoryStrength":0.8}"#).unwrap();
    let opts = InterferenceOptions::default();
    assert!(plan(
        &source,
        &[candidate.clone(), candidate.clone()],
        1,
        opts,
        &Cancel::never()
    )
    .is_err());
    assert!(plan(&source, &vec![candidate; 66], 1, opts, &Cancel::never()).is_err());
    for opts in [
        InterferenceOptions {
            max_affected: 65,
            ..opts
        },
        InterferenceOptions {
            multiplier: f64::NAN,
            ..opts
        },
        InterferenceOptions {
            threshold: 1.1,
            ..opts
        },
    ] {
        assert!(search_request(&source, opts, &Cancel::never()).is_err());
    }
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(search_request(&source, opts, &cancel).is_err());
    assert!(plan(&source, &[], 1, opts, &cancel).is_err());
}
#[test]
fn node_partial_failure_evidence_is_retained_without_claiming_transactionality() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/interference.json")).unwrap();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "partial-update-failure")
        .unwrap();
    assert_eq!(case["calls"].as_array().unwrap().len(), 3);
    assert_eq!(
        case["result"],
        json!({"ok":false,"affected":0,"error":"synthetic failure"})
    );
}
#[test]
fn plan_bounds_the_entire_candidate_set_and_freezes_exact_sources() {
    let source = parse_json(r#"{"id":"new","vector":[1,0]}"#).unwrap();
    let options = InterferenceOptions::default();
    let candidate = parse_json(r#"{"id":"old","memoryStrength":0.8,"opaque":"keep"}"#).unwrap();
    let first = plan(
        &source,
        std::slice::from_ref(&candidate),
        1234,
        options,
        &Cancel::never(),
    )
    .unwrap();
    let repeat = plan(
        &source,
        std::slice::from_ref(&candidate),
        1234,
        options,
        &Cancel::never(),
    )
    .unwrap();
    assert_eq!(first[0].before, candidate);
    assert_eq!(first[0].memory_strength, repeat[0].memory_strength);
    let large = ["one", "two"]
        .map(|id| parse_json(&json!({"id":id,"opaque":"x".repeat(600_000)}).to_string()).unwrap());
    assert!(plan(&source, &large, 1234, options, &Cancel::never()).is_err());
    let oversized_vector =
        parse_json(&json!({"id":"new","vector":vec![1;32_769]}).to_string()).unwrap();
    assert!(search_request(&oversized_vector, options, &Cancel::never()).is_err());
    let mut nested = plur1bus_engine::text::json::TolerantJsonValue::Null;
    for _ in 0..130 {
        nested = plur1bus_engine::text::json::TolerantJsonValue::Array(vec![nested]);
    }
    assert!(plan(&source, &[nested], 1234, options, &Cancel::never()).is_err());
}
