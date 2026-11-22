//! The gate against the dispatcher's order and refusals (`packages/core/src/tools/dispatcher.ts`, step 2 of `call`; the
//! tests of `test/tools/dispatcher*.test.ts` that concern the policy gate), and the binding of an approved action.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::doubles::{MemoryAudit, Permits, SetClock};
use super::*;
use plur1bus_core::approvals::service::Answer;

const NOW: f64 = 1_791_288_000_000.0;

fn who() -> Caller {
    Caller {
        principal: "christian".into(),
        agent_id: "bernd".into(),
        surface: 3,
        session_id: Some("s1".into()),
        task_id: Some("t1".into()),
        ..Caller::default()
    }
}

fn inside(access: &'static str) -> impl Fn(&Value) -> Result<Classification, String> {
    move |args: &Value| {
        let path = args["path"].as_str().ok_or("path must be a string")?;
        let mut flags = Map::new();
        flags.insert("outsideRoots".into(), json!(false));
        flags.insert("denyListHit".into(), json!(path.contains(".ssh")));
        Ok(Classification {
            flags,
            targets: Some(vec![format!("/work/proj/{path}")]),
            access: Some(access),
            hash_extra: args["extra"].as_str().map(str::to_owned),
        })
    }
}

struct Bench {
    clock: SetClock,
    audit: MemoryAudit,
    permits: Permits,
}

impl Bench {
    fn new() -> Self {
        Bench {
            clock: SetClock::at(NOW),
            audit: MemoryAudit::default(),
            permits: Permits::default(),
        }
    }
    fn verify(
        &mut self,
        tool: &str,
        args: Value,
        who: &Caller,
    ) -> Result<ApprovedAction, GateError> {
        let read = inside("read");
        let write = inside("write");
        let tools = [
            GatedTool {
                name: "file.read",
                capability: "fs.read",
                effect: "read",
                risk: "low",
                classifier: Some(&read),
            },
            GatedTool {
                name: "file.write",
                capability: "fs.write",
                effect: "local-write",
                risk: "low",
                classifier: Some(&write),
            },
            GatedTool {
                name: "exec.run",
                capability: "shell.exec",
                effect: "local-write",
                risk: "medium",
                classifier: Some(&write),
            },
            GatedTool {
                name: "file.unclassified",
                capability: "fs.write",
                effect: "local-write",
                risk: "low",
                classifier: None,
            },
        ];
        let action = UnverifiedAction {
            tool: tool.to_owned(),
            args,
            call_id: "call-1".into(),
            reason: None,
            diff: None,
        };
        Gate::new(&tools, &self.clock, &mut self.audit, &mut self.permits).verify(action, who)
    }
}

fn once_grant(id: &str, capability: &str, action_hash: &str) -> Value {
    json!({ "id": id, "capability": capability, "person": "christian", "agent": "bernd", "scope": "once",
        "match": { "kind": "action" }, "actionHash": action_hash, "createdAt": NOW - 60_000.0, "surface": 3 })
}

#[test]
fn a_read_inside_the_roots_is_allowed_recorded_and_bound() {
    let mut b = Bench::new();
    let a = b
        .verify("file.read", json!({ "path": "a.txt" }), &who())
        .unwrap();
    let want_hash = plur1bus_canon::action_hash(
        "fs.read",
        "file.read",
        &json!({ "path": "a.txt" }),
        &["/work/proj/a.txt".to_owned()],
        None,
    );
    assert_eq!(a.action_hash(), want_hash, "the dispatcher's action hash");
    assert_eq!(
        (a.tool(), a.capability(), a.access()),
        ("file.read", "fs.read", Some("read"))
    );
    assert_eq!(a.targets(), ["/work/proj/a.txt".to_owned()]);
    assert_eq!(
        (a.principal(), a.agent_id(), a.session_id(), a.call_id()),
        ("christian", "bernd", Some("s1"), "call-1")
    );
    assert_eq!(a.allowed(), &Allowed::Default);
    assert_eq!(a.expires_at(), NOW + APPROVAL_TTL_MS);
    assert!(!a.flag("outsideRoots") && !a.flag("no-such-flag"));
    // One decision line, with the dispatcher's members.
    assert_eq!(b.audit.lines.len(), 1);
    let (action, f) = &b.audit.lines[0];
    assert_eq!(action, "policy.decision");
    assert_eq!(
        f,
        &json!({ "person": "christian", "agentId": "bernd", "subjectKind": "agent", "sessionId": "s1", "taskId": "t1",
            "tool": "file.read", "capability": "fs.read", "effect": "read", "risk": "low", "actionHash": want_hash,
            "surface": 3, "targets": ["/work/proj/a.txt"], "flags": { "outsideRoots": false, "denyListHit": false },
            "argsBytes": 16, "outcome": "allowed", "via": "default" })
    );
    assert!(
        b.permits.log.is_empty(),
        "nobody is asked for an allowed call"
    );
}

