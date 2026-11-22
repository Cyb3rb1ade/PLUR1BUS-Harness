use super::*;
use crate::{
    media_search::{
        admission::{Operation, Route},
        Authority,
    },
    rbac::types::{Principal, PrincipalKind, Role},
};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

struct Rig {
    state: RefCell<Option<Vec<u8>>>,
    status: RefCell<Status>,
    events: RefCell<Vec<Value>>,
    calls: RefCell<Vec<Value>>,
    local: Cell<bool>,
    trusted: Cell<bool>,
    conflict: Cell<bool>,
}
impl Authority for Rig {
    fn principal(&self, id: &str) -> Option<Principal> {
        let mut who = Principal::new(id, Role::Owner);
        who.kind = Some(PrincipalKind::Person);
        Some(who)
    }
    fn scope_is_current(&self, _: &Principal, _: &Scope) -> bool {
        true
    }
    fn now(&self) -> u64 {
        0
    }
}
impl Policy for Rig {
    fn route(&self, _: Operation, _: &Scope) -> Option<Route> {
        Some(Route {
            provider: "local".into(),
            model: "fixture".into(),
            endpoint: None,
            local: self.local.get(),
            pinned: false,
            acknowledgment: None,
        })
    }
}
impl Driver for Rig {
    fn status(&self, _: &Scope) -> Result<Status, Error> {
        Ok(self.status.borrow().clone())
    }
    fn control(&self, _: &Scope, action: Action) -> Result<(), Error> {
        let bf = &mut self.status.borrow_mut().backfill;
        let call = match action {
            Action::Start(reason) => {
                bf.state = Phase::Running;
                json!([
                    "start",
                    match reason {
                        Start::Enable => "enable",
                        Start::ModelChange => "model-change",
                        Start::Manual => "manual",
                    }
                ])
            }
            Action::Resume => {
                bf.state = Phase::Running;
                bf.paused_reason = None;
                json!("resume")
            }
            Action::Cancel => {
                bf.state = Phase::Cancelled;
                json!("cancel")
            }
            Action::Pause => {
                bf.state = Phase::Paused;
                bf.paused_reason = Some(Pause::User);
                json!("pause")
            }
        };
        self.calls.borrow_mut().push(call);
        Ok(())
    }
    fn emit(&self, _: &Scope, event: &'static str, status: &Status) -> Result<(), Error> {
        self.events
            .borrow_mut()
            .push(json!({"name":event,"payload":status}));
        Ok(())
    }
}
impl StateFile for Rig {
    fn trusted(&self, _: &Scope) -> bool {
        self.trusted.get()
    }
    fn read(&self, _: usize) -> Result<Option<Vec<u8>>, Error> {
        Ok(self.state.borrow().clone())
    }
    fn compare_replace(&self, expected: Option<&[u8]>, after: &[u8]) -> Result<bool, Error> {
        if self.conflict.get() || self.state.borrow().as_deref() != expected {
            return Ok(false);
        }
        self.state.replace(Some(after.to_vec()));
        Ok(true)
    }
}

fn rig(row: &Value) -> Rig {
    Rig {
        state: RefCell::new(
            row["before"]
                .as_str()
                .map(|state| state.as_bytes().to_vec()),
        ),
        status: RefCell::new(serde_json::from_value(row["initial"].clone()).unwrap()),
        events: RefCell::new(Vec::new()),
        calls: RefCell::new(Vec::new()),
        local: Cell::new(true),
        trusted: Cell::new(true),
        conflict: Cell::new(false),
    }
}
fn fixture() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/media/backfill.json"
    ))
    .unwrap()
}
fn scope() -> Scope {
    Scope {
        workspace: "w".into(),
        agent_id: "a".into(),
        user: Some("u".into()),
    }
}

#[test]
fn backfill_controls_fingerprint_and_poll_match_typescript() {
    for row in fixture() {
        let name = row["name"].as_str().unwrap();
        let rig = rig(&row);
        let who = rig.principal("u").unwrap();
        let scope = scope();
        let caller = Caller {
            who: &who,
            scope: &scope,
            authority: &rig,
        };
        let ports = Ports {
            policy: &rig,
            driver: &rig,
            file: &rig,
        };
        let mut worker = Controller::new(scope.clone());
        let config = serde_json::from_value(row["cfg"].clone()).unwrap();
        let outcome = match name {
            "reindex" => json!(worker.reindex(&caller, &ports).unwrap()),
            "controls" => {
                worker.control(&caller, Action::Pause, &ports).unwrap();
                worker.control(&caller, Action::Resume, &ports).unwrap();
                json!(worker.control(&caller, Action::Cancel, &ports).unwrap())
            }
            "changes" => {
                worker.poll(&caller, &ports).unwrap();
                worker.poll(&caller, &ports).unwrap();
                rig.status.borrow_mut().model = "other".into();
                worker.poll(&caller, &ports).unwrap();
                rig.status.borrow_mut().counts.indexed += 1;
                json!(worker.poll(&caller, &ports).unwrap())
            }
            _ => json!(worker.init(&caller, &config, &ports).unwrap()),
        };
        assert_eq!(outcome, row["outcome"], "{name}");
        assert_eq!(json!(rig.calls.into_inner()), row["calls"], "{name}");
        assert_eq!(json!(rig.events.into_inner()), row["events"], "{name}");
        let state = rig
            .state
            .into_inner()
            .map(|bytes| String::from_utf8(bytes).unwrap());
        assert_eq!(json!(state), row["after"], "{name}");
    }
}

#[test]
fn trusted_scope_budget_and_state_are_checked_before_transition() {
    let row = &fixture()[0];
    let rig = rig(row);
    let who = rig.principal("u").unwrap();
    let scope = scope();
    let caller = Caller {
        who: &who,
        scope: &scope,
        authority: &rig,
    };
    let ports = Ports {
        policy: &rig,
        driver: &rig,
        file: &rig,
    };
    let mut worker = Controller::new(scope.clone());
    let config = serde_json::from_value(row["cfg"].clone()).unwrap();
    rig.local.set(false);
    assert!(worker.init(&caller, &config, &ports).is_err());
    assert!(rig.calls.borrow().is_empty());
    rig.local.set(true);
    rig.trusted.set(false);
    assert!(worker.init(&caller, &config, &ports).is_err());
    assert!(rig.calls.borrow().is_empty());
    rig.trusted.set(true);
    rig.conflict.set(true);
    assert_eq!(
        worker.init(&caller, &config, &ports).unwrap_err().reason,
        "backfill-state-changed"
    );
    assert!(rig.state.borrow().is_none());
}
