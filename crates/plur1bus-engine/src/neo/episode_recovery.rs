//! Engine-owned recovery of prepared Neo work before accepting new turns.
use super::*;
use crate::capture::retained::Bounds;
use crate::contract::{
    AgentId, EgressGate, EngineConfig, HostError, JournalBacklog, PlatformCapabilities, SecretPort,
};

/// A host whose workspace answer for one agent was taken before any lease (RE-D163). The
/// replay of that agent's binding asks it nothing that could fail to return: under the
/// workspace lease and the Neo write lock only the file system is used.
struct ResolvedHost {
    host: Arc<dyn HostServices>,
    agent: AgentId,
    workspace: Option<std::path::PathBuf>,
}
impl HostServices for ResolvedHost {
    fn state_dir(&self) -> &Path {
        self.host.state_dir()
    }
    fn config(&self) -> EngineConfig {
        self.host.config()
    }
    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<std::path::PathBuf>, HostError> {
        if agent == &self.agent {
            Ok(self.workspace.clone())
        } else {
            // Nobody else's workspace is part of this binding.
            Err(HostError::Unavailable)
        }
    }
    fn llm(&self) -> Option<&dyn LlmPort> {
        self.host.llm()
    }
    fn secrets(&self) -> Option<&dyn SecretPort> {
        self.host.secrets()
    }
    fn egress(&self) -> &dyn EgressGate {
        self.host.egress()
    }
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.host.emit(event, payload);
    }
    fn now_ms(&self) -> i64 {
        self.host.now_ms()
    }
    fn platform(&self) -> &PlatformCapabilities {
        self.host.platform()
    }
    fn journal_backlog(&self) -> Option<JournalBacklog> {
        None
    }
}

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
        let bounds = Bounds::new(cancel.clone());
        let inventory = self.journal.recovery_plans(cancel)?;
        let mut report = RecoveryReport {
            bindings: inventory.plans.len(),
            unreadable: inventory.unreadable,
            ..RecoveryReport::default()
        };
        for plans in &inventory.plans {
            cancel.check()?;
            let budget = cancel.limited_to(Instant::now() + self.plan_budget());
            if !self.recover_plans(plans, &budget, &bounds, &mut report) {
                // Only the outer cancellation (shutdown) ends the whole recovery.
                cancel.check()?;
                self.defer(&mut report, plans, &bounds);
            }
        }
        Ok(report)
    }
    /// One binding's recovery budget (RE-D162): what a turn's own Neo step gets at the pin,
    /// `min(captureTimeoutMs, max(1000, neo.agentEndBudgetMs || 20000))`
    /// (`engine/create-engine.js` `neoAgentEndBudgetMs`, applied in
    /// `engine/capture/capture-turn.js` through `deriveBudgetedSignal`). A resumed binding
    /// is that same step, so it gets no more.
    pub(in crate::neo) fn plan_budget(&self) -> Duration {
        crate::neo::capture_journal::neo_budget(self.host.as_ref())
    }
    /// This store over the host's answer for one agent's workspace, asked now: on a thread
    /// of its own, within the binding's budget and the agent's places for outstanding host
    /// lookups (RE-D163). No answer in time is a transient host failure.
    fn resolved(
        &self,
        agent: &AgentId,
        cancel: &Cancel,
        bounds: &Bounds,
    ) -> Result<EpisodeStore, EngineError> {
        let (host, asked) = (self.host.clone(), agent.clone());
        let workspace = bounds
            .host_call(
                agent.as_str(),
                "neo-recovery",
                cancel,
                self.plan_budget(),
                move || host.workspace_dir(&asked),
            )
            .ok_or(HostError::Unavailable)??;
        cancel.check()?;
        let host: Arc<dyn HostServices> = Arc::new(ResolvedHost {
            host: self.host.clone(),
            agent: agent.clone(),
            workspace,
        });
        Ok(EpisodeStore {
            journal: self.journal.over(host.clone())?,
            sessions: self.sessions.over(host.clone())?,
            host,
            mood: self.mood.clone(),
            narrative: self.narrative.clone(),
        })
    }
    /// The bindings with prepared plans (`<workspace directory>/<binding digest>`) and the
    /// number of plan files that cannot be read or attributed. Directory entries and plan
    /// files only: no host is asked, nothing is leased (RE-D162).
    pub(in crate::neo) fn plan_keys(
        &self,
        cancel: &Cancel,
    ) -> Result<(Vec<String>, usize), EngineError> {
        let inventory = self.journal.recovery_plans(cancel)?;
        let keys = inventory
            .plans
            .iter()
            .map(|plans| format!("{}/{}", plans.canonical, plans.digest))
            .collect();
        Ok((keys, inventory.unreadable))
    }
    /// One attempt for one binding within `budget`; true when none of its plans is left.
    pub(in crate::neo) fn recover_key(&self, key: &str, budget: &Cancel, bounds: &Bounds) -> bool {
        let Some((canonical, digest)) = key.split_once('/') else {
            return true;
        };
        match self.journal.binding_plans(canonical, digest, budget) {
            Ok(Some(plans)) => {
                self.recover_plans(&plans, budget, bounds, &mut RecoveryReport::default())
            }
            Ok(None) => true,
            Err(_) => false,
        }
    }
    /// Whether a binding still has a prepared plan.
    pub(in crate::neo) fn has_plans(&self, key: &str, cancel: &Cancel) -> bool {
        key.split_once('/').is_some_and(|(canonical, digest)| {
            !matches!(
                self.journal.binding_plans(canonical, digest, cancel),
                Ok(None)
            )
        })
    }
    /// The key of the binding a caller's own journal writes use; this asks the host.
    pub(in crate::neo) fn binding_key(
        &self,
        principal: &crate::contract::Principal,
        agent: &crate::contract::AgentContext,
    ) -> Result<Option<String>, EngineError> {
        self.journal.binding_key(principal, agent)
    }
    /// Recover or close one binding's plans within its budget; false when they stay for a
    /// later attempt. Closing waits for the workspace leases under the same budget (I3):
    /// a lease held elsewhere defers the binding, it never stops anyone.
    fn recover_plans(
        &self,
        plans: &crate::neo::capture_journal::PendingPlans,
        budget: &Cancel,
        bounds: &Bounds,
        report: &mut RecoveryReport,
    ) -> bool {
        match self.recover_binding(plans, budget, bounds, report) {
            Ok(PlanOutcome::Recovered) => true,
            Ok(PlanOutcome::Deferred) | Err(_) => false,
            Ok(PlanOutcome::Closed(reason)) => {
                log::warn!("neo: prepared plans closed ({reason})");
                match self.journal.discard_plans(plans, budget) {
                    Ok(()) => {
                        let _ = self.journal.note_plan_attempt(plans, 0);
                        report.closed += 1;
                        true
                    }
                    // The attempt was counted; the next one closes the plans again.
                    Err(_) => false,
                }
            }
        }
    }
    /// Remember a binding whose plans stay, keyed by agent and owner for the status.
    fn defer(
        &self,
        report: &mut RecoveryReport,
        plans: &crate::neo::capture_journal::PendingPlans,
        bounds: &Bounds,
    ) {
        let key = plans.caller.as_ref().map_or_else(
            || (String::new(), plans.digest.clone()),
            |(caller, _)| {
                // The owner's name for the report needs the host; without an answer the
                // binding digest stands for it.
                let (host, principal, agent) = (
                    self.host.clone(),
                    caller.principal.clone(),
                    caller.agent.clone(),
                );
                bounds
                    .host_call(
                        caller.principal.agent_id.as_str(),
                        "neo-recovery",
                        &bounds.shutdown,
                        self.plan_budget(),
                        move || RequestContext::build(&principal, &agent, host.as_ref()),
                    )
                    .and_then(Result::ok)
                    .map_or_else(
                        || (caller.principal.agent_id.to_string(), plans.digest.clone()),
                        |ctx| (ctx.agent_id.to_string(), ctx.owner_user_id),
                    )
            },
        );
        report.deferred.insert(key);
    }
    /// Recover one owner binding: count first, then ask the host, then assess and replay
    /// its plans. The host is asked once, before any lease, with a budget (RE-D163); what
    /// follows runs on that answer.
    fn recover_binding(
        &self,
        plans: &crate::neo::capture_journal::PendingPlans,
        cancel: &Cancel,
        bounds: &Bounds,
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
            let Some((caller, _)) = &plans.caller else {
                return Ok(PlanOutcome::Closed("workspace-identity-changed"));
            };
            let view = self.resolved(&caller.principal.agent_id, cancel, bounds)?;
            match view.journal.assess_plans(plans, cancel)? {
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
            let capture = view
                .journal
                .recover(&caller.principal, &caller.agent, cancel)?;
            let context =
                RequestContext::build(&caller.principal, &caller.agent, view.host.as_ref())?;
            let episode = view.journal.with_writer(
                &caller.principal,
                &caller.agent,
                &context,
                cancel,
                &|| Ok(()),
                |dir, proof, name, check| view.resume_episode(dir, proof, name, check, cancel),
            )?;
            let embedding =
                view.embedding_transaction(&caller.principal, &caller.agent, cancel, |session| {
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
