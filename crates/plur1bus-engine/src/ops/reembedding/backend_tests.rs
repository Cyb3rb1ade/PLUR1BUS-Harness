#![allow(clippy::unwrap_used, reason = "real Lance reembedding fixtures")]
use super::*;
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn config(root: &Path) -> BackendConfig {
    BackendConfig {
        state_root: root.join("state"),
        active_root: root.join("active"),
        active_shared_base: root.join("active"),
        namespace: None,
        active_generation: "active".into(),
        active_selection: json!({"mode":"generation","generation":"active"}),
        active_fingerprint: json!({"provider":"openai","model":"synthetic-source","dimensions":3}),
        active_secret_ref: None,
        config_revision: None,
    }
}
fn schema(nested: bool) -> SchemaRef {
    let opaque = if nested {
        DataType::Struct(
            vec![
                Arc::new(Field::new("label", DataType::Utf8, true)),
                Arc::new(Field::new(
                    "flags",
                    DataType::List(Arc::new(Field::new("item", DataType::Boolean, true))),
                    true,
                )),
            ]
            .into(),
        )
    } else {
        DataType::Utf8
    };
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, true),
        Field::new("status", DataType::Utf8, true),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 3),
            true,
        ),
        Field::new("createdAt", DataType::Float64, true),
        Field::new("validFrom", DataType::Float64, true),
        Field::new("validUntil", DataType::Float64, true),
        Field::new("opaque", opaque, true),
    ]))
}
fn fixture() -> Json {
    parse_json(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-backend.json"
    ))
    .unwrap()
}
#[test]
fn actual_node_metadata_hashes_preserve_unknown_nested_and_utf16_fields() {
    let fixture = fixture();
    let Json::Array(cases) = crate::ops::import_primitives::field(&fixture, "hashes").unwrap()
    else {
        unreachable!()
    };
    assert_eq!(cases.len(), 10);
    for c in cases {
        let row = crate::ops::import_primitives::field(c, "row").unwrap();
        assert_eq!(
            stable_non_vector_hash(row).unwrap(),
            super::super::state_json::get_text(c, "hash").unwrap()
        );
    }
}
#[test]
fn actual_lance_replay_repairs_float32_manifest_and_nested_metadata() {
    let fixture = fixture();
    let backend_cases: Value = serde_json::from_str(&write_json(
        crate::ops::import_primitives::field(&fixture, "backend").unwrap(),
    ))
    .unwrap();
    for case in backend_cases.as_array().unwrap() {
        let root = root();
        let config = config(root.path());
        let cancel = Cancel::never();
        let access = MigrationAccess::new().unwrap();
        let nested = case["name"] == "nested-arrow-metadata";
        let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ops/reembedding-stores")
            .join(case["name"].as_str().unwrap());
        let source_path = config.active_root.join("agent-a");
        copy_tree(&fixture_root, &source_path);
        let before = tree_digests(&source_path);
        let source = access
            .open(&source_path, "memories", OpenMode::ReadOnly, &cancel)
            .unwrap();
        let version = source.version(&cancel).unwrap();
        let backend = GenerationBackend::new(config).unwrap();
        let inventory = backend.inventory(&cancel).unwrap();
        let source_rows = backend
            .read_source("agent-a/memories", 0, 8, &cancel)
            .unwrap();
        backend
            .create_generation(
                "target",
                Some("synthetic-fingerprint"),
                2,
                inventory[0]["tables"].as_array().unwrap(),
                None,
                &cancel,
            )
            .unwrap();
        let migrated = source_rows
            .iter()
            .map(|r| {
                let mut r = r.clone();
                r["vector"] = case["vector"].clone();
                r
            })
            .collect::<Vec<_>>();
        assert_eq!(
            backend
                .write_target("target", "agent-a/memories", &migrated, &cancel)
                .unwrap(),
            json!({"added":1,"existing":0})
        );
        if case["interruptManifest"] == true {
            let mut m = backend.describe("target", &cancel).unwrap();
            m["tables"]["agent-a/memories"]["writtenRows"] = json!(0);
            backend.save("target", &m).unwrap();
        }
        assert_eq!(
            backend
                .write_target("target", "agent-a/memories", &migrated, &cancel)
                .unwrap(),
            json!({"added":0,"existing":1})
        );
        assert_eq!(
            backend.describe("target", &cancel).unwrap()["tables"]["agent-a/memories"]
                ["writtenRows"],
            1
        );
        let ids = source_rows
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let actual = backend
            .read_target("target", "agent-a/memories", &ids, &cancel)
            .unwrap();
        if !nested {
            assert_eq!(
                normalize(&parse_json(&json!(actual).to_string()).unwrap(), 0).unwrap(),
                normalize(&parse_json(&case["readback"].to_string()).unwrap(), 0).unwrap(),
                "{}",
                case["name"]
            );
        }
        assert_eq!(
            row_hash(&actual[0]).unwrap(),
            row_hash(&source_rows[0]).unwrap()
        );
        assert_eq!(
            backend.validate("target", &cancel).unwrap(),
            json!({"tables":1,"rows":1,"dimensions":2})
        );
        let hits = backend
            .search("target", "agent-a/memories", &[0.25, 0.5], 5, &cancel)
            .unwrap();
        assert!(hits.iter().any(|row| row["id"] == source_rows[0]["id"]));
        let mut overflow = migrated.clone();
        overflow[0]["vector"] = json!([1e300, 0.5]);
        assert_eq!(
            backend
                .write_target("target", "agent-a/memories", &overflow, &cancel)
                .unwrap_err(),
            BackendError::Invalid
        );
        assert_eq!(source.version(&cancel).unwrap(), version);
        assert_eq!(tree_digests(&source_path), before);
        let mut conflict = migrated.clone();
        conflict[0]["text"] = json!("changed metadata");
        assert_eq!(
            backend
                .write_target("target", "agent-a/memories", &conflict, &cancel)
                .unwrap_err(),
            BackendError::Conflict
        );
        backend.close().unwrap();
        assert_eq!(
            backend.inventory(&cancel).unwrap_err(),
            BackendError::Closed
        );
    }
}
#[test]
fn namespace_and_shared_partitions_keep_identity_and_empty_schemas() {
    let root = root();
    let mut config = config(root.path());
    config.namespace = Some("space-a".into());
    config.active_root = config.active_root.join("space-a");
    let access = MigrationAccess::new().unwrap();
    let cancel = Cancel::never();
    access
        .create(
            &config.active_root.join("agent-a"),
            "memories",
            schema(false),
            &cancel,
        )
        .unwrap();
    let key = format!("w-{}", "a".repeat(62));
    let shared = config
        .active_shared_base
        .join(".plur1bus-shared/workspaces")
        .join(&key);
    access
        .create(&shared, "memories", schema(false), &cancel)
        .unwrap();
    let backend = GenerationBackend::new(config).unwrap();
    let inventory = backend.inventory(&cancel).unwrap();
    assert_eq!(inventory[0]["tables"].as_array().unwrap().len(), 2);
    let mismatched = json!({"provider":"openai","model":"synthetic-target","dimensions":3});
    assert_eq!(
        backend
            .create_generation(
                "mismatched",
                Some("synthetic"),
                2,
                inventory[0]["tables"].as_array().unwrap(),
                Some(&mismatched),
                &cancel
            )
            .unwrap_err(),
        BackendError::Invalid
    );
    assert!(!root.path().join("state/generations/mismatched").exists());
    let identity = json!({"provider":"openai","model":"synthetic-target","dimensions":2});
    let manifest = backend
        .create_generation(
            "target",
            Some("synthetic"),
            2,
            inventory[0]["tables"].as_array().unwrap(),
            Some(&identity),
            &cancel,
        )
        .unwrap();
    assert!(manifest["identityId"].as_str().unwrap().len() == 64);
    for path in [
        root.path().join("state/generations/target/space-a/agent-a"),
        root.path()
            .join("state/generations/target/.plur1bus-shared/workspaces")
            .join(&key),
    ] {
        let table = access
            .open(&path, "_embedding_identity", OpenMode::ReadOnly, &cancel)
            .unwrap();
        let rows = table.read(0, 2, None, &cancel).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["identityId"], manifest["identityId"]);
    }
    assert_eq!(
        backend.validate("target", &cancel).unwrap(),
        json!({"tables":2,"rows":0,"dimensions":2})
    );
    assert_eq!(
        backend
            .create_generation(
                "target",
                Some("synthetic"),
                2,
                inventory[0]["tables"].as_array().unwrap(),
                Some(&identity),
                &cancel
            )
            .unwrap_err(),
        BackendError::Exists
    );
}
#[test]
fn interrupted_empty_creation_resumes_but_wrong_schema_and_source_drift_fail() {
    let root = root();
    let config = config(root.path());
    let cancel = Cancel::never();
    let access = MigrationAccess::new().unwrap();
    let source = access
        .create(
            &config.active_root.join("agent-a"),
            "memories",
            schema(false),
            &cancel,
        )
        .unwrap();
    let backend = GenerationBackend::new(config).unwrap();
    let inventory = backend.inventory(&cancel).unwrap();
    let tables = inventory[0]["tables"].as_array().unwrap();
    let partial = root.path().join("state/generations/target/agent-a");
    access
        .create(
            &partial,
            "memories",
            target_schema(schema(false).as_ref(), 2).unwrap(),
            &cancel,
        )
        .unwrap();
    backend
        .create_generation("target", Some("synthetic"), 2, tables, None, &cancel)
        .unwrap();
    assert_eq!(backend.validate("target", &cancel).unwrap()["rows"], 0);
    let wrong = root.path().join("state/generations/wrong/agent-a");
    access
        .create(&wrong, "memories", schema(false), &cancel)
        .unwrap();
    assert_eq!(
        backend
            .create_generation("wrong", Some("synthetic"), 2, tables, None, &cancel)
            .unwrap_err(),
        BackendError::Drift
    );
    assert!(!root
        .path()
        .join("state/generations/wrong/generation.json")
        .exists());
    source.add(vec![json!({"id":"11111111-1111-4111-8111-111111111111","vector":[0.1,0.2,0.3],"opaque":null})],&cancel).unwrap();
    assert_eq!(
        backend.validate("target", &cancel).unwrap_err(),
        BackendError::Drift
    );
}
#[test]
fn cancellation_paths_held_lease_and_source_readonly_refuse_mutation() {
    let root = root();
    let config = config(root.path());
    let backend = GenerationBackend::new(config).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert_eq!(
        backend.inventory(&cancel).unwrap_err(),
        BackendError::Cancelled
    );
    assert_eq!(
        backend
            .create_generation("target", None, 2, &[], None, &cancel)
            .unwrap_err(),
        BackendError::Cancelled
    );
    assert!(!root.path().join("state").exists());
    let lease = JobLock::acquire(
        &root.path().join("state/generations"),
        "reembedding-generation",
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(
        backend
            .create_generation("target", None, 2, &[], None, &Cancel::never())
            .unwrap_err(),
        BackendError::Busy
    );
    drop(lease);
    assert!(backend
        .create_generation("../outside", None, 2, &[], None, &Cancel::never())
        .is_err());
    assert!(!root.path().join("outside").exists());
    let access = MigrationAccess::new().unwrap();
    let path = root.path().join("active/agent-a");
    access
        .create(&path, "memories", schema(false), &Cancel::never())
        .unwrap();
    let source = access
        .open(&path, "memories", OpenMode::ReadOnly, &Cancel::never())
        .unwrap();
    assert_eq!(
        source.add(vec![json!({})], &Cancel::never()).unwrap_err(),
        StoreError::ReadOnly
    );
    assert_eq!(
        source.delete("true".into(), &Cancel::never()).unwrap_err(),
        StoreError::ReadOnly
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(
            root.path().join("active"),
            root.path().join("state/generations/linked"),
        )
        .unwrap();
        assert!(backend
            .create_generation("linked", None, 2, &[], None, &Cancel::never())
            .is_err());
    }
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let kind = e.file_type().unwrap();
        assert!(!kind.is_symlink());
        let target = to.join(e.file_name());
        if kind.is_dir() {
            copy_tree(&e.path(), &target);
        } else {
            fs::copy(e.path(), target).unwrap();
        }
    }
}
fn tree_digests(root: &Path) -> BTreeMap<PathBuf, String> {
    fn visit(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, String>) {
        for e in fs::read_dir(path).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                visit(root, &e.path(), out);
            } else {
                out.insert(
                    e.path().strip_prefix(root).unwrap().to_owned(),
                    format!("{:x}", Sha256::digest(fs::read(e.path()).unwrap())),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}
#[test]
fn raw_arrow_width_validation_refuses_silent_null_conversion() {
    let root = root();
    let cancel = Cancel::never();
    let access = MigrationAccess::new().unwrap();
    let table = access
        .create(&root.path().join("raw"), "memories", schema(false), &cancel)
        .unwrap();
    let before = table.version(&cancel).unwrap();
    let invalid = json!({"id":"11111111-1111-4111-8111-111111111111","vector":[0.25,0.5]});
    assert_eq!(
        table.add(vec![invalid], &cancel).unwrap_err(),
        StoreError::Corrupt
    );
    assert_eq!(table.version(&cancel).unwrap(), before);
    assert_eq!(table.count(&cancel).unwrap(), 0);
    table
        .add(
            vec![json!({"id":"11111111-1111-4111-8111-111111111111","vector":[0.25,0.5,0.75]})],
            &cancel,
        )
        .unwrap();
    let rows = table.read(0, 1, None, &cancel).unwrap();
    for key in [
        "text",
        "status",
        "createdAt",
        "validFrom",
        "validUntil",
        "opaque",
    ] {
        assert_eq!(rows[0].get(key), Some(&Value::Null));
    }
}
