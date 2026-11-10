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
    /// Missing target/queue revisions resumed from prepared embedding plans, without inference.
    pub embedding_revisions: usize,
    /// Bindings whose plans were closed (revoked, changed, exhausted or refused): their
    /// prepared turn content is removed, journals already written stay.
    pub closed: usize,
    /// Owner bindings (`agent`, `owner`) whose plans stay for a later attempt.
    pub deferred: std::collections::BTreeSet<(String, String)>,
    /// Plan files that could not be read or attributed: kept, reported, never blocking.
    pub unreadable: usize,
}
/// How one binding's recovery ended.
enum PlanOutcome {
    Recovered,
    Deferred,
    Closed(&'static str),
}
impl EpisodeStore {
    /// Resume existing private plans without synthesizing messages or borrowing a current user.
    /// Each owner binding is recovered on its own with its own budget (RE-D159): a revoked
    /// policy, a changed workspace or binding, five failed attempts or a terminal refusal
    /// close that binding's plans; maintenance and transient failures defer them. Nothing of
    /// one binding fails another's or the whole recovery; only `cancel` (shutdown) ends it.
    /// This does not replay the independent Lance capture WAL or invent episodes.
    pub fn recover_pending(&self, cancel: &Cancel) -> Result<RecoveryReport, EngineError> {
        let inventory = self.journal.recovery_plans(cancel)?;
        let mut report = RecoveryReport {
            bindings: inventory.plans.len(),
            unreadable: inventory.unreadable,
            ..RecoveryReport::default()
        };
        for plans in &inventory.plans {
            cancel.check()?;
            let budget = cancel.limited_to(Instant::now() + Duration::from_secs(300));
            match self.recover_binding(plans, &budget, &mut report) {
                Ok(PlanOutcome::Recovered) => {}
                Ok(PlanOutcome::Deferred) => self.defer(&mut report, plans),
                Ok(PlanOutcome::Closed(reason)) => {
                    log::warn!("neo: prepared plans closed ({reason})");
                    match self.journal.discard_plans(plans, cancel) {
                        Ok(()) => {
                            let _ = self.journal.note_plan_attempt(plans, 0);
                            report.closed += 1;
                        }
                        Err(error @ EngineError::Cancelled(_)) => return Err(error),
                        Err(_) => self.defer(&mut report, plans),
                    }
                }
                Err(_) => {
                    // Only the outer cancellation (shutdown) ends the whole recovery.
                    cancel.check()?;
                    self.defer(&mut report, plans);
                }
            }
        }
        Ok(report)
    }
    /// Remember a binding whose plans stay, keyed by agent and owner for the status.
    fn defer(
        &self,
        report: &mut RecoveryReport,
        plans: &crate::neo::capture_journal::PendingPlans,
    ) {
        let key = plans.caller.as_ref().map_or_else(
            || (String::new(), plans.digest.clone()),
            |(caller, _)| {
                RequestContext::build(&caller.principal, &caller.agent, self.host.as_ref())
                    .map_or_else(
                        |_| (caller.principal.agent_id.to_string(), plans.digest.clone()),
                        |ctx| (ctx.agent_id.to_string(), ctx.owner_user_id),
                    )
            },
        );
        report.deferred.insert(key);
    }
    /// Recover one owner binding: count first, then assess, then replay its plans.
    fn recover_binding(
        &self,
        plans: &crate::neo::capture_journal::PendingPlans,
        cancel: &Cancel,
        report: &mut RecoveryReport,
    ) -> Result<PlanOutcome, EngineError> {
        use crate::capture::failure::{classify, FailureClass, MAX_RECOVERY_ATTEMPTS};
        use crate::neo::capture_journal::PlanAssessment;
        let made = match self.journal.note_plan_attempt(plans, 1) {
            Ok(made) => made,
            Err(_) => return Ok(PlanOutcome::Deferred),
        };
        if made >= MAX_RECOVERY_ATTEMPTS {
            return Ok(PlanOutcome::Closed("recovery-exhausted"));
        }
        let outcome = (|| -> Result<PlanOutcome, EngineError> {
            match self.journal.assess_plans(plans, cancel)? {
                PlanAssessment::Ready => {}
                PlanAssessment::Revoked => {
                    return Ok(PlanOutcome::Closed("workspace-policy-disabled"))
                }
                PlanAssessment::Changed => {
                    return Ok(PlanOutcome::Closed("workspace-identity-changed"))
                }
                PlanAssessment::Maintenance => {
                    // Maintenance is no attempt: give the counted one back.
                    let _ = self.journal.note_plan_attempt(plans, -1);
                    return Ok(PlanOutcome::Deferred);
                }
            }
            let Some((caller, _)) = &plans.caller else {
                return Ok(PlanOutcome::Closed("workspace-identity-changed"));
            };
            let capture = self
                .journal
                .recover(&caller.principal, &caller.agent, cancel)?;
            let context =
                RequestContext::build(&caller.principal, &caller.agent, self.host.as_ref())?;
            let episode = self.journal.with_writer(
                &caller.principal,
                &caller.agent,
                &context,
                cancel,
                &|| Ok(()),
                |dir, proof, name, check| self.resume_episode(dir, proof, name, check, cancel),
            )?;
            let embedding =
                self.embedding_transaction(&caller.principal, &caller.agent, cancel, |session| {
                    crate::neo::embedding_publication::resume(&session, cancel)
                })?;
            report.capture_records += capture;
            report.episode_revisions += episode;
            report.embedding_revisions += embedding;
            Ok(PlanOutcome::Recovered)
        })();
        match outcome {
            Ok(PlanOutcome::Recovered) => {
                let _ = self.journal.note_plan_attempt(plans, 0);
                Ok(PlanOutcome::Recovered)
            }
            Ok(other) => Ok(other),
            Err(error) => match classify(&error) {
                FailureClass::Transient => Err(error),
                FailureClass::Terminal(reason) => Ok(PlanOutcome::Closed(reason)),
            },
        }
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
