#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::contract::VectorSpaceIdentity;
use plur1bus_engine::store::{IdentityStatus, OpenMode, RowFilter, Store, StoreSchemaVersion};
use std::path::PathBuf;
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v1")
}
struct Scratch {
    _guard: tempfile::TempDir,
    path: PathBuf,
}
impl Scratch {
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}
fn copied_fixture(name: &str) -> Scratch {
    fn copy(source: &std::path::Path, target: &std::path::Path) {
        std::fs::create_dir_all(target).unwrap();
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let destination = target.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &destination);
            } else {
                std::fs::copy(entry.path(), destination).unwrap();
            }
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    copy(&fixture().with_file_name(name), temporary.path());
    let path = temporary.path().canonicalize().unwrap();
    Scratch {
        _guard: temporary,
        path,
    }
}
fn identity() -> VectorSpaceIdentity {
    serde_json::from_str(&std::fs::read_to_string(fixture().join("identity.json")).unwrap())
        .unwrap()
}
#[test]
fn the_fixture_opens_and_lists_twelve_rows() {
    let temporary = copied_fixture("store-v1");
    let store = Store::open(temporary.path(), OpenMode::ReadOnly, Some(&identity())).unwrap();
    assert_eq!(store.schema_version(), StoreSchemaVersion::V1);
    assert!(matches!(store.identity_status(), IdentityStatus::Verified));
    assert_eq!(store.count(&RowFilter::default()).unwrap(), 12);
    assert_eq!(store.scan(&RowFilter::default(), 100).unwrap().len(), 12);
    assert_eq!(
        store.schema_text(),
        std::fs::read_to_string(fixture().join("schema.txt")).unwrap()
    );
}
#[test]
fn a_node_row_cut_inside_an_emoji_reads_back_as_u_fffd() {
    let temporary = copied_fixture("store-surrogate");
    let store = Store::open(temporary.path(), OpenMode::ReadOnly, None).unwrap();
    let rows = store.scan(&RowFilter::default(), 2).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].text.ends_with('\u{fffd}'),
        "captured text must end at the Arrow UTF-8 replacement boundary"
    );
}

