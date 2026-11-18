//! The typestate tool gate, T1-b (D120 §11.2): the place where a decision becomes an execution.
//!
//! ```text
//! UnverifiedAction ──Gate::verify──► ApprovedAction ──redeem (in an Executor)──► Receipt ──► the effect
//! ```
//!
//! **What the types prove.** An [`Executor`] takes an [`ApprovedAction`], by value. An [`ApprovedAction`] has no public
//! field and no constructor outside this module, and it implements neither `Clone`, `Default`, `Deserialize` nor `From`:
//! the only way to hold one is [`Gate::verify`], and holding one means that the policy allowed the call, that the audit
//! line of the decision was written, and that an approval or a one-time grant the call needed was consumed. It is used
//! once: [`ApprovedAction::redeem`] consumes it, and it is bound to exactly the action that was verified (tool, the
//! canonical arguments through the action hash, targets, the hash extra, principal, agent, session) and to a short
//! lifetime. An executor redeems it against what it is about to do, computed again at that moment; a difference is a
//! refusal. This module is the trust boundary: code outside it cannot make the type lie.
//!
//! **What the gate composes** (P4-K K2 and K3): `policy::decide` over the real `GrantSource`, the headless rule, the
//! policy audit line before anything else happens, the approval port (`request`, then `begin`, which consumes the approval
//! and its one-time grant atomically) and the use of a grant. The order is the TypeScript dispatcher's
//! (`packages/core/src/tools/dispatcher.ts`, `call`, step 2): classify, hash, decide, record, ask or use the grant. The
//! tool's classifier (the path layer for `exec` and `fs`) runs inside the gate, never on the caller's side: the flags and
//! targets the policy judges are computed here from the arguments.
//!
//! **What is not here.** Argument validation against the tool's schema and the repair round, the channel behaviour
//! profile, the sandbox precondition, result limits, the result redaction, taint tracking and the outcome line of an
//! executed call are the dispatcher's (P4-43). Nothing is wired: no RPC method reaches this module.
//!
//! **The ticket of D120 §11.2.** While the decision was made in the TypeScript core and the execution in this process, a
//! MAC ticket had to carry the decision across. This gate makes the decision itself, so the value that crosses from
//! decision to execution is an in-process one and the type system carries it (§11.2, last bullet). The lifetime of the
//! ticket (30 s) is kept as the lifetime of an [`ApprovedAction`].
//!
//! # The compile-time proofs
//!
//! Each `compile_fail` block names the error it must fail with, and is followed by the same code without the offending
//! part, which compiles: the failure is the intended one and not a typing mistake in the example. (rustdoc compares the
//! error code on a nightly toolchain only; the K10a entry of the ledger records a run that did.)
//!
//! An executor cannot be called with an action the gate has not verified:
//!
//! ```compile_fail,E0308
//! use plur1bus_tools::gate::{Caller, Executor, UnverifiedAction};
//! fn run<E: Executor>(e: &mut E, a: UnverifiedAction, who: &Caller) {
//!     let _ = e.execute(a, who);
//! }
//! ```
//! ```
//! use plur1bus_tools::gate::{ApprovedAction, Caller, Executor};
//! fn run<E: Executor>(e: &mut E, a: ApprovedAction, who: &Caller) {
//!     let _ = e.execute(a, who);
//! }
//! ```
//!
//! An `ApprovedAction` cannot be written down outside the gate, and one that exists cannot be altered (its fields are
//! private). rustc reports the struct literal without an error code ("cannot construct `ApprovedAction` with struct
//! literal syntax due to private fields"), so that block names none; the write to a field has one:
//!
//! ```compile_fail
//! use plur1bus_tools::gate::ApprovedAction;
//! fn forge() -> ApprovedAction {
//!     ApprovedAction { tool: String::from("exec.run") }
//! }
//! ```
//! ```compile_fail,E0616
//! use plur1bus_tools::gate::ApprovedAction;
//! fn stretch(a: &mut ApprovedAction) {
//!     a.expires_at = f64::INFINITY;
//! }
//! ```
//! ```
//! use plur1bus_tools::gate::ApprovedAction;
//! fn read(a: &ApprovedAction) -> f64 {
//!     a.expires_at()
//! }
//! ```
//!
//! Nor conjured, copied, read from bytes or converted from the unverified action:
//!
//! ```compile_fail,E0277
//! use plur1bus_tools::gate::ApprovedAction;
//! fn needs<T: Default>() {}
//! needs::<ApprovedAction>();
//! ```
//! ```compile_fail,E0277
//! use plur1bus_tools::gate::ApprovedAction;
//! fn needs<T: Clone>() {}
//! needs::<ApprovedAction>();
//! ```
//! ```compile_fail,E0277
//! use plur1bus_tools::gate::ApprovedAction;
//! fn needs<T: serde::de::DeserializeOwned>() {}
//! needs::<ApprovedAction>();
//! ```
//! ```compile_fail,E0277
//! use plur1bus_tools::gate::{ApprovedAction, UnverifiedAction};
//! fn needs<T: From<UnverifiedAction>>() {}
//! needs::<ApprovedAction>();
//! ```
//! ```
//! // The same probes on the unverified action, which is plain data: the probes themselves are sound.
//! use plur1bus_tools::gate::UnverifiedAction;
//! fn needs<T: Default + Clone + serde::de::DeserializeOwned + From<UnverifiedAction>>() {}
//! needs::<UnverifiedAction>();
//! ```
//!
//! It is used once: redeeming it moves it.
//!
//! ```compile_fail,E0382
//! use plur1bus_tools::gate::{ApprovedAction, Live};
//! use plur1bus_core::policy::decide::Clock;
//! fn twice(a: ApprovedAction, live: &Live<'_>, clock: &dyn Clock) {
//!     let _ = a.redeem(live, clock);
//!     let _ = a.redeem(live, clock);
//! }
//! ```
//! ```
//! use plur1bus_tools::gate::{ApprovedAction, Live};
//! use plur1bus_core::policy::decide::Clock;
//! fn once(a: ApprovedAction, live: &Live<'_>, clock: &dyn Clock) {
//!     let _ = a.redeem(live, clock);
//! }
//! ```
//!
//! And the receipt an executor works under cannot be made without redeeming (again a literal, so no error code):
//!
//! ```compile_fail
//! use plur1bus_tools::gate::Receipt;
//! fn forge() -> Receipt {
//!     Receipt { action_hash: String::new() }
//! }
//! ```
use plur1bus_core::approvals::service::{Answer, Ask};
use plur1bus_core::approvals::AuditPort;
use plur1bus_core::policy::decide::{decide, Clock, Decision, GrantSource, Via};
use plur1bus_core::policy::headless::headless_gate;
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub mod doubles;
#[cfg(test)]
mod tests;

