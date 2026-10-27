//! Recorded engine payloads retain their JSON representation through the contract types.
#![allow(clippy::unwrap_used)]
use plur1bus_engine::contract::*;
use serde::{de::DeserializeOwned, Serialize};

fn roundtrip<T: DeserializeOwned + Serialize>(name: &str) {
    let raw = std::fs::read_to_string(format!(
        "{}/tests/fixtures/contract/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let typed: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), value, "{name}");
}

#[test]
fn recall_result_roundtrips() {
    roundtrip::<RecallResult>("recall-result");
}

#[test]
fn capture_result_roundtrips() {
    roundtrip::<CaptureResult>("capture-result");
}

#[test]
fn job_run_roundtrips() {
    roundtrip::<JobRun>("job-run");
}

#[test]
fn memory_card_roundtrips() {
    roundtrip::<MemoryCard>("memory-card");
}

#[test]
fn engine_status_roundtrips() {
    roundtrip::<EngineStatus>("engine-status");
}

#[test]
fn an_unknown_field_in_a_closed_input_is_refused() {
    let bad = serde_json::json!({ "query": "x", "principal": {}, "agent": {}, "extra": 1 });
    assert!(serde_json::from_value::<RecallQuery>(bad).is_err());
}

#[test]
fn a_valid_closed_input_refuses_an_added_field() {
    let mut query = serde_json::json!({
        "query": "tea",
        "principal": {
            "agentId": "contract-agent", "workspace": "workspace:v1:contract",
            "channel": "cli", "accountId": "account", "chat": {"id": "chat", "kind": "direct"},
            "trust": "proved"
        },
        "agent": {"origin": "user", "background": false}
    });
    serde_json::from_value::<RecallQuery>(query.clone()).unwrap();
    query["extra"] = serde_json::json!(1);
    let error = serde_json::from_value::<RecallQuery>(query).unwrap_err();
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn optional_null_and_empty_values_keep_their_presence() {
    let base = serde_json::json!({
        "provider":"flat", "model":"flat", "revision":"1", "dimension":384,
        "normalization":"unit", "prefixScheme":"none", "instruction":"", "dtype":"float32"
    });
    for additions in [
        serde_json::json!({}),
        serde_json::json!({"tokenCap":null}),
        serde_json::json!({"artifacts":[]}),
    ] {
        let mut value = base.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(additions.as_object().unwrap().clone());
        let typed: VectorSpaceIdentity = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), value);
    }
}

#[test]
fn configuration_preserves_legacy_aliases_and_omitted_defaults() {
    let value = serde_json::json!({
        "runtime": {"traceRegistrations":true},
        "groupReasoningFilter":{},
        "obsidianBridge":{"workspaces":[{
            "agentId":"canonical", "agent_id":"legacy", "workspaceId":"first", "workspace_id":"second"
        }]}
    });
    let config: EngineConfig = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(config).unwrap(), value);
}

#[test]
fn constant_boolean_fields_refuse_the_opposite_value() {
    let good = serde_json::json!({"id":"card", "archived":true});
    let typed: MemoryCorrectResult = serde_json::from_value(good.clone()).unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), good);
    assert!(serde_json::from_value::<MemoryCorrectResult>(
        serde_json::json!({"id":"card","archived":false})
    )
    .is_err());
}

fn assert_value_roundtrip<T: DeserializeOwned + Serialize>(value: &serde_json::Value) {
    let typed: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(&serde_json::to_value(typed).unwrap(), value);
}

