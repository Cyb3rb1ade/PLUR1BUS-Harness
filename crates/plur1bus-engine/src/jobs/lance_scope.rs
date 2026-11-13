//! Binding for unattended Lance work. Foreground memory authority is never inferred here.
use super::{
    authority::{self, JobAuthority},
    registry::JobReport,
};
use crate::{
    capture::shared_scope::{CapturePolicy, PolicyDecision},
    context::{RequestContext, RouteVocabulary},
    contract::{Cancel, EngineError, JobOutcome, MemoryScope},
    ops::{context::OperationContext, write::MutationStores},
    store::RowFilter,
};
use std::sync::Arc;

pub(crate) struct LanceScope {
    pub operations: Arc<OperationContext>,
    pub stores: Arc<dyn MutationStores>,
    pub policy: Arc<dyn CapturePolicy>,
}

impl LanceScope {
    pub fn check(
        &self,
        authority: &JobAuthority,
        cancel: &Cancel,
    ) -> Result<Option<JobReport>, EngineError> {
        cancel.check()?;
        self.operations.assert_open()?;
        let (principal, agent) = authority.caller();
        let current = RequestContext::build_for_job(
            principal,
            agent,
            self.operations.host(),
            RouteVocabulary::shared(),
        )?;
        if &current != authority.request() {
            return Err(authority::unbound());
        }
        let reason = match self.policy.decision(&current)? {
            PolicyDecision::Allowed => return Ok(None),
            PolicyDecision::Revoked => "workspace-policy-disabled",
            PolicyDecision::Maintenance => "workspace-maintenance",
        };
        Ok(Some(JobReport {
            outcome: JobOutcome::Skipped,
            reason: Some(reason.into()),
        }))
    }

    pub fn filter(authority: &JobAuthority) -> RowFilter {
        let request = authority.request();
        RowFilter {
            agent_id: Some(request.agent_id.to_string()),
            scope: Some(MemoryScope::AgentPrivate),
            workspace_id: Some(request.workspace_key.clone()),
            owner_user_id: Some(request.owner_user_id.clone()),
            memory_kind: Some("memory".into()),
            ..RowFilter::default()
        }
    }
}
