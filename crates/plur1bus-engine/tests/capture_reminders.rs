//! Actual Node reminder extraction, including half-hour quirks and lossless UTF-16 cuts.
#![allow(clippy::unwrap_used, reason = "golden assertions")]
use plur1bus_engine::{
    capture::reminders,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
const NOW: i64 = 1_710_000_000_000;
fn fixture() -> Json {
    parse_json(include_str!(
        "fixtures/capture/golden/reminder-extraction.json"
    ))
    .unwrap()
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
fn js(v: &Json) -> JsString {
    if let Json::String(v) = v {
        v.clone()
    } else {
        JsString::from("")
    }
}
fn text(v: &Json) -> String {
    js(v).to_utf8_lossy()
}
#[test]
fn relative_time_and_normalized_evidence_match_actual_node_bytes() {
    for case in array(get(&fixture(), "intents")) {
        let input = js(get(case, "text"));
        assert_eq!(
            write_json(&reminders::parse_intent(&input, NOW).unwrap().to_json()),
            text(get(case, "line")),
            "{}",
            input.to_json()
        );
    }
}
#[test]
fn only_enabled_user_items_with_a_time_and_topic_produce_a_plan() {
    for case in array(get(&fixture(), "plans")) {
        let input = js(get(case, "text"));
        let plan = reminders::plan(
            &input,
            &text(get(case, "role")),
            get(case, "enabled") == &Json::Bool(true),
            NOW,
        )
        .unwrap();
        assert_eq!(
            write_json(&plan.to_json()),
            text(get(case, "line")),
            "{}",
            input.to_json()
        );
    }
}
#[test]
fn sentence_topic_and_nudge_projection_preserve_actual_node_unicode_behavior() {
    for case in array(get(&fixture(), "texts")) {
        let input = js(get(case, "text"));
        let evidence = js(get(case, "evidence"));
        let output = reminders::build_text(&input, &evidence).unwrap();
        assert_eq!(
            output.to_json(),
            text(get(case, "line")),
            "{}",
            input.to_json()
        );
        assert_eq!(
            Json::Bool(reminders::has_topic(&output, &evidence.to_utf8_lossy()).unwrap()),
            *get(case, "topic")
        );
    }
    for case in array(get(&fixture(), "stripped")) {
        assert_eq!(
            reminders::strip_nudge(&js(get(case, "text")))
                .unwrap()
                .to_json(),
            text(get(case, "line"))
        );
    }
}
