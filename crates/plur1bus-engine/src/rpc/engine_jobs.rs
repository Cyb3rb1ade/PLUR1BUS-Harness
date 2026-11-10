//! The native job registry over `<baseDbPath>/_jobs`, as the pin's `createJobRegistry`
//! (RE-D158, RE-D160). F13: RX has no owner or workspace binding for background work, so
//! every job whose body reads or writes private rows refuses with a fixed reason; LLM bodies
//! are not ported. The only installed body is the pin's `embedding-drain` with Neo disabled,
//! which records `skipped/neo_disabled` and reads nothing. Reads (`list`, `history`, health)
//! and dry runs never create anything. A session start (lease, recovery, legacy migration)
//! has a fixed budget and ends on shutdown or when its caller is cancelled.

use crate::{
    contract::{
        AgentId, Cancel, Degraded, EngineError, HistoryFilter, HostServices, JobName, JobOutcome,
        JobRegistry, JobRun, JobSpec, JobTrigger, JobsHealth, JobsHealthLedger, RunOptions,
    },
    jobs::{
        authority,
        registry::{
            dry_run_report, health_at, HealthCache, JobBody, JobContext, JobReport, Registry,
        },
    },
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};

/// Run reason while an agent's session start (recovery, migration) fails; that agent only.
const RECOVERY_INCOMPLETE: &str = "startup-recovery-incomplete";
/// Status and run reason when the jobs root cannot be bound (not a trusted directory, replaced).
const COMPOSITION_INVALID: &str = "composition-invalid";
/// Run reason when the session start did not finish within its budget (for example another
/// process holds the agent's session lease). Not a failure state; the next call retries.
const SESSION_BUSY: &str = "job-session-busy";
/// Budget of one session start when the caller has no earlier deadline. The library's
/// comparable bounded lock waits are 5 s: `store/tombstone.rs` `LOCK_TIMEOUT`,
/// `store/sqlite.rs` `BUSY_TIMEOUT` and the registry's settle budget in `jobs/registry.rs`.
const SESSION_START_BUDGET: Duration = Duration::from_secs(5);
/// How often a waiting session start looks at its caller's and the engine's cancellation.
const WATCH_TICK: Duration = Duration::from_millis(10);

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
    /// Health projections while no registry is bound yet.
    unbound: HealthCache,
    invalid: AtomicBool,
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
            unbound: HealthCache::default(),
            invalid: AtomicBool::new(false),
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

    fn root(&self) -> Result<&PathBuf, EngineError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(unavailable("closed"));
        }
        self.root
            .as_ref()
            .ok_or_else(|| unavailable("composition-pending"))
    }

    /// The bound registry. Without `create`, an absent root is `None`, nothing is written and
    /// a replaced root is reported (`composition-invalid`), not rebound; a run rebinds it.
    fn registry(&self, create: bool) -> Result<Option<Arc<Registry>>, EngineError> {
        let root = self.root()?;
        let mut slot = self.slot();
        if let Some(registry) = slot.as_ref() {
            if registry.root_intact() {
                return Ok(Some(registry.clone()));
            }
            if !create {
                self.invalid.store(true, Ordering::Release);
                return Err(unavailable(COMPOSITION_INVALID));
            }
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

    /// Start the agent's session (lease, orphan recovery, legacy migration) within
    /// `SESSION_START_BUDGET` (or the caller's earlier deadline). It ends early on shutdown or
    /// when the caller's token is cancelled, for example by a closed connection. A failure
    /// concerns only this agent and is retried by its next call; nothing is recorded.
    fn prepare(
        &self,
        registry: &Registry,
        agent: &AgentId,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let now = Instant::now();
        let end = cancel
            .remaining()
            .map_or(now + SESSION_START_BUDGET, |left| {
                (now + left).min(now + SESSION_START_BUDGET)
            });
        let token = Cancel::with_deadline(end);
        let done = AtomicBool::new(false);
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Acquire) {
                    if cancel.is_cancelled() || self.shutdown.is_cancelled() {
                        token.cancel();
                        break;
                    }
                    std::thread::sleep(WATCH_TICK);
                }
            });
            let result = registry.prepare(agent, &token);
            done.store(true, Ordering::Release);
            result
        });
        match result {
            Ok(()) => Ok(()),
            // Shutdown is no failure state.
            Err(_) if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() => {
                Err(unavailable("closed"))
            }
            // The caller's own cancellation or deadline.
            Err(_) if cancel.is_cancelled() => Err(cancel
                .check()
                .err()
                .map_or_else(|| unavailable(SESSION_BUSY), EngineError::from)),
            Err(EngineError::Cancelled(_)) => Err(unavailable(SESSION_BUSY)),
            Err(error @ EngineError::Invalid { .. }) => Err(error),
            Err(_) => {
                log::warn!("jobs: session start incomplete");
                Err(unavailable(RECOVERY_INCOMPLETE))
            }
        }
    }

    /// The jobs degradation the status reports: only a jobs root that cannot be bound.
    /// One agent's failed session start concerns only that agent's runs (RE-D160).
    pub(super) fn degradation(&self) -> Option<Degraded> {
        self.invalid
            .load(Ordering::Acquire)
            .then(|| super::degradation(COMPOSITION_INVALID, "jobs").ok())
            .flatten()
    }

    /// Ledger-derived health. Never creates, binds, closes or waits: a replaced root is
    /// reported, an unbound existing root is read through a temporary handle.
    pub(super) fn health(&self) -> JobsHealth {
        let unavailable = JobsHealth {
            ledger: JobsHealthLedger::Unavailable,
            agents: vec![],
        };
        let Ok(root) = self.root() else {
            return unavailable;
        };
        let bound = self.slot().clone();
        let health = match bound {
            Some(registry) if registry.root_intact() => Some(registry.health()),
            Some(_) => None,
            None => match std::fs::symlink_metadata(root) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(JobsHealth {
                    ledger: JobsHealthLedger::Ok,
                    agents: vec![],
                }),
                Err(_) => None,
                Ok(_) => health_at(root, self.host.now_ms(), &self.unbound),
            },
        };
        self.invalid.store(health.is_none(), Ordering::Release);
        health.unwrap_or(unavailable)
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
        self.root()?;
        // F13: refused before any file exists; an agent ID or a cron trigger grants nothing.
        if !self.installed(job) {
            return Err(unavailable(authority::refusal(job)));
        }
        // A dry run creates nothing: no root, no session, no ledger entry.
        if opts.dry_run == Some(true) {
            if let Some(registry) = self.registry(false)? {
                return registry.run(job, agent, opts, cancel);
            }
            let started = self.host.now_ms();
            let run = dry_run_report(
                job,
                agent,
                opts.trigger.unwrap_or(JobTrigger::Manual),
                started,
                self.host.now_ms(),
                uuid::Uuid::new_v4().to_string(),
            )?;
            if let Ok(payload) = serde_json::to_value(&run) {
                self.host.emit("job.run", payload);
            }
            return Ok(run);
        }
        let registry = self
            .registry(true)?
            .ok_or_else(|| unavailable(COMPOSITION_INVALID))?;
        self.prepare(&registry, agent, cancel)?;
        cancel.check()?;
        registry.run(job, agent, opts, cancel)
    }
    fn history(&self, agent: &AgentId, filter: HistoryFilter) -> Result<Vec<JobRun>, EngineError> {
        match self.registry(false)? {
            // Never waits for a running session start (`Registry::history`).
            Some(registry) => registry.history(agent, filter),
            // The pin reads an absent ledger as no history.
            None => Ok(Vec::new()),
        }
    }
}
