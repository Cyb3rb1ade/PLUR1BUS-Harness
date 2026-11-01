//! Actual Node namespace-runtime recordings, including byte-exact retrieval JSONL.
#![allow(
    clippy::unwrap_used,
    reason = "recorded parity failures stop the fixture"
)]
#[path = "recall_support.rs"]
mod support;

use std::fs::{self, File, FileTimes};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use plur1bus_engine::context::RequestContext;
use plur1bus_engine::contract::{AgentContext, Principal, RerankHit, VectorSpaceIdentity};
use plur1bus_engine::embedding::{
    Cancel, EmbedError, EmbedKind, EmbeddingProvider, RerankError, Reranker,
};
use plur1bus_engine::recall::acl::DenialSink;
use plur1bus_engine::recall::finalise::FinaliseLimits;
use plur1bus_engine::recall::graph::GraphEdge;
use plur1bus_engine::recall::merge::MergeOptions;
use plur1bus_engine::recall::namespace_budget::MergedBudget;
use plur1bus_engine::recall::namespace_pipeline::Pipeline;
use plur1bus_engine::recall::namespaces::{recall, NamespaceRequest, NamespaceStores};
use plur1bus_engine::recall::stages::{StageClocks, StageFlags, StageLimits};
use plur1bus_engine::store::ledger::JsonlLedger;
use plur1bus_engine::store::ledger_types::RetrievalLedgerLine;
use plur1bus_engine::store::Store;
use serde_json::{json, Value};
use support::{memory_row, TestHost};

macro_rules! runtime_case {
    ($test:ident, $name:literal) => {
        #[test]
        fn $test() {
            assert_runtime($name);
        }
    };
}
runtime_case!(
    absent_budget_object_uses_twelve,
    "namespaces-budget-default-object-absent"
);
runtime_case!(
    enabled_merged_tiers_match_node,
    "namespaces-budget-enabled-tiers"
);
runtime_case!(
    absent_budget_object_still_applies_tiers,
    "namespaces-budget-object-absent-tiers"
);
runtime_case!(
    canonical_graph_and_dedupe_match_node,
    "namespaces-canonical-graph-dedupe"
);
runtime_case!(
    runtime_rerank_then_merge_matches_node,
    "namespaces-runtime-rerank"
);
runtime_case!(
    equal_width_missing_provider_matches_node,
    "namespaces-foreign-identity-unavailable-384"
);
runtime_case!(
    different_width_missing_provider_matches_node,
    "namespaces-foreign-identity-unavailable-192"
);
runtime_case!(
    available_identity_providers_and_fusion_match_node,
    "namespaces-foreign-identities-available"
);

runtime_case!(
    graph_endpoint_acl_observation_order_matches_node,
    "namespaces-graph-endpoint-acl-order"
);
runtime_case!(
    fused_identities_are_reranked_once,
    "namespaces-foreign-identities-rerank"
);
runtime_case!(
    fused_identities_report_reranker_fallback,
    "namespaces-foreign-identities-rerank-fallback"
);

