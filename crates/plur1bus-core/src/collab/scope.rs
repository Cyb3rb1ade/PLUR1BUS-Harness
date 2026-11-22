//! `collab/scope.ts`: the collaboration adapter for the process-wide `AgentScope` (ADR-003). A consult or delegation fails
//! closed without a scope: unscoped access is refused, never defaulted. The scope is passed explicitly here (TypeScript reads
//! it from `AsyncLocalStorage`); the flip decides how a run carries it.
use super::errors::{CollabError, CollabErrorCode};
use super::limits::{CallClass, DelegationWorkBudget};

/// The trusted path and work allocation of a delegated run, installed only by the collaboration service.
#[derive(Clone, Debug)]
pub struct DelegationScope {
    /// The trace.
    pub trace_id: String,
    /// The span of this run.
    pub span_id: String,
    /// The agents on the path.
    pub path: Vec<String>,
    /// The class of the call.
    pub call_class: CallClass,
    /// The work allocation shared by acceptance, work, retries and return repair.
    pub work_budget: DelegationWorkBudget,
}

/// `AgentScopeValue`.
#[derive(Clone, Debug)]
pub struct AgentScopeValue {
    /// The agent.
    pub agent_id: String,
    /// The project; a scope without one is not a collaboration scope.
    pub project_id: String,
    /// `agent:<id>`.
    pub secret_scope: String,
    /// `agents/<id>`.
    pub workdir: String,
    /// `agent:<id>`.
    pub budget_ledger: String,
    /// The tools the agent may use; empty means none.
    pub tool_view: Vec<String>,
    /// The delegation this run belongs to.
    pub delegation: Option<DelegationScope>,
}

/// `scopeFor(agentId, projectId)`: the narrowest scope of an agent in a project.
pub fn scope_for(agent_id: &str, project_id: &str) -> AgentScopeValue {
    AgentScopeValue {
        agent_id: agent_id.to_owned(),
        project_id: project_id.to_owned(),
        secret_scope: format!("agent:{agent_id}"),
        workdir: format!("agents/{agent_id}"),
        budget_ledger: format!("agent:{agent_id}"),
        tool_view: Vec::new(),
        delegation: None,
    }
}

/// `requireAgentScope()`: the current scope, or the `no-scope` refusal.
pub fn require_scope(current: Option<&AgentScopeValue>) -> Result<&AgentScopeValue, CollabError> {
    current.ok_or_else(|| {
        CollabError::new(
            CollabErrorCode::NoScope,
            "AgentScope is required; unscoped access is refused",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_is_derived_from_the_agent_and_never_defaulted() {
        let s = scope_for("worker", "prj_1");
        assert_eq!(s.secret_scope, "agent:worker");
        assert_eq!(s.workdir, "agents/worker");
        assert_eq!(s.budget_ledger, "agent:worker");
        assert!(
            s.tool_view.is_empty(),
            "no tools unless the trusted view grants them"
        );
        assert!(s.delegation.is_none());
        let refused = require_scope(None).unwrap_err();
        assert_eq!(refused.code, CollabErrorCode::NoScope);
        assert_eq!(
            refused.message,
            "AgentScope is required; unscoped access is refused"
        );
        assert_eq!(require_scope(Some(&s)).unwrap().agent_id, "worker");
    }
}
