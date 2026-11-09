//! Namespace composition keeps ownership, denial delivery and request-scoped provider work.
#![allow(
    clippy::unwrap_used,
    reason = "integration fixtures fail on parity drift"
)]
#[path = "recall_support.rs"]
mod support;

use plur1bus_engine::context::{principal_key, RequestContext};
use plur1bus_engine::contract::{AgentContext, MemoryRow, Principal, RerankHit};
use plur1bus_engine::embedding::{
    Cancel, EmbedError, EmbedKind, EmbeddingProvider, RerankError, Reranker,
};
use plur1bus_engine::recall::acl::DenialSink;
use plur1bus_engine::recall::finalise::FinaliseLimits;
use plur1bus_engine::recall::hash_embed::{HashEmbedder, HASH_DIMENSION};
use plur1bus_engine::recall::knowledge::search_canonical;
use plur1bus_engine::recall::merge::MergeOptions;
use plur1bus_engine::recall::namespace_pipeline::Pipeline;
use plur1bus_engine::recall::namespace_query::RequestQueries;
use plur1bus_engine::recall::namespaces::{
    recall, CanonicalSource, NamespaceError, NamespaceRequest, NamespaceStores, TableRecall,
};
use plur1bus_engine::recall::stages::{StageClocks, StageError, StageFlags, StageLimits};
use plur1bus_engine::store::Store;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use support::{memory_row, TestHost};

#[test]
fn canonical_recall_rebuilds_heading_only_caches_from_before_t4() {
    for complete_first in [false, true] {
        let root = support::canonical_tempdir();
        let memory = root.path().join("memory");
        let cache = root.path().join(".adaptive-learning");
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        let first =
            "## First\nSynthetic first canonical section retained across an engine upgrade.\n";
        let second =
            "## Second\nSynthetic second canonical section retained across an engine upgrade.\n";
        let knowledge = memory.join("KNOWLEDGE.md");
        std::fs::write(&knowledge, format!("{first}{second}")).unwrap();
        let mtime = std::fs::metadata(&knowledge)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        // T2/T3 persisted heading/vector only; also cover a partially upgraded cache.
        let mut chunks = json!([
            {"heading":"First","vector":vector()},
            {"heading":"Second","vector":vector()}
        ]);
        if complete_first {
            chunks[0]["text"] = json!(first);
        }
        std::fs::write(
            cache.join("knowledge-cache.json"),
            json!({"mtime":mtime as i64,"identityId":"legacy","chunks":chunks}).to_string(),
        )
        .unwrap();
        let embedder = Flat::new();
        let hits = search_canonical(root.path(), &vector(), &embedder, 0.0, 10, true);
        assert_eq!(hits.len(), 2, "an older cache hid canonical sections");
        assert_eq!(hits[0].text, first);
        assert_eq!(hits[1].text, format!("{second}\n"));
        assert_eq!(embedder.1.load(Ordering::SeqCst), 2);
        assert_eq!(
            search_canonical(root.path(), &vector(), &embedder, 0.0, 10, true),
            hits
        );
        assert_eq!(
            embedder.1.load(Ordering::SeqCst),
            2,
            "rebuilt cache was not reused"
        );
    }
}

#[test]
fn recall_namespaces_share_query_inference_only_within_one_request() {
    assert_request_query_calls(false);
}

#[test]
fn recall_namespaces_share_query_failures_and_settle_without_retrying() {
    assert_request_query_calls(true);
}

