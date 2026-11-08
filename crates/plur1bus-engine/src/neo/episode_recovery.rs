//! Engine-owned recovery of prepared Neo work before accepting new turns.
use super::*;

/// Counts of work actually resumed during this startup pass, without caller or content disclosure.
#[derive(Default, Debug)]
pub struct RecoveryReport {
    /// Distinct owner/agent/workspace bindings with prepared work in the read-only inventory.
    pub bindings: usize,
    /// Missing source/derived/queue rows appended from existing frozen capture plans.
    pub capture_records: usize,
    /// Missing episode revisions appended; checkpoint-only completion can legitimately write zero.
    pub episode_revisions: usize,
}
impl EpisodeStore {
    /// Resume existing private plans without synthesizing messages or borrowing a current user.
    /// Revoked/corrupt/unrestorable plans fail closed and remain on disk. This does not replay
    /// the independent Lance capture WAL or invent episodes that were never durably planned.
    pub fn recover_pending(&self, cancel: &Cancel) -> Result<RecoveryReport, EngineError> {
        let cancel = cancel.limited_to(Instant::now() + Duration::from_secs(300));
        let callers = self.journal.recovery_callers(&cancel)?;
        let mut report = RecoveryReport {
            bindings: callers.len(),
            ..RecoveryReport::default()
        };
        for caller in callers {
            cancel.check()?;
            report.capture_records +=
                self.journal
                    .recover(&caller.principal, &caller.agent, &cancel)?;
            let context =
                RequestContext::build(&caller.principal, &caller.agent, self.host.as_ref())?;
            report.episode_revisions += self.journal.with_writer(
                &caller.principal,
                &caller.agent,
                &context,
                &cancel,
                &|| Ok(()),
                |dir, proof, name, check| self.resume_episode(dir, proof, name, check, &cancel),
            )?;
        }
        Ok(report)
    }
    pub(super) fn resume_episode(
        &self,
        dir: &crate::store::directory::TrustedDirectory,
        proof: &crate::text::json::TolerantJsonValue,
        name: &str,
        check: &dyn Fn() -> Result<(), EngineError>,
        cancel: &Cancel,
    ) -> Result<usize, EngineError> {
        let Some(plan) = episode_io::read(dir, name, proof, cancel)? else {
            return Ok(0);
        };
        let session = str_field(&plan, "session")?;
        let caller = crate::neo::caller::decode(
            crate::neo::merged_order::field(&plan, "caller").ok_or(StoreError::Corrupt)?,
        )?;
        let context = self.journal.authorize_caller(&caller, proof, cancel)?;
        let original_check = || -> Result<(), EngineError> {
            check()?;
            if self.journal.authorize_caller(&caller, proof, cancel)? != context {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        let publication = Publication {
            dir,
            proof,
            name,
            ctx: &context,
            check: &original_check,
        };
        self.sessions.transaction(
            &caller.principal,
            &caller.agent,
            session,
            cancel,
            &original_check,
            |checkpoint| episode_io::replay(&publication, &plan, checkpoint, cancel),
        )
    }
}
