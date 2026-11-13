//! Deterministic promotion through the same source-marker and queue writer as A1.
use super::{
    lance_scope::LanceScope,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    contract::{Cancel, EngineError, JobName, JobOutcome, StoreError},
    neo::capture_journal::CaptureJournal,
    ops::{knowledge_promotion::NativePromotion, memory::MemoryReader},
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) struct KnowledgeUpdate {
    pub scope: Arc<LanceScope>,
    pub reader: Arc<MemoryReader>,
    pub root: PathBuf,
}

impl JobBody for KnowledgeUpdate {
    fn name(&self) -> JobName {
        JobName::KnowledgeUpdate
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(60));
        let authority = context.authority()?;
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let host = self.scope.operations.host_handle();
        let config = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config =
            crate::config::effective_config(&config).map_err(|_| StoreError::InvalidInput)?;
        if config["schicht15"]["enabled"] == false {
            return Ok(JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some("knowledge_disabled".into()),
            });
        }
        let journal = match CaptureJournal::open(&self.root, host, self.scope.policy.clone()) {
            Ok(journal) => journal,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(JobReport::completed()),
            Err(error) => return Err(error.into()),
        };
        let result = NativePromotion::new(self.reader.clone(), Arc::new(journal))
            .run_for_job(authority, cancel)?;
        let result = serde_json::to_value(result).map_err(|_| StoreError::Corrupt)?;
        let items = result["items"].as_array().ok_or(StoreError::Corrupt)?;
        let promoted = items
            .iter()
            .filter(|item| item["outcome"] == "promoted")
            .count();
        context.note_count("promoted", promoted)?;
        context.note_count("skipped", items.len() - promoted)?;
        Ok(JobReport::completed())
    }
}
