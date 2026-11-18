//! The TypeScript tests of `packages/core/test/grants/` that are not surface, ported: the store rules and their chain
//! authority (`store`, `once`, `integrity`, `audit-hook`, `attested`, `engine-owner-grants`), and `policy::decide` over the
//! real store as the [`GrantSource`] (`decide-integration`, `system-tree-grants`, the store half of `lifetime-core`).
#![allow(clippy::needless_pass_by_value)]
use super::store::{
    AutoJobReason, CreateGrantInput, GrantError, GrantErrorCode, GrantMatch, GrantState,
};
use crate::approvals::tests::{opened, Opened, NOW};
use crate::approvals::{AuditPort, NoAudit};
use crate::policy::decide::{decide, Clock as PolicyClock, GrantSource};
use serde_json::{json, Value};

const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;
const DAY: i64 = 24 * HOUR;
const HOME: &str = "/home/test-user";

#[derive(Default)]
struct Lines(Vec<(String, Value)>, bool);

impl AuditPort for Lines {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        if self.1 {
            return Err("disk full".into());
        }
        self.0.push((action.to_owned(), fields.clone()));
        Ok(())
    }
}

fn always_cap() -> CreateGrantInput {
    CreateGrantInput::new(
        "fs.read",
        "christian",
        "bernd",
        "always",
        GrantMatch::Capability,
        "christian",
        3,
    )
}

fn path_grant(path: &str, recursive: bool) -> CreateGrantInput {
    CreateGrantInput::new(
        "fs.read",
        "christian",
        "bernd",
        "always",
        GrantMatch::Path {
            path: path.into(),
            access: "read".into(),
            recursive,
        },
        "christian",
        3,
    )
}

fn code(r: Result<Value, GrantError>) -> &'static str {
    match r {
        Ok(_) => "ok",
        Err(e) => e.code().map_or("error", GrantErrorCode::as_str),
    }
}

struct PClock(i64);

impl PolicyClock for PClock {
    fn now(&self) -> f64 {
        self.0 as f64
    }
}

fn call(target: &str, flags: Value, access: &str) -> Value {
    let cap = if access == "read" {
        "fs.read"
    } else {
        "fs.write"
    };
    json!({ "capability": cap, "tool": cap, "flags": flags, "targets": [target], "access": access, "actionHash": "h1" })
}

fn ctx() -> Value {
    json!({ "principal": { "person": "christian" }, "subject": { "kind": "agent", "agentId": "bernd" }, "surface": 3, "sessionId": "s1", "taskId": "t1" })
}

fn decided(o: &Opened, c: &Value, x: &Value) -> Value {
    decide(c, x, &o.stores, &PClock(o.clock.get())).json()
}

fn create(o: &mut Opened, i: &CreateGrantInput) -> Result<Value, GrantError> {
    o.stores.create_grant(&mut NoAudit, i)
}

// ---- decide-integration.test.ts: the store as the GrantSource of decide() ----

