//! Recorded engine payloads retain their JSON representation through the contract types.
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