#[test]
fn an_unknown_tool_and_a_call_that_cannot_be_classified_are_refused() {
    let mut b = Bench::new();
    let e = b.verify("file.nope", json!({}), &who()).unwrap_err();
    assert_eq!(
        (e.code(), e.message()),
        ("tool-unknown", "no tool named \"file.nope\"".to_owned())
    );
    assert!(b.audit.lines.is_empty());
    let long = "x".repeat(70);
    assert_eq!(
        GateError::UnknownTool(long).message(),
        format!("no tool named \"{}\"", "x".repeat(64))
    );
    let e = b
        .verify("file.read", json!({ "path": 7 }), &who())
        .unwrap_err();
    assert_eq!(
        (e.code(), e.message()),
        (
            "tool-denied",
            "the call could not be classified: path must be a string".to_owned()
        )
    );
    assert_eq!(
        b.audit.lines,
        vec![(
            "policy.decision".to_owned(),
            json!({ "person": "christian", "agentId": "bernd", "subjectKind": "agent", "sessionId": "s1", "taskId": "t1",
                "tool": "file.read", "capability": "fs.read", "outcome": "never", "rule": "classify-failed" })
        )]
    );
}

#[test]
fn a_denied_call_is_recorded_softly_and_nothing_else_happens() {
    let mut b = Bench::new();
    b.permits = Permits::approving();
    let e = b
        .verify("file.read", json!({ "path": ".ssh/id" }), &who())
        .unwrap_err();
    let GateError::Denied { reason, rule } = e.clone() else {
        panic!("{e:?}")
    };
    assert_eq!(reason, "deny-list");
    assert_eq!(e.code(), "tool-denied");
    assert_eq!(
        e.message(),
        format!("refused by policy (deny-list: {rule})")
    );
    let f = b.audit.of("policy.decision")[0];
    assert_eq!(
        (&f["outcome"], &f["reason"], f["rule"].as_str()),
        (&json!("never"), &json!("deny-list"), Some(rule))
    );
    assert!(b.permits.log.is_empty());
    // The refusal stands when its line cannot be written.
    b.audit.failing.push("policy.decision".into());
    let e = b
        .verify("file.read", json!({ "path": ".ssh/id" }), &who())
        .unwrap_err();
    assert!(matches!(e, GateError::Denied { .. }));
}

#[test]
fn no_approved_action_without_its_decision_line() {
    // Allowed by the policy, but the line cannot be written: refused, and nothing after the record ran.
    let mut b = Bench::new();
    b.audit.failing.push("policy.decision".into());
    let e = b
        .verify("file.read", json!({ "path": "a.txt" }), &who())
        .unwrap_err();
    assert_eq!(e, GateError::AuditUnavailable);
    assert_eq!(
        (e.code(), e.message()),
        (
            "tool-denied",
            "the audit trail is unavailable; nothing runs unrecorded".to_owned()
        )
    );
    // An ask: the person is not asked before the decision is on record (the audit line comes first).
    b.permits = Permits::approving();
    let e = b
        .verify("exec.run", json!({ "path": "w" }), &who())
        .unwrap_err();
    assert_eq!(e, GateError::AuditUnavailable);
    assert!(b.permits.log.is_empty(), "{:?}", b.permits.log);
    // A grant: it is not spent before the decision is on record.
    let hash = plur1bus_canon::action_hash(
        "shell.exec",
        "exec.run",
        &json!({ "path": "w" }),
        &["/work/proj/w".to_owned()],
        None,
    );
    b.permits.grants.push(once_grant("g1", "shell.exec", &hash));
    assert_eq!(
        b.verify("exec.run", json!({ "path": "w" }), &who())
            .unwrap_err(),
        GateError::AuditUnavailable
    );
    assert!(b.permits.spent.is_empty() && b.permits.log.is_empty());
    // No audit trail at all is not a recorded decision either.
    let mut b = Bench::new();
    b.audit.absent = true;
    assert_eq!(
        b.verify("file.read", json!({ "path": "a.txt" }), &who())
            .unwrap_err(),
        GateError::AuditUnavailable
    );
}