#[test]
fn decide_with_the_real_store_follows_the_typescript_integration() {
    let base = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(base.path()).unwrap();
    let shared = base.join("shared");
    std::fs::create_dir_all(shared.join("sub")).unwrap();
    let shared = shared.to_str().unwrap().to_owned();
    let out = json!({ "outsideRoots": true, "denyListHit": false });
    let inside = json!({ "outsideRoots": false, "denyListHit": false });
    let denied = json!({ "outsideRoots": true, "denyListHit": true });
    let a = format!("{shared}/a.txt");
    let b = format!("{shared}/sub/b.txt");

    let mut o = opened(None, None);
    assert_eq!(
        decided(
            &o,
            &call(&format!("{}/ws/own.txt", base.display()), inside, "read"),
            &ctx()
        ),
        json!({ "kind": "allow", "via": "default" })
    );
    assert_eq!(
        decided(&o, &call(&a, out.clone(), "read"), &ctx())["kind"],
        "ask"
    );

    let g = create(&mut o, &path_grant(&shared, true)).unwrap();
    let allow = json!({ "kind": "allow", "via": "grant", "grantId": g["id"] });
    assert_eq!(
        decided(&o, &call(&a, out.clone(), "read"), &ctx()),
        allow,
        "a recursive read grant covers the subtree"
    );
    assert_eq!(decided(&o, &call(&b, out.clone(), "read"), &ctx()), allow);
    assert_eq!(
        decided(
            &o,
            &call(&format!("{}/ws2/x", base.display()), out.clone(), "read"),
            &ctx()
        )["kind"],
        "ask",
        "not its siblings"
    );
    assert_eq!(
        decided(&o, &call(&a, out.clone(), "write"), &ctx())["kind"],
        "ask",
        "and not writes"
    );
    assert_eq!(
        decided(
            &o,
            &call(&a, out.clone(), "read"),
            &json!({ "principal": { "person": "christian" }, "subject": { "kind": "agent", "agentId": "bernd" }, "surface": 3, "toolsDeny": ["fs.*"] })
        ),
        json!({ "kind": "deny", "reason": "policy-never", "rule": "tools.deny" })
    );
    create(
        &mut o,
        &CreateGrantInput {
            id: Some("cap".into()),
            ..always_cap()
        },
    )
    .unwrap();
    assert_eq!(
        decided(
            &o,
            &call(
                &format!("{}/secrets/token.env", base.display()),
                denied,
                "read"
            ),
            &ctx()
        ),
        json!({ "kind": "deny", "reason": "deny-list", "rule": "deny-list" }),
        "the deny list beats any grant"
    );
    o.stores
        .revoke(&mut NoAudit, "cap", "christian", "revoked")
        .unwrap();
    assert!(o
        .stores
        .revoke(
            &mut NoAudit,
            g["id"].as_str().unwrap(),
            "christian",
            "revoked"
        )
        .unwrap());
    assert_eq!(
        decided(&o, &call(&a, out.clone(), "read"), &ctx())["kind"],
        "ask",
        "revoking sends the call back to approval at once"
    );

    let mut p = opened(None, None);
    create(&mut p, &path_grant(&shared, false)).unwrap();
    assert_eq!(
        decided(&p, &call(&a, out.clone(), "read"), &ctx())["kind"],
        "allow"
    );
    assert_eq!(
        decided(&p, &call(&b, out, "read"), &ctx())["kind"],
        "ask",
        "a non-recursive grant covers direct children only"
    );
}

#[test]
fn a_session_grant_ends_with_its_session_not_after_a_day() {
    let mut o = opened(None, None);
    let out = json!({ "outsideRoots": true, "denyListHit": false });
    let mut i = path_grant("/data", true);
    i.scope = "session".into();
    i.session_id = Some("s1".into());
    i.id = Some("s-grant".into());
    create(&mut o, &i).unwrap();
    assert_eq!(
        decided(&o, &call("/data/x", out.clone(), "read"), &ctx()),
        json!({ "kind": "allow", "via": "grant", "grantId": "s-grant" })
    );
    assert_eq!(o.stores.end_session(&mut NoAudit, "s1", "core").unwrap(), 1);
    o.clock.set(NOW + HOUR);
    assert_eq!(
        decided(&o, &call("/data/x", out, "read"), &ctx())["kind"],
        "ask"
    );
    let g = o.stores.grant("s-grant").unwrap().unwrap();
    assert_eq!(
        (g["revoked"].clone(), g["endReason"].clone()),
        (json!(true), json!("session-ended"))
    );
    let mut t = path_grant("/data", true);
    t.scope = "task".into();
    t.task_id = Some("t9".into());
    let tg = create(&mut o, &t).unwrap();
    assert_eq!(o.stores.end_task(&mut NoAudit, "t9", "core").unwrap(), 1);
    assert_eq!(
        o.stores.grant(tg["id"].as_str().unwrap()).unwrap().unwrap()["endReason"],
        "task-ended"
    );
}

// ---- system-tree-grants.test.ts (store half) ----

