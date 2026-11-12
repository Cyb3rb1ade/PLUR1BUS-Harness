//! RE-07 read parity from the real Node exports, with real Rust Lance tables.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "parity fixtures fail immediately"
)]
#[path = "recall_support.rs"]
mod support;

use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, EngineError, HostServices, MemoryRow, Principal, StoreError},
    embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    ops::{
        context::OperationContext,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    recall::hash_embed::HashEmbedder,
    store::Store,
};
use serde_json::{json, Value};
use std::sync::Arc;

struct OneStore(Arc<Store>);
impl ReadStores for OneStore {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(vec![ReadSource {
            store: self.0.clone(),
            kind: SourceKind::Private,
            optional: false,
        }])
    }
}
struct FixedEmbedding(VectorSpaceIdentity);
impl EmbeddingProvider for FixedEmbedding {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.0
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        Ok(texts.iter().map(|_| vec![1., 0., 0., 0.]).collect())
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/read.json")).unwrap()
}
fn wire_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(items) => items.iter_mut().for_each(wire_numbers),
        Value::Object(fields) => fields.values_mut().for_each(wire_numbers),
        _ => {}
    }
}

#[test]
fn reads_match_actual_node_oracle_and_do_not_reveal_foreign_or_deleted_rows() {
    let golden = fixture();
    let root = support::canonical_tempdir();
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let base = root.path().join("store");
    let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    let rows: Vec<MemoryRow> = golden["stored"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| {
            let mut value =
                serde_json::to_value(support::memory_row("fixture", "agent", "agent-private"))
                    .unwrap();
            for (key, item) in raw.as_object().unwrap() {
                if !item.is_null() {
                    value[key] = item.clone();
                }
            }
            serde_json::from_value(value).unwrap()
        })
        .collect();
    store.upsert(&rows).unwrap();
    let host: Arc<dyn HostServices> = Arc::new(support::TestHost::new(root.path().join("state")));
    let context = Arc::new(OperationContext::new(host));
    let reader = MemoryReader::new(
        context.clone(),
        Arc::new(OneStore(store)),
        Arc::new(FixedEmbedding(identity)),
        base.clone(),
    );
    let agent: AgentContext = serde_json::from_value(golden["agent"].clone()).unwrap();
    for case in golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["method"] != "state")
    {
        for (folder, content) in case["sidecars"].as_object().unwrap() {
            let path = base.join(folder).join("agent.jsonl");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            if path.is_file() {
                std::fs::remove_file(&path).unwrap();
            }
            if content["directory"] == true {
                std::fs::create_dir_all(&path).unwrap();
            } else {
                std::fs::write(&path, content["text"].as_str().unwrap()).unwrap();
            }
        }
        let principal: Principal = serde_json::from_value(case["principal"].clone()).unwrap();
        let result = match case["method"].as_str().unwrap() {
            "list" => reader
                .list_at(
                    &serde_json::from_value(case["argument"].clone()).unwrap(),
                    &principal,
                    &agent,
                    golden["now"].as_i64().unwrap(),
                )
                .map(|value| serde_json::to_value(value).unwrap()),
            "show" => reader
                .show_at(
                    case["argument"].as_str().unwrap(),
                    &principal,
                    &agent,
                    golden["now"].as_i64().unwrap(),
                )
                .map(|value| serde_json::to_value(value).unwrap()),
            _ => unreachable!(),
        };
        if let Some(code) = case["error"].as_str() {
            match result {
                Err(EngineError::MemoryOp(error)) => {
                    assert_eq!(error.code.to_string(), code, "{}", case["name"])
                }
                other => panic!("{}: {other:?}", case["name"]),
            }
        } else {
            // Node JSON has one number type; Lance's f64 timestamps encode 1.0
            // where Node stringify emits 1. Preserve every value and all fields.
            let mut actual = result.unwrap();
            let exceptions: Value =
                serde_json::from_str(include_str!("fixtures/ops/privacy-exceptions.json")).unwrap();
            let mut expected = if case["name"] == "topic" {
                assert_eq!(case["expected"], exceptions["topic"]["nodeExpected"]);
                exceptions["topic"]["rustExpected"].clone()
            } else {
                case["expected"].clone()
            };
            wire_numbers(&mut actual);
            wire_numbers(&mut expected);
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }
    // The actual Node count remains 5. Controller F4/RE-D31 explicitly expects 4.
    assert_eq!(
        golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "state")
            .unwrap()["expected"]["cards"]["agentPrivate"],
        5
    );
    let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
    let mut actual_state = serde_json::to_value(
        reader
            .state_at(&principal, &agent, golden["now"].as_i64().unwrap())
            .unwrap(),
    )
    .unwrap();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/ops/privacy-exceptions.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/ops/golden/read.json"))
        ),
        exceptions["state"]["nodeGoldenSha256"]
    );
    assert_eq!(
        golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "state")
            .unwrap()["expected"],
        exceptions["state"]["nodeExpected"]
    );
    actual_state["archiveDir"] = json!("<state>/memory/_archive");
    assert_eq!(actual_state, exceptions["state"]["rustExpected"]);
    // Unknown Node UTF-16 fields do not erase valid provenance and are never rewritten.
    let import_path = base.join("_imports/agent.jsonl");
    std::fs::remove_dir(&import_path).unwrap();
    let sidecar = "{\"v\":1,\"cardId\":\"00000000-0000-4000-8000-000000000001\",\"idempotencyKey\":\"opaque-fixture\",\"sourceRef\":\"fixture:opaque\",\"unknown\":\"\\ud800\"}\n";
    std::fs::write(&import_path, sidecar).unwrap();
    let shown = serde_json::to_value(
        reader
            .show_at(
                "00000000-0000-4000-8000-000000000001",
                &principal,
                &agent,
                golden["now"].as_i64().unwrap(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(shown["sourceRef"], "fixture:opaque");
    assert_eq!(std::fs::read_to_string(&import_path).unwrap(), sidecar);
    let forgotten = "00000000-0000-4000-8000-000000000001";
    let registry =
        plur1bus_engine::store::tombstone::TombstoneRegistry::new(&base, "agent").unwrap();
    let tombstone = json!({"schemaVersion":1,"agentId":"agent","memoryId":forgotten,"canonicalOriginId":forgotten,"scope":"agent-private","status":"committed","contentFingerprint":plur1bus_engine::store::tombstone::content_fingerprint("Synthetic read card 1")});
    registry
        .append(&plur1bus_engine::text::json::parse_json(&tombstone.to_string()).unwrap())
        .unwrap();
    assert!(
        matches!(reader.show_at(forgotten, &principal, &agent, golden["now"].as_i64().unwrap()), Err(EngineError::MemoryOp(error)) if error.code.to_string() == "not-found")
    );
    let listed = reader
        .list_at(
            &serde_json::from_value(json!({"since":0})).unwrap(),
            &principal,
            &agent,
            golden["now"].as_i64().unwrap(),
        )
        .unwrap();
    assert!(
        !listed.items.iter().any(|card| card.id == forgotten),
        "a restored live row must stay hidden by its surviving tombstone"
    );
    context.close();
    assert!(
        matches!(reader.show_at("00000000-0000-4000-8000-000000000001", &principal, &agent, 0), Err(EngineError::MemoryOp(error)) if error.code.to_string() == "storage")
    );
}

#[test]
fn contract_rejects_invalid_agents_before_an_operation_can_be_constructed() {
    let mut principal = fixture()["principal"].clone();
    principal["agentId"] = json!("../agent");
    assert!(serde_json::from_value::<Principal>(principal).is_err());
}

#[test]
fn close_waits_for_admitted_work_and_refuses_new_work() {
    use std::{sync::mpsc, time::Duration};
    let root = support::canonical_tempdir();
    let context = Arc::new(OperationContext::new(Arc::new(support::TestHost::new(
        root.path().to_owned(),
    ))));
    let principal = serde_json::from_value(fixture()["principal"].clone()).unwrap();
    let agent = serde_json::from_value(fixture()["agent"].clone()).unwrap();
    let operation = context.enter(&principal, &agent).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let closing = context.clone();
    let thread = std::thread::spawn(move || {
        closing.close();
        done_tx.send(()).unwrap();
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while context.assert_open().is_ok() {
        assert!(std::time::Instant::now() < deadline, "close did not start");
        std::thread::yield_now();
    }
    assert!(context.enter(&principal, &agent).is_err());
    assert!(done_rx.try_recv().is_err());
    drop(operation);
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    thread.join().unwrap();
}
