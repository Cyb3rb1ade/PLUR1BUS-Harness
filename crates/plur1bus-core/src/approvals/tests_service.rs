//! `packages/core/test/approvals/service.test.ts` and `scope-offers.test.ts`, ported: the service over the real stores, with
//! fake timers on the fake clock, recorded events and a recorded audit trail. The waiting call is a callback that stores its
//! answer.
#![allow(clippy::needless_pass_by_value)]
use super::service::{
    Answer, ApprovalEvents, ApprovalService, Ask, DispatchContext, ServiceDecide, ServiceDenial,
    ServicePorts, TimerKind, Timers, DEFAULT_FOREGROUND_WAIT_MS,
};
use super::store::{Denial, Status};
use super::tests::{opened, Opened, NOW};
use super::vectors::SetClock;
use super::AuditPort;
use crate::policy::decide::{decide, Clock as PolicyClock, Decision, GrantSource};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;

#[derive(Default)]
struct TimerQueue {
    q: Vec<(i64, u64, TimerKind, String)>,
    n: u64,
}

/// `FakeTimers`: what the service scheduled, fired in order by `advance`.
#[derive(Clone)]
struct FakeTimers(Rc<RefCell<TimerQueue>>, Arc<SetClock>);

impl Timers for FakeTimers {
    fn set(&self, kind: TimerKind, id: &str, ms: i64) {
        let mut t = self.0.borrow_mut();
        t.n += 1;
        let n = t.n;
        t.q.push((self.1.get() + ms, n, kind, id.to_owned()));
    }
    fn clear(&self, kind: TimerKind, id: &str) {
        self.0
            .borrow_mut()
            .q
            .retain(|(_, _, k, i)| !(*k == kind && i == id));
    }
}

#[derive(Clone, Default)]
struct Events(Rc<RefCell<Vec<(String, Value)>>>);

impl ApprovalEvents for Events {
    fn emit(&self, name: &str, payload: &Value) {
        self.0.borrow_mut().push((name.to_owned(), payload.clone()));
    }
}

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

impl Lines {
    fn has(&self, action: &str, key: &str, value: &str) -> bool {
        self.0.iter().any(|(a, f)| a == action && f[key] == value)
    }
}

type Slot = Rc<RefCell<Option<Answer>>>;

struct Rig {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    clock: Arc<SetClock>,
    service: ApprovalService,
    timers: FakeTimers,
    events: Events,
    audit: Lines,
}

fn ports() -> ServicePorts {
    ServicePorts {
        canonical: Box::new(|v| serde_json::to_string(v).ok()),
        redactor: Box::new(crate::rbac::audit::detail_redactor().unwrap()),
        peer_trust: Box::new(|_| Ok(None)),
    }
}

fn rig_with(ttl: Option<i64>, foreground: Option<i64>) -> Rig {
    let Opened {
        _dir,
        path,
        stores,
        clock,
    } = opened(ttl, None);
    let timers = FakeTimers(Rc::default(), clock.clone());
    let events = Events::default();
    let service = ApprovalService::new(
        stores,
        clock.clone(),
        Box::new(timers.clone()),
        Some(Box::new(events.clone())),
        foreground,
        ports(),
    );
    Rig {
        _dir,
        path,
        clock,
        service,
        timers,
        events,
        audit: Lines::default(),
    }
}

fn rig() -> Rig {
    rig_with(None, None)
}

impl Rig {
    fn advance(&mut self, ms: i64) {
        let end = self.clock.get() + ms;
        loop {
            let next = {
                let t = self.timers.0.borrow();
                t.q.iter()
                    .filter(|(at, ..)| *at <= end)
                    .min_by_key(|(at, n, ..)| (*at, *n))
                    .cloned()
            };
            let Some((at, n, kind, id)) = next else { break };
            self.timers.0.borrow_mut().q.retain(|(_, m, ..)| *m != n);
            self.clock.set(self.clock.get().max(at));
            self.service.fire(&mut self.audit, kind, &id);
        }
        self.clock.set(end);
    }

    fn request(&mut self, ask: &Ask) -> Slot {
        let slot: Slot = Rc::default();
        let s = Rc::clone(&slot);
        self.service.request(
            &mut self.audit,
            ask,
            Box::new(move |a| *s.borrow_mut() = Some(a)),
        );
        slot
    }