/// How long an [`ApprovedAction`] may wait for its execution, in milliseconds (the lifetime D120 §11.2 gives a ticket).
pub const APPROVAL_TTL_MS: f64 = 30_000.0;

/// A tool call as it arrives: nothing in it has been checked. Plain data; it can be deserialised, copied and compared.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnverifiedAction {
    /// The tool's name.
    pub tool: String,
    /// The arguments as the model gave them.
    pub args: Value,
    /// The call id.
    pub call_id: String,
    /// The model's own why (unverified; shown with an approval request after redaction).
    #[serde(default)]
    pub reason: Option<String>,
    /// A diff the model supplied with the request (unverified).
    #[serde(default)]
    pub diff: Option<String>,
}

/// Who is calling: built by the dispatcher from the authenticated turn, never from tool arguments.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Caller {
    /// The person on whose behalf the call runs.
    pub principal: String,
    /// The agent.
    pub agent_id: String,
    /// The trust of the surface the call comes from (D109 §5), 0 to 3.
    pub surface: u8,
    /// The session.
    pub session_id: Option<String>,
    /// The task.
    pub task_id: Option<String>,
    /// The turn (default: the call id).
    pub turn_id: Option<String>,
    /// Further members of the policy context, as the dispatcher's `policyContext` hook supplies them (`headless`,
    /// `overrides`, `deny`, `taint`, `projectId`, a `subject` other than the agent). They are merged over the base.
    pub policy: Map<String, Value>,
}

