//! Exercise normal recall through real process dispatch, Lance stores and the mood store.
#![allow(clippy::unwrap_used, reason = "isolated fixture errors are fatal")]

use super::*;
use crate::{contract::testing::FakeHost, rpc::methods, store::Store};
use std::{fs, path::Path};

fn params(query: &str, origin: &str) -> Value {
    json!({"query": {"query":query,
        "principal":{"agentId":"agent","workspace":"workspace:v1:fixture","channel":"cli",
            "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"inferred"},
        "agent":{"origin":origin,"background":false}}, "options":{"reranker":"off"}})
}

fn host(root: &Path, temporal: bool) -> Arc<FakeHost> {
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(json!({
            "baseDbPath":root.join("db"),
            "neo":{"enabled":false},
            "temporalContext":{"enabled":temporal},
            "namespaces":{"activeWriteNamespace":"current"}
        }))
        .unwrap(),
    ));
    // 2026-01-13T12:00:00Z, the parity clock.
    host.set_now_ms(1_768_305_600_000);
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    host.set_workspace(&"agent".parse().unwrap(), workspace);
    host
}

fn seeded(root: &Path, engine: &ProcessEngine) -> (Arc<Store>, MemoryRow) {
    let identity = engine.embedding().identities().remove(0);
    let vector = engine
        .embedding()
        .embed(
            &["synthetic project archive".into()],
            EmbedKind::Query,
            &identity,
            &Cancel::never(),
        )
        .unwrap()
        .remove(0);
    seeded_with(root, engine, vector)
}

fn seeded_with(root: &Path, engine: &ProcessEngine, vector: Vec<f32>) -> (Arc<Store>, MemoryRow) {
    let space = engine.embedding().identities().remove(0).space.unwrap();
    let width = space.dimension.as_u64().unwrap() as usize;
    let store = Arc::new(Store::create(&root.join("db/current/agent"), &space, width).unwrap());
    let mut row = adopt_tests::row(vector);
    row.category = "decision".into();
    row.text = "The synthetic project archive keeps one fixture decision.".into();
    store.upsert(std::slice::from_ref(&row)).unwrap();
    (store, row)
}

fn recall(engine: &ProcessEngine, params: &Value) -> Value {
    methods::dispatch(engine, "engine.recall", params, &Cancel::never()).unwrap()
}

fn block<'a>(value: &'a Value, name: &str) -> &'a Value {
    value["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["name"] == name)
        .unwrap()
}

#[test]
fn normal_recall_renders_the_selected_memory_and_records_mood_through_the_process() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root, false);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let (store, row) = seeded(root, &engine);
    let before = serde_json::to_value(store.get(&row.id).unwrap()).unwrap();

    let result = recall(&engine, &params("synthetic project archive", "user"));
    let names = result["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|block| block["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        ["neo", "start", "memories", "time", "temporal", "reminder"],
        "{result}"
    );
    assert_eq!(result["degraded"], Value::Null, "{result}");
    assert_eq!(result["capChars"], json!(17000));
    assert_eq!(result["deferrals"], json!([]));
    // The pinned Node recall never returns its internal decision trace.
    assert!(result.get("trace").is_none());
    let memories = block(&result, "memories")["text"].as_str().unwrap();
    assert!(
        memories.contains(&format!("id=\"{}\"", row.id)),
        "{memories}"
    );
    assert!(memories.contains("<relevant-memories untrusted=\"true\""));
    assert_eq!(
        block(&result, "time")["text"],
        "<time-context>\nFirst activity. Current time: 2026-01-13 13:00 Europe/Zurich (UTC 2026-01-13 12:00).\n</time-context>"
    );
    assert_eq!(block(&result, "temporal")["text"], "");
    // Recall reads rows; it does not rewrite them.
    assert_eq!(
        serde_json::to_value(store.get(&row.id).unwrap()).unwrap(),
        before
    );
    // The bound mood store persists the turn's emotion in the caller's workspace.
    assert!(root.join("workspace/.emotional-state.json").is_file());
    let events = host.events();
    assert!(events
        .iter()
        .any(|(name, payload)| name == "recall.completed"
            && payload["agentId"] == "agent"
            && payload["degraded"].is_null()));
    assert!(!engine.status().ready);
    // Model readiness may take precedence in status(); the composed baseline names capture.
    assert_eq!(
        engine.status.degraded.clone().unwrap().capability,
        "capture",
        "recall is served once a store is configured"
    );
}

