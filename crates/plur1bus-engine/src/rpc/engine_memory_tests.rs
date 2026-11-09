//! Exercise the configured native memory reader through typed engine dispatch.
#![allow(clippy::unwrap_used, reason = "isolated fixture errors are fatal")]

use super::*;
use crate::{contract::testing::FakeHost, rpc::methods, store::Store};
use std::path::Path;

const LIVE: &str = "11111111-1111-4111-8111-111111111111";
const FOREIGN: &str = "22222222-2222-4222-8222-222222222222";

fn engine(state: &Path, base: &Path) -> ProcessEngine {
    let host = Arc::new(FakeHost::new(
        state.to_owned(),
        serde_json::from_value(json!({
            "baseDbPath": base,
            "namespaces": {"activeWriteNamespace":"current"}
        }))
        .unwrap(),
    ));
    host.set_now_ms(10_000);
    ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap()
}

fn params() -> Value {
    json!({"p":{"agentId":"agent","workspace":"workspace:v1:fixture","channel":"cli",
        "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"inferred"},
        "a":{"origin":"user","background":false}})
}

#[test]
fn memory_reads_use_the_configured_existing_writer_and_filter_foreign_cards() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let state = temp.path().join("state");
    let base = temp.path().join("db");
    let engine = engine(&state, &base);
    let identity = engine.embedding().identities().remove(0).space.unwrap();
    let width = identity.dimension.as_u64().unwrap() as usize;
    let store = Store::create(&base.join("current/agent"), &identity, width).unwrap();
    let mut live = adopt_tests::row(vec![1.; width]);
    live.created_at = 2_000.into();
    let mut foreign = live.clone();
    foreign.id = FOREIGN.into();
    foreign.agent_id = "other".into();
    store.upsert(&[live, foreign]).unwrap();

    let call =
        |method: &str, params: &Value| methods::dispatch(&engine, method, params, &Cancel::never());
    let mut request = params();
    request["q"] = json!({"since":0});
    let list = call("engine.memory.list", &request).unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["items"][0]["id"], LIVE);

    let mut request = params();
    request["id"] = json!(LIVE);
    assert_eq!(call("engine.memory.show", &request).unwrap()["id"], LIVE);
    request["id"] = json!(FOREIGN);
    let foreign_error = call("engine.memory.show", &request).unwrap_err();
    request["id"] = json!("33333333-3333-4333-8333-333333333333");
    assert_eq!(
        call("engine.memory.show", &request).unwrap_err(),
        foreign_error
    );
    let state_result = call("engine.memory.state", &params()).unwrap();
    assert_eq!(state_result["cards"]["agentPrivate"], 1);
    assert_eq!(engine.status().agents, 0.into());
    assert!(!state.exists());

    engine.close(None).unwrap();
    assert_eq!(
        call("engine.memory.state", &params()).unwrap_err().reason,
        "closed"
    );
}

#[test]
fn empty_named_namespace_read_leaves_the_missing_store_root_absent() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let state = temp.path().join("state");
    let base = temp.path().join("db");
    let engine = engine(&state, &base);
    let mut request = params();
    request["q"] = json!({"since":0});
    let result =
        methods::dispatch(&engine, "engine.memory.list", &request, &Cancel::never()).unwrap();
    assert_eq!(result["items"], json!([]));
    assert!(!base.exists());
    assert!(!state.exists());
}

#[test]
fn named_writer_leaf_reads_only_the_authenticated_shared_user_pool() {
    use crate::context::{harness_user_principal, user_pool_key, RequestContext};
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db/current");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({
            "baseDbPath":base,"namespaces":{"activeWriteNamespace":"current"}
        }))
        .unwrap(),
    ));
    host.set_now_ms(10_000);
    let owner = harness_user_principal("synthetic-owner");
    let foreign = harness_user_principal("synthetic-other");
    let mut request = params();
    let agent: AgentId = "agent".parse().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    host.set_workspace(&agent, workspace);
    let context = RequestContext::build(
        &serde_json::from_value(request["p"].clone()).unwrap(),
        &serde_json::from_value(request["a"].clone()).unwrap(),
        host.as_ref(),
    )
    .unwrap();
    request["p"]["workspace"] = json!(context.workspace_key);
    request["p"]["trust"] = json!("proved");
    request["p"]["channel"] = json!("telegram");
    request["p"]["user"] = json!(owner);
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let identity = engine.embedding().identities().remove(0).space.unwrap();
    let width = identity.dimension.as_u64().unwrap() as usize;
    let pool = temp
        .path()
        .join("db/.plur1bus-shared/users")
        .join(user_pool_key(&owner));
    let store = Store::create(&pool, &identity, width).unwrap();
    let mut row = adopt_tests::row(vec![1.; width]);
    row.scope = "user".into();
    row.owner_user_id = owner;
    row.created_at = 2_000.into();
    store.upsert(&[row]).unwrap();
    request["q"] = json!({"since":0});
    let call = |params: &Value| {
        methods::dispatch(&engine, "engine.memory.list", params, &Cancel::never()).unwrap()
    };
    assert_eq!(call(&request)["items"][0]["id"], LIVE);
    request["p"]["user"] = json!(foreign);
    assert_eq!(call(&request)["items"], json!([]));
    assert!(!base.exists());
    assert!(!temp
        .path()
        .join("db/.plur1bus-shared/users")
        .join(user_pool_key(&foreign))
        .exists());
}

