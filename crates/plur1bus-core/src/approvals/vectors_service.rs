//! Replay of the service-level vectors of review B (`fixtures/parity/approvals/{regex,cells,cells-grants}.json`, written by
//! `scripts/parity/approvals-service-cases.ts`): the real service and stores over a real file run the operations the
//! TypeScript service ran and must give the same answers, audit lines, events and waiter answers, and leave the same rows.
//!
//! `regex` walks the directory of path targets (`parentOf`) and the flattened job name through every character class in
//! which a JavaScript regular expression could part ways with a port (RB-2). `cells` and `cells-grants` give one column of
//! one row a value of a foreign storage class and then call every public operation (RB-3).
use super::keys::StaticKeySource;
use super::service::{
    Answer, ApprovalEvents, ApprovalService, Ask, Recurring, ServiceDecide, ServicePorts,
    TimerKind, Timers,
};
use super::signing::{DecisionSigner, Ed25519Signer};
use super::{ApprovalError, AuditPort, Clock, Random};
use crate::grants::open::{OpenPermissionStores, PermissionStores, Signing};
use crate::grants::store::GrantError;
use crate::logs::redact::TextRedactor;
use crate::policy::capabilities::GrantScope;
use plur1bus_store::rusqlite::types::Value as SqlValue;
use plur1bus_store::rusqlite::Connection;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

fn fixture(name: &str) -> Value {
    let text = match name {
        "regex" => include_str!("../../../../fixtures/parity/approvals/regex.json"),
        "cells" => include_str!("../../../../fixtures/parity/approvals/cells.json"),
        "cells-grants" => include_str!("../../../../fixtures/parity/approvals/cells-grants.json"),
        _ => unreachable!(),
    };
    serde_json::from_str(text).unwrap()
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) => o["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect(),
        other => panic!("not a text: {other}"),
    }
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len() / 2)
        .map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_owned()
}

fn os(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

struct SharedClock(AtomicI64);
impl Clock for SharedClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Hands out the bytes TypeScript drew, in order; a draw TypeScript did not make (or of another size) is counted.
struct Scripted(Mutex<VecDeque<Vec<u8>>>, Mutex<Vec<usize>>);
impl Random for Scripted {
    fn fill(&self, buf: &mut [u8]) {
        match self.0.lock().unwrap().pop_front() {
            Some(next) if next.len() == buf.len() => buf.copy_from_slice(&next),
            _ => {
                self.1.lock().unwrap().push(buf.len());
                buf.fill(0xee);
            }
        }
    }
}

#[derive(Default)]
struct AuditRec(Vec<Value>);
impl AuditPort for AuditRec {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        self.0.push(json!([action, fields]));
        Ok(())
    }
}

struct NoTimers;
impl Timers for NoTimers {
    fn set(&self, _: TimerKind, _: &str, _: i64) {}
    fn clear(&self, _: TimerKind, _: &str) {}
}

struct EventsRec(Rc<RefCell<Vec<Value>>>);
impl ApprovalEvents for EventsRec {
    fn emit(&self, name: &str, payload: &Value) {
        self.0.borrow_mut().push(json!([name, payload]));
    }
}

struct Ident;
impl TextRedactor for Ident {
    fn text(&self, input: &str) -> String {
        input.to_owned()
    }
    fn value(&self, input: &Value) -> Value {
        input.clone()
    }
}

/// Numbers compared as `f64` (TypeScript has no integers).
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => n
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Null, Value::Number),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn ask_of(a: &Value) -> Ask {
    Ask {
        request: a["request"].clone(),
        call_id: s(a, "callId"),
        tool: s(a, "tool"),
        args: a["args"].clone(),
        agent_id: s(a, "agentId"),
        principal: s(a, "principal"),
        session_id: os(a, "sessionId"),
        park: a["park"] == true,
        aborted: false,
        subject_kind: os(a, "subjectKind"),
        turn_id: os(a, "turnId"),
        task_id: os(a, "taskId"),
        project_id: os(a, "projectId"),
        targets: a.get("targets").and_then(Value::as_array).cloned(),
        access: os(a, "access"),
        reason: os(a, "reason"),
        diff: os(a, "diff"),
        recurring: a.get("recurring").map(|r| Recurring {
            job_id: s(r, "jobId"),
            job_name: s(r, "jobName"),
        }),
        public_peer_trust: None,
    }
}

