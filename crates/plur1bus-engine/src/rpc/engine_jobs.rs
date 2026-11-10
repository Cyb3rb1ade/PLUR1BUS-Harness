//! The native job registry over `<baseDbPath>/_jobs`, as the pin's `createJobRegistry`
//! (RE-D158). F13: RX has no owner or workspace binding for background work, so every job
//! whose body reads or writes private rows refuses with a fixed reason; LLM bodies are not
//! ported. The only installed body is the pin's `embedding-drain` with Neo disabled, which
//! records `skipped/neo_disabled` and reads nothing. Reads (`list`, `history`, health) never
//! create the root; a session start (recovery and legacy migration) is bound to shutdown.

use crate::{
    contract::{
        AgentId, Cancel, CancelReason, Cancelled, Degraded, EngineError, HistoryFilter,
        HostServices, JobName, JobOutcome, JobRegistry, JobRun, JobSpec, JobsHealth,
        JobsHealthLedger, RunOptions,
    },
    jobs::{
        authority,
        registry::{JobBody, JobContext, JobReport, Registry},
    },
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::Instant,
};

/// Status reason while an agent's session start (recovery, migration) has not succeeded.
const RECOVERY_INCOMPLETE: &str = "startup-recovery-incomplete";
/// Status reason when the jobs root cannot be bound (not a trusted directory, replaced).
const COMPOSITION_INVALID: &str = "composition-invalid";

fn unavailable(reason: &str) -> EngineError {
    EngineError::NotAvailable {
        reason: reason.into(),
    }
}

/// The pin's `embedding-drain` early exit when Neo is disabled: no Neo store is opened.
struct NeoDisabledDrain;
impl JobBody for NeoDisabledDrain {
    fn name(&self) -> JobName {
        JobName::EmbeddingDrain
    }
    fn run(&self, _context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        cancel.check()?;
        Ok(JobReport {
            outcome: JobOutcome::Skipped,
            reason: Some("neo_disabled".into()),
        })
    }
}

/// The process's job registry, its composition state and its shutdown signal.
pub(super) struct ProcessJobs {
    root: Option<PathBuf>,
    host: Arc<dyn HostServices>,
    neo_enabled: bool,
    registry: Mutex<Option<Arc<Registry>>>,
    invalid: AtomicBool,
    failed: Mutex<BTreeMap<String, &'static str>>,
    shutdown: Cancel,
    closed: AtomicBool,
}

impl ProcessJobs {
    /// Construction does no I/O; the root is bound on first use.
    pub(super) fn new(
        base: Option<PathBuf>,
        host: Arc<dyn HostServices>,
        neo_enabled: bool,
    ) -> Self {
        Self {
            root: base.map(|base| base.join("_jobs")),
            host,
            neo_enabled,
            registry: Mutex::new(None),
            invalid: AtomicBool::new(false),
            failed: Mutex::new(BTreeMap::new()),
            shutdown: Cancel::never(),
            closed: AtomicBool::new(false),
        }
    }

    /// Whether a native body is installed for this job in this composition.
    fn installed(&self, job: JobName) -> bool {
        job == JobName::EmbeddingDrain && !self.neo_enabled
    }

