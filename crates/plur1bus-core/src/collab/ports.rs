//! `collab/ports.ts` (R-K-2): everything the collaboration service needs from the rest of the core comes in through one of these
//! ports, so it can be scripted in a test and wired by the flip. Nothing here reaches a clock, a network or a global.
//!
//! **Redaction is mandatory for release.** TypeScript falls back to a default redactor when none is given; this port has no
//! default. Without a [`RedactionPort`] the service refuses to return a trace, a task or a transcript and stores empty
//! previews: content an agent or a viewer must not see is never released by accident (K6-D decision D4 in the ledger).
use super::errors::{CollabError, GuardrailReason};
use super::types::{AgentState, CollabEvent};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, Decision, Principal, Resource};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// The answer of an [`AuthorizePort`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthDecision {
    /// Whether the effect is `allow`.
    pub allow: bool,
    /// The reason text (`role`, `membership-required`, ...).
    pub reason: String,
}

/// `AuthorizePort`.
pub trait AuthorizePort: Send + Sync {
    /// `authorize(principal, action, resource)`.
    fn authorize(&self, principal: &Principal, action: &str, resource: &Resource) -> AuthDecision;
}

/// `rbacAuthorizePort`: the real RBAC decision of [`crate::rbac`].
#[derive(Clone, Copy, Debug, Default)]
pub struct RbacAuthorize;

impl AuthorizePort for RbacAuthorize {
    fn authorize(&self, principal: &Principal, action: &str, resource: &Resource) -> AuthDecision {
        match authorize(
            Some(principal),
            action,
            resource,
            &AuthorizeContext::default(),
        ) {
            Decision::Allow { reason, .. } => AuthDecision {
                allow: true,
                reason: reason.as_str().to_owned(),
            },
            Decision::Deny { reason } => AuthDecision {
                allow: false,
                reason: reason.as_str().to_owned(),
            },
        }
    }
}

/// `BudgetCheck`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetCheck {
    /// Tokens.
    pub tokens: i64,
    /// The project.
    pub project_id: String,
    /// The agent.
    pub agent_id: String,
    /// The chain (trace) id.
    pub chain_id: String,
}

/// `BudgetPort`: the budget check before a call and the record after it.
pub trait BudgetPort: Send + Sync {
    /// Whether the call may start; a refusal is always the `token-budget` guardrail.
    fn check(&self, estimate: &BudgetCheck) -> bool;
    /// `record(usage)`.
    fn record(&self, usage: &BudgetCheck);
}

/// `unlimitedBudget`.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnlimitedBudget;

impl BudgetPort for UnlimitedBudget {
    fn check(&self, _: &BudgetCheck) -> bool {
        true
    }
    fn record(&self, _: &BudgetCheck) {}
}

/// `RedactionPort`.
pub trait RedactionPort: Send + Sync {
    /// One string through the rules.
    fn text(&self, s: &str) -> String;
    /// A JSON value through the rules.
    fn value(&self, v: &Value) -> Value;
}

/// `logsRedactionPort`: the redactor of [`crate::logs::redact`] behind the port.
pub struct LogsRedaction(pub std::sync::Arc<dyn crate::logs::redact::TextRedactor>);

impl RedactionPort for LogsRedaction {
    fn text(&self, s: &str) -> String {
        self.0.text(s)
    }
    fn value(&self, v: &Value) -> Value {
        self.0.value(v)
    }
}

/// `EventEmitter`: an emitter must not break the service, so it cannot fail.
pub trait EventEmitter: Send + Sync {
    /// `emit(e)`.
    fn emit(&self, e: &CollabEvent);
}

/// `noopEmitter`.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopEmitter;

impl EventEmitter for NoopEmitter {
    fn emit(&self, _: &CollabEvent) {}
}

/// An emitter that keeps what it heard (a test double, also what a flip's bridge can start from).
#[derive(Default)]
pub struct MemoryEmitter(pub Mutex<Vec<CollabEvent>>);

impl EventEmitter for MemoryEmitter {
    fn emit(&self, e: &CollabEvent) {
        if let Ok(mut v) = self.0.lock() {
            v.push(e.clone());
        }
    }
}

/// `AgentInfo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentInfo {
    /// The id.
    pub id: String,
    /// The state.
    pub state: AgentState,
    /// `external` or `a2a`.
    pub target_kind: Option<String>,
    /// `a2a`.
    pub origin_a2a: bool,
}

/// `AgentDirectoryPort`.
pub trait AgentDirectoryPort: Send + Sync {
    /// `get(agentId)`.
    fn get(&self, agent_id: &str) -> Option<AgentInfo>;
}

/// `activeDirectory`: every agent exists and is active.
#[derive(Clone, Copy, Debug, Default)]
pub struct ActiveDirectory;

impl AgentDirectoryPort for ActiveDirectory {
    fn get(&self, id: &str) -> Option<AgentInfo> {
        Some(AgentInfo {
            id: id.to_owned(),
            state: AgentState::Active,
            target_kind: None,
            origin_a2a: false,
        })
    }
}

/// A directory from a table (a test double): an agent that is not in it does not exist.
#[derive(Default)]
pub struct TableDirectory(pub HashMap<String, AgentInfo>);

impl AgentDirectoryPort for TableDirectory {
    fn get(&self, id: &str) -> Option<AgentInfo> {
        self.0.get(id).cloned()
    }
}

/// What a turn runner is asked to do (the target port of `runner.ts`, reduced to what admission and recording need).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunInput {
    /// The agent that answers.
    pub agent_id: String,
    /// The project.
    pub project_id: String,
    /// The question or task.
    pub text: String,
    /// The context.
    pub context: String,
}

/// What a run returns.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct RunOutput {
    /// The answer text.
    pub text: String,
    /// Whether it is partial.
    pub partial: bool,
    /// Input tokens.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
}

/// Turn execution (`AgentRunner`): the service does not run a model; the flip wires one. The two-phase calls of the service
/// take the result of a run, so nothing in this module blocks or spawns.
pub trait TurnRunner: Send + Sync {
    /// Runs one turn to the end.
    fn run(&self, input: &RunInput) -> Result<RunOutput, CollabError>;
}

/// A scripted runner (`FakeChatProvider` of the TypeScript tests): answers from a queue, then with an echo.
#[derive(Default)]
pub struct ScriptedRunner {
    answers: Mutex<Vec<Result<RunOutput, CollabError>>>,
    /// Every input it was given.
    pub seen: Mutex<Vec<RunInput>>,
}

impl ScriptedRunner {
    /// Queues one answer.
    pub fn push(&self, answer: Result<RunOutput, CollabError>) {
        if let Ok(mut a) = self.answers.lock() {
            a.push(answer);
        }
    }
}

impl TurnRunner for ScriptedRunner {
    fn run(&self, input: &RunInput) -> Result<RunOutput, CollabError> {
        if let Ok(mut s) = self.seen.lock() {
            s.push(input.clone());
        }
        let next = self
            .answers
            .lock()
            .ok()
            .and_then(|mut a| (!a.is_empty()).then(|| a.remove(0)));
        next.unwrap_or_else(|| {
            Ok(RunOutput {
                text: format!("echo: {}", input.text),
                partial: false,
                input_tokens: 1,
                output_tokens: 1,
            })
        })
    }
}

/// The guardrail a refused budget check reports.
pub const BUDGET_REFUSAL: GuardrailReason = GuardrailReason::TokenBudget;
