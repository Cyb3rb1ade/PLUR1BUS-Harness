//! Actual pinned MemoryDB selection and private authority-before-budget exception evidence.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline golden assertions"
)]
use plur1bus_engine::{
    capture::normal_candidates::{select, Thresholds},
    contract::Cancel,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    if let Json::Object(v) = v {
        v.iter()
            .find(|(k, _)| k == &JsString::from(key))
            .map(|(_, v)| v)
            .unwrap_or(&Json::Null)
    } else {
        &Json::Null
    }
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn text(v: &Json) -> String {
    let Json::String(v) = v else { panic!("text") };
    v.to_utf8_lossy()
}
fn number(v: &Json, fallback: f64) -> f64 {
    if let Json::Number(v) = v {
        v.parse().unwrap()
    } else {
        fallback
    }
}
#[test]
fn actual_candidate_budgets_scores_order_and_validity_match() {
    let bytes = include_bytes!("fixtures/capture/golden/normal-store-candidates.json");
    let golden = parse_json(std::str::from_utf8(bytes).unwrap()).unwrap();
    for case in array(field(&golden, "cases")) {
        let scenario = field(case, "scenario");
        let name = text(field(scenario, "name"));
        let expected = field(case, "authorizedFirst");
        let incoming = if let Json::String(v) = field(scenario, "text") {
            v.clone()
        } else {
            JsString::from("I enjoy drinking coffee every morning.")
        };
        let thresholds = Thresholds {
            duplicate: number(field(scenario, "threshold"), 0.95),
            merge: number(field(scenario, "merge"), 0.7),
        };
        let actual = select(
            array(field(expected, "inputRows")),
            &incoming,
            field(scenario, "window"),
            thresholds,
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            write_json(&actual.duplicates),
            write_json(field(expected, "duplicates")),
            "{name}"
        );
        assert_eq!(
            write_json(&actual.safe_duplicate),
            write_json(field(expected, "safe")),
            "{name}"
        );
        assert_eq!(
            write_json(&actual.merge),
            write_json(field(expected, "rawMerge")),
            "{name}"
        );
    }
}
#[test]
fn authority_budget_exceptions_are_bound_to_actual_original_and_filtered_node_runs() {
    let bytes = include_bytes!("fixtures/capture/golden/normal-store-candidates.json");
    let golden: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    let exceptions: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/capture/normal-store-candidates-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        exceptions["nodeGoldenSha256"],
        format!("{:x}", Sha256::digest(bytes))
    );
    for e in exceptions["cases"].as_array().unwrap() {
        let case = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["scenario"]["name"] == e["name"])
            .unwrap();
        let key = e["field"].as_str().unwrap();
        assert_eq!(case["observed"][key], e["observed"]);
        assert_eq!(case["authorizedFirst"][key], e["native"]);
        assert_ne!(e["observed"], e["native"]);
    }
}

#[test]
fn corrupt_query_evidence_and_cancelled_selection_refuse() {
    let incoming = JsString::from("Synthetic fact");
    let row =
        parse_json(r#"{"id":"fixture","text":"Synthetic fact","status":"active","_distance":0}"#)
            .unwrap();
    let thresholds = Thresholds {
        duplicate: 0.95,
        merge: 0.7,
    };
    for raw in [
        r#"{"text":"Synthetic fact","_distance":-1}"#,
        r#"{"text":"Synthetic fact","_distance":1e999}"#,
        r#"{"text":"Synthetic fact","_distance":"0"}"#,
        r#"{"text":"Synthetic fact","status":"deleted","_distance":0}"#,
        r#"{"text":"Synthetic fact","epistemicStatus":"invalidated","_distance":0}"#,
    ] {
        assert!(select(
            &[parse_json(raw).unwrap()],
            &incoming,
            &Json::Null,
            thresholds,
            &Cancel::never()
        )
        .is_err());
    }
    assert!(select(
        &vec![row.clone(); 1025],
        &incoming,
        &Json::Null,
        thresholds,
        &Cancel::never()
    )
    .is_err());
    assert!(select(
        std::slice::from_ref(&row),
        &incoming,
        &Json::Null,
        Thresholds {
            duplicate: f64::NAN,
            merge: 0.7
        },
        &Cancel::never()
    )
    .is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(select(&[row], &incoming, &Json::Null, thresholds, &cancel).is_err());
}
