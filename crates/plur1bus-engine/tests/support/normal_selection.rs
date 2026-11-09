//! Actual private query selection before bounded semantic decisions and provider preparation.
use super::*;
use plur1bus_engine::ops::durable_merge::NormalCandidateKind;
fn setup_selection(merge: bool) -> Fixture {
    let f = setup();
    f.base
        .store
        .delete(&["00000000-0000-4000-8000-000000000002"])
        .unwrap();
    if merge {
        let mut row = f.base.store.get(SOURCE).unwrap().unwrap();
        row.vector = vec![0.5, 0., 0., 0.];
        row.text = "A synthetic decision with context".into();
        f.base.store.upsert(&[row]).unwrap();
    }
    f
}
fn params() -> plur1bus_engine::text::json::TolerantJsonValue {
    parse_json(r#"{"text":"A synthetic decision","category":"decision","ttl":"session"}"#).unwrap()
}
#[test]
fn actual_query_duplicate_stops_before_model_and_merge_uses_frozen_admission_time() {
    for merge in [false, true] {
        let f = setup_selection(merge);
        let selected = f
            .merge
            .select_normal(
                &params(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
        if merge {
            assert!(matches!(selected.kind(), NormalCandidateKind::Merge { .. }));
            f.host.inner.time.store(1735689609000, Ordering::SeqCst);
            let result = f
                .merge
                .merge_selected(
                    &selected,
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never(),
                )
                .unwrap()
                .unwrap();
            let row = f.base.store.get(&result.replacement_id).unwrap().unwrap();
            assert_eq!(row.expires_at.as_f64(), Some(1735689600000. + 86400000.));
            assert_eq!(row.created_at.as_f64(), Some(1735689609000.));
            assert_eq!(f.embed.calls.load(Ordering::SeqCst), 2);
            assert_eq!(f.host.calls.load(Ordering::SeqCst), 1);
        } else {
            assert!(matches!(selected.kind(),NormalCandidateKind::Duplicate{id,..} if id==SOURCE));
            assert!(f
                .merge
                .merge_selected(
                    &selected,
                    &f.base.principal,
                    &f.base.agent,
                    &Cancel::never()
                )
                .unwrap()
                .is_none());
            assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
        }
    }
}
#[test]
fn foreign_nearest_rows_never_exhaust_private_semantic_budgets() {
    let f = setup_selection(true);
    let base = f.base.store.get(SOURCE).unwrap().unwrap();
    let mut rows = vec![];
    for i in 10..110 {
        let mut row = base.clone();
        row.id = format!("00000000-0000-4000-8000-{i:012}");
        row.vector = vec![1., 0., 0., 0.];
        if i % 2 == 0 {
            row.agent_id = "beta".into();
            row.stored_by = "beta".into();
        } else {
            row.owner_user_id = plur1bus_engine::context::harness_user_principal("foreign");
        }
        rows.push(row);
    }
    f.base.store.upsert(&rows).unwrap();
    let selected = f
        .merge
        .select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    assert!(matches!(selected.kind(),NormalCandidateKind::Merge{id,..} if id==SOURCE));
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn tombstoned_nearest_rows_are_removed_before_the_ten_five_limits() {
    let f = setup_selection(true);
    let base = f.base.store.get(SOURCE).unwrap().unwrap();
    let registry = plur1bus_engine::store::tombstone::TombstoneRegistry::new(
        &f.base.root.path().join("store"),
        "alpha",
    )
    .unwrap();
    for i in 10..24 {
        let mut row = base.clone();
        row.id = format!("00000000-0000-4000-8000-{i:012}");
        row.vector = vec![1., 0., 0., 0.];
        row.text = format!("Unrelated private card {i}");
        f.base.store.upsert(&[row.clone()]).unwrap();
        let value = json!({"schemaVersion":1,"agentId":"alpha","memoryId":row.id,"canonicalOriginId":row.id,"scope":"agent-private","status":"committed","contentFingerprint":plur1bus_engine::store::tombstone::content_fingerprint(&row.text)});
        registry
            .append(&parse_json(&value.to_string()).unwrap())
            .unwrap();
    }
    let selected = f
        .merge
        .select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    assert!(matches!(selected.kind(),NormalCandidateKind::Merge{id,..} if id==SOURCE));
}
#[test]
fn forgotten_input_and_denied_policy_never_reach_embedding() {
    for forgotten in [false, true] {
        let f = setup_selection(false);
        if forgotten {
            let registry = plur1bus_engine::store::tombstone::TombstoneRegistry::new(
                &f.base.root.path().join("store"),
                "alpha",
            )
            .unwrap();
            registry.append(&parse_json(&json!({"schemaVersion":1,"agentId":"alpha","memoryId":SOURCE,"canonicalOriginId":SOURCE,"scope":"agent-private","status":"committed","contentFingerprint":plur1bus_engine::store::tombstone::content_fingerprint("A synthetic decision")}).to_string()).unwrap()).unwrap();
        } else {
            f.policy.allowed.store(false, Ordering::SeqCst);
        }
        let result = f.merge.select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        );
        if forgotten {
            assert!(matches!(
                result.unwrap().kind(),
                NormalCandidateKind::Forgotten
            ));
        } else {
            assert!(result.is_err());
        }
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn selected_source_caller_and_config_cannot_be_replaced_before_model() {
    for change in ["source", "caller", "config", "policy"] {
        let f = setup_selection(true);
        let selected = f
            .merge
            .select_normal(
                &params(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never(),
            )
            .unwrap();
        let mut principal = f.base.principal.clone();
        match change {
            "source" => {
                f.base
                    .store
                    .patch(
                        SOURCE,
                        &RowPatch {
                            text: Some("Changed after selection".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "caller" => {
                let mut raw = serde_json::to_value(&principal).unwrap();
                raw["chat"]["id"] = "another-chat".into();
                principal = serde_json::from_value(raw).unwrap();
            }
            "policy" => f.policy.allowed.store(false, Ordering::SeqCst),
            _ => f.host.config.lock().unwrap()["merging"]["autoApply"] = false.into(),
        };
        assert!(
            f.merge
                .merge_selected(&selected, &principal, &f.base.agent, &Cancel::never())
                .is_err(),
            "{change}"
        );
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
        assert!(f.base.store.get(SOURCE).unwrap().is_some());
    }
}
#[test]
fn input_embedding_must_revalidate_policy_and_configuration_before_query() {
    for config in [false, true] {
        let f = setup_selection(true);
        let effect: Effect = if config {
            let host = f.host.clone();
            Arc::new(move || {
                host.config.lock().unwrap()["merging"]["autoApply"] = false.into();
            })
        } else {
            let policy = f.policy.clone();
            Arc::new(move || policy.allowed.store(false, Ordering::SeqCst))
        };
        *f.embed.effect.lock().unwrap() = Some(effect);
        assert!(f
            .merge
            .select_normal(
                &params(),
                &f.base.principal,
                &f.base.agent,
                &Cancel::never()
            )
            .is_err());
        assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
        assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn a_different_registry_root_cannot_borrow_the_original_selection() {
    let f = setup_selection(true);
    let selected = f
        .merge
        .select_normal(
            &params(),
            &f.base.principal,
            &f.base.agent,
            &Cancel::never(),
        )
        .unwrap();
    let other = f.base.root.path().join("other-registry-root");
    std::fs::create_dir(&other).unwrap();
    let journal = Arc::new(
        CaptureJournal::open(
            &f.base.root.path().join("neo"),
            f.host.clone(),
            f.policy.clone(),
        )
        .unwrap(),
    );
    let reader = Arc::new(MemoryReader::new(
        Arc::new(OperationContext::new(f.host.clone())),
        Arc::new(Sources(f.base.store.clone())),
        f.embed.clone(),
        other,
    ));
    let merge = NativeMerge::new(reader, journal);
    assert!(merge
        .merge_selected(
            &selected,
            &f.base.principal,
            &f.base.agent,
            &Cancel::never()
        )
        .is_err());
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 1);
}
