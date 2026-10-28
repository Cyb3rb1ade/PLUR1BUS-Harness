//! Persisted tombstone registry and pre-write guard parity against the pinned Node engine.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use plur1bus_engine::{
    contract::{MemoryRow, StoreError},
    store::{
        tombstone::{
            assert_card_write_allowed, assert_patch_write_allowed, content_fingerprint,
            is_content_changing_update, normalize_content_for_fingerprint, TombstoneRegistry,
        },
        RowPatch,
    },
    text::json::{parse_json, write_json, TolerantJsonValue},
};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::Command};

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn tombstone(text: &str, scope: &str) -> TolerantJsonValue {
    parse_json(
        &json!({"schemaVersion":1,"memoryId":"10000000-0000-4000-8000-000000000001",
        "canonicalOriginId":"canonical-origin","agentId":"a1","scope":scope,"workspaceId":"w1",
        "ownerUserId":"u1","status":"committed","contentFingerprint":content_fingerprint(text)})
        .to_string(),
    )
    .unwrap()
}
fn card(text: &str) -> MemoryRow {
    let schema: Value =
        serde_json::from_str(include_str!("../schema/engine-contract.schema.json")).unwrap();
    let mut fields = serde_json::Map::new();
    for (name, definition) in schema["$defs"]["MemoryRow"]["properties"]
        .as_object()
        .unwrap()
    {
        let value = match definition["type"].as_str().unwrap() {
            "string" => json!(""),
            "number" => json!(0),
            "boolean" => json!(false),
            "array" => json!([]),
            other => {
                [("array", json!([]))]
                    .into_iter()
                    .find(|(kind, _)| *kind == other)
                    .unwrap()
                    .1
            }
        };
        fields.insert(name.clone(), value);
    }
    fields.insert("id".into(), json!("10000000-0000-4000-8000-000000000001"));
    fields.insert("agentId".into(), json!("a1"));
    fields.insert("scope".into(), json!("agent-private"));
    fields.insert("text".into(), json!(text));
    serde_json::from_value(Value::Object(fields)).unwrap()
}

