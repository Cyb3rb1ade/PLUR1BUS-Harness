//! A1 plans compared to the actual promotion helper's real workspace effects.
#![allow(clippy::unwrap_used, reason = "synthetic actual-Node parity fixtures")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::{Cancel, EngineError, MemoryOpErrorCode, MemoryRow, StoreError},
    ops::promotion_plan::{plan, PromotionInput},
    recall::acl::AclSubject,
    text::json::parse_json,
};
use serde_json::{json, Value};
use std::collections::HashMap;
#[test]
fn selection_evidence_markers_caps_and_queue_effects_match_actual_node() {
    let g: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/knowledge-promotion.json")).unwrap();
    let context = AclSubject {
        agent_id: "agent".into(),
        workspace_identity: g["context"]["workspaceIdentity"].as_str().unwrap().into(),
        user_principal: g["context"]["userPrincipal"].as_str().unwrap().into(),
        aliases: Some(Default::default()),
    };
    for case in g["cases"].as_array().unwrap() {
        let mut rows: HashMap<String, Value> = case["input"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["id"].as_str().unwrap().into(), r.clone()))
            .collect();
        for step in case["steps"].as_array().unwrap() {
            for r in step["step"]["replace"].as_array().into_iter().flatten() {
                rows.insert(r["id"].as_str().unwrap().into(), r.clone());
            }
            let config = case["input"].get("config").cloned().unwrap_or(
                json!({"schicht15":{"enabled":true,"maxPromotionsPerRun":0,"minImportance":0.7}}),
            );
            let ids: Option<Vec<String>> = step["step"]
                .get("ids")
                .map(|v| serde_json::from_value(v.clone()).unwrap());
            let pending = parse_json(step["before"]["queue"].as_str().unwrap_or("{}")).unwrap();
            let mut reads = Vec::new();
            let result = plan(
                &PromotionInput {
                    context: &context,
                    config: &config,
                    ids: ids.as_deref(),
                    pending: &pending,
                    content: step["before"]["content"].as_str(),
                    now: g["now"].as_i64().unwrap(),
                    lock_busy: step["step"]["busy"] == true,
                },
                &Cancel::never(),
                |id| {
                    reads.push(id.to_owned());
                    rows.get(id)
                        .map(|r| {
                            let mut value = serde_json::to_value(support::memory_row(
                                id,
                                "agent",
                                "agent-private",
                            ))
                            .unwrap();
                            for (k, v) in r.as_object().unwrap() {
                                value[k] = v.clone();
                            }
                            serde_json::from_value::<MemoryRow>(value)
                                .map_err(|_| EngineError::Store(StoreError::Corrupt))
                        })
                        .transpose()
                },
                || {
                    if step["step"]["closed"] == true {
                        Err(EngineError::Store(StoreError::Corrupt))
                    } else {
                        Ok(())
                    }
                },
            );
            assert_eq!(json!(reads), step["reads"], "{}", case["input"]["name"]);
            if !step["error"].is_null() {
                assert!(result.is_err(), "{}", case["input"]["name"]);
                if step["error"]["code"] == "invalid-input" {
                    assert!(
                        matches!(result,Err(EngineError::MemoryOp(e)) if e.code==MemoryOpErrorCode::InvalidInput)
                    );
                }
            } else {
                let planned = result.unwrap();
                assert_eq!(
                    serde_json::to_value(planned.result).unwrap(),
                    step["result"],
                    "{}",
                    case["input"]["name"]
                );
                let content = planned
                    .markdown
                    .as_deref()
                    .or(step["before"]["content"].as_str());
                let queue = planned
                    .queue
                    .as_deref()
                    .or(step["before"]["queue"].as_str());
                assert_eq!(
                    json!(content),
                    step["after"]["content"],
                    "{}",
                    case["input"]["name"]
                );
                assert_eq!(
                    json!(queue),
                    step["after"]["queue"],
                    "{}",
                    case["input"]["name"]
                );
            }
        }
    }
}

#[test]
fn cancellation_during_authoritative_read_never_yields_partial_write_intents() {
    let context = AclSubject {
        agent_id: "agent".into(),
        workspace_identity: String::new(),
        user_principal: String::new(),
        aliases: Some(Default::default()),
    };
    let config = json!({});
    let pending = parse_json("{}").unwrap();
    let ids = vec!["00000000-0000-4000-8000-000000000001".to_owned()];
    let cancel = Cancel::never();
    let reads = std::cell::Cell::new(0);
    let opens = std::cell::Cell::new(0);
    let result = plan(
        &PromotionInput {
            context: &context,
            config: &config,
            ids: Some(&ids),
            pending: &pending,
            content: None,
            now: 0,
            lock_busy: false,
        },
        &cancel,
        |id| {
            reads.set(reads.get() + 1);
            cancel.cancel();
            let mut row = support::memory_row(id, "agent", "agent-private");
            row.status = "active".into();
            row.importance_status = "final".into();
            Ok(Some(row))
        },
        || {
            opens.set(opens.get() + 1);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(reads.get(), 1);
    assert_eq!(opens.get(), 0);
}