fn assert_request_query_calls(fail: bool) {
    let root = support::canonical_tempdir();
    let base = root.path().join("stores");
    let embedder = CountQueries {
        flat: Flat::new(),
        calls: AtomicUsize::new(0),
        fail,
    };
    for (namespace, id) in [
        ("first", "11111111-1111-4111-8111-111111111111"),
        ("second", "22222222-2222-4222-8222-222222222222"),
    ] {
        Store::create(
            &base.join(namespace).join("owner"),
            embedder.identity(),
            HASH_DIMENSION,
        )
        .unwrap()
        .upsert(&[row(id, "owner", "agent-private")])
        .unwrap();
    }
    let config = serde_json::from_value(json!({"namespaces":{"activeWriteNamespace":"first",
        "activeRecallNamespaces":["first","second"]}}))
    .unwrap();
    let stores = NamespaceStores::open(&base, &config, embedder.identity(), 4).unwrap();
    let host = TestHost::new(root.path().to_owned());
    let context = context(&host);
    let denials = Denials::default();
    let cancel = Cancel::never();
    let pipeline = pipeline(&context, &embedder, &denials, None, &cancel);
    let request = NamespaceRequest {
        rrf_k: plur1bus_engine::recall::namespace_identity::DEFAULT_RRF_K,
        budget: Default::default(),
        routes: &stores,
        pipeline: &pipeline,
        agent_id: "owner",
        workspace_key: "",
        query: "fixture",
        timestamp_ms: 1,
        ledger: None,
        merge: MergeOptions {
            max_out: 4,
            dedup_enabled: false,
            ..MergeOptions::default()
        },
    };
    for expected_calls in 1..=2 {
        let result = recall(&request);
        if fail {
            assert!(matches!(
                result,
                Err(NamespaceError::Stage(StageError::Embed(
                    EmbedError::Unavailable
                )))
            ));
        } else {
            assert_eq!(result.unwrap().result.memories.len(), 2);
        }
        assert_eq!(
            embedder.calls.load(Ordering::SeqCst),
            expected_calls,
            "the original query must be embedded once per request, including errors"
        );
    }
}

#[test]
fn recall_namespace_denials_reach_the_caller_before_any_reranker() {
    let root = support::canonical_tempdir();
    let host = TestHost::new(root.path().to_owned());
    let context = context(&host);
    let embedder = Flat::new();
    let store = Store::create(
        &root.path().join("data/owner"),
        embedder.identity(),
        HASH_DIMENSION,
    )
    .unwrap();
    let own = row(
        "11111111-1111-4111-8111-111111111111",
        "owner",
        "agent-private",
    );
    let second = row(
        "22222222-2222-4222-8222-222222222222",
        "owner",
        "agent-private",
    );
    let foreign = row(
        "33333333-3333-4333-8333-333333333333",
        "foreign",
        "agent-private",
    );
    store.upsert(&[own, second, foreign]).unwrap();
    let denials = Denials::default();
    let ranker = Ranking::default();
    let cancel = Cancel::never();
    let pipeline = pipeline(&context, &embedder, &denials, Some(&ranker), &cancel);
    let result = pipeline
        .recall(
            Some("active"),
            &store,
            CanonicalSource::Read,
            &RequestQueries::new("fixture"),
        )
        .unwrap();
    assert_eq!(result.memories.len(), 2);
    assert!(denials
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|(id, rule)| id == "33333333-3333-4333-8333-333333333333"
            && rule == "acl.agent_private.mismatch"));
    let calls = ranker.0.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].len(), 2);
    assert!(calls[0].iter().all(|text| !text.contains("foreign")));
}

#[test]
fn recall_namespace_finalisation_keeps_workspace_and_user_ownership_bindings() {
    for scope in ["workspace", "user"] {
        let root = support::canonical_tempdir();
        let host = TestHost::new(root.path().to_owned());
        let context = context(&host);
        let embedder = Flat::new();
        let store = Store::create(
            &root.path().join("data/owner"),
            embedder.identity(),
            HASH_DIMENSION,
        )
        .unwrap();
        let mut own = row("11111111-1111-4111-8111-111111111111", "owner", scope);
        own.workspace_id = context.workspace_key.clone();
        own.owner_user_id = context.owner_user_id.clone();
        store.upsert(&[own]).unwrap();
        let denials = Denials::default();
        let cancel = Cancel::never();
        let result = pipeline(&context, &embedder, &denials, None, &cancel)
            .recall(
                Some("active"),
                &store,
                CanonicalSource::Read,
                &RequestQueries::new("fixture"),
            )
            .unwrap();
        assert_eq!(
            result.memories.len(),
            1,
            "{scope} binding was lost between stages and finalisation"
        );
        assert!(denials.0.lock().unwrap().is_empty());
    }
}