    fn last(&self) -> (String, String) {
        let ev = self.events.0.borrow();
        let (_, p) = ev
            .iter()
            .rev()
            .find(|(n, _)| n == "approval.requested")
            .expect("no approval.requested event");
        (
            p["approval"]["id"].as_str().unwrap().to_owned(),
            p["nonce"].as_str().unwrap().to_owned(),
        )
    }

    fn decide(
        &mut self,
        approve: bool,
        surface: u8,
        scope: Option<&str>,
    ) -> Result<super::service::Decided, ServiceDenial> {
        let (id, nonce) = self.last();
        let input = ServiceDecide {
            request_id: id,
            nonce,
            approve,
            person: "christian".into(),
            surface,
            scope: scope.map(str::to_owned),
            ..Default::default()
        };
        self.service.decide(&mut self.audit, &input).unwrap()
    }

    fn event(&self, name: &str) -> Option<Value> {
        self.events
            .0
            .borrow()
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, p)| p.clone())
    }
}

struct PClock(i64);

impl PolicyClock for PClock {
    fn now(&self) -> f64 {
        self.0 as f64
    }
}

struct NoGrants;

impl GrantSource for NoGrants {
    fn list(&self, _: &str, _: &str, _: &str) -> Vec<Value> {
        Vec::new()
    }
    fn get(&self, _: &str) -> Option<Value> {
        None
    }
}

#[derive(Clone)]
struct AskFor {
    capability: &'static str,
    tool: Option<&'static str>,
    effect: Option<&'static str>,
    flags: Value,
    targets: Vec<&'static str>,
    action_hash: String,
    task: Option<&'static str>,
    session: Option<&'static str>,
    agent: &'static str,
    principal: &'static str,
}

impl Default for AskFor {
    fn default() -> Self {
        AskFor {
            capability: "fs.read",
            tool: None,
            effect: None,
            flags: json!({}),
            targets: vec!["/outside/dir/a.txt"],
            action_hash: format!("{:0<64}", "h1"),
            task: Some("t1"),
            session: Some("s1"),
            agent: "bernd",
            principal: "christian",
        }
    }
}

/// `askFor`: a genuine `ask` decision of the evaluator, turned into the ask the dispatcher would hand to the port.
fn ask_for(o: AskFor) -> Ask {
    let mut flags = json!({ "outsideRoots": true, "denyListHit": false });
    for (k, v) in o.flags.as_object().unwrap() {
        flags[k] = v.clone();
    }
    let tool = o.tool.unwrap_or(o.capability);
    let mut call = json!({ "capability": o.capability, "tool": tool, "flags": flags, "targets": o.targets, "access": "read", "actionHash": o.action_hash });
    if let Some(e) = o.effect {
        call["effect"] = json!(e);
    }
    let mut ctx = json!({ "principal": { "person": o.principal }, "subject": { "kind": "agent", "agentId": o.agent }, "surface": 3 });
    if let Some(s) = o.session {
        ctx["sessionId"] = json!(s);
    }
    if let Some(t) = o.task {
        ctx["taskId"] = json!(t);
    }
    let Decision::Ask { request, park, .. } = decide(&call, &ctx, &NoGrants, &PClock(0)) else {
        panic!("expected an ask decision for {call}")
    };
    Ask {
        request,
        call_id: "call1".into(),
        tool: tool.into(),
        args: json!({ "path": o.targets.first() }),
        agent_id: o.agent.into(),
        principal: o.principal.into(),
        session_id: o.session.map(str::to_owned),
        park,
        aborted: false,
        subject_kind: None,
        turn_id: Some("turn1".into()),
        task_id: o.task.map(str::to_owned),
        project_id: None,
        targets: Some(o.targets.iter().map(|t| json!(t)).collect()),
        access: Some("read".into()),
        reason: None,
        diff: None,
        recurring: None,
        public_peer_trust: None,
    }
}

fn answer(s: &Slot) -> Option<Answer> {
    s.borrow().clone()
}

