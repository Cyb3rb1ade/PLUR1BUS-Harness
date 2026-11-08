//! Actual Node/Lance reconsolidation oracle and native caller guards.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "contract fixtures fail immediately"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{MemoryRow, StoreError},
    embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    ops::{
        context::OperationContext,
        correction::{CorrectionEffects, CorrectionServices},
        safe_update::{UpdateEvidence, UpdatePatch, UpdateRequest},
        write::{MemoryWriter, MutationStores},
    },
    recall::hash_embed::HashEmbedder,
    store::{RowFilter, Store},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    sync::{Arc, Mutex},
};
struct Stores(Arc<Store>);
impl MutationStores for Stores {
    fn existing_private(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
}
struct Provider {
    identity: VectorSpaceIdentity,
    fail: bool,
    calls: Mutex<Vec<String>>,
}
impl EmbeddingProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        assert!(matches!(kind, EmbedKind::Passage));
        self.calls.lock().unwrap().extend_from_slice(texts);
        if self.fail {
            Err(EmbedError::Unavailable)
        } else {
            Ok(texts.iter().map(|_| vec![0., 1., 0., 0.]).collect())
        }
    }
}
struct Effects {
    case: Value,
    events: Mutex<Vec<Value>>,
    edges: Mutex<Vec<Value>>,
}
impl CorrectionEffects for Effects {
    fn contains(&self, ctx: &RequestContext, _: &str) -> Result<bool, StoreError> {
        assert_eq!(ctx.agent_id.as_str(), "agent");
        assert_ne!(
            self.case["forbidRead"], true,
            "unauthorized idempotency read"
        );
        if self.case["fail"] == "read" {
            Err(StoreError::Corrupt)
        } else {
            Ok(self.case["idempotent"] == true)
        }
    }
    fn rewrite_edges(
        &self,
        ctx: &RequestContext,
        old: &MemoryRow,
        new: &str,
    ) -> Result<(), StoreError> {
        assert_eq!(old.agent_id, ctx.agent_id.as_str());
        if self.case["fail"] == "edge" {
            return Err(StoreError::Corrupt);
        }
        self.edges
            .lock()
            .unwrap()
            .push(json!({"source":new,"target":"peer","kind":"related","weight":0.5}));
        Ok(())
    }
    fn record(
        &self,
        ctx: &RequestContext,
        old: &MemoryRow,
        event: &Value,
    ) -> Result<(), StoreError> {
        assert_eq!(old.agent_id, ctx.agent_id.as_str());
        if self.case["fail"] == "event" {
            return Err(StoreError::Corrupt);
        }
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
}
fn normalize(value: &mut Value, root: &str, ids: &BTreeMap<String, String>) {
    match value {
        Value::String(s) => {
            *s = ids
                .get(s)
                .cloned()
                .unwrap_or_else(|| s.replace(root, "<work>"))
        }
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(a) => a.iter_mut().for_each(|v| normalize(v, root, ids)),
        Value::Object(o) => o.values_mut().for_each(|v| normalize(v, root, ids)),
        _ => {}
    }
}
#[test]
fn safe_updates_match_actual_node_versions_and_inline_mutations() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/safe-update.json")).unwrap();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/capture/safe-update-exceptions.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/safe-update.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    for case in golden["cases"].as_array().unwrap() {
        // These storage-failure cuts require a store fault seam and are tested separately.
        if matches!(case["fail"].as_str(), Some("store" | "patch")) {
            continue;
        }
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        store.upsert(std::slice::from_ref(&original)).unwrap();
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        host.set_workspace("agent", workspace);
        let effects = Arc::new(Effects {
            case: case.clone(),
            events: Mutex::new(Vec::new()),
            edges: Mutex::new(Vec::new()),
        });
        let writer = MemoryWriter::new(
            Arc::new(OperationContext::new(host)),
            Arc::new(Stores(store.clone())),
            base,
        )
        .with_corrections(CorrectionServices {
            embedder: Arc::new(Provider {
                identity,
                fail: false,
                calls: Mutex::new(Vec::new()),
            }),
            effects: Some(effects.clone()),
        });
        let p=serde_json::from_value(json!({"agentId":"agent","workspace":"workspace:v1:fixture","channel":"","accountId":"","chat":{"id":"","kind":"direct"},"trust":"inferred"})).unwrap();
        let a = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
        let request = UpdateRequest {
            id: &original.id,
            patch: serde_json::from_value::<UpdatePatch>(case["patch"].clone()).unwrap(),
            evidence: serde_json::from_value::<UpdateEvidence>(case["evidence"].clone()).unwrap(),
            skip_drift_gate: case["skipDriftGate"] == true,
        };
        let result = match writer.safe_update_at(
            &request,
            &p,
            &a,
            &Cancel::never(),
            golden["now"].as_i64().unwrap(),
        ) {
            Ok(value) => json!({"value":value}),
            Err(_) => json!({"error":true}),
        };
        let mut rows = store.scan(&RowFilter::default(), 10).unwrap();
        rows.sort_by_key(|r| r.id != original.id);
        let mut ids = BTreeMap::new();
        for row in &rows {
            if row.id != original.id {
                ids.insert(row.id.clone(), "successor-id".into());
            }
        }
        let events = effects.events.lock().unwrap().clone();
        for e in &events {
            ids.insert(e["id"].as_str().unwrap().into(), "event-id".into());
        }
        let mut actual = json!({"result":result,"rows":rows,"events":events,"edges":effects.edges.lock().unwrap().clone()});
        let mut expected = json!({"result":case["result"],"rows":case["rows"],"events":case["events"],"edges":case["edges"]});
        if let Some(exception) = exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == case["name"])
        {
            for field in ["result", "rows", "events", "edges"] {
                if let Some(value) = exception.get(field) {
                    expected[field] = value.clone();
                }
            }
        }
        normalize(&mut actual, "<work>", &ids);
        normalize(&mut expected, "<work>", &BTreeMap::new());
        assert_json(&actual, &expected, &case["name"].to_string());
    }
}

