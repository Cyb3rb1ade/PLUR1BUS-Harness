use super::{prepare_handoff, prepare_return, HandoffContext, HandoffTicket, Repair};
use crate::approvals::store::{ApprovalRecord, Binding, Status};
use crate::budget::Clock;
use crate::collab::store::R;
use crate::rbac::audit::AuditEvent;
use crate::toolcall::json::{parse, V};
use serde_json::{json, Value};
use std::cell::Cell;
use std::sync::atomic::{AtomicI64, Ordering};

const FIXTURE: &str = include_str!("../../../../fixtures/parity/collab/handoff.json");

struct TestClock(AtomicI64);

impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

fn decode(value: &Value) -> V {
    parse(value.as_str().expect("recorded JSON text")).expect("valid JSON text")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("fixture string")
}

fn approval(row: &Value) -> Option<ApprovalRecord> {
    if row.is_null() {
        return None;
    }
    let bound = &row["bound"];
    Some(ApprovalRecord {
        id: "approval-fixture".to_owned(),
        status: match text(&row["status"]) {
            "approved" => Status::Approved,
            "used" => Status::Used,
            other => panic!("unexpected approval state {other}"),
        },
        capability: "file.read".to_owned(),
        bound: Binding {
            action_hash: "unused".to_owned(),
            principal: text(&bound["principal"]).to_owned(),
            subject_kind: text(&bound["subject"]["kind"]).to_owned(),
            subject_id: text(&bound["subject"]["id"]).to_owned(),
            turn_id: "turn".to_owned(),
            task_id: text(&bound["taskId"]).to_owned(),
            session_id: text(&bound["sessionId"]).to_owned(),
        },
        created_at: 0.0,
        expires_at: row["expiresAt"].as_f64().unwrap(),
        decided_at: None,
        decided_by: None,
        decision_surface: None,
        delegable: row["delegable"].as_bool().unwrap(),
        used_at: None,
        detail: None,
        cancelled_at: None,
    })
}

fn wire(outcome: R<Value>) -> Value {
    match outcome {
        Ok(value) => json!({ "ok": value }),
        Err(e) => {
            json!({ "err": { "code": e.code.as_str(), "message": e.message, "reason": e.reason } })
        }
    }
}

fn to_value(value: &V) -> Value {
    serde_json::from_str(&value.stringify()).unwrap()
}

#[test]
fn handoff_vectors() {
    let cases: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    let selected = std::env::var("PLUR1BUS_TEST_HANDOFF_CASE").ok();
    let mut checked = 0;
    for c in cases {
        let name = text(&c["name"]);
        if selected.as_deref().is_some_and(|case| case != name) {
            continue;
        }
        checked += 1;
        let clock = TestClock(AtomicI64::new(c["now"].as_i64().unwrap_or_default()));
        let expected = c["expected"].is_string().then(|| decode(&c["expected"]));
        let active = Cell::new(true);
        let lookup = |_: &str| Ok(active.get().then(|| approval(&c["record"])).flatten());
        let grants = |_: &str| Ok(c.get("grant").filter(|v| !v.is_null()).cloned());
        let mut reasons = Vec::new();
        let mut audit = |event: &AuditEvent| {
            assert_eq!(event.action, "handoff.refused");
            assert_eq!(event.user, "member");
            assert_eq!(event.target, "task");
            reasons.push(
                event
                    .detail
                    .iter()
                    .find(|(k, _)| k == "reason")
                    .unwrap()
                    .1
                    .clone(),
            );
            Ok(())
        };
        let mut ctx = HandoffContext {
            person: "member",
            task_id: "task",
            session_id: "session",
            from_agent: "sender",
            project_id: "project",
            expected: expected.as_ref(),
            has_history: c["history"].as_bool().unwrap_or_default(),
            clock: &clock,
            approval: &lookup,
            grant: &grants,
            audit: &mut audit,
        };
        let input = decode(&c["input"]);
        let mut repairs = 0;
        let mut repair = |_: &V, issues: &[String]| {
            repairs += 1;
            assert!(!issues.is_empty());
            Ok(decode(&c["repair"]))
        };
        let repair_port = c.get("repair").map(|_| &mut repair as &mut Repair<'_>);
        match text(&c["op"]) {
            "prepare" => {
                assert_eq!(
                    wire(prepare_handoff(input, &mut ctx, repair_port).map(|v| to_value(&v))),
                    c["result"],
                    "{name}"
                );
                assert_eq!(json!(reasons), c["audits"], "{name}");
                assert_eq!(json!(repairs), c["repairs"], "{name}");
            }
            "return" => {
                assert_eq!(
                    wire(
                        prepare_return(input, &decode(&c["contract"]), repair_port)
                            .map(|v| to_value(&v))
                    ),
                    c["result"],
                    "{name}"
                );
                assert_eq!(json!(repairs), c["repairs"], "{name}");
            }
            "ticket" => {
                let mut ticket =
                    HandoffTicket::new(input, &mut ctx).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(json!(ticket.digest), c["digest"], "{name}");
                let outcomes: Vec<_> = c["steps"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|step| {
                        wire(match text(&step["op"]) {
                            "ack" => ticket
                                .acknowledge(&V::from_serde(&step["input"]))
                                .map(|()| Value::Null),
                            "start" => ticket.start().map(|h| to_value(h.get("id").unwrap())),
                            "expire" => {
                                clock
                                    .0
                                    .store(c["deadline"].as_i64().unwrap(), Ordering::Relaxed);
                                Ok(Value::Null)
                            }
                            "revoke" => {
                                active.set(false);
                                Ok(Value::Null)
                            }
                            op => panic!("unexpected operation {op}"),
                        })
                    })
                    .collect();
                assert_eq!(json!(outcomes), c["outcomes"], "{name}");
                assert_eq!(json!(reasons), c["audits"], "{name}");
            }
            op => panic!("unexpected fixture operation {op}"),
        }
    }
    assert!(checked > 0);
}