#[test]
fn a_request_is_stored_and_announced_and_nothing_resolves_by_itself() {
    let mut r = rig();
    let ask = ask_for(AskFor {
        action_hash: format!("{:0<64}", "a1"),
        ..Default::default()
    });
    let slot = r.request(&ask);
    assert_eq!(answer(&slot), None);
    let p = r.event("approval.requested").unwrap();
    let nonce = p["nonce"].as_str().unwrap();
    assert!(nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(
        p["foregroundUntil"],
        json!(NOW + DEFAULT_FOREGROUND_WAIT_MS)
    );
    let a = &p["approval"];
    assert_eq!(
        (
            &a["status"],
            &a["principal"],
            &a["sessionId"],
            &a["taskId"],
            &a["turnId"]
        ),
        (
            &json!("pending"),
            &json!("christian"),
            &json!("s1"),
            &json!("t1"),
            &json!("turn1")
        )
    );
    assert_eq!(a["subject"], json!({ "kind": "agent", "id": "bernd" }));
    assert_eq!(a["actionHash"], json!(format!("{:0<64}", "a1")));
    assert_eq!(a["targets"], json!(["/outside/dir/a.txt"]));
    assert!(!a["grantOptions"].as_array().unwrap().is_empty());
    assert!(
        a.get("nonce").is_none() && a.get("args").is_none(),
        "a view never carries the nonce or the arguments"
    );
    let id = a["id"].as_str().unwrap();
    assert_eq!(
        r.service.stores().approval(id).unwrap().unwrap().status,
        Status::Pending
    );
    assert!(r.audit.has("approval.requested", "requestId", id));
    r.service.dispose(&mut r.audit);
    assert!(!answer(&slot).unwrap().approved);
}

#[test]
fn approve_once_resolves_the_call_with_a_once_grant_bound_to_the_action() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    let res = r.decide(true, 3, None).unwrap();
    assert!(res.approved);
    let a = answer(&slot).unwrap();
    assert!(a.approved);
    assert_eq!(
        (a.scope.map(|s| s.as_str()), a.grant_ids.len()),
        (Some("once"), 1)
    );
    let g = r.service.stores().grant(&a.grant_ids[0]).unwrap().unwrap();
    assert_eq!(
        (
            &g["scope"],
            &g["actionHash"],
            &g["person"],
            &g["agent"],
            &g["surface"]
        ),
        (
            &json!("once"),
            &json!(format!("{:0<64}", "h1")),
            &json!("christian"),
            &json!("bernd"),
            &json!(3)
        )
    );
    let resolved = r.event("approval.resolved").unwrap();
    assert_eq!(
        (
            &resolved["outcome"],
            &resolved["approval"]["status"],
            &resolved["approval"]["decidedBy"]
        ),
        (&json!("approved"), &json!("approved"), &json!("christian"))
    );
    let changed = r.event("grant.changed").unwrap();
    assert_eq!(
        (&changed["change"], &changed["grantId"]),
        (&json!("created"), &g["id"])
    );
    assert!(r.audit.has("approval.decided", "decision", "approve"));
}

#[test]
fn deny_resolves_not_approved_and_the_first_answer_wins() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    assert!(!r.decide(false, 3, None).unwrap().approved);
    assert_eq!(
        r.decide(true, 3, None),
        Err(ServiceDenial::Store(Denial::Used))
    );
    let a = answer(&slot).unwrap();
    assert!(!a.approved && a.reason.unwrap().contains("denied"));
    assert!(r.service.stores().inspect(None, None).unwrap().is_empty());
    assert_eq!(r.event("approval.resolved").unwrap()["outcome"], "denied");
}

#[test]
fn a_wrong_nonce_another_person_or_an_unknown_id_is_a_mismatch_and_the_call_keeps_waiting() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    let (id, nonce) = r.last();
    for (rid, n, person) in [
        (id.as_str(), "0".repeat(32), "christian"),
        (id.as_str(), nonce.clone(), "mallory"),
        ("apr_nope", nonce.clone(), "christian"),
    ] {
        let input = ServiceDecide {
            request_id: rid.into(),
            nonce: n,
            approve: true,
            person: person.into(),
            surface: 3,
            ..Default::default()
        };
        assert_eq!(
            r.service.decide(&mut r.audit, &input).unwrap(),
            Err(ServiceDenial::Store(Denial::Mismatch))
        );
    }
    assert_eq!(answer(&slot), None);
    assert!(r
        .audit
        .has("approval.refused", "reason", "approval-mismatch"));
}

