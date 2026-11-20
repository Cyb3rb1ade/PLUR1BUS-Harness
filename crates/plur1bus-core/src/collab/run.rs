//! Ports and settings for a single admitted delegation.
use super::handoff::HandoffContext;
use super::limits::{DelegationWorkBudget, TaskClass};
use super::ports::{RunInput, RunOutput};
use super::scope::AgentScopeValue;
use super::service::{AdmitInput, WriterReservation};
use super::store::R;
use super::types::{DelegateTask, TargetKind};
use crate::logs::methods::AbortSignal;
use crate::rbac::audit::AuditSink;
use crate::rbac::types::Principal;
use crate::toolcall::json::V;
use std::sync::Arc;

/// Trusted request to start a delegate.
pub struct DelegateRequest<'a> {
    /// Identity, agents, content and trace of this call.
    pub admission: AdmitInput<'a>,
    /// Optional parent task in the trace.
    pub parent_task: Option<&'a str>,
    /// Selects the configured run limits.
    pub task_class: TaskClass,
    /// The validated sender contract, when supplied.
    pub contract: Option<V>,
    /// Trusted current tool view of the target.
    pub allowed_tools: &'a [String],
    /// The parent's allocation, when this is a nested delegation.
    pub parent_budget: Option<&'a DelegationWorkBudget>,
    /// An existing writer reservation issued by this service.
    pub writer: Option<WriterReservation>,
    /// Cancellation from the parent turn.
    pub cancel: Option<AbortSignal>,
    /// Audits admission before any worker starts.
    pub audit: &'a mut dyn AuditSink,
}

/// Handle authorizing completion of the exact admitted run.
pub struct DelegateHandle {
    /// The queued task in the result of delegate.
    pub queued: DelegateTask,
    pub(super) id: String,
    pub(super) key: Arc<()>,
    pub(super) cancel: AbortSignal,
}

impl DelegateHandle {
    /// Allows a worker or caller to request cancellation without owning the service.
    pub fn cancellation(&self) -> AbortSignal {
        self.cancel.clone()
    }
}

#[derive(Clone)]
pub(super) struct PendingRun {
    pub transcript: Option<super::replay::RecordedTurn>,
    pub key: Arc<()>,
    pub task: DelegateTask,
    pub principal: Principal,
    pub sender_task: Option<String>,
    pub input: RunInput,
    pub contract: Option<V>,
    pub scope: AgentScopeValue,
    pub cancel: AbortSignal,
    pub writer: Option<WriterReservation>,
    pub parent_cancel: Option<AbortSignal>,
    pub deadline: i64,
    pub stall_ms: i64,
    pub progress_at: i64,
    pub progress: Option<RunOutput>,
    pub rounds: i64,
    pub return_tokens: i64,
    pub budget: DelegationWorkBudget,
    pub phase: RunPhase,
    pub kind: Option<TargetKind>,
    pub a2a: bool,
}

impl PendingRun {
    pub fn cancelled(&self) -> bool {
        self.cancel.is_aborted()
            || self
                .parent_cancel
                .as_ref()
                .is_some_and(AbortSignal::is_aborted)
    }

    pub fn timed_out(&self, now: i64) -> bool {
        now >= self.deadline
            || (self.phase != RunPhase::Queued
                && now >= self.progress_at.saturating_add(self.stall_ms))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RunPhase {
    Queued,
    Acknowledging,
    Running,
}

#[derive(Clone, Copy)]
pub(super) struct Drain {
    pub deadline: i64,
    pub budget_ms: i64,
}

/// A resolved worker start with inherited limits.
pub struct TargetRequest<'a> {
    /// Content and target identity.
    pub input: &'a RunInput,
    /// Local project session holding the turn, if recording is enabled.
    pub session_id: Option<&'a str>,
    /// Scoping for a local target.
    pub scope: Option<&'a AgentScopeValue>,
    /// The original sender contract.
    pub contract: Option<&'a V>,
    /// Cancellation signalled by the collaboration service.
    pub cancel: &'a AbortSignal,
    /// Maximum work rounds.
    pub max_rounds: i64,
    /// Shared work budget for ack, work and report repair.
    pub budget: &'a DelegationWorkBudget,
    /// Project return ceiling in estimated tokens.
    pub return_tokens: i64,
}

/// Adapter selected for a delegate. An admitted run may outlive the port call.
pub trait DelegationTarget {
    /// Class of this registration.
    fn kind(&self) -> TargetKind;
    /// A legacy remote registration can also carry A2A origin.
    fn origin_a2a(&self) -> bool {
        false
    }
    /// Whether this adapter serves the agent.
    fn accepts(&self, agent_id: &str) -> bool;
    /// Receiver's explicit reply to the contract.
    fn acknowledge(&self, request: &TargetRequest<'_>) -> R<V>;
    /// Begin the actual turn, or return its outcome immediately.
    fn start(&self, request: &TargetRequest<'_>) -> R<Option<RunOutput>>;
}

/// Trusted dispatcher inputs when authorizing a receiver.
pub struct TargetContext<'a, 'ports> {
    /// Live sender authority used at receiver acceptance.
    pub handoff: Option<&'a mut HandoffContext<'ports>>,
    /// Trusted intent to review local work.
    pub independent_review: bool,
    /// Whether the target would receive a local checkout.
    pub local_checkout: bool,
    /// Trusted notification of acceptance, before the work turn begins.
    pub on_accepted: Option<&'a mut dyn FnMut() -> R<()>>,
}
