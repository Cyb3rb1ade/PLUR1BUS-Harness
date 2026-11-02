//! Node-recorded namespace routing, fan-out, merge and retrieval ledger invariants.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "golden assertions stop on parity drift"
)]

#[path = "recall_support.rs"]
mod support;

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Barrier;

use plur1bus_engine::context::RequestContext;
use plur1bus_engine::contract::{AgentContext, EngineConfig, Principal, StoreError};
use plur1bus_engine::embedding::{Cancel, EmbeddingProvider};
use plur1bus_engine::recall::finalise::FinaliseLimits;
use plur1bus_engine::recall::hash_embed::{HashEmbedder, HASH_DIMENSION};
use plur1bus_engine::recall::merge::{merge, MergeOptions, NamespaceResult};
use plur1bus_engine::recall::namespace_pipeline::Pipeline;
use plur1bus_engine::recall::namespace_query::RequestQueries;
use plur1bus_engine::recall::namespace_trace::{NamespaceTrace, TraceLimits};
use plur1bus_engine::recall::namespaces::{
    recall, CanonicalSource, NamespaceError, NamespaceRequest, NamespaceStores, TableRecall,
};
use plur1bus_engine::recall::stages::{StageClocks, StageFlags, StageLimits};
use plur1bus_engine::store::ledger::JsonlLedger;
use plur1bus_engine::store::ledger_types::RetrievalLedgerLine;
use plur1bus_engine::store::state_file::JsonRecord;
use plur1bus_engine::store::{Store, StoreRoutes};
use plur1bus_engine::text::json::write_json;
use serde_json::{json, Value};
use support::{memory_row, TestHost};

#[test]
fn namespaces_two_tables_match_the_node_golden() {
    assert_runtime("namespaces-two-tables");
    let golden = load("namespaces-two-tables");
    for case in golden["merges"].as_array().unwrap() {
        for _ in 0..32 {
            assert_merge(case);
        }
    }
}

#[test]
fn namespaces_legacy_table_missing_is_skipped_without_creating_it() {
    assert_runtime("namespaces-legacy-table-missing-is-skipped");
}

#[test]
fn namespaces_second_table_error_rejects_the_whole_recall_after_all_children_settle() {
    assert_runtime("namespaces-second-table-error-rejects-the-whole-recall");
}

#[test]
fn namespaces_merge_keeps_reranker_order() {
    for case in load("namespaces-merge-keeps-reranker-order")["merges"]
        .as_array()
        .unwrap()
    {
        assert_merge(case);
    }
    let cp5 = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/recall/golden/rerank/G-RERANK-2.json");
    let golden: Value = serde_json::from_str(&fs::read_to_string(cp5).unwrap()).unwrap();
    let inputs: Vec<NamespaceResult> = serde_json::from_value(json!([
        {"namespace":"ns-a","memories":[
            {"entry":{"id":"r1","text":"r1","summary":"r1","agentId":"a1"},"score":0.1,"rerankScore":0.9},
            {"entry":{"id":"r2","text":"r2","summary":"r2","agentId":"a1"},"score":0.2,"rerankScore":0.8}]},
        {"namespace":"ns-b","memories":[
            {"entry":{"id":"u1","text":"u1","summary":"u1","agentId":"a1"},"score":0.99}]}
    ])).unwrap();
    let merged = merge(
        &inputs,
        &MergeOptions {
            max_out: 10,
            canonical_max_items: 10,
            dedup_enabled: false,
            ..MergeOptions::default()
        },
    );
    assert_eq!(
        json!(merged
            .memories
            .iter()
            .map(|m| m["entry"]["id"].clone())
            .collect::<Vec<_>>()),
        golden["runs"][0]["ids"]
    );
    assert_eq!(
        json!(merged
            .memories
            .iter()
            .map(|m| m["rerankScore"].clone())
            .collect::<Vec<_>>()),
        golden["runs"][0]["rerankScores"]
    );
}