impl Caller {
    /// The policy context of a call by this caller (`#decide` of the dispatcher).
    pub fn context(&self) -> Value {
        let mut m = Map::new();
        m.insert("principal".into(), json!({ "person": self.principal }));
        m.insert(
            "subject".into(),
            json!({ "kind": "agent", "agentId": self.agent_id }),
        );
        m.insert("surface".into(), json!(self.surface));
        if let Some(s) = session_of(self) {
            m.insert("sessionId".into(), json!(s));
        }
        if let Some(t) = self.task_id.as_deref().filter(|t| !t.is_empty()) {
            m.insert("taskId".into(), json!(t));
        }
        for (k, v) in &self.policy {
            m.insert(k.clone(), v.clone());
        }
        Value::Object(m)
    }
}

/// What a tool knows about a call that the policy needs (`ToolClassification`): computed by the harness from the
/// arguments, with the path layer, never taken from the model.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Classification {
    /// `CallFlags` members the classifier sets (`outsideRoots`, `denyListHit`, `systemTree`, `sandboxed`, ...).
    pub flags: Map<String, Value>,
    /// The canonical targets.
    pub targets: Option<Vec<String>>,
    /// `read` or `write`.
    pub access: Option<&'static str>,
    /// Bound into the action hash without becoming a grant target (the environment fingerprint of `exec.run`).
    pub hash_extra: Option<String>,
}

/// The classifier of a tool. An error refuses the call (`classify-failed`): a call that cannot be classified never runs.
pub trait Classifier {
    /// The classification of a call with these arguments.
    fn classify(&self, args: &Value) -> Result<Classification, String>;
}

impl<F: Fn(&Value) -> Result<Classification, String>> Classifier for F {
    fn classify(&self, args: &Value) -> Result<Classification, String> {
        self(args)
    }
}

/// A tool as the registry declares it (trusted configuration, not a call).
pub struct GatedTool<'a> {
    /// The name.
    pub name: &'a str,
    /// The D109 capability.
    pub capability: &'a str,
    /// The effect class (`read`, `local-write`, ...).
    pub effect: &'a str,
    /// The risk class.
    pub risk: &'a str,
    /// The classifier; a tool without one counts as outside the roots (fail closed).
    pub classifier: Option<&'a dyn Classifier>,
}

/// The gate's view of the permission stores of K3 (R-K-2): grants, their use, and approvals. `plur1bus-core`'s
/// `ApprovalService` over `approvals.sqlite` is what the flip puts behind it; [`doubles::Permits`] is the double.
pub trait Permissions {
    /// Where `decide` reads grants.
    fn grants(&self) -> &dyn GrantSource;
    /// `grantUse.consumeOnce`: spend a one-time grant; `Ok(false)` when it was already used.
    fn consume_once(
        &mut self,
        audit: &mut dyn AuditPort,
        id: &str,
        person: &str,
        agent: &str,
        action_hash: &str,
    ) -> Result<bool, String>;
    /// `grantUse.markUsed`: record the use of a standing grant.
    fn mark_used(&mut self, audit: &mut dyn AuditPort, id: &str) -> Result<(), String>;
    /// `approvals.request`: the person's answer. It returns when there is one; anything but an approval is a refusal.
    fn request(&mut self, audit: &mut dyn AuditPort, ask: &Ask) -> Answer;
    /// `approvals.begin`: execution start of an approved answer, consuming the approval and its one-time grant.
    fn begin(&mut self, audit: &mut dyn AuditPort, answer: &Answer, ask: &Ask) -> bool;
}

/// Why the gate refused. The codes and messages are the dispatcher's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateError {
    /// No tool of that name.
    UnknownTool(String),
    /// The classifier failed.
    Unclassified(String),
    /// The policy refused (`reason`, `rule`).
    Denied {
        /// The reason class.
        reason: &'static str,
        /// The rule that fired.
        rule: &'static str,
    },
    /// The decision could not be recorded: nothing runs unrecorded.
    AuditUnavailable,
    /// A person did not approve, or the approval or grant could not be used.
    NotApproved {
        /// A sentence for the model.
        message: String,
        /// The request is parked and still open.
        parked: bool,
    },
}

