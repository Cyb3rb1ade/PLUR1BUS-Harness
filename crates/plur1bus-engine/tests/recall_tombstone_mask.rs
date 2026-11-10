//! Committed deletions are masked in every recall candidate source (RE-D153).
//! The pin consults no registry; each case also runs unmasked to prove the row would return.
#![allow(clippy::unwrap_used, reason = "fixture errors are fatal")]
#[path = "recall_support.rs"]
mod support;

use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal},
    embedding::{Cancel, EmbedKind, EmbeddingProvider},
    recall::{
        acl::DenialSink,
        graph::GraphEdge,
        hash_embed::HashEmbedder,
        namespace_trace::TraceLimits,
        query_refiner::refine_query,
        stages::{
            run_observed_stage_7, StageClocks, StageError, StageFlags, StageInput, StageLimits,
            StageSnapshot,
        },
        tombstone_mask::TombstoneMask,
    },
    store::{
        tombstone::{content_fingerprint, TombstoneRegistry},
        Store,
    },
    text::json::parse_json,
};
use serde_json::json;
use std::path::Path;

const LIVE: &str = "11111111-1111-4111-8111-111111111111";
const GONE: &str = "22222222-2222-4222-8222-222222222222";

struct Sink;
impl DenialSink for Sink {
    fn denied(&self, _: &str, _: &str, _: &RequestContext) {}
}

struct Fixture {
    root: tempfile::TempDir,
    store: Store,
    context: RequestContext,
    hash: HashEmbedder,
}

impl Fixture {
    fn new() -> Self {
        let root = support::canonical_tempdir();
        let hash = HashEmbedder::new();
        let width = hash.identity().dimension.as_u64().unwrap() as usize;
        let store = Store::create(&root.path().join("db/agent"), hash.identity(), width).unwrap();
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
            context,
            hash,
        }
    }

    fn base(&self) -> std::path::PathBuf {
        self.root.path().join("db")
    }

    fn vector(&self, text: &str) -> Vec<f32> {
        self.hash
            .embed(&[text.into()], EmbedKind::Query, &Cancel::never())
            .unwrap()
            .remove(0)
    }

    fn row(&self, id: &str, text: &str, vector: Vec<f32>) {
        let mut row = support::memory_row(id, "agent", "agent-private");
        row.text = text.into();
        row.status = "active".into();
        row.memory_strength = serde_json::Number::from_f64(1.0).unwrap();
        row.vector = vector;
        self.store.upsert(&[row]).unwrap();
    }

    fn forget(&self, id: &str, text: &str) {
        let line = json!({"schemaVersion":1,"memoryId":id,"agentId":"agent","scope":"agent-private",
            "status":"committed","contentFingerprint":content_fingerprint(text)});
        TombstoneRegistry::new(&self.base(), "agent")
            .unwrap()
            .append(&parse_json(&line.to_string()).unwrap())
            .unwrap();
    }

    fn run(
        &self,
        query: &str,
        edges: &[GraphEdge],
        limits: StageLimits,
        flags: StageFlags,
        mask: Option<&TombstoneMask>,
    ) -> Result<StageSnapshot, StageError> {
        run_observed_stage_7(
            &StageInput {
                query,
                store: &self.store,
                embedder: &self.hash,
                context: &self.context,
                workspace_dir: None,
                edges,
                bound_graph: None,
                tombstones: mask,
                limits,
                flags,
                clocks: StageClocks {
                    now_ms: 0,
                    temporal_now_ms: 0,
                    valid_at: None,
                },
            },
            &Sink,
            Some(TraceLimits::default()),
            None,
        )
    }
}

fn limits(top: usize, min_score: f64) -> StageLimits {
    StageLimits {
        top_n: top,
        candidate_top_k: top,
        candidate_hard_limit: 10,
        recall_min_score: min_score,
        canonical_min_score: 0.3,
        canonical_max_items: 5,
    }
}

fn flags(associative: bool, query_refiner: bool) -> StageFlags {
    StageFlags {
        canonical: false,
        associative,
        defer_final_cap: true,
        query_refiner,
        persist_knowledge: false,
    }
}

fn masked_ids(snapshot: &StageSnapshot) -> Vec<String> {
    snapshot
        .rejections
        .iter()
        .filter(|rejection| rejection.reason == "tombstoned")
        .map(|rejection| rejection.memory_id.clone())
        .collect()
}

