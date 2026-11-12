//! N1 release invariants. Old pinned Node references remain unchanged.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline release fixture assertions"
)]
use plur1bus_engine::{
    contract::Cancel,
    neo::{derived::from_turns, merged::Layout},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
const GOLDEN: &str = include_str!("fixtures/capture/golden/neo-n1-release.json");
fn cases() -> Value {
    let marker: Value = serde_json::from_str(include_str!(
        "fixtures/capture/neo-n1-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        marker["nodeGoldenSha256"],
        format!("{:x}", Sha256::digest(GOLDEN.as_bytes()))
    );
    serde_json::from_str(GOLDEN).unwrap()
}
#[test]
fn actual_release_directory_names_are_idempotent_only_with_the_matching_hash() {
    for case in cases()["layouts"].as_array().unwrap() {
        let key = case["key"].as_str().unwrap();
        let layout = Layout::for_key(key);
        assert_eq!(
            layout.canonical,
            case["canonical"].as_str().unwrap(),
            "{key}"
        );
        assert_ne!(
            layout.legacy.as_ref(),
            Some(&layout.canonical),
            "same path must not be read twice"
        );
    }
}
#[test]
fn injected_context_never_enters_behavior_or_reaction_derivation() {
    let source = cases();
    for (index, case) in source["derivation"].as_array().unwrap().iter().enumerate() {
        let turn = parse_json(&case["turn"].to_string()).unwrap();
        let derived = from_turns(
            &[turn],
            &JsString::from(source["now"].as_str().unwrap()),
            &Cancel::never(),
        )
        .unwrap();
        let actual = Json::Object(vec![
            (
                JsString::from("candidates"),
                Json::Array(derived.candidates),
            ),
            (JsString::from("reactions"), Json::Array(derived.reactions)),
            (JsString::from("behavior"), Json::Array(derived.behavior)),
        ]);
        let expected = if index >= 3 {
            // Controller N1 explicitly strengthens v7.19.3; the marker binds the source SHA.
            assert_eq!(case["output"]["behavior"].as_array().unwrap().len(), 1);
            json!({"candidates":[], "reactions":[], "behavior":[]})
        } else {
            case["output"].clone()
        };
        // serde may reorder object keys; compare the complete fields without normalizing values.
        assert_eq!(
            serde_json::from_str::<Value>(&write_json(&actual)).unwrap(),
            expected,
            "case {index}"
        );
    }
}

#[test]
fn native_n1_settings_round_trip_without_widening_unrelated_config() {
    let raw = json!({"neo": {
        "maxRecords":40000, "appendDedupeTailRecords":5000,
        "retention":{"days":90,"softMaxRecords":5000}
    }});
    let config = plur1bus_engine::config::validate(&raw).unwrap();
    assert_eq!(serde_json::to_value(config).unwrap(), raw);
    for invalid in [
        json!({"neo":{"maxRecords":499}}),
        json!({"neo":{"maxRecords":50000.5}}),
        json!({"neo":{"appendDedupeTailRecords":99}}),
        json!({"neo":{"retention":{"days":0}}}),
        json!({"neo":{"retention":{"softMaxRecords":499}}}),
        json!({"neo":{"retention":{"unknown":true}}}),
    ] {
        assert!(
            plur1bus_engine::config::validate(&invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn host_and_native_neo_config_metadata_are_identical() {
    let native: Value =
        serde_json::from_str(plur1bus_engine::config::NATIVE_NEO_SCHEMA_JSON).unwrap();
    let host: Value = serde_json::from_str(include_str!(
        "../../../packages/config-schema/schema/config.schema.json"
    ))
    .unwrap();
    assert_eq!(
        native["properties"],
        host["properties"]["engine"]["properties"]["neo"]["properties"]
    );
}

#[test]
fn append_policy_defaults_do_not_scale_the_dedupe_tail_with_the_cap() {
    use plur1bus_engine::neo::store_policy::StorePolicy;
    let empty = plur1bus_engine::config::validate(&json!({})).unwrap();
    let defaults = StorePolicy::from_config(&empty).unwrap();
    assert_eq!(defaults.max_records, 40000);
    assert_eq!(defaults.dedupe_tail_records, 5000);
    assert_eq!(defaults.retention_days, 90);
    assert_eq!(defaults.retention_soft_max_records, 5000);
    let small = plur1bus_engine::config::validate(&json!({"neo":{"maxRecords":500}})).unwrap();
    let policy = StorePolicy::from_config(&small).unwrap();
    assert_eq!(policy.max_records, 500);
    assert_eq!(policy.dedupe_tail_records, 5000);
}

#[test]
fn revision_timestamps_use_seconds_below_the_release_boundary() {
    use plur1bus_engine::neo::store_policy::record_time_ms;
    for (input, expected) in [
        (json!({"timestamp":1794139200}), Some(1794139200000.)),
        (
            json!({"timestamp":999999999999_u64}),
            Some(999999999999000.),
        ),
        (json!({"timestamp":1000000000000_u64}), Some(1000000000000.)),
        (json!({"timestamp":-1}), Some(-1000.)),
        (json!({"timestamp":0}), Some(0.)),
        (json!({"timestamp":null}), None),
        (json!({"createdAt":"not-a-date"}), None),
        (
            json!({"createdAt":"2026-11-08T12:00:00.000Z", "timestamp":0}),
            Some(1794139200000.),
        ),
    ] {
        assert_eq!(
            record_time_ms(&parse_json(&input.to_string()).unwrap()).unwrap(),
            expected,
            "{input}"
        );
    }
}