#[test]
fn an_ask_runs_only_after_a_literal_approval_that_could_be_begun() {
    let mut b = Bench::new();
    b.permits = Permits::approving();
    let a = b
        .verify("exec.run", json!({ "path": "w" }), &who())
        .unwrap();
    assert_eq!(a.allowed(), &Allowed::Approval(Some("apr_1".into())));
    assert_eq!(b.permits.log, ["request", "begin apr_1"]);
    let f = b.audit.of("policy.decision")[0];
    assert_eq!(
        (&f["outcome"], &f["via"]),
        (&json!("approval"), &json!("ask"))
    );
    assert!(f["rule"].is_string());
    // What the person is asked about is this call.
    let ask = &b.permits.asked[0];
    assert_eq!(
        (
            ask.tool.as_str(),
            ask.call_id.as_str(),
            ask.principal.as_str(),
            ask.agent_id.as_str()
        ),
        ("exec.run", "call-1", "christian", "bernd")
    );
    assert_eq!(
        (
            ask.session_id.as_deref(),
            ask.task_id.as_deref(),
            ask.turn_id.as_deref()
        ),
        (Some("s1"), Some("t1"), Some("call-1"))
    );
    assert_eq!(ask.targets, Some(vec![json!("/work/proj/w")]));
    assert_eq!(ask.access.as_deref(), Some("write"));
    assert_eq!(ask.request["actionHash"], json!(a.action_hash()));
    assert!(!ask.park && !ask.aborted);

    // Not approved: with and without a reason, parked or not; the outcome line says refused.
    for (answer, message, parked) in [
        (Answer::default(), "not approved", false),
        (
            Answer {
                reason: Some("not now".into()),
                parked: true,
                ..Answer::default()
            },
            "not approved: not now",
            true,
        ),
    ] {
        let mut b = Bench::new();
        b.permits.answers.push_back(answer);
        let e = b
            .verify("exec.run", json!({ "path": "w" }), &who())
            .unwrap_err();
        assert_eq!(
            e,
            GateError::NotApproved {
                message: message.into(),
                parked
            }
        );
        assert_eq!(e.code(), "tool-not-approved");
        assert_eq!(b.permits.log, ["request"], "never begun");
        let o = b.audit.of("policy.outcome")[0];
        assert_eq!(
            (&o["outcome"], &o["resultCode"], &o["resultBytes"]),
            (&json!("refused"), &json!("tool-not-approved"), &json!(0))
        );
    }
    // Approved, but the approval cannot be used (already used, expired, bound to another action).
    let mut b = Bench::new();
    b.permits = Permits::approving();
    b.permits.begin_fails = true;
    let e = b
        .verify("exec.run", json!({ "path": "w" }), &who())
        .unwrap_err();
    assert_eq!(
        e.message(),
        "not approved: the approval could not be used (already used, expired or bound to another action)"
    );
    // Nobody to ask (no answer): not approved.
    let mut b = Bench::new();
    assert!(matches!(
        b.verify("exec.run", json!({ "path": "w" }), &who()),
        Err(GateError::NotApproved { .. })
    ));
}

#[test]
fn a_tool_without_a_classifier_counts_as_outside_the_roots() {
    let mut b = Bench::new();
    b.permits = Permits::approving();
    let a = b
        .verify("file.unclassified", json!({ "path": "a" }), &who())
        .unwrap();
    assert!(a.flag("outsideRoots"));
    assert!(a.targets().is_empty());
    assert_eq!(
        b.permits.log,
        ["request", "begin apr_1"],
        "a write outside the roots is asked"
    );
    assert!(b.audit.of("policy.decision")[0].get("targets").is_none());
}

#[test]
fn a_headless_ask_is_a_refusal_and_never_a_wait() {
    let mut b = Bench::new();
    b.permits = Permits::approving();
    let mut job = who();
    job.policy
        .insert("headless".into(), json!({ "jobId": "job-7" }));
    let e = b
        .verify("exec.run", json!({ "path": "w" }), &job)
        .unwrap_err();
    assert_eq!(
        e,
        GateError::Denied {
            reason: "policy-never",
            rule: "headless:no-job-grant"
        }
    );
    assert!(b.permits.log.is_empty());
    assert_eq!(b.audit.of("policy.decision")[0]["jobId"], json!("job-7"));
    // A context the evaluator cannot read is refused (fail closed).
    let mut bad = who();
    bad.principal = String::new();
    assert!(matches!(
        b.verify("file.read", json!({ "path": "a.txt" }), &bad),
        Err(GateError::Denied {
            reason: "policy-never",
            ..
        })
    ));
}

