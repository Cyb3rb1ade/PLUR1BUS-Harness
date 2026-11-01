//! Real native stores prove the two-field ceiling and the zero-write warm path.
#![allow(clippy::unwrap_used, reason = "native parity fixtures fail closed")]
#[path = "../tests/recall_support.rs"]
mod support;

use plur1bus_engine::recall::{
    maintenance,
    neo_prelude::{NeoPrelude, NeoRequest},
    render::RenderError,
    warm::{self, WarmParameters, WarmRecall, WarmRequest},
};
use plur1bus_engine::store::{OpenMode, RowFilter, Store};
use plur1bus_engine::text::js::JsString;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

fn store() -> (tempfile::TempDir, Store, String) {
    let directory = tempfile::tempdir().unwrap();
    let identity = serde_json::from_str(include_str!("fixtures/store-v1/identity.json")).unwrap();
    let store = Store::create(&directory.path().join("fixture"), &identity, 384).unwrap();
    let id = "00000000-0000-4000-8000-000000000001";
    let mut row = support::memory_row(id, "fixture", "agent-private");
    row.vector = vec![0.0; 384];
    row.vector[0] = 1.0;
    store.upsert(&[row]).unwrap();
    (directory, store, id.into())
}

#[test]
fn authorized_counter_patch_changes_only_the_two_permitted_fields() {
    let (_directory, store, id) = store();
    let before = serde_json::to_value(store.get(&id).unwrap().unwrap()).unwrap();
    let context = plur1bus_engine::recall::acl::AclSubject {
        agent_id: "fixture".into(),
        workspace_identity: String::new(),
        user_principal: String::new(),
        aliases: Some(plur1bus_engine::context::WorkspaceAliases::default()),
    };
    maintenance::record_retrieval(
        &store,
        std::slice::from_ref(&id),
        &context,
        1_768_305_600_000,
        false,
    )
    .unwrap();
    let after = serde_json::to_value(store.get(&id).unwrap().unwrap()).unwrap();
    for (key, value) in before.as_object().unwrap() {
        if !["retrievalCount", "lastRetrievedAt"].contains(&key.as_str()) {
            assert_eq!(&after[key], value);
        }
    }
    assert_eq!(after["retrievalCount"].as_f64(), Some(1.0));
    assert_eq!(after["lastRetrievedAt"].as_f64(), Some(1_768_305_600_000.0));
    maintenance::record_retrieval(
        &store,
        std::slice::from_ref(&id),
        &context,
        1_768_305_600_001,
        true,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(store.get(&id).unwrap().unwrap()).unwrap(),
        after
    );
}

fn files(path: &Path) -> BTreeMap<std::path::PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            out.extend(files(&entry.path()));
        } else {
            out.insert(
                entry.path(),
                Sha256::digest(std::fs::read(entry.path()).unwrap()).to_vec(),
            );
        }
    }
    out
}

struct NoNeo;
impl NeoPrelude for NoNeo {
    fn read(&self, _request: &NeoRequest<'_>) -> Result<JsString, RenderError> {
        Ok(JsString::default())
    }
}

struct NativeWarm(Store);
impl WarmRecall for NativeWarm {
    fn has_table(&self) -> Result<bool, RenderError> {
        Ok(true)
    }
    fn recall(&mut self, parameters: &WarmParameters) -> Result<(), RenderError> {
        assert!(
            parameters.read_only && !parameters.persist_embeddings && !parameters.retrieval_logger
        );
        let mut vector = vec![0.0; 384];
        vector[0] = 1.0;
        let result = self.0.search(&vector, 1, &RowFilter::default()).unwrap();
        assert_eq!(result.len(), 1);
        Ok(())
    }
}

#[test]
fn warm_vector_search_changes_no_row_file_or_ledger_bytes() {
    let (directory, store, id) = store();
    let before_row = serde_json::to_value(store.get(&id).unwrap().unwrap()).unwrap();
    let readonly =
        Store::open(&directory.path().join("fixture"), OpenMode::ReadOnly, None).unwrap();
    std::fs::write(
        directory.path().join("retrieval-ledger.jsonl"),
        b"{\"fixture\":true}\n",
    )
    .unwrap();
    let before_files = files(directory.path());
    let result = warm::run(
        &WarmRequest {
            prompt: "Architecture fixture query".into(),
            neo_enabled: false,
            top_n: 12,
            allowed: true,
        },
        &mut NativeWarm(readonly),
        &NoNeo,
    )
    .unwrap();
    assert!(result.blocks.is_empty() && result.deferrals.is_empty() && result.degraded.is_none());
    assert_eq!(files(directory.path()), before_files);
    assert_eq!(
        serde_json::to_value(store.get(&id).unwrap().unwrap()).unwrap(),
        before_row
    );
}
