//! Cooperative deadlines through real Lance search, canonical embeddings and namespace stages.
#![allow(clippy::unwrap_used, reason = "contract fixtures fail immediately")]
#[path = "recall_support.rs"]
mod support;

use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal, VectorSpaceIdentity},
    embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider},
    recall::{
        acl::DenialSink,
        budget::RecallBudget,
        control::{RecallControl, Stop},
        hash_embed::HashEmbedder,
        knowledge::cached_chunk_count,
        namespace_trace::TraceLimits,
        stages::{run_controlled_stage_7, StageClocks, StageFlags, StageInput, StageLimits},
    },
    store::Store,
};
use serde_json::json;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

struct Sink;
impl DenialSink for Sink {
    fn denied(&self, _: &str, _: &str, _: &RequestContext) {}
}

struct Provider {
    hash: HashEmbedder,
    calls: AtomicUsize,
    slow_passage: bool,
}
impl EmbeddingProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        self.hash.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(
            cancel.remaining().is_some(),
            "all stages must receive the request deadline"
        );
        if self.slow_passage && kind == EmbedKind::Passage {
            // Cooperative fake waits only for its injected bounded request token.
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        cancel.check().map_err(EmbedError::Cancelled)?;
        self.hash.embed(texts, kind, cancel)
    }
}

struct Fixture {
    root: tempfile::TempDir,
    store: std::sync::Arc<Store>,
    routes: plur1bus_engine::recall::namespaces::NamespaceStores,
    context: RequestContext,
    provider: Provider,
}
impl Fixture {
    fn new(slow_passage: bool) -> Self {
        Self::with_config(slow_passage, json!({}))
    }

    fn with_config(slow_passage: bool, config: serde_json::Value) -> Self {
        let root = support::canonical_tempdir();
        let hash = HashEmbedder::new();
        let routes = plur1bus_engine::recall::namespaces::NamespaceStores::open(
            &root.path().join("stores"),
            &serde_json::from_value(config).unwrap(),
            hash.identity(),
            4,
        )
        .unwrap();
        let store = routes.write_store("agent").unwrap();
        let mut row = support::memory_row("visible", "agent", "agent-private");
        row.vector = hash
            .embed(
                &["fixture query".into()],
                EmbedKind::Query,
                &Cancel::never(),
            )
            .unwrap()
            .remove(0);
        row.status = "active".into();
        row.memory_strength = serde_json::Number::from_f64(1.0).unwrap();
        store.upsert(&[row]).unwrap();
        std::fs::create_dir(root.path().join("memory")).unwrap();
        std::fs::write(
            root.path().join("memory/KNOWLEDGE.md"),
            "# Fixture\nSynthetic knowledge with enough text to form one section.\n",
        )
        .unwrap();
        let principal: Principal = serde_json::from_value(json!({"agentId":"agent","workspace":"workspace:v1:agent-private","channel":"","accountId":"","chat":{"id":"1","kind":"direct"},"trust":"inferred"})).unwrap();
        let agent: AgentContext =
            serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
        let context = RequestContext::build(
            &principal,
            &agent,
            &support::TestHost::new(root.path().to_owned()),
        )
        .unwrap();
        Self {
            root,
            store,
            routes,
            context,
            provider: Provider {
                hash,
                calls: AtomicUsize::new(0),
                slow_passage,
            },
        }
    }

    fn input(&self) -> StageInput<'_> {
        StageInput {
            query: "fixture query",
            store: &self.store,
            embedder: &self.provider,
            context: &self.context,
            workspace_dir: Some(self.root.path()),
            edges: &[],
            limits: StageLimits {
                top_n: 12,
                candidate_top_k: 40,
                candidate_hard_limit: 100,
                recall_min_score: 0.15,
                canonical_min_score: -1.0,
                canonical_max_items: 5,
            },
            flags: StageFlags {
                canonical: true,
                associative: false,
                defer_final_cap: true,
                query_refiner: false,
                persist_knowledge: true,
            },
            clocks: StageClocks {
                now_ms: 0,
                temporal_now_ms: 0,
                valid_at: None,
            },
        }
    }
}

