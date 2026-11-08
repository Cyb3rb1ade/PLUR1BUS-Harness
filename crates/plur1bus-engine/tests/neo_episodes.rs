//! Actual C4 deterministic episodes and grouping; no narrative model invocation.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::Cancel,
    neo::episodes::{self, BuildOptions},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
fn field<'a>(v: &'a Json, name: &str) -> Option<&'a Json> {
    let Json::Object(fields) = v else { return None };
    fields
        .iter()
        .find(|(k, _)| k == &JsString::from(name))
        .map(|(_, v)| v)
}
fn at<'a>(v: &'a Json, name: &str) -> &'a Json {
    field(v, name).unwrap()
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn string(v: &Json) -> &JsString {
    let Json::String(v) = v else { panic!("string") };
    v
}
fn number(v: &Json) -> f64 {
    let Json::Number(v) = v else { panic!("number") };
    v.parse().unwrap()
}
#[test]
fn actual_episode_fields_and_vividness_match_frozen_node() {
    let fixture = parse_json(include_str!("fixtures/capture/golden/neo-episodes.json")).unwrap();
    assert_eq!(
        string(at(at(&fixture, "provenance"), "unicodeDataSha256")).to_utf8_lossy(),
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("../src/neo/episode-unicode17.json"))
        )
    );
    for case in array(at(&fixture, "cases")) {
        let turns = array(at(case, "turns"));
        let options = at(case, "options");
        let id = JsString::from("00000000-0000-4000-8000-000000000001");
        let now = string(at(case, "now"));
        let names = field(options, "participantNames")
            .map(|names| (string(at(names, "user")), string(at(names, "assistant"))));
        let result = episodes::create(
            turns,
            &BuildOptions {
                id: &id,
                now,
                workspace_key: string(at(options, "workspaceKey")),
                agent_id: string(at(options, "agentId")),
                session_key: string(at(options, "sessionKey")),
                participant_names: names,
                mood: field(options, "mood"),
            },
            &Cancel::never(),
        )
        .unwrap();
        let actual = result.unwrap_or(Json::Null);
        assert_eq!(
            write_json(&actual),
            write_json(at(case, "output")),
            "{}",
            write_json(at(case, "name"))
        );
        if actual != Json::Null {
            let time = chrono::DateTime::parse_from_rfc3339(&now.to_utf8_lossy())
                .unwrap()
                .timestamp_millis();
            let value = episodes::vividness(&actual, time).unwrap();
            assert!(
                (value - number(at(case, "vividness"))).abs() < 1e-12,
                "{}",
                write_json(at(case, "name"))
            );
        }
    }
}
#[test]
fn actual_grouping_respects_sorted_time_exact_gap_and_turn_caps() {
    let fixture = parse_json(include_str!("fixtures/capture/golden/neo-episodes.json")).unwrap();
    for case in array(at(&fixture, "groups")) {
        let options = at(case, "options");
        let result = episodes::group(
            array(at(case, "turns")),
            number(at(options, "maxGapMinutes")),
            number(at(options, "maxEpisodeTurns")) as usize,
            &Cancel::never(),
        )
        .unwrap();
        let actual = Json::Array(result.into_iter().map(Json::Array).collect());
        assert_eq!(actual, *at(case, "output"));
    }
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(episodes::group(&[], 30., 50, &cancel).is_err());
    assert!(episodes::group(
        &[parse_json(r#"{"createdAt":"invalid"}"#).unwrap()],
        30.,
        50,
        &Cancel::never()
    )
    .is_err());
}

#[test]
fn creation_requires_explicit_identity_clock_and_live_cancellation() {
    let id = JsString::from("fixture-id");
    let now = JsString::from("2026-11-08T12:00:00.000Z");
    let empty = JsString::from("");
    let mut options = BuildOptions {
        id: &id,
        now: &now,
        workspace_key: &empty,
        agent_id: &empty,
        session_key: &empty,
        participant_names: None,
        mood: None,
    };
    let turns = [parse_json(r#"{"id":"turn-one","role":"user","content":"normal fact","createdAt":"2026-11-08T12:00:00.000Z"}"#).unwrap()];
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(episodes::create(&turns, &options, &cancel).is_err());
    options.id = &empty;
    assert!(episodes::create(&turns, &options, &Cancel::never()).is_err());
    options.id = &id;
    options.now = &empty;
    assert!(episodes::create(&turns, &options, &Cancel::never()).is_err());
    options.now = &now;
    let invalid = [parse_json(r#"{"createdAt":"invalid"}"#).unwrap()];
    assert!(episodes::create(&invalid, &options, &Cancel::never()).is_err());
    assert!(episodes::group(&turns, f64::NAN, 50, &Cancel::never()).is_err());
}