#[test]
fn for_every_permutation_the_merged_order_restricted_to_reranked_ids_equals_it() {
    let base = [0.2, 0.9, 0.5, 0.1]
        .into_iter()
        .enumerate()
        .map(|(id, score)| {
            json!({
                "entry":{"id":format!("r{id}"),"text":format!("distinct {id}"),"agentId":"a"},
                "score":score,
            })
        })
        .collect::<Vec<_>>();
    let mut seen = std::collections::HashSet::new();
    for a in 0..4 {
        for b in 0..4 {
            for c in 0..4 {
                for d in 0..4 {
                    let permutation = [a, b, c, d];
                    if (0..4).any(|i| (i + 1..4).any(|j| permutation[i] == permutation[j])) {
                        continue;
                    }
                    let mut ranked = base.clone();
                    for (position, index) in permutation.iter().enumerate() {
                        ranked[*index]["rerankScore"] = json!((4 - position) as f64 / 4.0);
                    }
                    let input: Vec<NamespaceResult> = serde_json::from_value(json!([
            {"namespace":"first","memories":[ranked[0],ranked[2],{"entry":{"id":"u"},"score":999}]},
            {"namespace":"second","memories":[ranked[1],ranked[3]]},
        ])).unwrap();
                    assert!(seen.insert(serde_json::to_string(&input).unwrap()));
                    let result = merge(
                        &input,
                        &MergeOptions {
                            max_out: 5,
                            canonical_max_items: 0,
                            dedup_enabled: false,
                            ..MergeOptions::default()
                        },
                    );
                    let ids = result
                        .memories
                        .iter()
                        .map(|item| item["entry"]["id"].as_str().unwrap())
                        .collect::<Vec<_>>();
                    let mut expected = permutation
                        .iter()
                        .map(|id| format!("r{id}"))
                        .collect::<Vec<_>>();
                    expected.push("u".to_owned());
                    assert_eq!(ids, expected);
                }
            }
        }
    }
    assert_eq!(seen.len(), 24);
}

#[test]
fn namespace_config_routes_and_refusals_match_node() {
    let golden = load("namespaces-two-tables");
    for case in golden["routing"].as_array().unwrap() {
        let scratch = support::canonical_tempdir();
        let root = scratch.path().join("stores");
        let base = case["leaf"]
            .as_str()
            .map_or_else(|| root.clone(), |leaf| root.join(leaf));
        fs::create_dir_all(&base).unwrap();
        let value = if case["config"].is_null() {
            json!({})
        } else {
            json!({"namespaces":case["config"]})
        };
        let config: EngineConfig = serde_json::from_value(value).unwrap();
        let embedder = HashEmbedder::new();
        let result = NamespaceStores::open(&base, &config, embedder.identity(), 4);
        if case["result"]["threw"] == true {
            assert!(result.is_err(), "{}", case["name"]);
            continue;
        }
        let routes = result.unwrap();
        let read: Vec<_> = routes
            .read_routes()
            .unwrap()
            .iter()
            .map(|route| route.namespace.clone())
            .collect();
        assert_eq!(json!(read), case["result"]["read"], "{}", case["name"]);
        routes.write_store("route-fixture").unwrap();
        let target = if case["result"]["mode"] == "legacy-flat" {
            base
        } else if case["result"]["baseLeafWasStripped"] == true {
            root.join(case["result"]["write"].as_str().unwrap())
        } else {
            base.join(case["result"]["write"].as_str().unwrap())
        };
        assert!(
            target.join("route-fixture/memories.lance").exists(),
            "{}",
            case["name"]
        );
    }
}

fn assert_merge(case: &Value) {
    let input: Vec<NamespaceResult> = serde_json::from_value(case["input"].clone()).unwrap();
    let unchanged = serde_json::to_value(&input).unwrap();
    let opts = &case["options"];
    let options = MergeOptions {
        max_out: opts["maxOut"].as_u64().unwrap_or(0) as usize,
        canonical_max_items: opts["canonicalMaxItems"]
            .as_u64()
            .unwrap_or(opts["maxOut"].as_u64().unwrap_or(0)) as usize,
        dedup_enabled: opts["dedupEnabled"].as_bool().unwrap_or(true),
        dedup_jaccard: opts["dedupJaccard"].as_f64().unwrap_or(0.78),
        trace_limits: Some(TraceLimits {
            decisions: case["maxDecisions"].as_u64().unwrap_or(100) as usize,
            candidates: 100,
            guards: 100,
            store_decisions: 100,
        }),
    };
    let result = merge(&input, &options);
    assert_node_json(&project(&result), &case["result"]);
    assert_eq!(
        serde_json::to_value(&input).unwrap(),
        unchanged,
        "merge mutated its inputs"
    );
    assert!(result.canonical.len() + result.memories.len() <= options.max_out);
}

