//! Exercise warm-only recall through real process dispatch and Lance stores.
#![allow(clippy::unwrap_used, reason = "isolated fixture errors are fatal")]

use super::*;
use crate::{contract::testing::FakeHost, rpc::methods, store::Store};
use std::{fs, path::Path};

fn params() -> Value {
    json!({"query": {"query":"synthetic project archive", "warmOnly":true,
        "principal":{"agentId":"agent","workspace":"workspace:v1:fixture","channel":"cli",
            "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"inferred"},
        "agent":{"origin":"user","background":false}}, "options":{"reranker":"off"}})
}

fn host(root: &Path) -> Arc<FakeHost> {
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(json!({
            "baseDbPath":root.join("db"),
            "neo":{"enabled":false},
            "namespaces":{"activeWriteNamespace":"current"}
        }))
        .unwrap(),
    ));
    host.set_now_ms(10_000);
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    host.set_workspace(&"agent".parse().unwrap(), workspace);
    host
}

fn warm(engine: &ProcessEngine, cancel: &Cancel) -> Value {
    methods::dispatch(engine, "engine.recall", &params(), cancel).unwrap()
}

fn has_phase(value: &Value, phase: &str) -> bool {
    value["timing"]["phases"]["completed"]
        .as_array()
        .is_some_and(|phases| phases.iter().any(|item| item["phase"] == phase))
}

#[test]
fn warms_existing_lance_table_without_injecting_or_writing_and_skips_a_missing_table() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let missing = warm(&engine, &Cancel::never());
    assert_eq!(missing["degraded"], Value::Null);
    assert!(!has_phase(&missing, "vector_search"));
    assert!(!root.join("db").exists());

    let space = engine.embedding().identities().remove(0).space.unwrap();
    let width = space.dimension.as_u64().unwrap() as usize;
    let store = Store::create(&root.join("db/current/agent"), &space, width).unwrap();
    let row = adopt_tests::row(vec![1.; width]);
    store.upsert(std::slice::from_ref(&row)).unwrap();
    let before = serde_json::to_value(store.get(&row.id).unwrap()).unwrap();
    let files = adopt_tests::snapshot(root);
    let result = warm(&engine, &Cancel::never());
    assert!(has_phase(&result, "vector_search"), "{result}");
    assert_eq!(result["blocks"], json!([]));
    assert_eq!(result["capChars"], Value::Null);
    assert_eq!(result["degraded"], Value::Null);
    assert_eq!(
        serde_json::to_value(store.get(&row.id).unwrap()).unwrap(),
        before
    );
    assert!(!root.join("state").exists());
    assert!(!root.join("_tombstones").exists());
    assert_eq!(fs::read_dir(root.join("workspace")).unwrap().count(), 0);
    assert_eq!(adopt_tests::snapshot(root), files);
    assert!(host.events().is_empty());
}

#[test]
fn reranker_receives_only_live_authorized_rows_and_no_interrupted_deletion() {
    use crate::{
        embedding::{RerankError, Reranker},
        store::tombstone::{content_fingerprint, TombstoneRegistry},
    };

    struct Recorder(Arc<Mutex<Vec<String>>>);
    impl Reranker for Recorder {
        fn empty_result_is_valid(&self) -> bool {
            false
        }

        fn rerank(
            &self,
            _: &str,
            docs: &[String],
            _: usize,
            _: &Cancel,
        ) -> Result<Vec<RerankHit>, RerankError> {
            self.0.lock().unwrap().extend_from_slice(docs);
            Ok(vec![RerankHit {
                index: 0.into(),
                score: 1.into(),
            }])
        }
    }
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root);
    let mut engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let identity = engine.embedding().identities().remove(0);
    let space = identity.space.clone().unwrap();
    let width = space.dimension.as_u64().unwrap() as usize;
    let provider = Seam::FlatEmbedder.embedder(width, &space).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    engine.embedding = Arc::new(
        Service::new(
            provider,
            Some(Box::new(Recorder(seen.clone()))),
            identity,
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    let base = root.join("db");
    let store = Store::create(&base.join("current/agent"), &space, width).unwrap();
    let mut vector = vec![0.; width];
    vector[0] = 1.;
    let rows = [
        (1, "allowed one"),
        (2, "allowed two"),
        (3, "interrupted deletion"),
        (4, "foreign row"),
    ]
    .into_iter()
    .map(|(index, text)| {
        let mut row = adopt_tests::row(vector.clone());
        row.id = format!("00000000-0000-4000-8000-{index:012}");
        row.text = text.into();
        if index == 4 {
            row.agent_id = "foreign".into();
        }
        row
    })
    .collect::<Vec<_>>();
    store.upsert(&rows).unwrap();
    let registry = TombstoneRegistry::new(&base, "agent").unwrap();
    let marker = json!({
        "schemaVersion":1,"memoryId":rows[2].id,"agentId":"agent","scope":"agent-private",
        "status":"attempted","contentFingerprint":content_fingerprint(&rows[2].text)
    });
    registry
        .append(&crate::recall::trace::from_value(&marker))
        .unwrap();
    let before = fs::read(registry.path()).unwrap();
    let mut params = params();
    params["options"]["reranker"] = json!("on");
    let reply = methods::dispatch(&engine, "engine.recall", &params, &Cancel::never()).unwrap();
    assert_eq!(reply["degraded"], Value::Null);
    assert!(has_phase(&reply, "rerank"));
    let mut actual = seen.lock().unwrap().clone();
    actual.sort();
    assert_eq!(actual, ["allowed one", "allowed two"]);
    assert_eq!(fs::read(registry.path()).unwrap(), before);
    assert!(store.get(&rows[2].id).unwrap().is_some());
    assert!(host.events().is_empty());
}

#[test]
fn a_disabled_workspace_and_cancelled_warm_request_skip_model_and_store_work() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root);
    let params = params();
    let context = crate::context::RequestContext::build(
        &serde_json::from_value(params["query"]["principal"].clone()).unwrap(),
        &serde_json::from_value(params["query"]["agent"].clone()).unwrap(),
        host.as_ref(),
    )
    .unwrap();
    crate::ops::workspace_policy::PolicyStore::new(&root.join("db"))
        .unwrap()
        .set(
            &json!({"agentId":"agent","workspaceIdentity":context.workspace_key,
            "expectedRevision":0,"enabled":false,"actorId":"system"}),
            10_000,
        )
        .unwrap();
    // A corrupt private root would fail any lease. The policy must decide first.
    fs::write(root.join("db/current"), "not a directory").unwrap();
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let result = warm(&engine, &Cancel::never());
    assert_eq!(result["degraded"], Value::Null);
    assert!(!has_phase(&result, "vector_search"));

    let cancelled = Cancel::never();
    cancelled.cancel();
    let result = warm(&engine, &cancelled);
    assert_eq!(result["degraded"]["reason"], "aborted");
    assert_eq!(result["blocks"], json!([]));
    let expired = Cancel::with_deadline(std::time::Instant::now());
    let result = warm(&engine, &expired);
    assert_eq!(result["degraded"]["reason"], "timeout");
    assert!(host.events().is_empty());
}