fn assert_runtime(name: &str) {
    let golden = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/recall/golden/namespaces")
        .join(format!("{name}.json"));
    let data: Value = serde_json::from_slice(&fs::read(golden).unwrap()).unwrap();
    let fixture = &data["runtime"];
    let root = tempfile::tempdir().unwrap();
    let base = root.path().join("stores");
    let workspace = root.path().join("workspace");
    prepare_knowledge(fixture, &workspace);
    seed(fixture, &base);
    let rows = fixture["rows"].as_array().unwrap();
    let active: VectorSpaceIdentity = serde_json::from_value(rows[0]["identity"].clone()).unwrap();
    let calls = Mutex::new(Vec::new());
    let provider = Flat {
        identity: active,
        calls: &calls,
    };
    let foreign_identity = rows
        .iter()
        .find(|row| row["namespace"] == "legacy")
        .map(|row| serde_json::from_value(row["identity"].clone()).unwrap())
        .unwrap_or_else(|| provider.identity.clone());
    let foreign = Flat {
        identity: foreign_identity,
        calls: &calls,
    };
    let other_providers: Vec<&dyn EmbeddingProvider> = if fixture["foreignAvailable"] == true {
        vec![&foreign]
    } else {
        Vec::new()
    };
    let config = serde_json::from_value(json!({"namespaces":fixture["config"]})).unwrap();
    let routes = NamespaceStores::open(&base, &config, provider.identity(), 4).unwrap();
    let host = TestHost::new(root.path().to_owned());
    let context = context(fixture, &host);
    let ranker = ScriptedRanker {
        scores: &fixture["rerank"],
        calls: Mutex::new(Vec::new()),
    };
    let cancel = Cancel::never();
    let edges = graph_edges(fixture);
    let mut pipeline = pipeline(
        fixture, &context, &provider, &ranker, &workspace, &edges, &cancel,
    );
    pipeline.identity_providers = &other_providers;
    let emotion = Emotion(fixture["emotion"].as_f64().unwrap_or(1.0));
    pipeline.emotion = fixture["emotion"].is_number().then_some(&emotion);
    let ledger_path = root.path().join("retrieval.jsonl");
    let ledger = JsonlLedger::<RetrievalLedgerLine>::open(&ledger_path).unwrap();
    let params = &fixture["params"];
    let output = recall(&NamespaceRequest {
        rrf_k: plur1bus_engine::recall::namespace_identity::DEFAULT_RRF_K,
        budget: MergedBudget {
            enabled: params["adaptiveBudget"]["enabled"].as_bool() != Some(false),
            limit: params["budget"].as_f64().unwrap_or(f64::NAN),
        },
        routes: &routes,
        pipeline: &pipeline,
        agent_id: fixture["agentId"].as_str().unwrap(),
        workspace_key: "",
        query: fixture["query"].as_str().unwrap(),
        timestamp_ms: fixture["now"].as_i64().unwrap(),
        ledger: Some(&ledger),
        merge: merge_options(params),
    })
    .unwrap();
    assert_eq!(output.ledger_error, None);
    let result = &output.result;
    let trace = result.trace.clone().unwrap_or_default();
    let actual = json!({
        "queryVector":result.query_vector.as_ref().map(|v|v.iter().take(2).collect::<Vec<_>>()),
        "canonical":result.canonical, "memories":result.memories,
        "trace":trace, "degraded":result.degraded,
    });
    assert_value(&actual, &fixture["result"], name);
    let raw = fs::read_to_string(ledger_path).unwrap();
    assert_eq!(
        normalize_uuid(&raw),
        fixture["ledgerLines"][0].as_str().unwrap(),
        "{name}: raw ledger"
    );
    let mut embedding_calls = calls.lock().unwrap().clone();
    embedding_calls.sort_by_key(Value::to_string);
    assert_eq!(
        json!(embedding_calls),
        fixture["embeddingCalls"],
        "{name}: provider routing"
    );
    let mut rank_calls = ranker.calls.lock().unwrap().clone();
    rank_calls.sort_by_key(|call| call["docs"].to_string());
    assert_eq!(
        json!(rank_calls),
        fixture["rerankCalls"],
        "{name}: reranker input"
    );
}

fn seed(fixture: &Value, base: &Path) {
    let mut stores = std::collections::HashMap::new();
    for item in fixture["rows"].as_array().unwrap() {
        let identity: VectorSpaceIdentity =
            serde_json::from_value(item["identity"].clone()).unwrap();
        let width = item["identity"]["dimension"].as_u64().unwrap() as usize;
        let path = base
            .join(item["namespace"].as_str().unwrap())
            .join(fixture["agentId"].as_str().unwrap());
        let store = stores
            .entry(path.clone())
            .or_insert_with(|| Store::create(&path, &identity, width).unwrap());
        let raw = &item["row"];
        let mut row = serde_json::to_value(memory_row(
            raw["id"].as_str().unwrap(),
            fixture["agentId"].as_str().unwrap(),
            "agent-private",
        ))
        .unwrap();
        for (key, value) in raw.as_object().unwrap() {
            if row.get(key).is_some() && !value.is_null() {
                row[key] = value.clone();
            }
        }
        // Match RE-02's nullable-column read fallback before seeding its typed writer.
        if raw["importance"].is_null() {
            row["importance"] = json!(0.5);
        }
        if !row["confirmed"].is_boolean() {
            row["confirmed"] = json!(row["confirmed"].as_i64().unwrap_or(0) != 0);
        }
        row["vector"] = json!(vector(width, item["basis"].as_u64().unwrap() as usize));
        store
            .upsert(&[serde_json::from_value(row).unwrap()])
            .unwrap();
    }
}

fn prepare_knowledge(fixture: &Value, workspace: &Path) {
    let Some(content) = fixture["knowledge"].as_str() else {
        return;
    };
    let file = workspace.join("memory/KNOWLEDGE.md");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, content).unwrap();
    let now = UNIX_EPOCH + Duration::from_millis(fixture["now"].as_u64().unwrap());
    File::open(file)
        .unwrap()
        .set_times(FileTimes::new().set_modified(now))
        .unwrap();
}

fn context(fixture: &Value, host: &TestHost) -> RequestContext {
    let principal: Principal = serde_json::from_value(json!({
        "agentId":fixture["agentId"],"workspace":"workspace:v1:fixture","channel":"","accountId":"",
        "chat":{"id":"fixture","kind":"direct"},"trust":"inferred"
    }))
    .unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&principal, &agent, host).unwrap()
}