#[test]
fn a_grant_that_reaches_home_or_a_system_tree_is_t3_and_at_most_task() {
    for path in [HOME, "/etc"] {
        for recursive in [false, true] {
            let mut o = opened(None, None);
            assert_eq!(
                code(create(&mut o, &path_grant(path, recursive))),
                "ceiling-exceeded",
                "{path}"
            );
            let mut session = path_grant(path, recursive);
            session.scope = "session".into();
            session.session_id = Some("s1".into());
            assert_eq!(code(create(&mut o, &session)), "ceiling-exceeded");
            let mut task = path_grant(path, recursive);
            task.scope = "task".into();
            task.task_id = Some("t1".into());
            for surface in [1, 2] {
                task.surface = surface;
                assert_eq!(code(create(&mut o, &task)), "surface-too-low", "T{surface}");
            }
            task.surface = 3;
            assert_eq!(create(&mut o, &task).unwrap()["scope"], "task");
            assert_eq!(
                o.stores
                    .grants_for("christian", "bernd", "fs.read")
                    .unwrap()
                    .len(),
                1
            );
        }
    }
    let mut o = opened(None, None);
    assert_eq!(
        code(create(&mut o, &path_grant("/home", true))),
        "ceiling-exceeded",
        "the directory that holds the home"
    );
    assert_eq!(
        create(
            &mut o,
            &path_grant(&format!("{HOME}/Documents/project"), true)
        )
        .unwrap()["scope"],
        "always"
    );
    assert_eq!(
        create(&mut o, &path_grant("/srv/data", false)).unwrap()["scope"],
        "always"
    );
}

// ---- store.test.ts, once.test.ts, integrity.test.ts, audit-hook.test.ts, attested.test.ts ----

#[test]
fn a_once_grant_is_consumed_exactly_once_and_only_for_its_binding() {
    let mut o = opened(None, None);
    let mut i = CreateGrantInput::new(
        "fs.write",
        "christian",
        "bernd",
        "once",
        GrantMatch::Action,
        "christian",
        3,
    );
    i.action_hash = Some("h1".into());
    let g = create(&mut o, &i).unwrap();
    let id = g["id"].as_str().unwrap();
    assert!(!o
        .stores
        .consume_once(&mut NoAudit, id, "christian", "bernd", "other")
        .unwrap());
    assert!(!o
        .stores
        .consume_once(&mut NoAudit, id, "mallory", "bernd", "h1")
        .unwrap());
    assert!(o
        .stores
        .consume_once(&mut NoAudit, id, "christian", "bernd", "h1")
        .unwrap());
    assert!(!o
        .stores
        .consume_once(&mut NoAudit, id, "christian", "bernd", "h1")
        .unwrap());
    let v = &o.stores.inspect(None, None).unwrap()[0];
    assert_eq!(v.state, GrantState::Consumed);
    raw_exec(&o, "UPDATE grants SET consumed_at = NULL");
    assert!(
        !o.stores
            .consume_once(&mut NoAudit, id, "christian", "bernd", "h1")
            .unwrap(),
        "a reset row cannot resurrect a consumed grant"
    );

    let late = create(
        &mut o,
        &CreateGrantInput {
            action_hash: Some("h2".into()),
            ..i.clone()
        },
    )
    .unwrap();
    o.clock.set(NOW + 10 * MIN);
    assert!(
        !o.stores
            .consume_once(
                &mut NoAudit,
                late["id"].as_str().unwrap(),
                "christian",
                "bernd",
                "h2"
            )
            .unwrap(),
        "ten minutes unused"
    );
}

