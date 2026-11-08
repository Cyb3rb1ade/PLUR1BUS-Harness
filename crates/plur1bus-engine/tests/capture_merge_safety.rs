//! Merge guards must preserve the actual pinned lexical defects and ordered evidence.
#![allow(clippy::unwrap_used, reason = "golden assertions")]
use plur1bus_engine::{
    capture::merge_safety,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
fn fixture() -> Json {
    parse_json(include_str!("fixtures/capture/golden/merge-safety.json")).unwrap()
}
fn get<'a>(v: &'a Json, key: &str) -> &'a Json {
    static NULL: Json = Json::Null;
    if let Json::Object(fields) = v {
        fields
            .iter()
            .find(|(k, _)| k == &JsString::from(key))
            .map_or(&NULL, |(_, v)| v)
    } else {
        &NULL
    }
}
fn array(v: &Json) -> &[Json] {
    if let Json::Array(v) = v {
        v
    } else {
        &[]
    }
}
fn text(v: &Json) -> JsString {
    if let Json::String(s) = v {
        s.clone()
    } else {
        JsString::default()
    }
}
#[test]
fn ordered_salient_terms_and_unicode17_normalization_match_node_bytes() {
    for case in array(get(&fixture(), "terms")) {
        let input = text(get(case, "input"));
        assert_eq!(
            merge_safety::normalize(&input).unwrap().to_json(),
            text(get(case, "normalizedLine")).to_utf8_lossy(),
            "{input:?}"
        );
        assert_eq!(
            write_json(&merge_safety::extract_terms(&input).unwrap().to_json()),
            text(get(case, "line")).to_utf8_lossy(),
            "{input:?}"
        );
    }
}
#[test]
fn role_reversal_structured_differences_and_duplicate_thresholds_match_node() {
    for case in array(get(&fixture(), "comparisons")) {
        let a = text(get(case, "a"));
        let b = text(get(case, "b"));
        assert_eq!(
            write_json(&merge_safety::structured_differences(&a, &b).unwrap()),
            text(get(case, "differencesLine")).to_utf8_lossy(),
            "{a:?}/{b:?}"
        );
        assert_eq!(
            Json::Bool(merge_safety::meaningful_difference(&a, &b).unwrap()),
            *get(case, "meaningful"),
            "{a:?}/{b:?}"
        );
        assert_eq!(
            Json::Bool(merge_safety::safe_duplicate(&a, &b).unwrap()),
            *get(case, "duplicate"),
            "{a:?}/{b:?}"
        );
    }
}
#[test]
fn merge_safety_refuses_the_golden_case_and_preserves_all_source_terms() {
    for case in array(get(&fixture(), "merges")) {
        let a = text(get(case, "a"));
        let b = text(get(case, "b"));
        let merged = text(get(case, "merged"));
        assert_eq!(
            Json::Bool(merge_safety::preserves_facts(&a, &b, &merged).unwrap()),
            *get(case, "preserves"),
            "{a:?}/{b:?}/{merged:?}"
        );
    }
}
#[test]
fn production_vocabulary_is_the_recorded_pinned_source_extraction() {
    let data: serde_json::Value =
        serde_json::from_str(include_str!("../src/capture/merge-safety-data.json")).unwrap();
    let provenance: serde_json::Value =
        serde_json::from_str(&write_json(get(&fixture(), "provenance"))).unwrap();
    assert_eq!(data["provenance"], provenance);
    assert_eq!(
        data["provenance"]["commit"],
        "9f34008c143c5da87b2194b5a28442b407ff8ba7"
    );
    assert_eq!(data["vocabulary"].as_object().unwrap().len(), 6);
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("../src/capture/merge-safety-data.json"))
        ),
        text(get(&fixture(), "vocabularySha256")).to_utf8_lossy()
    );
}