#[test]
fn namespace_merge_default_canonical_cap_uses_the_global_limit() {
    let golden = load("namespaces-two-tables");
    let case = golden["merges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "default-canonical-cap-follows-global")
        .unwrap();
    let input: Vec<NamespaceResult> = serde_json::from_value(case["input"].clone()).unwrap();
    let options = MergeOptions {
        max_out: 1,
        dedup_enabled: false,
        trace_limits: Some(TraceLimits {
            candidates: 100,
            decisions: 100,
            guards: 100,
            store_decisions: 100,
        }),
        ..MergeOptions::default()
    };
    assert_node_json(&project(&merge(&input, &options)), &case["result"]);
}

fn assert_runtime(name: &str) {
    let golden = load(name);
    let runtime = &golden["runtime"];
    let scratch = support::canonical_tempdir();
    let base = scratch.path().join("stores");
    fs::create_dir_all(&base).unwrap();
    let embedder = HashEmbedder::new();
    for spec in runtime["rows"].as_array().unwrap() {
        let path = base
            .join(spec["namespace"].as_str().unwrap())
            .join(runtime["agentId"].as_str().unwrap());
        let store = Store::create(&path, embedder.identity(), HASH_DIMENSION).unwrap();
        let row = &spec["row"];
        let mut value = serde_json::to_value(memory_row(
            row["id"].as_str().unwrap(),
            runtime["agentId"].as_str().unwrap(),
            "agent-private",
        ))
        .unwrap();
        for (key, field) in row.as_object().unwrap() {
            value[key] = field.clone();
        }
        value["vector"] = json!(flat());
        store
            .upsert(&[serde_json::from_value(value).unwrap()])
            .unwrap();
    }
    let config: EngineConfig =
        serde_json::from_value(json!({"namespaces":runtime["config"]})).unwrap();
    let routes = NamespaceStores::open(&base, &config, embedder.identity(), 4).unwrap();
    assert_eq!(routes.read_routes().unwrap().len(), 2);
    let host = TestHost::new(scratch.path().to_owned());
    let principal: Principal = serde_json::from_value(json!({
        "agentId":runtime["agentId"], "workspace":"workspace:v1:unused", "channel":"", "accountId":"",
        "chat":{"id":"fixture","kind":"direct"},"trust":"inferred"
    })).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let context = RequestContext::build(&principal, &agent, &host).unwrap();
    let flat_embedder = Flat(embedder);
    let pipeline = Pipeline {
        emotion: None,
        identity_providers: &[],
        context: &context,
        denials: &DiscardDenials,
        embedder: &flat_embedder,
        reranker: None,
        workspace_dir: None,
        edges: &[],
        cancel: &Cancel::never(),
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
            persist_knowledge: true,
        },
        clocks: StageClocks {
            now_ms: runtime["now"].as_i64().unwrap(),
            temporal_now_ms: runtime["now"].as_i64().unwrap(),
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
    };
    let completed = AtomicBool::new(false);
    let barrier = Barrier::new(2);
    let fail = name.contains("error");
    let seam = FailureSeam {
        pipeline,
        fail,
        completed: &completed,
        barrier: &barrier,
    };
    let ledger =
        JsonlLedger::<RetrievalLedgerLine>::open(&scratch.path().join("retrieval.jsonl")).unwrap();
    let outcome = recall(&NamespaceRequest {
        rrf_k: plur1bus_engine::recall::namespace_identity::DEFAULT_RRF_K,
        budget: Default::default(),
        routes: &routes,
        pipeline: &seam,
        agent_id: runtime["agentId"].as_str().unwrap(),
        workspace_key: "",
        query: runtime["query"].as_str().unwrap(),
        ledger: Some(&ledger),
        timestamp_ms: runtime["now"].as_i64().unwrap(),
        merge: MergeOptions {
            max_out: 4,
            canonical_max_items: 2,
            dedup_enabled: false,
            trace_limits: Some(TraceLimits {
                candidates: 100,
                decisions: 100,
                guards: 100,
                store_decisions: 100,
            }),
            ..MergeOptions::default()
        },
    });
    if fail {
        assert!(matches!(
            outcome,
            Err(NamespaceError::Store(StoreError::Unavailable))
        ));
        assert!(
            completed.load(Ordering::SeqCst),
            "recall released a still-running child after the second failed"
        );
    } else {
        let outcome = outcome.unwrap();
        assert_eq!(outcome.ledger_error, None);
        let mut expected = runtime["result"].clone();
        expected.as_object_mut().unwrap().remove("threw");
        assert_node_json(&project(&outcome.result), &expected);
    }
    let raw = fs::read_to_string(scratch.path().join("retrieval.jsonl")).unwrap_or_default();
    let normalized = raw
        .lines()
        .map(|line| {
            let prefix = "{\"id\":\"";
            assert!(line.starts_with(prefix));
            let end = line[prefix.len()..].find('"').unwrap() + prefix.len();
            assert!(uuid::Uuid::parse_str(&line[prefix.len()..end]).is_ok());
            let mut line = line.to_owned();
            line.replace_range(prefix.len()..end, "__UUID__");
            format!("{line}\n")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        json!(normalized),
        runtime["ledgerLines"],
        "byte-exact Node ledger"
    );
    let lines: Vec<Value> = ledger
        .iter()
        .map(|line| {
            let mut value: Value =
                serde_json::from_str(&write_json(&line.unwrap().to_json().unwrap())).unwrap();
            assert!(uuid::Uuid::parse_str(value["id"].as_str().unwrap()).is_ok());
            assert!(
                value.get("query").is_none(),
                "Node persists the hash, never plaintext queries"
            );
            value["id"] = json!("__UUID__");
            value
        })
        .collect();
    assert_eq!(
        json!(lines),
        runtime["ledger"],
        "one global ledger line, never one per table"
    );
    if name.contains("missing") {
        assert!(!base.join("legacy").exists());
    }
}

struct FailureSeam<'a> {
    pipeline: Pipeline<'a>,
    fail: bool,
    completed: &'a AtomicBool,
    barrier: &'a Barrier,
}
impl TableRecall for FailureSeam<'_> {
    fn recall(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
    ) -> Result<NamespaceResult, NamespaceError> {
        if self.fail {
            self.barrier.wait();
        }
        if self.fail && namespace == Some("legacy") {
            return Err(NamespaceError::Store(StoreError::Unavailable));
        }
        let result = self.pipeline.recall(namespace, store, canonical, queries);
        self.completed.store(true, Ordering::SeqCst);
        result
    }
}