#[test]
fn a_broken_chain_consumes_nothing_and_rolls_back() {
    let mut o = opened(None, None);
    let mut i = CreateGrantInput::new(
        "fs.write",
        "christian",
        "bernd",
        "once",
        GrantMatch::Action,
        "christian",
        3,
    );
    i.action_hash = Some("h1".into());
    let first = create(&mut o, &i).unwrap();
    create(&mut o, &always_cap()).unwrap();
    raw_exec(
        &o,
        "UPDATE approval_chain SET payload = replace(payload, 'bernd', 'other') WHERE seq = 2",
    );
    let id = first["id"].as_str().unwrap();
    assert!(!o
        .stores
        .consume_once(&mut NoAudit, id, "christian", "bernd", "h1")
        .unwrap());
    let consumed: Option<i64> = o
        .stores
        .conn()
        .query_row("SELECT consumed_at FROM grants WHERE id = ?", [id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(consumed, None, "the update was rolled back");
    for v in o.stores.inspect(None, None).unwrap() {
        let want = if v.grant["id"] == first["id"] {
            GrantState::Active
        } else {
            GrantState::Suspended
        };
        assert_eq!(v.state, want, "a grant at or after the break is suspended");
    }
    assert!(matches!(
        create(&mut o, &always_cap()),
        Err(GrantError::Integrity { .. })
    ));
}

fn raw_exec(o: &Opened, sql: &str) {
    plur1bus_store::rusqlite::Connection::open(&o.path)
        .unwrap()
        .execute_batch(sql)
        .unwrap();
}

#[test]
fn the_row_is_compared_with_its_chained_definition() {
    let mut o = opened(None, None);
    let g = create(&mut o, &always_cap()).unwrap();
    let id = g["id"].as_str().unwrap().to_owned();
    assert_eq!(
        o.stores
            .grants_for("christian", "bernd", "fs.read")
            .unwrap()
            .len(),
        1
    );
    raw_exec(&o, "UPDATE grants SET agent = 'eve'");
    assert!(o
        .stores
        .grants_for("eve", "bernd", "fs.read")
        .unwrap()
        .is_empty());
    assert!(
        o.stores
            .grants_for("christian", "eve", "fs.read")
            .unwrap()
            .is_empty(),
        "a moved row is suspended"
    );
    assert_eq!(o.stores.grant(&id).unwrap(), None);
    raw_exec(&o, "UPDATE grants SET agent = 'bernd', revoked_at = 5");
    assert_eq!(
        o.stores.inspect(None, None).unwrap()[0].state,
        GrantState::Revoked,
        "a row that says revoked is revoked"
    );
    let mut p = opened(None, None);
    let g = create(&mut p, &always_cap()).unwrap();
    let id = g["id"].as_str().unwrap();
    p.stores
        .revoke(&mut NoAudit, id, "christian", "revoked")
        .unwrap();
    raw_exec(&p, "UPDATE grants SET revoked_at = NULL, end_reason = NULL");
    assert_eq!(
        p.stores.inspect(None, None).unwrap()[0].state,
        GrantState::Revoked,
        "the chain's revocation wins"
    );
    assert!(p
        .stores
        .grants_for("christian", "bernd", "fs.read")
        .unwrap()
        .is_empty());
}

#[test]
fn every_change_is_audited_in_its_transaction_and_a_failing_line_rolls_it_back() {
    let mut o = opened(None, None);
    let mut failing = Lines(Vec::new(), true);
    assert!(matches!(
        o.stores.create_grant(&mut failing, &always_cap()),
        Err(GrantError::Audit(_))
    ));
    assert!(
        o.stores.inspect(None, None).unwrap().is_empty(),
        "no grant exists unrecorded"
    );
    assert!(o.stores.verify().unwrap().ok());
    let mut lines = Lines::default();
    let g = o.stores.create_grant(&mut lines, &always_cap()).unwrap();
    let id = g["id"].as_str().unwrap().to_owned();
    assert_eq!(lines.0[0].0, "grant.created");
    assert_eq!(
        lines.0[0].1,
        json!({ "person": "christian", "agentId": "bernd", "capability": "fs.read", "grantId": id, "grantScope": "always", "matchKind": "capability", "by": "christian", "decisionSurface": 3 })
    );
    o.clock.set(NOW + 2 * HOUR);
    o.stores.mark_used(&mut lines, &id).unwrap();
    assert_eq!(lines.0[1].0, "grant.used");
    assert!(
        o.stores
            .revoke(&mut failing, &id, "christian", "revoked")
            .unwrap(),
        "a revocation is never blocked by the audit trail"
    );
}

#[test]
fn mark_used_records_at_most_hourly_and_never_revives_a_lapsed_grant() {
    let mut o = opened(None, None);
    let g = create(&mut o, &always_cap()).unwrap();
    let id = g["id"].as_str().unwrap().to_owned();
    let uses = |o: &Opened| -> i64 {
        o.stores
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM approval_chain WHERE kind = 'grant.used'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    o.stores.mark_used(&mut NoAudit, &id).unwrap();
    o.stores.mark_used(&mut NoAudit, &id).unwrap();
    assert_eq!(uses(&o), 1);
    o.clock.set(NOW + HOUR);
    o.stores.mark_used(&mut NoAudit, &id).unwrap();
    assert_eq!(uses(&o), 2);
    assert_eq!(
        o.stores.grant(&id).unwrap().unwrap()["lastUsedAt"],
        json!(NOW + HOUR)
    );
    o.clock.set(NOW + HOUR + 90 * DAY);
    o.stores.mark_used(&mut NoAudit, &id).unwrap();
    assert_eq!(uses(&o), 2, "a lapsed grant is not revived");
}

#[test]
fn creation_refuses_what_typescript_refuses() {
    let mut o = opened(None, None);
    let cases: Vec<(CreateGrantInput, &str)> = vec![
        (
            CreateGrantInput {
                capability: "harness.admin".into(),
                ..always_cap()
            },
            "never-capability",
        ),
        (
            CreateGrantInput {
                capability: "memory.read".into(),
                ..always_cap()
            },
            "ceiling-exceeded",
        ),
        (
            CreateGrantInput {
                created_by: "core:auto-agent-owner".into(),
                ..always_cap()
            },
            "invalid-grant",
        ),
        (
            CreateGrantInput {
                surface: 0,
                ..always_cap()
            },
            "surface-too-low",
        ),
        (
            CreateGrantInput {
                attested_via: Some("attested:touch-id".into()),
                surface: 1,
                ..always_cap()
            },
            "invalid-grant",
        ),
        (
            CreateGrantInput {
                expires_at: Some(NOW as f64),
                ..always_cap()
            },
            "invalid-grant",
        ),
        (
            CreateGrantInput {
                scope: "task".into(),
                ..always_cap()
            },
            "invalid-grant",
        ),
        (
            CreateGrantInput {
                r#match: GrantMatch::Action,
                action_hash: Some("h".into()),
                ..always_cap()
            },
            "invalid-grant",
        ),
        (path_grant("/work/./x", true), "invalid-grant"),
        (path_grant("/", true), "invalid-grant"),
    ];
    for (i, want) in cases {
        assert_eq!(code(create(&mut o, &i)), want, "{i:?}");
    }
    let ok = create(
        &mut o,
        &CreateGrantInput {
            attested_via: Some("attested:touch-id".into()),
            surface: 2,
            ..always_cap()
        },
    )
    .unwrap();
    assert_eq!(ok["attestedVia"], "attested:touch-id");
    let dup = CreateGrantInput {
        id: ok["id"].as_str().map(str::to_owned),
        ..always_cap()
    };
    assert_eq!(code(create(&mut o, &dup)), "duplicate-id");
}

// ---- engine-owner-grants.test.ts ----

#[test]
fn the_automatic_owner_job_grant_is_issued_once_and_renewed_only_by_proved_turns() {
    let mut o = opened(None, None);
    let mut lines = Lines::default();
    assert!(
        matches!(
            o.stores.issue_owner_jobs(
                &mut NoAudit,
                "christian",
                "bernd",
                AutoJobReason::AgentCreated
            ),
            Err(GrantError::Refused { .. })
        ),
        "needs the audit"
    );
    let g = o
        .stores
        .issue_owner_jobs(
            &mut lines,
            "christian",
            "bernd",
            AutoJobReason::AgentCreated,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            g["origin"].clone(),
            g["jobId"].clone(),
            g["surface"].clone()
        ),
        (json!("auto-agent-owner"), json!("engine:*"), json!(0))
    );
    assert_eq!(lines.0[0].1["origin"], "auto-agent-owner");
    assert_eq!(
        o.stores
            .issue_owner_jobs(
                &mut lines,
                "christian",
                "bernd",
                AutoJobReason::RustCoreStart
            )
            .unwrap(),
        None,
        "still alive"
    );
    assert_eq!(
        o.stores
            .issue_owner_jobs(
                &mut lines,
                "christian",
                "bernd",
                AutoJobReason::OwnerReturned
            )
            .unwrap(),
        None
    );
    o.clock.set(NOW + 2 * HOUR);
    o.stores
        .renew_job_grants_from_turn(&mut lines, "christian", "bernd")
        .unwrap();
    o.stores
        .renew_job_grants_from_turn(&mut lines, "christian", "bernd")
        .unwrap();
    let v = &o.stores.inspect(Some("christian"), Some("bernd")).unwrap()[0];
    assert_eq!(v.grant["lastJobTurnAt"], json!(NOW + 2 * HOUR));
    assert_eq!(
        lines.0.iter().filter(|(a, _)| a == "grant.used").count(),
        1,
        "at most hourly"
    );
    o.clock.set(NOW + 2 * HOUR + 91 * DAY);
    assert!(
        o.stores
            .issue_owner_jobs(
                &mut lines,
                "christian",
                "bernd",
                AutoJobReason::RustCoreStart
            )
            .unwrap()
            .is_none(),
        "lapsed: only the owner's return reissues"
    );
    assert!(o
        .stores
        .issue_owner_jobs(
            &mut lines,
            "christian",
            "bernd",
            AutoJobReason::OwnerReturned
        )
        .unwrap()
        .is_some());
    let id = o.stores.inspect(Some("christian"), Some("bernd")).unwrap()[1].grant["id"]
        .as_str()
        .unwrap()
        .to_owned();
    o.stores
        .revoke(&mut lines, &id, "christian", "revoked")
        .unwrap();
    o.clock.set(NOW + 200 * DAY);
    assert!(
        o.stores
            .issue_owner_jobs(
                &mut lines,
                "christian",
                "bernd",
                AutoJobReason::OwnerReturned
            )
            .unwrap()
            .is_none(),
        "a revoked one is never reissued"
    );
}

#[test]
fn expired_and_suspended_grants_are_announced_once() {
    use std::cell::RefCell;
    use std::rc::Rc;
    let mut o = opened(None, None);
    let seen: Rc<RefCell<Vec<String>>> = Rc::default();
    let s2 = Rc::clone(&seen);
    o.stores.grants.set_notify(Some(Box::new(move |c, g, _| {
        s2.borrow_mut()
            .push(format!("{c:?}:{}", g["id"].as_str().unwrap_or("")))
    })));
    let mut task = always_cap();
    task.scope = "task".into();
    task.task_id = Some("t1".into());
    task.id = Some("g-task".into());
    create(&mut o, &task).unwrap();
    o.clock.set(NOW + DAY);
    o.stores.announce_due(None).unwrap();
    o.stores.announce_due(None).unwrap();
    assert_eq!(*seen.borrow(), ["Expired:g-task"]);
    raw_exec(&o, "UPDATE grants SET person = 'eve'");
    o.stores.announce_due(None).unwrap();
    assert_eq!(
        seen.borrow().last().map(String::as_str),
        Some("Suspended:g-task")
    );
}

#[test]
fn the_store_is_the_policy_grant_source() {
    let mut o = opened(None, None);
    let g = create(&mut o, &always_cap()).unwrap();
    let src: &dyn GrantSource = &o.stores;
    assert_eq!(src.max_grant_days(), Some(90.0));
    assert_eq!(src.list("christian", "bernd", "fs.read"), vec![g.clone()]);
    assert_eq!(src.get(g["id"].as_str().unwrap()), Some(g));
    assert_eq!(src.get("grt_nope"), None);
}

// ---- audit-findings.test.ts (store half) ----

#[test]
fn end_task_ends_only_that_tasks_task_grants_and_state_survives_a_restart() {
    let mut o = opened(None, None);
    let mut task = always_cap();
    task.scope = "task".into();
    task.task_id = Some("x".into());
    let t = create(&mut o, &task).unwrap();
    let mut session = always_cap();
    session.scope = "session".into();
    session.session_id = Some("x".into());
    let s = create(&mut o, &session).unwrap();
    let mut once = CreateGrantInput::new(
        "fs.write",
        "christian",
        "bernd",
        "once",
        GrantMatch::Action,
        "christian",
        3,
    );
    once.action_hash = Some("h".into());
    let g = create(&mut o, &once).unwrap();
    assert!(o
        .stores
        .consume_once(
            &mut NoAudit,
            g["id"].as_str().unwrap(),
            "christian",
            "bernd",
            "h"
        )
        .unwrap());
    assert_eq!(
        o.stores.end_task(&mut NoAudit, "x", "core").unwrap(),
        1,
        "never a session grant with the same id string"
    );
    let again = crate::approvals::tests::open_at(
        &o.path,
        &crate::approvals::tests::KEY,
        None,
        None,
        o.clock.clone(),
    );
    let state = |id: &Value| {
        again
            .inspect(None, None)
            .unwrap()
            .into_iter()
            .find(|v| v.grant["id"] == *id)
            .map(|v| v.state)
    };
    assert_eq!(
        (state(&t["id"]), state(&s["id"]), state(&g["id"])),
        (
            Some(GrantState::Revoked),
            Some(GrantState::Active),
            Some(GrantState::Consumed)
        ),
        "revocation, task end and consumption survive a restart"
    );
}
