//! Stage 1–7 parity against the pinned Node pipeline.
//!
//! Each scenario was recorded twice. The test rebuilds the store from the recipe
//! (the committed `store-v1` fixture for `plain`) and compares ordered ids, scores
//! rounded to 6 decimals, canonical headings, rejection entries and the knowledge
//! cache length. Ids are not re-sorted: a tie-order change is a failure.

#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::float_arithmetic,
    reason = "parity tests stop when a recorded golden disagrees with the port"
)]

#[path = "recall_support.rs"]
mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use plur1bus_engine::context::RequestContext;
use plur1bus_engine::contract::{
    AgentContext, EmbedError, EmbedKind, MemoryRow, Principal, VectorSpaceIdentity,
};
use plur1bus_engine::embedding::{Cancel, EmbeddingProvider};
use plur1bus_engine::recall::acl::DenialSink;
use plur1bus_engine::recall::graph::GraphEdge;
use plur1bus_engine::recall::hash_embed::{
    hash_unit, l2_normalize, to_f32, HashEmbedder, HASH_DIMENSION,
};
use plur1bus_engine::recall::knowledge::cached_chunk_count;
use plur1bus_engine::recall::stages::{
    run_through_stage_7, StageClocks, StageFlags, StageInput, StageLimits, StageSnapshot,
};
use plur1bus_engine::store::{OpenMode, Store};
use serde_json::{json, Value};
use support::{memory_row, TestHost};

#[test]
fn plain_matches_the_node_stage_golden() {
    assert_scenario("plain");
}

#[test]
fn temporal_last_week_matches_the_node_stage_golden() {
    assert_scenario("temporal-last-week");
}

#[test]
fn knowledge_section_hit_matches_the_node_stage_golden() {
    assert_scenario("knowledge-section-hit");
}

#[test]
fn knowledge_section_failed_not_cached_matches_the_node_stage_golden() {
    assert_scenario("knowledge-section-failed-not-cached");
}

#[test]
fn graph_spread_adds_neighbours_matches_the_node_stage_golden() {
    assert_scenario("graph-spread-adds-neighbours");
}

#[test]
fn graph_only_hit_excluded_matches_the_node_stage_golden() {
    assert_scenario("graph-only-hit-excluded");
}

#[test]
fn archived_rows_never_return_matches_the_node_stage_golden() {
    assert_scenario("archived-rows-never-return");
}

#[test]
fn epistemic_untrusted_rows_match_the_node_stage_golden() {
    assert_scenario("epistemic-untrusted-rows-ineligible");
}

#[test]
fn valid_time_window_matches_the_node_stage_golden() {
    assert_scenario("valid-time-window");
}

struct ScriptedEmbedder {
    inner: HashEmbedder,
    query: Vec<f32>,
    passage_failures: AtomicUsize,
}