struct Flat(HashEmbedder);
struct DiscardDenials;
impl plur1bus_engine::recall::acl::DenialSink for DiscardDenials {
    fn denied(&self, _id: &str, _rule: &'static str, _context: &RequestContext) {}
}
impl EmbeddingProvider for Flat {
    fn identity(&self) -> &plur1bus_engine::contract::VectorSpaceIdentity {
        self.0.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        _kind: plur1bus_engine::embedding::EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, plur1bus_engine::embedding::EmbedError> {
        cancel
            .check()
            .map_err(plur1bus_engine::embedding::EmbedError::Cancelled)?;
        Ok(texts.iter().map(|_| flat()).collect())
    }
}

fn flat() -> Vec<f32> {
    let mut out = vec![0.0; HASH_DIMENSION];
    out[0] = 1.0;
    out
}
fn load(name: &str) -> Value {
    serde_json::from_str(
        &fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/recall/golden/namespaces")
                .join(format!("{name}.json")),
        )
        .unwrap(),
    )
    .unwrap()
}
fn project(result: &NamespaceResult) -> Value {
    let trace = result
        .trace
        .as_ref()
        .cloned()
        .unwrap_or_else(NamespaceTrace::default);
    let project_entries = |entries: &[Value]| {
        entries
            .iter()
            .map(|entry| {
                let mut out = serde_json::Map::new();
                for key in [
                    "id",
                    "memoryId",
                    "action",
                    "stage",
                    "reason",
                    "name",
                    "passed",
                    "namespace",
                ] {
                    if let Some(value) = entry.get(key) {
                        out.insert(key.to_owned(), value.clone());
                    }
                }
                Value::Object(out)
            })
            .collect::<Vec<_>>()
    };
    json!({ "queryVector":result.query_vector.as_ref().map(|v| v.iter().take(2).collect::<Vec<_>>()),
        "canonical":result.canonical.iter().map(|c| json!({"heading":c["heading"],"text":c["text"],"score":c["score"],"namespace":c["namespace"]})).collect::<Vec<_>>(),
        "memories":result.memories.iter().map(|m| json!({"id":m["entry"]["id"],"text":m["entry"]["text"],"score":m["score"],
            "rerankScore":m["rerankScore"],"namespace":m["namespace"],"source":m["source"]})).collect::<Vec<_>>(),
        "trace":{"candidates":project_entries(&trace.candidates),"decisions":project_entries(&trace.decisions),
            "guards":project_entries(&trace.guards),"storeDecisions":project_entries(&trace.store_decisions)}
    })
}

// JSON numbers have Node's one numeric type. Compare their exact values, so
// integer tokens and serialized f32 values such as 1.0 do not create false drift.
// Strings are byte-exact; array order and the object key set are exact.
// Object insertion order is tested on the raw persisted ledger text separately.
fn assert_node_json(got: &Value, want: &Value) {
    match (got, want) {
        (Value::Number(left), Value::Number(right)) => assert_eq!(left.as_f64(), right.as_f64()),
        (Value::Array(left), Value::Array(right)) => {
            assert_eq!(left.len(), right.len());
            for (left, right) in left.iter().zip(right) {
                assert_node_json(left, right);
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            assert_eq!(
                left.keys().collect::<Vec<_>>(),
                right.keys().collect::<Vec<_>>()
            );
            for (key, value) in left {
                assert_node_json(value, &right[key]);
            }
        }
        _ => assert_eq!(got, want),
    }
}
