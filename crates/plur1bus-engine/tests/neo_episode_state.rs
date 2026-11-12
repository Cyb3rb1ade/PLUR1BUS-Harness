//! Actual C4 continuation plans and preservation of persisted open state on known spans.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::Cancel,
    neo::episode_state::{self, Options},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
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
fn actual_open_episode_transitions_match_node_without_model_work() {
    let fixture = parse_json(include_str!(
        "fixtures/capture/golden/neo-episode-state.json"
    ))
    .unwrap();
    for case in array(at(&fixture, "cases")) {
        let input = at(case, "options");
        let ids = field(input, "episodedTurnIds")
            .map(array)
            .unwrap_or(&[])
            .iter()
            .map(|v| string(v).clone())
            .collect::<Vec<_>>();
        let allocated = array(at(case, "allocatedIds"));
        let mut cursor = 0;
        let names = at(input, "participantNames");
        let options = Options {
            now: string(at(case, "now")),
            workspace_key: string(at(input, "workspaceKey")),
            agent_id: string(at(input, "agentId")),
            session_key: string(at(input, "sessionKey")),
            participant_names: Some((string(at(names, "user")), string(at(names, "assistant")))),
            mood: field(input, "mood"),
            open_episode: field(input, "openEpisode"),
            episoded_turn_ids: &ids,
            max_gap_minutes: field(input, "maxGapMinutes").map_or(30., number),
            max_episode_turns: field(input, "maxEpisodeTurns").map_or(50, |v| number(v) as usize),
        };
        let actual = episode_state::extract(
            array(at(case, "turns")),
            &options,
            &mut || {
                let id = string(&allocated[cursor]).clone();
                cursor += 1;
                Ok(id)
            },
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            write_json(&actual),
            write_json(at(case, "output")),
            "{}",
            write_json(at(case, "name"))
        );
        assert_eq!(cursor, allocated.len(), "UUID allocation order");
    }
}

#[test]
fn cancellation_and_id_allocation_failure_return_no_partial_plan() {
    let now = JsString::from("2026-11-08T12:00:00.000Z");
    let empty = JsString::from("");
    let turns = [parse_json(r#"{"id":"turn-one","role":"user","content":"Fact","createdAt":"2026-11-08T12:00:00.000Z"}"#).unwrap()];
    let options = Options {
        now: &now,
        workspace_key: &empty,
        agent_id: &empty,
        session_key: &empty,
        participant_names: None,
        mood: None,
        open_episode: None,
        episoded_turn_ids: &[],
        max_gap_minutes: 30.,
        max_episode_turns: 50,
    };
    let cancel = Cancel::never();
    cancel.cancel();
    let mut calls = 0;
    assert!(episode_state::extract(
        &turns,
        &options,
        &mut || {
            calls += 1;
            Ok(JsString::from("unused"))
        },
        &cancel
    )
    .is_err());
    assert_eq!(calls, 0);
    assert!(episode_state::extract(
        &turns,
        &options,
        &mut || { Err(plur1bus_engine::contract::StoreError::Unavailable.into()) },
        &Cancel::never()
    )
    .is_err());
    let cancel = Cancel::never();
    assert!(episode_state::extract(
        &turns,
        &options,
        &mut || {
            cancel.cancel();
            Ok(JsString::from("unused"))
        },
        &cancel
    )
    .is_err());
}
