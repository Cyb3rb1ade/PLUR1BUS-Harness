//! Reopen preflights every original caller before the first interrupted merge resumes.
use super::*;
pub(crate) type RestoredMerge = (MergeRequest, Principal, AgentContext);
pub(crate) fn restore(value: &Value, cancel: &Cancel) -> Result<RestoredMerge, EngineError> {
    let saved: Saved = serde_json::from_value(value.clone()).map_err(|_| StoreError::Corrupt)?;
    if saved.version != 1
        || saved.command != "memory-store-merge"
        || serde_json::to_value(&saved).map_err(|_| StoreError::Corrupt)? != *value
    {
        return Err(StoreError::Corrupt.into());
    }
    let request = saved.request();
    validate_request(&request, cancel)?;
    Ok((
        request,
        serde_json::from_value(saved.principal).map_err(|_| StoreError::Corrupt)?,
        serde_json::from_value(saved.agent).map_err(|_| StoreError::Corrupt)?,
    ))
}
impl NativeMerge {
    /// Recover all pending original callers using current policy; never invent a startup principal.
    pub fn open(
        reader: Arc<MemoryReader>,
        journal: Arc<CaptureJournal>,
    ) -> Result<Self, EngineError> {
        let adapter = Self::new(reader, journal);
        adapter.recover_pending(&Cancel::never())?;
        Ok(adapter)
    }
    /// Saved complete plans are validated together before any primary recovery mutation.
    pub fn recover_pending(&self, cancel: &Cancel) -> Result<usize, EngineError> {
        let cancel =
            cancel.limited_to(std::time::Instant::now() + std::time::Duration::from_secs(300));
        let requests = self.journal.merge_requests(&cancel)?;
        let inserts = self.journal.normal_insert_requests(&cancel)?;
        for (r, p, a) in &requests {
            self.settle(r, p, a, &cancel, true, true)?;
        }
        for (r, p, a) in &inserts {
            self.recover_insert(r, p, a, &cancel, true)?;
        }
        for (r, p, a) in &requests {
            self.settle(r, p, a, &cancel, true, false)?;
        }
        for (r, p, a) in &inserts {
            self.recover_insert(r, p, a, &cancel, false)?;
        }
        Ok(requests.len() + inserts.len())
    }
}
