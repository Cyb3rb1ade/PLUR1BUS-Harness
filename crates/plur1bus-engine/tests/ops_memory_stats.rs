//! A1 counters are disclosed only through the current real-Lance read ACL.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic integration fixtures"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, MemoryOpErrorCode, Principal, StoreError},
    embedding::{EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    ops::{
        context::OperationContext,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    recall::hash_embed::HashEmbedder,
    store::{recall_stats::RecallStats, Store},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
struct Routes {
    store: Arc<Store>,
    fail: AtomicBool,
}
impl ReadStores for Routes {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(StoreError::Unavailable);
        }
        Ok(vec![ReadSource {
            store: self.store.clone(),
            kind: SourceKind::Private,
            optional: false,
        }])
    }
}
struct NoEmbedding(VectorSpaceIdentity);
impl EmbeddingProvider for NoEmbedding {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.0
    }
    fn embed(&self, _: &[String], _: EmbedKind, _: &Cancel) -> Result<Vec<Vec<f32>>, EmbedError> {
        panic!("stats must not embed")
    }
}
fn id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}
struct Fixture {
    _root: tempfile::TempDir,
    base: std::path::PathBuf,
    reader: MemoryReader,
    context: Arc<OperationContext>,
    routes: Arc<Routes>,
    principal: Principal,
    agent: AgentContext,
}
fn setup() -> Fixture {
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    let mut rows = Vec::new();
    for n in 1..=5 {
        let mut row = support::memory_row(&id(n), "agent", "agent-private");
        row.stored_by = "agent".into();
        row.vector = vec![1., 0., 0., 0.];
        row.status = "active".into();
        if n == 2 {
            row.agent_id = "other".into();
            row.stored_by = "other".into();
        }
        if n == 3 {
            row.expires_at = 50.into();
        }
        if n == 4 {
            row.status = "deleted".into();
        }
        rows.push(row);
    }
    store.upsert(&rows).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.time.store(100, Ordering::SeqCst);
    let context = Arc::new(OperationContext::new(host));
    let routes = Arc::new(Routes {
        store,
        fail: AtomicBool::new(false),
    });
    let reader = MemoryReader::new(
        context.clone(),
        routes.clone(),
        Arc::new(NoEmbedding(identity)),
        base.clone(),
    );
    let g: Value = serde_json::from_str(include_str!("fixtures/ops/golden/read.json")).unwrap();
    Fixture {
        _root: root,
        base,
        reader,
        context,
        routes,
        principal: serde_json::from_value(g["principal"].clone()).unwrap(),
        agent: serde_json::from_value(g["agent"].clone()).unwrap(),
    }
}
fn value(f: &Fixture, ids: Option<&[String]>) -> Value {
    serde_json::to_value(f.reader.stats(ids, &f.principal, &f.agent).unwrap()).unwrap()
}
fn assert_error(
    result: Result<plur1bus_engine::contract::MemoryStatsResult, EngineError>,
    code: MemoryOpErrorCode,
) {
    assert!(matches!(result, Err(EngineError::MemoryOp(e)) if e.code == code));
}
#[test]
fn current_acl_filters_foreign_deleted_expired_and_missing_even_with_explicit_ids() {
    let f = setup();
    let stats = RecallStats::new(&f.base).unwrap();
    stats
        .record(
            "agent",
            &(1..=4).map(id).collect::<Vec<_>>(),
            "private query",
            70.,
            &Cancel::never(),
        )
        .unwrap();
    let ids = vec![id(5), id(2), id(1), id(3), id(4), id(99), id(1)];
    let actual = value(&f, Some(&ids));
    assert_eq!(
        actual,
        json!({"agentId":"agent","items":[
            {"id":id(5),"recalls":0,"distinctQueries":0,"lastRecalledAt":null},
            {"id":id(1),"recalls":1,"distinctQueries":1,"lastRecalledAt":70}
        ]})
    );
    assert_eq!(
        value(&f, None)["items"],
        json!([{ "id":id(1),"recalls":1,"distinctQueries":1,"lastRecalledAt":70 }])
    );
    // A card becoming hidden after recording must disappear without altering its private counter.
    let mut row = f.routes.store.get(&id(1)).unwrap().unwrap();
    row.status = "deleted".into();
    f.routes.store.upsert(&[row]).unwrap();
    assert_eq!(value(&f, None)["items"], json!([]));
    assert_eq!(
        stats
            .read("agent", Some(&[id(1)]), &Cancel::never())
            .unwrap()[0]
            .recalls,
        1
    );
}
#[test]
fn validation_and_closed_guard_precede_sidecar_creation() {
    let f = setup();
    for ids in [vec![id(1); 501], vec!["invalid".into()]] {
        assert_error(
            f.reader.stats(Some(&ids), &f.principal, &f.agent),
            MemoryOpErrorCode::InvalidInput,
        );
    }
    assert!(!f.base.join("_recall-stats").exists());
    f.context.close();
    assert_error(
        f.reader.stats(None, &f.principal, &f.agent),
        MemoryOpErrorCode::Storage,
    );
    assert!(!f.base.join("_recall-stats").exists());
}
#[test]
fn counters_are_per_agent_and_required_source_errors_are_not_hidden() {
    let mut f = setup();
    RecallStats::new(&f.base)
        .unwrap()
        .record("agent", &[id(1), id(2)], "query", 70., &Cancel::never())
        .unwrap();
    f.principal.agent_id = serde_json::from_value(json!("other")).unwrap();
    assert_eq!(value(&f, None)["items"], json!([]));
    assert_eq!(
        value(&f, Some(&[id(1), id(2)]))["items"],
        json!([{ "id":id(2),"recalls":0,"distinctQueries":0,"lastRecalledAt":null }])
    );
    f.routes.fail.store(true, Ordering::SeqCst);
    assert_error(
        f.reader.stats(Some(&[id(2)]), &f.principal, &f.agent),
        MemoryOpErrorCode::Storage,
    );
}

#[test]
fn committed_tombstone_hides_a_still_present_row_and_corrupt_registry_is_an_error() {
    use plur1bus_engine::{store::tombstone::TombstoneRegistry, text::json::parse_json};
    let f = setup();
    let stats = RecallStats::new(&f.base).unwrap();
    stats
        .record("agent", &[id(1)], "query", 70., &Cancel::never())
        .unwrap();
    assert_eq!(value(&f, None)["items"].as_array().unwrap().len(), 1);
    let registry = TombstoneRegistry::new(&f.base, "agent").unwrap();
    let tombstone = json!({"schemaVersion":1,"agentId":"agent","memoryId":id(1),"canonicalOriginId":id(1),"scope":"agent-private","status":"committed","contentFingerprint":plur1bus_engine::store::tombstone::content_fingerprint("note")});
    registry
        .append(&parse_json(&tombstone.to_string()).unwrap())
        .unwrap();
    assert_eq!(value(&f, None)["items"], json!([]));
    assert!(f.routes.store.get(&id(1)).unwrap().is_some());
    // Required authorization evidence must not degrade into an empty successful answer.
    let path = registry.path();
    assert!(path.is_file());
    std::fs::write(path, "{broken").unwrap();
    assert_error(
        f.reader.stats(Some(&[id(5)]), &f.principal, &f.agent),
        MemoryOpErrorCode::Storage,
    );
}
