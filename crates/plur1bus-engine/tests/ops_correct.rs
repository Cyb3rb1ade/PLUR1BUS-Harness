//! Actual Node correct oracles, including durable versions and authorized Neo effects.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "contract fixtures fail immediately"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{EngineError, MemoryRow, StoreError},
    embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    ops::{
        context::OperationContext,
        correction::{CorrectionEffects, CorrectionServices},
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
        if self.case["eventReadFailure"] == true {
            Err(StoreError::Corrupt)
        } else {
            Ok(false)
        }
    }
    fn rewrite_edges(
        &self,
        ctx: &RequestContext,
        old: &MemoryRow,
        new: &str,
    ) -> Result<(), StoreError> {
        assert_eq!(old.agent_id, ctx.agent_id.as_str());
        if self.case["edgeReadFailure"] == true {
            return Err(StoreError::Corrupt);
        }
        self.edges.lock().unwrap().extend([
            json!({"source":new,"target":"synthetic-peer","kind":"related","weight":0.5}),
            json!({"source":"synthetic-peer","target":new,"kind":"related","weight":0.3}),
        ]);
        Ok(())
    }
    fn record(
        &self,
        ctx: &RequestContext,
        old: &MemoryRow,
        event: &Value,
    ) -> Result<(), StoreError> {
        assert_eq!(old.agent_id, ctx.agent_id.as_str());
        if self.case["eventWriteFailure"] == true {
            return Err(StoreError::Corrupt);
        }
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
}
fn normalize(value: &mut Value, root: &str, ids: &BTreeMap<String, String>) {
    match value {
        Value::String(s) => {
            *s = ids.get(s).cloned().unwrap_or_else(|| {
                s.strip_prefix(root).map_or_else(
                    || s.clone(),
                    |suffix| format!("<work>{}", suffix.replace(std::path::MAIN_SEPARATOR, "/")),
                )
            })
        }
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(a) => a.iter_mut().for_each(|v| normalize(v, root, ids)),
        Value::Object(o) => o.values_mut().for_each(|v| normalize(v, root, ids)),
        _ => {}
    }
}
#[test]
fn corrections_preserve_versions_archives_acl_and_event_oracles() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/correct.json")).unwrap();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/ops/correction-exceptions.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/ops/golden/correct.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let state = root.path().join("state");
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        store.upsert(std::slice::from_ref(&original)).unwrap();
        let host = Arc::new(support::TestHost::new(state.clone()));
        if case["noWorkspace"] != true {
            host.set_workspace("agent", workspace.clone());
        }
        let provider = Arc::new(Provider {
            identity,
            fail: case["embedFailure"] == true,
            calls: Mutex::new(Vec::new()),
        });
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
            embedder: provider.clone(),
            effects: if case["noNeo"] == true {
                None
            } else {
                Some(effects.clone())
            },
        });
        let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
        let agent = serde_json::from_value(case.get("context").unwrap_or(&golden["agent"]).clone())
            .unwrap();
        if case["archiveFailure"] == true {
            fs::create_dir_all(state.join("memory")).unwrap();
            fs::write(state.join("memory/_archive"), "blocked").unwrap();
        }
        if case["auditFailure"] == true {
            fs::write(workspace.join(".adaptive-learning"), "blocked").unwrap();
        }
        let result = match writer.correct_at(
            case["id"].as_str().unwrap_or(&original.id),
            case["newText"].as_str().unwrap(),
            &principal,
            &agent,
            golden["now"].as_i64().unwrap(),
        ) {
            Ok(v) => json!({"value":v}),
            Err(EngineError::MemoryOp(e)) => json!({"error":e.code.to_string()}),
            Err(e) => panic!("{e:?}"),
        };
        let rows = store.scan(&RowFilter::default(), 10).unwrap();
        let mut ids = BTreeMap::new();
        for row in &rows {
            if row.id != original.id {
                ids.insert(row.id.clone(), "generated-1".into());
            }
        }
        let events = effects.events.lock().unwrap().clone();
        for event in &events {
            ids.insert(
                event["id"].as_str().unwrap().to_owned(),
                "generated-2".into(),
            );
        }
        let archive_root = state.join("memory/_archive/agent");
        let mut archives = Vec::new();
        if archive_root.is_dir() {
            for file in fs::read_dir(&archive_root).unwrap() {
                let file = file.unwrap();
                archives.push(json!({"file":file.file_name().to_str().unwrap(),"card":serde_json::from_slice::<Value>(&fs::read(file.path()).unwrap()).unwrap()}));
            }
        }
        let audit_path = workspace.join(".adaptive-learning/destructive-ops.jsonl");
        let audit: Vec<Value> = if audit_path.is_file() {
            fs::read_to_string(&audit_path)
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        } else {
            Vec::new()
        };
        let mut actual = json!({"results":[result],"rows":rows,"archives":archives,"audit":audit,"events":events,"edgeWrites":effects.edges.lock().unwrap().clone(),"embeddingCalls":provider.calls.lock().unwrap().clone()});
        normalize(&mut actual, root.path().to_str().unwrap(), &ids);
        let mut expected = json!({"results":case["results"],"rows":case["rows"],"archives":case["archives"],"audit":case["audit"],"events":case["events"],"edgeWrites":case["edgeWrites"],"embeddingCalls":case["embeddingCalls"]});
        if let Some(exception) = exceptions["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == case["name"])
        {
            for field in ["results", "events"] {
                if let Some(value) = exception.get(field) {
                    expected[field] = value.clone();
                }
            }
        }
        normalize(&mut expected, "<work>", &BTreeMap::new());
        assert_eq!(actual, expected, "{}", case["name"]);
    }
}