    fn slot(&self) -> MutexGuard<'_, Option<Arc<Registry>>> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The bound registry. Without `create`, an absent root is `None` and nothing is written.
    fn registry(&self, create: bool) -> Result<Option<Arc<Registry>>, EngineError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(unavailable("closed"));
        }
        let Some(root) = &self.root else {
            return Err(unavailable("composition-pending"));
        };
        let mut slot = self.slot();
        if let Some(registry) = slot.as_ref() {
            if registry.root_intact() {
                return Ok(Some(registry.clone()));
            }
            // A replaced root is rebound (or reported) instead of serving the old one.
            registry.close();
            *slot = None;
        }
        let exists = match std::fs::symlink_metadata(root) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => {
                self.invalid.store(true, Ordering::Release);
                return Err(unavailable(COMPOSITION_INVALID));
            }
        };
        if !exists && !create {
            self.invalid.store(false, Ordering::Release);
            return Ok(None);
        }
        let bound = (|| {
            if !exists {
                crate::store::paths::secure_dir(root)?;
            }
            let clock = self.host.clone();
            let events = self.host.clone();
            Ok::<_, EngineError>(
                Registry::new(root, Arc::new(move || clock.now_ms()))?.with_events(Arc::new(
                    move |run| {
                        // Best effort, as the pin's `emitEngineEvent(host, "job.run", run)`.
                        if let Ok(payload) = serde_json::to_value(run) {
                            events.emit("job.run", payload);
                        }
                        Ok(())
                    },
                )),
            )
        })();
        let registry = match bound {
            Ok(registry) => Arc::new(registry),
            Err(_) => {
                self.invalid.store(true, Ordering::Release);
                log::warn!("jobs: the jobs root cannot be bound");
                return Err(unavailable(COMPOSITION_INVALID));
            }
        };
        if self.installed(JobName::EmbeddingDrain) {
            registry.bind(Arc::new(NeoDisabledDrain))?;
        }
        self.invalid.store(false, Ordering::Release);
        *slot = Some(registry.clone());
        Ok(Some(registry))
    }

    /// Start the agent's session (orphan recovery, legacy migration) bound to shutdown and to
    /// the request deadline. Its failure is reported by status until a later start succeeds.
    fn prepare(
        &self,
        registry: &Registry,
        agent: &AgentId,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let bound = match cancel.remaining() {
            Some(left) => self.shutdown.limited_to(Instant::now() + left),
            None => self.shutdown.clone(),
        };
        let failed = |reason: &'static str| {
            self.failed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(agent.to_string(), reason);
            log::warn!("jobs: session start incomplete");
        };
        match registry.prepare(agent, &bound) {
            Ok(()) => {
                self.failed
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(agent.as_str());
                Ok(())
            }
            // Shutdown is no failure state.
            Err(_) if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() => {
                Err(unavailable("closed"))
            }
            // The request's own deadline ended the wait; nothing failed and nothing is recorded.
            Err(
                error @ EngineError::Cancelled(Cancelled {
                    reason: CancelReason::Deadline,
                }),
            ) => Err(error),
            Err(error @ EngineError::Invalid { .. }) => {
                failed(COMPOSITION_INVALID);
                Err(error)
            }
            Err(_) => {
                failed(RECOVERY_INCOMPLETE);
                Err(unavailable(RECOVERY_INCOMPLETE))
            }
        }
    }

    /// The jobs degradation the status reports, if the registry is not (fully) served.
    pub(super) fn degradation(&self) -> Option<Degraded> {
        let reason = if self.invalid.load(Ordering::Acquire) {
            COMPOSITION_INVALID
        } else {
            *self
                .failed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .values()
                .next()?
        };
        super::degradation(reason, "jobs").ok()
    }

    /// Ledger-derived health; never creates the root and never waits for a session.
    pub(super) fn health(&self) -> JobsHealth {
        match self.registry(false) {
            Ok(Some(registry)) => registry.health(),
            Ok(None) => JobsHealth {
                ledger: JobsHealthLedger::Ok,
                agents: vec![],
            },
            Err(_) => JobsHealth {
                ledger: JobsHealthLedger::Unavailable,
                agents: vec![],
            },
        }
    }

    /// Refuse new runs and stop session starts; admitted runs keep their own handles.
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.shutdown.cancel();
        if let Some(registry) = self.slot().take() {
            registry.close();
        }
    }
}

impl JobRegistry for ProcessJobs {
    fn list(&self) -> Vec<JobSpec> {
        crate::jobs::catalog()
    }
    fn run(
        &self,
        job: JobName,
        agent: &AgentId,
        opts: RunOptions,
        cancel: &Cancel,
    ) -> Result<JobRun, EngineError> {
        cancel.check()?;
        if self.closed.load(Ordering::Acquire) {
            return Err(unavailable("closed"));
        }
        if self.root.is_none() {
            return Err(unavailable("composition-pending"));
        }
        // F13: refused before any file exists; an agent ID or a cron trigger grants nothing.
        if !self.installed(job) {
            return Err(unavailable(authority::refusal(job)));
        }
        let registry = self
            .registry(true)?
            .ok_or_else(|| unavailable(COMPOSITION_INVALID))?;
        // A dry run is answered by the registry without a session or ledger entry.
        if opts.dry_run != Some(true) {
            self.prepare(&registry, agent, cancel)?;
        }
        cancel.check()?;
        registry.run(job, agent, opts, cancel)
    }
    fn history(&self, agent: &AgentId, filter: HistoryFilter) -> Result<Vec<JobRun>, EngineError> {
        match self.registry(false)? {
            Some(registry) => registry.history(agent, filter),
            // The pin reads an absent ledger as no history.
            None => Ok(Vec::new()),
        }
    }
}
