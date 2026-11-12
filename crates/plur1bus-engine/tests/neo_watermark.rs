//! Actual S2 session-local compare-and-set plans, without fake persisted execution.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    neo::watermark,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("object")
    };
    &fields
        .iter()
        .find(|(k, _)| k == &JsString::from(key))
        .unwrap()
        .1
}
fn text(v: &Json) -> &JsString {
    let Json::String(v) = v else { panic!("string") };
    v
}
#[test]
fn actual_s2_session_read_claim_advance_failure_and_eviction_match_node() {
    let f = parse_json(include_str!("fixtures/capture/golden/neo-watermark.json")).unwrap();
    let Json::Array(cases) = get(&f, "cases") else {
        panic!("cases")
    };
    for c in cases {
        let state = get(c, "state");
        let before = write_json(state);
        let key = text(get(c, "session"));
        let now = text(get(c, "now"));
        let output = match text(get(c, "action")).to_utf8_lossy().as_str() {
            "read" => watermark::read_session(state, key).to_json(),
            "claim" => watermark::plan_legacy_claim(state, key, now)
                .unwrap()
                .unwrap_or(Json::Null),
            "advance" => {
                let change = get(c, "change");
                watermark::plan_advance(state, key, get(change, "baseline"), get(change, "to"), now)
                    .unwrap()
                    .unwrap_or(Json::Null)
            }
            "failure" => {
                let change = get(c, "change");
                watermark::plan_failure(
                    state,
                    key,
                    get(change, "baseline"),
                    get(change, "failures"),
                    now,
                )
                .unwrap()
                .unwrap_or(Json::Null)
            }
            _ => panic!("action"),
        };
        assert_eq!(
            write_json(&output),
            write_json(get(c, "output")),
            "{}",
            write_json(get(c, "name"))
        );
        assert_eq!(write_json(state), before);
    }
}
#[test]
fn empty_host_time_is_rejected_before_a_patch_can_be_produced() {
    let state = parse_json("{}").unwrap();
    let zero = Json::Number("0".into());
    assert!(watermark::plan_advance(
        &state,
        &JsString::from("a"),
        &zero,
        &zero,
        &JsString::from("")
    )
    .is_err());
    assert!(watermark::plan_failure(
        &state,
        &JsString::from("a"),
        &zero,
        &zero,
        &JsString::from("")
    )
    .is_err());
    assert!(
        watermark::plan_legacy_claim(&state, &JsString::from("a"), &JsString::from("")).is_err()
    );
}

#[test]
fn out_of_order_completion_cannot_undo_progress_or_update_another_session() {
    let mut state = parse_json(
        r#"{"sessionWatermarks":{"s:a":{"count":5,"failures":0},"s:b":{"count":99,"failures":1}}}"#,
    )
    .unwrap();
    let key = JsString::from("a");
    let now = JsString::from("2026-11-08T12:00:00.000Z");
    let n = |v: i32| Json::Number(v.to_string());
    let patch = watermark::plan_advance(&state, &key, &n(5), &n(20), &now)
        .unwrap()
        .unwrap();
    state = patch;
    assert!(watermark::plan_advance(&state, &key, &n(5), &n(10), &now)
        .unwrap()
        .is_none());
    assert!(watermark::plan_failure(&state, &key, &n(5), &n(3), &now)
        .unwrap()
        .is_none());
    assert_eq!(
        watermark::read_session(&state, &JsString::from("b")).count,
        99.
    );
    let reset = watermark::plan_advance(&state, &key, &n(20), &n(2), &now)
        .unwrap()
        .unwrap();
    assert_eq!(watermark::read_session(&reset, &key).count, 2.);
    assert_eq!(
        watermark::read_session(&reset, &JsString::from("b")).failures,
        1.
    );
}
#[test]
fn ambiguous_maps_and_arrays_cannot_produce_mutation_plans() {
    let now = JsString::from("2026-11-08T12:00:00.000Z");
    let zero = Json::Number("0".into());
    for raw in [
        r#"{"sessionWatermarks":[]}"#,
        r#"{"sessionWatermarks":{"s:a":{"count":1},"s:a":{"count":2}}}"#,
        r#"{"sessionWatermarks":{},"sessionWatermarks":{}}"#,
    ] {
        let state = parse_json(raw).unwrap();
        assert!(watermark::plan_advance(&state, &JsString::from("a"), &zero, &zero, &now).is_err());
    }
}