fn budget(soft: f64, hard: f64) -> RecallBudget {
    RecallBudget {
        soft_ms: soft,
        hard_ms: hard,
        cap_chars: 17000.0,
    }
}

#[test]
fn hard_timeout_preserves_authorized_hits_and_prevents_failed_cache_persistence() {
    let fixture = Fixture::new(true);
    let mut control = RecallControl::new(Instant::now(), budget(10000.0, 500.0), &Cancel::never());
    let snapshot = run_controlled_stage_7(
        &fixture.input(),
        &Sink,
        Some(TraceLimits::default()),
        None,
        &mut control,
    )
    .unwrap();
    assert_eq!(control.stopped(), Some(Stop::Timeout));
    assert_eq!(snapshot.ordered_ids, ["visible"]);
    assert!(snapshot.canonical.is_empty());
    assert_eq!(cached_chunk_count(fixture.root.path()), None);
    assert_eq!(fixture.provider.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn caller_cancel_prevents_all_provider_calls() {
    let fixture = Fixture::new(false);
    let caller = Cancel::never();
    caller.cancel();
    let mut control = RecallControl::new(Instant::now(), budget(1000.0, 2000.0), &caller);
    let snapshot =
        run_controlled_stage_7(&fixture.input(), &Sink, None, None, &mut control).unwrap();
    assert_eq!(control.stopped(), Some(Stop::Aborted));
    assert!(snapshot.hydrated.is_empty());
    assert_eq!(fixture.provider.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn soft_ms_switches_to_the_fast_path_and_is_traced() {
    let fixture = Fixture::new(false);
    let mut control = RecallControl::new(
        Instant::now() - Duration::from_millis(10),
        budget(1.0, 5000.0),
        &Cancel::never(),
    );
    let snapshot = run_controlled_stage_7(
        &fixture.input(),
        &Sink,
        Some(TraceLimits::default()),
        None,
        &mut control,
    )
    .unwrap();
    assert_eq!(control.stopped(), Some(Stop::SoftBudget));
    assert_eq!(snapshot.ordered_ids, ["visible"]);
    assert!(snapshot
        .trace
        .guards
        .iter()
        .any(|guard| guard["name"] == "soft-budget"
            && guard["phaseSummary"]["exceededBudget"] == true));
    assert_eq!(fixture.provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        control
            .timer
            .completed()
            .iter()
            .map(|phase| phase.name)
            .collect::<Vec<_>>(),
        ["embedding", "vector_search"]
    );
}

#[test]
fn each_namespace_gets_its_own_stage_clock() {
    let fixture = Fixture::new(false);
    let started = Instant::now();
    for _ in 0..2 {
        let mut control = RecallControl::new(started, budget(5000.0, 10000.0), &Cancel::never());
        run_controlled_stage_7(&fixture.input(), &Sink, None, None, &mut control).unwrap();
        assert_eq!(
            control
                .timer
                .completed()
                .iter()
                .map(|phase| phase.name)
                .collect::<Vec<_>>(),
            [
                "embedding",
                "vector_search",
                "query_refinement",
                "temporal",
                "canonical",
                "scoring",
                "graph",
                "graph_hydration"
            ]
        );
        assert_eq!(control.stopped(), None);
    }
}

struct EmptyNeo;
impl plur1bus_engine::recall::neo_prelude::NeoPrelude for EmptyNeo {
    fn read(
        &self,
        _: &plur1bus_engine::recall::neo_prelude::NeoRequest<'_>,
    ) -> Result<plur1bus_engine::text::js::JsString, plur1bus_engine::recall::render::RenderError>
    {
        Ok("".into())
    }
}

impl Fixture {
    fn request<'a>(
        &'a self,
        caller: &'a Cancel,
    ) -> plur1bus_engine::recall::runtime::RuntimeRequest<'a> {
        use plur1bus_engine::recall::{
            acl::AclSubject, finalise::FinaliseLimits, namespace_pipeline::Pipeline,
            render::RenderRequest, runtime::RuntimeRequest,
        };
        let input = self.input();
        let mut render = RenderRequest::new(AclSubject::from_context(&self.context), 0.0);
        render.prompt = input.query.into();
        render.trace_enabled = true;
        RuntimeRequest {
            pipeline: Pipeline {
                emotion: None,
                identity_providers: &[],
                context: &self.context,
                denials: &Sink,
                embedder: &self.provider,
                reranker: None,
                workspace_dir: input.workspace_dir,
                edges: &[],
                cancel: caller,
                limits: input.limits,
                flags: input.flags,
                clocks: input.clocks,
                finalise_limits: FinaliseLimits {
                    top_n: 12.0,
                    budget: 12.0,
                    rerank_candidates: 100.0,
                    defer_final_cap: true,
                    dedup_enabled: true,
                    dedup_jaccard: 0.78,
                    candidate_hard_limit: 100.0,
                    summary_max_words: 150.0,
                    reranker_fallback_on_error: true,
                    canonical_count: 0.0,
                },
            },
            routes: &self.routes,
            render,
            filter: None,
            started: Instant::now(),
            budget_overrides: json!({"softMs":5000,"hardMs":10000}),
            known_secrets: &[],
            ledger: None,
            neo: &EmptyNeo,
            reranker_requested: true,
        }
    }
}

#[test]
fn an_overrun_of_hard_ms_answers_degraded_timeout_with_the_blocks_on_hand() {
    let fixture = Fixture::new(true);
    let caller = Cancel::never();
    let mut request = fixture.request(&caller);
    request.budget_overrides = json!({"softMs":10000,"hardMs":500});
    let result = plur1bus_engine::recall::runtime::run(request).unwrap();
    let wire: serde_json::Value = serde_json::from_str(&result.to_json_line().unwrap()).unwrap();
    assert_eq!(
        wire["degraded"],
        json!({"reason":"timeout","capability":"recall"})
    );
    assert!(result
        .rendered
        .blocks
        .iter()
        .any(|block| block.name == "memories" && block.text.to_utf8_lossy().contains("note")));
    assert_eq!(result.rendered.effects, Default::default());
    assert_eq!(cached_chunk_count(fixture.root.path()), None);
    assert!(wire["timing"]["totalMs"].as_f64().unwrap() >= 500.0);
}

#[test]
fn a_caller_cancel_answers_degraded_aborted() {
    let fixture = Fixture::new(false);
    let caller = Cancel::never();
    caller.cancel();
    let result = plur1bus_engine::recall::runtime::run(fixture.request(&caller)).unwrap();
    let wire: serde_json::Value = serde_json::from_str(&result.to_json_line().unwrap()).unwrap();
    assert_eq!(
        wire["degraded"],
        json!({"reason":"aborted","capability":"recall"})
    );
    assert_eq!(wire["blocks"], json!([]));
    assert_eq!(fixture.provider.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn no_reranker_configured_yields_the_reranker_not_configured_diagnostic() {
    let fixture = Fixture::new(false);
    let caller = Cancel::never();
    let result = plur1bus_engine::recall::runtime::run(fixture.request(&caller)).unwrap();
    let wire = result.to_json_line().unwrap();
    let _: plur1bus_engine::contract::RecallResult = serde_json::from_str(&wire).unwrap();
    let wire: serde_json::Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(
        wire["diagnostics"],
        json!([{"feature":"reranker","reason":"reranker-not-configured","fallback":"unreranked"}])
    );
    assert!(wire["degraded"].is_null());
    let mut off = fixture.request(&caller);
    off.reranker_requested = false;
    assert!(plur1bus_engine::recall::runtime::run(off)
        .unwrap()
        .diagnostics
        .is_empty());
}

#[test]
fn timing_has_one_phase_per_stage_and_namespace_phases_per_table() {
    let fixture = Fixture::with_config(
        false,
        json!({"namespaces":{"activeWriteNamespace":"a","activeRecallNamespaces":["a","b"],"legacyReadOnlyNamespaces":[]}}),
    );
    let result = plur1bus_engine::recall::runtime::run(fixture.request(&Cancel::never())).unwrap();
    let phases = result.timing["namespacePhases"].as_array().unwrap();
    for namespace in ["a", "b"] {
        let phases = phases
            .iter()
            .filter(|phase| phase["namespace"] == namespace)
            .collect::<Vec<_>>();
        assert_eq!(
            phases
                .iter()
                .map(|phase| phase["phase"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "embedding",
                "vector_search",
                "query_refinement",
                "temporal",
                "canonical",
                "scoring",
                "graph",
                "graph_hydration",
                "rerank",
                "budget",
                "dedup",
                "acl",
                "finalize"
            ]
        );
        assert!(phases
            .iter()
            .all(|phase| phase["ms"].as_f64().unwrap() >= 0.0));
    }
}

#[test]
fn trace_never_contains_a_secret_marker_from_a_recalled_memory() {
    use plur1bus_engine::text::json::write_json;
    let fixture = Fixture::new(false);
    let source: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/recall/golden/runtime-trace.json")).unwrap();
    let markers = source["markers"].as_array().unwrap();
    let secrets = markers
        .iter()
        .map(|marker| marker["marker"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let forms = markers
        .iter()
        .flat_map(|marker| marker["forms"].as_array().unwrap())
        .map(|form| form.as_str().unwrap())
        .collect::<Vec<_>>();
    let mut row = fixture.store.get("visible").unwrap().unwrap();
    row.text = forms.join(" | ");
    fixture.store.upsert(&[row]).unwrap();
    let caller = Cancel::never();
    for cap in [1, 12, 160, 10000] {
        let mut request = fixture.request(&caller);
        request.known_secrets = &secrets;
        request.render.config = json!({"recall":{"trace":{"maxTextPreviewChars":cap}}});
        let result = plur1bus_engine::recall::runtime::run(request).unwrap();
        let trace = write_json(result.trace.as_ref().unwrap());
        for form in &forms {
            assert!(!trace.contains(form), "marker leaked at cap {cap}");
        }
        assert!(
            !trace.contains("redact-probe-"),
            "marker prefix leaked at cap {cap}"
        );
    }
}

#[test]
fn disabling_soft_fallback_runs_optional_stages_with_the_original_hard_limit() {
    let fixture = Fixture::new(false);
    let caller = Cancel::never();
    let mut request = fixture.request(&caller);
    request.started = Instant::now() - Duration::from_millis(10);
    request.budget_overrides = json!({"softMs":1,"hardMs":5000});
    request.render.config = json!({"recall":{"softBudgetFallback":false}});
    let result = plur1bus_engine::recall::runtime::run(request).unwrap();
    assert!(result.degraded.is_none());
    assert_eq!(fixture.provider.calls.load(Ordering::SeqCst), 2);
    assert!(result.timing["namespacePhases"]
        .as_array()
        .unwrap()
        .iter()
        .any(|phase| phase["phase"] == "canonical"));
}

struct AbortRanker {
    caller: Cancel,
    calls: AtomicUsize,
}
impl plur1bus_engine::embedding::Reranker for AbortRanker {
    fn rerank(
        &self,
        _: &str,
        _: &[String],
        _: usize,
        cancel: &Cancel,
    ) -> Result<Vec<plur1bus_engine::contract::RerankHit>, plur1bus_engine::embedding::RerankError>
    {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.caller.cancel();
        Err(plur1bus_engine::embedding::RerankError::Cancelled(
            cancel.check().unwrap_err(),
        ))
    }
    fn empty_result_is_valid(&self) -> bool {
        false
    }
}

#[test]
fn cancellation_inside_reranker_returns_partial_rows_without_retry_or_ledger_write() {
    use plur1bus_engine::store::{ledger::JsonlLedger, ledger_types::RetrievalLedgerLine};
    let fixture = Fixture::new(false);
    let mut row = fixture.store.get("visible").unwrap().unwrap();
    row.id = "second".into();
    row.text = "independent second memory".into();
    fixture.store.upsert(&[row]).unwrap();
    let path = fixture.root.path().join("retrieval.jsonl");
    let ledger = JsonlLedger::<RetrievalLedgerLine>::open(&path).unwrap();
    let caller = Cancel::never();
    let ranker = AbortRanker {
        caller: caller.clone(),
        calls: AtomicUsize::new(0),
    };
    let mut request = fixture.request(&caller);
    request.pipeline.reranker = Some(&ranker);
    request.pipeline.finalise_limits.reranker_fallback_on_error = false;
    request.ledger = Some(&ledger);
    let result = plur1bus_engine::recall::runtime::run(request).unwrap();
    assert_eq!(
        result.degraded,
        Some(json!({"reason":"aborted","capability":"recall"}))
    );
    assert!(!result.rendered.blocks.is_empty());
    assert_eq!(ranker.calls.load(Ordering::SeqCst), 1);
    assert!(
        !path.exists(),
        "cancelled recall must not create a lazy ledger"
    );
}

#[test]
fn canonical_ids_stay_consistent_after_candidate_and_global_canonical_caps() {
    let fixture = Fixture::new(false);
    let first = format!("{}😀 remainder", "a".repeat(39));
    let second = format!("{}😀 remainder", "b".repeat(39));
    std::fs::write(fixture.root.path().join("memory/KNOWLEDGE.md"), format!("# {first}\nSynthetic first section long enough to embed.\n# {second}\nSynthetic second section long enough to embed.\n")).unwrap();
    let caller = Cancel::never();
    let mut request = fixture.request(&caller);
    request.render.config = json!({"recall":{"canonicalMaxItems":0,"trace":{"maxCandidates":1,"maxTextPreviewChars":2}}});
    let result = plur1bus_engine::recall::runtime::run(request).unwrap();
    let wire = plur1bus_engine::text::json::write_json(result.trace.as_ref().unwrap());
    assert!(!wire.contains('�'));
    assert!(!wire.contains("\\ud83d"));
    let trace: serde_json::Value = serde_json::from_str(&wire).unwrap();
    for prefix in ["a", "b"] {
        let expected = format!("canonical:{}…", prefix.repeat(39));
        assert_eq!(
            trace["decisions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["memoryId"] == expected)
                .count(),
            2,
            "child inclusion and global cap refer to the same diagnostic ID"
        );
    }
    assert!(result.to_contract().is_ok());
    assert!(!wire.contains("_traceCanonicalId"));
}

struct AbortFilter(Cancel);
impl plur1bus_engine::recall::filter::CandidateFilter for AbortFilter {
    fn select(
        &self,
        _: &str,
        documents: &[String],
        _: &Cancel,
    ) -> plur1bus_engine::recall::filter::FilterOutcome {
        self.0.cancel();
        plur1bus_engine::recall::filter::FilterOutcome {
            indices: (0..documents.len()).collect(),
            fallback: Some("timeout".into()),
            evaluated: None,
            removed: None,
        }
    }
}

#[test]
fn cancellation_inside_filter_does_not_dispatch_the_reranker() {
    let fixture = Fixture::new(false);
    let mut row = fixture.store.get("visible").unwrap().unwrap();
    row.id = "second".into();
    row.text = "independent second memory".into();
    fixture.store.upsert(&[row]).unwrap();
    let caller = Cancel::never();
    let ranker = AbortRanker {
        caller: caller.clone(),
        calls: AtomicUsize::new(0),
    };
    let filter = AbortFilter(caller.clone());
    let mut request = fixture.request(&caller);
    request.pipeline.reranker = Some(&ranker);
    request.filter = Some(&filter);
    let result = plur1bus_engine::recall::runtime::run(request).unwrap();
    assert_eq!(
        result.degraded,
        Some(json!({"reason":"aborted","capability":"recall"}))
    );
    assert_eq!(ranker.calls.load(Ordering::SeqCst), 0);
}
