use super::*;
use crate::toolcall::json::{parse, Obj};
use serde_json::{json, Value};

fn read() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/parity/learn/findings.json"
    ))
    .unwrap()
}

fn native(value: &V) -> Value {
    serde_json::from_str(&value.stringify()).unwrap()
}

#[test]
fn validates_model_extraction_against_the_frozen_evidence() {
    for row in read()["extraction"].as_array().unwrap() {
        let transcript = V::from_serde(&row["transcript"]);
        let result = match parse_extraction(row["raw"].as_str().unwrap(), &transcript) {
            Ok(raw) => json!({"raw":raw.iter().map(native).collect::<Vec<_>>()}),
            Err(e) => json!({"error":e.as_str()}),
        };
        assert_eq!(result, row["expected"], "{}", row["name"]);
    }
}

#[test]
fn aggregation_and_vocabulary_match_typescript() {
    let vectors = read();
    let row = &vectors["aggregate"];
    let batch = row["batch"]
        .as_array()
        .unwrap()
        .iter()
        .map(V::from_serde)
        .collect::<Vec<_>>();
    let target: Target = serde_json::from_value(row["target"].clone()).unwrap();
    let findings = aggregate(&batch, &target, "run-fixture", 7).unwrap();
    assert_eq!(
        json!(findings.iter().map(native).collect::<Vec<_>>()),
        row["expected"]
    );
    assert_eq!(
        json!(vocabulary(&batch)
            .unwrap()
            .iter()
            .map(native)
            .collect::<Vec<_>>()),
        row["vocabulary"]
    );
    let mut next = findings[0]
        .as_obj()
        .map(|o| Obj::from_pairs(o.entries().to_vec()))
        .unwrap();
    next.set("evidence", batch[1].get("evidence").unwrap().clone());
    assert_eq!(
        native(&merge_evidence(&findings[0], &V::Obj(next)).unwrap()),
        row["merged"]
    );
    assert!(parse("[]").unwrap().as_arr().unwrap().is_empty());
}

#[test]
fn score_and_precision_always_remain_in_shadow() {
    let fixture = read();
    for row in fixture["scored"].as_array().unwrap() {
        let safety = serde_json::from_value(row["safety"].clone()).unwrap();
        let result = score(&V::from_serde(&row["input"]), safety).unwrap();
        for key in ["score", "desiredTier", "effectiveTier"] {
            let value = native(result.get(key).unwrap());
            assert!(
                V::from_serde(&value).deep_equal(&V::from_serde(&row["expected"][key])),
                "{} {key}: {value} vs {}",
                row["name"],
                row["expected"][key]
            );
        }
    }
    for row in fixture["precision"].as_array().unwrap() {
        assert!(precision_gate(
            row["accepted"].as_u64().unwrap(),
            row["decided"].as_u64().unwrap()
        )
        .deep_equal(&V::from_serde(row)));
    }
}