#[test]
fn the_temporal_block_follows_configuration() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root, true), Some(Seam::FlatEmbedder)).unwrap();
    seeded(root, &engine);
    let result = recall(&engine, &params("synthetic project archive", "user"));
    let temporal = block(&result, "temporal")["text"].as_str().unwrap();
    assert!(temporal.starts_with("<temporal-context>\nCurrent local time: "));
    assert!(temporal.contains("Previous user-visible turn: none\nGap bucket: new_session"));
}

#[test]
fn disabled_workspace_internal_turns_and_short_prompts_answer_empty_without_store_work() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root, false);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    for params in [
        params("synthetic project archive", "system"),
        params("hey", "user"),
    ] {
        let result = recall(&engine, &params);
        assert_eq!(result["blocks"], json!([]));
        assert_eq!(result["degraded"], Value::Null);
    }
    assert!(!root.join("db").exists());
    assert!(!root.join("workspace/.emotional-state.json").exists());

    let context = crate::context::RequestContext::build(
        &serde_json::from_value(params("x", "user")["query"]["principal"].clone()).unwrap(),
        &serde_json::from_value(params("x", "user")["query"]["agent"].clone()).unwrap(),
        host.as_ref(),
    )
    .unwrap();
    crate::ops::workspace_policy::PolicyStore::new(&root.join("db"))
        .unwrap()
        .set(
            &json!({"agentId":"agent","workspaceIdentity":context.workspace_key,
            "expectedRevision":0,"enabled":false,"actorId":"system"}),
            10_000,
        )
        .unwrap();
    // A corrupt private root would fail any lease. The policy must decide first.
    fs::write(root.join("db/current"), "not a directory").unwrap();
    let result = recall(&engine, &params("synthetic project archive", "user"));
    assert_eq!(result["blocks"], json!([]));
    assert_eq!(result["degraded"], Value::Null);
    assert!(!root.join("workspace/.emotional-state.json").exists());
}

#[test]
fn cancelled_and_closed_normal_recall_never_reads_or_writes() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root, false);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    seeded(root, &engine);
    let cancelled = Cancel::never();
    cancelled.cancel();
    let result = methods::dispatch(
        &engine,
        "engine.recall",
        &params("synthetic project archive", "user"),
        &cancelled,
    )
    .unwrap();
    assert_eq!(result["degraded"]["reason"], "aborted");
    assert_eq!(result["blocks"], json!([]));
    assert!(!root.join("workspace/.emotional-state.json").exists());
    engine.close(None).unwrap();
    let error = methods::dispatch(
        &engine,
        "engine.recall",
        &params("synthetic project archive", "user"),
        &Cancel::never(),
    )
    .unwrap_err();
    assert_eq!((error.error, error.reason), ("E_NOT_AVAILABLE", "closed"));
}

#[test]
fn weak_hits_fail_closed_while_query_refinement_is_not_ported() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let engine = ProcessEngine::new(host(root, false), Some(Seam::FlatEmbedder)).unwrap();
    let identity = engine.embedding().identities().remove(0);
    // Opposite the flat query at twice its length: score 1/(1+9) is below autoRecallMinScore,
    // so the pin would refine the query.
    let vector = engine
        .embedding()
        .embed(
            &["synthetic project archive".into()],
            EmbedKind::Query,
            &identity,
            &Cancel::never(),
        )
        .unwrap()
        .remove(0)
        .into_iter()
        .map(|value| -2. * value)
        .collect();
    seeded_with(root, &engine, vector);
    let error = methods::dispatch(
        &engine,
        "engine.recall",
        &params("synthetic project archive", "user"),
        &Cancel::never(),
    )
    .unwrap_err();
    assert_eq!(
        (error.error, error.reason),
        ("E_NOT_AVAILABLE", "operation-unavailable")
    );
}