#[test]
fn node_reads_rust_registry_rows_and_rust_reads_node_rows_and_fingerprints() {
    let directory = scratch();
    let base = directory.path().join("lancedb");
    let registry = TombstoneRegistry::new(&base, "a1").unwrap();
    registry
        .append(&tombstone("Grüße Straße", "workspace"))
        .unwrap();
    let script = r#"
import {createRequire} from 'node:module';import path from 'node:path';import {pathToFileURL} from 'node:url';
let root;try{root=path.dirname(createRequire(path.join(process.cwd(),'package.json')).resolve('@cyb3rb1ade/plur1bus-memory/package.json'));}
catch{throw new Error('run pnpm test:prep (the engine package is not installed)');}
const api=await import(pathToFileURL(path.join(root,'lib/tombstone.js')));
const base=process.argv[1];const rows=api.readTombstonesFromRegistry(base,'a1');
const text=['\ufeff  ＡPFEL\tStraße\n🚀  ','\u0085Nicht trimmen\u0085','Mu\u0308ller café'];
const second={...rows[0],memoryId:'10000000-0000-4000-8000-000000000002',reason:'Grüße 🚀'.slice(0,7)};
api.appendTombstoneToRegistry(base,'a1',second);
console.log(JSON.stringify({count:rows.length,first:rows[0],fingerprints:text.map(api.contentFingerprint),normalized:text.map(api.normalizeContentForFingerprint)}));
"#;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(&base)
        .current_dir(root.join("packages/core"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(node["count"], 1);
    assert_eq!(
        node["first"]["contentFingerprint"],
        content_fingerprint("Grüße Straße")
    );
    let texts = [
        "\u{feff}  ＡPFEL\tStraße\n🚀  ",
        "\u{0085}Nicht trimmen\u{0085}",
        "Mu\u{0308}ller café",
    ];
    assert_eq!(json!(texts.map(content_fingerprint)), node["fingerprints"]);
    assert_eq!(
        json!(texts.map(normalize_content_for_fingerprint)),
        node["normalized"]
    );
    let read = registry.read(true).unwrap();
    assert_eq!(read.corrupt_lines, 0);
    assert_eq!(read.tombstones.len(), 2);
    assert!(write_json(&read.tombstones[1]).contains("\\ud83d"));
    let latest = registry
        .find_by_origin("canonical-origin", true)
        .unwrap()
        .unwrap();
    assert!(write_json(&latest).contains("000000000002"));
    assert!(registry
        .find_by_origin("10000000-0000-4000-8000-000000000001", true)
        .unwrap()
        .is_some());
    assert!(registry
        .find_by_fingerprint(&content_fingerprint("Grüße Straße"))
        .unwrap()
        .is_some());
}

#[test]
fn scope_principals_committed_status_and_content_changes_guard_writes() {
    let directory = scratch();
    let base = directory.path().join("lancedb");
    let registry = TombstoneRegistry::new(&base, "a1").unwrap();
    registry
        .append(&tombstone("forbidden", "workspace"))
        .unwrap();
    let mut row = card(" FORBIDDEN ");
    assert_card_write_allowed(&base, &row).unwrap();
    row.scope = "workspace".into();
    row.workspace_id = "w2".into();
    assert_card_write_allowed(&base, &row).unwrap();
    row.workspace_id = "w1".into();
    assert_eq!(
        assert_card_write_allowed(&base, &row),
        Err(StoreError::TombstoneBlocked)
    );
    registry
        .append(&tombstone("forbidden", "agent-private"))
        .unwrap();
    assert_eq!(
        assert_card_write_allowed(&base, &row),
        Err(StoreError::TombstoneBlocked),
        "newer private row must not hide the workspace tombstone"
    );
    row.scope = "user".into();
    row.owner_user_id = "u2".into();
    assert_card_write_allowed(&base, &row).unwrap();
    registry.append(&tombstone("forbidden", "user")).unwrap();
    assert_card_write_allowed(&base, &row).unwrap();
    row.owner_user_id = "u1".into();
    assert_eq!(
        assert_card_write_allowed(&base, &row),
        Err(StoreError::TombstoneBlocked)
    );

    let existing = card("kept");
    let patch = RowPatch {
        text: Some("forbidden".into()),
        scope: Some("user".into()),
        ..Default::default()
    };
    assert!(is_content_changing_update(&existing, &patch));
    assert_eq!(
        assert_patch_write_allowed(&base, &existing, &patch),
        Err(StoreError::TombstoneBlocked),
        "the existing private scope governs Node's content update guard"
    );
    let metadata = RowPatch {
        status: Some("archived".into()),
        ..Default::default()
    };
    assert!(!is_content_changing_update(&existing, &metadata));
    assert_patch_write_allowed(&base, &existing, &metadata).unwrap();

    let directory = scratch();
    let base = directory.path().join("lancedb");
    let registry = TombstoneRegistry::new(&base, "a1").unwrap();
    for status in ["attempted", "failed"] {
        let mut value: Value =
            serde_json::from_str(&write_json(&tombstone("forbidden", "agent-private"))).unwrap();
        value["status"] = json!(status);
        registry
            .append(&parse_json(&value.to_string()).unwrap())
            .unwrap();
    }
    assert_card_write_allowed(&base, &card("forbidden")).unwrap();
}

#[test]
fn torn_tail_is_quarantined_once_and_complete_invalid_rows_remain_fail_closed() {
    let directory = scratch();
    let base = directory.path().join("lancedb");
    let registry = TombstoneRegistry::new(&base, "a1").unwrap();
    registry
        .append(&tombstone("first", "agent-private"))
        .unwrap();
    let complete = fs::read(registry.path()).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(registry.path())
        .unwrap()
        .write_all(b"{\"schemaVersion\":")
        .unwrap();
    let readonly = registry.read(false).unwrap();
    assert!(readonly.torn_tail);
    assert_eq!(readonly.corrupt_lines, 1);
    let repaired = registry.read(true).unwrap();
    assert_eq!(repaired.corrupt_lines, 0);
    assert_eq!(fs::read(registry.path()).unwrap(), complete);
    let quarantine = registry.path().with_extension("corrupt.log");
    assert_eq!(fs::read(&quarantine).unwrap(), b"{\"schemaVersion\":\n");
    registry.read(true).unwrap();
    assert_eq!(fs::read(&quarantine).unwrap(), b"{\"schemaVersion\":\n");
    fs::write(registry.path(), b"{}\n{\"schemaVersion\":").unwrap();
    let corrupt = registry.read(true).unwrap();
    assert_eq!(corrupt.corrupt_lines, 2);
    assert!(!corrupt.torn_tail);
    assert_eq!(
        assert_card_write_allowed(&base, &card("anything")),
        Err(StoreError::TombstoneBlocked)
    );
    fs::write(registry.path(), b"{}").unwrap();
    let invalid = registry.read(true).unwrap();
    assert_eq!(invalid.invalid, 1);
    assert!(!invalid.torn_tail);
    let mut future: Value =
        serde_json::from_str(&write_json(&tombstone("anything", "agent-private"))).unwrap();
    future["schemaVersion"] = json!(2);
    fs::write(registry.path(), future.to_string()).unwrap();
    assert_eq!(registry.read(true).unwrap().invalid, 1);
    assert_eq!(
        assert_card_write_allowed(&base, &card("anything")),
        Err(StoreError::TombstoneBlocked)
    );
    assert_card_write_allowed(&base, &card("")).unwrap();
}

#[test]
fn append_repairs_a_torn_tail_and_registry_agent_mismatch_blocks() {
    let directory = scratch();
    let base = directory.path().join("lancedb");
    let registry = TombstoneRegistry::new(&base, "a1").unwrap();
    registry
        .append(&tombstone("first", "agent-private"))
        .unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(registry.path())
        .unwrap()
        .write_all(b"{broken")
        .unwrap();
    registry
        .append(&tombstone("second", "agent-private"))
        .unwrap();
    assert_eq!(registry.read(true).unwrap().tombstones.len(), 2);
    let mut wrong: Value =
        serde_json::from_str(&write_json(&tombstone("anything", "agent-private"))).unwrap();
    wrong["agentId"] = json!("a2");
    fs::write(registry.path(), wrong.to_string()).unwrap();
    assert_eq!(registry.read(true).unwrap().invalid, 1);
    assert_eq!(
        assert_card_write_allowed(&base, &card("anything")),
        Err(StoreError::TombstoneBlocked)
    );
}

#[test]
fn lance_writes_and_content_patches_obey_the_persisted_tombstone_guard() {
    use plur1bus_engine::store::{RowFilter, Store};
    let root = scratch();
    let base = root.path().join("base");
    let path = base.join("a1");
    let identity = serde_json::from_str(include_str!("fixtures/store-v1/identity.json")).unwrap();
    let store = Store::create(&path, &identity, 384).unwrap();
    let registry = TombstoneRegistry::new(&base, "a1").unwrap();
    registry
        .append(&tombstone("blocked content", "agent-private"))
        .unwrap();
    let mut row = card("blocked content");
    row.vector = vec![0.; 384];
    assert!(matches!(
        store.upsert(std::slice::from_ref(&row)),
        Err(StoreError::TombstoneBlocked)
    ));
    assert_eq!(store.count(&RowFilter::default()).unwrap(), 0);
    row.text = "allowed content".into();
    store.upsert(std::slice::from_ref(&row)).unwrap();
    assert!(matches!(
        store.patch(
            &row.id,
            &RowPatch {
                text: Some("blocked content".into()),
                scope: Some("user".into()),
                owner_user_id: Some("other".into()),
                ..Default::default()
            }
        ),
        Err(StoreError::TombstoneBlocked)
    ));
    store
        .patch(
            &row.id,
            &RowPatch {
                status: Some("archived".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(store.get(&row.id).unwrap().unwrap().text, "allowed content");
}

#[test]
fn blank_legacy_agent_fields_use_the_physical_namespace_only_for_the_guard() {
    use plur1bus_engine::store::Store;
    let root = scratch();
    let base = root.path().join("base");
    let path = base.join("a1");
    let identity = serde_json::from_str(include_str!("fixtures/store-v1/identity.json")).unwrap();
    let store = Store::create(&path, &identity, 384).unwrap();
    let mut row = card("allowed legacy content");
    row.agent_id.clear();
    row.stored_by.clear();
    row.vector = vec![0.; 384];
    store.upsert(std::slice::from_ref(&row)).unwrap();
    store
        .patch(
            &row.id,
            &RowPatch {
                text: Some("another allowed legacy content".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let persisted = store.get(&row.id).unwrap().unwrap();
    assert!(persisted.agent_id.is_empty() && persisted.stored_by.is_empty());
    TombstoneRegistry::new(&base, "a1")
        .unwrap()
        .append(&tombstone("blocked legacy content", "agent-private"))
        .unwrap();
    row.text = "blocked legacy content".into();
    assert!(matches!(
        store.upsert(std::slice::from_ref(&row)),
        Err(StoreError::TombstoneBlocked)
    ));
    assert!(matches!(
        store.patch(
            &row.id,
            &RowPatch {
                text: Some(row.text),
                ..Default::default()
            }
        ),
        Err(StoreError::TombstoneBlocked)
    ));
}
