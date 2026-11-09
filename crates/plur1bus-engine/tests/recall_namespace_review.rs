//! Regression tests for the requested changes on PR #850.
#![allow(
    clippy::unwrap_used,
    reason = "synthetic parity fixtures stop on failure"
)]
#[path = "recall_support.rs"]
mod support;

use plur1bus_engine::context::RequestContext;
use plur1bus_engine::contract::StoreError;
use plur1bus_engine::contract::{AgentContext, Principal, VectorSpaceIdentity};
use plur1bus_engine::embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider};
use plur1bus_engine::recall::acl::DenialSink;
use plur1bus_engine::recall::finalise::FinaliseLimits;
use plur1bus_engine::recall::hash_embed::{HashEmbedder, HASH_DIMENSION};
use plur1bus_engine::recall::merge::MergeOptions;
use plur1bus_engine::recall::namespace_pipeline::Pipeline;
use plur1bus_engine::recall::namespace_query::RequestQueries;
use plur1bus_engine::recall::namespaces::{
    recall, CanonicalSource, NamespaceError, NamespaceOutput, NamespaceRequest, NamespaceStores,
    TableRecall,
};
use plur1bus_engine::recall::stages::{StageClocks, StageError, StageFlags, StageLimits};
use plur1bus_engine::store::ledger::JsonlLedger;
use plur1bus_engine::store::ledger_types::RetrievalLedgerLine;
use plur1bus_engine::store::{Store, StoreIdentityResolver};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use support::{memory_row, TestHost};

#[test]
fn recorder_refuses_an_unpinned_source_before_import() {
    let root = support::canonical_tempdir();
    let module = root.path().join("engine/recall/namespace-recall.js");
    std::fs::create_dir_all(module.parent().unwrap()).unwrap();
    std::fs::write(module, "throw new Error('untrusted module executed');\n").unwrap();
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/recall/record.mjs");
    let output = std::process::Command::new("node")
        .arg(script)
        .arg("--namespaces")
        .arg(root.path())
        .env("PLUR1BUS_ENGINE_SRC", root.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains("immutable runtime source mismatch: engine/recall/namespace-recall.js"));
    assert!(!error.contains("untrusted module executed"));
}

#[test]
fn retrieval_record_has_the_typed_nullable_node_envelope() {
    use plur1bus_engine::store::state_file::JsonRecord;
    use plur1bus_engine::text::json::parse_json;
    let (_, raw) = fixture(1, None).unwrap();
    let line = RetrievalLedgerLine::from_json(parse_json(&raw).unwrap()).unwrap();
    assert!(line.id.is_some());
    assert_eq!(line.workspace_key, Some(None));
    assert!(line.query_hash.as_ref().unwrap().is_some());
    assert_eq!(line.timestamp.unwrap().as_i64(), Some(1));
}

#[test]
fn nullable_retrieval_envelope_and_idless_selection_match_node_bytes() {
    use plur1bus_engine::store::state_file::JsonRecord;
    use plur1bus_engine::text::js::JsString;
    use plur1bus_engine::text::json::write_json;
    let golden = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/recall/golden/namespaces/namespaces-merge-keeps-reranker-order.json");
    let recorded: Value = serde_json::from_slice(&std::fs::read(golden).unwrap()).unwrap();
    let line = RetrievalLedgerLine::selected(
        JsString::from("__UUID__"),
        None,
        None,
        None,
        vec![None, Some(JsString::from("kept"))],
        1_798_761_600_000,
    );
    assert_eq!(
        format!("{}\n", write_json(&line.to_json().unwrap())),
        recorded["nullableLedgerLine"].as_str().unwrap()
    );
}

#[test]
fn merged_recall_applies_the_default_budget_before_persisting() {
    let (output, line) = fixture(13, None).unwrap();
    assert_eq!(output.result.memories.len(), 12);
    let recorded: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(recorded["resultsCount"], 12);
    assert_eq!(recorded["selectedIds"].as_array().unwrap().len(), 12);
}