fn writable() -> (Scratch, Store) {
    let temporary = copied_fixture("store-v1");
    let store = Store::open(temporary.path(), OpenMode::ReadWrite, Some(&identity())).unwrap();
    (temporary, store)
}
fn appended_rows(store: &Store) -> Vec<plur1bus_engine::contract::MemoryRow> {
    let prototype = store.scan(&RowFilter::default(), 1).unwrap().remove(0);
    (0..5)
        .map(|index| {
            let mut row = prototype.clone();
            row.id = format!("10000000-0000-4000-8000-{:012}", index + 1);
            row.text = format!("Rust committed fact {index}");
            row
        })
        .collect()
}
fn node(arguments: &[&str]) -> serde_json::Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let result = std::process::Command::new("node")
        .arg(root.join("crates/plur1bus-engine/tests/node/roundtrip-check.mjs"))
        .args(arguments)
        .current_dir(root.join("packages/core"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Node round trip failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
#[test]
fn rust_appends_and_node_reads_them_back() {
    let (temporary, store) = writable();
    let rows = appended_rows(&store);
    store.upsert(&rows).unwrap();
    let result = node(&[temporary.path().to_str().unwrap(), "17"]);
    assert_eq!(result["identityStatus"], "verified");
    for row in rows {
        assert!(result["ids"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(row.id)));
    }
}
#[test]
fn node_appends_and_rust_reads_them_back() {
    let (temporary, store) = writable();
    store.upsert(&appended_rows(&store)).unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = std::process::Command::new("node")
        .arg(root.join("crates/plur1bus-engine/tests/fixtures/store-v1/make.mjs"))
        .args(["--append", temporary.path().to_str().unwrap()])
        .current_dir(root.join("packages/core"))
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(store.count(&RowFilter::default()).unwrap(), 22);
    assert!(store
        .get("20000000-0000-4000-8000-000000000005")
        .unwrap()
        .is_some());
}
#[test]
fn a_write_is_visible_only_after_commit() {
    let (temporary, first) = writable();
    let second = Store::open(temporary.path(), OpenMode::ReadOnly, None).unwrap();
    assert_eq!(second.count(&RowFilter::default()).unwrap(), 12);
    first.upsert(&appended_rows(&first)).unwrap();
    assert_eq!(second.count(&RowFilter::default()).unwrap(), 17);
}
#[test]
fn read_only_refuses_writes() {
    let temporary = copied_fixture("store-v1");
    let store = Store::open(temporary.path(), OpenMode::ReadOnly, None).unwrap();
    assert!(matches!(
        store.upsert(&appended_rows(&store)),
        Err(plur1bus_engine::contract::StoreError::ReadOnly)
    ));
    assert!(matches!(
        store.delete(&["10000000-0000-4000-8000-000000000001"]),
        Err(plur1bus_engine::contract::StoreError::ReadOnly)
    ));
}
#[test]
fn an_identity_mismatch_refuses_read_write_and_allows_read_only() {
    let temporary = copied_fixture("store-v1");
    let mut wrong = identity();
    wrong.model.push_str("-wrong");
    assert!(matches!(
        Store::open(temporary.path(), OpenMode::ReadWrite, Some(&wrong)),
        Err(plur1bus_engine::contract::StoreError::IdentityMismatch)
    ));
    assert!(matches!(
        Store::open(temporary.path(), OpenMode::ReadOnly, Some(&wrong))
            .unwrap()
            .identity_status(),
        IdentityStatus::Mismatch { .. }
    ));
}
#[test]
fn the_distance_is_the_squared_l2_of_lance() {
    let (_temporary, store) = writable();
    let mut rows = appended_rows(&store);
    rows.truncate(2);
    rows[0].vector = vec![0.; 384];
    rows[0].vector[1] = 1.;
    rows[1].vector = vec![0.; 384];
    rows[1].vector[0] = -1.;
    store.upsert(&rows).unwrap();
    let filter = RowFilter {
        ids: Some(rows.iter().map(|row| row.id.clone()).collect()),
        ..RowFilter::default()
    };
    let mut query = vec![0.; 384];
    query[0] = 1.;
    let found = store.search(&query, 2, &filter).unwrap();
    assert_eq!(found[0].row.id, rows[0].id);
    assert_eq!(found[0].distance, 2.);
    assert_eq!(found[1].row.id, rows[1].id);
    assert_eq!(found[1].distance, 4.);
}
#[test]
fn search_orders_by_distance_and_honours_the_filter() {
    let (_temporary, store) = writable();
    let mut rows = appended_rows(&store);
    rows.truncate(2);
    rows[0].agent_id = "filtered".into();
    rows[1].agent_id = "filtered".into();
    rows[0].vector = vec![0.; 384];
    rows[0].vector[1] = 1.;
    rows[1].vector = vec![0.; 384];
    rows[1].vector[0] = 1.;
    store.upsert(&rows).unwrap();
    let filter = RowFilter {
        agent_id: Some("filtered".into()),
        ..RowFilter::default()
    };
    let mut query = vec![0.; 384];
    query[0] = 1.;
    let found = store.search(&query, 20, &filter).unwrap();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].row.id, rows[1].id);
    let patch = plur1bus_engine::store::RowPatch {
        text: Some("Patched Rust text".into()),
        ..Default::default()
    };
    store.patch(&rows[1].id, &patch).unwrap();
    assert_eq!(
        store.get(&rows[1].id).unwrap().unwrap().text,
        "Patched Rust text"
    );
    assert_eq!(store.delete(&[&rows[1].id]).unwrap(), 1);
    assert_eq!(store.count(&filter).unwrap(), 1);
}

#[test]
fn a_derived_lexical_table_and_index_do_not_change_the_node_reader() {
    use std::sync::Arc;
    let (temporary, store) = writable();
    store.upsert(&appended_rows(&store)).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let connection = lancedb::connect(temporary.path().to_str().unwrap())
            .execute()
            .await
            .unwrap();
        let schema = Arc::new(arrow_schema::Schema::new(vec![
            arrow_schema::Field::new("id", arrow_schema::DataType::Utf8, true),
            arrow_schema::Field::new("terms", arrow_schema::DataType::Utf8, true),
        ]));
        let batch = arrow_array::RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(arrow_array::StringArray::from(vec!["derived"])),
                Arc::new(arrow_array::StringArray::from(vec![
                    "fixture lexical terms",
                ])),
            ],
        )
        .unwrap();
        let table = connection
            .create_table(
                "_lexical",
                arrow_array::RecordBatchIterator::new(vec![Ok(batch)], schema),
            )
            .execute()
            .await
            .unwrap();
        table
            .create_index(&["terms"], lancedb::index::Index::FTS(Default::default()))
            .execute()
            .await
            .unwrap();
    });
    assert_eq!(
        node(&[temporary.path().to_str().unwrap(), "17"])["identityStatus"],
        "verified"
    );
    assert_eq!(store.arrow_schema().fields().len(), 69);
}
#[test]
fn the_sync_store_boundary_is_safe_inside_another_tokio_runtime() {
    let temporary = copied_fixture("store-v1");
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let store = Store::open(temporary.path(), OpenMode::ReadOnly, None).unwrap();
        assert_eq!(store.count(&RowFilter::default()).unwrap(), 12);
        drop(store);
    });
}
#[test]
fn filters_quote_node_literals_and_parse_the_same_suffix_grammar() {
    use plur1bus_engine::store::filter::sql_string;
    assert_eq!(sql_string("O'Brien\\archive"), "'O''Brien\\\\archive'");
    let parsed=RowFilter::parse("Projekt Müller cat:Work aus:chat wichtig:0.7junk seit:2026-01-01 bis:2026-01-02 mood:neutral");
    assert!(parsed.errors.is_empty());
    assert_eq!(parsed.topic, "Projekt Müller");
    assert_eq!(parsed.filter.category.as_deref(), Some("work"));
    assert_eq!(parsed.filter.origin.as_deref(), Some("dm"));
    assert_eq!(parsed.filter.min_importance, Some(0.7));
    assert_eq!(parsed.filter.since, Some(1767225600000));
    assert_eq!(parsed.filter.until, Some(1767398399999));
    let ambiguous = RowFilter::parse("topic from:chat cat:work");
    assert_eq!(ambiguous.topic, "topic from:chat");
    assert_eq!(ambiguous.errors.len(), 1);
    assert_eq!(
        RowFilter {
            ids: Some(vec!["bad' OR true".into()]),
            ..Default::default()
        }
        .to_sql(),
        "false"
    );
}

