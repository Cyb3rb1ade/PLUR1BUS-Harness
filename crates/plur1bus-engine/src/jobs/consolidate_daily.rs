//! Daily maintenance of owned Lance rows and the canonical Capture workspace.
use super::{
    lance_scope::LanceScope,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    contract::{Cancel, EngineError, JobName, JobOutcome, StoreError},
    neo::{capture_journal::CaptureJournal, retention},
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) struct ConsolidateDaily {
    pub scope: Arc<LanceScope>,
    pub neo_root: Option<PathBuf>,
}

impl JobBody for ConsolidateDaily {
    fn name(&self) -> JobName {
        JobName::ConsolidateDaily
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = cancel.limited_to(Instant::now() + Duration::from_secs(300));
        let host = self.scope.operations.host_handle();
        let cfg = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        if cfg["dailyConsolidation"]["enabled"] == false {
            return Ok(JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some("dailyConsolidation_disabled".into()),
            });
        }
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, &cancel)? {
            return Ok(skip);
        }
        let expired = {
            let _mutation = self.scope.operations.mutation()?;
            if let Some(skip) = self.scope.check(authority, &cancel)? {
                return Ok(skip);
            }
            match self.scope.stores.existing_private(authority.request())? {
                Some(store) => store.purge_job_expired(authority.request(), context.now_ms)?,
                None => 0,
            }
        };
        context.note_count("expiredDeleted", expired)?;
        let pruned = if let Some(root) = &self.neo_root {
            match CaptureJournal::open(root, host.clone(), self.scope.policy.clone()) {
                Ok(journal) => retention::run_for_job(&journal, authority, host, &cancel)?,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => 0,
                Err(error) => return Err(error.into()),
            }
        } else {
            0
        };
        context.note_count("hookStorePrune", pruned)?;
        Ok(JobReport::completed())
    }
}