#[test]
fn foreign_identity_with_equal_width_never_uses_the_active_query_vector() {
    let (output, line) = fixture(1, Some(HASH_DIMENSION)).unwrap();
    assert_eq!(output.result.memories.len(), 1);
    assert!(!line.contains("ffffffff-ffff-4fff-8fff-ffffffffffff"));
}

#[test]
fn foreign_identity_with_different_width_degrades_instead_of_rejecting() {
    let (output, line) = fixture(1, Some(HASH_DIMENSION / 2)).unwrap();
    assert_eq!(output.result.memories.len(), 1);
    assert!(!line.contains("ffffffff-ffff-4fff-8fff-ffffffffffff"));
}

#[test]
fn namespace_entries_use_the_node_projection_without_vectors() {
    let (output, _) = fixture(1, None).unwrap();
    let entry = &output.result.memories[0]["entry"];
    assert!(entry.get("vector").is_none());
    assert_eq!(entry["origin"], "dm");
    assert_eq!(entry["emotionalDominant"], "neutral");
    assert_eq!(entry["memoryClass"], "standard");
}

#[test]
fn a_real_child_store_read_failure_settles_siblings_and_writes_no_ledger() {
    assert!(matches!(
        fixture_with_fault(1, None, ReadFault::ReplaceLegacyAgent),
        Err(NamespaceError::Stage(StageError::Store(
            StoreError::UntrustedPath
        )))
    ));
}

#[test]
fn unconfigured_foreign_legacy_identity_rejects_all_memories_at_both_widths() {
    for width in [HASH_DIMENSION, HASH_DIMENSION / 2] {
        assert!(matches!(
            fixture_with_fault(1, Some(width), ReadFault::None),
            Err(NamespaceError::Store(StoreError::IdentityMismatch))
        ));
    }
}

#[derive(Clone, Copy)]
enum ReadFault {
    None,
    ReplaceLegacyAgent,
}

fn fixture(
    count: usize,
    foreign_width: Option<usize>,
) -> Result<(NamespaceOutput, String), NamespaceError> {
    fixture_with_routes(count, foreign_width, ReadFault::None, true)
}

fn fixture_with_fault(
    count: usize,
    foreign_width: Option<usize>,
    fault: ReadFault,
) -> Result<(NamespaceOutput, String), NamespaceError> {
    fixture_with_routes(count, foreign_width, fault, false)
}

