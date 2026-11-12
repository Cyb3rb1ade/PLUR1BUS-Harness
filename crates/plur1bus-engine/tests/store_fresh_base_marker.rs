//! RE-D175 (fix3): a guarded fresh store base gets the current schema marker with whatever is created in it first.
//! The pin writes the marker at engine creation; the engine process writes it at its start, and a library
//! composition with the first entry, never on a read. The public directory creators of the store layer
//! (`secure_dir`, `atomic_write`) are covered here; `create_child` and the release of the promise in the unit tests
//! of `store::schema_version`; a first job run through the library composition in `rpc::engine_jobs_tests`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::ops::rebind_ledger::RebindLedger;
use plur1bus_engine::store::atomic_write::atomic_write;
use plur1bus_engine::store::ledger::JsonlLedger;
use plur1bus_engine::store::paths::secure_dir;
use plur1bus_engine::store::schema_version::{guard_base, read_base, StoreSchemaVersion};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::Duration;

/// Every base-level entry the engine creates before any store exists.
const ENTRIES: [&str; 9] = [
    "_jobs",
    "_links",
    "_imports",
    "_rebinds",
    "_capture-turns",
    "_capture-admissions",
    "_neo",
    "_recall-stats",
    "_post-turn",
];

fn marker(base: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(base.join("_schema.json")).ok()?).ok()
}

#[test]
fn guarding_a_base_writes_nothing() {
    let root = support::canonical_tempdir();
    let base = root.path().join("state/lancedb");
    guard_base(&base).unwrap();
    assert!(!base.exists());
    assert!(!root.path().join("state").exists());
}

#[test]
fn the_first_directory_in_a_fresh_base_brings_the_current_marker() {
    for entry in ENTRIES {
        let root = support::canonical_tempdir();
        let base = root.path().join("state/lancedb");
        guard_base(&base).unwrap();
        secure_dir(&base.join(entry).join("a1")).unwrap();
        let marker = marker(&base).expect(entry);
        assert_eq!(marker["schemaVersion"], "1", "{entry}");
        assert_eq!(read_base(&base).unwrap(), StoreSchemaVersion::V1, "{entry}");
    }
}

#[test]
fn the_base_itself_and_an_empty_base_are_covered_too() {
    let root = support::canonical_tempdir();
    let base = root.path().join("lancedb");
    guard_base(&base).unwrap();
    secure_dir(&base).unwrap();
    assert_eq!(marker(&base).unwrap()["schemaVersion"], "1");

    let empty = root.path().join("empty");
    fs::create_dir(&empty).unwrap();
    guard_base(&empty).unwrap();
    secure_dir(&empty.join("_links")).unwrap();
    assert_eq!(marker(&empty).unwrap()["schemaVersion"], "1");
}

#[test]
fn atomic_write_and_the_ledgers_are_covered() {
    let root = support::canonical_tempdir();
    let base = root.path().join("lancedb");
    guard_base(&base).unwrap();
    atomic_write(&base.join("_neo/state.json"), b"{}").unwrap();
    assert_eq!(marker(&base).unwrap()["schemaVersion"], "1");

    let links = root.path().join("links-base");
    guard_base(&links).unwrap();
    JsonlLedger::<Value>::open(&links.join("_links/a1.jsonl"))
        .unwrap()
        .append_durable(&json!({"v":1}))
        .unwrap();
    assert_eq!(marker(&links).unwrap()["schemaVersion"], "1");

    let rebinds = root.path().join("rebinds-base");
    guard_base(&rebinds).unwrap();
    let ledger = RebindLedger::new(&rebinds);
    let _lease = ledger
        .acquire(
            &plur1bus_engine::contract::Cancel::never(),
            Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(marker(&rebinds).unwrap()["schemaVersion"], "1");
}

#[test]
fn a_legacy_base_without_a_marker_is_never_raised_and_an_unguarded_base_is_left_alone() {
    let root = support::canonical_tempdir();
    let legacy = root.path().join("legacy");
    fs::create_dir_all(legacy.join("a1")).unwrap();
    guard_base(&legacy).unwrap();
    for entry in ENTRIES {
        secure_dir(&legacy.join(entry)).unwrap();
    }
    assert!(!legacy.join("_schema.json").exists());
    assert_eq!(read_base(&legacy).unwrap(), StoreSchemaVersion::Legacy0);

    let unguarded = root.path().join("unguarded");
    secure_dir(&unguarded.join("_jobs")).unwrap();
    assert!(!unguarded.join("_schema.json").exists());

    // An existing marker stays byte-identical.
    let current = root.path().join("current");
    fs::create_dir_all(&current).unwrap();
    fs::write(
        current.join("_schema.json"),
        br#"{"schemaVersion":"1","note":"mine"}"#,
    )
    .unwrap();
    guard_base(&current).unwrap();
    secure_dir(&current.join("_jobs")).unwrap();
    assert_eq!(
        fs::read(current.join("_schema.json")).unwrap(),
        br#"{"schemaVersion":"1","note":"mine"}"#
    );
}
