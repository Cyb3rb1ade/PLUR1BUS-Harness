//! Actual candidate, reaction and behavior projections from captured C4 turns.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::Cancel,
    neo::derived::from_turns,
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
fn field<'a>(v: &'a Json, name: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("object")
    };
    &fields
        .iter()
        .find(|(k, _)| k == &JsString::from(name))
        .unwrap()
        .1
}
fn text(v: &Json) -> &JsString {
    let Json::String(v) = v else { panic!("string") };
    v
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn fixture() -> Json {
    parse_json(include_str!("fixtures/capture/golden/neo-derived.json")).unwrap()
}
#[test]
fn actual_candidate_reaction_and_behavior_fields_match_node_in_order() {
    let f = fixture();
    for case in array(field(&f, "cases")) {
        let turns = array(field(case, "turns"));
        let before = write_json(field(case, "turns"));
        let output = from_turns(turns, text(field(case, "extractedAt")), &Cancel::never()).unwrap();
        let actual = Json::Object(vec![
            (JsString::from("candidates"), Json::Array(output.candidates)),
            (JsString::from("reactions"), Json::Array(output.reactions)),
            (JsString::from("behavior"), Json::Array(output.behavior)),
        ]);
        assert_eq!(
            write_json(&actual),
            write_json(field(case, "output")),
            "{}",
            write_json(field(case, "name"))
        );
        assert_eq!(before, write_json(field(case, "turns")));
    }
}
#[test]
fn cancelled_or_ambiguous_sources_and_missing_explicit_time_are_rejected() {
    let f = fixture();
    let case = &array(field(&f, "cases"))[0];
    let time = text(field(case, "extractedAt"));
    let mut turns = array(field(case, "turns")).to_vec();
    assert!(from_turns(&[], &JsString::from(""), &Cancel::never()).is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(from_turns(&[], time, &cancel).is_err());
    assert!(from_turns(&turns, time, &cancel).is_err());
    assert!(from_turns(&[Json::Null], time, &Cancel::never()).is_err());
    let Json::Object(fields) = &mut turns[0] else {
        panic!("object")
    };
    fields.push((JsString::from("id"), Json::String(JsString::from("other"))));
    assert!(from_turns(&turns, time, &Cancel::never()).is_err());
    let mut turns = array(field(case, "turns")).to_vec();
    let Json::Object(fields) = &mut turns[0] else {
        panic!("object")
    };
    let (_, Json::Object(origin)) = fields
        .iter_mut()
        .find(|(k, _)| k == &JsString::from("origin"))
        .unwrap()
    else {
        panic!("origin")
    };
    origin.push((
        JsString::from("trustLevel"),
        Json::String(JsString::from("curated")),
    ));
    assert!(from_turns(&turns, time, &Cancel::never()).is_err());
}
