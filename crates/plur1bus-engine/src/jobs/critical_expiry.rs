//! The scheduled `auto-accept-stale` job declassifies old unconfirmed criticals.
use super::{
    lance_scope::LanceScope,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    contract::{Cancel, EngineError, JobName},
    recall::acl,
};
use std::sync::Arc;

const AGE_MS: i64 = 24 * 60 * 60 * 1000;

pub(crate) struct CriticalExpiry(pub Arc<LanceScope>);

impl JobBody for CriticalExpiry {
    fn name(&self) -> JobName {
        JobName::AutoAcceptStale
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let request = authority.request();
        let _operation = self.0.operations.enter(principal, agent)?;
        if let Some(skip) = self.0.check(authority, cancel)? {
            return Ok(skip);
        }
        let _mutation = self.0.operations.mutation()?;
        cancel.check()?;
        let Some(store) = self.0.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let mut scope = LanceScope::filter(authority);
        scope.status = Some("active".into());
        let cutoff = context.now_ms.saturating_sub(AGE_MS);
        for row in store.stale_criticals(&scope, cutoff)? {
            cancel.check()?;
            if acl::allowed(&row, request).is_err() {
                continue;
            }
            if let Some(skip) = self.0.check(authority, cancel)? {
                return Ok(skip);
            }
            store.expire_critical(&scope, cutoff, &row)?;
        }
        Ok(JobReport::completed())
    }
}
