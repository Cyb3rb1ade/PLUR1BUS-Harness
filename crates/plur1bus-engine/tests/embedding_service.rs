#![allow(clippy::unwrap_used, clippy::expect_used)]

use plur1bus_engine::contract::{EmbeddingIdentity, EmbeddingService, ModelState, ModelsService};
use plur1bus_engine::embedding::{
    cache,
    seam::FlatEmbedder,
    service::{Service, ServiceOptions},
};
use plur1bus_engine::embedding::{
    Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity,
};
use plur1bus_engine::store::sqlite::EmbeddingCache;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

fn space(width: usize) -> VectorSpaceIdentity {
    serde_json::from_value(serde_json::json!({"provider":"local-transformers","model":"fixture", "revision":"main", "dimension":width,"normalization":"l2","prefixScheme":"none","instruction":"","dtype":"fp32"})).unwrap()
}

fn identity(width: usize) -> EmbeddingIdentity {
    EmbeddingIdentity {
        provider: "local-transformers".into(),
        model: "fixture".into(),
        dimensions: width.into(),
        fingerprint_id: "fixture-fingerprint".into(),
        space: Some(space(width)),
    }
}

struct CountingProvider {
    identity: VectorSpaceIdentity,
    calls: Arc<AtomicUsize>,
    width: usize,
    delay: Duration,
}
impl EmbeddingProvider for CountingProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(self.delay);
        Ok(texts.iter().map(|_| vec![1.0; self.width]).collect())
    }
}

fn service(
    width: usize,
    actual: usize,
    delay: Duration,
    cache: Option<EmbeddingCache>,
) -> (Service, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = CountingProvider {
        identity: space(width),
        calls: calls.clone(),
        width: actual,
        delay,
    };
    (
        Service::new(
            Box::new(provider),
            None,
            identity(width),
            cache,
            ServiceOptions::default(),
        )
        .unwrap(),
        calls,
    )
}

#[test]
fn embed_uses_the_cache_on_the_second_call() {
    let dir = tempfile::tempdir().unwrap();
    let (service, calls) = service(
        3,
        3,
        Duration::ZERO,
        Some(EmbeddingCache::open(&dir.path().join("cache.sqlite")).unwrap()),
    );
    let id = service.identities().remove(0);
    service
        .embed(&["Apple".into()], EmbedKind::Query, &id, &Cancel::never())
        .unwrap();
    service
        .embed(
            &["\u{feff}apple\u{feff}".into()],
            EmbedKind::Query,
            &id,
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    service
        .embed(&["apple".into()], EmbedKind::Passage, &id, &Cancel::never())
        .unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "query and passage must have distinct keys"
    );
}

#[test]
fn probe_reports_dimension_mismatch_for_a_vector_of_the_wrong_length() {
    let (service, _) = service(3, 2, Duration::ZERO, None);
    let probe = service.probe(false, &Cancel::never()).unwrap();
    assert!(!probe.ok);
    assert_eq!(
        serde_json::to_value(probe.error).unwrap(),
        serde_json::json!("dimension-mismatch")
    );
    assert_eq!(service.status().embedder.state, ModelState::Failed);
}

#[test]
fn warm_moves_state_from_loading_to_ready() {
    let (service, calls) = service(3, 3, Duration::ZERO, None);
    assert_eq!(service.status().embedder.state, ModelState::Loading);
    let status = service.warm(&Cancel::never(), false).unwrap();
    assert_eq!(status.embedder.state, ModelState::Ready);
    assert_eq!(status.reranker.state, ModelState::Disabled);
    assert!(service.probe(false, &Cancel::never()).unwrap().cached);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        service.serve().unwrap().identity.unwrap().fingerprint_id,
        "fixture-fingerprint"
    );
}

