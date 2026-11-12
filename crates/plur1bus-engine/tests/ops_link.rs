//! Source-link parity, read-only dry runs and durable per-agent provenance.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "oracle fixtures fail immediately"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{EngineError, MemoryRow, StoreError},
    embedding::EmbeddingProvider,
    ops::{
        context::OperationContext,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    recall::hash_embed::HashEmbedder,
    store::Store,
};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};
struct Stores(Arc<Store>);
impl ReadStores for Stores {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(vec![ReadSource {
            store: self.0.clone(),
            kind: SourceKind::Private,
            optional: false,
        }])
    }
}
fn put_lines(path: &Path, lines: &Value) {
    let lines = lines.as_array().unwrap();
    if lines.is_empty() {
        return;
    }
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        lines.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
}
fn read_lines(path: &Path) -> Value {
    if !path.is_file() {
        return json!([]);
    }
    Value::Array(
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect(),
    )
}
fn numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(items) => items.iter_mut().for_each(numbers),
        Value::Object(fields) => fields.values_mut().for_each(numbers),
        _ => {}
    }
}
#[test]
fn actual_node_links_never_change_cards_and_follow_receipt_state() {
    use sha2::{Digest, Sha256};
    let bytes = include_bytes!("fixtures/ops/golden/link.json");
    let golden: Value = serde_json::from_slice(bytes).unwrap();
    let exception: Value =
        serde_json::from_str(include_str!("fixtures/ops/link-exceptions.json")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        exception["nodeGoldenSha256"]
    );
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        store.upsert(std::slice::from_ref(&original)).unwrap();
        let before = serde_json::to_value(store.get(&original.id).unwrap().unwrap()).unwrap();
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        if case["noWorkspace"] != true {
            host.set_workspace("agent", workspace.clone());
        }
        let context = Arc::new(OperationContext::new(host));
        let reader = MemoryReader::new(
            context,
            Arc::new(Stores(store.clone())),
            Arc::new(HashEmbedder::new()),
            base.clone(),
        );
        let link_path = base.join("_links/agent.jsonl");
        let import_path = base.join("_imports/agent.jsonl");
        put_lines(&link_path, &case["seededLinks"]);
        put_lines(&import_path, &case["imports"]);
        for (enabled, path) in [
            (&case["ledgerFailure"], &link_path),
            (&case["importFailure"], &import_path),
        ] {
            if enabled == true {
                fs::create_dir_all(path).unwrap();
            }
        }
        if case["auditFailure"] == true {
            fs::write(workspace.join(".adaptive-learning"), "blocked").unwrap();
        }
        let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
        let agent = serde_json::from_value(case.get("context").unwrap_or(&golden["agent"]).clone())
            .unwrap();
        let request = serde_json::from_value(case["request"].clone()).unwrap();
        let mut results = Vec::new();
        for _ in 0..if case["repeat"] == true { 2 } else { 1 } {
            results.push(
                match reader.link_at(
                    case["id"].as_str().unwrap_or(&original.id),
                    &request,
                    &principal,
                    &agent,
                    golden["now"].as_i64().unwrap(),
                ) {
                    Ok(value) => json!({"value":value}),
                    Err(EngineError::MemoryOp(e)) => json!({"error":e.code.to_string()}),
                    other => panic!("{}: {other:?}", case["name"]),
                },
            );
        }
        let mut expected = case["results"].clone();
        if let Some(marker) = exception["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == case["name"])
        {
            assert_eq!(expected, marker["nodeResults"]);
            expected = marker["rustResults"].clone();
        }
        assert_eq!(json!(results), expected, "{}", case["name"]);
        for (field, path) in [
            ("links", link_path),
            ("imports", import_path),
            (
                "audit",
                workspace.join(".adaptive-learning/destructive-ops.jsonl"),
            ),
        ] {
            let mut actual = read_lines(&path);
            let mut expected = case[field].clone();
            numbers(&mut actual);
            numbers(&mut expected);
            assert_eq!(actual, expected, "{} {field}", case["name"]);
        }
        assert_eq!(
            serde_json::to_value(store.get(&original.id).unwrap().unwrap()).unwrap(),
            before,
            "{} changed the card",
            case["name"]
        );
        if case["request"]["dryRun"] == true {
            assert!(!base.join("_imports/.locks").exists());
            assert!(!base.join("_links").exists());
            assert!(!workspace.join(".adaptive-learning").exists());
        }
    }
}

#[test]
fn concurrent_links_serialize_the_last_available_slot() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/link.json")).unwrap();
    let case = &golden["cases"][0];
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    let row: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
    store.upsert(std::slice::from_ref(&row)).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("agent", workspace.clone());
    let reader = MemoryReader::new(
        Arc::new(OperationContext::new(host)),
        Arc::new(Stores(store)),
        Arc::new(HashEmbedder::new()),
        base.clone(),
    );
    let links = base.join("_links/agent.jsonl");
    put_lines(&links,&Value::Array((0..99).map(|i| json!({"v":1,"kind":"linked","linkId":format!("seed-{i}"),"cardId":row.id,"sourceRef":format!("fixture:seed-{i}"),"at":i})).collect()));
    let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
    let agent = serde_json::from_value(golden["agent"].clone()).unwrap();
    let barrier = std::sync::Barrier::new(2);
    let outcomes = std::thread::scope(|scope| {
        let handles=(0..2).map(|i| {
            let reader=&reader;let barrier=&barrier;let principal=&principal;let agent=&agent;let id=&row.id;
            scope.spawn(move || {
                let request=serde_json::from_value(json!({"sourceRef":format!("fixture:contender-{i}"),"provenance":"imported"})).unwrap();
                barrier.wait();
                match reader.link_at(id,&request,principal,agent,1_800_000_000_000) {
                    Ok(result)=>result.outcome.to_string(),
                    Err(EngineError::MemoryOp(e))=>e.code.to_string(),
                    other=>panic!("unexpected contender result {other:?}"),
                }
            })
        }).collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(outcomes.iter().filter(|s| *s == "linked").count(), 1);
    assert_eq!(outcomes.iter().filter(|s| *s == "conflict").count(), 1);
    assert_eq!(read_lines(&links).as_array().unwrap().len(), 100);
    assert_eq!(
        read_lines(&workspace.join(".adaptive-learning/destructive-ops.jsonl"))
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