#[test]
fn surfaces_and_scopes_are_checked_before_anything_is_decided() {
    let mut r = rig();
    let money = AskFor {
        capability: "money.spend",
        tool: Some("pay"),
        effect: Some("money"),
        targets: vec![],
        ..Default::default()
    };
    let slot = r.request(&ask_for(money.clone()));
    for surface in [0, 1, 2, 4] {
        assert_eq!(
            r.decide(true, surface, None),
            Err(ServiceDenial::Store(Denial::SurfaceUntrusted)),
            "T{surface}"
        );
    }
    assert_eq!(
        r.decide(true, 3, Some("always")),
        Err(ServiceDenial::ScopeUnavailable)
    );
    assert_eq!(
        r.decide(true, 3, Some("forever")),
        Err(ServiceDenial::ScopeUnavailable)
    );
    let (id, _) = r.last();
    assert_eq!(
        r.service.stores().approval(&id).unwrap().unwrap().status,
        Status::Pending
    );
    assert!(r.decide(true, 3, None).unwrap().approved);
    assert!(answer(&slot).unwrap().approved);

    let mut d = rig();
    let slot = d.request(&ask_for(money));
    assert!(
        !d.decide(false, 1, None).unwrap().approved,
        "a T1 surface may refuse what it may not approve"
    );
    assert!(!answer(&slot).unwrap().approved);
}

#[test]
fn a_task_scope_grants_the_targets_directory_and_decide_then_allows() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    assert!(r.decide(true, 3, Some("task")).unwrap().approved);
    let a = answer(&slot).unwrap();
    let g = r.service.stores().grant(&a.grant_ids[0]).unwrap().unwrap();
    assert_eq!((&g["scope"], &g["taskId"]), (&json!("task"), &json!("t1")));
    assert_eq!(
        g["match"],
        json!({ "kind": "path", "path": "/outside/dir", "access": "read", "recursive": false })
    );
    let ctx = json!({ "principal": { "person": "christian" }, "subject": { "kind": "agent", "agentId": "bernd" }, "surface": 3, "sessionId": "s1", "taskId": "t1" });
    let call = |t: &str| json!({ "capability": "fs.read", "tool": "fs.read", "flags": { "outsideRoots": true, "denyListHit": false }, "targets": [t], "access": "read", "actionHash": "h2" });
    let now = PClock(r.clock.get());
    assert_eq!(
        decide(&call("/outside/dir/b.txt"), &ctx, r.service.stores(), &now).json()["kind"],
        "allow"
    );
    assert_eq!(
        decide(
            &call("/outside/other/b.txt"),
            &ctx,
            r.service.stores(),
            &now
        )
        .json()["kind"],
        "ask"
    );

    let mut n = rig();
    let _ = n.request(&ask_for(AskFor {
        task: None,
        session: None,
        ..Default::default()
    }));
    for scope in ["task", "session"] {
        assert_eq!(
            n.decide(true, 3, Some(scope)),
            Err(ServiceDenial::ScopeUnavailable),
            "{scope}"
        );
    }
    assert!(n.service.stores().inspect(None, None).unwrap().is_empty());
}

#[test]
fn begin_consumes_the_approval_and_its_once_grant_exactly_once() {
    let mut r = rig();
    let ask = ask_for(AskFor::default());
    let slot = r.request(&ask);
    r.decide(true, 3, None).unwrap();
    let a = answer(&slot).unwrap();
    let other = Ask {
        agent_id: "eve".into(),
        ..ask.clone()
    };
    assert!(!r.service.begin(&mut r.audit, &a, &other), "another agent");
    let other = Ask {
        session_id: Some("s2".into()),
        ..ask.clone()
    };
    assert!(
        !r.service.begin(&mut r.audit, &a, &other),
        "another session"
    );
    assert!(r.service.begin(&mut r.audit, &a, &ask));
    assert!(!r.service.begin(&mut r.audit, &a, &ask), "replay");
    assert_eq!(
        r.service
            .stores()
            .approval(a.request_id.as_deref().unwrap())
            .unwrap()
            .unwrap()
            .status,
        Status::Used
    );
    assert!(r
        .service
        .stores()
        .grant(&a.grant_ids[0])
        .unwrap()
        .unwrap()
        .get("consumedAt")
        .is_some());
    assert!(r.audit.0.iter().any(|(n, _)| n == "approval.consumed"));
    assert!(
        !r.service.begin(&mut r.audit, &Answer::default(), &ask),
        "a not-approved answer never begins"
    );
}