#[test]
fn explicit_generation_does_not_fall_back_to_the_legacy_root() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("legacy-db");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({
            "baseDbPath":base,
            "reembedding":{"activeGeneration":"candidate","fingerprintId":format!("embedding:v1:sha256:{}", "a".repeat(64)), "dimensions":384}
        }))
        .unwrap(),
    ));
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    assert!(matches!(
        engine.open(&"agent".parse().unwrap()),
        Err(EngineError::Store(StoreError::IdentityMismatch))
    ));
    let mut request = params();
    request["q"] = json!({"since":0});
    assert!(methods::dispatch(&engine, "engine.memory.list", &request, &Cancel::never()).is_err());
    assert!(!base.exists());
}

#[test]
fn validated_generation_routes_reads_and_open_to_the_selected_root() {
    for generation_id in ["selected", "current"] {
        check_generation(generation_id);
    }
}

fn check_generation(generation_id: &str) {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db/current");
    let state = temp.path().join("state");
    let control = engine(&state, &base);
    let envelope = control.embedding().identities().remove(0);
    let identity = envelope.space.as_ref().unwrap();
    let width = envelope.dimensions.as_u64().unwrap() as usize;
    let generation = temp.path().join("db/generations").join(generation_id);
    let active = generation.join("current");
    let legacy = Store::create(&base.join("agent"), identity, width).unwrap();
    let selected = Store::create(&active.join("agent"), identity, width).unwrap();
    let mut row = adopt_tests::row(vec![1.; width]);
    row.created_at = 2_000.into();
    row.text = "Legacy generation".into();
    legacy.upsert(std::slice::from_ref(&row)).unwrap();
    row.text = "Selected generation".into();
    selected.upsert(&[row]).unwrap();

    let config = json!({"baseDbPath":base,"namespaces":{"activeWriteNamespace":"current"},
        "reembedding":{"activeGeneration":generation_id,"fingerprintId":envelope.fingerprint_id,"dimensions":width}});
    let manifest_path = generation.join("generation.json");
    let mut manifest = json!({
        "schemaVersion":1,"generation":generation_id,"fingerprintId":"mismatched",
        "dimensions":width,"tables":{"agent/memories":{"sourceVersion":"1","sourceRows":1,"writtenRows":1}}
    });
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let host = Arc::new(FakeHost::new(
        state,
        serde_json::from_value(config).unwrap(),
    ));
    host.set_now_ms(10_000);
    let process = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    assert!(matches!(
        process.open(&"new-agent".parse().unwrap()),
        Err(EngineError::Store(StoreError::IdentityMismatch))
    ));
    assert!(!active.join("new-agent").exists());
    manifest["fingerprintId"] = json!(envelope.fingerprint_id);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let mut request = params();
    request["id"] = json!(LIVE);
    let result =
        methods::dispatch(&process, "engine.memory.show", &request, &Cancel::never()).unwrap();
    assert_eq!(result["text"], "Selected generation");
    let handle = process.open(&"new-agent".parse().unwrap()).unwrap();
    assert!(active.join("new-agent/memories.lance").is_dir());
    assert!(!base.join("new-agent").exists());
    assert_eq!(legacy.get(LIVE).unwrap().unwrap().text, "Legacy generation");
    (handle.close)().unwrap();

    #[cfg(unix)]
    {
        let generations = generation.parent().unwrap();
        let moved = temp.path().join("displaced");
        std::fs::rename(generations, &moved).unwrap();
        std::fs::create_dir(generations).unwrap();
        std::fs::rename(moved.join(generation_id), &generation).unwrap();
        assert!(
            methods::dispatch(&process, "engine.memory.show", &request, &Cancel::never()).is_err()
        );
        assert!(process.open(&"other".parse().unwrap()).is_err());
        assert!(!active.join("other").exists());
    }
}

