//! Human facade mode preserves C4 CAS while requiring its audit before any revision.
use super::*;
#[cfg(feature = "testkit")]
use plur1bus_engine::contract::StoreError;
fn seeded() -> (Fixture, RevisionRequest) {
    let f = fixture();
    let case = cases().remove(0);
    let request = request(&case, source(&f, &case));
    (f, request)
}
fn apply(
    f: &Fixture,
    request: &RevisionRequest,
) -> Result<plur1bus_engine::neo::revisions::RevisionResult, EngineError> {
    f.store
        .apply_curation(&f.principal, &f.agent, request, &Cancel::never())
}
#[test]
fn facade_preserves_c4_transition_and_origin_with_one_distinct_audit() {
    for case in cases()
        .into_iter()
        .filter(|case| ["keep", "drop"].contains(&string(field(case, "action")).as_str()))
    {
        let f = fixture();
        let request = request(&case, source(&f, &case));
        let result = apply(&f, &request).unwrap();
        assert_eq!(result.record, bound(&f, field(&case, "revision")));
        let audit = rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"));
        assert_eq!(audit.len(), 1);
        assert_eq!(field(&audit[0], "source"), &text("engine.memory.curation"));
        assert_eq!(field(&audit[0], "event"), &text("curation.resolve"));
        assert_eq!(field(&audit[0], "action"), &text(request.action.as_str()));
        assert_eq!(
            field(&audit[0], "operationId"),
            &text(&request.operation_id.to_string())
        );
        assert_eq!(apply(&f, &request).unwrap().record, result.record);
        assert_eq!(
            rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
            1
        );
        assert!(!f.directory.join("embedding-queue.jsonl").exists());
        assert_eq!(result.store, string(field(&case, "origin")));
        assert!(f
            .store
            .apply(&f.principal, &f.agent, &request, &Cancel::never())
            .is_err());
    }
}
#[test]
fn facade_refuses_background_nonhuman_resolved_other_actions_and_cancel_before_receipt() {
    for mode in [
        "background",
        "system",
        "cron",
        "subagent",
        "resolved",
        "promote",
        "cancel",
    ] {
        let (mut f, mut request) = seeded();
        let cancel = Cancel::never();
        match mode {
            "background" => {
                f.agent =
                    serde_json::from_value(json!({"origin":"user","background":true})).unwrap()
            }
            "system" | "cron" | "subagent" => {
                f.agent = serde_json::from_value(json!({"origin":mode,"background":false})).unwrap()
            }
            "resolved" => set(&mut request.expected, "status", text("promoted")),
            "promote" => request.action = Action::Promote,
            "cancel" => cancel.cancel(),
            _ => panic!("unknown fixture mode"),
        }
        assert!(f
            .store
            .apply_curation(&f.principal, &f.agent, &request, &cancel)
            .is_err());
        assert!(!f.directory.join("native-revision-state.json").exists());
        assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
        assert!(!f.workspace.join(".adaptive-learning").exists());
    }
}
#[test]
fn legacy_receipts_cannot_be_reinterpreted_as_facade_requests() {
    let (f, request) = seeded();
    f.store
        .apply(&f.principal, &f.agent, &request, &Cancel::never())
        .unwrap();
    assert!(apply(&f, &request).is_err());
    let audit = rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"));
    assert_eq!(audit.len(), 1);
    assert_eq!(field(&audit[0], "source"), &text("plur1bus_curation"));
}
#[cfg(feature = "testkit")]
#[test]
fn audit_is_durable_before_revision_and_recovery_uses_original_mode() {
    for stage in ["prepared", "audit", "revision", "queue", "complete"] {
        let (mut f, request) = seeded();
        f.store = f.store.with_observer(Arc::new(move |found| {
            if found == stage {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(apply(&f, &request).is_err());
        let audit = rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"));
        assert_eq!(audit.len(), usize::from(stage != "prepared"));
        assert_eq!(
            rows(f.directory.join("behavior-cards.jsonl")).len(),
            if ["prepared", "audit"].contains(&stage) {
                1
            } else {
                2
            }
        );
        let journal = Arc::new(
            CaptureJournal::open(
                &f._root.path().join("neo"),
                f.host.clone(),
                f.policy.clone(),
            )
            .unwrap(),
        );
        let store = RevisionStore::open(journal, f.host.clone()).unwrap();
        assert_eq!(store.recover_pending(&Cancel::never()).unwrap(), 0);
        assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
        let audit = rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"));
        assert_eq!(audit.len(), 1);
        assert_eq!(field(&audit[0], "source"), &text("engine.memory.curation"));
    }
}
#[cfg(feature = "testkit")]
#[test]
fn audit_destination_changed_after_prepare_leaves_source_unchanged() {
    let (mut f, request) = seeded();
    let audit = f.workspace.join(".adaptive-learning/destructive-ops.jsonl");
    f.store = f.store.with_observer(Arc::new(move |stage| {
        if stage == "prepared" {
            fs::create_dir(&audit).unwrap();
        }
        Ok(())
    }));
    assert!(apply(&f, &request).is_err());
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
    assert!(!f.directory.join("embedding-queue.jsonl").exists());
}

#[cfg(feature = "testkit")]
#[path = "neo_curation_writer_recovery.rs"]
mod recovery;
