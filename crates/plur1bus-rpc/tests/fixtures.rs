//! Every fixture in packages/rpc-schema/fixtures must deserialize into the generated Rust types
//! and serialize back to the same JSON. This is the Rust half of spec criterion 7.
use plur1bus_rpc::types;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/rpc-schema/fixtures")
}
fn load(rel: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(fixtures().join(rel)).unwrap()).unwrap()
}

fn round_trip<T: DeserializeOwned + Serialize>(v: &Value, what: &str) {
    let typed: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{what}: {e}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(&back, v, "{what}: serialize(deserialize(x)) != x");
}

macro_rules! method {
    ($file:literal, $p:ty, $r:ty) => {{
        let f = load(concat!("methods/", $file, ".json"));
        round_trip::<$p>(&f["params"], concat!($file, " params"));
        round_trip::<$r>(&f["result"], concat!($file, " result"));
    }};
}

#[test]
fn every_method_fixture_round_trips() {
    method!("core.auth", types::CoreAuthParams, types::CoreAuthResult);
    method!(
        "core.status",
        types::CoreStatusParams,
        types::CoreStatusResult
    );
    method!(
        "core.shutdown",
        types::CoreShutdownParams,
        types::CoreShutdownResult
    );
    method!(
        "memory.recall",
        types::MemoryRecallParams,
        types::MemoryRecallResult
    );
    method!(
        "memory.capture",
        types::MemoryCaptureParams,
        types::MemoryCaptureResult
    );
    method!(
        "memory.checkpoint",
        types::MemoryCheckpointParams,
        types::MemoryCheckpointResult
    );
    method!(
        "memory.list",
        types::MemoryListParams,
        types::MemoryListResult
    );
    method!("agent.list", types::AgentListParams, types::AgentListResult);
    method!("agent.open", types::AgentOpenParams, types::AgentOpenResult);
    method!(
        "agent.close",
        types::AgentCloseParams,
        types::AgentCloseResult
    );
    method!(
        "agent.status",
        types::AgentStatusParams,
        types::AgentStatusResult
    );
    method!("jobs.list", types::JobsListParams, types::JobsListResult);
    method!("jobs.run", types::JobsRunParams, types::JobsRunResult);
    method!(
        "jobs.history",
        types::JobsHistoryParams,
        types::JobsHistoryResult
    );
    method!(
        "events.subscribe",
        types::EventsSubscribeParams,
        types::EventsSubscribeResult
    );
    method!(
        "events.unsubscribe",
        types::EventsUnsubscribeParams,
        types::EventsUnsubscribeResult
    );
}

#[test]
fn every_error_fixture_is_a_known_code_and_every_notification_round_trips() {
    for entry in fs::read_dir(fixtures().join("errors")).unwrap() {
        let v: Value =
            serde_json::from_str(&fs::read_to_string(entry.unwrap().path()).unwrap()).unwrap();
        let code: types::ErrorCode =
            serde_json::from_value(v["error"]["data"]["error"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(code).unwrap(),
            v["error"]["data"]["error"]
        );
    }
    round_trip::<types::EngineEventNotification>(
        &load("notifications/engine.event.json"),
        "engine.event",
    );
    round_trip::<types::AgentActivityNotification>(
        &load("notifications/agent.activity.json"),
        "agent.activity",
    );
    round_trip::<types::CoreStateNotification>(
        &load("notifications/core.state.json"),
        "core.state",
    );
}

#[test]
fn journal_line_type_matches_schema_fixture_shape() {
    let v = serde_json::json!({ "v": 1, "id": "11111111-1111-4111-8111-111111111111", "at": 1, "agentId": "bernd", "sessionKey": "s1",
        "caller": { "channel": "cli", "accountId": "h", "userId": "u" }, "messages": [{ "role": "user", "content": "x" }] });
    round_trip::<types::JournalLine>(&v, "journal line");
}
