//! Foreground forget parity including persisted archives, tombstones and audit.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "contract fixtures fail immediately"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{EngineError, MemoryRow, StoreError},
    embedding::EmbeddingProvider,
    ops::{
        context::OperationContext,
        write::{MemoryWriter, MutationStores},
    },
    recall::hash_embed::HashEmbedder,
    store::{tombstone::TombstoneRegistry, Store},
    text::json::write_json,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, sync::Arc};
struct Stores(Arc<Store>);
impl MutationStores for Stores {
    fn existing_private(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
}
fn normalize(value: &mut Value, root: &str, ids: &mut BTreeMap<String, String>, key: &str) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::String(text) if key == "tombstoneId" => {
            assert!(uuid::Uuid::parse_str(text).is_ok());
            let next = format!("tombstone-{}", ids.len() + 1);
            *text = ids.entry(text.clone()).or_insert(next).clone();
        }
        Value::String(text) => *text = text.replace(root, "<work>"),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| normalize(item, root, ids, "")),
        Value::Object(fields) => fields
            .iter_mut()
            .for_each(|(key, item)| normalize(item, root, ids, key)),
        _ => {}
    }
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
fn actual_node_forget_archive_audit_and_retry_oracles() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/forget.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let state = root.path().join("state");
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        store.upsert(std::slice::from_ref(&original)).unwrap();
        let host = Arc::new(support::TestHost::new(state.clone()));
        if case["noWorkspace"] != true {
            host.set_workspace("agent", workspace.clone());
        }
        let context = Arc::new(OperationContext::new(host));
        let writer = MemoryWriter::new(context, Arc::new(Stores(store.clone())), base.clone());
        let principal = serde_json::from_value(golden["principal"].clone()).unwrap();
        let agent = serde_json::from_value(case.get("context").unwrap_or(&golden["agent"]).clone())
            .unwrap();
        if case["archiveFailure"] == true {
            fs::create_dir_all(state.join("memory")).unwrap();
            fs::write(state.join("memory/_archive"), "blocked").unwrap();
        }
        if case["auditFailure"] == true {
            fs::write(workspace.join(".adaptive-learning"), "blocked").unwrap();
        }
        let id = case["id"].as_str().unwrap_or(&original.id);
        let mut results = Vec::new();
        for index in 0..if case["repeat"] == true { 2 } else { 1 } {
            if index == 1 && case["auditFailure"] == true {
                fs::remove_file(workspace.join(".adaptive-learning")).unwrap();
            }
            results.push(
                match writer.forget_at(id, &principal, &agent, golden["now"].as_i64().unwrap()) {
                    Ok(value) => json!({"value":value}),
                    Err(EngineError::MemoryOp(error)) => json!({"error":error.code.to_string()}),
                    Err(error) => panic!("{}: {error:?}", case["name"]),
                },
            );
        }
        let registry: Vec<Value> = TombstoneRegistry::new(&base, "agent")
            .unwrap()
            .read(false)
            .unwrap()
            .tombstones
            .into_iter()
            .map(|row| serde_json::from_str(&write_json(&row)).unwrap())
            .collect();
        let archive_root = state.join("memory/_archive/agent");
        let mut archives = Vec::new();
        if archive_root.is_dir() {
            for file in fs::read_dir(&archive_root).unwrap() {
                let file = file.unwrap();
                archives.push(json!({"file":file.file_name().to_str().unwrap(),"card":serde_json::from_slice::<Value>(&fs::read(file.path()).unwrap()).unwrap()}));
            }
        }
        archives.sort_by_key(|v| v["file"].as_str().unwrap().to_owned());
        let audit_path = workspace.join(".adaptive-learning/destructive-ops.jsonl");
        let audit: Vec<Value> = if audit_path.is_file() {
            fs::read_to_string(audit_path)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        } else {
            Vec::new()
        };
        let mut actual = json!({"results":results,"row":store.get(&original.id).unwrap().unwrap(),"archives":archives,"registry":registry,"audit":audit});
        // Normalize only random tombstone UUIDs, the scratch root and numeric representation.
        normalize(
            &mut actual,
            root.path().to_str().unwrap(),
            &mut BTreeMap::new(),
            "",
        );
        let mut expected = json!({"results":case["results"],"row":case["row"],"archives":case["archives"],"registry":case["registry"],"audit":case["audit"]});
        numbers(&mut expected);
        assert_eq!(actual, expected, "{}", case["name"]);
        if case["name"] == "forget-repeat" {
            let registry = TombstoneRegistry::new(&base, "agent").unwrap();
            let last = registry.read(false).unwrap().tombstones.pop().unwrap();
            let line = write_json(&last);
            let line = format!("{},\"opaque\":\"\\ud800\"}}", &line[..line.len() - 1]);
            let path = registry
                .append(&plur1bus_engine::text::json::parse_json(&line).unwrap())
                .unwrap();
            let before = fs::read(&path).unwrap();
            let repeated = writer
                .forget_at(id, &principal, &agent, golden["now"].as_i64().unwrap())
                .unwrap();
            assert!(repeated.already_forgotten);
            assert_eq!(
                fs::read(&path).unwrap(),
                before,
                "retry must preserve opaque Node fields"
            );
        }
    }
}