#[test]
fn a_once_grant_is_spent_at_verification_and_allows_exactly_one_call() {
    let args = json!({ "path": "w" });
    let hash = plur1bus_canon::action_hash(
        "shell.exec",
        "exec.run",
        &args,
        &["/work/proj/w".to_owned()],
        None,
    );
    let mut b = Bench::new();
    b.permits.grants.push(once_grant("g1", "shell.exec", &hash));
    let a = b.verify("exec.run", args.clone(), &who()).unwrap();
    assert_eq!(a.allowed(), &Allowed::Grant(Some("g1".into())));
    assert_eq!(b.permits.log, ["consume g1"]);
    assert_eq!(b.audit.of("policy.decision")[0]["grantId"], json!("g1"));
    // A stale list still offers it; the store says it is spent.
    let e = b.verify("exec.run", args.clone(), &who()).unwrap_err();
    assert_eq!(
        e,
        GateError::NotApproved {
            message: "the one-time grant was already used".into(),
            parked: false
        }
    );
    // Other arguments are another action: the grant does not cover them, the person is asked.
    let e = b
        .verify("exec.run", json!({ "path": "other" }), &who())
        .unwrap_err();
    assert!(matches!(e, GateError::NotApproved { .. }));
    assert_eq!(b.permits.log.last().map(String::as_str), Some("request"));
    // A use that cannot be recorded does not run.
    let mut b = Bench::new();
    b.permits.grants.push(once_grant("g1", "shell.exec", &hash));
    b.permits.use_fails = true;
    assert_eq!(
        b.verify("exec.run", args.clone(), &who())
            .unwrap_err()
            .message(),
        "the use of the grant could not be recorded, so the call does not run"
    );
    // A standing grant records its use.
    let mut b = Bench::new();
    b.permits.grants.push(json!({ "id": "g2", "capability": "shell.exec", "person": "christian", "agent": "bernd",
        "scope": "session", "sessionId": "s1", "match": { "kind": "capability" }, "createdAt": NOW - 60_000.0, "surface": 3 }));
    let a = b.verify("exec.run", args, &who());
    if let Ok(a) = a {
        assert_eq!(a.allowed(), &Allowed::Grant(Some("g2".into())));
        assert_eq!(b.permits.log, ["used g2"]);
    } else {
        // The evaluator does not let a capability grant cover shell.exec: then the person is asked, never silently run.
        assert_eq!(b.permits.log, ["request"]);
    }
}

fn approved(extra: Option<&str>) -> (Bench, ApprovedAction, Value) {
    let mut b = Bench::new();
    b.permits = Permits::approving();
    let mut args = json!({ "path": "w" });
    if let Some(x) = extra {
        args["extra"] = json!(x);
    }
    let a = b.verify("exec.run", args.clone(), &who()).unwrap();
    (b, a, args)
}

#[test]
fn an_approved_action_is_bound_to_the_action_that_was_verified() {
    let targets = vec!["/work/proj/w".to_owned()];
    let me = who();
    // It holds for exactly what was verified.
    let (b, a, args) = approved(Some("fp-1"));
    let live = Live {
        tool: "exec.run",
        args: &args,
        targets: &targets,
        hash_extra: Some("fp-1"),
        caller: &me,
    };
    let hash = a.action_hash().to_owned();
    let r = a.redeem(&live, &b.clock).unwrap();
    assert_eq!(
        (r.action_hash(), r.call_id(), r.allowed().as_str()),
        (hash.as_str(), "call-1", "approval")
    );
    assert!(!r.flag("outsideRoots"));

    let other_args = json!({ "path": "w", "extra": "fp-1", "more": true });
    let other_targets = vec!["/work/proj/elsewhere".to_owned()];
    let mut other_person = who();
    other_person.principal = "eva".into();
    let mut other_agent = who();
    other_agent.agent_id = "pi".into();
    let mut other_session = who();
    other_session.session_id = Some("s2".into());
    let mut no_session = who();
    no_session.session_id = None;
    let cases: Vec<(Live<'_>, BindingError)> = vec![
        (
            Live {
                tool: "file.write",
                ..live
            },
            BindingError::Tool,
        ),
        (
            Live {
                caller: &other_person,
                ..live
            },
            BindingError::Principal,
        ),
        (
            Live {
                caller: &other_agent,
                ..live
            },
            BindingError::Agent,
        ),
        (
            Live {
                caller: &other_session,
                ..live
            },
            BindingError::Session,
        ),
        (
            Live {
                caller: &no_session,
                ..live
            },
            BindingError::Session,
        ),
        (
            Live {
                targets: &other_targets,
                ..live
            },
            BindingError::Targets,
        ),
        (
            Live {
                targets: &[],
                ..live
            },
            BindingError::Targets,
        ),
        (
            Live {
                hash_extra: Some("fp-2"),
                ..live
            },
            BindingError::HashExtra,
        ),
        (
            Live {
                hash_extra: None,
                ..live
            },
            BindingError::HashExtra,
        ),
        (
            Live {
                args: &other_args,
                ..live
            },
            BindingError::ActionHash,
        ),
    ];
    for (live, want) in cases {
        let (b, a, _) = approved(Some("fp-1"));
        assert_eq!(a.redeem(&live, &b.clock).unwrap_err(), want);
    }
    assert_eq!(
        BindingError::ActionHash.to_string(),
        "the approved action is not this action (action-hash)"
    );
}

