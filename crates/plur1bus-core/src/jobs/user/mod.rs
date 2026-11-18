//! `packages/core/src/user-jobs/{index,rpc}.ts` (P4-K K7a): the recurring jobs a person defines for an agent. A job keeps an
//! identity reference (`runAs`), never an authority snapshot; each due slot is claimed in one SQLite transaction before any turn
//! can start; the rights are decided by `rbac::authorize` and never around it. See [`super`] for the rule in full.
//!
//! The service works on [`J`] (JSON with its member order, the `JSON.parse`/`JSON.stringify` of JavaScript) for the job and the
//! run record, because TypeScript stores `JSON.stringify` of an object it checks member by member (`typeof`, `Object.keys`) and
//! the file must come out the way TypeScript writes it. `rpc.ts` is not ported: it is the RPC wiring (principal resolution and
//! method routing), which the flip does.
pub mod service;
pub mod store;

#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use service::UserJobs;

use super::JobsError;
use crate::approvals::js_json::J;
use crate::budget::{Clock, IdSource};
use crate::rbac::audit::AuditSink;
use crate::rbac::types::Principal;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `UserJobOutcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserJobOutcome {
    /// `completed`
    Completed,
    /// `failed`
    Failed,
    /// `abandoned`
    Abandoned,
    /// `skipped_owner_inactive`
    SkippedOwnerInactive,
    /// `skipped_no_rights`
    SkippedNoRights,
    /// `skipped_agent_missing`
    SkippedAgentMissing,
    /// `skipped_agent_inactive`
    SkippedAgentInactive,
    /// `skipped_budget`
    SkippedBudget,
    /// `approval_timeout`
    ApprovalTimeout,
}

impl UserJobOutcome {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Abandoned => "abandoned",
            Self::SkippedOwnerInactive => "skipped_owner_inactive",
            Self::SkippedNoRights => "skipped_no_rights",
            Self::SkippedAgentMissing => "skipped_agent_missing",
            Self::SkippedAgentInactive => "skipped_agent_inactive",
            Self::SkippedBudget => "skipped_budget",
            Self::ApprovalTimeout => "approval_timeout",
        }
    }

    /// The outcome named exactly `s`.
    pub fn parse(s: &str) -> Option<Self> {
        [
            Self::Completed,
            Self::Failed,
            Self::Abandoned,
            Self::SkippedOwnerInactive,
            Self::SkippedNoRights,
            Self::SkippedAgentMissing,
            Self::SkippedAgentInactive,
            Self::SkippedBudget,
            Self::ApprovalTimeout,
        ]
        .into_iter()
        .find(|o| o.as_str() == s)
    }
}

/// `validateDelivery(id, person, agentId)`: throws (an `Err`) when the destination may not receive this job's result.
pub type ValidateDelivery = Box<dyn Fn(&str, &str, &str) -> Result<(), JobsError>>;
/// `submitTurn(job, person)`: the turn itself, which is not part of this package. An `Err` is a failed run.
pub type SubmitTurn = Box<dyn Fn(&J, &Principal) -> Result<UserJobOutcome, JobsError>>;
/// `displayName(id)`: `Ok(None)` is `undefined`, an `Err` is a throw (both fall back to the id).
pub type DisplayName = Box<dyn Fn(&str) -> Result<Option<String>, JobsError>>;
/// The platform's owner-only hook (`createPlatformCapabilities().securePath(path, { mode: 0o600 })`); its answer is not
/// looked at, as in TypeScript.
pub type SecurePath = Box<dyn Fn(&Path)>;

/// `UserJobsOptions`.
pub struct UserJobsOptions {
    /// The database file.
    pub path: PathBuf,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// `randomUUID()`: job and run ids.
    pub ids: Arc<dyn IdSource>,
    /// The audit sink; a change that cannot be recorded is not made (`E_STORAGE`).
    pub audit: Box<dyn AuditSink>,
    /// `agentExists(id)`.
    pub agent_exists: Box<dyn Fn(&str) -> bool>,
    /// `agents()`: the agent ids offered to `targets`; absent is none.
    pub agents: Option<Box<dyn Fn() -> Vec<String>>>,
    /// `resolve(personId)`: the person as they are now, `None` when they no longer exist.
    pub resolve: Box<dyn Fn(&str) -> Option<Principal>>,
    /// `displayName`.
    pub display_name: Option<DisplayName>,
    /// `budgetBlocked(agentId)`.
    pub budget_blocked: Box<dyn Fn(&str) -> bool>,
    /// `notify(run)`: a run that switched its job off; a throw is ignored.
    pub notify: Box<dyn Fn(&J) -> Result<(), JobsError>>,
    /// `onRecorded(run)`: a throw is ignored.
    pub on_recorded: Option<Box<dyn Fn(&J) -> Result<(), JobsError>>>,
    /// `submitTurn`.
    pub submit_turn: SubmitTurn,
    /// `validateDelivery`; without one a job with a delivery target is refused.
    pub validate_delivery: Option<ValidateDelivery>,
    /// `isStopping()`.
    pub is_stopping: Option<Box<dyn Fn() -> bool>>,
    /// The owner-only hook; `None` applies mode 0600 on Unix.
    pub secure_path: Option<SecurePath>,
}
