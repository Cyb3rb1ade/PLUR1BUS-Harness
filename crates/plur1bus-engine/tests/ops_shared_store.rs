//! Real Node shared-pool schema/provenance, retained without changing the RPC row contract.
#![allow(
    clippy::unwrap_used,
    reason = "physical schema fixtures fail immediately"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::{MemoryRow, StoreError},
    embedding::EmbeddingProvider,
    recall::hash_embed::HashEmbedder,
    store::{
        shared_row::ShareMetadata,
        tombstone::{content_fingerprint, TombstoneRegistry},
        OpenMode, RowFilter, RowPatch, Store,
    },
    text::json::parse_json,
};
use serde_json::{json, Value};
use std::path::PathBuf;
fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/shared-store.json")).unwrap()
}
fn schema(store: &Store) -> Value {
    Value::Array(
        store
            .arrow_schema()
            .fields()
            .iter()
            .map(|f| {
                let text = match f.data_type() {
                    arrow_schema::DataType::Utf8 => "Utf8".into(),
                    arrow_schema::DataType::LargeUtf8 => "LargeUtf8".into(),
                    arrow_schema::DataType::Float64 => "Float64".into(),
                    arrow_schema::DataType::Boolean => "Bool".into(),
                    arrow_schema::DataType::FixedSizeList(_, dim) => {
                        format!("FixedSizeList[{dim}]<Float32>")
                    }
                    other => format!("{other:?}"),
                };
                json!({"name":f.name(),"type":text,"nullable":f.is_nullable()})
            })
            .collect(),
    )
}
fn metadata(value: &Value) -> ShareMetadata {
    serde_json::from_value(json!({"sourceMemoryId":value["sourceMemoryId"],"sourceAgentId":value["sourceAgentId"],"shareIdempotencyKey":value["shareIdempotencyKey"],"shareProvenance":value["shareProvenance"]})).unwrap()
}
fn row(value: &Value) -> MemoryRow {
    let mut value = value.clone();
    let fields = value.as_object_mut().unwrap();
    for field in [
        "sourceMemoryId",
        "sourceAgentId",
        "shareIdempotencyKey",
        "shareProvenance",
    ] {
        fields.remove(field);
    }
    fields.insert("id".into(), json!("00000000-0000-4000-8000-000000000002"));
    serde_json::from_value(value).unwrap()
}
#[test]
fn opens_actual_node_shared_columns_read_only_and_preserves_origin() {
    let golden = golden();
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ops/shared-store-node");
    let store = Store::open(&path, OpenMode::ReadOnly, None).unwrap();
    assert_eq!(schema(&store), golden["expected"]["schema"]);
    let rows = store.scan(&RowFilter::default(), 10).unwrap();
    assert_eq!(rows.len(), 1);
    let record = store.get_record(&rows[0].id).unwrap().unwrap();
    assert_eq!(
        record.sharing.as_ref().unwrap(),
        &metadata(&golden["expected"]["row"])
    );
    assert_eq!(
        record.origin(),
        Some((
            "agent".into(),
            golden["expected"]["original"]["id"]
                .as_str()
                .unwrap()
                .into()
        ))
    );
    let mut actual = serde_json::to_value(record.row).unwrap();
    actual["id"] = json!("00000000-0000-4000-8000-000000000002");
    let mut expected = serde_json::to_value(row(&golden["expected"]["row"])).unwrap();
    numbers(&mut actual);
    numbers(&mut expected);
    assert_eq!(actual, expected);
    assert_eq!(
        store
            .memory_records(None, Some((0., 1_900_000_000_000.)), 5, 1_800_000_000_000)
            .unwrap()[0]
            .0
            .sharing,
        record.sharing
    );
}
#[test]
fn rust_shared_writes_keep_node_schema_and_fence_original_tombstones() {
    let golden = golden();
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let path = base.join("shared");
    let mut store = Store::create_shared(&path, &identity, 4).unwrap();
    assert_eq!(schema(&store), golden["expected"]["schema"]);
    store.ensure_shared_columns().unwrap();
    assert_eq!(schema(&store), golden["expected"]["schema"]);
    let row = row(&golden["expected"]["row"]);
    let sharing = metadata(&golden["expected"]["row"]);
    store
        .upsert_shared(&[(row.clone(), sharing.clone())], &base)
        .unwrap();
    assert!(
        store.upsert(std::slice::from_ref(&row)).is_err(),
        "ordinary upsert must not erase sharing columns"
    );
    store
        .patch(
            &row.id,
            &RowPatch {
                retrieval_count: Some(2.),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        store.get_record(&row.id).unwrap().unwrap().sharing,
        Some(sharing.clone())
    );
    drop(store);
    let store = Store::open(&path, OpenMode::ReadWrite, Some(&identity)).unwrap();
    assert_eq!(
        store.get_record(&row.id).unwrap().unwrap().sharing,
        Some(sharing.clone())
    );
    let registry = TombstoneRegistry::new(&base, "agent").unwrap();
    let tombstone = json!({"schemaVersion":1,"memoryId":sharing.source_memory_id,"canonicalOriginId":sharing.source_memory_id,"agentId":"agent","storedBy":"agent","scope":"agent-private","status":"committed","contentFingerprint":content_fingerprint("changed original text")});
    registry
        .append(&parse_json(&tombstone.to_string()).unwrap())
        .unwrap();
    assert!(matches!(
        store.upsert_shared(&[(row, sharing)], &base),
        Err(StoreError::TombstoneBlocked)
    ));
}

fn numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(values) => values.iter_mut().for_each(numbers),
        Value::Object(values) => values.values_mut().for_each(numbers),
        _ => {}
    }
}
