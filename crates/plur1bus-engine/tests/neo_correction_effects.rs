//! Real Lance safeUpdate with actual source-bound Neo graph and event files.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, MemoryRow, Principal, StoreError},
    embedding::{EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    neo::{
        capture_journal::CaptureJournal,
        correction_effects::{EffectAuthority, NativeCorrectionEffects},
        merged::Layout,
    },
    ops::{
        context::OperationContext,
        correction::{CorrectionEffects, CorrectionServices},
        safe_update::{UpdateEvidence, UpdatePatch, UpdateRequest},
        write::{MemoryWriter, MutationStores},
    },
    recall::hash_embed::HashEmbedder,
    store::{RowPatch, Store},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

struct Stores(Arc<Store>);
impl MutationStores for Stores {
    fn existing_private(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
}
struct Provider(VectorSpaceIdentity);
impl EmbeddingProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.0
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        Ok(texts.iter().map(|_| vec![1., 0., 0., 0.]).collect())
    }
}
struct Policy(AtomicBool);
impl CapturePolicy for Policy {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    directory: PathBuf,
    workspace: PathBuf,
    host: Arc<support::TestHost>,
    store: Arc<Store>,
    policy: Arc<Policy>,
    original: MemoryRow,
    peer: MemoryRow,
    context: RequestContext,
    principal: Principal,
    agent: AgentContext,
    effects: Arc<NativeCorrectionEffects>,
    writer: MemoryWriter,
    case: Value,
    now: i64,
}
fn fixture(case_name: &str) -> Fixture {
    fixture_config(case_name, json!({}))
}
fn fixture_config(case_name: &str, config: Value) -> Fixture {
    let root = support::canonical_tempdir();
    let workspace = root.path().join("workspace");
    let neo = root.path().join("neo");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&neo).unwrap();
    let host = Arc::new(
        support::TestHost::new(root.path().join("state"))
            .with_config(serde_json::from_value(config).unwrap()),
    );
    host.set_workspace("agent", workspace.clone());
    let principal: Principal = serde_json::from_value(json!({"agentId":"agent","workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("fixture"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let agent = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let context = RequestContext::build(&principal, &agent, host.as_ref()).unwrap();
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/safe-update.json")).unwrap();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == case_name)
        .unwrap()
        .clone();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/capture/safe-update-exceptions.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/safe-update.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    let mut case = case;
    if let Some(exception) = exceptions["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["name"] == case_name)
    {
        if let Some(events) = exception.get("events") {
            case["events"] = events.clone();
        }
    }
    let mut original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
    original.owner_user_id = context.owner_user_id.clone();
    original.workspace_key = context.workspace_key.clone();
    original.workspace_id = context.workspace_key.clone();
    original.agent_id = "agent".into();
    original.stored_by = "agent".into();
    let mut peer = original.clone();
    peer.id = "00000000-0000-4000-8000-000000000002".into();
    peer.text = "Peer synthetic fact".into();
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let base = root.path().join("store");
    let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    store.upsert(&[original.clone(), peer.clone()]).unwrap();
    let stores = Arc::new(Stores(store.clone()));
    let policy = Arc::new(Policy(AtomicBool::new(true)));
    let journal = Arc::new(CaptureJournal::open(&neo, host.clone(), policy.clone()).unwrap());
    let effects = Arc::new(
        NativeCorrectionEffects::open(
            journal,
            host.clone(),
            stores.clone(),
            EffectAuthority {
                principal: principal.clone(),
                agent: agent.clone(),
                cancel: Cancel::never(),
                base_db: base.clone(),
            },
        )
        .unwrap(),
    );
    let directory = neo
        .join("workspaces")
        .join(Layout::for_key(&context.workspace_key).canonical);
    fs::create_dir_all(&directory).unwrap();
    let edge = json!({"source":original.id,"target":peer.id,"kind":"related","weight":0.5,"scope":"agent_private","agentId":"agent","ownerUserId":context.owner_user_id,"workspaceKey":context.workspace_key});
    fs::write(directory.join("memory-graph.jsonl"), format!("{edge}\n")).unwrap();
    let writer = MemoryWriter::new(Arc::new(OperationContext::new(host.clone())), stores, base)
        .with_corrections(CorrectionServices {
            embedder: Arc::new(Provider(identity)),
            effects: Some(effects.clone()),
        });
    Fixture {
        _root: root,
        directory,
        workspace,
        host,
        store,
        policy,
        original,
        peer,
        context,
        principal,
        agent,
        effects,
        writer,
        case,
        now: golden["now"].as_i64().unwrap(),
    }
}
fn update(f: &Fixture) -> plur1bus_engine::ops::safe_update::UpdateResult {
    f.writer
        .safe_update_at(
            &UpdateRequest {
                id: &f.original.id,
                patch: serde_json::from_value::<UpdatePatch>(f.case["patch"].clone()).unwrap(),
                evidence: serde_json::from_value::<UpdateEvidence>(f.case["evidence"].clone())
                    .unwrap(),
                skip_drift_gate: false,
            },
            &f.principal,
            &f.agent,
            &Cancel::never(),
            f.now,
        )
        .unwrap()
}
fn rows(f: &Fixture, name: &str) -> Vec<Value> {
    fs::read_to_string(f.directory.join(name))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
#[test]
fn safe_update_publishes_actual_graph_edges_and_private_node_shaped_receipts() {
    let f = fixture("version");
    let result = update(&f);
    assert_ne!(result.new_id, f.original.id);
    assert_eq!(
        f.store.get(&f.original.id).unwrap().unwrap().status,
        "superseded"
    );
    let graph = rows(&f, "memory-graph.jsonl");
    assert_eq!(graph.len(), 2);
    assert_eq!(graph[1]["source"], result.new_id);
    assert_eq!(graph[1]["target"], f.peer.id);
    let events = rows(&f, "reconsolidation-events.jsonl");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["ownerUserId"], f.context.owner_user_id);
    assert_eq!(events[0]["scope"], "agent_private");
    let mut projected = events[0].clone();
    for key in ["ownerUserId", "workspaceKey", "agentId", "scope"] {
        projected.as_object_mut().unwrap().remove(key);
    }
    projected["id"] = json!("event-id");
    projected["newMemoryId"] = json!("successor-id");
    let mut expected = f.case["events"][0].clone();
    // Node has one numeric type; retain exact values, with no epsilon/tolerance.
    normalize_numbers(&mut projected);
    normalize_numbers(&mut expected);
    assert_eq!(projected, expected);
    assert!(f
        .effects
        .contains(&f.context, events[0]["idempotencyKey"].as_str().unwrap())
        .unwrap());
    f.effects
        .rewrite_edges(&f.context, &f.original, &result.new_id)
        .unwrap();
    f.effects
        .record(&f.context, &f.original, &events[0])
        .unwrap();
    assert_eq!(rows(&f, "memory-graph.jsonl").len(), 2);
    assert_eq!(rows(&f, "reconsolidation-events.jsonl").len(), 1);
}

#[test]
fn inline_update_uses_the_durable_receipt_on_the_next_call() {
    let f = fixture("metadata");
    assert!(update(&f).inline);
    assert_eq!(update(&f).skipped, Some(true));
    assert_eq!(rows(&f, "reconsolidation-events.jsonl").len(), 1);
    assert_eq!(rows(&f, "memory-graph.jsonl").len(), 1);
}

#[test]
fn current_policy_physical_workspace_and_peer_authority_are_not_borrowed() {
    let f = fixture("version");
    f.store
        .patch(
            &f.peer.id,
            &RowPatch {
                status: Some("deleted".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let result = update(&f);
    assert_eq!(rows(&f, "memory-graph.jsonl").len(), 1);
    f.policy.0.store(false, Ordering::SeqCst);
    assert!(f.effects.contains(&f.context, "fixture-key").is_err());
    assert!(f
        .effects
        .rewrite_edges(&f.context, &f.original, &result.new_id)
        .is_err());
    f.policy.0.store(true, Ordering::SeqCst);
    let moved = f.workspace.with_extension("moved");
    fs::rename(&f.workspace, moved).unwrap();
    fs::create_dir(&f.workspace).unwrap();
    assert!(f.effects.contains(&f.context, "fixture-key").is_err());
    assert_eq!(rows(&f, "memory-graph.jsonl").len(), 1);
    f.host.set_workspace("agent", f.workspace.clone());
}

#[test]
fn event_visibility_is_filtered_before_the_idempotency_tail() {
    let f = fixture("metadata");
    update(&f);
    let event = rows(&f, "reconsolidation-events.jsonl")[0].clone();
    let mut foreign = event.clone();
    foreign["ownerUserId"] = json!(harness_user_principal("another-owner"));
    foreign["idempotencyKey"] = json!("foreign-key");
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(f.directory.join("reconsolidation-events.jsonl"))
        .unwrap();
    use std::io::Write;
    for _ in 0..1001 {
        writeln!(file, "{foreign}").unwrap();
    }
    file.sync_all().unwrap();
    assert!(f
        .effects
        .contains(&f.context, event["idempotencyKey"].as_str().unwrap())
        .unwrap());
    assert!(!f.effects.contains(&f.context, "foreign-key").unwrap());
}

#[test]
fn idempotency_read_never_runs_append_archival() {
    let f = fixture_config("metadata", json!({"neo":{"maxRecords":500}}));
    update(&f);
    let original = rows(&f, "reconsolidation-events.jsonl")[0].clone();
    let mut records = vec![original.clone()];
    for index in 1..700 {
        let mut event = original.clone();
        event["idempotencyKey"] = json!(format!("other-{index}"));
        records.push(event);
    }
    let before = records
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    fs::write(f.directory.join("reconsolidation-events.jsonl"), &before).unwrap();
    assert!(f
        .effects
        .contains(&f.context, original["idempotencyKey"].as_str().unwrap())
        .unwrap());
    assert_eq!(
        fs::read_to_string(f.directory.join("reconsolidation-events.jsonl")).unwrap(),
        before
    );
    assert!(!f.directory.join("archives").exists());
}

#[test]
fn corrupt_or_torn_receipts_refuse_without_rewriting_the_file() {
    for bytes in [b"not-json\n".as_slice(), b"{\"partial\":true}".as_slice()] {
        let f = fixture("metadata");
        update(&f);
        let path = f.directory.join("reconsolidation-events.jsonl");
        fs::write(&path, bytes).unwrap();
        assert!(f.effects.contains(&f.context, "fixture-key").is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn later_callers_and_unrelated_successors_cannot_borrow_the_source() {
    let f = fixture("version");
    let result = update(&f);
    assert!(f
        .effects
        .rewrite_edges(&f.context, &f.original, &f.peer.id)
        .is_err());
    let mut other = f.principal.clone();
    other.chat.id = "different-chat".into();
    let context = RequestContext::build(&other, &f.agent, f.host.as_ref()).unwrap();
    assert!(f.effects.contains(&context, "fixture-key").is_err());
    let mut old = f.store.get(&f.original.id).unwrap().unwrap();
    old.owner_user_id = harness_user_principal("another-owner");
    f.store.upsert(&[old]).unwrap();
    assert!(f
        .effects
        .rewrite_edges(&f.context, &f.original, &result.new_id)
        .is_err());
    assert_eq!(rows(&f, "memory-graph.jsonl").len(), 2);
}

#[cfg(unix)]
#[test]
fn linked_effect_files_are_refused_without_following_or_changing_them() {
    for symbolic in [false, true] {
        let f = fixture("metadata");
        update(&f);
        let path = f.directory.join("reconsolidation-events.jsonl");
        let external = f.workspace.join("unrelated.jsonl");
        let bytes = fs::read(&path).unwrap();
        if symbolic {
            fs::rename(&path, &external).unwrap();
            std::os::unix::fs::symlink(&external, &path).unwrap();
        } else {
            fs::hard_link(&path, &external).unwrap();
        }
        assert!(f.effects.contains(&f.context, "fixture-key").is_err());
        assert_eq!(fs::read(&external).unwrap(), bytes);
    }
}

fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(values) => values.iter_mut().for_each(normalize_numbers),
        Value::Object(values) => values.values_mut().for_each(normalize_numbers),
        _ => (),
    }
}

#[test]
fn human_correction_uses_the_same_actual_neo_effects_and_archive_path() {
    let f = fixture("version");
    f.writer
        .correct_at(
            &f.original.id,
            "A corrected synthetic fact",
            &f.principal,
            &f.agent,
            f.now,
        )
        .unwrap();
    let old = f.store.get(&f.original.id).unwrap().unwrap();
    assert_eq!(old.status, "superseded");
    let next = f.store.get(&old.superseded_by).unwrap().unwrap();
    assert_eq!(next.text, "A corrected synthetic fact");
    let events = rows(&f, "reconsolidation-events.jsonl");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["newMemoryId"], next.id);
    assert_eq!(events[0]["updateSource"], "user_correction");
    assert_eq!(rows(&f, "memory-graph.jsonl")[1]["source"], next.id);
}

#[test]
fn a_restored_live_peer_remains_excluded_by_the_actual_tombstone_registry() {
    let f = fixture("version");
    f.writer
        .forget_at(&f.peer.id, &f.principal, &f.agent, f.now)
        .unwrap();
    f.store
        .patch(
            &f.peer.id,
            &RowPatch {
                status: Some("active".into()),
                ..Default::default()
            },
        )
        .unwrap();
    update(&f);
    assert_eq!(rows(&f, "memory-graph.jsonl").len(), 1);
}

#[test]
fn concurrent_retries_do_not_duplicate_anonymous_graph_rows_or_receipts() {
    let f = fixture("version");
    let result = update(&f);
    let event = rows(&f, "reconsolidation-events.jsonl")[0].clone();
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                f.effects
                    .rewrite_edges(&f.context, &f.original, &result.new_id)
                    .unwrap();
                f.effects.record(&f.context, &f.original, &event).unwrap();
            });
        }
    });
    assert_eq!(rows(&f, "memory-graph.jsonl").len(), 2);
    assert_eq!(rows(&f, "reconsolidation-events.jsonl").len(), 1);
}

#[test]
fn event_metadata_cannot_add_conflicting_nested_authority() {
    let f = fixture("version");
    update(&f);
    let mut event = rows(&f, "reconsolidation-events.jsonl")[0].clone();
    event["visibility"] =
        json!({"scope":"global_user","ownerUserId":harness_user_principal("another-owner")});
    assert!(f.effects.record(&f.context, &f.original, &event).is_err());
    assert_eq!(rows(&f, "reconsolidation-events.jsonl").len(), 1);
}

#[test]
fn correction_effect_policy_cannot_replay_a_refused_automatic_capture() {
    struct StopOnPlan(PathBuf);
    impl CapturePolicy for StopOnPlan {
        fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
            Ok(!fs::read_dir(&self.0)
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("native-capture-pending-")
                }))
        }
    }
    let f = fixture("version");
    let automatic = CaptureJournal::open(
        &f._root.path().join("neo"),
        f.host.clone(),
        Arc::new(StopOnPlan(f.directory.clone())),
    )
    .unwrap();
    let turn:plur1bus_engine::contract::TurnRecord=serde_json::from_value(json!({
        "agentId":"agent","principal":f.principal,"agent":f.agent,"runId":"automatic",
        "sessionKey":"automatic","incognito":false,"messages":[{"role":"user","content":"Synthetic capture pending"}]
    })).unwrap();
    assert!(automatic
        .record(&turn, &f.context, &Cancel::never())
        .is_err());
    assert!(!f.directory.join("turn-journal.jsonl").exists());
    assert!(f
        .effects
        .contains(&f.context, "synthetic-effect-key")
        .is_err());
    assert!(!f.directory.join("turn-journal.jsonl").exists());
    assert!(!f.directory.join("reconsolidation-events.jsonl").exists());
}