impl GateError {
    /// The dispatcher's error code.
    pub fn code(&self) -> &'static str {
        match self {
            GateError::UnknownTool(_) => "tool-unknown",
            GateError::Unclassified(_) | GateError::Denied { .. } | GateError::AuditUnavailable => {
                "tool-denied"
            }
            GateError::NotApproved { .. } => "tool-not-approved",
        }
    }

    /// The dispatcher's message.
    pub fn message(&self) -> String {
        match self {
            GateError::UnknownTool(name) => {
                // `String(req.name).slice(0, 64)`: 64 UTF-16 units.
                let units: Vec<u16> = name.encode_utf16().take(64).collect();
                format!(
                    "no tool named {}",
                    plur1bus_core::js::json_stringify(&String::from_utf16_lossy(&units))
                )
            }
            GateError::Unclassified(m) => format!("the call could not be classified: {m}"),
            GateError::Denied { reason, rule } => format!("refused by policy ({reason}: {rule})"),
            GateError::AuditUnavailable => {
                "the audit trail is unavailable; nothing runs unrecorded".to_owned()
            }
            GateError::NotApproved { message, .. } => message.clone(),
        }
    }
}

impl std::fmt::Display for GateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for GateError {}

/// How a verified call came to be allowed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Allowed {
    /// The class of the capability.
    Default,
    /// A per-agent move to `allowed`.
    Override,
    /// A grant (its id).
    Grant(Option<String>),
    /// A person's approval (the request id).
    Approval(Option<String>),
}

impl Allowed {
    /// The spelling in an audit line (`default`, `override`, `grant`, `approval`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Allowed::Default => "default",
            Allowed::Override => "override",
            Allowed::Grant(_) => "grant",
            Allowed::Approval(_) => "approval",
        }
    }
}

/// The proof that the decision line was written. Only [`Gate::record`] makes one, and an [`ApprovedAction`] leaves the
/// gate only in exchange for one: no audit line, no approved action.
struct Recorded(());

/// A verified call: allowed by the policy, recorded, with the approval or grant it needed consumed. See the module
/// documentation for what the type guarantees. All fields are private; the accessors read them.
#[derive(Debug)]
pub struct ApprovedAction {
    tool: String,
    capability: String,
    args: Value,
    targets: Vec<String>,
    access: Option<&'static str>,
    hash_extra: Option<String>,
    flags: Map<String, Value>,
    action_hash: String,
    principal: String,
    agent_id: String,
    session_id: Option<String>,
    call_id: String,
    allowed: Allowed,
    expires_at: f64,
}

/// What an executor is about to do, computed by the executor at execution time from the arguments it will really use.
#[derive(Clone, Copy, Debug)]
pub struct Live<'a> {
    /// The tool the executor implements.
    pub tool: &'a str,
    /// The arguments it runs.
    pub args: &'a Value,
    /// The canonical targets it acts on, resolved again now.
    pub targets: &'a [String],
    /// The hash extra of what it runs (the environment fingerprint of `exec.run`), computed again now.
    pub hash_extra: Option<&'a str>,
    /// The caller it runs for.
    pub caller: &'a Caller,
}

/// Which part of the binding did not hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindingError {
    /// Another tool.
    Tool,
    /// Another person.
    Principal,
    /// Another agent.
    Agent,
    /// Another session.
    Session,
    /// Other targets than the ones that were judged.
    Targets,
    /// Another hash extra (for `exec.run`: another environment).
    HashExtra,
    /// Other arguments: the action hash over what would run is not the hash that was approved.
    ActionHash,
    /// Too late.
    Expired,
}

impl BindingError {
    /// A word for an audit line or a refusal.
    pub fn as_str(self) -> &'static str {
        match self {
            BindingError::Tool => "tool",
            BindingError::Principal => "principal",
            BindingError::Agent => "agent",
            BindingError::Session => "session",
            BindingError::Targets => "targets",
            BindingError::HashExtra => "hash-extra",
            BindingError::ActionHash => "action-hash",
            BindingError::Expired => "expired",
        }
    }
}

