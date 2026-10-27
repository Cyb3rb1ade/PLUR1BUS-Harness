#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::contract::VectorSpaceIdentity;
use plur1bus_engine::store::{IdentityStatus, OpenMode, RowFilter, Store, StoreSchemaVersion};
use std::path::PathBuf;
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v1")
}
fn copied_fixture(name: &str) -> tempfile::TempDir {
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
    temporary
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
