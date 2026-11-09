//! Frozen curation trait through actual caller-bound native stores.
use super::*;
use plur1bus_engine::{
    contract::{
        MemoryCurationAction, MemoryCurationListQuery, MemoryCurationOps, MemoryOpErrorCode,
    },
    ops::{context::OperationContext, curation::NativeCuration},
};
fn native(f: &Fixture) -> (Arc<OperationContext>, NativeCuration) {
    let context = Arc::new(OperationContext::new(f.host.clone()));
    let journal = Arc::new(
        CaptureJournal::open(
            &f._root.path().join("neo"),
            f.host.clone(),
            f.policy.clone(),
        )
        .unwrap(),
    );
    let native = NativeCuration::new(context.clone(), journal);
    (context, native)
}
fn seeded() -> Fixture {
    let f = fixture();
    source(&f, &cases().remove(0));
    f
}
#[test]
fn actual_trait_lists_resolves_and_audits_both_human_choices() {
    for action in [MemoryCurationAction::Keep, MemoryCurationAction::Drop] {
        let f = seeded();
        let (_, native) = native(&f);
        let listed = native
            .list(MemoryCurationListQuery::default(), &f.principal, &f.agent)
            .unwrap();
        assert_eq!(listed.items.len(), 1);
        let id = &listed.items[0].id;
        let expected = if action == MemoryCurationAction::Keep {
            "promoted"
        } else {
            "demoted"
        };
        let result = native.resolve(id, action, &f.principal, &f.agent).unwrap();
        assert!(result.ok);
        assert_eq!(result.id, *id);
        assert_eq!(result.status.as_deref(), Some(expected));
        assert_eq!(
            native
                .list(MemoryCurationListQuery::default(), &f.principal, &f.agent)
                .unwrap()
                .items
                .len(),
            0
        );
        assert!(
            matches!(native.resolve(id,action,&f.principal,&f.agent),Err(EngineError::MemoryOp(e)) if e.code==MemoryOpErrorCode::NotFound)
        );
        assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
        let audit = rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"));
        assert_eq!(audit.len(), 1);
        assert_eq!(field(&audit[0], "source"), &text("engine.memory.curation"));
        assert!(!f.directory.join("embedding-queue.jsonl").exists());
    }
}
#[test]
fn foreign_owner_nonhuman_invalid_id_and_closed_context_never_mutate() {
    let f = seeded();
    let (context, native) = native(&f);
    for id in [" ".into(), "x".repeat(201)] {
        assert!(
            matches!(native.resolve(&id,MemoryCurationAction::Keep,&f.principal,&f.agent),Err(EngineError::MemoryOp(e)) if e.code==MemoryOpErrorCode::InvalidInput)
        );
    }
    for origin in ["system", "cron", "subagent"] {
        let agent = serde_json::from_value(json!({"origin":origin,"background":false})).unwrap();
        assert!(native
            .list(MemoryCurationListQuery::default(), &f.principal, &agent)
            .is_err());
        assert!(native
            .resolve(
                "beh_revision",
                MemoryCurationAction::Keep,
                &f.principal,
                &agent
            )
            .is_err());
    }
    let mut other = serde_json::to_value(&f.principal).unwrap();
    other["user"] = json!(harness_user_principal("other"));
    let other = serde_json::from_value(other).unwrap();
    assert!(native
        .list(MemoryCurationListQuery::default(), &other, &f.agent)
        .unwrap()
        .items
        .is_empty());
    assert!(
        matches!(native.resolve("beh_revision",MemoryCurationAction::Drop,&other,&f.agent),Err(EngineError::MemoryOp(e)) if e.code==MemoryOpErrorCode::NotFound)
    );
    context.close();
    assert!(native
        .list(MemoryCurationListQuery::default(), &f.principal, &f.agent)
        .is_err());
    assert!(native
        .resolve(
            "beh_revision",
            MemoryCurationAction::Keep,
            &f.principal,
            &f.agent
        )
        .is_err());
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
    assert!(!f.workspace.join(".adaptive-learning").exists());
}
#[test]
fn incompatible_legacy_result_text_is_not_silently_replaced_in_typed_output() {
    let f = seeded();
    let (_, native) = native(&f);
    let path = f.directory.join("behavior-cards.jsonl");
    let mut row = rows(&path).remove(0);
    set(
        &mut row,
        "statement",
        parse_json("\"raw-\\ud800-text\"").unwrap(),
    );
    let bytes = format!("{}\n", write_json(&row));
    fs::write(&path, &bytes).unwrap();
    assert!(native
        .list(MemoryCurationListQuery::default(), &f.principal, &f.agent)
        .is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), bytes);
}
#[cfg(feature = "testkit")]
#[test]
fn closing_during_prepare_stops_the_next_durable_effect_and_drains() {
    let f = seeded();
    let (context, native) = native(&f);
    let gate = context.clone();
    let started = Arc::new(AtomicBool::new(false));
    let signal = started.clone();
    let native = native.with_observer(Arc::new(move |stage| {
        if stage == "prepared" {
            signal.store(true, Ordering::SeqCst);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while gate.assert_open().is_ok() {
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
        }
        Ok(())
    }));
    std::thread::scope(|scope| {
        let run = scope.spawn(|| {
            native.resolve(
                "beh_revision",
                MemoryCurationAction::Keep,
                &f.principal,
                &f.agent,
            )
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !started.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        context.close();
        assert!(run.join().unwrap().is_err());
    });
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
    assert!(rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).is_empty());
}
#[test]
fn cancelled_calls_create_no_receipt_and_concurrent_decisions_commit_once() {
    let f = seeded();
    let (_, native) = native(&f);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(native
        .list_with_cancel(
            &MemoryCurationListQuery::default(),
            &f.principal,
            &f.agent,
            &cancel
        )
        .is_err());
    assert!(native
        .resolve_with_cancel(
            "beh_revision",
            MemoryCurationAction::Keep,
            &f.principal,
            &f.agent,
            &cancel
        )
        .is_err());
    assert!(!f.directory.join("native-revision-state.json").exists());
    assert!(
        matches!(native.resolve("bad\0id",MemoryCurationAction::Keep,&f.principal,&f.agent),Err(EngineError::MemoryOp(e)) if e.code==MemoryOpErrorCode::NotFound)
    );
    std::thread::scope(|scope| {
        let runs = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    native.resolve(
                        "beh_revision",
                        MemoryCurationAction::Keep,
                        &f.principal,
                        &f.agent,
                    )
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            runs.into_iter()
                .map(|r| r.join().unwrap())
                .filter(Result::is_ok)
                .count(),
            1
        );
    });
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
    assert_eq!(
        rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
        1
    );
}
