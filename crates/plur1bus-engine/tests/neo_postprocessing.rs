//! Actual frozen retry decisions and string-ID episode replay filtering.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    neo::postprocessing,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
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
fn number(v: &Json) -> f64 {
    match v {
        Json::Number(v) => v.parse().unwrap(),
        Json::String(v) => match v.to_utf8_lossy().as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            s => s.parse().unwrap(),
        },
        _ => panic!("number"),
    }
}
fn ids(v: &Json) -> Vec<JsString> {
    array(v).iter().map(|v| text(v).clone()).collect()
}
#[test]
fn retry_give_up_and_empty_or_successful_work_match_actual_node() {
    let f = parse_json(include_str!(
        "fixtures/capture/golden/neo-postprocessing.json"
    ))
    .unwrap();
    for c in array(field(&f, "retry")) {
        let results: Vec<_> = array(field(c, "results"))
            .iter()
            .map(|v| v == &Json::Bool(true))
            .collect();
        let result = postprocessing::resolve_advance(
            &results,
            number(field(c, "failures")),
            number(field(c, "maxRetries")),
        );
        let want = field(c, "output");
        assert_eq!(Json::Bool(result.advance), *field(want, "advance"));
        assert_eq!(result.next_failures, number(field(want, "nextFailures")));
        assert_eq!(Json::Bool(result.gave_up), *field(want, "gaveUp"));
    }
}
#[test]
fn episode_dedupe_and_bounded_first_insertion_order_match_actual_node() {
    let f = parse_json(include_str!(
        "fixtures/capture/golden/neo-postprocessing.json"
    ))
    .unwrap();
    for c in array(field(&f, "episodes")) {
        let previous = ids(field(c, "previous"));
        let records = array(field(c, "episodes"));
        let episodes: Vec<_> = records.iter().map(|r| ids(field(r, "memoryIds"))).collect();
        let selected = postprocessing::filter_already_episoded(&episodes, &previous);
        let want = field(c, "filtered");
        let expected: Vec<_> = array(field(want, "fresh"))
            .iter()
            .map(|r| text(field(r, "id")).clone())
            .collect();
        let actual: Vec<_> = selected
            .indices
            .iter()
            .map(|i| text(field(&records[*i], "id")).clone())
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(selected.skipped as f64, number(field(want, "skipped")));
        assert_eq!(
            postprocessing::merge_episoded_ids(&previous, &episodes, number(field(c, "limit"))),
            ids(field(c, "merged"))
        );
    }
}