impl ScriptedEmbedder {
    fn new(scenario: &Value) -> Self {
        let failures = scenario
            .get("knowledge")
            .and_then(|value| value.get("failEmbeds"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        Self {
            inner: HashEmbedder::new(),
            query: materialise(&scenario["queryVector"]),
            passage_failures: AtomicUsize::new(failures),
        }
    }
}

impl EmbeddingProvider for ScriptedEmbedder {
    fn identity(&self) -> &VectorSpaceIdentity {
        self.inner.identity()
    }

    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        if kind == EmbedKind::Query {
            return Ok(texts.iter().map(|_| self.query.clone()).collect());
        }
        if self.passage_failures.load(Ordering::SeqCst) > 0 {
            self.passage_failures.fetch_sub(1, Ordering::SeqCst);
            return Err(EmbedError::ProviderFailed { status: None });
        }
        Ok(texts.iter().map(|text| to_f32(&hash_unit(text))).collect())
    }
}

struct SilentSink;

impl DenialSink for SilentSink {
    fn denied(&self, _row_id: &str, _rule: &'static str, _ctx: &RequestContext) {}
}

fn assert_scenario(name: &str) {
    let scenario = load("scenarios", name);
    let golden = load("golden/stages", name);
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().canonicalize().unwrap();
    let store = open_store(&root, &scenario);
    let host = TestHost::new(root.clone());
    let context = context_for(&scenario, &host);
    let workspace = workspace_for(&root, &scenario);
    let edges = edges_of(&scenario);
    let embedder = ScriptedEmbedder::new(&scenario);
    let runs = golden["runs"].as_array().unwrap();
    for (pass, expected) in runs.iter().enumerate() {
        let snapshot = run_through_stage_7(
            &StageInput {
                query: scenario["query"].as_str().unwrap(),
                store: &store,
                embedder: &embedder,
                context: &context,
                workspace_dir: workspace.as_deref(),
                edges: &edges,
                limits: limits_of(&scenario),
                flags: flags_of(&scenario),
                clocks: clocks_of(&scenario),
            },
            &SilentSink,
        )
        .unwrap_or_else(|error| panic!("{name} pass {pass}: {error}"));
        let cache = workspace.as_deref().and_then(cached_chunk_count);
        assert_run(name, pass, &snapshot, expected, cache);
    }
}

fn assert_run(
    name: &str,
    pass: usize,
    snapshot: &StageSnapshot,
    expected: &Value,
    cache: Option<usize>,
) {
    let ids = strings(&expected["orderedIds"]);
    assert_eq!(snapshot.ordered_ids, ids, "{name} pass {pass} ids");
    let scores = expected["scores"].as_array().unwrap();
    assert_eq!(
        snapshot.scores.len(),
        scores.len(),
        "{name} pass {pass} scores"
    );
    for (index, score) in scores.iter().enumerate() {
        let actual = round6(snapshot.scores[index]);
        let wanted = score.as_f64().unwrap();
        assert!(
            (actual - wanted).abs() < 1e-9,
            "{name} pass {pass} score {index}: {actual} vs {wanted}"
        );
    }
    let canonical = expected["canonical"].as_array().unwrap();
    assert_eq!(
        snapshot.canonical.len(),
        canonical.len(),
        "{name} pass {pass} canonical"
    );
    for (hit, wanted) in snapshot.canonical.iter().zip(canonical) {
        assert_eq!(hit.heading, wanted["heading"].as_str().unwrap());
        let actual = round6(hit.score);
        let score = wanted["score"].as_f64().unwrap();
        assert!(
            (actual - score).abs() < 1e-9,
            "{name} pass {pass} canonical score {actual} vs {score}"
        );
    }
    let rejections = expected["rejections"].as_array().unwrap();
    assert_eq!(
        snapshot.rejections.len(),
        rejections.len(),
        "{name} pass {pass} rejections: {snapshot:?}"
    );
    for (got, wanted) in snapshot.rejections.iter().zip(rejections) {
        assert_eq!(got.memory_id, wanted["memoryId"].as_str().unwrap_or(""));
        assert_eq!(got.stage, wanted["stage"].as_str().unwrap());
        assert_eq!(got.reason, wanted["reason"].as_str().unwrap());
    }
    match &expected["cacheChunks"] {
        Value::Null => assert!(cache.is_none(), "{name} pass {pass} cache {cache:?}"),
        other => assert_eq!(
            cache,
            Some(other.as_u64().unwrap() as usize),
            "{name} pass {pass} cache"
        ),
    }
}

fn open_store(root: &Path, scenario: &Value) -> Store {
    if scenario["store"].as_str() == Some("store-v1") {
        let path = root.join("store-v1");
        copy_dir(&fixture("store-v1"), &path);
        let identity = fixture_identity();
        return Store::open(&path, OpenMode::ReadOnly, Some(&identity)).unwrap();
    }
    let path = root.join("store");
    let embedder = HashEmbedder::new();
    let store = Store::create(&path, embedder.identity(), HASH_DIMENSION).unwrap();
    let rows: Vec<MemoryRow> = scenario["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(scenario_row)
        .collect();
    store.upsert(&rows).unwrap();
    store
}

fn scenario_row(spec: &Value) -> MemoryRow {
    let prototype = memory_row(
        spec["id"].as_str().unwrap(),
        spec["agentId"].as_str().unwrap(),
        spec["scope"].as_str().unwrap(),
    );
    let mut value = serde_json::to_value(prototype).unwrap();
    let fields = value.as_object_mut().unwrap();
    for (key, item) in spec.as_object().unwrap() {
        if key != "vector" {
            fields.insert(key.clone(), item.clone());
        }
    }
    fields.insert("vector".into(), json!(materialise(&spec["vector"])));
    if fields.get("category").and_then(Value::as_str) == Some("") {
        fields.insert("category".into(), json!("general"));
    }
    serde_json::from_value(value).unwrap()
}

fn context_for(scenario: &Value, host: &TestHost) -> RequestContext {
    let agent = scenario["context"]["agentId"].as_str().unwrap();
    let workspace = scenario["context"]["workspaceIdentity"]
        .as_str()
        .unwrap_or("");
    let user = scenario["context"]["userPrincipal"].as_str().unwrap_or("");
    let proved = !workspace.is_empty() || !user.is_empty();
    // Agent-private scenarios carry an empty workspace. The contract still requires a
    // workspace principal and a chat kind, and inferred trust discards both.
    let principal = if proved {
        json!({
            "agentId": agent,
            "workspace": workspace,
            "user": user,
            "channel": "telegram",
            "accountId": "default",
            "chat": {"id": "1", "kind": "direct"},
            "trust": "proved",
        })
    } else {
        json!({
            "agentId": agent,
            "workspace": "workspace:v1:agent-private",
            "channel": "",
            "accountId": "",
            "chat": {"id": "1", "kind": "direct"},
            "trust": "inferred",
        })
    };
    let principal: Principal = serde_json::from_value(principal).unwrap();
    let agent_ctx: AgentContext =
        serde_json::from_value(json!({"origin": "user", "background": false})).unwrap();
    RequestContext::build(&principal, &agent_ctx, host)
        .unwrap_or_else(|error| panic!("context: {error}"))
}

fn workspace_for(root: &Path, scenario: &Value) -> Option<PathBuf> {
    let markdown = scenario["knowledge"]["markdown"].as_str()?;
    let directory = root.join("workspace");
    fs::create_dir_all(directory.join("memory")).unwrap();
    fs::write(directory.join("memory").join("KNOWLEDGE.md"), markdown).unwrap();
    Some(directory)
}

fn limits_of(scenario: &Value) -> StageLimits {
    StageLimits {
        top_n: usize_field(scenario, "topN"),
        candidate_top_k: usize_field(scenario, "candidateTopK"),
        candidate_hard_limit: usize_field(scenario, "candidateHardLimit"),
        recall_min_score: scenario["recallMinScore"].as_f64().unwrap(),
        canonical_min_score: scenario["canonicalMinScore"].as_f64().unwrap(),
        canonical_max_items: usize_field(scenario, "canonicalMaxItems"),
    }
}

fn flags_of(scenario: &Value) -> StageFlags {
    StageFlags {
        canonical: scenario["knowledge"].is_object(),
        associative: scenario["associativeEnabled"].as_bool().unwrap(),
        defer_final_cap: scenario["deferFinalCap"].as_bool().unwrap(),
        query_refiner: false,
        persist_knowledge: true,
    }
}

fn clocks_of(scenario: &Value) -> StageClocks {
    StageClocks {
        now_ms: scenario["now"].as_i64().unwrap(),
        temporal_now_ms: scenario["now"].as_i64().unwrap(),
        valid_at: scenario["validAt"].as_i64(),
    }
}

fn edges_of(scenario: &Value) -> Vec<GraphEdge> {
    scenario["edges"]
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

fn materialise(spec: &Value) -> Vec<f32> {
    to_f32(&materialise_f64(spec))
}

fn materialise_f64(spec: &Value) -> Vec<f64> {
    match spec["op"].as_str().unwrap() {
        "hash" => hash_unit(spec["text"].as_str().unwrap()),
        "flat" => {
            let mut values = vec![0.0; HASH_DIMENSION];
            values[0] = 1.0;
            values
        }
        "basis" => {
            let mut values = vec![0.0; HASH_DIMENSION];
            values[spec["index"].as_u64().unwrap() as usize] = 1.0;
            values
        }
        "mix" => {
            let left = materialise_f64(&spec["left"]);
            let right = materialise_f64(&spec["right"]);
            let scale = spec["scale"].as_f64().unwrap();
            let mixed = left
                .iter()
                .zip(right)
                .map(|(left, right)| left + scale * right)
                .collect::<Vec<_>>();
            l2_normalize(&mixed)
        }
        other => panic!("unknown vector op {other}"),
    }
}

fn usize_field(value: &Value, name: &str) -> usize {
    value[name].as_u64().unwrap() as usize
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn load(kind: &str, name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/recall")
        .join(kind)
        .join(format!("{name}.json"));
    serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn fixture_identity() -> VectorSpaceIdentity {
    serde_json::from_str(&fs::read_to_string(fixture("store-v1").join("identity.json")).unwrap())
        .unwrap()
}

fn copy_dir(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}