#[test]
fn after_ten_minutes_the_call_parks_and_after_a_day_the_request_expires() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    r.advance(DEFAULT_FOREGROUND_WAIT_MS - 1);
    assert_eq!(answer(&slot), None);
    r.advance(1);
    let a = answer(&slot).unwrap();
    assert!(!a.approved && a.parked);
    assert!(r.event("approval.parked").is_some());
    let (id, _) = r.last();
    assert_eq!(
        r.service.stores().approval(&id).unwrap().unwrap().status,
        Status::Pending,
        "the request stays open"
    );
    r.advance(24 * HOUR);
    assert_eq!(
        r.service.stores().approval(&id).unwrap().unwrap().status,
        Status::Expired
    );
    assert!(r.audit.0.iter().any(|(n, _)| n == "approval.expired"));
    assert_eq!(
        r.decide(true, 3, None),
        Err(ServiceDenial::Store(Denial::Expired)),
        "never approved after the end"
    );

    let mut late = rig();
    let slot = late.request(&ask_for(AskFor::default()));
    late.advance(DEFAULT_FOREGROUND_WAIT_MS);
    assert!(
        late.decide(true, 3, None).unwrap().approved,
        "a parked request can still be decided"
    );
    assert!(
        answer(&slot).unwrap().parked,
        "the answer the call got stays the parked one"
    );

    let mut long = rig_with(Some(5 * MIN), Some(HOUR));
    let slot = long.request(&ask_for(AskFor::default()));
    long.advance(5 * MIN);
    let a = answer(&slot).unwrap();
    assert!(!a.approved && !a.parked && a.reason.unwrap().contains("expired"));
}

#[test]
fn abort_headless_and_an_aborted_signal_never_approve() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    let (id, _) = r.last();
    r.service.abort(&mut r.audit, &id);
    let a = answer(&slot).unwrap();
    assert_eq!((a.approved, a.reason.as_deref()), (false, Some("aborted")));
    assert_eq!(
        r.service.stores().approval(&id).unwrap().unwrap().status,
        Status::Cancelled
    );
    assert_eq!(
        r.event("approval.resolved").unwrap()["outcome"],
        "cancelled"
    );
    assert_eq!(
        r.decide(true, 3, None),
        Err(ServiceDenial::Store(Denial::Expired))
    );

    let mut h = rig();
    let slot = h.request(&Ask {
        park: true,
        ..ask_for(AskFor::default())
    });
    assert!(!answer(&slot).unwrap().approved);
    assert!(h.audit.has("approval.refused", "reason", "headless"));
    assert!(h.event("approval.requested").is_none());
    assert!(
        h.service.stores().approvals(None, None).unwrap().is_empty(),
        "nothing parks"
    );
    let slot = h.request(&Ask {
        aborted: true,
        ..ask_for(AskFor::default())
    });
    assert_eq!(answer(&slot).unwrap().reason.as_deref(), Some("aborted"));
}

#[test]
fn a_broken_chain_or_a_failing_audit_line_is_not_approved() {
    let mut r = rig();
    let _ = r.request(&ask_for(AskFor::default()));
    plur1bus_store::rusqlite::Connection::open(&r.path)
        .unwrap()
        .execute("UPDATE approval_chain SET payload = '{}'", [])
        .unwrap();
    let slot = r.request(&ask_for(AskFor::default()));
    let a = answer(&slot).unwrap();
    assert!(!a.approved && a.reason.unwrap().contains("integrity"));
    assert!(r
        .audit
        .0
        .iter()
        .any(|(n, f)| n == "approvals.integrity-failure" && f["failure"] == "mac-mismatch"));

    let mut f = rig();
    f.audit.1 = true;
    let slot = f.request(&ask_for(AskFor::default()));
    assert!(!answer(&slot).unwrap().approved);
    f.audit.1 = false;
    assert!(
        f.service.stores().approvals(None, None).unwrap().is_empty(),
        "the request was rolled back with its audit line"
    );
}