#[test]
fn recall_namespaces_read_canonical_knowledge_only_in_the_first_table() {
    let root = support::canonical_tempdir();
    let base = root.path().join("stores");
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(workspace.join("memory")).unwrap();
    std::fs::write(
        workspace.join("memory/KNOWLEDGE.md"),
        "## Shared knowledge\nSynthetic canonical evidence belongs to the whole workspace.\n",
    )
    .unwrap();
    let embedder = Flat::new();
    for (namespace, id) in [
        ("first", "11111111-1111-4111-8111-111111111111"),
        ("second", "22222222-2222-4222-8222-222222222222"),
    ] {
        let store = Store::create(
            &base.join(namespace).join("owner"),
            embedder.identity(),
            HASH_DIMENSION,
        )
        .unwrap();
        store.upsert(&[row(id, "owner", "agent-private")]).unwrap();
    }
    let config = serde_json::from_value(json!({"namespaces":{"activeWriteNamespace":"first",
        "activeRecallNamespaces":["first","second"]}}))
    .unwrap();
    let stores = NamespaceStores::open(&base, &config, embedder.identity(), 4).unwrap();
    let host = TestHost::new(root.path().to_owned());
    let context = context(&host);
    let denials = Denials::default();
    let cancel = Cancel::never();
    let mut pipeline = pipeline(&context, &embedder, &denials, None, &cancel);
    pipeline.workspace_dir = Some(&workspace);
    pipeline.flags.canonical = true;
    let output = recall(&NamespaceRequest {
        rrf_k: plur1bus_engine::recall::namespace_identity::DEFAULT_RRF_K,
        budget: Default::default(),
        routes: &stores,
        pipeline: &pipeline,
        agent_id: "owner",
        workspace_key: "",
        query: "fixture",
        timestamp_ms: 1,
        ledger: None,
        merge: MergeOptions {
            max_out: 4,
            canonical_max_items: 2,
            dedup_enabled: false,
            ..MergeOptions::default()
        },
    })
    .unwrap();
    assert_eq!(output.result.canonical.len(), 1);
    assert_eq!(
        embedder.1.load(Ordering::SeqCst),
        1,
        "knowledge was embedded once per namespace"
    );
}

#[test]
fn recall_namespace_child_caps_are_deferred_to_the_global_merge() {
    let root = support::canonical_tempdir();
    let host = TestHost::new(root.path().to_owned());
    let context = context(&host);
    let embedder = Flat::new();
    let store = Store::create(
        &root.path().join("data/owner"),
        embedder.identity(),
        HASH_DIMENSION,
    )
    .unwrap();
    store
        .upsert(&[
            row(
                "11111111-1111-4111-8111-111111111111",
                "owner",
                "agent-private",
            ),
            row(
                "22222222-2222-4222-8222-222222222222",
                "owner",
                "agent-private",
            ),
        ])
        .unwrap();
    let denials = Denials::default();
    let cancel = Cancel::never();
    let mut pipeline = pipeline(&context, &embedder, &denials, None, &cancel);
    pipeline.flags.defer_final_cap = false;
    pipeline.limits.candidate_hard_limit = 1;
    pipeline.finalise_limits.defer_final_cap = false;
    pipeline.finalise_limits.candidate_hard_limit = 1.0;
    let result = pipeline
        .recall(
            Some("active"),
            &store,
            CanonicalSource::Read,
            &RequestQueries::new("fixture"),
        )
        .unwrap();
    assert_eq!(
        result.memories.len(),
        2,
        "a child applied the caller cap before the global merge"
    );
}

fn context(host: &TestHost) -> RequestContext {
    let principal: Principal = serde_json::from_value(json!({
        "agentId":"owner","workspace":"workspace:v1:shared","user":principal_key("telegram","default","fixture"),
        "channel":"telegram","accountId":"default","chat":{"id":"fixture","kind":"direct"},"trust":"proved"
    })).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&principal, &agent, host).unwrap()
}