fn pipeline<'a>(
    fixture: &'a Value,
    context: &'a RequestContext,
    provider: &'a dyn EmbeddingProvider,
    ranker: &'a ScriptedRanker<'a>,
    workspace: &'a Path,
    edges: &'a [GraphEdge],
    cancel: &'a Cancel,
) -> Pipeline<'a> {
    let p = &fixture["params"];
    let top = p["topN"].as_u64().unwrap_or(9) as usize;
    Pipeline {
        emotion: None,
        identity_providers: &[],
        context,
        denials: &Discard,
        embedder: provider,
        reranker: (!fixture["rerank"].is_null()).then_some(ranker as &dyn Reranker),
        workspace_dir: fixture["knowledge"].is_string().then_some(workspace),
        edges,
        cancel,
        limits: StageLimits {
            top_n: top,
            candidate_top_k: 40,
            candidate_hard_limit: 100,
            recall_min_score: p["recallMinScore"].as_f64().unwrap_or(0.15),
            canonical_min_score: 0.3,
            canonical_max_items: 2,
        },
        flags: StageFlags {
            canonical: p["canonicalEnabled"].as_bool().unwrap_or(false),
            associative: p["associativeEnabled"].as_bool().unwrap_or(false),
            defer_final_cap: true,
            query_refiner: false,
            persist_knowledge: true,
        },
        clocks: StageClocks {
            now_ms: fixture["now"].as_i64().unwrap(),
            temporal_now_ms: fixture["now"].as_i64().unwrap(),
            valid_at: None,
        },
        finalise_limits: FinaliseLimits {
            top_n: top as f64,
            budget: p["budget"].as_f64().unwrap_or(12.0),
            rerank_candidates: 100.0,
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

fn merge_options(p: &Value) -> MergeOptions {
    MergeOptions {
        max_out: p["topN"].as_u64().unwrap_or(9) as usize,
        canonical_max_items: 2,
        dedup_enabled: p["dedupEnabled"].as_bool().unwrap_or(false),
        trace_limits: Some(plur1bus_engine::recall::namespace_trace::TraceLimits {
            candidates: 100,
            decisions: 100,
            guards: 100,
            store_decisions: 100,
        }),
        ..MergeOptions::default()
    }
}

fn graph_edges(fixture: &Value) -> Vec<GraphEdge> {
    fixture["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|edge| GraphEdge {
            source: edge["source"].as_str().unwrap().to_owned(),
            target: edge["target"].as_str().unwrap().to_owned(),
            strength: edge["strength"].as_f64().unwrap(),
            directed: edge["directed"].as_bool().unwrap(),
            kind: edge["type"].as_str().unwrap().to_owned(),
        })
        .collect()
}

fn normalize_uuid(raw: &str) -> String {
    let prefix = "{\"id\":\"";
    assert!(
        raw.starts_with(prefix),
        "Node ledger starts with its id field"
    );
    let end = raw[prefix.len()..].find('"').unwrap() + prefix.len();
    assert!(uuid::Uuid::parse_str(&raw[prefix.len()..end]).is_ok());
    let mut normalized = raw.to_owned();
    normalized.replace_range(prefix.len()..end, "__UUID__");
    normalized
}

// In-memory JSON numbers share Node's numeric value semantics. Persisted JSONL
// above is compared as text, so field order and number spelling are protected.
fn assert_value(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{path}"),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_value(a, b, &format!("{path}/{i}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}"
            );
            for (key, a) in a {
                assert_value(a, &b[key], &format!("{path}/{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

struct Discard;
impl DenialSink for Discard {
    fn denied(&self, _: &str, _: &'static str, _: &RequestContext) {}
}
struct Flat<'a> {
    identity: VectorSpaceIdentity,
    calls: &'a Mutex<Vec<Value>>,
}
impl EmbeddingProvider for Flat<'_> {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        for _ in texts {
            self.calls
                .lock()
                .unwrap()
                .push(json!({"identityId":self.identity.model,
                "kind":if kind==EmbedKind::Query {"query"} else {"passage"}}));
        }
        let width = serde_json::to_value(&self.identity).unwrap()["dimension"]
            .as_u64()
            .unwrap() as usize;
        Ok(texts.iter().map(|_| vector(width, 0)).collect())
    }
}
struct ScriptedRanker<'a> {
    scores: &'a Value,
    calls: Mutex<Vec<Value>>,
}
impl Reranker for ScriptedRanker<'_> {
    fn empty_result_is_valid(&self) -> bool {
        false
    }
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        _: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        self.calls
            .lock()
            .unwrap()
            .push(json!({"query":query,"docs":docs,"topN":top_n}));
        if self.scores == "unavailable" {
            return Err(RerankError::Unavailable);
        }
        let mut ranks = docs
            .iter()
            .enumerate()
            .map(|(index, text)| {
                let key = text.rsplit(' ').next().unwrap();
                (index, self.scores[key].as_f64().unwrap())
            })
            .collect::<Vec<_>>();
        ranks.sort_by(|a, b| b.1.total_cmp(&a.1));
        Ok(ranks
            .into_iter()
            .map(|(index, score)| {
                serde_json::from_value(json!({"index":index,"score":score})).unwrap()
            })
            .collect())
    }
}
fn vector(width: usize, basis: usize) -> Vec<f32> {
    let mut v = vec![0.0; width];
    v[basis] = 1.0;
    v
}

struct Emotion(f64);
impl plur1bus_engine::recall::score::EmotionalRecallState for Emotion {
    fn recall_boost(&self, _: &plur1bus_engine::contract::MemoryRow) -> f64 {
        self.0
    }
}