#[test]
fn create_writes_the_identity_row_the_node_engine_expects() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().canonicalize().unwrap().join("base/a1");
    let store = Store::create(&path, &identity(), 384).unwrap();
    assert_eq!(store.count(&RowFilter::default()).unwrap(), 0);
    assert_eq!(store.schema_version(), StoreSchemaVersion::V1);
    assert_eq!(
        node(&[path.to_str().unwrap(), "0"])["identityStatus"],
        "verified"
    );
    let fixture = copied_fixture("store-v1");
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for table in ["memories.lance", "_embedding_identity.lance"] {
            let rust = lance::Dataset::open(path.join(table).to_str().unwrap())
                .await
                .unwrap();
            let node = lance::Dataset::open(fixture.path().join(table).to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(
                rust.manifest().data_storage_format,
                node.manifest().data_storage_format,
                "storage version differs for {table}"
            );
            assert_eq!(
                rust.manifest_location().naming_scheme,
                node.manifest_location().naming_scheme,
                "manifest naming differs for {table}"
            );
            assert_eq!(
                rust.manifest().reader_feature_flags,
                node.manifest().reader_feature_flags,
                "reader flags differ for {table}"
            );
            assert_eq!(
                rust.manifest().writer_feature_flags,
                node.manifest().writer_feature_flags,
                "writer flags differ for {table}"
            );
            let rust_connection = lancedb::connect(path.to_str().unwrap())
                .execute()
                .await
                .unwrap();
            let node_connection = lancedb::connect(fixture.path().to_str().unwrap())
                .execute()
                .await
                .unwrap();
            let name = table.trim_end_matches(".lance");
            assert_eq!(
                rust_connection
                    .open_table(name)
                    .execute()
                    .await
                    .unwrap()
                    .list_indices()
                    .await
                    .unwrap()
                    .len(),
                node_connection
                    .open_table(name)
                    .execute()
                    .await
                    .unwrap()
                    .list_indices()
                    .await
                    .unwrap()
                    .len(),
                "index options differ for {table}"
            );
        }
    });
}
#[test]
fn a_legacy_store_without_version_reports_legacy0() {
    let temporary = copied_fixture("store-v1");
    std::fs::remove_file(temporary.path().join("_schema.json")).unwrap();
    assert_eq!(
        Store::open(temporary.path(), OpenMode::ReadOnly, None)
            .unwrap()
            .schema_version(),
        StoreSchemaVersion::Legacy0
    );
}
#[test]
fn a_missing_read_only_store_is_not_created() {
    let temporary = tempfile::tempdir().unwrap();
    let missing = temporary.path().join("absent");
    assert!(Store::open(&missing, OpenMode::ReadOnly, None).is_err());
    assert!(!missing.exists());
}
#[cfg(unix)]
#[test]
fn a_symlinked_store_directory_is_refused() {
    let fixture = copied_fixture("store-v1");
    let temporary = tempfile::tempdir().unwrap();
    let alias = temporary.path().join("alias");
    std::os::unix::fs::symlink(fixture.path(), &alias).unwrap();
    assert!(matches!(
        Store::open(&alias, OpenMode::ReadOnly, None),
        Err(plur1bus_engine::contract::StoreError::UntrustedPath)
    ));
}
