//! Review plans bind exact caller, proposal, model and sources without granting a write.
use super::*;
use plur1bus_engine::{
    ops::conflicts::{ApplicationRequest, ResolutionRequest},
    text::json::parse_json,
};
fn owned_fixture() -> Fixture {
    let mut f = setup();
    let mut row = f.request.existing.row.clone();
    row.scope = "agent-private".into();
    row.agent_id = "alpha".into();
    row.stored_by = "alpha".into();
    f.store.upsert(&[row.clone()]).unwrap();
    f.request.existing = f.store.get_record(&row.id).unwrap().unwrap();
    f
}
fn propose(f: &Fixture) -> Value {
    let cancel = Cancel::never();
    f.ledger
        .record(&f.request, &f.principal, &f.agent, &cancel)
        .unwrap();
    let decision = parse_json(r#"{"resolution":"merge","confidence":0.95,"reason":"explicit synthetic evidence","mergedText":"Combined synthetic decision"}"#).unwrap();
    f.ledger
        .propose_resolution(
            &ResolutionRequest {
                operation_id: uuid::Uuid::new_v4(),
                conflict: &f.request,
                decision: &decision,
            },
            &f.principal,
            &f.agent,
            &cancel,
        )
        .unwrap()
}
fn request<'a>(f: &'a Fixture, proposal: &'a Value) -> ApplicationRequest<'a> {
    ApplicationRequest {
        operation_id: uuid::Uuid::new_v4(),
        memory_id: &f.request.new.row.id,
        expected_proposal: proposal,
        vector: vec![1., 0., 0., 0.],
        identity: f.store.identity().unwrap(),
    }
}
#[test]
fn review_plan_freezes_actual_successor_and_preserves_both_memories() {
    let f = owned_fixture();
    let proposal = propose(&f);
    let plan = f
        .ledger
        .prepare_application(
            &request(&f, &proposal),
            &f.principal,
            &f.agent,
            &Cancel::never(),
        )
        .unwrap();
    let review = plan.review();
    assert_eq!(review["command"], "conflict-apply");
    assert_eq!(review["targetId"], f.request.existing.row.id);
    assert_eq!(review["newText"], "Combined synthetic decision");
    assert_ne!(review["successorId"], review["targetId"]);
    assert_eq!(review["proposalId"], proposal["operationId"]);
    assert_eq!(review["semanticDrift"], 0.);
    assert!(plan.fingerprint().starts_with("sha256:"));
    f.ledger
        .validate_application(&plan, &f.principal, &f.agent, &Cancel::never())
        .unwrap();
    for row in [&f.request.new.row, &f.request.existing.row] {
        assert_eq!(
            serde_json::to_value(f.store.get(&row.id).unwrap().unwrap()).unwrap(),
            serde_json::to_value(row).unwrap()
        );
    }
    assert!(f
        .store
        .get(review["successorId"].as_str().unwrap())
        .unwrap()
        .is_none());
}
#[test]
fn readable_shared_origin_never_becomes_a_writable_application_target() {
    let f = setup();
    let proposal = propose(&f);
    assert!(f
        .ledger
        .prepare_application(
            &request(&f, &proposal),
            &f.principal,
            &f.agent,
            &Cancel::never()
        )
        .is_err());
}
#[test]
fn application_refuses_changed_proposal_model_invalid_vector_and_semantic_drift() {
    let f = owned_fixture();
    let proposal = propose(&f);
    for mode in ["proposal", "model", "dimension", "nan", "drift", "nil"] {
        let mut changed = proposal.clone();
        if mode == "proposal" {
            changed["mergedText"] = json!("unapproved replacement");
        }
        let mut identity = f.store.identity().unwrap().clone();
        identity.model.push_str("-other");
        let mut req = request(&f, &changed);
        if mode == "model" {
            req.identity = &identity;
        }
        if mode == "dimension" {
            req.vector = vec![1.];
        }
        if mode == "nan" {
            req.vector[0] = f32::NAN;
        }
        if mode == "drift" {
            req.vector = vec![0., 1., 0., 0.];
        }
        if mode == "nil" {
            req.operation_id = uuid::Uuid::nil();
        }
        assert!(
            f.ledger
                .prepare_application(&req, &f.principal, &f.agent, &Cancel::never())
                .is_err(),
            "{mode}"
        );
    }
}
#[test]
fn revalidation_binds_exact_chat_and_agent_context_not_only_read_acl() {
    let f = owned_fixture();
    let proposal = propose(&f);
    let plan = f
        .ledger
        .prepare_application(
            &request(&f, &proposal),
            &f.principal,
            &f.agent,
            &Cancel::never(),
        )
        .unwrap();
    for mode in ["chat", "account", "background"] {
        let mut principal = serde_json::to_value(&f.principal).unwrap();
        let mut agent = serde_json::to_value(&f.agent).unwrap();
        if mode == "chat" {
            principal["chat"]["id"] = json!("another-chat");
        }
        if mode == "account" {
            principal["accountId"] = json!("another-account");
        }
        if mode == "background" {
            agent["background"] = json!(true);
        }
        assert!(
            f.ledger
                .validate_application(
                    &plan,
                    &serde_json::from_value(principal).unwrap(),
                    &serde_json::from_value(agent).unwrap(),
                    &Cancel::never()
                )
                .is_err(),
            "{mode}"
        );
    }
}
#[test]
fn revalidation_refuses_changed_source_withdrawn_proposal_and_current_policy() {
    for mode in ["source", "proposal", "policy", "successor"] {
        let f = owned_fixture();
        let proposal = propose(&f);
        let plan = f
            .ledger
            .prepare_application(
                &request(&f, &proposal),
                &f.principal,
                &f.agent,
                &Cancel::never(),
            )
            .unwrap();
        if mode == "source" {
            f.store
                .patch(
                    &f.request.existing.row.id,
                    &RowPatch {
                        text: Some("changed".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if mode == "proposal" {
            fs::write(
                f.root
                    .path()
                    .join("workspace/.adaptive-learning/conflict-resolved.jsonl"),
                "",
            )
            .unwrap();
        }
        if mode == "policy" {
            f.policy.allowed.store(false, Ordering::SeqCst);
        }
        if mode == "successor" {
            let mut unrelated = f.request.new.row.clone();
            unrelated.id = plan.review()["successorId"].as_str().unwrap().into();
            f.store.upsert(&[unrelated]).unwrap();
        }
        assert!(
            f.ledger
                .validate_application(&plan, &f.principal, &f.agent, &Cancel::never())
                .is_err(),
            "{mode}"
        );
    }
}
