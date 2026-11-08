//! S5 committed-tombstone parity through real Node/Lance goldens and native Lance stores.
#![allow(clippy::unwrap_used, reason = "contract fixtures fail immediately")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    contract::{Cancel, MemoryRow, StoreError},
    embedding::EmbeddingProvider,
    ops::{
        tombstone_reapply::{reapply, GenerationReapplyTarget, ReapplyMutation, ReapplyTarget},
        tombstones::TombstoneLookup,
    },
    recall::hash_embed::HashEmbedder,
    store::{OpenMode, Store},
};
use serde_json::{json, Value};
use std::{fs, path::Path};

struct FaultTarget<'a> {
    target: &'a GenerationReapplyTarget,
    case: &'a Value,
    cancel_after_write: Option<&'a Cancel>,
}
impl TombstoneLookup for FaultTarget<'_> {
    fn agent_exists(&self, agent: &str) -> Result<bool, StoreError> {
        self.target.agent_exists(agent)
    }
    fn status(&self, agent: &str, id: &str) -> Result<Option<String>, StoreError> {
        if self.case["verifyError"] == true {
            return Err(StoreError::Corrupt);
        }
        self.target.status(agent, id)
    }
}
impl ReapplyTarget for FaultTarget<'_> {
    fn tombstone(&self, agent: &str, id: &str) -> Result<ReapplyMutation, StoreError> {
        if self.case["writeError"] == true {
            return Err(StoreError::Corrupt);
        }
        if self.case["writeNoop"] == true {
            return Ok(ReapplyMutation::Applied);
        }
        let result = self.target.tombstone(agent, id);
        if let Some(cancel) = self.cancel_after_write {
            cancel.cancel();
        }
        result
    }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/reapply.json")).unwrap()
}
fn identity() -> plur1bus_engine::contract::VectorSpaceIdentity {
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    identity
}
fn numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(items) => items.iter_mut().for_each(numbers),
        Value::Object(fields) => fields.values_mut().for_each(numbers),
        _ => (),
    }
}
fn comparable(mut value: Value) -> Value {
    numbers(&mut value);
    value
}
fn registry(root: &Path, case: &Value) -> std::path::PathBuf {
    let dir = root.join("_tombstones");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(if case["invalidAgent"] == true {
        "bad agent.jsonl"
    } else {
        "agent.jsonl"
    });
    fs::write(&path, case["before"].as_str().unwrap()).unwrap();
    path
}

#[test]
fn committed_reapply_matches_actual_node_lance_reports_rows_and_repeat_execution() {
    let golden = fixture();
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let identity = identity();
        let store = if case["missingStore"] == true {
            None
        } else {
            let store = Store::create(&base.join("agent"), &identity, 4).unwrap();
            if !case["original"].is_null() {
                let row: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
                store.upsert(&[row]).unwrap();
            }
            Some(store)
        };
        let file = registry(root.path(), case);
        let apply = case["apply"].as_bool().unwrap();
        let target = GenerationReapplyTarget::open(
            &base,
            &identity,
            if apply {
                OpenMode::ReadWrite
            } else {
                OpenMode::ReadOnly
            },
        )
        .unwrap();
        let target = FaultTarget {
            target: &target,
            case,
            cancel_after_write: None,
        };
        for (report_key, failed_key, row_key) in [
            ("report", "failed", "row"),
            ("second", "secondFailed", "secondRow"),
        ] {
            let report = reapply(&base, &target, apply, &Cancel::never()).unwrap();
            assert_eq!(
                json!(report.failed()),
                case[failed_key],
                "{} {report_key}",
                case["name"]
            );
            assert_eq!(
                serde_json::to_value(report).unwrap(),
                case[report_key],
                "{} {report_key}",
                case["name"]
            );
            let row = store
                .as_ref()
                .and_then(|store| store.get("00000000-0000-4000-8000-000000000001").unwrap());
            assert_eq!(
                comparable(json!(row)),
                comparable(case[row_key].clone()),
                "{} {row_key}",
                case["name"]
            );
            assert_eq!(
                fs::read_to_string(&file).unwrap(),
                case["after"].as_str().unwrap(),
                "{} registry",
                case["name"]
            );
        }
        if !apply {
            assert_eq!(
                fs::read_to_string(file).unwrap(),
                case["before"].as_str().unwrap()
            );
        }
        if case["missingStore"] == true {
            assert!(!base.exists());
        }
    }
}

