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
        Err(EngineError::NotAvailable {reason}) if reason == "generation-routing-pending"
    ));
    assert!(
        methods::dispatch(&engine, "engine.memory.state", &params(), &Cancel::never()).is_err()
    );
    assert!(!base.exists());
}