#[test]
fn process_forget_archives_the_active_writer_and_replays_the_same_tombstone() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let state = temp.path().join("state");
    let base = temp.path().join("db");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let host = Arc::new(FakeHost::new(
        state.clone(),
        serde_json::from_value(json!({
            "baseDbPath": base,
            "namespaces": {"activeWriteNamespace":"current","legacyReadOnlyNamespaces":["legacy"],"crossNamespaceRecall":true}
        }))
        .unwrap(),
    ));
    host.set_workspace(&"agent".parse().unwrap(), workspace.clone());
    host.set_now_ms(10_000);
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let identity = engine.embedding().identities().remove(0).space.unwrap();
    let width = identity.dimension.as_u64().unwrap() as usize;
    let active = Store::create(&base.join("current/agent"), &identity, width).unwrap();
    let legacy = Store::create(&base.join("legacy/agent"), &identity, width).unwrap();
    let mut row = adopt_tests::row(vec![1.; width]);
    row.created_at = 2_000.into();
    row.text = "The active writer's card".into();
    let mut foreign = row.clone();
    foreign.id = FOREIGN.into();
    foreign.agent_id = "other".into();
    let foreign_status = foreign.status.clone();
    active.upsert(&[row.clone(), foreign]).unwrap();
    row.text = "Legacy copy kept on disk".into();
    legacy.upsert(&[row]).unwrap();

    let call =
        |method, request: &Value| methods::dispatch(&engine, method, request, &Cancel::never());
    let mut request = params();
    request["id"] = json!(LIVE);
    let first = call("engine.memory.forget", &request).unwrap();
    assert_eq!(first["archived"], true);
    assert_eq!(first["alreadyForgotten"], false);
    let receipt = uuid::Uuid::parse_str(first["tombstoneId"].as_str().unwrap()).unwrap();
    assert_eq!(receipt.get_version_num(), 4);
    assert_eq!(
        call("engine.memory.show", &request).unwrap_err().reason,
        "not-found"
    );
    let repeated = call("engine.memory.forget", &request).unwrap();
    assert_eq!(repeated["alreadyForgotten"], true);
    assert_eq!(repeated["tombstoneId"], first["tombstoneId"]);

    request["id"] = json!(FOREIGN);
    assert_eq!(
        call("engine.memory.forget", &request).unwrap_err().reason,
        "not-found"
    );
    assert_eq!(active.get(FOREIGN).unwrap().unwrap().status, foreign_status);
    assert_eq!(
        legacy.get(LIVE).unwrap().unwrap().text,
        "Legacy copy kept on disk"
    );
    let archive = std::fs::read_dir(state.join("memory/_archive/agent"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(archive.len(), 1);
    let card: Value = serde_json::from_slice(&std::fs::read(&archive[0]).unwrap()).unwrap();
    assert_eq!(card["text"], "The active writer's card");
    let ledger = crate::store::tombstone::TombstoneRegistry::new(&base, "agent").unwrap();
    assert!(ledger.find_by_origin(LIVE, false).unwrap().is_some());
    assert!(workspace
        .join(".adaptive-learning/destructive-ops.jsonl")
        .is_file());
}

#[test]
fn process_forget_retracts_shared_rows_only_for_the_original_sharer() {
    use crate::{
        context::{harness_user_principal, RequestContext},
        store::{shared_pool::SharedPool, shared_row::ShareMetadata},
    };
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let state = temp.path().join("state");
    let base = temp.path().join("db");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let host = Arc::new(FakeHost::new(
        state.clone(),
        serde_json::from_value(json!({"baseDbPath":base})).unwrap(),
    ));
    host.set_workspace(&"agent".parse().unwrap(), workspace.clone());
    host.set_workspace(&"other".parse().unwrap(), workspace);
    host.set_now_ms(10_000);
    let mut request = params();
    let owner = harness_user_principal("synthetic-owner");
    let context = RequestContext::build(
        &serde_json::from_value(request["p"].clone()).unwrap(),
        &serde_json::from_value(request["a"].clone()).unwrap(),
        host.as_ref(),
    )
    .unwrap();
    request["p"]["workspace"] = json!(context.workspace_key);
    request["p"]["trust"] = json!("proved");
    request["p"]["channel"] = json!("telegram");
    request["p"]["user"] = json!(owner);
    request["id"] = json!(LIVE);
    let context = RequestContext::build(
        &serde_json::from_value(request["p"].clone()).unwrap(),
        &serde_json::from_value(request["a"].clone()).unwrap(),
        host.as_ref(),
    )
    .unwrap();
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let identity = engine.embedding().identities().remove(0).space.unwrap();
    let width = identity.dimension.as_u64().unwrap() as usize;
    let pool = SharedPool::open(&base, &identity, 4).unwrap();
    let shared = pool.writable(&context, MemoryShareTarget::User).unwrap();
    let mut row = adopt_tests::row(vec![1.; width]);
    row.created_at = 2_000.into();
    row.scope = "user".into();
    row.owner_user_id = owner;
    row.stored_by = "agent".into();
    shared
        .upsert_shared(
            &[(
                row,
                ShareMetadata {
                    source_memory_id: FOREIGN.into(),
                    source_agent_id: "agent".into(),
                    ..ShareMetadata::default()
                },
            )],
            &base,
        )
        .unwrap();
    let call =
        |method, request: &Value| methods::dispatch(&engine, method, request, &Cancel::never());
    let mut other = request.clone();
    other["p"]["agentId"] = json!("other");
    assert_eq!(call("engine.memory.show", &other).unwrap()["id"], LIVE);
    assert_eq!(
        call("engine.memory.forget", &other).unwrap_err().reason,
        "denied"
    );
    assert!(!state.exists());
    let forgotten = call("engine.memory.forget", &request).unwrap();
    assert_eq!(
        forgotten,
        json!({"id":LIVE,"archived":true,"tombstoneId":null,"alreadyForgotten":false})
    );
    assert_eq!(
        call("engine.memory.show", &other).unwrap_err().reason,
        "not-found"
    );
}
