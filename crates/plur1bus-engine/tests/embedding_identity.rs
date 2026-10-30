#![allow(clippy::unwrap_used)]

use plur1bus_engine::embedding::{
    fingerprint::{fingerprint_id, fingerprint_record_id, normalize_fingerprint},
    identity::{identity_from_value, identity_id},
    normalize::normalize_embedding_config,
};
use serde_json::{json, Value};

fn recordings() -> Vec<Value> {
    [
        include_str!("fixtures/vectors/identity-e5.json"),
        include_str!("fixtures/vectors/identity-embeddinggemma-2.json"),
    ]
    .iter()
    .flat_map(|source| {
        serde_json::from_str::<Value>(source).unwrap()["cases"]
            .as_array()
            .unwrap()
            .clone()
    })
    .collect()
}

#[test]
fn identity_id_matches_the_node_engine_for_every_recorded_case() {
    for case in recordings() {
        let identity = identity_from_value(&case["identityInput"]).unwrap();
        assert_eq!(
            serde_json::to_value(&identity).unwrap(),
            case["identity"],
            "{}",
            case["name"]
        );
        assert_eq!(
            identity_id(&identity),
            case["identityId"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn fingerprint_id_matches_the_node_engine_for_every_recorded_case() {
    for case in recordings() {
        let fingerprint = match case.get("fingerprintInput") {
            Some(input) => normalize_fingerprint(input, &case["fingerprintArtifacts"]).unwrap(),
            None => case["fingerprint"].clone(),
        };
        assert_eq!(fingerprint, case["fingerprint"], "{}", case["name"]);
        assert_eq!(
            fingerprint_record_id(&fingerprint).unwrap(),
            case["fingerprintId"],
            "{}",
            case["name"]
        );
        if case.get("fingerprintInput").is_none() {
            let normalized = normalize_embedding_config(&case["raw"]).unwrap();
            assert_eq!(
                fingerprint_id(&normalized),
                case["fingerprintId"],
                "{}",
                case["name"]
            );
        }
    }
}

#[test]
fn normalization_matches_the_node_engine_for_every_recorded_case() {
    for case in recordings() {
        let normalized = normalize_embedding_config(&case["raw"]).unwrap();
        assert_eq!(
            normalized.as_value(),
            &case["normalized"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn normalize_rejects_a_config_without_a_provider() {
    assert!(normalize_embedding_config(&json!({ "model": "text-embedding-3-small" })).is_err());
}

#[test]
fn normalization_choices_and_refusals_match_the_node_engine() {
    let recording: Value =
        serde_json::from_str(include_str!("fixtures/vectors/normalize.json")).unwrap();
    for case in recording["cases"].as_array().unwrap() {
        match case.get("error") {
            Some(expected) => assert_eq!(
                normalize_embedding_config(&case["raw"])
                    .unwrap_err()
                    .message,
                expected.as_str().unwrap(),
                "{}",
                case["name"]
            ),
            None => assert_eq!(
                normalize_embedding_config(&case["raw"]).unwrap().as_value(),
                &case["normalized"],
                "{}",
                case["name"]
            ),
        }
    }
}

#[test]
fn local_cache_selection_is_explicit_and_does_not_change_the_fingerprint() {
    assert!(normalize_embedding_config(&json!({"provider":"local-transformers"})).is_err());
    let first = normalize_embedding_config(
        &json!({"provider":"local-transformers", "local":{"cacheDir":"/first"}}),
    )
    .unwrap();
    let second = normalize_embedding_config(
        &json!({"provider":"local-transformers", "local":{"cacheDir":"/second"}}),
    )
    .unwrap();
    assert_eq!(fingerprint_id(&first), fingerprint_id(&second));
}

#[test]
fn fingerprint_refusals_match_the_node_engine() {
    let recording: Value =
        serde_json::from_str(include_str!("fixtures/vectors/fingerprint-invalid.json")).unwrap();
    for case in recording["cases"].as_array().unwrap() {
        let error = normalize_fingerprint(&case["input"], &case["artifacts"]).unwrap_err();
        assert_eq!(
            error.message,
            case["error"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn null_and_undefined_have_the_recorded_identity_and_fingerprint_semantics() {
    let cases = recordings();
    let undefined = cases
        .iter()
        .find(|case| case["name"] == "undefined-defaults")
        .unwrap();
    let null = cases
        .iter()
        .find(|case| case["name"] == "null-identity-defaults")
        .unwrap();
    assert_eq!(undefined["identityId"], null["identityId"]);
    assert!(normalize_fingerprint(
        &json!({ "provider": "openai", "model": "x", "dimensions": 3, "tokenCap": null }),
        &json!([])
    )
    .is_err());
}
