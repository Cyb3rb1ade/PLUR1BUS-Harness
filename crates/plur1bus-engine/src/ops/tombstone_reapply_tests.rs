//! RE-D170: the namespace reapply target takes the engine-wide mutation gate per row patch.
#![allow(clippy::unwrap_used, reason = "fixture errors are fatal")]
use super::*;
use crate::{
    contract::{testing::FakeHost, MemoryRow},
    embedding::EmbeddingProvider,
    ops::context::OperationContext,
    recall::{hash_embed::HashEmbedder, namespaces::NamespaceStores},
    store::Store,
};
use std::{sync::Arc, time::Duration};

const FIRST: &str = "11111111-1111-4111-8111-111111111111";
const SECOND: &str = "22222222-2222-4222-8222-222222222222";

fn row(id: &str) -> MemoryRow {
    let schema: Value =
        serde_json::from_str(include_str!("../../schema/engine-contract.schema.json")).unwrap();
    let mut fields = serde_json::Map::new();
    for (name, definition) in schema["$defs"]["MemoryRow"]["properties"]
        .as_object()
        .unwrap()
    {
        fields.insert(
            name.clone(),
            match definition["type"].as_str().unwrap() {
                "string" => json!(""),
                "number" => json!(0),
                "boolean" => json!(false),
                "array" => json!([]),
                _ => Value::Null,
            },
        );
    }
    let mut row: MemoryRow = serde_json::from_value(Value::Object(fields)).unwrap();
    row.id = id.into();
    row.agent_id = "agent".into();
    row.scope = "agent-private".into();
    row.status = "active".into();
    row.vector = vec![0.; 384];
    row
}

#[test]
fn a_held_gate_is_one_busy_entry_per_id_and_the_retry_converges() {
    let temp = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let provider = HashEmbedder::new();
    let config =
        serde_json::from_value(json!({"namespaces":{"activeWriteNamespace":"current"}})).unwrap();
    let store = Store::create(&base.join("current/agent"), provider.identity(), 384).unwrap();
    store.upsert(&[row(FIRST), row(SECOND)]).unwrap();
    let registry = temp.path().join("_tombstones");
    crate::store::paths::secure_dir(&registry).unwrap();
    let lines: String = [FIRST, SECOND]
        .iter()
        .map(|id| {
            format!(
                "{}\n",
                json!({"schemaVersion":1,"tombstoneId":id,"memoryId":id,"agentId":"agent",
                    "scope":"agent-private","contentFingerprint":"a".repeat(64),
                    "status":"committed"})
            )
        })
        .collect();
    fs::write(registry.join("agent.jsonl"), lines).unwrap();
    let stores = Arc::new(NamespaceStores::open(&base, &config, provider.identity(), 8).unwrap());
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({})).unwrap(),
    ));
    let gate = Arc::new(OperationContext::new(host));
    gate.set_mutation_wait(Duration::from_millis(20));
    let target = NamespaceReapplyTarget::new(stores, gate.clone());

    let held = gate.mutation().unwrap();
    let report = reapply(&base, &target, true, &Cancel::never()).unwrap();
    assert!(report.failed());
    assert_eq!(
        serde_json::to_value(&report.errors).unwrap(),
        json!([{"agent":"agent","memoryId":FIRST,"error":"busy"},
            {"agent":"agent","memoryId":SECOND,"error":"busy"}])
    );
    assert_eq!(report.active_after_reapply.len(), 2);
    assert_eq!(gate.mutation_waiters(), 0, "no caller is left waiting");
    assert_eq!(store.get(FIRST).unwrap().unwrap().status, "active");
    drop(held);

    let retry = reapply(&base, &target, true, &Cancel::never()).unwrap();
    assert!(!retry.failed(), "{retry:?}");
    assert_eq!(retry.applied.len(), 2);
    assert_eq!(store.get(SECOND).unwrap().unwrap().status, "deleted");
    // After close no write step passes: a closed gate is a storage entry for every id (even
    // one already deleted: the gate is refused before the row is read), never a write.
    store
        .patch(
            FIRST,
            &RowPatch {
                status: Some("active".into()),
                ..RowPatch::default()
            },
        )
        .unwrap();
    gate.close_within(Duration::ZERO);
    let closed = reapply(&base, &target, true, &Cancel::never()).unwrap();
    assert_eq!(
        serde_json::to_value(&closed.errors).unwrap(),
        json!([{"agent":"agent","memoryId":FIRST,"error":"storage"},
            {"agent":"agent","memoryId":SECOND,"error":"storage"}])
    );
    assert_eq!(store.get(FIRST).unwrap().unwrap().status, "active");
}
