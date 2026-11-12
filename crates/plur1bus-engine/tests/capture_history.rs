//! Recorded Node history traversal over actual native Lance stores.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "fixture failure is fatal"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::StoreError,
    contract::{Cancel, MemoryRow},
    embedding::EmbeddingProvider,
    ops::{
        context::OperationContext,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    recall::hash_embed::HashEmbedder,
    store::Store,
};
use serde_json::{json, Value};
use std::sync::Arc;
struct Stores(Arc<Store>);
impl ReadStores for Stores {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(vec![ReadSource {
            store: self.0.clone(),
            kind: SourceKind::Private,
            optional: false,
        }])
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
#[test]
fn versions_cycles_missing_links_and_depth_match_node() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/history.json")).unwrap();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/capture/history-exceptions.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/history.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let rows: Vec<MemoryRow> = serde_json::from_value(case["rows"].clone()).unwrap();
        store.upsert(&rows).unwrap();
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        let reader = MemoryReader::new(
            Arc::new(OperationContext::new(host)),
            Arc::new(Stores(store)),
            Arc::new(HashEmbedder::new()),
            base,
        );
        let p=serde_json::from_value(json!({"agentId":"agent","workspace":"workspace:v1:fixture","channel":"","accountId":"","chat":{"id":"","kind":"direct"},"trust":"inferred"})).unwrap();
        let a = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
        let id = case["startId"].as_str().unwrap();
        let depth = case["maxDepth"].as_u64().map(|n| n as usize);
        let history = reader.history(id, depth, &p, &a, &Cancel::never()).unwrap();
        let current = reader
            .current_version(id, depth, &p, &a, &Cancel::never())
            .unwrap();
        let mut actual = json!({"history":history,"current":current});
        let mut expected = json!({"history":case["history"],"current":case["current"]});
        if let Some(exception) = exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == case["name"])
        {
            expected["history"] = exception["history"].clone();
            expected["current"] = exception["current"].clone();
        }
        normalize(&mut actual);
        normalize(&mut expected);
        assert_eq!(actual, expected, "{}", case["name"]);
    }
}

#[test]
fn deleted_tombstoned_or_foreign_bound_middle_rows_stop_both_directions() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/history.json")).unwrap();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "three")
        .unwrap();
    for kind in ["deleted", "tombstone", "owner", "workspace"] {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let mut rows: Vec<MemoryRow> = serde_json::from_value(case["rows"].clone()).unwrap();
        match kind {
            "deleted" => rows[1].status = "deleted".into(),
            "owner" => {
                rows[1].owner_user_id =
                    plur1bus_engine::context::harness_user_principal("fixture-foreign-owner")
            }
            "workspace" => rows[1].workspace_id = "workspace:v1:foreign".into(),
            _ => {}
        }
        store.upsert(&rows).unwrap();
        if kind == "tombstone" {
            let marker = json!({"schemaVersion":1,"memoryId":rows[1].id,"canonicalOriginId":rows[1].id,"agentId":"agent","scope":"agent-private","workspaceId":"","ownerUserId":"","status":"committed","contentFingerprint":plur1bus_engine::store::tombstone::content_fingerprint(&rows[1].text)});
            plur1bus_engine::store::tombstone::TombstoneRegistry::new(&base, "agent")
                .unwrap()
                .append(&plur1bus_engine::text::json::parse_json(&marker.to_string()).unwrap())
                .unwrap();
        }
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        let reader = MemoryReader::new(
            Arc::new(OperationContext::new(host)),
            Arc::new(Stores(store)),
            Arc::new(HashEmbedder::new()),
            base,
        );
        let p=serde_json::from_value(json!({"agentId":"agent","workspace":"workspace:v1:fixture","channel":"","accountId":"","chat":{"id":"","kind":"direct"},"trust":"inferred"})).unwrap();
        let a = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
        let history = reader
            .history(&rows[2].id, None, &p, &a, &Cancel::never())
            .unwrap();
        assert_eq!(history.len(), 1, "{kind}");
        assert_eq!(history[0].id, rows[2].id);
        let current = reader
            .current_version(&rows[0].id, None, &p, &a, &Cancel::never())
            .unwrap()
            .unwrap();
        assert_eq!(current.id, rows[0].id, "{kind}");
        assert!(
            reader
                .history(&rows[1].id, None, &p, &a, &Cancel::never())
                .unwrap()
                .is_empty(),
            "{kind}"
        );
    }
}
