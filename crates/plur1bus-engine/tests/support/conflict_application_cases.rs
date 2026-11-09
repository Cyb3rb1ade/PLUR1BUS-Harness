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

use plur1bus_engine::ops::conflicts::{
    ApplicationAuthorization, ConfirmationCheck, ConfirmationVerifier,
};
struct Verifier {
    fingerprint: String,
    calls: std::sync::atomic::AtomicUsize,
    allowed: bool,
}
impl ConfirmationVerifier for Verifier {
    fn verify(&self, request: &ConfirmationCheck<'_>, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.allowed
            || request.fingerprint != self.fingerprint
            || request.command != "conflict-apply"
        {
            return Err(StoreError::InvalidInput.into());
        }
        Ok(())
    }
}
#[test]
fn actual_application_requires_explicit_bound_confirmation_and_retries_without_reauthorizing() {
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
    assert!(f
        .ledger
        .apply_application(&plan, None, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    let verifier = Verifier {
        fingerprint: plan.fingerprint().into(),
        calls: 0.into(),
        allowed: true,
    };
    let proof = uuid::Uuid::new_v4().to_string();
    let authorization = ApplicationAuthorization {
        verifier: &verifier,
        proof: &proof,
    };
    let first = f
        .ledger
        .apply_application(
            &plan,
            Some(&authorization),
            &f.principal,
            &f.agent,
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(first.old_id, f.request.existing.row.id);
    assert_eq!(first.new_id, plan.review()["successorId"]);
    assert!(!first.replayed);
    let old = f.store.get(&first.old_id).unwrap().unwrap();
    let next = f.store.get(&first.new_id).unwrap().unwrap();
    assert_eq!(old.status, "superseded");
    assert_eq!(old.superseded_by, first.new_id);
    assert_eq!(next.previous_version, first.old_id);
    assert_eq!(next.text, "Combined synthetic decision");
    assert_eq!(next.update_source, "conflict-resolver");
    assert_eq!(next.owner_user_id, f.request.existing.row.owner_user_id);
    assert_eq!(
        f.store.get(&f.request.new.row.id).unwrap().unwrap().text,
        f.request.new.row.text
    );
    let second = f
        .ledger
        .apply_application(&plan, None, &f.principal, &f.agent, &Cancel::never())
        .unwrap();
    assert!(second.replayed);
    assert_eq!(second.new_id, first.new_id);
    assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn denied_or_mismatched_confirmation_leaves_no_successor_or_replay_permission() {
    for mode in ["denied", "binding", "empty"] {
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
        let verifier = Verifier {
            fingerprint: if mode == "binding" {
                "different-plan".into()
            } else {
                plan.fingerprint().into()
            },
            calls: 0.into(),
            allowed: mode != "denied",
        };
        let proof = if mode == "empty" {
            String::new()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let auth = ApplicationAuthorization {
            verifier: &verifier,
            proof: &proof,
        };
        assert!(f
            .ledger
            .apply_application(&plan, Some(&auth), &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert!(f
            .ledger
            .apply_application(&plan, None, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        assert!(f
            .store
            .get(plan.review()["successorId"].as_str().unwrap())
            .unwrap()
            .is_none());
        assert_eq!(
            f.store
                .get(&f.request.existing.row.id)
                .unwrap()
                .unwrap()
                .status,
            "active"
        );
    }
}
#[cfg(feature = "testkit")]
#[test]
fn partial_application_reuses_the_frozen_successor_and_current_authority() {
    for stage in ["confirmed", "successor", "superseded", "complete"] {
        let mut f = owned_fixture();
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
        let verifier = Verifier {
            fingerprint: plan.fingerprint().into(),
            calls: 0.into(),
            allowed: true,
        };
        let proof = uuid::Uuid::new_v4().to_string();
        let auth = ApplicationAuthorization {
            verifier: &verifier,
            proof: &proof,
        };
        f.ledger = f.ledger.with_application_observer(Arc::new(move |at| {
            if at == stage {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .ledger
            .apply_application(&plan, Some(&auth), &f.principal, &f.agent, &Cancel::never())
            .is_err());
        f.ledger = f.ledger.with_application_observer(Arc::new(|_| Ok(())));
        f.policy.allowed.store(false, Ordering::SeqCst);
        assert!(f
            .ledger
            .apply_application(&plan, None, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        f.policy.allowed.store(true, Ordering::SeqCst);
        let result = f
            .ledger
            .apply_application(&plan, None, &f.principal, &f.agent, &Cancel::never())
            .unwrap();
        assert!(result.replayed);
        assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
        assert_eq!(result.new_id, plan.review()["successorId"]);
        assert_eq!(
            f.store.get(&result.old_id).unwrap().unwrap().status,
            "superseded"
        );
    }
}

#[path = "conflict_application_recovery_cases.rs"]
mod recovery_cases;