#[test]
fn selected_generation_changes_but_original_store_and_lossless_registry_do_not() {
    let golden = fixture();
    let case = &golden["cases"][0];
    let root = support::canonical_tempdir();
    let base = root.path().join("original");
    let active = root.path().join("active-generation");
    let identity = identity();
    let row: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
    let old = Store::create(&base.join("agent"), &identity, 4).unwrap();
    let current = Store::create(&active.join("agent"), &identity, 4).unwrap();
    old.upsert(std::slice::from_ref(&row)).unwrap();
    current.upsert(std::slice::from_ref(&row)).unwrap();
    let file = registry(root.path(), case);
    let before = format!(
        "{},\"future\":\"\\ud800\"}}\n",
        case["before"]
            .as_str()
            .unwrap()
            .trim_end()
            .trim_end_matches('}')
    );
    fs::write(&file, &before).unwrap();
    let target = GenerationReapplyTarget::open(&active, &identity, OpenMode::ReadWrite).unwrap();
    let first = reapply(&base, &target, true, &Cancel::never()).unwrap();
    assert!(!first.failed());
    assert_eq!(first.applied.len(), 1);
    assert_eq!(old.get(&row.id).unwrap().unwrap().status, "active");
    let deleted = current.get(&row.id).unwrap().unwrap();
    assert_eq!(deleted.status, "deleted");
    assert_eq!(deleted.epistemic_status, "invalidated");
    assert_eq!(deleted.text, row.text);
    assert_eq!(deleted.vector, row.vector);
    assert_eq!(deleted.updated_at.as_f64(), row.updated_at.as_f64());
    let versions = || {
        fs::read_dir(active.join("agent/memories.lance/_versions"))
            .unwrap()
            .count()
    };
    let before_repeat = versions();
    assert_eq!(
        reapply(&base, &target, true, &Cancel::never())
            .unwrap()
            .already_tombstoned
            .len(),
        1
    );
    assert_eq!(
        versions(),
        before_repeat,
        "idempotence must issue no new Lance update"
    );
    assert_eq!(fs::read_to_string(file).unwrap(), before);
}

#[test]
fn cancellation_does_not_repair_a_tail_or_create_missing_tables_and_retry_is_idempotent() {
    let golden = fixture();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "torn-tail-apply")
        .unwrap();
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    let identity = identity();
    let file = registry(root.path(), case);
    let target = GenerationReapplyTarget::open(&base, &identity, OpenMode::ReadWrite).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(reapply(&base, &target, true, &cancel).is_err());
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        case["before"].as_str().unwrap()
    );
    assert!(!base.exists());

    // An existing agent directory without a table is a storage failure, never an empty
    // newly manufactured table that could falsely pass tombstone verification.
    fs::create_dir_all(base.join("agent")).unwrap();
    let report = reapply(&base, &target, true, &Cancel::never()).unwrap();
    assert!(report.failed());
    assert_eq!(report.errors.len(), 2);
    assert!(!base.join("agent/memories.lance").exists());

    // Restore brings an old table back by rename. Ordinary writes correctly refuse
    // recreating this committed forgotten content, so build the old table separately.
    let staged = root.path().join("snapshot/store/agent");
    let store = Store::create(&staged, &identity, 4).unwrap();
    let row: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
    store.upsert(&[row]).unwrap();
    drop(store);
    fs::remove_dir(base.join("agent")).unwrap();
    fs::rename(staged, base.join("agent")).unwrap();
    let cancel = Cancel::never();
    let cancelling = FaultTarget {
        target: &target,
        case: &Value::Null,
        cancel_after_write: Some(&cancel),
    };
    assert!(reapply(&base, &cancelling, true, &cancel).is_err());
    let retry = reapply(&base, &target, true, &Cancel::never()).unwrap();
    assert!(!retry.failed());
    assert_eq!(retry.already_tombstoned.len(), 1);
}
