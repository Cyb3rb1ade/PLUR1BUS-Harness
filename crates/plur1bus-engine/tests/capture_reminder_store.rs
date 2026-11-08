//! Actual Lance rows and fail-closed reminder reuse; no dispatch or external API.
#![allow(clippy::unwrap_used, clippy::panic, reason = "integration assertions")]
#[allow(dead_code)]
mod capture_pipeline_support;
use plur1bus_engine::{
    capture::{
        reminder_store::{reminder_key, ReminderCapture, ReminderStore},
        row_builder,
    },
    context::harness_user_principal,
    contract::{AgentContext, Cancel, MemoryRow, Principal},
    embedding::EmbeddingProvider,
    store::{
        tombstone::{content_fingerprint, TombstoneRegistry},
        OpenMode, RowFilter, StorePool,
    },
    text::{js::JsString, json::parse_json},
};
use serde_json::{json, Value};
use std::{fs, sync::Arc};
const TEXT: &str = "Bitte Testbericht in 2 Minuten prüfen.";
const NOW: i64 = 1_710_000_000_000;
struct Fixture {
    dir: tempfile::TempDir,
    principal: Principal,
    stores: Arc<StorePool>,
    service: ReminderStore,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let workspace = dir.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let host = Arc::new(capture_pipeline_support::Host::new(
        dir.path().join("state"),
        workspace.clone(),
        serde_json::from_value(json!({})).unwrap(),
    ));
    let embedder = Arc::new(capture_pipeline_support::HashEmbedder::new(false));
    let stores = Arc::new(
        StorePool::open(
            &dir.path().join("stores"),
            OpenMode::ReadWrite,
            Some(embedder.identity()),
            8,
        )
        .unwrap(),
    );
    let principal=serde_json::from_value(json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("fixture-user"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let service = ReminderStore::new(host, stores.clone(), embedder);
    Fixture {
        dir,
        principal,
        stores,
        service,
    }
}
fn agent() -> AgentContext {
    serde_json::from_value(json!({"origin":"user","background":false})).unwrap()
}
fn capture(f: &Fixture) -> Result<ReminderCapture, plur1bus_engine::contract::EngineError> {
    f.service.capture(
        &JsString::from(TEXT),
        "user",
        true,
        &f.principal,
        &agent(),
        &Cancel::never(),
    )
}
fn stored(result: ReminderCapture) -> (MemoryRow, bool) {
    match result {
        ReminderCapture::Stored { row, created } => (*row, created),
        _ => panic!("expected reminder"),
    }
}
fn normalized(mut row: MemoryRow) -> String {
    row.id = "volatile-id".into();
    row.workspace_key = "/fixture-workspace".into();
    row.reminder_key = reminder_key(
        "alpha",
        "/fixture-workspace",
        &JsString::from(TEXT),
        NOW + 120_000,
    );
    row_builder::to_node_json(&row).unwrap()
}
fn node() -> Value {
    serde_json::from_str(include_str!("fixtures/capture/golden/reminder-store.json")).unwrap()
}
#[test]
fn a_reminder_sentence_yields_actual_node_lance_columns_and_reuses_active_rows() {
    let golden = node();
    for kind in ["new", "duplicate", "terminal"] {
        let f = fixture();
        let first = stored(capture(&f).unwrap());
        assert!(first.1);
        if kind == "duplicate" {
            let second = stored(capture(&f).unwrap());
            assert!(!second.1);
            assert_eq!(second.0.id, first.0.id);
        }
        if kind == "terminal" {
            let mut row = first.0;
            row.reminder_status = "acknowledged".into();
            f.stores.get("alpha").unwrap().upsert(&[row]).unwrap();
            assert!(stored(capture(&f).unwrap()).1);
        }
        let case = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["kind"] == kind)
            .unwrap();
        let mut actual = f
            .stores
            .get("alpha")
            .unwrap()
            .scan(&RowFilter::default(), 20)
            .unwrap()
            .into_iter()
            .map(normalized)
            .collect::<Vec<_>>();
        let mut expected = case["rowLines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected, "{kind}");
    }
}
#[test]
fn source_key_matches_node_and_parallel_native_captures_commit_only_one_row() {
    let golden = node();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "concurrent")
        .unwrap();
    assert_eq!(case["rowLines"].as_array().unwrap().len(), 2);
    let expected: Value = serde_json::from_str(case["rowLines"][0].as_str().unwrap()).unwrap();
    assert_eq!(
        reminder_key(
            "alpha",
            "/fixture-workspace",
            &JsString::from(TEXT),
            NOW + 120_000
        ),
        expected["reminderKey"]
    );
    let f = fixture();
    let results = std::thread::scope(|scope| {
        let workers = (0..4)
            .map(|_| scope.spawn(|| stored(capture(&f).unwrap())))
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|(_, created)| *created).count(), 1);
    assert!(results.iter().all(|(row, _)| row.id == results[0].0.id));
    assert_eq!(
        f.stores
            .get("alpha")
            .unwrap()
            .count(&RowFilter::default())
            .unwrap(),
        1
    );
}
#[test]
fn foreign_shared_and_invalidated_existing_rows_are_not_returned_or_replaced() {
    for kind in ["foreign-owner", "foreign-scope", "invalidated"] {
        let f = fixture();
        let (mut row, _) = stored(capture(&f).unwrap());
        match kind {
            "foreign-owner" => row.owner_user_id = "foreign".into(),
            "foreign-scope" => {
                row.scope = "user".into();
                row.owner_user_id = "foreign".into();
            }
            _ => row.epistemic_status = "invalidated".into(),
        }
        let store = f.stores.get("alpha").unwrap();
        store.upsert(std::slice::from_ref(&row)).unwrap();
        assert!(capture(&f).is_err());
        assert_eq!(
            row_builder::to_node_json(&store.get(&row.id).unwrap().unwrap()).unwrap(),
            row_builder::to_node_json(&row).unwrap()
        );
        assert_eq!(store.count(&RowFilter::default()).unwrap(), 1);
    }
}
#[test]
fn tombstone_blocks_both_new_reminder_writes_and_reuse_of_an_unreconciled_row() {
    for existing in [false, true] {
        let f = fixture();
        if existing {
            capture(&f).unwrap();
        }
        let base = f.dir.path().join("stores");
        fs::create_dir_all(&base).unwrap();
        let marker = json!({"schemaVersion":1,"memoryId":"10000000-0000-4000-8000-000000000001","canonicalOriginId":"reminder-fixture","agentId":"alpha","scope":"agent-private","workspaceId":"","ownerUserId":"","status":"committed","contentFingerprint":content_fingerprint(TEXT)});
        TombstoneRegistry::new(&base, "alpha")
            .unwrap()
            .append(&parse_json(&marker.to_string()).unwrap())
            .unwrap();
        assert!(capture(&f).is_err());
        assert_eq!(
            f.stores
                .get("alpha")
                .unwrap()
                .count(&RowFilter::default())
                .unwrap(),
            usize::from(existing)
        );
    }
}
#[test]
fn failed_identity_cancel_and_ineligible_items_do_not_create_a_store() {
    let f = fixture();
    for role in ["assistant", "system"] {
        assert!(matches!(
            f.service
                .capture(
                    &JsString::from(TEXT),
                    role,
                    true,
                    &f.principal,
                    &agent(),
                    &Cancel::never()
                )
                .unwrap(),
            ReminderCapture::Skipped("not_user_role")
        ));
    }
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(f
        .service
        .capture(
            &JsString::from(TEXT),
            "user",
            true,
            &f.principal,
            &agent(),
            &cancel
        )
        .is_err());
    let mut foreign = f.principal.clone();
    foreign.workspace = serde_json::from_value(json!("workspace-dir:v1:/foreign")).unwrap();
    assert!(f
        .service
        .capture(
            &JsString::from(TEXT),
            "user",
            true,
            &foreign,
            &agent(),
            &Cancel::never()
        )
        .is_err());
    assert!(!f.dir.path().join("stores").exists());
}

struct EffectJournal {
    at: i64,
    effects: std::collections::BTreeMap<usize, plur1bus_engine::capture::pipeline::ReminderEffect>,
    stop_after_plan: bool,
}
impl plur1bus_engine::capture::pipeline::CapturePostStore for EffectJournal {
    fn reference_time(&self) -> i64 {
        self.at
    }
    fn reminder(
        &self,
        position: usize,
    ) -> Option<plur1bus_engine::capture::pipeline::ReminderEffect> {
        self.effects.get(&position).cloned()
    }
    fn plan_reminder(
        &mut self,
        position: usize,
        effect: plur1bus_engine::capture::pipeline::ReminderEffect,
        _: &Cancel,
    ) -> Result<(), plur1bus_engine::contract::EngineError> {
        self.effects.insert(position, effect);
        if self.stop_after_plan {
            return Err(plur1bus_engine::contract::StoreError::Unavailable.into());
        }
        Ok(())
    }
    fn check(&self, cancel: &Cancel) -> Result<(), plur1bus_engine::contract::EngineError> {
        cancel.check()?;
        Ok(())
    }
}
#[test]
fn prepared_reminder_replays_one_original_id_and_preserves_terminal_acknowledgement() {
    for terminal in ["scheduled", "acknowledged", "cancelled"] {
        let f = fixture();
        let mut journal = EffectJournal {
            at: NOW - 60_000,
            effects: Default::default(),
            stop_after_plan: true,
        };
        let call = |journal: &mut EffectJournal| {
            f.service.capture_recoverable(
                plur1bus_engine::capture::reminder_store::ReminderInput {
                    text: &JsString::from(TEXT),
                    role: "user",
                    enabled: true,
                    principal: &f.principal,
                    agent: &agent(),
                },
                0,
                journal,
                &Cancel::never(),
            )
        };
        assert!(call(&mut journal).is_err());
        assert_eq!(
            f.stores
                .get("alpha")
                .unwrap()
                .count(&RowFilter::default())
                .unwrap(),
            0
        );
        let expected = journal.effects[&0].row.clone();
        assert_eq!(expected.remind_at.as_i64(), Some(NOW + 60_000));
        journal.stop_after_plan = false;
        let (row, created) = stored(call(&mut journal).unwrap());
        assert!(created);
        assert_eq!(row.id, expected.id);
        let mut current = row;
        current.reminder_status = terminal.into();
        if terminal == "acknowledged" {
            current.acknowledged_at = (NOW + 5_000).into();
        }
        if terminal == "cancelled" {
            current.cancelled_at = (NOW + 5_000).into();
        }
        f.stores.get("alpha").unwrap().upsert(&[current]).unwrap();
        let (replayed, created) = stored(call(&mut journal).unwrap());
        assert!(!created);
        assert_eq!(replayed.id, expected.id);
        assert_eq!(replayed.reminder_status, terminal);
        assert_eq!(
            f.stores
                .get("alpha")
                .unwrap()
                .count(&RowFilter::default())
                .unwrap(),
            1
        );
    }
}