#[test]
fn referenced_scalar_union_reasons_remain_json_strings() {
    for reason in ["already-imported", "invalid-input", "duplicate-in-batch"] {
        assert_value_roundtrip::<MemoryImportCardResult>(&serde_json::json!({
            "idempotencyKey":"fixture", "outcome":"rejected", "reason":reason
        }));
    }
    for reason in ["superseded", "aborted", "storage"] {
        assert_value_roundtrip::<MemoryUnimportCardResult>(&serde_json::json!({
            "idempotencyKey":"fixture", "id":"card", "outcome":"failed", "reason":reason
        }));
    }
    for reason in ["provider-failed", "invalid-vector", "invalid-result"] {
        assert_value_roundtrip::<ModelReadiness>(&serde_json::json!({
            "state":"failed", "warming":false, "checkedAt":0, "error":reason
        }));
    }
}

#[test]
fn embedded_model_readiness_errors_remain_strings() {
    let raw: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/contract/engine-status.json")).unwrap();
    let mut models = raw["models"].clone();
    models["embedder"]["state"] = serde_json::json!("failed");
    models["embedder"]["error"] = serde_json::json!("provider-failed");
    models["reranker"]["state"] = serde_json::json!("failed");
    models["reranker"]["error"] = serde_json::json!("invalid-result");
    assert_value_roundtrip::<ModelsStatus>(&models);
}

#[test]
fn history_limit_preserves_the_declared_number_domain() {
    for limit in [
        serde_json::json!(-1),
        serde_json::json!(1.0),
        serde_json::json!(1.5),
    ] {
        assert_value_roundtrip::<HistoryFilter>(&serde_json::json!({"limit":limit}));
    }
}

#[test]
fn principals_keep_template_prefixes_without_extra_suffix_constraints() {
    for value in ["workspace:v1:", "workspace-dir:v1:folder/😀"] {
        assert_value_roundtrip::<WorkspacePrincipal>(&serde_json::json!(value));
    }
    for value in ["user:v1:", "user:v2:identity/😀"] {
        assert_value_roundtrip::<UserPrincipal>(&serde_json::json!(value));
    }
    assert!(serde_json::from_value::<WorkspacePrincipal>(serde_json::json!("garbage")).is_err());
    assert!(serde_json::from_value::<UserPrincipal>(serde_json::json!("garbage")).is_err());
}

#[test]
fn closed_uncapped_recall_roundtrips() {
    roundtrip::<RecallResult>("recall-result-closed");
}

// These compile-time consumers keep request cancellation available at every
// expensive memory boundary without inventing an implementation of MemoryOps.
type MemoryRequestCall<Request, Response> = fn(
    &dyn MemoryOps,
    Request,
    &Cancel,
    &Principal,
    &AgentContext,
) -> Result<Response, EngineError>;
const _: MemoryRequestCall<MemoryImportRequest, MemoryImportResult> =
    |ops, req, cancel, principal, agent| ops.import(req, cancel, principal, agent);
const _: MemoryRequestCall<MemoryRebindRequest, MemoryRebindResult> =
    |ops, req, cancel, principal, agent| ops.rebind(req, cancel, principal, agent);
const _: MemoryRequestCall<MemoryUnbindRequest, MemoryUnbindResult> =
    |ops, req, cancel, principal, agent| ops.unbind(req, cancel, principal, agent);
const _: MemoryRequestCall<MemoryUnimportRequest, MemoryUnimportResult> =
    |ops, req, cancel, principal, agent| ops.unimport(req, cancel, principal, agent);

#[test]
fn capture_carries_cancellation_without_serializing_the_runtime_flag() {
    let value = serde_json::json!({
        "agentId":"contract-agent", "incognito":false, "messages":[],
        "principal": {
            "agentId":"contract-agent", "workspace":"workspace:v1:contract",
            "channel":"cli", "accountId":"account", "chat":{"id":"chat","kind":"direct"}, "trust":"proved"
        },
        "agent":{"origin":"user","background":false}
    });
    let turn: TurnRecord = serde_json::from_value(value.clone()).unwrap();
    let caller = turn.cancel.clone();
    caller.cancel();
    assert!(turn.cancel.is_cancelled());
    assert_eq!(serde_json::to_value(turn).unwrap(), value);
}