fn fixture_with_routes(
    count: usize,
    foreign_width: Option<usize>,
    fault: ReadFault,
    configured_legacy: bool,
) -> Result<(NamespaceOutput, String), NamespaceError> {
    let root = support::canonical_tempdir();
    let base = root.path().join("stores");
    let embedder = Flat(HashEmbedder::new());
    let store = Store::create(
        &base.join("active/owner"),
        embedder.identity(),
        HASH_DIMENSION,
    )
    .unwrap();
    for index in 1..=count {
        let id = format!("{index:08x}-0000-4000-8000-000000000000");
        seed(&store, &id, HASH_DIMENSION);
    }
    if let Some(width) =
        foreign_width.or(matches!(fault, ReadFault::ReplaceLegacyAgent).then_some(HASH_DIMENSION))
    {
        let mut identity = serde_json::to_value(embedder.identity()).unwrap();
        if foreign_width.is_some() {
            identity["model"] = json!("synthetic-foreign-model");
        }
        identity["dimension"] = json!(width);
        let identity: VectorSpaceIdentity = serde_json::from_value(identity).unwrap();
        let legacy = Store::create(&base.join("legacy/owner"), &identity, width).unwrap();
        seed(&legacy, "ffffffff-ffff-4fff-8fff-ffffffffffff", width);
    }
    let config = serde_json::from_value(json!({"namespaces":{
        "activeWriteNamespace":"active", "activeRecallNamespaces":["active"],
        "legacyReadOnlyNamespaces":["legacy"], "crossNamespaceRecall":true
    }}))
    .unwrap();
    let routes = if configured_legacy && foreign_width.is_some() {
        let legacy = Store::open(
            &base.join("legacy/owner"),
            plur1bus_engine::store::OpenMode::ReadOnly,
            None,
        )
        .unwrap();
        NamespaceStores::open_with_identity_resolver(
            &base,
            &config,
            embedder.identity(),
            Arc::new(ReviewIdentities {
                active: embedder.identity().clone(),
                legacy: legacy.identity().unwrap().clone(),
            }),
            4,
        )
        .unwrap()
    } else {
        NamespaceStores::open(&base, &config, embedder.identity(), 4).unwrap()
    };
    let host = TestHost::new(root.path().to_owned());
    let principal: Principal = serde_json::from_value(json!({
        "agentId":"owner", "workspace":"workspace:v1:fixture", "channel":"", "accountId":"",
        "chat":{"id":"fixture","kind":"direct"},"trust":"inferred"
    }))
    .unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let context = RequestContext::build(&principal, &agent, &host).unwrap();
    let cancel = Cancel::never();
    let pipeline = Pipeline {
        emotion: None,
        identity_providers: &[],
        context: &context,
        denials: &Discard,
        embedder: &embedder,
        reranker: None,
        workspace_dir: None,
        edges: &[],
        bound_graph: None,
        cancel: &cancel,
        limits: StageLimits {
            top_n: 20,
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
            top_n: 20.0,
            budget: 12.0,
            rerank_candidates: 20.0,
            defer_final_cap: true,
            dedup_enabled: false,
            dedup_jaccard: 0.78,
            candidate_hard_limit: 100.0,
            summary_max_words: 60.0,
            reranker_fallback_on_error: true,
            canonical_count: 0.0,
        },
    };
    let path = root.path().join("retrieval.jsonl");
    let ledger = JsonlLedger::<RetrievalLedgerLine>::open(&path).unwrap();
    let completed = AtomicBool::new(false);
    let failing = base.join("legacy/owner");
    let pipeline = FaultingPipeline {
        pipeline,
        completed: &completed,
        failing: matches!(fault, ReadFault::ReplaceLegacyAgent).then_some(failing.as_path()),
    };
    let result = recall(&NamespaceRequest {
        rrf_k: plur1bus_engine::recall::namespace_identity::DEFAULT_RRF_K,
        budget: Default::default(),
        routes: &routes,
        pipeline: &pipeline,
        agent_id: "owner",
        workspace_key: "",
        query: "fixture",
        timestamp_ms: 1,
        ledger: Some(&ledger),
        merge: MergeOptions {
            max_out: 20,
            dedup_enabled: false,
            ..MergeOptions::default()
        },
    });
    if matches!(
        &result,
        Err(NamespaceError::Store(StoreError::IdentityMismatch))
    ) {
        assert!(
            !completed.load(Ordering::SeqCst),
            "identity mismatch started a child pipeline"
        );
        assert!(std::fs::read_to_string(&path)
            .unwrap_or_default()
            .is_empty());
    }
    if matches!(fault, ReadFault::ReplaceLegacyAgent) {
        assert!(
            completed.load(Ordering::SeqCst),
            "a real sibling read was left unfinished"
        );
        assert!(std::fs::read_to_string(&path)
            .unwrap_or_default()
            .is_empty());
    }
    Ok((result?, std::fs::read_to_string(path).unwrap()))
}

fn seed(store: &Store, id: &str, width: usize) {
    let mut row = serde_json::to_value(memory_row(id, "owner", "agent-private")).unwrap();
    row["vector"] = json!(vector(width));
    row["text"] = json!(format!("Synthetic namespace review fixture {id}"));
    row["summary"] = row["text"].clone();
    row["origin"] = json!("");
    row["emotionalDominant"] = json!("");
    row["memoryClass"] = json!("");
    row["status"] = json!("active");
    row["epistemicStatus"] = json!("observed");
    row["memoryStrength"] = json!(1);
    store
        .upsert(&[serde_json::from_value(row).unwrap()])
        .unwrap();
}

