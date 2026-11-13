//! Actual C4 batches constrained to the existing role/content message contract.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    contract::{Cancel, Message, MessageRole},
    neo::{
        turn_batch::{from_host_messages_since, from_messages, BatchOptions, MessageMetadata},
        turns::TurnBuilder,
    },
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};

fn field<'a>(v: &'a Json, name: &str) -> &'a Json {
    let Json::Object(fields) = v else {
        panic!("object")
    };
    fields
        .iter()
        .find(|(k, _)| k == &JsString::from(name))
        .map(|(_, value)| value)
        .unwrap()
}
fn text(v: &Json) -> &JsString {
    let Json::String(v) = v else { panic!("string") };
    v
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(v) = v else { panic!("array") };
    v
}
fn options(p: &Json) -> BatchOptions<'_> {
    let Json::Number(n) = field(p, "startTurnIndex") else {
        panic!("number")
    };
    BatchOptions {
        workspace_key: text(field(p, "workspaceKey")),
        agent_id: text(field(p, "agentId")),
        session_key: text(field(p, "sessionKey")),
        session_id: text(field(p, "sessionId")),
        start_turn_index: n.parse().unwrap(),
        created_at: text(field(p, "createdAt")),
    }
}
#[test]
fn actual_message_batches_match_node_selection_links_ordinals_and_fields() {
    let f = parse_json(include_str!("fixtures/capture/golden/neo-turn-batch.json")).unwrap();
    let builder = TurnBuilder::new().unwrap();
    for case in array(field(&f, "cases")) {
        let messages: Vec<Message> =
            serde_json::from_str(&write_json(field(case, "messages"))).unwrap();
        let result = from_messages(
            &builder,
            &messages,
            &options(field(case, "params")),
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            write_json(&Json::Array(result)),
            write_json(field(case, "output")),
            "{}",
            write_json(field(case, "name"))
        );
    }
}

#[test]
fn host_metadata_matches_node_times_tool_filtering_and_stable_ids() {
    let fixture = parse_json(include_str!(
        "fixtures/capture/golden/neo-host-metadata.json"
    ))
    .unwrap();
    let builder = TurnBuilder::new().unwrap();
    let params = options(field(&fixture, "params"));
    let records: serde_json::Value =
        serde_json::from_str(&write_json(field(&fixture, "messages"))).unwrap();
    let (messages, metadata): (Vec<_>, Vec<_>) = records
        .as_array()
        .unwrap()
        .iter()
        .map(|record| {
            (
                Message {
                    role: serde_json::from_value(record["role"].clone()).unwrap(),
                    content: record["content"].as_str().unwrap().to_owned(),
                },
                MessageMetadata {
                    timestamp_ms: record["timestamp"].as_i64(),
                    tool_name: record["toolName"].as_str().map(str::to_owned),
                    is_error: record["isError"] == true,
                    tool_call_id: record["toolCallId"].as_str().map(str::to_owned),
                },
            )
        })
        .unzip();
    let expected = array(field(&fixture, "output"));
    let cancel = Cancel::never();
    let actual =
        from_host_messages_since(&builder, &messages, Some(&metadata), &params, 0, &cancel)
            .unwrap();
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        for key in [
            "id",
            "turnIndex",
            "content",
            "origin",
            "visibility",
            "createdAt",
        ] {
            assert_eq!(field(actual, key), field(expected, key), "{key}");
        }
    }
    assert_eq!(
        from_host_messages_since(&builder, &messages, Some(&metadata), &params, 6, &cancel)
            .unwrap(),
        actual[3..],
    );
    assert!(from_host_messages_since(
        &builder,
        &messages,
        Some(&metadata[..1]),
        &params,
        0,
        &cancel
    )
    .is_err());
}
#[test]
fn explicit_time_and_cancellation_are_required_even_for_empty_batches() {
    let builder = TurnBuilder::new().unwrap();
    let id = JsString::from("fixture");
    let empty = JsString::from("");
    let mut p = BatchOptions {
        workspace_key: &id,
        agent_id: &id,
        session_key: &id,
        session_id: &id,
        start_turn_index: 0.,
        created_at: &empty,
    };
    assert!(from_messages(&builder, &[], &p, &Cancel::never()).is_err());
    p.created_at = &id;
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(from_messages(&builder, &[], &p, &cancel).is_err());
    assert!(from_messages(
        &builder,
        &[Message {
            role: MessageRole::User,
            content: "visible source".into()
        }],
        &p,
        &cancel
    )
    .is_err());
    p.start_turn_index = f64::NAN;
    let result = from_messages(
        &builder,
        &[Message {
            role: MessageRole::User,
            content: "visible source".into(),
        }],
        &p,
        &Cancel::never(),
    )
    .unwrap();
    assert_eq!(write_json(field(&result[0], "turnIndex")), "0");
}