#[test]
fn dispose_resolves_every_waiting_call_as_not_approved() {
    let mut r = rig();
    let a = r.request(&ask_for(AskFor::default()));
    let b = r.request(&ask_for(AskFor {
        action_hash: format!("{:0<64}", "h2"),
        ..Default::default()
    }));
    r.service.dispose(&mut r.audit);
    assert!(!answer(&a).unwrap().approved && !answer(&b).unwrap().approved);
    assert_eq!(r.timers.0.borrow().q.len(), 0, "timers are cleared");
}

#[test]
fn a_decision_after_a_restart_uses_the_stored_detail() {
    let mut r = rig();
    let _ = r.request(&ask_for(AskFor {
        capability: "money.spend",
        tool: Some("pay"),
        effect: Some("money"),
        targets: vec![],
        ..Default::default()
    }));
    let (id, nonce) = r.last();
    let stores = crate::approvals::tests::open_at(
        &r.path,
        &crate::approvals::tests::KEY,
        None,
        None,
        r.clock.clone(),
    );
    let mut fresh = ApprovalService::new(
        stores,
        r.clock.clone(),
        Box::new(r.timers.clone()),
        None,
        None,
        ports(),
    );
    let input = ServiceDecide {
        request_id: id,
        nonce,
        approve: true,
        person: "christian".into(),
        surface: 2,
        ..Default::default()
    };
    assert_eq!(
        fresh.decide(&mut r.audit, &input).unwrap(),
        Err(ServiceDenial::Store(Denial::SurfaceUntrusted))
    );
    let input = ServiceDecide {
        surface: 3,
        ..input
    };
    assert!(
        fresh
            .decide(&mut r.audit, &input)
            .unwrap()
            .unwrap()
            .approved
    );
}

#[test]
fn views_list_get_cancel_decide_for_session_and_verify() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    let (id, _) = r.last();
    let views = r
        .service
        .list(Some(Status::Pending), Some("christian"), Some("t1"), None)
        .unwrap();
    assert_eq!(views.len(), 1);
    assert!(views[0].get("nonce").is_none());
    assert!(r
        .service
        .list(None, Some("mallory"), None, None)
        .unwrap()
        .is_empty());
    assert_eq!(
        r.service.get(&id, Some("mallory")).unwrap(),
        None,
        "another person's request is unknown"
    );
    assert!(r.service.get(&id, Some("christian")).unwrap().is_some());
    assert_eq!(
        r.service
            .cancel(&mut r.audit, &id, "mallory", None)
            .unwrap(),
        Err(Denial::Mismatch)
    );
    assert_eq!(
        r.service
            .cancel(&mut r.audit, &id, "christian", None)
            .unwrap(),
        Ok(())
    );
    assert_eq!(answer(&slot).unwrap().reason.as_deref(), Some("cancelled"));

    let slot = r.request(&ask_for(AskFor {
        action_hash: format!("{:0<64}", "h9"),
        ..Default::default()
    }));
    let (id, _) = r.last();
    let input = ServiceDecide {
        request_id: id,
        approve: true,
        person: "christian".into(),
        surface: 3,
        attested_via: Some("attested:touch-id".into()),
        scope: Some("task".into()),
        ..Default::default()
    };
    assert!(
        r.service
            .decide_for_session(&mut r.audit, &input)
            .unwrap()
            .unwrap()
            .approved
    );
    let a = answer(&slot).unwrap();
    assert_eq!(
        r.service.stores().grant(&a.grant_ids[0]).unwrap().unwrap()["attestedVia"],
        "attested:touch-id"
    );
    assert!(r.service.verify(&mut r.audit).unwrap().ok());
}

