//! RE-D63: episode deltas reference actual full-journal identities, including repeated content.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::Cancel,
    neo::{
        turn_batch::{from_messages_since, BatchOptions},
        turns::TurnBuilder,
    },
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[test]
fn selected_turns_match_full_node_journal_and_preserve_duplicate_ordinals() {
    let fixture = include_str!("fixtures/capture/golden/neo-episode-turn-selection.json");
    let data: Value = serde_json::from_str(fixture).unwrap();
    let exceptions: Value = serde_json::from_str(include_str!(
        "fixtures/capture/neo-episode-turn-selection-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(fixture.as_bytes())),
        exceptions["nodeGoldenSha256"]
    );
    let builder = TurnBuilder::new().unwrap();
    let mut changed = Vec::new();
    for case in data["cases"].as_array().unwrap() {
        let messages: Vec<plur1bus_engine::contract::Message> =
            serde_json::from_value(case["messages"].clone()).unwrap();
        let opt = &case["options"];
        let workspace = JsString::from(opt["workspaceKey"].as_str().unwrap());
        let agent = JsString::from(opt["agentId"].as_str().unwrap());
        let session = JsString::from(opt["sessionKey"].as_str().unwrap());
        let run = JsString::from(opt["sessionId"].as_str().unwrap());
        let now = JsString::from(opt["createdAt"].as_str().unwrap());
        let options = BatchOptions {
            workspace_key: &workspace,
            agent_id: &agent,
            session_key: &session,
            session_id: &run,
            start_turn_index: 0.,
            created_at: &now,
        };
        let output = from_messages_since(
            &builder,
            &messages,
            &options,
            case["baseline"].as_u64().unwrap() as usize,
            &Cancel::never(),
        )
        .unwrap();
        let actual: Value = serde_json::from_str(&write_json(&Json::Array(output))).unwrap();
        assert_eq!(actual, case["selectedJournal"], "{}", case["name"]);
        if actual != case["legacyDelta"] {
            changed.push(case["name"].clone());
        }
        if case["name"] == "conversation-0-baseline-2" {
            assert_eq!(case["legacyDelta"][0]["id"], case["full"][0]["id"]);
            assert_ne!(actual[0]["id"], case["legacyDelta"][0]["id"]);
            assert_eq!(actual[0]["id"], case["full"][2]["id"]);
        }
    }
    assert_eq!(Value::Array(changed), exceptions["cases"]);
}
