//! Actual C4 event construction and stable replay identities, before host metadata adaptation.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use plur1bus_engine::{
    neo::turns::{stable_turn_id, Role, TurnBuilder, TurnInput},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
fn field<'a>(v: &'a Json, k: &str) -> &'a Json {
    let Json::Object(v) = v else { panic!("object") };
    &v.iter()
        .find(|(key, _)| key == &JsString::from(k))
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
fn ids(v: &Json) -> Vec<JsString> {
    array(v).iter().map(|v| text(v).clone()).collect()
}
#[test]
fn actual_turn_fields_scopes_origin_and_lexical_emotion_match_node() {
    let f = parse_json(include_str!("fixtures/capture/golden/neo-turns.json")).unwrap();
    let builder = TurnBuilder::new().unwrap();
    for case in array(field(&f, "construct")) {
        let p = field(case, "params");
        let tools = ids(field(p, "sourceToolCallIds"));
        let replies = ids(field(p, "repliesToTurnIds"));
        let Json::Number(index) = field(p, "turnIndex") else {
            panic!("index")
        };
        let role = Role::parse(&text(field(p, "role")).to_utf8_lossy()).unwrap();
        let input = TurnInput {
            id: text(field(p, "id")),
            workspace_key: text(field(p, "workspaceKey")),
            agent_id: text(field(p, "agentId")),
            session_id: text(field(p, "sessionId")),
            turn_index: index.parse().unwrap(),
            role,
            content: text(field(p, "content")),
            scope: text(field(p, "scope")),
            source_tool_call_ids: &tools,
            replies_to_turn_ids: &replies,
            created_at: text(field(p, "createdAt")),
        };
        assert_eq!(
            write_json(&builder.build(&input).unwrap()),
            write_json(field(case, "output")),
            "{}",
            write_json(field(p, "id"))
        );
    }
}
#[test]
fn stable_ids_preserve_normalized_utf16_content_and_duplicate_ordinals() {
    let f = parse_json(include_str!("fixtures/capture/golden/neo-turns.json")).unwrap();
    for case in array(field(&f, "stable")) {
        let role = Role::parse(&text(field(case, "role")).to_utf8_lossy()).unwrap();
        let tools = ids(field(case, "sourceToolCallIds"));
        for (ordinal, id) in array(field(case, "ids")).iter().enumerate() {
            assert_eq!(
                stable_turn_id(
                    text(field(case, "workspaceKey")),
                    text(field(case, "agentId")),
                    text(field(case, "sessionKey")),
                    role,
                    text(field(case, "content")),
                    &tools,
                    ordinal as u32
                ),
                *text(id)
            );
        }
    }
}

#[test]
fn missing_identity_or_time_cannot_fall_back_to_random_or_ambient_values() {
    let builder = TurnBuilder::new().unwrap();
    let valid = JsString::from("fixture");
    let empty = JsString::from("");
    let scope = JsString::from("agent_private");
    let mut input = TurnInput {
        id: &empty,
        workspace_key: &valid,
        agent_id: &valid,
        session_id: &valid,
        turn_index: 0.,
        role: Role::User,
        content: &valid,
        scope: &scope,
        source_tool_call_ids: &[],
        replies_to_turn_ids: &[],
        created_at: &valid,
    };
    assert!(builder.build(&input).is_err());
    input.id = &valid;
    input.created_at = &empty;
    assert!(builder.build(&input).is_err());
    assert_eq!(Role::parse("\u{feff}toolResult \t"), Some(Role::Tool));
    assert!(Role::parse("system").is_none());
}