#[test]
fn a_relayed_decision_never_carries_an_attestation() {
    let mut r = rig();
    let slot = r.request(&ask_for(AskFor::default()));
    let (id, nonce) = r.last();
    let input = ServiceDecide {
        request_id: id,
        nonce,
        approve: true,
        person: "christian".into(),
        surface: 3,
        attested_via: Some("attested:touch-id".into()),
        scope: Some("task".into()),
        ..Default::default()
    };
    assert!(
        r.service
            .decide(&mut r.audit, &input)
            .unwrap()
            .unwrap()
            .approved
    );
    let a = answer(&slot).unwrap();
    assert!(r
        .service
        .stores()
        .grant(&a.grant_ids[0])
        .unwrap()
        .unwrap()
        .get("attestedVia")
        .is_none());
}

#[test]
fn policy_context_adds_denials_prompts_and_verified_hand_off_references() {
    let mut r = rig();
    let _ = r.request(&ask_for(AskFor {
        action_hash: "denied-hash".into(),
        ..Default::default()
    }));
    r.decide(false, 3, None).unwrap();
    let _ = r.request(&ask_for(AskFor {
        action_hash: "other-task".into(),
        task: Some("t2"),
        ..Default::default()
    }));
    let ctx = DispatchContext {
        principal: "christian".into(),
        agent_id: "bernd".into(),
        task_id: Some("t1".into()),
        session_id: Some("s1".into()),
    };
    let out = r
        .service
        .policy_context(
            &mut r.audit,
            &ctx,
            json!({ "promptsThisHour": 0, "deniedActionHashes": ["x"] }),
        )
        .unwrap();
    assert_eq!(out["deniedActionHashes"], json!(["x", "denied-hash"]));
    assert_eq!(
        out["promptsThisHour"],
        json!(1),
        "only this task's prompts of the last hour"
    );
    r.clock.set(NOW + HOUR + 1);
    let out = r
        .service
        .policy_context(&mut r.audit, &ctx, json!({ "promptsThisHour": 3 }))
        .unwrap();
    assert_eq!(
        out["promptsThisHour"],
        json!(3),
        "the inner hook's count is kept when it is higher"
    );

    // D104: references are verified, never believed.
    let slot = r.request(&ask_for(AskFor {
        action_hash: "h-del".into(),
        ..Default::default()
    }));
    let (id, nonce) = r.last();
    let input = ServiceDecide {
        request_id: id,
        nonce,
        approve: true,
        person: "christian".into(),
        surface: 3,
        scope: Some("task".into()),
        delegable: true,
        ..Default::default()
    };
    r.service.decide(&mut r.audit, &input).unwrap().unwrap();
    let good = answer(&slot).unwrap().grant_ids[0].clone();
    let base = json!({ "handoff": { "taskId": "t1", "approvalsHeld": [good, "grt_forged"] } });
    let out = r
        .service
        .policy_context(&mut r.audit, &ctx, base.clone())
        .unwrap();
    assert_eq!(out["handoff"]["approvalsHeld"], json!([good]));
    let (_, f) = r
        .audit
        .0
        .iter()
        .rev()
        .find(|(n, _)| n == "approvals.held-rejected")
        .unwrap();
    assert_eq!(
        f["rejected"],
        json!([{ "id": "grt_forged", "reason": "unknown" }])
    );
    let wrong = DispatchContext {
        principal: "eve".into(),
        ..ctx.clone()
    };
    let out = r
        .service
        .policy_context(
            &mut r.audit,
            &wrong,
            json!({ "handoff": { "taskId": "t1", "approvalsHeld": [good] } }),
        )
        .unwrap();
    assert_eq!(
        out["handoff"]["approvalsHeld"],
        json!([]),
        "a foreign person's grant is dropped"
    );
    let out = r
        .service
        .policy_context(
            &mut r.audit,
            &ctx,
            json!({ "handoff": { "taskId": "t9", "approvalsHeld": [good] } }),
        )
        .unwrap();
    assert_eq!(
        out["handoff"]["approvalsHeld"],
        json!([]),
        "another task's grant is dropped"
    );
    r.audit.1 = true;
    assert!(
        r.service.policy_context(&mut r.audit, &ctx, base).is_err(),
        "an unrecordable rejection makes the hook fail"
    );
}