fn row(id: &str, owner: &str, scope: &str) -> MemoryRow {
    let mut row = memory_row(id, owner, scope);
    row.text = format!("Synthetic fixture owned by {owner}, id {id}");
    row.summary = row.text.clone();
    row.vector = vector();
    row.status = "active".to_owned();
    row.epistemic_status = "observed".to_owned();
    row.memory_strength = serde_json::from_value(json!(1)).unwrap();
    row
}

fn pipeline<'a>(
    context: &'a RequestContext,
    embedder: &'a dyn EmbeddingProvider,
    denials: &'a (dyn DenialSink + Sync),
    reranker: Option<&'a dyn Reranker>,
    cancel: &'a Cancel,
) -> Pipeline<'a> {
    Pipeline {
        emotion: None,
        identity_providers: &[],
        context,
        embedder,
        denials,
        reranker,
        workspace_dir: None,
        edges: &[],
        bound_graph: None,
        cancel,
        limits: StageLimits {
            top_n: 4,
            candidate_top_k: 40,
            candidate_hard_limit: 100,
            recall_min_score: 0.15,
            canonical_min_score: 0.3,
            canonical_max_items: 2,
        },
        flags: StageFlags {
            canonical: false,
            associative: false,
            defer_final_cap: true,
            query_refiner: false,
            persist_knowledge: false,
        },
        clocks: StageClocks {
            now_ms: 1,
            temporal_now_ms: 1,
            valid_at: None,
        },
        finalise_limits: FinaliseLimits {
            top_n: 4.0,
            budget: 4.0,
            rerank_candidates: 20.0,
            defer_final_cap: true,
            dedup_enabled: false,
            dedup_jaccard: 0.78,
            candidate_hard_limit: 100.0,
            summary_max_words: 60.0,
            reranker_fallback_on_error: true,
            canonical_count: 0.0,
        },
    }
}

#[derive(Default)]
struct Denials(Mutex<Vec<(String, String)>>);
impl DenialSink for Denials {
    fn denied(&self, id: &str, rule: &'static str, _context: &RequestContext) {
        self.0
            .lock()
            .unwrap()
            .push((id.to_owned(), rule.to_owned()));
    }
}
#[derive(Default)]
struct Ranking(Mutex<Vec<Vec<String>>>);
impl Reranker for Ranking {
    fn empty_result_is_valid(&self) -> bool {
        false
    }
    fn rerank(
        &self,
        _query: &str,
        documents: &[String],
        _top_n: usize,
        _cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        self.0.lock().unwrap().push(documents.to_vec());
        Ok(documents
            .iter()
            .enumerate()
            .map(|(index, _)| serde_json::from_value(json!({"index":index,"score":1.0})).unwrap())
            .collect())
    }
}
struct CountQueries {
    flat: Flat,
    calls: AtomicUsize,
    fail: bool,
}
impl EmbeddingProvider for CountQueries {
    fn identity(&self) -> &plur1bus_engine::contract::VectorSpaceIdentity {
        self.flat.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        if kind == EmbedKind::Query {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(EmbedError::Unavailable);
            }
        }
        self.flat.embed(texts, kind, cancel)
    }
}

struct Flat(HashEmbedder, AtomicUsize);
impl Flat {
    fn new() -> Self {
        Self(HashEmbedder::new(), AtomicUsize::new(0))
    }
}
impl EmbeddingProvider for Flat {
    fn identity(&self) -> &plur1bus_engine::contract::VectorSpaceIdentity {
        self.0.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        if kind == EmbedKind::Passage {
            self.1.fetch_add(texts.len(), Ordering::SeqCst);
        }
        Ok(texts.iter().map(|_| vector()).collect())
    }
}
fn vector() -> Vec<f32> {
    let mut vector = vec![0.0; HASH_DIMENSION];
    vector[0] = 1.0;
    vector
}

#[path = "support/recall_bound_graph.rs"]
mod bound_graph;
