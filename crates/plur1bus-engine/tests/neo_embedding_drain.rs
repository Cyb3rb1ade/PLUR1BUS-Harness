//! Native Neo embedding drain publishes real sidecars before current target and queue revisions.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{episode_store::EpisodeStore, merged::Layout},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[path = "support/neo_episode.rs"]
mod fixtures;
use fixtures::*;

use plur1bus_engine::{
    contract::{EmbedError, EmbedKind, VectorSpaceIdentity},
    embedding::EmbeddingProvider,
    neo::embedding_drain::{DrainOptions, EmbeddingDrain, Impact},
};
type OnEmbed = Arc<dyn Fn(&Cancel) + Send + Sync>;
struct Embedder {
    identity: VectorSpaceIdentity,
    calls: std::sync::Mutex<Vec<String>>,
    fail: AtomicBool,
    mode: std::sync::Mutex<String>,
    action: std::sync::Mutex<Option<OnEmbed>>,
}
impl Embedder {
    fn new() -> Self {
        Self {
            identity: serde_json::from_value(json!({
                "provider":"fixture","model":"neo-drain","revision":"1","dimension":3,
                "normalization":"none","prefixScheme":"fixture","instruction":"","dtype":"f32",
                "tokenCap":null,"pooling":"mean","artifacts":[]
            }))
            .unwrap(),
            calls: Default::default(),
            fail: AtomicBool::new(false),
            mode: std::sync::Mutex::new("normal".into()),
            action: Default::default(),
        }
    }
}
impl EmbeddingProvider for Embedder {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        assert!(matches!(kind, EmbedKind::Passage));
        self.calls.lock().unwrap().extend_from_slice(texts);
        if let Some(action) = self.action.lock().unwrap().clone() {
            action(cancel);
        }
        let mode = self.mode.lock().unwrap().clone();
        if mode == "scalar" {
            return Err(EmbedError::InvalidVector);
        }
        if mode == "throw" || self.fail.load(Ordering::SeqCst) {
            return Err(EmbedError::Unavailable);
        }
        let vector = match mode.as_str() {
            "empty" => vec![],
            "nan" => vec![f32::NAN, 0., 1.],
            "wrong-dimensions" => vec![0.5, 1.],
            _ => vec![0.5, -0.25, 1.125],
        };
        Ok(texts.iter().map(|_| vector.clone()).collect())
    }
}
fn drain(f: &Fixture, provider: Arc<Embedder>) -> EmbeddingDrain {
    let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
        f.host.clone(),
        json!({}),
    ));
    let episodes = Arc::new(
        EpisodeStore::open(f.root.path(), f.host.clone(), f.policy.clone(), mood).unwrap(),
    );
    EmbeddingDrain::new(episodes, Some(provider)).unwrap()
}
#[test]
fn five_turns_produce_actual_node_counts_and_float32_sidecar_bytes() {
    let f = setup();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let provider = Arc::new(Embedder::new());
    let worker = drain(&f, provider.clone());
    let options = DrainOptions {
        impact: Impact::All,
        ..DrainOptions::default()
    };
    let result = worker
        .drain(&f.turn.principal, &f.turn.agent, &options, &Cancel::never())
        .unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/capture/golden/neo-embedding-drain.json"
    ))
    .unwrap();
    let node = &fixture["cases"][0]["rounds"][0];
    assert_eq!(
        result.processed,
        node["result"]["processed"].as_u64().unwrap() as usize
    );
    assert_eq!(result.pending, 0);
    assert_eq!(result.deferred, 0);
    assert_eq!(result.skipped, 0);
    assert_eq!(provider.calls.lock().unwrap().len(), 12);
    let manifest: Value =
        serde_json::from_slice(&fs::read(f.directory.join("vector-index.json")).unwrap()).unwrap();
    let bytes = fs::read(f.directory.join(manifest["file"].as_str().unwrap())).unwrap();
    let values: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    let expected: Vec<f32> = node["output"]["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap() as f32)
        .collect();
    assert_eq!(values, expected);
    assert_eq!(manifest["entries"].as_object().unwrap().len(), 12);
    assert_eq!(rows(&f.directory, "embedding-queue.jsonl").len(), 24);
    let settled: Value = serde_json::from_slice(
        &fs::read(native_file(&f.directory, "native-embedding-pending-")).unwrap(),
    )
    .unwrap();
    assert_eq!(settled["plan"], Value::Null);
    let before = bytes;
    assert_eq!(
        worker
            .drain(&f.turn.principal, &f.turn.agent, &options, &Cancel::never())
            .unwrap()
            .processed,
        0
    );
    assert_eq!(
        fs::read(f.directory.join(manifest["file"].as_str().unwrap())).unwrap(),
        before
    );
    assert_eq!(provider.calls.lock().unwrap().len(), 12);
}
#[test]
fn failed_provider_defers_without_vectors_and_retry_completes_the_same_queue() {
    let f = setup();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let provider = Arc::new(Embedder::new());
    provider.fail.store(true, Ordering::SeqCst);
    let worker = drain(&f, provider.clone());
    let options = DrainOptions {
        impact: Impact::All,
        ..DrainOptions::default()
    };
    let result = worker
        .drain(&f.turn.principal, &f.turn.agent, &options, &Cancel::never())
        .unwrap();
    assert_eq!(result.processed, 0);
    assert_eq!(result.deferred, 12);
    assert!(!f.directory.join("vector-index.json").exists());
    provider.fail.store(false, Ordering::SeqCst);
    let result = worker
        .drain(&f.turn.principal, &f.turn.agent, &options, &Cancel::never())
        .unwrap();
    assert_eq!(result.processed, 12);
    assert_eq!(result.pending, 0);
    assert_eq!(result.deferred, 0);
}

#[path = "support/neo_embedding_crash.rs"]
mod crash;
#[path = "support/neo_embedding_edges.rs"]
mod edges;
#[path = "support/neo_embedding_oracle.rs"]
mod oracle;

#[path = "support/neo_embedding_recovery.rs"]
mod recovery;
