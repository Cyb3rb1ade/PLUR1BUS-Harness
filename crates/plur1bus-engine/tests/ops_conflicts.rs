//! Actual source-bound conflict records retain both Lance rows and private caller summaries.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, Principal, StoreError},
    embedding::{EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    neo::capture_journal::CaptureJournal,
    ops::{
        conflicts::{ConflictLedger, ConflictRequest, MergeDecision},
        context::OperationContext,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    recall::hash_embed::HashEmbedder,
    store::{RowPatch, Store},
};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
struct Sources(Arc<Store>);
impl ReadStores for Sources {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(vec![ReadSource {
            store: self.0.clone(),
            kind: SourceKind::Private,
            optional: false,
        }])
    }
}
struct Embed(VectorSpaceIdentity);
impl EmbeddingProvider for Embed {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.0
    }
    fn embed(&self, _: &[String], _: EmbedKind, _: &Cancel) -> Result<Vec<Vec<f32>>, EmbedError> {
        panic!("conflict recording must not infer")
    }
}
struct Policy {
    allowed: AtomicBool,
    stop_after_log: AtomicBool,
    log: std::path::PathBuf,
}
impl CapturePolicy for Policy {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        if self.stop_after_log.load(Ordering::SeqCst)
            && fs::metadata(&self.log).is_ok_and(|m| m.len() > 0)
        {
            self.allowed.store(false, Ordering::SeqCst);
        }
        Ok(self.allowed.load(Ordering::SeqCst))
    }
}
struct Fixture {
    root: tempfile::TempDir,
    store: Arc<Store>,
    ledger: ConflictLedger,
    principal: Principal,
    agent: AgentContext,
    request: ConflictRequest,
    policy: Arc<Policy>,
}
fn setup() -> Fixture {
    let root = support::canonical_tempdir();
    let workspace = root.path().join("workspace");
    let neo = root.path().join("neo");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&neo).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("alpha", workspace.clone());
    host.time.store(1735689600000, Ordering::SeqCst);
    let principal:Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("fixture"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let ctx = RequestContext::build(&principal, &agent, host.as_ref()).unwrap();
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let base = root.path().join("store");
    let store = Arc::new(Store::create(&base.join("alpha"), &identity, 4).unwrap());
    let mut new = support::memory_row(
        "00000000-0000-4000-8000-000000000001",
        "alpha",
        "agent-private",
    );
    new.stored_by = "alpha".into();
    new.status = "active".into();
    new.owner_user_id = ctx.owner_user_id.clone();
    new.workspace_key = ctx.workspace_key.clone();
    new.workspace_id = ctx.workspace_key.clone();
    new.vector = vec![1., 0., 0., 0.];
    new.text = "A synthetic decision".into();
    new.category = "decision".into();
    let mut existing = new.clone();
    existing.id = "00000000-0000-4000-8000-000000000002".into();
    existing.agent_id = "beta".into();
    existing.stored_by = "beta".into();
    existing.scope = "user".into();
    existing.text = "Another synthetic decision".into();
    store.upsert(&[new.clone(), existing.clone()]).unwrap();
    let policy = Arc::new(Policy {
        allowed: AtomicBool::new(true),
        stop_after_log: AtomicBool::new(false),
        log: workspace.join(".adaptive-learning/conflict-log.jsonl"),
    });
    let journal = Arc::new(CaptureJournal::open(&neo, host.clone(), policy.clone()).unwrap());
    let reader = Arc::new(MemoryReader::new(
        Arc::new(OperationContext::new(host)),
        Arc::new(Sources(store.clone())),
        Arc::new(Embed(identity)),
        base,
    ));
    let ledger = ConflictLedger::new(reader, journal);
    let request = ConflictRequest {
        operation_id: uuid::Uuid::new_v4(),
        new: store.get_record(&new.id).unwrap().unwrap(),
        existing: store.get_record(&existing.id).unwrap().unwrap(),
        score: 0.8,
        decision: MergeDecision::StoredSeparately,
    };
    Fixture {
        root,
        store,
        ledger,
        principal,
        agent,
        request,
        policy,
    }
}
#[test]
fn real_cross_agent_same_user_conflict_keeps_both_rows_and_deduplicates_retries() {
    let f = setup();
    std::thread::scope(|scope| {
        let hs = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    f.ledger
                        .record(&f.request, &f.principal, &f.agent, &Cancel::never())
                })
            })
            .collect::<Vec<_>>();
        for h in hs {
            h.join().unwrap().unwrap();
        }
    });
    let file = f
        .root
        .path()
        .join("workspace/.adaptive-learning/conflict-log.jsonl");
    let bytes = fs::read(&file).unwrap();
    let lines = std::str::from_utf8(&bytes)
        .unwrap()
        .lines()
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let row: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(row["newText"], "A synthetic decision");
    assert_eq!(row["existingAgentId"], "beta");
    assert_eq!(row["scope"], "agent_private");
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/conflict-ledger.json")).unwrap();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "current-source-pair")
        .unwrap();
    let observed: Value = serde_json::from_str(case["log"].as_str().unwrap().trim()).unwrap();
    for (key, expected) in observed.as_object().unwrap() {
        assert_eq!(&row[key], expected, "{key}");
    }

    assert_eq!(
        f.store.get(&f.request.new.row.id).unwrap().unwrap().text,
        f.request.new.row.text
    );
    assert_eq!(
        f.store
            .get(&f.request.existing.row.id)
            .unwrap()
            .unwrap()
            .text,
        f.request.existing.row.text
    );
    let summary = f
        .ledger
        .summary(&f.principal, &f.agent, &Cancel::never())
        .unwrap();
    assert_eq!(summary.count, 1);
    assert_eq!(summary.size_bytes, bytes.len());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(file).unwrap().permissions().mode() & 0o077, 0);
    }
}
#[test]
fn foreign_hidden_changed_and_revoked_sources_cannot_publish() {
    for mode in ["foreign", "changed", "deleted", "revoked"] {
        let f = setup();
        match mode {
            "foreign" => {
                f.store
                    .patch(
                        &f.request.existing.row.id,
                        &RowPatch {
                            owner_user_id: Some(harness_user_principal("other")),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "changed" => {
                f.store
                    .patch(
                        &f.request.existing.row.id,
                        &RowPatch {
                            text: Some("Changed".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "deleted" => {
                f.store
                    .patch(
                        &f.request.existing.row.id,
                        &RowPatch {
                            status: Some("deleted".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            _ => f.policy.allowed.store(false, Ordering::SeqCst),
        }
        assert!(f
            .ledger
            .record(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert!(!f
            .root
            .path()
            .join("workspace/.adaptive-learning/conflict-log.jsonl")
            .exists());
    }
}

#[test]
fn committed_log_survives_summary_interruption_and_retry_keeps_one_record() {
    let f = setup();
    f.policy.stop_after_log.store(true, Ordering::SeqCst);
    assert!(f
        .ledger
        .record(&f.request, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    let file = f
        .root
        .path()
        .join("workspace/.adaptive-learning/conflict-log.jsonl");
    let original = fs::read(&file).unwrap();
    assert_eq!(std::str::from_utf8(&original).unwrap().lines().count(), 1);
    f.policy.stop_after_log.store(false, Ordering::SeqCst);
    f.policy.allowed.store(true, Ordering::SeqCst);
    assert_eq!(
        f.ledger
            .summary(&f.principal, &f.agent, &Cancel::never())
            .unwrap()
            .count,
        1
    );
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &Cancel::never())
        .unwrap();
    assert_eq!(fs::read(file).unwrap(), original);
}
#[test]
fn cached_forgery_and_foreign_or_conflicting_rows_do_not_supply_counts() {
    let f = setup();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &Cancel::never())
        .unwrap();
    let dir = f.root.path().join("workspace/.adaptive-learning");
    let log = dir.join("conflict-log.jsonl");
    let original = fs::read_to_string(&log).unwrap();
    let mut other: Value = serde_json::from_str(original.trim()).unwrap();
    other["ownerUserId"] = json!(harness_user_principal("other"));
    let mut conflict: Value = serde_json::from_str(original.trim()).unwrap();
    conflict["visibility"] = json!({"ownerUserId":harness_user_principal("other")});
    fs::write(&log, format!("{original}{other}\n{conflict}\n")).unwrap();
    for file in fs::read_dir(&dir)
        .unwrap()
        .map(|v| v.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("native-conflict-review-summary-")
        })
    {
        fs::write(file, r#"{"summary":{"count":99999,"sizeBytes":99999999}}"#).unwrap();
    }
    let summary = f
        .ledger
        .summary(&f.principal, &f.agent, &Cancel::never())
        .unwrap();
    assert_eq!(summary.count, 1);
    assert_eq!(summary.size_bytes, original.len());
}
#[test]
fn operation_uuid_reuse_with_a_different_observation_refuses_without_rewriting() {
    let mut f = setup();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &Cancel::never())
        .unwrap();
    let file = f
        .root
        .path()
        .join("workspace/.adaptive-learning/conflict-log.jsonl");
    let original = fs::read(&file).unwrap();
    f.request.score = 0.9;
    assert!(f
        .ledger
        .record(&f.request, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    assert_eq!(fs::read(file).unwrap(), original);
}
#[test]
fn malformed_torn_and_linked_files_refuse_without_repair_or_external_writes() {
    for mode in ["malformed", "torn", "symlink", "hardlink"] {
        let f = setup();
        let dir = f.root.path().join("workspace/.adaptive-learning");
        fs::create_dir(&dir).unwrap();
        let file = dir.join("conflict-log.jsonl");
        let outside = f.root.path().join("outside");
        fs::write(&outside, "foreign contents").unwrap();
        match mode {
            "malformed" => fs::write(&file, "not-json\n").unwrap(),
            "torn" => fs::write(&file, r#"{"old":"#).unwrap(),
            "symlink" => {
                #[cfg(unix)]
                std::os::unix::fs::symlink(&outside, &file).unwrap();
                #[cfg(not(unix))]
                continue;
            }
            _ => fs::hard_link(&outside, &file).unwrap(),
        }
        let old = fs::read(&file).unwrap();
        assert!(f
            .ledger
            .record(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert_eq!(fs::read(&file).unwrap(), old);
        assert_eq!(fs::read_to_string(outside).unwrap(), "foreign contents");
    }
}

#[test]
fn cancellation_capacity_and_unsafe_cache_refuse_before_new_authoritative_bytes() {
    for mode in ["cancel", "bytes", "rows", "cache"] {
        let mut f = setup();
        let dir = f.root.path().join("workspace/.adaptive-learning");
        let log = dir.join("conflict-log.jsonl");
        let cancel = Cancel::never();
        if mode == "cancel" {
            cancel.cancel();
            assert!(f
                .ledger
                .record(&f.request, &f.principal, &f.agent, &cancel)
                .is_err());
            assert!(!log.exists());
            continue;
        }
        if mode == "cache" {
            #[cfg(not(unix))]
            continue;
            #[cfg(unix)]
            {
                f.ledger
                    .record(&f.request, &f.principal, &f.agent, &cancel)
                    .unwrap();
                let cache = fs::read_dir(&dir)
                    .unwrap()
                    .map(|v| v.unwrap().path())
                    .find(|p| {
                        p.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with("native-conflict-review-summary-")
                    })
                    .unwrap();
                let outside = f.root.path().join("outside-cache");
                fs::write(&outside, "private outside").unwrap();
                fs::remove_file(&cache).unwrap();
                std::os::unix::fs::symlink(outside, cache).unwrap();
                f.request.operation_id = uuid::Uuid::new_v4();
            }
        } else {
            fs::create_dir(&dir).unwrap();
            if mode == "bytes" {
                fs::File::create(&log)
                    .unwrap()
                    .set_len(64 * 1024 * 1024 + 1)
                    .unwrap();
            } else {
                fs::write(&log, "{}\n".repeat(50_000)).unwrap();
            }
        }
        let before = fs::metadata(&log).unwrap().len();
        assert!(
            f.ledger
                .record(&f.request, &f.principal, &f.agent, &cancel)
                .is_err(),
            "{mode}"
        );
        assert_eq!(fs::metadata(&log).unwrap().len(), before);
    }
}
#[cfg(unix)]
#[test]
fn existing_loose_log_modes_are_tightened_without_dropping_old_records() {
    use std::os::unix::fs::PermissionsExt;
    let f = setup();
    let dir = f.root.path().join("workspace/.adaptive-learning");
    fs::create_dir(&dir).unwrap();
    let log = dir.join("conflict-log.jsonl");
    fs::write(&log, concat!(r#"{"old":true}"#, "\n")).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&log, fs::Permissions::from_mode(0o644)).unwrap();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &Cancel::never())
        .unwrap();
    assert!(fs::read_to_string(&log)
        .unwrap()
        .starts_with(concat!(r#"{"old":true}"#, "\n")));
    assert_eq!(fs::metadata(&log).unwrap().permissions().mode() & 0o077, 0);
    assert_eq!(fs::metadata(dir).unwrap().permissions().mode() & 0o077, 0);
    assert_eq!(
        f.ledger
            .summary(&f.principal, &f.agent, &Cancel::never())
            .unwrap()
            .count,
        1
    );
}
