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
    host_with(root, &json!({"temporalContext":{"enabled":temporal}}))
}

fn host_with(root: &Path, extra: &Value) -> Arc<FakeHost> {
    let mut config = json!({
        "baseDbPath":root.join("db"),
        "neo":{"enabled":false},
        "namespaces":{"activeWriteNamespace":"current"}
    });
    for (key, value) in extra.as_object().unwrap() {
        config[key] = value.clone();
    }
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(config).unwrap(),
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
    // The frozen status text keeps composition-pending/recall until the engine is ready.
    assert!(!engine.status().ready);
    assert_eq!(engine.status.degraded.clone().unwrap().capability, "recall");
    // A1 counts exactly the rendered card.
    let stats = crate::store::recall_stats::RecallStats::new(&root.join("db"))
        .unwrap()
        .read("agent", None, &Cancel::never())
        .unwrap();
    assert_eq!(
        stats
            .iter()
            .map(|counter| (counter.id.as_str(), counter.recalls))
            .collect::<Vec<_>>(),
        [(row.id.as_str(), 1)]
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
    let announced = host.events().len();
    let result = recall(&engine, &params("synthetic project archive", "user"));
    assert_eq!(result["blocks"], json!([]));
    assert_eq!(result["degraded"], Value::Null);
    assert!(!root.join("workspace/.emotional-state.json").exists());
    // The pin returns before its scheduler: a disabled workspace announces nothing.
    assert_eq!(host.events().len(), announced);
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
    // The pin's entry abort announces only the degradation, and nothing is counted.
    let names = host
        .events()
        .into_iter()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    assert_eq!(names, ["recall.degraded"]);
    assert!(!root.join("db/_recall-stats").exists());
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

fn params_for(agent: &str, query: &str) -> Value {
    let mut params = params(query, "user");
    params["query"]["principal"]["agentId"] = json!(agent);
    params
}

fn memories(result: &Value) -> String {
    block(result, "memories")["text"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn a_foreign_or_corrupt_mood_file_is_neither_used_nor_overwritten() {
    for contents in [
        "not json".to_owned(),
        json!({"agentId":"other","ownership":{"version":1},"state":{"current":{}}}).to_string(),
    ] {
        let scratch =
            tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let root = scratch.path();
        let host = host(root, false);
        let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
        let (_, row) = seeded(root, &engine);
        let file = root.join("workspace/.emotional-state.json");
        fs::write(&file, &contents).unwrap();
        let result = recall(&engine, &params("synthetic project archive", "user"));
        assert_eq!(result["degraded"], Value::Null);
        let text = memories(&result);
        assert!(text.contains(&row.id), "{text}");
        // No mood, so no style directive; the file stays exactly as it was.
        assert!(!text.contains("Schreibe"), "{text}");
        assert_eq!(fs::read_to_string(&file).unwrap(), contents);
        assert!(!root.join("workspace/.current-mood.txt").exists());
    }
}

#[test]
fn rows_of_other_agents_owners_and_workspaces_are_never_rendered() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    // Until query refinement is ported, an empty authorized result would fail closed.
    let host = host_with(
        root,
        &json!({"recall":{"queryRefinement":{"enabled":false}}}),
    );
    let second = root.join("second");
    fs::create_dir(&second).unwrap();
    host.set_workspace(&"agent2".parse().unwrap(), second);
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let (store, visible) = seeded(root, &engine);
    let derive = |id: &str, edit: &dyn Fn(&mut MemoryRow)| {
        let mut row = visible.clone();
        row.id = id.into();
        edit(&mut row);
        row
    };
    let other_agent = derive("22222222-2222-4222-8222-222222222222", &|row| {
        row.agent_id = "agent2".into();
    });
    let other_owner = derive("33333333-3333-4333-8333-333333333333", &|row| {
        row.scope = "user".into();
        row.owner_user_id = format!("user:v1:{}", "c".repeat(64));
    });
    let other_workspace = derive("44444444-4444-4444-8444-444444444444", &|row| {
        row.scope = "workspace".into();
        row.workspace_key = format!("workspace:v1:{}", "d".repeat(64));
    });
    store
        .upsert(&[
            other_agent.clone(),
            other_owner.clone(),
            other_workspace.clone(),
        ])
        .unwrap();
    let text = memories(&recall(
        &engine,
        &params("synthetic project archive", "user"),
    ));
    assert!(text.contains(&visible.id), "{text}");
    for hidden in [&other_agent, &other_owner, &other_workspace] {
        assert!(!text.contains(&hidden.id), "{text}");
    }

    // A second agent of the same caller reads its own writer table only, and still
    // never sees a row that table holds for the first agent.
    let space = engine.embedding().identities().remove(0).space.unwrap();
    let width = space.dimension.as_u64().unwrap() as usize;
    let foreign = Store::create(&root.join("db/current/agent2"), &space, width).unwrap();
    let planted = derive("55555555-5555-4555-8555-555555555555", &|_| {});
    foreign.upsert(std::slice::from_ref(&planted)).unwrap();
    let result = recall(&engine, &params_for("agent2", "synthetic project archive"));
    let text = memories(&result);
    for hidden in [&visible, &planted, &other_agent] {
        assert!(!text.contains(&hidden.id), "{text}");
    }
}

#[test]
fn a_forgotten_card_is_not_rendered() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    // Until query refinement is ported, an empty authorized result would fail closed.
    let host = host_with(
        root,
        &json!({"recall":{"queryRefinement":{"enabled":false}}}),
    );
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let (_, row) = seeded(root, &engine);
    let query = params("synthetic project archive", "user");
    assert!(memories(&recall(&engine, &query)).contains(&row.id));
    let forget = json!({"id":row.id,"p":query["query"]["principal"],"a":query["query"]["agent"]});
    methods::dispatch(&engine, "engine.memory.forget", &forget, &Cancel::never()).unwrap();
    let result = recall(&engine, &query);
    assert_eq!(result["degraded"], Value::Null);
    assert!(!memories(&result).contains(&row.id));
}

#[test]
fn a_clipped_memories_block_announces_its_deferral() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host_with(root, &json!({"recall":{"memoriesMaxChars":200}}));
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    seeded(root, &engine);
    let result = recall(&engine, &params("synthetic project archive", "user"));
    let deferral = result["deferrals"][0].clone();
    assert_eq!(deferral["kind"], "clipped", "{result}");
    assert_eq!(deferral["reason"], "memories-cap");
    let clipped = host
        .events()
        .into_iter()
        .filter(|(name, _)| name == "recall.block-clipped")
        .map(|(_, payload)| payload)
        .collect::<Vec<_>>();
    let mut expected = deferral.as_object().unwrap().clone();
    expected.insert("agentId".into(), json!("agent"));
    assert_eq!(clipped, [Value::Object(expected)]);
}

#[test]
fn store_and_neo_failures_after_admission_degrade_with_events() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root, false);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let (_, row) = seeded(root, &engine);
    // A Neo state root that is not a directory is a failed source, not an absent one.
    fs::write(root.join("db/_neo"), "not a directory").unwrap();
    let result = recall(&engine, &params("synthetic project archive", "user"));
    assert_eq!(
        result["degraded"],
        json!({"reason":"error","capability":"recall","detail":"recall failed"})
    );
    assert_eq!(result["blocks"], json!([]));
    assert!(!result.to_string().contains(&row.id));
    let names = host
        .events()
        .into_iter()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    assert_eq!(names, ["recall.degraded", "recall.completed"]);
}