#[test]
fn source_authority_cancellation_and_close_precede_idempotency() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/safe-update.json")).unwrap();
    for kind in [
        "foreign-agent",
        "foreign-owner",
        "shared-copy",
        "foreign-workspace",
        "cancelled",
        "closed",
    ] {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let mut old: MemoryRow =
            serde_json::from_value(golden["cases"][0]["original"].clone()).unwrap();
        match kind {
            "foreign-agent" => {
                old.agent_id = "foreign".into();
                old.stored_by = "foreign".into();
            }
            "foreign-owner" => {
                old.owner_user_id =
                    plur1bus_engine::context::harness_user_principal("fixture-owner-b")
            }
            "shared-copy" => old.scope = "workspace".into(),
            "foreign-workspace" => old.workspace_id = "workspace:v1:foreign".into(),
            _ => {}
        }
        store.upsert(std::slice::from_ref(&old)).unwrap();
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        let context = Arc::new(OperationContext::new(host));
        let effects = Arc::new(Effects {
            case: json!({"forbidRead":true}),
            events: Mutex::new(Vec::new()),
            edges: Mutex::new(Vec::new()),
        });
        let writer = MemoryWriter::new(context.clone(), Arc::new(Stores(store.clone())), base)
            .with_corrections(CorrectionServices {
                embedder: Arc::new(Provider {
                    identity,
                    fail: false,
                    calls: Mutex::new(Vec::new()),
                }),
                effects: Some(effects.clone()),
            });
        let p=serde_json::from_value(json!({"agentId":"agent","workspace":"workspace:v1:fixture","channel":"","accountId":"","chat":{"id":"","kind":"direct"},"trust":"inferred"})).unwrap();
        let a = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
        let request = UpdateRequest {
            id: &old.id,
            patch: serde_json::from_value(golden["cases"][0]["patch"].clone()).unwrap(),
            evidence: serde_json::from_value(golden["cases"][0]["evidence"].clone()).unwrap(),
            skip_drift_gate: false,
        };
        let cancel = Cancel::never();
        if kind == "cancelled" {
            cancel.cancel();
        }
        if kind == "closed" {
            context.close();
        }
        assert!(
            writer
                .safe_update_at(&request, &p, &a, &cancel, golden["now"].as_i64().unwrap())
                .is_err(),
            "{kind}"
        );
        let mut actual =
            serde_json::to_value(store.scan(&RowFilter::default(), 10).unwrap()).unwrap();
        let mut expected = json!([old]);
        normalize(&mut actual, "<work>", &BTreeMap::new());
        normalize(&mut expected, "<work>", &BTreeMap::new());
        assert_json(&actual, &expected, kind);
        assert!(effects.events.lock().unwrap().is_empty());
        assert!(effects.edges.lock().unwrap().is_empty());
    }
}

fn assert_json(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: field count");
            for (k, v) in b {
                assert_json(a.get(k).unwrap(), v, &format!("{path}.{k}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_json(a, b, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}
