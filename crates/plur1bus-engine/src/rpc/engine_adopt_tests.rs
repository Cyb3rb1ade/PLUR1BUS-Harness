//! Real ProcessEngine + embedding service + read-only Lance adoption composition.
#![allow(clippy::unwrap_used, reason = "synthetic fixtures fail immediately")]
use super::*;
use crate::{contract::testing::FakeHost, store::Store};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn snapshot(root: &Path) -> BTreeMap<PathBuf, String> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let key = path.strip_prefix(root).unwrap().to_path_buf();
            if entry.file_type().unwrap().is_dir() {
                out.insert(key, "directory".into());
                walk(root, &path, out);
            } else {
                out.insert(
                    key,
                    format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
pub(super) fn row(vector: Vec<f32>) -> MemoryRow {
    let schema: Value =
        serde_json::from_str(include_str!("../../schema/engine-contract.schema.json")).unwrap();
    let mut fields = serde_json::Map::new();
    for (name, definition) in schema["$defs"]["MemoryRow"]["properties"]
        .as_object()
        .unwrap()
    {
        fields.insert(
            name.clone(),
            match definition["type"].as_str().unwrap() {
                "string" => json!(""),
                "number" => json!(0),
                "boolean" => json!(false),
                "array" => json!([]),
                _ => Value::Null,
            },
        );
    }
    let mut row: MemoryRow = serde_json::from_value(Value::Object(fields)).unwrap();
    row.id = "11111111-1111-4111-8111-111111111111".into();
    row.agent_id = "agent".into();
    row.scope = "agent-private".into();
    row.text = "Synthetic copied-store passage".into();
    row.status = "active".into();
    row.vector = vector;
    row
}
#[test]
fn process_adoption_uses_its_real_embedding_service_and_keeps_sources_unchanged() {
    for mismatch in [false, true] {
        let scratch =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let state = scratch.path().join("not-created");
        let mut host = FakeHost::new(state.clone(), serde_json::from_value(json!({})).unwrap());
        host.set_platform(crate::rpc::platform::capabilities());
        let host = Arc::new(host);
        let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
        let identity = engine.embedding().identities().remove(0);
        let dim = identity.dimensions.as_u64().unwrap() as usize;
        let mut vector = vec![0.; dim];
        vector[usize::from(mismatch)] = 1.;
        let copy = scratch.path().join("copy");
        let store =
            Store::create(&copy.join("agent"), identity.space.as_ref().unwrap(), dim).unwrap();
        store.upsert(&[row(vector)]).unwrap();
        drop(store);
        let before = snapshot(&copy);
        let config = serde_json::to_value(host.config()).unwrap();
        for dry_run in [true, false] {
            let request: StoreAdoptRequest = serde_json::from_value(
                json!({"path":copy,"expectedIdentity":identity,"dryRun":dry_run}),
            )
            .unwrap();
            let report =
                serde_json::to_value(engine.stores().adopt(request.clone()).unwrap()).unwrap();
            assert_eq!(
                report["verdict"],
                if mismatch { "incompatible" } else { "ok" }
            );
            assert_eq!(report["identitySource"], "probe");
            if mismatch {
                assert_eq!(report["reason"], "identity-mismatch");
            }
            assert_eq!(snapshot(&copy), before);
            assert_eq!(serde_json::to_value(host.config()).unwrap(), config);
            assert!(!state.exists());
            assert!(!engine.status().ready);
        }
        // A passage probe is not the separately tracked models.warm operation.
        assert_eq!(engine.models().status().embedder.state, ModelState::Loading);
        engine.close(None).unwrap();
        let request =
            serde_json::from_value(json!({"path":copy,"expectedIdentity":identity})).unwrap();
        assert!(matches!(
            engine.stores().adopt(request),
            Err(EngineError::Cancelled(_))
        ));
        assert_eq!(snapshot(&copy), before);
    }
}

#[test]
fn process_inspection_keeps_a_refusing_host_platform_authoritative() {
    let scratch =
        tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let state = scratch.path().join("not-created");
    let host = Arc::new(FakeHost::new(
        state.clone(),
        serde_json::from_value(json!({})).unwrap(),
    ));
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let identity = engine.embedding().identities().remove(0);
    let request =
        serde_json::from_value(json!({"path":scratch.path(),"expectedIdentity":identity})).unwrap();
    assert!(matches!(
        engine.stores().adopt(request),
        Err(EngineError::MemoryOp(_))
    ));
    assert!(!state.exists());
}
