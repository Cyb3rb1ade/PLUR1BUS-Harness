//! Doubles of the gate's ports (R-K-2): a clock that is set, an audit trail in memory, and permission stores in memory.
//! They are public because the executors' tests and the documentation examples build a [`super::Gate`] from them. A gate
//! over doubles is still a gate: it decides with the real evaluator, and nothing here can make an
//! [`super::ApprovedAction`] except through [`super::Gate::verify`].
use super::Permissions;
use plur1bus_core::approvals::service::{Answer, Ask};
use plur1bus_core::approvals::AuditPort;
use plur1bus_core::policy::decide::{Clock, GrantSource};
use serde_json::Value;
use std::cell::Cell;
use std::collections::VecDeque;

/// A clock that shows what it was set to (milliseconds since the epoch).
#[derive(Debug, Default)]
pub struct SetClock(pub Cell<f64>);

impl SetClock {
    /// A clock at `ms`.
    pub fn at(ms: f64) -> Self {
        SetClock(Cell::new(ms))
    }
    /// Move the clock forward.
    pub fn advance(&self, ms: f64) {
        self.0.set(self.0.get() + ms);
    }
}

impl Clock for SetClock {
    fn now(&self) -> f64 {
        self.0.get()
    }
}

/// An audit trail in memory: every line as `(action, fields)`, in order.
#[derive(Debug, Default)]
pub struct MemoryAudit {
    /// The lines written.
    pub lines: Vec<(String, Value)>,
    /// Actions whose line cannot be written (the sink fails for them).
    pub failing: Vec<String>,
    /// `false`: no audit trail is configured at all.
    pub absent: bool,
}

impl MemoryAudit {
    /// The lines of one action.
    pub fn of(&self, action: &str) -> Vec<&Value> {
        self.lines
            .iter()
            .filter(|(a, _)| a == action)
            .map(|(_, f)| f)
            .collect()
    }
}

impl AuditPort for MemoryAudit {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        if self.failing.iter().any(|a| a == action) {
            return Err("the audit sink failed".to_owned());
        }
        self.lines.push((action.to_owned(), fields.clone()));
        Ok(())
    }
    fn present(&self) -> bool {
        !self.absent
    }
}

/// Permission stores in memory: grants as the store hands them back (JSON), the answers a person gives in order, and a
/// record of what the gate did with them.
#[derive(Debug, Default)]
pub struct Permits {
    /// The grants.
    pub grants: Vec<Value>,
    /// The answers to the next approval requests, in order; none left means "not approved".
    pub answers: VecDeque<Answer>,
    /// What `begin` answers.
    pub begin_fails: bool,
    /// One-time grants already spent.
    pub spent: Vec<String>,
    /// The use of a grant cannot be recorded.
    pub use_fails: bool,
    /// Every request the gate made.
    pub asked: Vec<Ask>,
    /// Every call in order: `request`, `begin <request id>`, `consume <grant id>`, `used <grant id>`.
    pub log: Vec<String>,
}

impl Permits {
    /// A store whose next approval request is approved (as request `apr_1`).
    pub fn approving() -> Self {
        let mut p = Permits::default();
        p.answers.push_back(Answer {
            approved: true,
            request_id: Some("apr_1".to_owned()),
            ..Answer::default()
        });
        p
    }
}

impl GrantSource for Permits {
    fn list(&self, person: &str, agent: &str, capability: &str) -> Vec<Value> {
        let is = |g: &Value, k: &str, want: &str| g.get(k).and_then(Value::as_str) == Some(want);
        self.grants
            .iter()
            .filter(|g| {
                is(g, "person", person) && is(g, "agent", agent) && is(g, "capability", capability)
            })
            .cloned()
            .collect()
    }
    fn get(&self, id: &str) -> Option<Value> {
        self.grants
            .iter()
            .find(|g| g.get("id").and_then(Value::as_str) == Some(id))
            .cloned()
    }
}

impl Permissions for Permits {
    fn grants(&self) -> &dyn GrantSource {
        self
    }
    fn consume_once(
        &mut self,
        _: &mut dyn AuditPort,
        id: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<bool, String> {
        self.log.push(format!("consume {id}"));
        if self.use_fails {
            return Err("store unavailable".to_owned());
        }
        if self.spent.iter().any(|s| s == id) {
            return Ok(false);
        }
        self.spent.push(id.to_owned());
        Ok(true)
    }
    fn mark_used(&mut self, _: &mut dyn AuditPort, id: &str) -> Result<(), String> {
        self.log.push(format!("used {id}"));
        if self.use_fails {
            return Err("store unavailable".to_owned());
        }
        Ok(())
    }
    fn request(&mut self, _: &mut dyn AuditPort, ask: &Ask) -> Answer {
        self.log.push("request".to_owned());
        self.asked.push(ask.clone());
        self.answers.pop_front().unwrap_or_default()
    }
    fn begin(&mut self, _: &mut dyn AuditPort, answer: &Answer, _: &Ask) -> bool {
        self.log.push(format!(
            "begin {}",
            answer.request_id.as_deref().unwrap_or("-")
        ));
        !self.begin_fails
    }
}