struct Discard;
impl DenialSink for Discard {
    fn denied(&self, _: &str, _: &'static str, _: &RequestContext) {}
}
struct Flat(HashEmbedder);
impl EmbeddingProvider for Flat {
    fn identity(&self) -> &VectorSpaceIdentity {
        self.0.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        Ok(texts.iter().map(|_| vector(HASH_DIMENSION)).collect())
    }
}
fn vector(width: usize) -> Vec<f32> {
    let mut vector = vec![0.0; width];
    vector[0] = 1.0;
    vector
}

struct FaultingPipeline<'a> {
    pipeline: Pipeline<'a>,
    completed: &'a AtomicBool,
    failing: Option<&'a std::path::Path>,
}
impl TableRecall for FaultingPipeline<'_> {
    fn recall(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
    ) -> Result<plur1bus_engine::recall::merge::NamespaceResult, NamespaceError> {
        let result = if let (Some("legacy"), Some(original)) = (namespace, self.failing) {
            let held = original.with_file_name("owner-held");
            std::fs::rename(original, &held).unwrap();
            std::fs::create_dir(original).unwrap();
            let outcome = self.pipeline.recall(namespace, store, canonical, queries);
            std::fs::remove_dir(original).unwrap();
            std::fs::rename(held, original).unwrap();
            outcome
        } else {
            self.pipeline.recall(namespace, store, canonical, queries)
        };
        if namespace == Some("active") {
            self.completed.store(true, Ordering::SeqCst);
        }
        result
    }
}

struct ReviewIdentities {
    active: VectorSpaceIdentity,
    legacy: VectorSpaceIdentity,
}
impl StoreIdentityResolver for ReviewIdentities {
    fn expected_identity(
        &self,
        namespace: Option<&str>,
        agent: &str,
    ) -> Result<VectorSpaceIdentity, StoreError> {
        Ok(if namespace == Some("legacy") && agent == "owner" {
            self.legacy.clone()
        } else {
            self.active.clone()
        })
    }
}

#[test]
fn expected_identity_is_resolved_for_each_agent_on_a_legacy_route() {
    use plur1bus_engine::store::StoreRoutes;
    let root = support::canonical_tempdir();
    let active = HashEmbedder::new().identity().clone();
    let mut legacy = active.clone();
    legacy.model = "synthetic-old-profile".into();
    Store::create(&root.path().join("legacy/owner"), &legacy, HASH_DIMENSION).unwrap();
    Store::create(&root.path().join("legacy/other"), &active, HASH_DIMENSION).unwrap();
    let config = serde_json::from_value(json!({"namespaces":{
        "activeWriteNamespace":"active", "activeRecallNamespaces":["active"],
        "legacyReadOnlyNamespaces":["legacy"], "crossNamespaceRecall":true
    }}))
    .unwrap();
    let routes = NamespaceStores::open_with_identity_resolver(
        root.path(),
        &config,
        &active,
        Arc::new(ReviewIdentities {
            active: active.clone(),
            legacy: legacy.clone(),
        }),
        4,
    )
    .unwrap();
    let reads = routes.read_routes().unwrap();
    let route = reads
        .iter()
        .find(|r| r.namespace.as_deref() == Some("legacy"))
        .unwrap();
    let identity_id = plur1bus_engine::embedding::identity::try_identity_id;
    assert_eq!(
        identity_id(route.lease("owner").unwrap().unwrap().identity().unwrap()).unwrap(),
        identity_id(&legacy).unwrap()
    );
    assert_eq!(
        identity_id(route.lease("other").unwrap().unwrap().identity().unwrap()).unwrap(),
        identity_id(&active).unwrap()
    );
}
