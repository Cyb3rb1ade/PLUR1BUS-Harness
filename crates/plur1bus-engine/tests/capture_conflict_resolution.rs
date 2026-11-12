#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "actual Node parity fixtures"
)]
use plur1bus_engine::{
    capture::conflict_resolution::{apply_id, apply_text, confirmation_gate, proposal},
    contract::Cancel,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("object")
    };
    &fields
        .iter()
        .find(|(k, _)| k == &JsString::from(key))
        .unwrap()
        .1
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn text(v: &Json) -> &JsString {
    let Json::String(v) = v else { panic!("string") };
    v
}
#[test]
fn actual_node_proposal_bytes_and_lossless_selection_helpers_match() {
    let raw = include_str!("fixtures/capture/golden/conflict-resolution.json");
    let golden = parse_json(raw).unwrap();
    let exceptions: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/capture/conflict-resolution-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        exceptions["nodeGoldenSha256"],
        format!("{:x}", Sha256::digest(raw.as_bytes()))
    );
    for (i, case) in array(field(&golden, "proposals")).iter().enumerate() {
        let line = text(field(case, "line")).to_utf8_lossy();
        let observed = parse_json(&line).unwrap();
        let actual = proposal(
            field(&observed, "original"),
            field(case, "decision"),
            1735689600000,
            &Cancel::never(),
        );
        if exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["proposalIndex"] == i)
        {
            assert!(actual.is_err());
            continue;
        }
        assert_eq!(write_json(&actual.unwrap()) + "\n", line);
    }
    for case in array(field(&golden, "selectors")) {
        let input = field(case, "input");
        assert_eq!(apply_id(input).unwrap(), *field(case, "id"));
        assert_eq!(apply_text(input).unwrap(), *text(field(case, "text")));
    }
    for case in array(field(&golden, "apply")) {
        assert_eq!(
            confirmation_gate(field(case, "conflict"), field(case, "options")).unwrap_err(),
            text(field(field(case, "result"), "reason")).to_utf8_lossy()
        );
    }
}
#[test]
fn proposal_bounds_cancellation_and_recommendation_never_grant_apply() {
    let original = parse_json(r#"{"existingMemoryId":"old","existingText":"old"}"#).unwrap();
    let decision =
        parse_json(r#"{"resolution":"keep_a","confidence":1,"reason":"fixture"}"#).unwrap();
    let result = proposal(&original, &decision, 0, &Cancel::never()).unwrap();
    assert_eq!(
        field(&result, "recommendation"),
        &Json::String("apply_via_safe_reconsolidation".into())
    );
    assert_eq!(
        confirmation_gate(&result, &Json::Object(vec![])),
        Err("confirm_required")
    );
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(proposal(&original, &decision, 0, &cancel).is_err());
    let huge = Json::Object(vec![(
        "opaque".into(),
        Json::String(JsString::from("x".repeat(1_048_577).as_str())),
    )]);
    assert!(proposal(&huge, &decision, 0, &Cancel::never()).is_err());
    assert!(apply_id(&huge).is_err());
    assert!(apply_text(&huge).is_err());
    let bad = parse_json(r#"{"resolution":"merge","confidence":-0.1}"#).unwrap();
    assert!(proposal(&original, &bad, 0, &Cancel::never()).is_err());
}
