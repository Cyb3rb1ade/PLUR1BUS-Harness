//! Actual pinned Node state transitions, with explicit time and no scope expansion.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    neo::status::{transition, Status},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
fn field<'a>(value: &'a Json, name: &str) -> &'a Json {
    let Json::Object(fields) = value else {
        panic!("fixture object")
    };
    &fields
        .iter()
        .find(|(key, _)| key == &JsString::from(name))
        .unwrap()
        .1
}
#[test]
fn all_seven_transitions_match_real_node_including_legacy_coercions() {
    let fixture = parse_json(include_str!("fixtures/capture/golden/neo-status.json")).unwrap();
    let Json::Array(cases) = field(&fixture, "cases") else {
        panic!("fixture cases")
    };
    for case in cases {
        let Json::String(status) = field(case, "status") else {
            panic!("status")
        };
        let Json::String(now) = field(case, "now") else {
            panic!("time")
        };
        let record = field(case, "record");
        let before = write_json(record);
        let result = transition(record, Status::parse(status).unwrap(), now).unwrap();
        assert_eq!(
            write_json(&result),
            write_json(field(case, "output")),
            "{}",
            write_json(field(case, "name"))
        );
        assert_eq!(write_json(record), before);
        assert_eq!(field(&result, "origin"), field(record, "origin"));
        assert_eq!(field(&result, "visibility"), field(record, "visibility"));
    }
}
#[test]
fn malformed_commands_do_not_gain_default_status_or_ambient_time() {
    assert!(Status::parse(&JsString::from("PROMOTED")).is_none());
    assert!(Status::parse(&JsString::from("unknown")).is_none());
    assert!(transition(&Json::Null, Status::Promoted, &JsString::from("now")).is_err());
    assert!(transition(
        &parse_json("{}").unwrap(),
        Status::Promoted,
        &JsString::from("")
    )
    .is_err());
}
