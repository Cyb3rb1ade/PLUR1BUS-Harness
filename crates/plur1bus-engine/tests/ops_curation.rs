//! Pure A1 list selection with original human context and explicit D130 exception.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "fixture assertions"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, MemoryOpErrorCode, Principal},
    neo::curation::{list, queue},
    text::json::{parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
fn context(request: &Value, origin: &str, background: bool) -> RequestContext {
    let host = support::TestHost::new("/fixture/state".into());
    let principal: Principal = serde_json::from_value(json!({
        "agentId": request["agentId"], "workspace": request["workspaceIdentity"], "user": request["ownerUserId"],
        "channel":"telegram", "accountId":"fixture", "chat":{"id":"fixture","kind":"direct"}, "trust":"proved"
    })).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":origin,"background":background})).unwrap();
    RequestContext::build(&principal, &agent, &host).unwrap()
}
fn field<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    match value {
        Json::Object(fields) => fields
            .iter()
            .find(|(key, _)| key == &name.into())
            .map(|(_, value)| value),
        _ => None,
    }
}
fn rows(value: &Json, name: &str) -> Vec<Json> {
    let found = match value {
        Json::Object(fields) => fields
            .iter()
            .find(|(key, _)| key == &name.into())
            .map(|(_, value)| value),
        _ => None,
    };
    match found {
        Some(Json::Array(rows)) => Some(rows.clone()),
        _ => None,
    }
    .expect("fixture rows")
}
#[test]
fn twenty_three_node_lists_preserve_latest_revisions_order_and_projection() {
    use sha2::{Digest, Sha256};
    let raw = include_bytes!("fixtures/ops/golden/curation-list.json");
    let golden: Value = serde_json::from_slice(raw).unwrap();
    let exceptions: Value = serde_json::from_str(include_str!(
        "fixtures/ops/curation-list-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(raw)),
        exceptions["nodeGoldenSha256"]
    );
    let ctx = context(&golden["requester"], "user", false);
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let input = parse_json(case["inputJson"].as_str().unwrap()).unwrap();
        let limit = match field(&input, "query").and_then(|q| field(q, "limit")) {
            Some(Json::Number(value)) => Some(value.parse::<f64>().unwrap()),
            None | Some(Json::Null) => None,
            _ => panic!("unexpected fixture limit"),
        };
        let result = list(
            &rows(&input, "candidates"),
            &rows(&input, "behavior"),
            &ctx,
            limit,
            &Cancel::never(),
        );
        if case.get("error").is_some() {
            assert!(
                matches!(result, Err(EngineError::MemoryOp(error)) if error.code == MemoryOpErrorCode::InvalidInput)
            );
        } else {
            let expected = exceptions["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|value| value["index"].as_u64() == Some(index as u64))
                .unwrap_or(case);
            assert_eq!(
                write_json(&result.unwrap()),
                expected["outputJson"].as_str().unwrap(),
                "{index}"
            );
        }
    }
}

#[test]
fn background_system_cancel_and_ambiguous_or_unsupported_sources_refuse() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/curation-list.json")).unwrap();
    for (origin, background) in [("system", false), ("user", true), ("subagent", false)] {
        let ctx = context(&golden["requester"], origin, background);
        assert!(matches!(list(&[], &[], &ctx, None, &Cancel::never()),
            Err(EngineError::MemoryOp(error)) if error.code == MemoryOpErrorCode::Denied));
    }
    let ctx = context(&golden["requester"], "user", false);
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(queue(&[], &[], &ctx, &cancelled).is_err());
    for raw in [
        r#"{"id":"x","id":"y"}"#,
        r#"{"id":"x","createdAt":"11/08/2026"}"#,
        r#"{"id":" "}"#,
    ] {
        assert!(queue(&[parse_json(raw).unwrap()], &[], &ctx, &Cancel::never()).is_err());
    }
    assert!(queue(&vec![Json::Null; 10001], &[], &ctx, &Cancel::never()).is_err());
}

#[test]
fn a_newer_hidden_revision_never_resurrects_the_older_visible_record() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/curation-list.json")).unwrap();
    let ctx = context(&golden["requester"], "user", false);
    let input = parse_json(golden["cases"][10]["inputJson"].as_str().unwrap()).unwrap();
    let mut newer = rows(&input, "candidates");
    let mut older: Value = serde_json::from_str(&write_json(&newer[0])).unwrap();
    older["ownerUserId"] = golden["requester"]["ownerUserId"].clone();
    older["ownerId"] = golden["requester"]["ownerUserId"].clone();
    older["createdAt"] = json!(1);
    newer.insert(0, parse_json(&older.to_string()).unwrap());
    assert!(queue(&newer, &[], &ctx, &Cancel::never())
        .unwrap()
        .is_empty());
}
