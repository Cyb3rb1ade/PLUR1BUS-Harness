//! Actual process composition, with synthetic isolated stores and no model I/O.
#![allow(clippy::unwrap_used, reason = "synthetic fixture failures are fatal")]
use super::*;
use crate::contract::testing::FakeHost;

fn agent(name: &str) -> AgentId {
    serde_json::from_value(json!(name)).unwrap()
}
fn count(engine: &ProcessEngine) -> Value {
    serde_json::to_value(engine.status()).unwrap()["agents"].clone()
}
#[test]
fn open_is_lazy_reuses_the_writer_and_close_is_idempotent() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({"baseDbPath":base})).unwrap(),
    ));
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    assert!(!base.exists());
    let first = engine.open(&agent("first")).unwrap();
    assert_eq!(first.agent_id, agent("first"));
    assert!(base.join("first/memories.lance").is_dir());
    let second = engine.open(&agent("first")).unwrap();
    assert_eq!(count(&engine), 1);
    (first.close)().unwrap();
    (first.close)().unwrap();
    assert_eq!(count(&engine), 0);
    let reopened = engine.open(&agent("first")).unwrap();
    (first.close)().unwrap();
    assert_eq!(count(&engine), 1);
    let other = engine.open(&agent("other")).unwrap();
    assert_eq!(count(&engine), 2);
    // A configured base serves recall and capture (RE-D154); models still load lazily.
    assert!(engine.status().ready);
    assert_eq!(engine.models().status().embedder.state, ModelState::Loading);
    engine.close(None).unwrap();
    assert_eq!(count(&engine), 0);
    assert!(engine.open(&agent("after-close")).is_err());
    assert!(!base.join("after-close").exists());
    for handle in [second, reopened, other] {
        (handle.close)().unwrap();
    }
    engine.close(None).unwrap();
    assert_eq!(count(&engine), 0);
}
#[test]
fn invalid_agents_and_missing_config_never_create_roots() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    for config in [json!({}), json!({"baseDbPath":base})] {
        let missing = config.get("baseDbPath").is_none();
        let host = Arc::new(FakeHost::new(
            temp.path().join("state"),
            serde_json::from_value(config).unwrap(),
        ));
        let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
        for name in ["a.b".to_owned(), "a:b".to_owned(), "a".repeat(65)] {
            assert!(engine.open(&agent(&name)).is_err());
        }
        if missing {
            assert!(engine.open(&agent("valid")).is_err());
        }
        assert!(!base.exists());
        assert_eq!(count(&engine), 0);
    }
}

#[test]
fn named_writer_keeps_legacy_absent_and_config_is_a_constructor_snapshot() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({
        "baseDbPath":base,"namespaces":{"activeWriteNamespace":"current",
        "activeRecallNamespaces":["current"],"legacyReadOnlyNamespaces":["legacy"],
        "crossNamespaceRecall":true}}))
        .unwrap(),
    ));
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    assert!(!base.exists());
    host.set_config(
        serde_json::from_value(json!({"baseDbPath":temp.path().join("changed")})).unwrap(),
    );
    let handle = engine.open(&agent("first")).unwrap();
    assert!(base.join("current/first/memories.lance").is_dir());
    assert!(!base.join("legacy").exists());
    assert!(!temp.path().join("changed").exists());
    (handle.close)().unwrap();
    engine.close(None).unwrap();
}
#[cfg(unix)]
#[test]
fn replaced_root_is_rejected_without_counting_or_creating_an_agent() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({"baseDbPath":base})).unwrap(),
    ));
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let handle = engine.open(&agent("first")).unwrap();
    std::fs::rename(&base, temp.path().join("old")).unwrap();
    std::fs::create_dir(&base).unwrap();
    assert!(engine.open(&agent("other")).is_err());
    assert_eq!(count(&engine), 1);
    assert!(std::fs::read_dir(&base).unwrap().next().is_none());
    (handle.close)().unwrap();
    engine.close(None).unwrap();
}

#[test]
fn concurrent_open_and_stop_leave_no_registered_agents() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({"baseDbPath":base})).unwrap(),
    ));
    let engine = Arc::new(ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap());
    let gate = std::sync::Barrier::new(5);
    std::thread::scope(|scope| {
        for i in 0..4 {
            let engine = &engine;
            let gate = &gate;
            scope.spawn(move || {
                gate.wait();
                match engine.open(&agent(&format!("agent-{i}"))) {
                    Ok(handle) => {
                        (handle.close)().unwrap();
                    }
                    Err(EngineError::NotAvailable { reason }) => assert_eq!(reason, "closed"),
                    Err(EngineError::Cancelled(_)) => {
                        assert!(engine.closed.load(Ordering::Acquire))
                    }
                    Err(error) => assert!(
                        matches!(error, EngineError::NotAvailable { .. }),
                        "unexpected open failure: {error}"
                    ),
                }
            });
        }
        gate.wait();
        engine.close(None).unwrap();
    });
    assert_eq!(count(&engine), 0);
    assert!(engine.open(&agent("later")).is_err());
    assert!(!base.join("later").exists());
}
#[test]
fn native_lifecycle_exception_binds_the_original_node_source() {
    let marker: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/ops/process-store-native-exceptions.json"
    ))
    .unwrap();
    let sources: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/recall/namespace-sources.json"
    ))
    .unwrap();
    assert_eq!(marker["sourceCommit"], sources["runtime"]["commit"]);
    assert_eq!(
        marker["sourceSha256"],
        sources["runtime"]["sha256"]["engine/create-engine.js"]
    );
}