#[test]
fn an_approved_action_expires() {
    let targets = vec!["/work/proj/w".to_owned()];
    let me = who();
    for (after, ok) in [
        (0.0, true),
        (APPROVAL_TTL_MS, true),
        (APPROVAL_TTL_MS + 1.0, false),
        (f64::NAN, false),
    ] {
        let (b, a, args) = approved(None);
        let live = Live {
            tool: "exec.run",
            args: &args,
            targets: &targets,
            hash_extra: None,
            caller: &me,
        };
        b.clock.advance(after);
        assert_eq!(
            a.redeem(&live, &b.clock)
                .map(|_| ())
                .map_err(|e| e.as_str()),
            if ok { Ok(()) } else { Err("expired") },
            "{after}"
        );
    }
}

#[test]
fn the_unverified_action_is_plain_data_and_the_context_is_the_dispatchers() {
    let a: UnverifiedAction = serde_json::from_value(
        json!({ "tool": "file.read", "args": { "path": "a" }, "callId": "c9", "reason": "because" }),
    )
    .unwrap();
    assert_eq!(
        (a.tool.as_str(), a.call_id.as_str(), a.reason.as_deref()),
        ("file.read", "c9", Some("because"))
    );
    assert!(serde_json::from_value::<UnverifiedAction>(
        json!({ "tool": "t", "args": {}, "callId": "c", "approved": true })
    )
    .is_err());
    let mut c = who();
    c.policy
        .insert("overrides".into(), json!({ "fs.write": "allowed" }));
    assert_eq!(
        c.context(),
        json!({ "principal": { "person": "christian" }, "subject": { "kind": "agent", "agentId": "bernd" }, "surface": 3,
            "sessionId": "s1", "taskId": "t1", "overrides": { "fs.write": "allowed" } })
    );
    c.session_id = Some(String::new());
    c.task_id = None;
    assert!(c.context().get("sessionId").is_none() && c.context().get("taskId").is_none());
}

#[test]
fn the_policy_context_cannot_decide_for_another_caller_than_the_action_is_bound_to() {
    // `Caller.policy` is merged over the base context; a member that names another person, agent or session would have
    // the policy decide (with that one's grants) for a call that is then bound to `who`. Refused, and nobody is asked.
    for (key, value) in [
        ("principal", json!({ "person": "someone-else" })),
        ("principal", json!("christian")),
        (
            "subject",
            json!({ "kind": "agent", "agentId": "another-agent" }),
        ),
        ("subject", json!({ "kind": "subagent" })),
        ("sessionId", json!("s2")),
    ] {
        let mut b = Bench::new();
        b.permits = Permits::approving();
        let mut c = who();
        c.policy.insert(key.into(), value.clone());
        assert_eq!(
            b.verify("file.read", json!({ "path": "a.txt" }), &c)
                .unwrap_err(),
            GateError::Denied {
                reason: "policy-never",
                rule: "context-mismatch"
            },
            "{key}: {value}"
        );
        assert!(b.permits.log.is_empty(), "{key}");
        assert_eq!(b.audit.of("policy.decision").len(), 1, "{key}");
    }
    // The same person, agent and session spelled again decide as before.
    let mut b = Bench::new();
    let mut c = who();
    c.policy
        .insert("principal".into(), json!({ "person": "christian" }));
    c.policy.insert(
        "subject".into(),
        json!({ "kind": "agent", "agentId": "bernd" }),
    );
    c.policy.insert("sessionId".into(), json!("s1"));
    let a = b
        .verify("file.read", json!({ "path": "a.txt" }), &c)
        .unwrap();
    assert_eq!((a.principal(), a.agent_id()), ("christian", "bernd"));
}
