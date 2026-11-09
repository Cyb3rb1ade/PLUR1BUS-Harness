//! CP-2 through the actual process engine, without providers or lifecycle resets at checkpoints.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::contract::testing::FakeHost;
use crate::embedding::{EmbeddingProvider, VectorSpaceIdentity};
use std::sync::atomic::AtomicUsize;
fn fixture() -> (tempfile::TempDir, Arc<FakeHost>, ProcessEngine) {
    let root = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let host = Arc::new(FakeHost::new(
        root.path().join("not-created"),
        serde_json::from_value(json!({})).unwrap(),
    ));
    host.set_now_ms(1234);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    (root, host, engine)
}
fn id() -> AgentId {
    serde_json::from_value(json!("alpha")).unwrap()
}
#[test]
fn actual_process_lists_the_catalog_without_granting_job_execution() {
    let (_root, host, engine) = fixture();
    let specs = engine.jobs().list();
    assert_eq!(specs.len(), 20);
    assert_eq!(
        serde_json::to_value(&specs).unwrap(),
        serde_json::to_value(crate::jobs::catalog()).unwrap()
    );
    for spec in specs {
        let opts = serde_json::from_value(json!({})).unwrap();
        assert!(
            matches!(engine.jobs().run(spec.name, &id(), opts, &Cancel::never()), Err(EngineError::NotAvailable{reason}) if reason == "composition-pending")
        );
        let cancelled = Cancel::never();
        cancelled.cancel();
        assert!(engine
            .jobs()
            .run(
                spec.name,
                &id(),
                serde_json::from_value(json!({})).unwrap(),
                &cancelled
            )
            .is_err());
    }
    assert!(!host.state_dir().exists());
    assert!(!engine.status().ready);
    engine.close(None).unwrap();
    assert_eq!(engine.jobs().list().len(), 20);
    assert!(
        matches!(engine.jobs().run(JobName::KnowledgeUpdate, &id(), serde_json::from_value(json!({})).unwrap(), &Cancel::never()), Err(EngineError::NotAvailable{reason}) if reason == "closed")
    );
}
#[test]
fn checkpoints_use_the_existing_node_digest_and_host_clock_for_all_reasons() {
    let (_root, host, engine) = fixture();
    let reference = crate::store::checkpoint::CheckpointStore::new(|| 1234.0);
    for name in ["compaction", "session-end", "shutdown", "manual"] {
        let reason: CheckpointReason = serde_json::from_value(json!(name)).unwrap();
        let expected = reference.checkpoint("alpha", name, None, "").unwrap();
        assert_eq!(
            serde_json::to_value(engine.checkpoint(&id(), reason).unwrap()).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert!(!engine.checkpoint(&id(), reason).unwrap().written);
        let other: AgentId = serde_json::from_value(json!("beta")).unwrap();
        assert!(engine.checkpoint(&other, reason).unwrap().written);
    }
    host.set_now_ms(1235);
    assert!(
        engine
            .checkpoint(&id(), CheckpointReason::Manual)
            .unwrap()
            .written
    );
    assert!(
        !engine
            .checkpoint(&id(), CheckpointReason::Manual)
            .unwrap()
            .written
    );
}
#[test]
fn checkpoint_does_not_create_files_load_models_or_claim_memory_readiness() {
    let (_root, host, engine) = fixture();
    let before = serde_json::to_value(engine.models().status()).unwrap();
    assert!(
        engine
            .checkpoint(&id(), CheckpointReason::SessionEnd)
            .unwrap()
            .written
    );
    assert_eq!(
        serde_json::to_value(engine.models().status()).unwrap(),
        before
    );
    assert!(!engine.status().ready);
    assert!(!host.state_dir().exists());
}
#[test]
fn checkpoint_map_has_engine_lifetime_and_close_rejects_all_boundaries() {
    let (_root, host, engine) = fixture();
    let first = engine
        .checkpoint(&id(), CheckpointReason::SessionEnd)
        .unwrap();
    assert!(first.written);
    engine.close(None).unwrap();
    for reason in [
        CheckpointReason::Compaction,
        CheckpointReason::SessionEnd,
        CheckpointReason::Shutdown,
        CheckpointReason::Manual,
    ] {
        assert!(
            matches!(engine.checkpoint(&id(), reason), Err(EngineError::NotAvailable {reason}) if reason == "closed")
        );
    }
    let fresh = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let next = fresh
        .checkpoint(&id(), CheckpointReason::SessionEnd)
        .unwrap();
    assert!(next.written);
    assert_eq!(first.digest, next.digest);
}
struct Counted {
    inner: embedding::seam::FlatEmbedder,
    calls: Arc<AtomicUsize>,
}
impl EmbeddingProvider for Counted {
    fn identity(&self) -> &VectorSpaceIdentity {
        self.inner.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.embed(texts, kind, cancel)
    }
}
#[test]
fn one_thousand_session_end_checkpoints_leave_the_same_embedder_warm() {
    let (_root, host, mut engine) = fixture();
    let identity = engine.embedding().identities().remove(0);
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = Counted {
        inner: embedding::seam::FlatEmbedder::new(
            identity.dimensions.as_u64().unwrap() as usize,
            false,
        )
        .bind_identity(identity.space.as_ref().unwrap())
        .unwrap(),
        calls: calls.clone(),
    };
    engine.embedding = Arc::new(
        Service::new(
            Box::new(provider),
            None,
            identity.clone(),
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    // Keep the test-only provider replacement shared with the newly composed inspector.
    engine.stores = crate::ops::adopt::StoreAdopter::new(
        engine.embedding.clone(),
        Some(identity.clone()),
        host.platform().clone(),
        Arc::new(crate::ops::adopt::CopiedStoreRoutes),
        engine.store_cancel.clone(),
    );
    engine.models().warm(&Cancel::never(), false).unwrap();
    let before = serde_json::to_value(engine.models().status()).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    for clock in 2000..3000 {
        host.set_now_ms(clock);
        assert!(
            engine
                .checkpoint(&id(), CheckpointReason::SessionEnd)
                .unwrap()
                .written
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        serde_json::to_value(engine.models().status()).unwrap(),
        before
    );
    engine
        .embedding()
        .embed(
            &["A fresh post-checkpoint query".into()],
            EmbedKind::Query,
            &identity,
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!host.state_dir().exists());
}
#[test]
fn simultaneous_identical_checkpoints_acknowledge_one_new_digest() {
    let (_root, _host, engine) = fixture();
    let engine = Arc::new(engine);
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let engine = engine.clone();
            std::thread::spawn(move || engine.checkpoint(&id(), CheckpointReason::Manual).unwrap())
        })
        .collect();
    let rows: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(rows.iter().filter(|r| r.written).count(), 1);
    assert!(rows.iter().all(|r| r.digest == rows[0].digest));
}