#[test]
fn a_tombstoned_vector_hit_is_masked_and_a_live_neighbour_stays() {
    let fixture = Fixture::new();
    let query = "fixture archive decision";
    fixture.row(LIVE, "live card", fixture.vector(query));
    fixture.row(GONE, "forgotten card", fixture.vector(query));
    fixture.forget(GONE, "forgotten card");
    let mask = TombstoneMask::new(&fixture.base());
    let open = fixture
        .run(query, &[], limits(5, 0.15), flags(false, false), None)
        .unwrap();
    assert!(open.ordered_ids.contains(&GONE.to_owned()));
    let masked = fixture
        .run(
            query,
            &[],
            limits(5, 0.15),
            flags(false, false),
            Some(&mask),
        )
        .unwrap();
    assert_eq!(masked.ordered_ids, [LIVE]);
    assert_eq!(masked_ids(&masked), [GONE]);
    // The trace names the id and the fixed reason only.
    let trace = serde_json::to_string(&masked.trace).unwrap();
    assert!(!trace.contains("forgotten card"));
}

#[test]
fn a_tombstoned_graph_neighbour_is_never_hydrated() {
    let fixture = Fixture::new();
    let query = "fixture archive decision";
    let seed = fixture.vector(query);
    let other = fixture.vector("unrelated neighbour");
    // Close to the query, so hydration relevance passes, but outside the one-row vector fetch.
    let mut near = seed
        .iter()
        .zip(&other)
        .map(|(a, b)| 0.95 * a + 0.05 * b)
        .collect::<Vec<f32>>();
    let norm = near.iter().map(|v| v * v).sum::<f32>().sqrt();
    near.iter_mut().for_each(|v| *v /= norm);
    fixture.row(LIVE, "seed card", seed);
    fixture.row(GONE, "forgotten neighbour", near);
    fixture.forget(GONE, "forgotten neighbour");
    let edges = [GraphEdge {
        source: LIVE.into(),
        target: GONE.into(),
        strength: 0.9,
        directed: false,
        kind: "related".into(),
    }];
    let open = fixture
        .run(query, &edges, limits(1, 0.15), flags(true, false), None)
        .unwrap();
    assert!(
        open.ordered_ids.contains(&GONE.to_owned()),
        "{:?}",
        open.ordered_ids
    );
    let mask = TombstoneMask::new(&fixture.base());
    let masked = fixture
        .run(
            query,
            &edges,
            limits(1, 0.15),
            flags(true, false),
            Some(&mask),
        )
        .unwrap();
    assert_eq!(masked.ordered_ids, [LIVE]);
    assert!(masked_ids(&masked).contains(&GONE.to_owned()));
}

#[test]
fn the_refined_second_search_is_masked() {
    let fixture = Fixture::new();
    let query = "Wie konfiguriere ich den Docker?";
    let refined = refine_query(query, None);
    fixture.row(GONE, "forgotten docker card", fixture.vector(&refined));
    fixture.forget(GONE, "forgotten docker card");
    // Unit vectors score at least 0.2; the original query misses this floor.
    let open = fixture
        .run(query, &[], limits(5, 0.5), flags(false, true), None)
        .unwrap();
    assert_eq!(open.ordered_ids, [GONE]);
    let mask = TombstoneMask::new(&fixture.base());
    let masked = fixture
        .run(query, &[], limits(5, 0.5), flags(false, true), Some(&mask))
        .unwrap();
    assert!(masked.ordered_ids.is_empty());
    assert_eq!(masked_ids(&masked), [GONE]);
}

#[test]
fn an_unreadable_registry_fails_instead_of_reading_unmasked() {
    let fixture = Fixture::new();
    let query = "fixture archive decision";
    fixture.row(LIVE, "live card", fixture.vector(query));
    let registry = TombstoneRegistry::new(&fixture.base(), "agent").unwrap();
    std::fs::create_dir_all(registry.path()).unwrap();
    let mask = TombstoneMask::new(Path::new(&fixture.base()));
    assert!(matches!(
        fixture.run(
            query,
            &[],
            limits(5, 0.15),
            flags(false, false),
            Some(&mask)
        ),
        Err(StageError::Store(_))
    ));
}

#[test]
fn the_native_exception_binds_the_pinned_pipeline_source() {
    let marker: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/recall/tombstone-recall-native-exceptions.json"
    ))
    .unwrap();
    let sources: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/recall/namespace-sources.json")).unwrap();
    assert_eq!(marker["exception"], "RE-D153");
    assert_eq!(marker["sourceCommit"], sources["runtime"]["commit"]);
    assert_eq!(
        marker["sourceSha256"],
        sources["runtime"]["sha256"]["lib/recall-pipeline.js"]
    );
}
