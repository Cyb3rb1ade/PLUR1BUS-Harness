//! `rbac/audit.ts`: the audit event of the RBAC modules and its sink. The line shape is the five-key one the CLI writes to
//! `logs/audit.log`: `{ at, actor: { user, host }, action, target, detail }`.
use serde_json::{json, Value};

/// `AuditEvent`. `detail` keeps the order its producer wrote the members in: the line is written in that order.
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEvent {
    /// Epoch milliseconds.
    pub at: i64,
    /// `actor.user`.
    pub user: String,
    /// `actor.host`.
    pub host: String,
    /// The action name.
    pub action: String,
    /// What it was done to.
    pub target: String,
    /// Further members.
    pub detail: Vec<(String, Value)>,
}

impl AuditEvent {
    /// `{ at, actor: { user, host }, action, target, detail }` as a value (member order is not kept: see `line`).
    pub fn to_json(&self) -> Value {
        json!({ "at": self.at, "actor": { "user": self.user, "host": self.host }, "action": self.action, "target": self.target,
            "detail": Value::Object(self.detail.iter().cloned().collect()) })
    }
}

/// `AuditSink`: `append` fails when the event could not be recorded; callers that must not act unrecorded rely on it.
pub trait AuditSink {
    /// Records one event.
    fn append(&mut self, event: &AuditEvent) -> Result<(), String>;
}

impl<F: FnMut(&AuditEvent) -> Result<(), String>> AuditSink for F {
    fn append(&mut self, event: &AuditEvent) -> Result<(), String> {
        self(event)
    }
}
