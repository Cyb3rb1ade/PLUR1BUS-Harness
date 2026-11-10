//! Actual process opening must reconcile interrupted deletion before admission.
#![allow(clippy::unwrap_used, reason = "synthetic fixture failures are fatal")]
use super::*;
use crate::{
    contract::testing::FakeHost,
    store::{tombstone::TombstoneRegistry, Store},
    text::json::{parse_json, write_json},
};

#[test]
fn first_process_open_recovers_the_active_writer_and_repeats_without_extra_records() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let golden: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/ops/golden/reconcile.json"
    ))
    .unwrap();
    let host = Arc::new(FakeHost::new(temp.path().join("state"), serde_json::from_value(json!({
        "baseDbPath":base, "namespaces":{"activeWriteNamespace":"current",
        "activeRecallNamespaces":["current"], "legacyReadOnlyNamespaces":["legacy"], "crossNamespaceRecall":true}
    })).unwrap()));
    host.set_now_ms(golden["now"].as_i64().unwrap());
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    assert!(!base.exists());
    let identity = engine.embedding().identities().remove(0);
    let width = identity.dimensions.as_u64().unwrap() as usize;
    for (namespace, status) in [("current", "deleted"), ("legacy", "active")] {
        let store = Store::create(
            &base.join(namespace).join("agent"),
            identity.space.as_ref().unwrap(),
            width,
        )
        .unwrap();
        let mut row = adopt_tests::row(vec![0.; width]);
        row.id = golden["cases"][0]["before"][0]["memoryId"]
            .as_str()
            .unwrap()
            .into();
        row.status = status.into();
        store.upsert(&[row]).unwrap();
    }
    let registry = TombstoneRegistry::new(&base, "agent").unwrap();
    registry
        .append(&parse_json(&golden["cases"][0]["before"][0].to_string()).unwrap())
        .unwrap();
    let agent = serde_json::from_value(json!("agent")).unwrap();
    for _ in 0..2 {
        let handle = engine.open(&agent).unwrap();
        let rows: Vec<Value> = registry
            .read(false)
            .unwrap()
            .tombstones
            .iter()
            .map(|row| serde_json::from_str(&write_json(row)).unwrap())
            .collect();
        assert_eq!(Value::Array(rows), golden["cases"][0]["after"]);
        (handle.close)().unwrap();
    }
    // A configured base serves recall and capture (RE-D154); models still load lazily.
    assert!(engine.status().ready);
    assert_eq!(engine.models().status().embedder.state, ModelState::Loading);
    engine.close(None).unwrap();
}
#[test]
fn corrupt_registry_blocks_open_without_creating_an_agent_and_a_fixed_retry_works() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({"baseDbPath":base})).unwrap(),
    ));
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let registry = TombstoneRegistry::new(&base, "agent").unwrap();
    std::fs::create_dir_all(registry.path().parent().unwrap()).unwrap();
    std::fs::write(registry.path(), b"broken-record\n").unwrap();
    let agent = serde_json::from_value(json!("agent")).unwrap();
    assert!(engine.open(&agent).is_err());
    assert!(!base.join("agent").exists());
    assert_eq!(serde_json::to_value(engine.status()).unwrap()["agents"], 0);
    assert_eq!(std::fs::read(registry.path()).unwrap(), b"broken-record\n");
    std::fs::write(registry.path(), b"").unwrap();
    let handle = engine.open(&agent).unwrap();
    assert!(base.join("agent/memories.lance").is_dir());
    (handle.close)().unwrap();
    engine.close(None).unwrap();
}

#[test]
fn shutdown_during_the_startup_clock_prevents_registry_publication() {
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let base = temp.path().join("db");
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({"baseDbPath":base})).unwrap(),
    ));
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let identity = engine.embedding().identities().remove(0);
    let width = identity.dimensions.as_u64().unwrap() as usize;
    let space = identity.space.unwrap();
    let store = Store::create(&base.join("agent"), &space, width).unwrap();
    let golden: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/ops/golden/reconcile.json"
    ))
    .unwrap();
    let mut row = adopt_tests::row(vec![0.; width]);
    row.id = golden["cases"][0]["before"][0]["memoryId"]
        .as_str()
        .unwrap()
        .into();
    row.status = "deleted".into();
    store.upsert(&[row]).unwrap();
    let registry = TombstoneRegistry::new(&base, "agent").unwrap();
    registry
        .append(&parse_json(&golden["cases"][0]["before"][0].to_string()).unwrap())
        .unwrap();
    let before = std::fs::read(registry.path()).unwrap();
    let cancel = Cancel::never();
    let clock_cancel = cancel.clone();
    let stores = Arc::new(EngineStores::new(
        host.config(),
        Some(base.clone()),
        space,
        identity.fingerprint_id,
        Arc::new(move || {
            clock_cancel.cancel();
            1_800_000_000_000
        }),
        cancel,
    ));
    let agent = serde_json::from_value(json!("new-agent")).unwrap();
    assert!(matches!(
        stores.open(&agent),
        Err(EngineError::Cancelled(_))
    ));
    assert_eq!(std::fs::read(registry.path()).unwrap(), before);
    assert!(!base.join("new-agent").exists());
    assert_eq!(stores.count(), 0);
    stores.close().unwrap();
    engine.close(None).unwrap();
}
#[test]
fn startup_recovery_marker_binds_s5_source_and_unchanged_vectors() {
    use sha2::{Digest, Sha256};
    let marker: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/ops/process-recovery-native-exceptions.json"
    ))
    .unwrap();
    let sources: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/ops/s5-sources.json")).unwrap();
    assert_eq!(marker["sourceCommit"], sources["commit"]);
    assert_eq!(marker["sourceTreeSha256"], sources["treeSha256"]);
    assert_eq!(
        marker["goldenSha256"],
        format!(
            "{:x}",
            Sha256::digest(include_bytes!(
                "../../tests/fixtures/ops/golden/reconcile.json"
            ))
        )
    );
}
