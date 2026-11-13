//! The scheduled `auto-accept-stale` job declassifies old unconfirmed criticals.
use super::{
    authority,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    capture::shared_scope::{CapturePolicy, PolicyDecision},
    context::{RequestContext, RouteVocabulary},
    contract::{Cancel, EngineError, JobName, JobOutcome, MemoryScope},
    ops::{context::OperationContext, write::MutationStores},
    recall::acl,
    store::RowFilter,
};
use std::sync::Arc;

const AGE_MS: i64 = 24 * 60 * 60 * 1000;

pub(crate) struct CriticalExpiry {
    pub operations: Arc<OperationContext>,
    pub stores: Arc<dyn MutationStores>,
    pub policy: Arc<dyn CapturePolicy>,
}

impl JobBody for CriticalExpiry {
    fn name(&self) -> JobName {
        JobName::AutoAcceptStale
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let request = authority.request();
        let operation = self.operations.enter(principal, agent)?;
        if operation.context != *request {
            return Err(authority::unbound());
        }
        if let Some(skip) = self.blocked(request)? {
            return Ok(skip);
        }
        let _mutation = self.operations.mutation()?;
        cancel.check()?;
        let Some(store) = self.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let scope = RowFilter {
            scope: Some(MemoryScope::AgentPrivate),
            status: Some("active".into()),
            workspace_id: Some(request.workspace_key.clone()),
            owner_user_id: Some(request.owner_user_id.clone()),
            memory_kind: Some("memory".into()),
            ..RowFilter::default()
        };
        let cutoff = context.now_ms.saturating_sub(AGE_MS);
        for row in store.stale_criticals(&scope, cutoff)? {
            cancel.check()?;
            if acl::allowed(&row, request).is_err() {
                continue;
            }
            self.operations.assert_open()?;
            let current = RequestContext::build_for_job(
                principal,
                agent,
                self.operations.host(),
                RouteVocabulary::shared(),
            )?;
            if current != *request {
                return Err(authority::unbound());
            }
            if let Some(skip) = self.blocked(request)? {
                return Ok(skip);
            }
            store.expire_critical(&scope, cutoff, &row)?;
        }
        Ok(JobReport::completed())
    }
}

impl CriticalExpiry {
    fn blocked(&self, request: &RequestContext) -> Result<Option<JobReport>, EngineError> {
        let reason = match self.policy.decision(request)? {
            PolicyDecision::Allowed => return Ok(None),
            PolicyDecision::Revoked => "workspace-policy-disabled",
            PolicyDecision::Maintenance => "workspace-maintenance",
        };
        Ok(Some(JobReport {
            outcome: JobOutcome::Skipped,
            reason: Some(reason.into()),
        }))
    }
}
