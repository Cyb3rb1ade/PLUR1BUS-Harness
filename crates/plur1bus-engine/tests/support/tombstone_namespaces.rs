//! Existing Node recovery vectors over actual, conflicting namespace tables.
use super::*;
use plur1bus_engine::{
    embedding::EmbeddingProvider,
    ops::tombstones::NamespaceGenerationLookup,
    recall::{hash_embed::HashEmbedder, namespaces::NamespaceStores},
    store::Store,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

fn snapshot(root: &Path) -> BTreeMap<PathBuf, String> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, String>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, out);
            } else {
                out.insert(
                    path.strip_prefix(root).unwrap().into(),
                    format!("{:x}", Sha256::digest(fs::read(path).unwrap())),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
fn put(root: &Path, provider: &HashEmbedder, id: &str, status: Option<&str>) {
    let store = Store::create(&root.join("agent"), provider.identity(), 384).unwrap();
    if let Some(status) = status {
        let mut row = support::memory_row(id, "agent", "agent-private");
        row.status = status.into();
        row.vector = vec![0.; 384];
        store.upsert(&[row]).unwrap();
    }
}
#[test]
fn recovery_uses_only_the_existing_active_writer_and_preserves_all_tables() {
    let golden: Value =
        serde_json::from_str(include_str!("../fixtures/ops/golden/reconcile.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let temp = support::canonical_tempdir();
        let registry_base = temp.path().join("registry-base");
        let tables = temp.path().join("tables");
        let provider = HashEmbedder::new();
        let active = tables.join("current");
        let legacy = tables.join("legacy");
        let row_status = case["rowStatus"].as_str();
        let id = case["before"][0]["memoryId"].as_str().unwrap();
        put(
            &legacy,
            &provider,
            id,
            Some(if row_status == Some("deleted") {
                "active"
            } else {
                "deleted"
            }),
        );
        if case["missingStore"] != true {
            if case["readError"] == true {
                fs::create_dir_all(active.join("agent/memories.lance")).unwrap();
            } else {
                put(&active, &provider, id, row_status);
            }
        }
        let config = serde_json::from_value(serde_json::json!({"namespaces":{
            "activeWriteNamespace":"current", "activeRecallNamespaces":["current"],
            "legacyReadOnlyNamespaces":["legacy"], "crossNamespaceRecall":true}}))
        .unwrap();
        let stores =
            Arc::new(NamespaceStores::open(&active, &config, provider.identity(), 8).unwrap());
        let lookup = NamespaceGenerationLookup::new(stores);
        let registry = TombstoneRegistry::new(&registry_base, "agent").unwrap();
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
        let before = snapshot(&tables);
        let result = reconcile(
            &registry_base,
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
        let after: Vec<Value> = registry
            .read(false)
            .unwrap()
            .tombstones
            .iter()
            .map(|row| serde_json::from_str(&write_json(row)).unwrap())
            .collect();
        assert_eq!(Value::Array(after), case["after"], "{}", case["name"]);
        assert_eq!(snapshot(&tables), before, "{}", case["name"]);
        assert!(!lookup.agent_exists("missing").unwrap());
        assert_eq!(lookup.status("missing", "id").unwrap(), None);
        assert!(!active.join("missing").exists());
        assert!(!registry_base.exists());
    }
}
#[cfg(unix)]
#[test]
fn namespace_lookup_retains_root_pins_for_absent_agents() {
    let temp = support::canonical_tempdir();
    let base = temp.path().join("tables");
    let provider = HashEmbedder::new();
    let config = serde_json::from_value(
        serde_json::json!({"namespaces":{"activeWriteNamespace":"current"}}),
    )
    .unwrap();
    let stores = Arc::new(NamespaceStores::open(&base, &config, provider.identity(), 8).unwrap());
    let lookup = NamespaceGenerationLookup::new(stores);
    fs::rename(&base, temp.path().join("old")).unwrap();
    fs::create_dir(&base).unwrap();
    assert!(lookup.agent_exists("missing").is_err());
    assert!(lookup.status("missing", "id").is_err());
    assert!(fs::read_dir(base).unwrap().next().is_none());
}

#[test]
fn namespace_recovery_marker_binds_unchanged_node_vectors() {
    let marker: Value = serde_json::from_str(include_str!(
        "../fixtures/ops/namespace-recovery-native-exceptions.json"
    ))
    .unwrap();
    let sources: Value =
        serde_json::from_str(include_str!("../fixtures/ops/s5-sources.json")).unwrap();
    assert_eq!(marker["sourceCommit"], sources["commit"]);
    let bytes = include_bytes!("../fixtures/ops/golden/reconcile.json");
    assert_eq!(
        marker["goldenSha256"],
        format!("{:x}", Sha256::digest(bytes))
    );
}