fn answer_json(a: &Answer) -> Value {
    json!({ "approved": a.approved, "parked": a.parked, "requestId": a.request_id, "reason": a.reason,
        "scope": a.scope.map(GrantScope::as_str), "grantIds": a.grant_ids })
}

fn thrown_a(e: &ApprovalError) -> Value {
    match e {
        ApprovalError::Integrity { broken_at, reason } => {
            json!({ "throw": "integrity", "brokenAt": broken_at, "reason": reason.as_str() })
        }
        _ => json!({ "throw": "other" }),
    }
}

fn thrown_g(e: &GrantError) -> Value {
    match e {
        GrantError::Integrity { broken_at, reason } => {
            json!({ "throw": "integrity", "brokenAt": broken_at, "reason": reason.as_str() })
        }
        GrantError::Refused { code, message } => {
            json!({ "throw": "grant", "code": code.as_str(), "msg": message })
        }
        _ => json!({ "throw": "other" }),
    }
}

/// Every row as `quote()` spells it.
fn dump(conn: &Connection) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for t in [
        "approval_chain",
        "chain_head",
        "approvals",
        "grants",
        "approval_signatures",
    ] {
        let cols: Vec<String> = conn
            .prepare(&format!("PRAGMA table_info({t})"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let sql = format!(
            "SELECT {} AS l FROM {t} ORDER BY rowid",
            cols.iter()
                .map(|c| format!("quote({c})"))
                .collect::<Vec<_>>()
                .join(" || '|' || ")
        );
        let rows: Vec<Value> = conn
            .prepare(&sql)
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|l| Value::String(l.unwrap()))
            .collect();
        out.insert(t.to_owned(), Value::Array(rows));
    }
    out
}

/// `changed(before, now)` of the exporter.
fn changed(before: &Value, now: &serde_json::Map<String, Value>) -> Value {
    let mut out = serde_json::Map::new();
    for (t, rows) in now {
        let rows = rows.as_array().unwrap();
        let b = before[t].as_array().unwrap();
        let diff: Vec<Value> = rows
            .iter()
            .enumerate()
            .filter(|(i, l)| b.get(*i) != Some(*l))
            .map(|(i, l)| json!([i, l]))
            .collect();
        out.insert(t.clone(), json!({ "rows": rows.len(), "changed": diff }));
    }
    Value::Object(out)
}

