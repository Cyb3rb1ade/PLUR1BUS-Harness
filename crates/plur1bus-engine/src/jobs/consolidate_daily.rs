//! Daily maintenance of owned Lance rows and the canonical Capture workspace.
mod dynamics;
use super::{
    lance_scope::LanceScope,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    contract::{Cancel, EngineError, JobName, JobOutcome, StoreError},
    neo::{capture_journal::CaptureJournal, graph_prune, retention},
    ops::memory::MemoryReader,
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) struct ConsolidateDaily {
    pub scope: Arc<LanceScope>,
    pub neo_root: Option<PathBuf>,
    pub base: PathBuf,
    pub reader: Arc<MemoryReader>,
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
        let Some(root) = &self.neo_root else {
            return Ok(JobReport::completed());
        };
        let journal = match CaptureJournal::open(root, host.clone(), self.scope.policy.clone()) {
            Ok(journal) => journal,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(JobReport::completed()),
            Err(error) => return Err(error.into()),
        };
        let check = || {
            if self.scope.check(authority, &cancel)?.is_some()
                || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != cfg
            {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let graph = match self.scope.stores.existing_private(authority.request())? {
            Some(store) => {
                let decayed = dynamics::decay(
                    &store,
                    authority.request(),
                    &self.scope.operations,
                    &crate::recall::tombstone_mask::TombstoneMask::new(&self.base),
                    context.now_ms,
                    &cancel,
                    &check,
                )?;
                context.note_count("dynamicsDecayed", decayed)?;
                let _mutation = self.scope.operations.mutation()?;
                check()?;
                graph_prune::run(
                    &journal,
                    authority,
                    &store,
                    &LanceScope::filter(authority),
                    context.now_ms,
                    &cancel,
                    &check,
                )?
            }
            None => graph_prune::Pruned::default(),
        };
        context.note_count("graphRemovedInactive", graph.inactive)?;
        context.note_count("graphRemovedWeak", graph.weak)?;
        let pruned = retention::run_for_job(&journal, authority, host.clone(), &cancel)?;
        context.note_count("hookStorePrune", pruned)?;
        check()?;
        let config = crate::config::effective_config(&cfg).map_err(|_| StoreError::InvalidInput)?;
        if config["schicht15"]["enabled"] != false {
            let (promoted, skipped) = super::knowledge_update::promote(
                self.reader.clone(),
                Arc::new(journal),
                authority,
                &cancel,
            )?;
            context.note_count("knowledgePromoted", promoted)?;
            context.note_count("knowledgeSkipped", skipped)?;
        }
        Ok(JobReport::completed())
    }
}