#[test]
fn cancelling_one_probe_waiter_does_not_cancel_the_shared_provider_call() {
    let (service, calls) = service(3, 3, Duration::from_millis(350), None);
    let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(20));
    let start = Instant::now();
    let probe = service.probe(false, &cancel).unwrap();
    assert!(!probe.ok);
    assert_eq!(
        serde_json::to_value(probe.error).unwrap(),
        serde_json::json!("aborted")
    );
    assert!(start.elapsed() < Duration::from_millis(200));
    assert!(service.probe(false, &Cancel::never()).unwrap().ok);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn concurrent_refreshes_share_one_probe_queued_after_the_running_call() {
    struct BlockingProvider {
        identity: VectorSpaceIdentity,
        calls: Arc<AtomicUsize>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl EmbeddingProvider for BlockingProvider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.release.lock().unwrap().recv().unwrap();
            }
            Ok(vec![vec![1.0; 3]; texts.len()])
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let provider = BlockingProvider {
        identity: space(3),
        calls: calls.clone(),
        release: std::sync::Mutex::new(release_rx),
    };
    let service = Arc::new(
        Service::new(
            Box::new(provider),
            None,
            identity(3),
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    let first = {
        let s = service.clone();
        std::thread::spawn(move || s.probe(false, &Cancel::never()).unwrap())
    };
    while calls.load(Ordering::SeqCst) == 0 {
        std::thread::yield_now();
    }
    // Both refreshes are now guaranteed to queue while the first provider call is blocked.
    for _ in 0..2 {
        let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(20));
        assert!(!service.probe(true, &cancel).unwrap().ok);
    }
    release_tx.send(()).unwrap();
    assert!(first.join().unwrap().ok);
    let deadline = Instant::now() + Duration::from_secs(1);
    while service.status().embedder.warming && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(!service.status().embedder.warming);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn the_flat_embedder_returns_e0_for_every_text() {
    let flat = FlatEmbedder::new(768, false);
    let values = flat
        .embed(
            &["a".into(), "b".into()],
            EmbedKind::Passage,
            &Cancel::never(),
        )
        .unwrap();
    for vector in values {
        assert_eq!(vector.len(), 768);
        assert_eq!(vector[0], 1.0);
        assert!(vector[1..].iter().all(|v| *v == 0.0));
    }
}

#[test]
fn the_cold_flat_embedder_delays_the_first_two_query_embeds_by_350ms_each_serially() {
    let flat = FlatEmbedder::new(3, true);
    let started = Instant::now();
    let (a, b) = std::thread::scope(|scope| {
        let call = || {
            flat.embed(&["q".into()], EmbedKind::Query, &Cancel::never())
                .unwrap();
            started.elapsed()
        };
        let a = scope.spawn(call);
        let b = scope.spawn(call);
        (a.join().unwrap(), b.join().unwrap())
    });
    let mut times = [a, b];
    times.sort();
    assert!(times[0] >= Duration::from_millis(340));
    assert!(times[1] >= Duration::from_millis(690));
    assert!(times[0] < Duration::from_millis(650));
    let started = Instant::now();
    flat.embed(&["third".into()], EmbedKind::Query, &Cancel::never())
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(100));
    let flat = FlatEmbedder::new(3, true);
    let started = Instant::now();
    flat.embed(&["passage".into()], EmbedKind::Passage, &Cancel::never())
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(100));
}

#[test]
fn the_cache_key_matches_node() {
    use plur1bus_engine::text::js::JsString;
    let expected = "04b8e83d29ef5973935c4deb1a14ddfa75ab09bd54c464e2dcb772d6d8402eeb";
    let key = cache::cache_key(
        "local-transformers",
        "fixture",
        3,
        "agent",
        "legacy",
        EmbedKind::Query,
        &JsString::from_utf8_str("\u{feff}APPLE\u{feff}"),
    );
    assert_eq!(key.key_hash(), expected);
    let cut = cache::cache_key(
        "p",
        "m",
        3,
        "a",
        "legacy",
        EmbedKind::Passage,
        &JsString::from_utf16_units(vec![0xd83d]),
    );
    let replacement = cache::cache_key(
        "p",
        "m",
        3,
        "a",
        "legacy",
        EmbedKind::Passage,
        &JsString::from_utf8_str("\u{fffd}"),
    );
    assert_eq!(cut.key_hash(), replacement.key_hash());
}