fn load(conn: &Connection, rows: &Value) {
    for t in [
        "approval_chain",
        "chain_head",
        "approvals",
        "grants",
        "approval_signatures",
    ] {
        for r in rows[t].as_array().unwrap() {
            let o = r.as_object().unwrap();
            let cols: Vec<&String> = o.keys().collect();
            let values: Vec<SqlValue> = cols
                .iter()
                .map(|c| match &o[*c] {
                    Value::Null => SqlValue::Null,
                    Value::String(s) => SqlValue::Text(s.clone()),
                    Value::Number(n) => n
                        .as_i64()
                        .map_or_else(|| SqlValue::Real(n.as_f64().unwrap()), SqlValue::Integer),
                    other => panic!("a base cell of another kind: {other}"),
                })
                .collect();
            let sql = format!(
                "INSERT INTO {t} ({}) VALUES ({})",
                cols.iter()
                    .map(|c| c.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                cols.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
            );
            conn.execute(&sql, plur1bus_store::rusqlite::params_from_iter(values))
                .unwrap();
        }
    }
}

struct Session {
    svc: ApprovalService,
    raw: Connection,
    clock: Arc<SharedClock>,
    random: Arc<Scripted>,
    events: Rc<RefCell<Vec<Value>>>,
    answers: Rc<RefCell<Vec<Value>>>,
    canonical: Rc<RefCell<String>>,
}

fn open(v: &Value, path: &Path, base: Option<&Value>) -> Session {
    let key = unhex(&text(&v["key"]));
    let pkcs8 = super::node_codec::base64_decode(&text(&v["signing"]));
    let clock = Arc::new(SharedClock(AtomicI64::new(v["now"].as_i64().unwrap())));
    let random = Arc::new(Scripted(
        Mutex::new(VecDeque::new()),
        Mutex::new(Vec::new()),
    ));
    let keys = StaticKeySource::new(&key).unwrap();
    let opts = |clock: Arc<SharedClock>, random: Arc<Scripted>| OpenPermissionStores {
        path,
        db: Default::default(),
        keys: &keys,
        clock,
        random,
        request_ttl_ms: None,
        max_grant_days: None,
        home: Some(s(v, "home")),
        signing: Signing::Signer(
            Arc::new(Ed25519Signer::from_pkcs8(&pkcs8).unwrap()) as Arc<dyn DecisionSigner>
        ),
    };
    if let Some(rows) = base {
        // The schema first (the stores migrate a new file), then the base rows, then the stores over them.
        drop(PermissionStores::open(opts(clock.clone(), random.clone())).unwrap());
        load(&Connection::open(path).unwrap(), rows);
    }
    let stores = PermissionStores::open(opts(clock.clone(), random.clone())).unwrap();
    let events = Rc::new(RefCell::new(Vec::new()));
    let canonical = Rc::new(RefCell::new(String::new()));
    let canon = canonical.clone();
    let svc = ApprovalService::new(
        stores,
        clock.clone(),
        Box::new(NoTimers),
        Some(Box::new(EventsRec(events.clone()))),
        None,
        ServicePorts {
            canonical: Box::new(move |_| Some(canon.borrow().clone())),
            redactor: Box::new(Ident),
            peer_trust: Box::new(|_| Ok(None)),
        },
    );
    Session {
        svc,
        raw: Connection::open(path).unwrap(),
        clock,
        random,
        events,
        answers: Rc::new(RefCell::new(Vec::new())),
        canonical,
    }
}

fn decided_json(
    r: Result<Result<super::service::Decided, super::service::ServiceDenial>, ApprovalError>,
) -> Value {
    match r {
        Ok(Ok(d)) => {
            json!({ "ok": true, "approved": d.approved, "scope": d.scope.map(GrantScope::as_str), "grantIds": d.grant_ids })
        }
        Ok(Err(e)) => json!({ "ok": false, "reason": e.as_str() }),
        Err(e) => thrown_a(&e),
    }
}

/// Runs one recorded operation; returns the differences from the record (empty when equal).
fn replay_op(x: &mut Session, rec: &Value, begin_ask: Option<&Value>) -> Vec<String> {
    let op = rec["op"].as_str().unwrap();
    let i = &rec["in"];
    x.clock
        .0
        .store(rec["now"].as_i64().unwrap(), Ordering::SeqCst);
    {
        let mut q = x.random.0.lock().unwrap();
        q.clear();
        q.extend(
            rec["rand"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|h| unhex(h.as_str().unwrap())),
        );
    }
    x.random.1.lock().unwrap().clear();
    x.events.borrow_mut().clear();
    x.answers.borrow_mut().clear();
    let mut audit = AuditRec::default();
    let out: Value = match op {
        // A statement SQLite refuses (a CHECK constraint) throws in TypeScript, and the rest is not run.
        "sql" => i["sql"]
            .as_array()
            .unwrap()
            .iter()
            .try_for_each(|q| x.raw.execute_batch(q.as_str().unwrap()))
            .map_or_else(|_| json!({ "throw": "other" }), |()| Value::Null),
        "request" => {
            let ask = ask_of(&i["ask"]);
            *x.canonical.borrow_mut() = s(&i["ask"], "canonical");
            let answers = x.answers.clone();
            x.svc.request(
                &mut audit,
                &ask,
                Box::new(move |a| answers.borrow_mut().push(answer_json(&a))),
            );
            Value::Null
        }
        "decideForSession" => {
            let d = ServiceDecide {
                request_id: s(i, "requestId"),
                nonce: String::new(),
                approve: i["decision"] == "approve",
                person: s(i, "person"),
                surface: i["surface"].as_u64().unwrap() as u8,
                scope: os(i, "scope"),
                ..Default::default()
            };
            decided_json(x.svc.decide_for_session(&mut audit, &d))
        }
        "begin" => {
            let a = &i["answer"];
            let answer = Answer {
                approved: a["approved"] == true,
                parked: false,
                request_id: os(a, "requestId"),
                reason: None,
                scope: a["scope"].as_str().and_then(GrantScope::parse),
                grant_ids: a["grantIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|g| g.as_str().unwrap().to_owned())
                    .collect(),
            };
            let ask = begin_ask.expect("a begin needs the vector's ask");
            *x.canonical.borrow_mut() = s(ask, "canonical");
            json!(x.svc.begin(&mut audit, &answer, &ask_of(ask)))
        }
        "abort" => {
            x.svc.abort(&mut audit, &s(i, "id"));
            Value::Null
        }
        "storeRequest" => {
            let bound = super::store::Binding {
                action_hash: s(i, "actionHash"),
                principal: s(i, "principal"),
                subject_kind: s(&i["subject"], "kind"),
                subject_id: s(&i["subject"], "id"),
                turn_id: s(i, "turnId"),
                task_id: s(i, "taskId"),
                session_id: s(i, "sessionId"),
            };
            let input = super::store::RequestInput {
                bound,
                capability: s(i, "capability"),
                detail: Some(super::js_json::J::from_value(&i["detail"])),
            };
            x.svc.stores().request(&input).map_or_else(
                |e| thrown_a(&e),
                |r| json!({ "id": r.id, "nonce": r.nonce, "expiresAt": r.expires_at }),
            )
        }
        "gcreate" => {
            let mut g = crate::grants::store::CreateGrantInput::new(
                &s(i, "capability"),
                &s(i, "person"),
                &s(i, "agent"),
                &s(i, "scope"),
                crate::grants::store::GrantMatch::Capability,
                &s(i, "createdBy"),
                i["surface"].as_u64().unwrap() as u8,
            );
            g.id = os(i, "id");
            g.delegable = i["delegable"] == true;
            x.svc
                .stores()
                .create_grant(&mut audit, &g)
                .map_or_else(|e| thrown_g(&e), |v| v)
        }
        "policyContext" => {
            let c = &i["ctx"];
            let ctx = super::service::DispatchContext {
                principal: s(c, "principal"),
                agent_id: s(c, "agentId"),
                task_id: os(c, "taskId"),
                session_id: os(c, "sessionId"),
            };
            match x.svc.policy_context(&mut audit, &ctx, i["base"].clone()) {
                Ok(o) => {
                    json!({ "held": o.get("handoff").map_or(Value::Null, |h| h["approvalsHeld"].clone()) })
                }
                Err(_) => json!({ "throw": "other" }),
            }
        }
        "dispose" => {
            x.svc.dispose(&mut audit);
            Value::Null
        }
        "cancel" => match x.svc.cancel(
            &mut audit,
            &s(i, "requestId"),
            &s(i, "person"),
            i["by"].as_str(),
        ) {
            Ok(Ok(())) => json!({ "ok": true }),
            Ok(Err(d)) => json!({ "ok": false, "reason": d.as_str() }),
            Err(e) => thrown_a(&e),
        },
        "verify" => x
            .svc
            .verify(&mut audit)
            .map_or_else(|e| thrown_a(&e), |v| v.json()),
        "list" => x
            .svc
            .list(None, None, None, None)
            .map_or_else(|e| thrown_a(&e), Value::Array),
        "inspect" => x.svc.stores().inspect(None, None).map_or_else(
            |e| thrown_g(&e),
            |v| {
                Value::Array(
                    v.into_iter()
                        .map(|v| json!({ "grant": v.grant, "state": v.state.as_str() }))
                        .collect(),
                )
            },
        ),
        "glist" => x
            .svc
            .stores()
            .grants_for(&s(i, "person"), &s(i, "agent"), &s(i, "capability"))
            .map_or_else(|e| thrown_g(&e), Value::Array),
        "gget" => x
            .svc
            .stores()
            .grant(&s(i, "id"))
            .map_or_else(|e| thrown_g(&e), |g| g.unwrap_or(Value::Null)),
        "grevoke" => x
            .svc
            .stores()
            .revoke(&mut audit, &s(i, "id"), &s(i, "by"), &s(i, "reason"))
            .map_or_else(|e| thrown_g(&e), |b| json!(b)),
        "endTask" => x
            .svc
            .stores()
            .end_task(&mut audit, &s(i, "taskId"), "core")
            .map_or_else(|e| thrown_g(&e), |n| json!(n)),
        "endSession" => x
            .svc
            .stores()
            .end_session(&mut audit, &s(i, "sessionId"), "core")
            .map_or_else(|e| thrown_g(&e), |n| json!(n)),
        "markUsed" => x
            .svc
            .stores()
            .mark_used(&mut audit, &s(i, "id"))
            .map_or_else(|e| thrown_g(&e), |()| Value::Null),
        other => panic!("unknown operation {other}"),
    };
    let mut diffs = Vec::new();
    let mut check = |what: &str, ts: &Value, rs: Value| {
        if norm(ts) != norm(&rs) {
            diffs.push(format!("{op} {what}:\n    TS {ts}\n    RS {rs}"));
        }
    };
    check("out", &rec["out"], out);
    check("audit", &rec["audit"], Value::Array(audit.0));
    check(
        "events",
        &rec["events"],
        Value::Array(x.events.borrow().clone()),
    );
    check(
        "answers",
        &rec["answers"],
        Value::Array(x.answers.borrow().clone()),
    );
    let left = x.random.0.lock().unwrap().len();
    let extra = x.random.1.lock().unwrap().clone();
    if left != 0 || !extra.is_empty() {
        diffs.push(format!("{op} random: {left} of TypeScript's draws left over, draws TypeScript did not make: {extra:?}"));
    }
    diffs
}

#[test]
fn regular_expressions_through_the_service_give_typescripts_records() {
    let v = fixture("regex");
    let dir = tempfile::tempdir().unwrap();
    let mut x = open(&v, &dir.path().join("a.sqlite"), None);
    let mut bad = Vec::new();
    for (k, rec) in v["ops"].as_array().unwrap().iter().enumerate() {
        for d in replay_op(&mut x, rec, None) {
            bad.push(format!(
                "op {k} (in {}): {d}",
                rec["in"].to_string().chars().take(200).collect::<String>()
            ));
        }
    }
    let grants = dump(&x.raw).remove("grants").unwrap();
    if grants != v["grants"] {
        bad.push(format!(
            "grant rows differ:\n    TS {}\n    RS {grants}",
            v["grants"]
        ));
    }
    assert!(
        bad.is_empty(),
        "{} of {} operations differ:\n{}",
        bad.len(),
        v["ops"].as_array().unwrap().len(),
        bad.join("\n")
    );
}

fn cells(name: &str) {
    let v = fixture(name);
    let cases = v["cases"].as_array().unwrap();
    let reference = cases[0]["ops"].as_array().unwrap();
    let mut bad = Vec::new();
    for c in cases {
        let dir = tempfile::tempdir().unwrap();
        let mut x = open(&v, &dir.path().join("a.sqlite"), Some(&v["base"]));
        let mut diffs = Vec::new();
        for (k, op) in c["ops"].as_array().unwrap().iter().enumerate() {
            let rec = op.as_u64().map_or(op, |n| &reference[n as usize]);
            diffs.extend(
                replay_op(&mut x, rec, Some(&v["beginAsk"]))
                    .into_iter()
                    .map(|d| format!("op {k} {d}")),
            );
            if !diffs.is_empty() {
                break; // the first difference; what follows would only repeat it
            }
        }
        if diffs.is_empty() {
            let rows = changed(&v["baseDump"], &dump(&x.raw));
            if rows != c["dump"] {
                diffs.push(format!("rows:\n    TS {}\n    RS {rows}", c["dump"]));
            }
        }
        if !diffs.is_empty() {
            bad.push(format!(
                "== {}\n  {}",
                c["name"].as_str().unwrap(),
                diffs.join("\n  ")
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} cases differ:\n{}",
        bad.len(),
        cases.len(),
        bad.join("\n")
    );
}

#[test]
fn a_cell_of_a_foreign_type_in_the_chain_head_signatures_or_projection_gets_typescripts_answers() {
    cells("cells");
}

#[test]
fn a_cell_of_a_foreign_type_in_a_grant_row_gets_typescripts_answers() {
    cells("cells-grants");
}
