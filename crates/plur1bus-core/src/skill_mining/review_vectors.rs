use super::*;
use crate::policy::capabilities::GrantScope;
use crate::rbac::{
    audit::AuditEvent,
    types::{AgentRight, PrincipalKind, Role, ROLES},
};
use serde_json::{json, Value};

struct Runtime;
impl Clock for Runtime {
    fn now(&self) -> i64 {
        10
    }
}
impl IdSource for Runtime {
    fn next_id(&self) -> String {
        "approval-fixture".into()
    }
}
impl Authority for Runtime {
    fn current(&self, id: &str) -> Option<Principal> {
        Some(person(id, Role::Owner))
    }
    fn allows(&self, _: &Scope, _: &Principal) -> bool {
        true
    }
}
fn person(id: &str, role: Role) -> Principal {
    Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new(id, role)
    }
}

struct Queue<'a> {
    name: &'a str,
    initial: Proposal,
    calls: Vec<Value>,
    reads: usize,
}
impl Backend for Queue<'_> {
    fn ready(&self) -> bool {
        self.name != "missing"
    }
    fn find(&mut self, _: &Scope, _: &str) -> R<Option<Proposal>> {
        Ok(None)
    }
    fn propose(&mut self, _: &Scope, _: &Candidate) -> R<Proposal> {
        panic!("review may only change review state")
    }
    fn get(&mut self, _: &Scope, _: &str) -> R<Proposal> {
        self.reads += 1;
        let mut p = self.initial.clone();
        if self.name == "changed" && self.reads > 1 {
            p.candidate.skill_md = "Changed".into();
        }
        Ok(p)
    }
    fn decide(
        &mut self,
        scope: &Scope,
        id: &str,
        expected_hash: &str,
        decision: Decision,
    ) -> R<()> {
        let decision = if matches!(decision, Decision::Accept) {
            "accept"
        } else {
            "reject"
        };
        self.calls
            .push(json!({"scope":scope,"id":id,"expectedHash":expected_hash,"decision":decision}));
        Ok(())
    }
}

struct Approver<'a> {
    name: &'a str,
    calls: Vec<Value>,
    starts: usize,
}
impl Approval for Approver<'_> {
    fn ask(&mut self, ask: &Ask, _: &AbortSignal) -> R<Answer> {
        self.calls.push(
            json!({"request":ask.request,"tool":ask.tool,"args":ask.args,"principal":ask.principal,
            "agentId":ask.agent_id,"park":ask.park}),
        );
        Ok(Answer {
            approved: self.name != "denied",
            scope: Some(if self.name == "standing" {
                GrantScope::Always
            } else {
                GrantScope::Once
            }),
            ..Answer::default()
        })
    }
    fn begin(&mut self, _: &Answer, _: &Ask) -> bool {
        self.starts += 1;
        self.name != "consumed"
    }
}

#[test]
fn proposal_review_checks_role_and_person_on_both_identity_snapshots() {
    struct Live<'a>(&'a Principal);
    impl Authority for Live<'_> {
        fn current(&self, _: &str) -> Option<Principal> {
            Some(self.0.clone())
        }

        fn allows(&self, _: &Scope, _: &Principal) -> bool {
            true
        }
    }

    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/skills/review.json"
    ))
    .unwrap();
    let scope: Scope = serde_json::from_value(fixture[0]["scope"].clone()).unwrap();
    let proposal: Proposal = serde_json::from_value(fixture[0]["proposal"].clone()).unwrap();
    let evaluate = |caller: &Principal, current: &Principal, expected: Option<&str>| {
        let mut queue = Queue {
            name: "ready",
            initial: proposal.clone(),
            calls: vec![],
            reads: 0,
        };
        let mut approval = Approver {
            name: "once",
            calls: vec![],
            starts: 0,
        };
        let result = decide(
            &Request {
                scope: &scope,
                who: caller,
                id: &proposal.id,
                decision: Decision::Accept,
                surface: 3,
                abort: &AbortSignal::new(),
            },
            &mut Ports {
                authority: &Live(current),
                backend: &mut queue,
                approval: &mut approval,
                clock: &Runtime,
                ids: &Runtime,
                audit: &mut |_: &AuditEvent| Ok(()),
            },
        )
        .err();
        assert_eq!(
            result.as_ref().and_then(|error| error.reason.as_deref()),
            expected
        );
        if expected.is_some() {
            assert_eq!(queue.reads, 0);
            assert!(approval.calls.is_empty());
            assert!(queue.calls.is_empty());
        } else {
            assert!(result.is_none());
            assert_eq!(queue.calls.len(), 1);
        }
    };

    for role in ROLES {
        let mut who = person("ada", role);
        who.agent_rights = Some(vec![(scope.agent_id.clone(), AgentRight::Manage)]);
        let expected = match role {
            Role::Owner | Role::Admin => None,
            Role::Member => Some("reviewer-role"),
            Role::Operator | Role::Viewer => Some("scope-unavailable"),
        };
        evaluate(&who, &who, expected);
    }
    let owner = person("ada", Role::Owner);
    let agent = Principal {
        kind: Some(PrincipalKind::Agent),
        ..owner.clone()
    };
    evaluate(&agent, &owner, Some("scope-unavailable"));
    evaluate(&owner, &agent, Some("scope-unavailable"));
    let member = Principal {
        role: Role::Member,
        agent_rights: Some(vec![(scope.agent_id.clone(), AgentRight::Manage)]),
        ..owner.clone()
    };
    evaluate(&owner, &member, Some("reviewer-role"));
}

#[test]
fn content_bound_single_use_skill_review_matches_typescript() {
    let fixture: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/skills/review.json"
    ))
    .unwrap();
    for row in fixture {
        let name = row["name"].as_str().unwrap();
        let scope: Scope = serde_json::from_value(row["scope"].clone()).unwrap();
        let mut proposal: Proposal = serde_json::from_value(row["proposal"].clone()).unwrap();
        if name == "long candidate" {
            proposal.candidate.skill_md = "é".repeat(33_000);
        }
        let mut backend = Queue {
            name,
            initial: proposal,
            calls: vec![],
            reads: 0,
        };
        let mut approval = Approver {
            name,
            calls: vec![],
            starts: 0,
        };
        let mut audit = |_: &AuditEvent| Ok(());
        let caller = person(
            "ada",
            if name == "viewer" {
                Role::Viewer
            } else {
                Role::Owner
            },
        );
        let request = Request {
            scope: &scope,
            who: &caller,
            id: "fixture",
            decision: if name == "rejected" {
                Decision::Reject
            } else {
                Decision::Accept
            },
            surface: 3,
            abort: &AbortSignal::new(),
        };
        let actual = match decide(
            &request,
            &mut Ports {
                authority: &Runtime,
                backend: &mut backend,
                approval: &mut approval,
                clock: &Runtime,
                ids: &Runtime,
                audit: &mut audit,
            },
        ) {
            Ok(()) => json!({"ok":true}),
            Err(e) => json!({"error":match e.code{
                CollabErrorCode::Conflict=>"E_NOT_AVAILABLE",
                CollabErrorCode::Unauthorized=>"E_DENIED",
                _=>"E_STORAGE",
            }}),
        };
        assert_eq!(
            json!({"result":actual,"calls":backend.calls,"asked":approval.calls,"reads":backend.reads,"starts":approval.starts}),
            row["expected"],
            "{name}"
        );
    }
}