#[test]
fn cache_hits_do_not_extend_the_original_ttl() {
    use std::sync::atomic::AtomicI64;
    let now = Arc::new(AtomicI64::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = CountingProvider {
        identity: space(3),
        calls: calls.clone(),
        width: 3,
        delay: Duration::ZERO,
    };
    let options = ServiceOptions {
        cache_ttl_ms: 100,
        clock: {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        },
        ..ServiceOptions::default()
    };
    let service = Service::new(Box::new(provider), None, identity(3), None, options).unwrap();
    let id = service.identities().remove(0);
    for timestamp in [0, 90, 110] {
        now.store(timestamp, Ordering::SeqCst);
        service
            .embed(&["ttl".into()], EmbedKind::Query, &id, &Cancel::never())
            .unwrap();
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

struct FloatIndexReranker;
impl plur1bus_engine::embedding::Reranker for FloatIndexReranker {
    fn rerank(
        &self,
        _: &str,
        _: &[String],
        _: usize,
        _: &Cancel,
    ) -> Result<Vec<plur1bus_engine::contract::RerankHit>, plur1bus_engine::embedding::RerankError>
    {
        Ok(vec![serde_json::from_value(
            serde_json::json!({"index":1.0,"score":0.75}),
        )
        .unwrap()])
    }
    fn empty_result_is_valid(&self) -> bool {
        false
    }
}

#[test]
fn rerank_accepts_an_integral_json_float_index_as_node_does() {
    let provider = CountingProvider {
        identity: space(3),
        calls: Arc::new(AtomicUsize::new(0)),
        width: 3,
        delay: Duration::ZERO,
    };
    let service = Service::new(
        Box::new(provider),
        Some(Box::new(FloatIndexReranker)),
        identity(3),
        None,
        ServiceOptions::default(),
    )
    .unwrap();
    let hits = service
        .rerank("query", &["one".into(), "two".into()], 1, &Cancel::never())
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].index.as_f64(), Some(1.0));
}

#[test]
fn malformed_caller_vector_space_identity_returns_a_typed_error() {
    let (service, _) = service(3, 3, Duration::ZERO, None);
    let mut id = identity(3);
    let mut malformed = serde_json::to_value(space(3)).unwrap();
    malformed["artifacts"] = serde_json::json!([{"path":"model.onnx","sha256":"invalid"}]);
    id.space = Some(serde_json::from_value(malformed).unwrap());
    assert!(service
        .embed(&["query".into()], EmbedKind::Query, &id, &Cancel::never())
        .is_err());
}

#[test]
fn a_disabled_reranker_returns_an_empty_result() {
    let (service, _) = service(3, 3, Duration::ZERO, None);
    assert!(service
        .rerank("query", &["one".into(), "two".into()], 1, &Cancel::never())
        .unwrap()
        .is_empty());
}

#[test]
fn a_memoized_probe_answers_without_waiting_even_for_a_cancelled_caller() {
    let (service, calls) = service(3, 3, Duration::ZERO, None);
    assert!(service.probe(false, &Cancel::never()).unwrap().ok);
    let cancel = Cancel::never();
    cancel.cancel();
    let result = service.probe(false, &cancel).unwrap();
    assert!(result.ok && result.cached);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn flat_identity_binding_is_explicit_canonical_and_width_checked() {
    let flat = FlatEmbedder::new(3, false)
        .bind_identity(&space(3))
        .unwrap();
    let service = Service::new(
        Box::new(flat),
        None,
        identity(3),
        None,
        ServiceOptions::default(),
    )
    .unwrap();
    assert_eq!(service.identities()[0].model, "fixture");
    assert!(FlatEmbedder::new(3, false)
        .bind_identity(&space(4))
        .is_err());
    let mut malformed = serde_json::to_value(space(3)).unwrap();
    malformed["artifacts"] = serde_json::json!([{"path":"model.onnx","sha256":"invalid"}]);
    let malformed: VectorSpaceIdentity = serde_json::from_value(malformed).unwrap();
    assert!(FlatEmbedder::new(3, false)
        .bind_identity(&malformed)
        .is_err());
}

struct EmptyReranker;
impl plur1bus_engine::embedding::Reranker for EmptyReranker {
    fn rerank(
        &self,
        _: &str,
        _: &[String],
        _: usize,
        _: &Cancel,
    ) -> Result<Vec<plur1bus_engine::contract::RerankHit>, plur1bus_engine::embedding::RerankError>
    {
        Ok(Vec::new())
    }
    fn empty_result_is_valid(&self) -> bool {
        false
    }
}

#[test]
fn the_facade_preserves_empty_rerank_results_and_probe_checks_readiness() {
    let provider = CountingProvider {
        identity: space(3),
        calls: Arc::new(AtomicUsize::new(0)),
        width: 3,
        delay: Duration::ZERO,
    };
    let service = Service::new(
        Box::new(provider),
        Some(Box::new(EmptyReranker)),
        identity(3),
        None,
        ServiceOptions::default(),
    )
    .unwrap();
    assert!(service
        .rerank("query", &["one".into(), "two".into()], 1, &Cancel::never())
        .unwrap()
        .is_empty());
    let status = service.warm(&Cancel::never(), false).unwrap();
    assert_eq!(status.reranker.state, ModelState::Failed);
    assert_eq!(
        serde_json::to_value(status.reranker.error).unwrap(),
        serde_json::json!("invalid-result")
    );
}

#[test]
fn the_facade_honors_the_top_level_embedding_batch_size_without_dropping_texts() {
    let config: plur1bus_engine::contract::EngineConfig =
        serde_json::from_value(serde_json::json!({"embeddingBatchSize":2})).unwrap();
    let options = ServiceOptions::from_config(&config).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = CountingProvider {
        identity: space(3),
        calls: calls.clone(),
        width: 3,
        delay: Duration::ZERO,
    };
    let service = Service::new(Box::new(provider), None, identity(3), None, options).unwrap();
    let texts = (0..5)
        .map(|index| format!("text-{index}"))
        .collect::<Vec<_>>();
    let vectors = service
        .embed(&texts, EmbedKind::Passage, &identity(3), &Cancel::never())
        .unwrap();
    assert_eq!(vectors.len(), 5);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn gemma_cache_model_includes_dtype_before_purpose_as_node_does() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.sqlite");
    let mut configured = space(768);
    configured.model = "google/embeddinggemma-2".into();
    configured.dtype = "q8".into();
    let mut envelope = identity(768);
    envelope.model = configured.model.clone();
    envelope.space = Some(configured.clone());
    let provider = CountingProvider {
        identity: configured.clone(),
        calls: Arc::new(AtomicUsize::new(0)),
        width: 768,
        delay: Duration::ZERO,
    };
    let service = Service::new(
        Box::new(provider),
        None,
        envelope.clone(),
        Some(EmbeddingCache::open(&path).unwrap()),
        ServiceOptions::default(),
    )
    .unwrap();
    service
        .embed(
            &["Apple".into()],
            EmbedKind::Passage,
            &envelope,
            &Cancel::never(),
        )
        .unwrap();
    let key = cache::cache_key(
        "local-transformers",
        "google/embeddinggemma-2@q8",
        768,
        "default",
        &plur1bus_engine::embedding::identity::identity_id(&configured),
        EmbedKind::Passage,
        &plur1bus_engine::text::js::JsString::from_utf8_str("apple"),
    );
    assert!(
        EmbeddingCache::open(&path)
            .unwrap()
            .get(&key)
            .unwrap()
            .is_some(),
        "Node uses google/embeddinggemma-2@q8:passage for the persisted model key"
    );
}

#[test]
fn egress_changes_invalidate_the_owned_embedding_and_reranker_clients() {
    use plur1bus_engine::embedding::{RerankError, RerankHit, Reranker};
    struct Provider {
        space: VectorSpaceIdentity,
        changes: Arc<AtomicUsize>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.space
        }
        fn embed(
            &self,
            _: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            Ok(Vec::new())
        }
        fn invalidate_egress(&self) {
            self.changes.fetch_add(1, Ordering::SeqCst);
        }
    }
    struct Ranker(Arc<AtomicUsize>);
    impl Reranker for Ranker {
        fn rerank(
            &self,
            _: &str,
            _: &[String],
            _: usize,
            _: &Cancel,
        ) -> Result<Vec<RerankHit>, RerankError> {
            Ok(Vec::new())
        }
        fn empty_result_is_valid(&self) -> bool {
            false
        }
        fn invalidate_egress(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let embeddings = Arc::new(AtomicUsize::new(0));
    let reranks = Arc::new(AtomicUsize::new(0));
    let service = Service::new(
        Box::new(Provider {
            space: space(3),
            changes: embeddings.clone(),
        }),
        Some(Box::new(Ranker(reranks.clone()))),
        identity(3),
        None,
        ServiceOptions::default(),
    )
    .unwrap();
    service.invalidate_egress();
    assert_eq!(embeddings.load(Ordering::SeqCst), 1);
    assert_eq!(reranks.load(Ordering::SeqCst), 1);
}

#[test]
fn omitted_envelope_spaces_still_isolate_the_actual_provider_revisions_in_sqlite() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.sqlite");
    for revision in ["revision-one", "revision-two"] {
        let mut configured = space(3);
        configured.revision = revision.into();
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = CountingProvider {
            identity: configured,
            calls: calls.clone(),
            width: 3,
            delay: Duration::ZERO,
        };
        let mut envelope = identity(3);
        envelope.space = None;
        envelope.fingerprint_id = revision.into();
        let service = Service::new(
            Box::new(provider),
            None,
            envelope.clone(),
            Some(EmbeddingCache::open(&path).unwrap()),
            ServiceOptions::default(),
        )
        .unwrap();
        service
            .embed(
                &["shared text".into()],
                EmbedKind::Passage,
                &envelope,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "provider revision {revision} must own a distinct Node v2 cache entry"
        );
    }
}

#[test]
fn newly_computed_embeddings_receive_their_ttl_at_compute_completion() {
    use std::sync::atomic::AtomicI64;
    struct Provider {
        identity: VectorSpaceIdentity,
        clock: Arc<AtomicI64>,
        calls: Arc<AtomicUsize>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.clock.store(101, Ordering::SeqCst);
            Ok(vec![vec![1.0; 3]; texts.len()])
        }
    }
    let clock = Arc::new(AtomicI64::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = Provider {
        identity: space(3),
        clock: clock.clone(),
        calls: calls.clone(),
    };
    let options = ServiceOptions {
        cache_ttl_ms: 100,
        clock: Arc::new(move || clock.load(Ordering::SeqCst)),
        ..ServiceOptions::default()
    };
    let service = Service::new(Box::new(provider), None, identity(3), None, options).unwrap();
    for _ in 0..2 {
        service
            .embed(
                &["slow compute".into()],
                EmbedKind::Query,
                &identity(3),
                &Cancel::never(),
            )
            .unwrap();
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a compute lasting longer than the TTL must still publish a fresh cache entry"
    );
}

#[test]
fn a_blocked_cache_miss_does_not_delay_an_unrelated_warm_hit() {
    struct Provider {
        identity: VectorSpaceIdentity,
        started: std::sync::mpsc::Sender<()>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            if texts.iter().any(|text| text == "blocked") {
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            Ok(vec![vec![1.0; 3]; texts.len()])
        }
    }
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let provider = Provider {
        identity: space(3),
        started: started_tx,
        release: std::sync::Mutex::new(release_rx),
    };
    let service = Arc::new(
        Service::new(
            Box::new(provider),
            None,
            identity(3),
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    service
        .embed(
            &["warm".into()],
            EmbedKind::Query,
            &identity(3),
            &Cancel::never(),
        )
        .unwrap();
    let owner = {
        let service = service.clone();
        std::thread::spawn(move || {
            service
                .embed(
                    &["blocked".into()],
                    EmbedKind::Query,
                    &identity(3),
                    &Cancel::never(),
                )
                .unwrap()
        })
    };
    started_rx.recv().unwrap();
    let hit = service.embed(
        &["warm".into()],
        EmbedKind::Query,
        &identity(3),
        &Cancel::with_deadline(Instant::now() + Duration::from_millis(20)),
    );
    release_tx.send(()).unwrap();
    owner.join().unwrap();
    assert!(
        hit.is_ok(),
        "a warm cache hit must not wait for another key's provider computation: {hit:?}"
    );
}

#[test]
fn sqlite_cache_failures_do_not_prevent_provider_results() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.sqlite");
    let cache = EmbeddingCache::open(&path).unwrap();
    // A real SQLite schema failure makes both the cache read and its later persistent write fail.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute("DROP TABLE embeddings", [])
        .unwrap();
    let (service, calls) = service(3, 3, Duration::ZERO, Some(cache));
    let vector = service
        .embed(
            &["uncached".into()],
            EmbedKind::Query,
            &identity(3),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(vector, vec![vec![1.0; 3]]);
    service
        .embed(
            &["uncached".into()],
            EmbedKind::Query,
            &identity(3),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "memory caching remains usable after persistent cache I/O fails"
    );
}

#[test]
fn overlapping_batches_publish_owned_keys_before_waiting_and_cancel_only_the_waiter() {
    struct Provider {
        identity: VectorSpaceIdentity,
        calls: Arc<AtomicUsize>,
        started: std::sync::mpsc::Sender<Vec<String>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
            self.started.send(texts.to_vec()).unwrap();
            if first {
                self.release.lock().unwrap().recv().unwrap();
            }
            Ok(texts
                .iter()
                .map(|text| vec![f32::from(text.as_bytes()[0] - b'A' + 1); 3])
                .collect())
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let service = Arc::new(
        Service::new(
            Box::new(Provider {
                identity: space(3),
                calls: calls.clone(),
                started: started_tx,
                release: std::sync::Mutex::new(release_rx),
            }),
            None,
            identity(3),
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    let first = {
        let service = service.clone();
        std::thread::spawn(move || {
            service.embed(
                &["A".into(), "B".into()],
                EmbedKind::Passage,
                &identity(3),
                &Cancel::never(),
            )
        })
    };
    assert_eq!(
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        ["A", "B"]
    );
    let cancel = Cancel::never();
    let overlapping = {
        let service = service.clone();
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            service.embed(
                &["B".into(), "C".into()],
                EmbedKind::Passage,
                &identity(3),
                &cancel,
            )
        })
    };
    let owned = started_rx.recv_timeout(Duration::from_secs(1));
    if owned.is_err() {
        cancel.cancel();
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        let _ = overlapping.join().unwrap();
        assert!(
            owned.is_ok(),
            "the overlapping batch must compute C before waiting on foreign B"
        );
        return;
    }
    assert_eq!(owned.unwrap(), ["C"]);
    assert_eq!(
        service
            .embed(
                &["C".into()],
                EmbedKind::Passage,
                &identity(3),
                &Cancel::with_deadline(Instant::now() + Duration::from_millis(100))
            )
            .unwrap(),
        vec![vec![3.0; 3]]
    );
    cancel.cancel();
    assert!(overlapping.join().unwrap().is_err());
    assert!(service
        .embed(
            &["B".into(), "A".into()],
            EmbedKind::Passage,
            &identity(3),
            &Cancel::with_deadline(Instant::now() + Duration::from_millis(20))
        )
        .is_err());
    release_tx.send(()).unwrap();
    assert_eq!(
        first.join().unwrap().unwrap(),
        vec![vec![1.0; 3], vec![2.0; 3]]
    );
    assert_eq!(
        service
            .embed(
                &["B".into(), "A".into()],
                EmbedKind::Passage,
                &identity(3),
                &Cancel::never()
            )
            .unwrap(),
        vec![vec![2.0; 3], vec![1.0; 3]]
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "foreign claims coalesce across reversed and partially overlapping batches"
    );
}

#[test]
fn an_owned_cache_failure_is_not_hidden_behind_a_pending_foreign_key() {
    struct Provider {
        identity: VectorSpaceIdentity,
        started: std::sync::mpsc::Sender<()>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            if texts[0] == "B" {
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                Ok(vec![vec![1.0; 3]])
            } else {
                Err(EmbedError::ProviderFailed { status: Some(418) })
            }
        }
    }
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let service = Arc::new(
        Service::new(
            Box::new(Provider {
                identity: space(3),
                started: started_tx,
                release: std::sync::Mutex::new(release_rx),
            }),
            None,
            identity(3),
            None,
            ServiceOptions::default(),
        )
        .unwrap(),
    );
    let owner = {
        let service = service.clone();
        std::thread::spawn(move || {
            service.embed(
                &["B".into()],
                EmbedKind::Query,
                &identity(3),
                &Cancel::never(),
            )
        })
    };
    started_rx.recv().unwrap();
    let result = service.embed(
        &["B".into(), "C".into()],
        EmbedKind::Query,
        &identity(3),
        &Cancel::with_deadline(Instant::now() + Duration::from_millis(30)),
    );
    release_tx.send(()).unwrap();
    owner.join().unwrap().unwrap();
    assert!(
        matches!(
            result,
            Err(plur1bus_engine::contract::EngineError::Embedding(
                EmbedError::ProviderFailed { status: Some(418) }
            ))
        ),
        "the known provider error must return before waiting on B: {result:?}"
    );
}

#[test]
fn a_foreign_cache_failure_is_not_hidden_behind_an_earlier_pending_key() {
    struct Provider {
        identity: VectorSpaceIdentity,
        started: std::sync::mpsc::Sender<String>,
        b: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        c: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            self.started.send(texts[0].clone()).unwrap();
            if texts[0] == "B" {
                self.b.lock().unwrap().recv().unwrap();
                Ok(vec![vec![1.0; 3]])
            } else {
                self.c.lock().unwrap().recv().unwrap();
                Err(EmbedError::ProviderFailed { status: Some(418) })
            }
        }
    }
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (b_tx, b_rx) = std::sync::mpsc::channel();
    let (c_tx, c_rx) = std::sync::mpsc::channel();
    let (lookup_tx, lookup_rx) = std::sync::mpsc::channel();
    let options = ServiceOptions {
        clock: Arc::new(move || {
            if std::thread::current().name() == Some("joining-cache-keys") {
                lookup_tx.send(()).unwrap();
            }
            0
        }),
        ..ServiceOptions::default()
    };
    let service = Arc::new(
        Service::new(
            Box::new(Provider {
                identity: space(3),
                started: started_tx,
                b: std::sync::Mutex::new(b_rx),
                c: std::sync::Mutex::new(c_rx),
            }),
            None,
            identity(3),
            None,
            options,
        )
        .unwrap(),
    );
    let b = {
        let service = service.clone();
        std::thread::spawn(move || {
            service.embed(
                &["B".into()],
                EmbedKind::Query,
                &identity(3),
                &Cancel::never(),
            )
        })
    };
    assert_eq!(started_rx.recv().unwrap(), "B");
    let c = {
        let service = service.clone();
        std::thread::spawn(move || {
            service.embed(
                &["C".into()],
                EmbedKind::Query,
                &identity(3),
                &Cancel::never(),
            )
        })
    };
    assert_eq!(started_rx.recv().unwrap(), "C");
    let joining = {
        let service = service.clone();
        std::thread::Builder::new()
            .name("joining-cache-keys".into())
            .spawn(move || {
                service.embed(
                    &["B".into(), "C".into()],
                    EmbedKind::Query,
                    &identity(3),
                    &Cancel::with_deadline(Instant::now() + Duration::from_millis(100)),
                )
            })
            .unwrap()
    };
    // The lookup signal runs under the memory lock: C's publication cannot overtake the joiner's claims.
    lookup_rx.recv().unwrap();
    c_tx.send(()).unwrap();
    assert!(c.join().unwrap().is_err());
    let result = joining.join().unwrap();
    b_tx.send(()).unwrap();
    b.join().unwrap().unwrap();
    assert!(
        matches!(
            result,
            Err(plur1bus_engine::contract::EngineError::Embedding(
                EmbedError::ProviderFailed { status: Some(418) }
            ))
        ),
        "C's completed provider error must not wait for pending B: {result:?}"
    );
}

fn cancelling_the_cache_owner_preserves_other_waiters(deadline: bool) {
    use plur1bus_engine::contract::{CancelReason, EngineError};

    struct Provider {
        identity: VectorSpaceIdentity,
        calls: Arc<AtomicUsize>,
        started: std::sync::mpsc::Sender<()>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            cancel: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            if texts[0] == "X" {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            cancel.check().map_err(EmbedError::Cancelled)?;
            Ok(vec![vec![1.0; 3]; texts.len()])
        }
    }

    let calls = Arc::new(AtomicUsize::new(0));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (lookup_tx, lookup_rx) = std::sync::mpsc::channel();
    let service = Arc::new(
        Service::new(
            Box::new(Provider {
                identity: space(3),
                calls: calls.clone(),
                started: started_tx,
                release: std::sync::Mutex::new(release_rx),
            }),
            None,
            identity(3),
            None,
            ServiceOptions {
                clock: Arc::new(move || {
                    if std::thread::current().name() == Some("surviving-cache-waiter") {
                        lookup_tx.send(()).unwrap();
                    }
                    0
                }),
                ..ServiceOptions::default()
            },
        )
        .unwrap(),
    );
    service
        .embed(
            &["warm".into()],
            EmbedKind::Query,
            &identity(3),
            &Cancel::never(),
        )
        .unwrap();
    let owner_cancel = Cancel::never();
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let owner = {
        let service = service.clone();
        let cancel = owner_cancel.clone();
        std::thread::spawn(move || {
            let cancel = if deadline {
                Cancel::with_deadline(Instant::now() + Duration::from_millis(20))
            } else {
                cancel
            };
            result_tx
                .send(service.embed(&["X".into()], EmbedKind::Query, &identity(3), &cancel))
                .unwrap();
        })
    };
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let survivor = {
        let service = service.clone();
        std::thread::Builder::new()
            .name("surviving-cache-waiter".into())
            .spawn(move || {
                service.embed(
                    &["X".into()],
                    EmbedKind::Query,
                    &identity(3),
                    &Cancel::with_deadline(Instant::now() + Duration::from_secs(2)),
                )
            })
            .unwrap()
    };
    lookup_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    // The signal runs under the memory lock. This warm hit acquires that lock afterwards,
    // ensuring the survivor has joined X before the owner is cancelled or the provider is released.
    service
        .embed(
            &["warm".into()],
            EmbedKind::Query,
            &identity(3),
            &Cancel::never(),
        )
        .unwrap();
    if !deadline {
        owner_cancel.cancel();
    }
    let owner_result = result_rx.recv_timeout(Duration::from_millis(200));
    release_tx.send(()).unwrap();
    owner.join().unwrap();
    let survivor_result = survivor.join().unwrap();
    assert!(
        owner_result.is_ok(),
        "the cancelled owner must return while shared computation is still blocked: {owner_result:?}; surviving waiter: {survivor_result:?}"
    );
    assert!(matches!(
        owner_result.unwrap(),
        Err(EngineError::Cancelled(cancelled))
            if cancelled.reason == if deadline { CancelReason::Deadline } else { CancelReason::Caller }
    ));
    assert_eq!(survivor_result.unwrap(), vec![vec![1.0; 3]]);
    assert_eq!(
        service
            .embed(
                &["X".into()],
                EmbedKind::Query,
                &identity(3),
                &Cancel::never(),
            )
            .unwrap(),
        vec![vec![1.0; 3]]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn cancelling_the_cache_owner_does_not_cancel_shared_computation() {
    cancelling_the_cache_owner_preserves_other_waiters(false);
}

#[test]
fn the_cache_owner_deadline_does_not_expire_shared_computation() {
    cancelling_the_cache_owner_preserves_other_waiters(true);
}

#[test]
fn a_panicking_shared_compute_returns_an_error_and_releases_every_claim_for_retry() {
    struct Provider {
        identity: VectorSpaceIdentity,
        calls: Arc<AtomicUsize>,
    }
    impl EmbeddingProvider for Provider {
        fn identity(&self) -> &VectorSpaceIdentity {
            &self.identity
        }
        #[allow(clippy::panic)] // This test boundary deliberately panics to verify every claim is released.
        fn embed(
            &self,
            texts: &[String],
            _: EmbedKind,
            _: &Cancel,
        ) -> Result<Vec<Vec<f32>>, EmbedError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("synthetic provider panic");
            }
            Ok(vec![vec![1.0; 3]; texts.len()])
        }
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let service = Service::new(
        Box::new(Provider {
            identity: space(3),
            calls: calls.clone(),
        }),
        None,
        identity(3),
        None,
        ServiceOptions::default(),
    )
    .unwrap();
    let result = service.embed(
        &["X".into(), "Y".into()],
        EmbedKind::Query,
        &identity(3),
        &Cancel::with_deadline(Instant::now() + Duration::from_secs(1)),
    );
    assert!(matches!(
        result,
        Err(plur1bus_engine::contract::EngineError::Embedding(
            EmbedError::ProviderFailed { status: None }
        ))
    ));
    assert_eq!(
        service
            .embed(
                &["Y".into(), "X".into()],
                EmbedKind::Query,
                &identity(3),
                &Cancel::with_deadline(Instant::now() + Duration::from_secs(1)),
            )
            .unwrap(),
        vec![vec![1.0; 3]; 2]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
