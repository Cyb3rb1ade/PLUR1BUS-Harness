//! F13 native job authority. Only a trusted host can attest the owner of a scheduled job.
use crate::{
    context::{RequestContext, RouteVocabulary},
    contract::{AgentContext, AgentId, EngineError, HostServices, JobName, Principal},
};

/// Fixed refusal for jobs over private owner or workspace rows without a bound authority.
pub const AUTHORITY_UNBOUND: &str = "job-authority-unbound";
/// Fixed refusal for LLM job bodies, which RX does not port (RE-06 T2–T7).
pub const LLM_UNPORTED: &str = "not-implemented";

/// What a catalog job's full body reads or writes, independent of any installed owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobScope {
    /// Private owner or workspace rows (memories, Neo, reminders, proposals, knowledge).
    OwnerData,
    /// An LLM body over owner data (RE-06 T2–T7).
    Llm,
}

/// An owner identity attested by the host for one native job and agent.
///
/// This type is deliberately absent from the wire and the persisted job ledger. Its
/// constructor belongs at the host's admission boundary, after checking the standing
/// job grant and the person's current access. It must not be called with input from a
/// job's trigger, payload, or the rows it reads.
pub struct JobAuthority {
    job: JobName,
    principal: Principal,
    agent: AgentContext,
    request: RequestContext,
}

impl std::fmt::Debug for JobAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("JobAuthority")
            .field("job", &self.job)
            .finish_non_exhaustive()
    }
}

impl JobAuthority {
    /// Bind an explicitly authorized host principal to the selected job and agent.
    /// The engine independently rejects an inferred/ownerless context, a mismatched
    /// agent and a conflicting workspace claim.
    pub fn from_host(
        host: &dyn HostServices,
        job: JobName,
        selected: &AgentId,
        principal: Principal,
        agent: AgentContext,
        vocabulary: &RouteVocabulary,
    ) -> Result<Self, EngineError> {
        if &principal.agent_id != selected || !agent.background {
            return Err(unbound());
        }
        let request = RequestContext::build_for_job(&principal, &agent, host, vocabulary)?;
        if &request.agent_id != selected
            || request.trust() != "proved"
            || request.owner_user_id.is_empty()
            || request.workspace_key.is_empty()
        {
            return Err(unbound());
        }
        Ok(Self {
            job,
            principal,
            agent,
            request,
        })
    }

    /// The authenticated subject for existing ACL-aware readers.
    #[must_use]
    pub fn request(&self) -> &RequestContext {
        &self.request
    }

    /// The original arguments for an engine API that rebinds the subject itself.
    #[must_use]
    pub fn caller(&self) -> (&Principal, &AgentContext) {
        (&self.principal, &self.agent)
    }

    pub(super) fn matches(&self, job: JobName, agent: &AgentId) -> bool {
        self.job == job && &self.request.agent_id == agent
    }
}

pub(super) fn unbound() -> EngineError {
    EngineError::NotAvailable {
        reason: AUTHORITY_UNBOUND.to_owned(),
    }
}

/// Every catalog job reads or writes private rows; LLM bodies are classified separately.
#[must_use]
pub fn scope(job: JobName) -> JobScope {
    if super::catalog()
        .iter()
        .any(|spec| spec.name == job && spec.needs_llm)
    {
        JobScope::Llm
    } else {
        JobScope::OwnerData
    }
}

/// The fixed refusal for a job without an installed body.
#[must_use]
pub fn refusal(job: JobName) -> &'static str {
    match scope(job) {
        JobScope::OwnerData => AUTHORITY_UNBOUND,
        JobScope::Llm => LLM_UNPORTED,
    }
}
