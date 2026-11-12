//! Real Lance failure cuts, comparing the pinned Node failure oracle.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "fail fast on fixture divergence"
)]
use super::*;
use crate::{
    contract::testing::FakeHost, embedding::EmbeddingProvider, recall::hash_embed::HashEmbedder,
    store::RowFilter,
};
use serde_json::Value;
struct FailingStore<'a> {
    store: &'a Store,
    stage: &'a str,
}
impl Database for FailingStore<'_> {
    fn store(&self, row: &MemoryRow) -> Result<(), StoreError> {
        if self.stage == "store" {
            Err(StoreError::Corrupt)
        } else {
            self.store.upsert(std::slice::from_ref(row))
        }
    }
    fn patch(&self, id: &str, patch: &RowPatch) -> Result<(), StoreError> {
        if self.stage == "patch" {
            Err(StoreError::Corrupt)
        } else {
            self.store.patch(id, patch)
        }
    }
}
#[test]
fn failed_successor_or_supersede_never_loses_the_original() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/capture/golden/safe-update.json"
    ))
    .unwrap();
    for case in golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| matches!(c["fail"].as_str(), Some("store" | "patch")))
    {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Store::create(&root.path().join("agent"), &identity, 4).unwrap();
        let old: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        store.upsert(std::slice::from_ref(&old)).unwrap();
        let host = FakeHost::new(
            root.path().join("state"),
            serde_json::from_value(json!({})).unwrap(),
        );
        let p:Principal=serde_json::from_value(json!({"agentId":"agent","workspace":"workspace:v1:fixture","channel":"","accountId":"","chat":{"id":"","kind":"direct"},"trust":"inferred"})).unwrap();
        let a: AgentContext =
            serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
        let ctx = RequestContext::build(&p, &a, &host).unwrap();
        let request = UpdateRequest {
            id: &old.id,
            patch: serde_json::from_value(case["patch"].clone()).unwrap(),
            evidence: serde_json::from_value(case["evidence"].clone()).unwrap(),
            skip_drift_gate: false,
        };
        let db = FailingStore {
            store: &store,
            stage: case["fail"].as_str().unwrap(),
        };
        assert!(apply(
            &db,
            &old,
            &request,
            &ctx,
            None,
            &Cancel::never(),
            golden["now"].as_i64().unwrap()
        )
        .is_err());
        let mut rows = store.scan(&RowFilter::default(), 10).unwrap();
        rows.sort_by_key(|row| row.id != old.id);
        for row in &mut rows {
            if row.id != old.id {
                row.id = "successor-id".into();
            }
        }
        let mut actual = serde_json::to_value(rows).unwrap();
        let mut expected = case["rows"].clone();
        normalize(&mut actual);
        normalize(&mut expected);
        assert_eq!(actual, expected, "{}", case["name"]);
        drop(store);
        let store = Store::open(
            &root.path().join("agent"),
            crate::store::OpenMode::ReadOnly,
            Some(&identity),
        )
        .unwrap();
        // A reopened actual Lance store retains the still-active original.
        assert_eq!(store.get(&old.id).unwrap().unwrap().status, "active");
    }
}

fn normalize(v: &mut Value) {
    match v {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(a) => a.iter_mut().for_each(normalize),
        Value::Object(o) => o.values_mut().for_each(normalize),
        _ => {}
    }
}
