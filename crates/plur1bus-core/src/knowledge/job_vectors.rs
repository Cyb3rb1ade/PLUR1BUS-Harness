use super::*;
use crate::rbac::types::Role;
use serde_json::json;
use std::cell::{Cell, RefCell};

struct Rig<'a> {
    name: &'a str,
    time: Cell<u64>,
    schedule: &'a Schedule,
    who: Principal,
    agents: RefCell<Vec<String>>,
    calls: RefCell<Vec<Value>>,
    reentrant: RefCell<Value>,
    cancelled: Cell<bool>,
    revoke: Cell<bool>,
}

impl Host for Rig<'_> {
    fn now(&self) -> u64 {
        self.time.get()
    }
    fn cancelled(&self) -> bool {
        self.cancelled.get()
    }
    fn agents(&self) -> Vec<String> {
        self.agents.borrow().clone()
    }
    fn principal(&self, user: &str) -> Option<Principal> {
        (user == self.who.user_id && !self.revoke.get()).then(|| self.who.clone())
    }
    fn knowledge_promotion(&self) -> bool {
        self.name != "capability"
    }
    fn jobs(&self) -> Vec<String> {
        vec![(if self.name == "job name" {
            "knowledge.update"
        } else {
            "knowledge-update"
        })
        .into()]
    }
    fn dispatch(&self, job: &str, agent: &str, trigger: Trigger) -> Option<Receipt> {
        self.calls
            .borrow_mut()
            .push(json!([job, agent, trigger.name()]));
        if agent == "a" {
            match self.name {
                "removed" => self.agents.borrow_mut().retain(|id| id != "b"),
                "abort" => self.cancelled.set(true),
                "singleton" => {
                    self.reentrant.replace(
                        self.schedule
                            .run(self, &self.who, &Value::Null, Trigger::Manual)
                            .unwrap(),
                    );
                }
                "throw" => return None,
                "rights" => self.revoke.set(true),
                _ => {}
            }
        }
        if agent == "b" && self.name == "mixed" {
            return Some(Receipt {
                outcome: "incomplete".into(),
                run_id: None,
                reason: Some("budget".into()),
            });
        }
        let outcome = match (agent, self.name) {
            ("b", "invalid") => "complete",
            ("c", _) => "skipped",
            _ => "completed",
        };
        Some(Receipt {
            outcome: outcome.into(),
            run_id: Some(format!("{agent}-run")),
            reason: None,
        })
    }
}

fn rig<'a>(schedule: &'a Schedule, name: &'a str) -> Rig<'a> {
    Rig {
        name,
        time: Cell::new(10_200),
        schedule,
        who: Principal::new("owner", Role::Owner),
        agents: RefCell::new(["a", "b", "c"].map(str::to_owned).to_vec()),
        calls: RefCell::new(Vec::new()),
        reentrant: RefCell::new(Value::Null),
        cancelled: Cell::new(name == "pre-abort"),
        revoke: Cell::new(false),
    }
}

#[test]
fn scheduler_and_receipts_match_typescript() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/knowledge/job.json"
    ))
    .unwrap();
    for row in fixture["cases"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let schedule = Schedule::new(10_000, (name == "restart").then_some(9_000));
        assert_eq!(json!(schedule.next_at()), row["initial"], "{name}");
        let rig = rig(&schedule, name);
        let arg = match name {
            "target" => json!({"agentId":"b"}),
            "unknown" => json!({"agentId":"absent"}),
            "extra" => json!({"scope":"b"}),
            "array" => json!([]),
            _ => Value::Null,
        };
        let run = schedule
            .run(&rig, &rig.who, &arg, Trigger::Manual)
            .unwrap_or_else(|error| json!({"error":error}));
        assert_eq!(run, row["outcome"], "{name}");
        assert_eq!(json!(schedule.next_at()), row["next"], "{name}");
        assert_eq!(json!(rig.calls.into_inner()), row["calls"], "{name}");
        assert_eq!(rig.reentrant.into_inner(), row["reentrant"], "{name}");
    }
    assert_eq!(
        json!([
            Schedule::wake_delay(120, 100, false),
            Schedule::wake_delay(125, 120, true)
        ]),
        fixture["retry"]["delays"]
    );
}

#[test]
fn lost_live_authority_stops_later_dispatches() {
    let schedule = Schedule::new(0, None);
    let rig = rig(&schedule, "rights");
    let out = schedule
        .run(&rig, &rig.who, &Value::Null, Trigger::Harness)
        .unwrap();
    assert_eq!(out["reason"], "knowledge-rights-changed");
    assert_eq!(rig.calls.borrow().len(), 1);
}

#[test]
fn narrower_scope_skips_unentitled_agents() {
    let schedule = Schedule::new(0, None);
    let mut rig = rig(&schedule, "scope");
    rig.who.role = Role::Operator;
    rig.who.agent_rights = Some(vec![("b".into(), crate::rbac::types::AgentRight::Use)]);
    schedule
        .run(&rig, &rig.who, &Value::Null, Trigger::Cron)
        .unwrap();
    assert_eq!(
        rig.calls.into_inner(),
        vec![json!(["knowledge-update", "b", "cron"])]
    );
}