impl std::fmt::Display for BindingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the approved action is not this action ({})",
            self.as_str()
        )
    }
}

impl std::error::Error for BindingError {}

/// What is left of a redeemed [`ApprovedAction`]: the right to perform that one action now, and what its audit lines
/// say about how it was allowed. Private fields; made only by [`ApprovedAction::redeem`].
#[derive(Debug)]
pub struct Receipt {
    action_hash: String,
    call_id: String,
    allowed: Allowed,
    flags: Map<String, Value>,
}

impl Receipt {
    /// The action hash the decision, the approval and the audit lines carry.
    pub fn action_hash(&self) -> &str {
        &self.action_hash
    }
    /// The call id.
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    /// How the call was allowed.
    pub fn allowed(&self) -> &Allowed {
        &self.allowed
    }
    /// A flag of the classification the decision was made on (a member that is not `true` is false).
    pub fn flag(&self, name: &str) -> bool {
        self.flags.get(name) == Some(&Value::Bool(true))
    }
}

impl ApprovedAction {
    /// The tool.
    pub fn tool(&self) -> &str {
        &self.tool
    }
    /// The capability the decision was made for.
    pub fn capability(&self) -> &str {
        &self.capability
    }
    /// The arguments that were verified. An executor runs these, not a second copy from elsewhere.
    pub fn args(&self) -> &Value {
        &self.args
    }
    /// The canonical targets the policy judged.
    pub fn targets(&self) -> &[String] {
        &self.targets
    }
    /// `read` or `write`.
    pub fn access(&self) -> Option<&'static str> {
        self.access
    }
    /// The hash extra bound into the action hash.
    pub fn hash_extra(&self) -> Option<&str> {
        self.hash_extra.as_deref()
    }
    /// A flag of the classification (a member that is not `true` is false).
    pub fn flag(&self, name: &str) -> bool {
        self.flags.get(name) == Some(&Value::Bool(true))
    }
    /// The action hash.
    pub fn action_hash(&self) -> &str {
        &self.action_hash
    }
    /// The person it was verified for.
    pub fn principal(&self) -> &str {
        &self.principal
    }
    /// The agent it was verified for.
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
    /// The session it was verified in.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }
    /// The call id.
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    /// How it was allowed.
    pub fn allowed(&self) -> &Allowed {
        &self.allowed
    }
    /// The instant after which it is refused (milliseconds since the epoch).
    pub fn expires_at(&self) -> f64 {
        self.expires_at
    }

    /// Use the approval for the one execution it was given for. `live` is what the executor is about to do; every part of
    /// the binding must hold: the tool, the caller (person, agent, session), the targets and the hash extra as they are
    /// now, the action hash recomputed over the live arguments, and the lifetime. The approval is consumed either way.
    pub fn redeem(self, live: &Live<'_>, clock: &dyn Clock) -> Result<Receipt, BindingError> {
        if live.tool != self.tool {
            return Err(BindingError::Tool);
        }
        if live.caller.principal != self.principal {
            return Err(BindingError::Principal);
        }
        if live.caller.agent_id != self.agent_id {
            return Err(BindingError::Agent);
        }
        if session_of(live.caller) != self.session_id.as_deref() {
            return Err(BindingError::Session);
        }
        if live.targets != self.targets.as_slice() {
            return Err(BindingError::Targets);
        }
        let live_extra = live.hash_extra.filter(|x| !x.is_empty());
        if live_extra != self.hash_extra.as_deref() {
            return Err(BindingError::HashExtra);
        }
        let now_hash = plur1bus_canon::action_hash(
            &self.capability,
            live.tool,
            live.args,
            live.targets,
            live_extra,
        );
        if now_hash != self.action_hash {
            return Err(BindingError::ActionHash);
        }
        // Not `now > expires`: a clock that answers NaN refuses.
        let in_time = clock.now() <= self.expires_at;
        if !in_time {
            return Err(BindingError::Expired);
        }
        Ok(Receipt {
            action_hash: self.action_hash,
            call_id: self.call_id,
            allowed: self.allowed,
            flags: self.flags,
        })
    }
}

fn session_of(c: &Caller) -> Option<&str> {
    c.session_id.as_deref().filter(|s| !s.is_empty())
}

