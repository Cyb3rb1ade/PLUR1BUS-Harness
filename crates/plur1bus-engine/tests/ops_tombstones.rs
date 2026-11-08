//! S5a startup reconciliation against the actual frozen Node branch.
#![allow(clippy::unwrap_used, reason = "golden fixtures fail immediately")]
use plur1bus_engine::{
    contract::{Cancel, StoreError},
    ops::tombstones::{reconcile, TombstoneLookup},
    store::tombstone::TombstoneRegistry,
    text::json::{parse_json, write_json},
};
use serde_json::Value;
use std::{fs, io::Write};
#[path = "recall_support.rs"]
mod support;

struct Lookup(Value);
impl TombstoneLookup for Lookup {
    fn agent_exists(&self, _: &str) -> Result<bool, StoreError> {
        Ok(self.0["missingStore"] != true)
    }
    fn status(&self, _: &str, _: &str) -> Result<Option<String>, StoreError> {
        if self.0["readError"] == true {
            return Err(StoreError::Corrupt);
        }
        Ok(self.0["rowStatus"].as_str().map(str::to_owned))
    }
}

#[test]
fn interrupted_forgets_match_node_and_repeat_without_duplicate_commits() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/reconcile.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let base = root.path().join("lance");
        fs::create_dir(&base).unwrap();
        let registry = TombstoneRegistry::new(&base, "agent").unwrap();
        for row in case["before"].as_array().unwrap() {
            registry
                .append(&parse_json(&row.to_string()).unwrap())
                .unwrap();
        }
        if case["corrupt"] == true {
            writeln!(
                fs::OpenOptions::new()
                    .append(true)
                    .open(registry.path())
                    .unwrap(),
                "invalid-line"
            )
            .unwrap();
        }
        let lookup = Lookup(case.clone());
        let result = reconcile(
            &base,
            &lookup,
            golden["now"].as_i64().unwrap(),
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            case["report"],
            "{}",
            case["name"]
        );
        let actual: Vec<Value> = registry
            .read(false)
            .unwrap()
            .tombstones
            .into_iter()
            .map(|row| serde_json::from_str(&write_json(&row)).unwrap())
            .collect();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            case["after"],
            "{}",
            case["name"]
        );
        let second = reconcile(
            &base,
            &lookup,
            golden["now"].as_i64().unwrap(),
            &Cancel::never(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(second).unwrap(),
            case["second"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn recovery_reads_active_generation_and_preserves_unknown_utf16_metadata() {
    use plur1bus_engine::{
        embedding::EmbeddingProvider, ops::tombstones::ActiveGenerationLookup,
        recall::hash_embed::HashEmbedder, store::Store,
    };
    let root = support::canonical_tempdir();
    let base = root.path().join("original");
    let generation = root.path().join("generation");
    let provider = HashEmbedder::new();
    let store = Store::create(&generation.join("agent"), provider.identity(), 384).unwrap();
    let mut row = support::memory_row(
        "00000000-0000-4000-8000-000000000001",
        "agent",
        "agent-private",
    );
    row.status = "deleted".into();
    row.vector = vec![0.; 384];
    store.upsert(&[row.clone()]).unwrap();
    let registry = TombstoneRegistry::new(&base, "agent").unwrap();
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/reconcile.json")).unwrap();
    let mut record = golden["cases"][0]["before"][0].clone();
    record["memoryId"] = serde_json::json!(row.id);
    // Persist through the lossless record codec, not serde_json's UTF-8 string model.
    let raw = record.to_string();
    let with_unknown = format!("{},\"future\":\"\\ud800\"}}", raw.trim_end_matches('}'));
    registry
        .append(&parse_json(&with_unknown).unwrap())
        .unwrap();
    let lookup = ActiveGenerationLookup::open(&generation, provider.identity()).unwrap();
    let result = reconcile(
        &base,
        &lookup,
        golden["now"].as_i64().unwrap(),
        &Cancel::never(),
    )
    .unwrap();
    assert_eq!(result.committed.len(), 1);
    assert!(
        !base.exists(),
        "recovery must not create or read the inactive store root"
    );
    assert!(!lookup.agent_exists("missing").unwrap());
    assert!(!generation.join("missing").exists());
    let records = registry.read(false).unwrap().tombstones;
    assert_eq!(records.len(), 2);
    assert!(write_json(&records[1]).contains("\"future\":\"\\ud800\""));
    assert_eq!(store.get(&row.id).unwrap().unwrap().status, "deleted");
}

#[test]
fn cancelled_recovery_never_creates_a_registry_or_store() {
    let root = support::canonical_tempdir();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(reconcile(
        &root.path().join("absent"),
        &Lookup(serde_json::json!({})),
        0,
        &cancel
    )
    .is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}
