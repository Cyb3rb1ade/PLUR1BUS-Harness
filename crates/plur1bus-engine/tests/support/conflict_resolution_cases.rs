//! Durable recommendations remain separate from an authorized actual application.
use super::*;
use plur1bus_engine::{ops::conflicts::ResolutionRequest, text::json::parse_json};
#[test]
fn actual_sources_back_a_durable_proposal_but_both_memories_remain_unchanged() {
    let f = setup();
    let cancel = Cancel::never();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &cancel)
        .unwrap();
    let decision =
        parse_json(r#"{"resolution":"keep_a","confidence":0.95,"reason":"fixture"}"#).unwrap();
    let request = ResolutionRequest {
        operation_id: uuid::Uuid::new_v4(),
        conflict: &f.request,
        decision: &decision,
    };
    let first = f
        .ledger
        .propose_resolution(&request, &f.principal, &f.agent, &cancel)
        .unwrap();
    assert_eq!(first["recommendation"], "apply_via_safe_reconsolidation");
    assert_eq!(first["scope"], "agent_private");
    assert_eq!(
        f.ledger
            .propose_resolution(&request, &f.principal, &f.agent, &cancel)
            .unwrap(),
        first
    );
    assert_eq!(
        f.ledger
            .find_resolution(&f.request.new.row.id, &f.principal, &f.agent, &cancel)
            .unwrap(),
        Some(first)
    );
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
}
#[test]
fn proposals_require_a_current_owned_observation_and_current_source_snapshots() {
    for mode in ["absent", "changed", "revoked"] {
        let f = setup();
        let cancel = Cancel::never();
        if mode != "absent" {
            f.ledger
                .record(&f.request, &f.principal, &f.agent, &cancel)
                .unwrap();
        }
        if mode == "changed" {
            f.store
                .patch(
                    &f.request.existing.row.id,
                    &RowPatch {
                        text: Some("changed source".into()),
                        ..RowPatch::default()
                    },
                )
                .unwrap();
        }
        if mode == "revoked" {
            f.policy.allowed.store(false, Ordering::SeqCst);
        }
        let decision =
            parse_json(r#"{"resolution":"keep_a","confidence":0.95,"reason":"fixture"}"#).unwrap();
        let request = ResolutionRequest {
            operation_id: uuid::Uuid::new_v4(),
            conflict: &f.request,
            decision: &decision,
        };
        assert!(
            f.ledger
                .propose_resolution(&request, &f.principal, &f.agent, &cancel)
                .is_err(),
            "{mode}"
        );
        assert!(!f
            .root
            .path()
            .join("workspace/.adaptive-learning/conflict-resolved.jsonl")
            .exists());
    }
}
#[test]
fn removed_observation_cannot_leave_an_applicable_recommendation() {
    let f = setup();
    let cancel = Cancel::never();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &cancel)
        .unwrap();
    let decision =
        parse_json(r#"{"resolution":"keep_a","confidence":0.95,"reason":"fixture"}"#).unwrap();
    let request = ResolutionRequest {
        operation_id: uuid::Uuid::new_v4(),
        conflict: &f.request,
        decision: &decision,
    };
    f.ledger
        .propose_resolution(&request, &f.principal, &f.agent, &cancel)
        .unwrap();
    fs::write(
        f.root
            .path()
            .join("workspace/.adaptive-learning/conflict-log.jsonl"),
        "",
    )
    .unwrap();
    assert!(f
        .ledger
        .find_resolution(&f.request.new.row.id, &f.principal, &f.agent, &cancel)
        .is_err());
}
#[test]
fn concurrent_proposal_retries_are_single_and_colliding_decisions_refuse() {
    let f = setup();
    let cancel = Cancel::never();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &cancel)
        .unwrap();
    let decision=parse_json(r#"{"resolution":"merge","confidence":0.95,"reason":"fixture","mergedText":"Combined synthetic decision"}"#).unwrap();
    let operation_id = uuid::Uuid::new_v4();
    let request = ResolutionRequest {
        operation_id,
        conflict: &f.request,
        decision: &decision,
    };
    std::thread::scope(|scope| {
        let hs = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    f.ledger
                        .propose_resolution(&request, &f.principal, &f.agent, &cancel)
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
        .join("workspace/.adaptive-learning/conflict-resolved.jsonl");
    let before = fs::read(&file).unwrap();
    assert_eq!(std::str::from_utf8(&before).unwrap().lines().count(), 1);
    let changed =
        parse_json(r#"{"resolution":"keep_b","confidence":0.95,"reason":"fixture"}"#).unwrap();
    let request = ResolutionRequest {
        operation_id,
        conflict: &f.request,
        decision: &changed,
    };
    assert!(f
        .ledger
        .propose_resolution(&request, &f.principal, &f.agent, &cancel)
        .is_err());
    assert_eq!(fs::read(file).unwrap(), before);
}
#[test]
fn recommendation_lookup_filters_before_tail_and_rechecks_current_access() {
    let f = setup();
    let cancel = Cancel::never();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &cancel)
        .unwrap();
    let decision =
        parse_json(r#"{"resolution":"keep_a","confidence":0.95,"reason":"fixture"}"#).unwrap();
    let request = ResolutionRequest {
        operation_id: uuid::Uuid::new_v4(),
        conflict: &f.request,
        decision: &decision,
    };
    let row = f
        .ledger
        .propose_resolution(&request, &f.principal, &f.agent, &cancel)
        .unwrap();
    let file = f
        .root
        .path()
        .join("workspace/.adaptive-learning/conflict-resolved.jsonl");
    let mut bytes = fs::read(&file).unwrap();
    let mut foreign = row.clone();
    foreign["ownerUserId"] = json!("foreign-owner");
    let line = serde_json::to_string(&foreign).unwrap() + "\n";
    for _ in 0..1100 {
        bytes.extend_from_slice(line.as_bytes());
    }
    fs::write(&file, bytes).unwrap();
    assert_eq!(
        f.ledger
            .find_resolution(&f.request.new.row.id, &f.principal, &f.agent, &cancel)
            .unwrap(),
        Some(row)
    );
    f.store
        .patch(
            &f.request.existing.row.id,
            &RowPatch {
                status: Some("deleted".into()),
                ..RowPatch::default()
            },
        )
        .unwrap();
    assert!(f
        .ledger
        .find_resolution(&f.request.new.row.id, &f.principal, &f.agent, &cancel)
        .is_err());
}
#[test]
fn review_only_is_not_selected_and_torn_proposal_logs_refuse() {
    let f = setup();
    let cancel = Cancel::never();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &cancel)
        .unwrap();
    let decision = parse_json(
        r#"{"resolution":"merge","confidence":0.8,"reason":"fixture","mergedText":"Review"}"#,
    )
    .unwrap();
    let request = ResolutionRequest {
        operation_id: uuid::Uuid::new_v4(),
        conflict: &f.request,
        decision: &decision,
    };
    f.ledger
        .propose_resolution(&request, &f.principal, &f.agent, &cancel)
        .unwrap();
    assert!(f
        .ledger
        .find_resolution(&f.request.new.row.id, &f.principal, &f.agent, &cancel)
        .unwrap()
        .is_none());
    let file = f
        .root
        .path()
        .join("workspace/.adaptive-learning/conflict-resolved.jsonl");
    let mut bytes = fs::read(&file).unwrap();
    bytes.push(b'{');
    fs::write(file, bytes).unwrap();
    assert!(f
        .ledger
        .find_resolution(&f.request.new.row.id, &f.principal, &f.agent, &cancel)
        .is_err());
    assert!(f
        .ledger
        .propose_resolution(&request, &f.principal, &f.agent, &cancel)
        .is_err());
}