/// An executor: the code that performs a tool's effect. It can only be handed a verified action, and it takes it by
/// value. It must redeem the action against what it actually does before it does it.
pub trait Executor {
    /// What a call yields.
    type Output;
    /// Perform the approved action for `who`.
    fn execute(&mut self, approved: ApprovedAction, who: &Caller) -> Self::Output;
}

/// The gate. It borrows its ports for one or more verifications; it holds no state of its own.
pub struct Gate<'a> {
    tools: &'a [GatedTool<'a>],
    clock: &'a dyn Clock,
    audit: &'a mut dyn AuditPort,
    permissions: &'a mut dyn Permissions,
}

impl<'a> Gate<'a> {
    /// A gate over these tools and ports. `audit` is the policy audit (`policy::audit::PolicyAudit` in production): a
    /// decision that cannot be recorded there refuses the call.
    pub fn new(
        tools: &'a [GatedTool<'a>],
        clock: &'a dyn Clock,
        audit: &'a mut dyn AuditPort,
        permissions: &'a mut dyn Permissions,
    ) -> Self {
        Gate {
            tools,
            clock,
            audit,
            permissions,
        }
    }

    fn soft(&mut self, action: &str, fields: &Value) {
        // The refusal stands whether or not its line could be written.
        let _ = self.audit.record(action, fields);
    }

    /// The decision line, hard: `Err` when it could not be written.
    fn record(&mut self, fields: &Value) -> Result<Recorded, GateError> {
        // A gate without an audit trail does not run anything: "not configured" is not "recorded".
        if !self.audit.present() {
            return Err(GateError::AuditUnavailable);
        }
        match self.audit.record("policy.decision", fields) {
            Ok(()) => Ok(Recorded(())),
            Err(_) => Err(GateError::AuditUnavailable),
        }
    }

    /// The one place an [`ApprovedAction`] leaves the gate: in exchange for the proof of its decision line, with its
    /// lifetime stamped.
    // By value on purpose: the proof is spent on the one action it was written for.
    #[allow(clippy::needless_pass_by_value)]
    fn mint(&self, _recorded: Recorded, mut action: ApprovedAction) -> ApprovedAction {
        action.expires_at = self.clock.now() + APPROVAL_TTL_MS;
        action
    }

    /// Verify one call of `who`: classify it, decide it, record the decision, obtain and consume the approval or the grant
    /// it needs. `Ok` is the only way an [`ApprovedAction`] comes to exist.
    pub fn verify(
        &mut self,
        action: UnverifiedAction,
        who: &Caller,
    ) -> Result<ApprovedAction, GateError> {
        let started = self.clock.now();
        let Some(tool) = self.tools.iter().find(|t| t.name == action.tool) else {
            return Err(GateError::UnknownTool(action.tool));
        };
        let context = who.context();
        let who_fields = who_fields(who, &context);

        // Classification: by the tool's own trusted classifier; a failure refuses.
        let classified = match tool.classifier.map(|c| c.classify(&action.args)) {
            None => None,
            Some(Ok(c)) => Some(c),
            Some(Err(message)) => {
                let mut f = who_fields;
                put(&mut f, "tool", json!(tool.name));
                put(&mut f, "capability", json!(tool.capability));
                put(&mut f, "outcome", json!("never"));
                put(&mut f, "rule", json!("classify-failed"));
                self.soft("policy.decision", &Value::Object(f));
                return Err(GateError::Unclassified(message));
            }
        };
        // Absent an explicit classification the call counts as outside the roots.
        let mut flags = Map::new();
        flags.insert("outsideRoots".into(), json!(true));
        flags.insert("denyListHit".into(), json!(false));
        let (targets, access, hash_extra) = match classified {
            Some(c) => {
                for (k, v) in c.flags {
                    flags.insert(k, v);
                }
                (c.targets, c.access, c.hash_extra.filter(|x| !x.is_empty()))
            }
            None => (None, None, None),
        };
        let hash_targets = targets.clone().unwrap_or_default();
        let action_hash = plur1bus_canon::action_hash(
            tool.capability,
            tool.name,
            &action.args,
            &hash_targets,
            hash_extra.as_deref(),
        );
        let mut call = Map::new();
        call.insert("capability".into(), json!(tool.capability));
        call.insert("tool".into(), json!(tool.name));
        call.insert("effect".into(), json!(tool.effect));
        call.insert("flags".into(), Value::Object(flags.clone()));
        if let Some(t) = &targets {
            call.insert("targets".into(), json!(t));
        }
        if let Some(a) = access {
            call.insert("access".into(), json!(a));
        }
        call.insert("actionHash".into(), json!(action_hash));
        let call = Value::Object(call);

        // The decision; a headless ask is a refusal, never a wait (D5).
        let decision = headless_gate(
            decide(&call, &context, self.permissions.grants(), self.clock),
            &context,
        );

        let mut base = who_fields;
        put(&mut base, "tool", json!(tool.name));
        put(&mut base, "capability", json!(tool.capability));
        put(&mut base, "effect", json!(tool.effect));
        put(&mut base, "risk", json!(tool.risk));
        put(&mut base, "actionHash", json!(action_hash));
        put(&mut base, "surface", json!(who.surface));
        if let Some(t) = &targets {
            put(&mut base, "targets", json!(t));
        }
        put(&mut base, "flags", Value::Object(flags.clone()));
        let args_bytes = plur1bus_canon::canonical_json(&action.args).len();
        put(&mut base, "argsBytes", json!(args_bytes));
        let mut fields = base.clone();
        match &decision {
            Decision::Allow { via, grant_id, .. } => {
                put(&mut fields, "outcome", json!("allowed"));
                put(&mut fields, "via", json!(via_str(*via)));
                if let Some(g) = grant_id {
                    put(&mut fields, "grantId", json!(g));
                }
            }
            Decision::Ask { why, .. } => {
                put(&mut fields, "outcome", json!("approval"));
                put(&mut fields, "via", json!("ask"));
                put(&mut fields, "rule", json!(why));
            }
            Decision::Deny { reason, rule } => {
                put(&mut fields, "outcome", json!("never"));
                put(&mut fields, "rule", json!(rule));
                put(&mut fields, "reason", json!(reason.as_str()));
            }
        }
        let fields = Value::Object(fields);
        if let Decision::Deny { reason, rule } = &decision {
            self.soft("policy.decision", &fields);
            return Err(GateError::Denied {
                reason: reason.as_str(),
                rule,
            });
        }
        // The audit line before anything else happens: before a person is asked, before a grant is spent, and long
        // before the effect. Without it there is no `Recorded`, and without that no approved action.
        let recorded = self.record(&fields)?;

        let allowed = match decision {
            // Returned above; repeated so that no path of this match can turn a refusal into an action.
            Decision::Deny { reason, rule } => {
                return Err(GateError::Denied {
                    reason: reason.as_str(),
                    rule,
                })
            }
            Decision::Ask { request, park, .. } => {
                let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
                let ask = Ask {
                    request,
                    call_id: action.call_id.clone(),
                    tool: tool.name.to_owned(),
                    args: action.args.clone(),
                    agent_id: who.agent_id.clone(),
                    principal: who.principal.clone(),
                    session_id: session_of(who).map(str::to_owned),
                    park,
                    aborted: false,
                    subject_kind: text(&context["subject"]["kind"]),
                    turn_id: Some(
                        who.turn_id
                            .clone()
                            .unwrap_or_else(|| action.call_id.clone()),
                    ),
                    task_id: text(&context["taskId"]),
                    project_id: text(&context["projectId"]),
                    targets: targets
                        .as_ref()
                        .map(|t| t.iter().map(|x| json!(x)).collect()),
                    access: access.map(str::to_owned),
                    reason: action.reason.clone(),
                    diff: action.diff.clone(),
                    recurring: None,
                    public_peer_trust: None,
                };
                let answer = self.permissions.request(self.audit, &ask);
                // Only a literal approval counts.
                if !answer.approved {
                    let message = match answer.reason.as_deref() {
                        Some(r) => format!("not approved: {r}"),
                        None => "not approved".to_owned(),
                    };
                    self.outcome(&base, started);
                    return Err(GateError::NotApproved {
                        message,
                        parked: answer.parked,
                    });
                }
                // Execution start: the approval and its one-time grant are consumed atomically, single use.
                if !self.permissions.begin(self.audit, &answer, &ask) {
                    self.outcome(&base, started);
                    return Err(GateError::NotApproved {
                        message: "not approved: the approval could not be used (already used, expired or bound to another action)".to_owned(),
                        parked: false,
                    });
                }
                Allowed::Approval(answer.request_id)
            }
            Decision::Allow {
                via: Via::Grant,
                grant_id: Some(id),
                ..
            } => {
                if let Some(refusal) = self.use_grant(&id) {
                    self.outcome(&base, started);
                    return Err(GateError::NotApproved {
                        message: refusal.to_owned(),
                        parked: false,
                    });
                }
                Allowed::Grant(Some(id))
            }
            Decision::Allow { via, .. } => match via {
                Via::Default => Allowed::Default,
                Via::Override => Allowed::Override,
                Via::Grant => Allowed::Grant(None),
            },
        };

        let approved = ApprovedAction {
            tool: tool.name.to_owned(),
            capability: tool.capability.to_owned(),
            args: action.args,
            targets: hash_targets,
            access,
            hash_extra,
            flags,
            action_hash,
            principal: who.principal.clone(),
            agent_id: who.agent_id.clone(),
            session_id: session_of(who).map(str::to_owned),
            call_id: action.call_id,
            allowed,
            expires_at: f64::NEG_INFINITY,
        };
        Ok(self.mint(recorded, approved))
    }

    /// Start of a call a grant allowed (`#useGrant`): a `once` grant is consumed atomically, a standing grant records
    /// its use. A refusal text, or `None`.
    fn use_grant(&mut self, id: &str) -> Option<&'static str> {
        let Some(g) = self.permissions.grants().get(id) else {
            return Some("the grant that allowed this call no longer exists");
        };
        let text = |k: &str| g.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let failed = "the use of the grant could not be recorded, so the call does not run";
        if g.get("scope").and_then(Value::as_str) == Some("once") {
            match self.permissions.consume_once(
                self.audit,
                id,
                &text("person"),
                &text("agent"),
                &text("actionHash"),
            ) {
                Ok(true) => None,
                Ok(false) => Some("the one-time grant was already used"),
                Err(_) => Some(failed),
            }
        } else {
            match self.permissions.mark_used(self.audit, id) {
                Ok(()) => None,
                Err(_) => Some(failed),
            }
        }
    }

    /// The outcome line of a call the gate itself refused after its decision was recorded (best effort).
    fn outcome(&mut self, base: &Map<String, Value>, started: f64) {
        let mut f = base.clone();
        put(&mut f, "outcome", json!("refused"));
        let elapsed = (self.clock.now() - started).max(0.0);
        put(&mut f, "durationMs", json!(elapsed));
        put(&mut f, "resultBytes", json!(0));
        put(&mut f, "resultCode", json!("tool-not-approved"));
        self.soft("policy.outcome", &Value::Object(f));
    }
}

fn put(m: &mut Map<String, Value>, k: &str, v: Value) {
    m.insert(k.to_owned(), v);
}

fn via_str(v: Via) -> &'static str {
    match v {
        Via::Default => "default",
        Via::Override => "override",
        Via::Grant => "grant",
    }
}

/// `#who`: who the decision is about.
fn who_fields(who: &Caller, context: &Value) -> Map<String, Value> {
    let mut f = Map::new();
    put(&mut f, "person", json!(who.principal));
    put(&mut f, "agentId", json!(who.agent_id));
    let kind = context["subject"]["kind"].as_str().unwrap_or("agent");
    put(&mut f, "subjectKind", json!(kind));
    if let Some(s) = session_of(who) {
        put(&mut f, "sessionId", json!(s));
    }
    if let Some(t) = context["taskId"].as_str().filter(|t| !t.is_empty()) {
        put(&mut f, "taskId", json!(t));
    }
    if let Some(j) = context["headless"]["jobId"].as_str() {
        put(&mut f, "jobId", json!(j));
    }
    f
}
