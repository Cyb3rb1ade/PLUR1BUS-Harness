//! The native job registry over `<baseDbPath>/_jobs`, as the pin's `createJobRegistry`
//! (RE-D158, RE-D160). F13: RX has no owner or workspace binding for background work, so
//! every private job needs an explicit native grant. Embedding drain is implemented over
//! the owner-bound Neo writer, or reports the pin's skip when Neo is disabled.
//! Reads (`list`, `history`, health)
//! and dry runs never create anything. A session start (lease, recovery, legacy migration)
//! has a fixed budget and ends on shutdown or when its caller is cancelled.

use crate::{
    contract::{
        AgentId, Cancel, Degraded, EngineError, HistoryFilter, HostServices, JobName, JobOutcome,
        JobRegistry, JobRun, JobSpec, JobTrigger, JobsHealth, JobsHealthLedger, RunOptions,
        StoreError,
    },
    jobs::{
        authority::{self, JobAuthority},
        registry::{
            dry_run_report, health_at, HealthCache, JobBody, JobContext, JobReport, Registry,
        },
    },
    neo::{
        embedding_drain::{DrainOptions, EmbeddingDrain, Impact},
        episode_store::EpisodeStore,
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
// Run reason when the session start or the admission did not finish within its budget (for
// example another process holds the agent's session lease). Not a failure state; the next call
// retries. Never reported once a body began (RE-D164).
use crate::jobs::registry::SESSION_BUSY;
/// Budget of one session start when the caller has no earlier deadline. The library's
/// comparable bounded lock waits are 5 s: `store/tombstone.rs` `LOCK_TIMEOUT`,
/// `store/sqlite.rs` `BUSY_TIMEOUT` and the registry's settle budget in `jobs/registry.rs`.
const SESSION_START_BUDGET: Duration = Duration::from_secs(5);
/// How often a waiting session start looks at its caller's and the engine's cancellation.
const WATCH_TICK: Duration = Duration::from_millis(10);
/// Most idle agent slots the registry keeps (RE-D164).
#[cfg(test)]
pub(super) const MAX_AGENT_SESSIONS: usize = crate::jobs::registry::MAX_AGENT_SESSIONS;

#[cfg(test)]
type Fault = Arc<dyn Fn() + Send + Sync>;

/// A fresh token ending after `SESSION_START_BUDGET`, or at the caller's earlier deadline.
fn budgeted(cancel: &Cancel) -> Cancel {
    let now = Instant::now();
    let end = cancel
        .remaining()
        .map_or(now + SESSION_START_BUDGET, |left| {
            (now + left).min(now + SESSION_START_BUDGET)
        });
    Cancel::with_deadline(end)
}

fn unavailable(reason: &str) -> EngineError {
    EngineError::NotAvailable {
        reason: reason.into(),
    }
}

/// The pin's early exit for Neo jobs when the store is disabled.
struct NeoDisabled(JobName);
impl JobBody for NeoDisabled {
    fn name(&self) -> JobName {
        self.0
    }
    fn run(&self, _context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        cancel.check()?;
        Ok(JobReport {
            outcome: JobOutcome::Skipped,
            reason: Some("neo_disabled".into()),
        })
    }
}

/// Process job entry point over the existing ACL-aware Neo persistence.
pub(super) struct NeoDrain {
    pub(super) root: PathBuf,
    pub(super) policy: Arc<dyn crate::capture::shared_scope::CapturePolicy>,
    pub(super) mood: Arc<crate::capture::emotion_pool::EmotionalPool>,
    pub(super) host: Arc<dyn HostServices>,
    pub(super) provider: Arc<dyn crate::embedding::EmbeddingProvider>,
    pub(super) impact: Option<String>,
}

impl JobBody for NeoDrain {
    fn name(&self) -> JobName {
        JobName::EmbeddingDrain
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let authority = context.authority()?;
        cancel.check()?;
        // Native publications are capped at 1,000 items and 300 seconds. The
        // retained queue can be drained by later runs without widening scope.
        let options = DrainOptions {
            max_items: 1000,
            impact: Impact::from_config(self.impact.as_deref())?,
        };
        let episodes = match EpisodeStore::open(
            &self.root,
            self.host.clone(),
            self.policy.clone(),
            self.mood.clone(),
        ) {
            Ok(episodes) => Arc::new(episodes),
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(JobReport::completed()),
            Err(error) => return Err(error.into()),
        };
        EmbeddingDrain::bind(episodes, Some(self.provider.clone()))?
            .drain_for_job(authority, &options, cancel)?;
        Ok(JobReport::completed())
    }
}

/// Open the capture workspace episode store for a scoped rebuild.
pub(super) struct NeoRebuild {
    pub(super) root: PathBuf,
    pub(super) policy: Arc<dyn crate::capture::shared_scope::CapturePolicy>,
    pub(super) mood: Arc<crate::capture::emotion_pool::EmotionalPool>,
    pub(super) host: Arc<dyn HostServices>,
}

impl JobBody for NeoRebuild {
    fn name(&self) -> JobName {
        JobName::EpisodesRebuild
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let authority = context.authority()?;
        cancel.check()?;
        let episodes = match EpisodeStore::open(
            &self.root,
            self.host.clone(),
            self.policy.clone(),
            self.mood.clone(),
        ) {
            Ok(episodes) => episodes,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => {
                return Ok(JobReport::completed());
            }
            Err(error) => return Err(error.into()),
        };
        let rebuilt = episodes.rebuild_for_job(authority, context.now_ms, cancel)?;
        context.note_count("rebuilt", rebuilt)?;
        Ok(JobReport::completed())
    }
}

fn skip_when_neo_disabled(job: JobName) -> bool {
    matches!(job, JobName::EmbeddingDrain | JobName::EpisodesRebuild)
}

/// The process's job registry, its composition state and its shutdown signal.
pub(super) struct ProcessJobs {
    root: Option<PathBuf>,
    host: Arc<dyn HostServices>,
    neo_enabled: bool,
    drain: Option<Arc<NeoDrain>>,
    scoped_jobs: Vec<Arc<dyn JobBody>>,
    registry: Mutex<Option<Arc<Registry>>>,
    /// Health projections while no registry is bound yet.
    unbound: HealthCache,
    invalid: AtomicBool,
    shutdown: Cancel,
    closed: AtomicBool,
    #[cfg(test)]
    prepare_fault: Mutex<Option<Fault>>,
    /// A fixture body and settle budget, installed when the registry is bound (test only).
    #[cfg(test)]
    fixture: Mutex<Option<(Arc<dyn JobBody>, Duration)>>,
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
            drain: None,
            scoped_jobs: Vec::new(),
            registry: Mutex::new(None),
            unbound: HealthCache::default(),
            invalid: AtomicBool::new(false),
            shutdown: Cancel::never(),
            closed: AtomicBool::new(false),
            #[cfg(test)]
            prepare_fault: Mutex::new(None),
            #[cfg(test)]
            fixture: Mutex::new(None),
        }
    }

    pub(super) fn with_drain(mut self, drain: Option<NeoDrain>) -> Self {
        self.drain = drain.map(Arc::new);
        self
    }

    pub(super) fn with_scoped_jobs(mut self, bodies: Vec<Arc<dyn JobBody>>) -> Self {
        self.scoped_jobs = bodies;
        self
    }

    /// Install a fixture body and a settle budget before the first run (test only).
    #[cfg(test)]
    pub(super) fn set_fixture_body(&self, body: Arc<dyn JobBody>, settle: Duration) {
        *self.fixture.lock().unwrap_or_else(PoisonError::into_inner) = Some((body, settle));
    }

    #[cfg(test)]
    fn fixture(&self) -> Option<(Arc<dyn JobBody>, Duration)> {
        self.fixture
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Run a fault inside the session start (test only).
    #[cfg(test)]
    pub(super) fn set_prepare_fault(&self, fault: Fault) {
        *self
            .prepare_fault
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(fault);
    }

    /// Observe ledger reads of the unbound health cache (test only).
    #[cfg(test)]
    pub(super) fn set_ledger_read_hook(&self, hook: Arc<dyn Fn(&str) + Send + Sync>) {
        self.unbound.set_read_hook(hook);
    }

    /// Agent slots of the bound registry (test only).
    #[cfg(test)]
    pub(super) fn open_sessions(&self) -> usize {
        self.slot()
            .as_ref()
            .map_or(0, |registry| registry.open_sessions())
    }

    /// Ledger projections kept by both health caches (test only).
    #[cfg(test)]
    pub(super) fn cached_projections(&self) -> usize {
        self.unbound.len()
            + self
                .slot()
                .as_ref()
                .map_or(0, |registry| registry.cached_projections())
    }

    /// Whether a native body is installed for this job in this composition.
    pub(super) fn needs_authority(&self, job: JobName) -> bool {
        #[cfg(test)]
        if self.fixture().is_some_and(|(body, _)| body.name() == job) {
            return false;
        }
        match job {
            JobName::EmbeddingDrain => self.drain.is_some(),
            _ => self.scoped_jobs.iter().any(|body| body.name() == job),
        }
    }

    fn installed(&self, job: JobName) -> bool {
        #[cfg(test)]
        if self.fixture().is_some_and(|(body, _)| body.name() == job) {
            return true;
        }
        self.needs_authority(job) || (!self.neo_enabled && skip_when_neo_disabled(job))
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
        #[cfg(test)]
        let bound = bound.map(|registry| match self.fixture() {
            Some((_, settle)) => registry.with_settle_budget(settle),
            None => registry,
        });
        let registry = match bound {
            Ok(registry) => Arc::new(registry),
            Err(_) => {
                self.invalid.store(true, Ordering::Release);
                log::warn!("jobs: the jobs root cannot be bound");
                return Err(unavailable(COMPOSITION_INVALID));
            }
        };
        if !self.neo_enabled {
            registry.bind(Arc::new(NeoDisabled(JobName::EmbeddingDrain)))?;
            registry.bind(Arc::new(NeoDisabled(JobName::EpisodesRebuild)))?;
        } else if let Some(drain) = &self.drain {
            registry.bind_scoped(drain.clone())?;
        }
        for body in &self.scoped_jobs {
            #[cfg(test)]
            if self
                .fixture()
                .is_some_and(|(fixture, _)| fixture.name() == body.name())
            {
                continue;
            }
            registry.bind_scoped(body.clone())?;
        }
        #[cfg(test)]
        if let Some((body, _)) = self.fixture() {
            registry.bind(body)?;
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
        let token = budgeted(cancel);
        self.watched(cancel, &token, || {
            #[cfg(test)]
            {
                let fault = self
                    .prepare_fault
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone();
                if let Some(fault) = fault {
                    fault();
                }
            }
            registry.prepare(agent, &token)
        })
        .map_err(|error| self.waited(error, cancel))
    }

    /// Run `work` while a watcher cancels `token` when the caller's token (a closed
    /// connection) or the engine's shutdown fires. The watcher ends on every exit of `work`,
    /// also a panic (drop guard), so the scope never waits for it (RE-D164).
    fn watched<T>(&self, cancel: &Cancel, token: &Cancel, work: impl FnOnce() -> T) -> T {
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Acquire) {
                    if cancel.is_cancelled() || self.shutdown.is_cancelled() {
                        token.cancel();
                        break;
                    }
                    std::thread::sleep(WATCH_TICK);
                }
            });
            let _done = Done(&done);
            work()
        })
    }

    /// Map a session-start error: shutdown → closed; the caller's own cancellation stays its
    /// own; the budget → `job-session-busy`; anything else concerns this agent only.
    fn waited(&self, error: EngineError, cancel: &Cancel) -> EngineError {
        if let Some(error) = self.interrupted(&error, cancel) {
            return error;
        }
        match error {
            error @ EngineError::Invalid { .. } => error,
            _ => {
                log::warn!("jobs: session start incomplete");
                unavailable(RECOVERY_INCOMPLETE)
            }
        }
    }

    /// The common part of every budgeted wait: shutdown, the caller, then the budget.
    fn interrupted(&self, error: &EngineError, cancel: &Cancel) -> Option<EngineError> {
        if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
            return Some(unavailable("closed"));
        }
        if cancel.is_cancelled() {
            return Some(
                cancel
                    .check()
                    .err()
                    .map_or_else(|| unavailable(SESSION_BUSY), EngineError::from),
            );
        }
        matches!(error, EngineError::Cancelled(_)).then(|| unavailable(SESSION_BUSY))
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
        self.run_inner(job, agent, opts, cancel, None)
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

impl ProcessJobs {
    pub(super) fn run_authorized(
        &self,
        authority: JobAuthority,
        opts: RunOptions,
        cancel: &Cancel,
    ) -> Result<JobRun, EngineError> {
        let agent = authority.request().agent_id.clone();
        self.run_inner(authority.job(), &agent, opts, cancel, Some(authority))
    }

    fn run_inner(
        &self,
        job: JobName,
        agent: &AgentId,
        mut opts: RunOptions,
        cancel: &Cancel,
        authority: Option<JobAuthority>,
    ) -> Result<JobRun, EngineError> {
        cancel.check()?;
        self.root()?;
        // F13: refused before any file exists; an agent ID or a cron trigger grants nothing.
        if !self.installed(job) {
            return Err(unavailable(authority::refusal(job)));
        }
        if self.needs_authority(job) && authority.is_none() {
            return Err(unavailable(authority::AUTHORITY_UNBOUND));
        }
        // Pin `engine/create-engine.js`: a run without a trigger is a `harness` run. The default belongs to this
        // facade; the registry keeps the Node registry's own default (`manual`), as its recorded scenarios do.
        opts.trigger.get_or_insert(JobTrigger::Harness);
        // A dry run creates nothing: no root, no session, no ledger entry.
        if opts.dry_run == Some(true) {
            if let Some(registry) = self.registry(false)? {
                return match authority {
                    Some(authority) => {
                        registry.run_authorized(job, agent, &opts, cancel, cancel, authority)
                    }
                    None => registry.run(job, agent, opts, cancel),
                };
            }
            let started = self.host.now_ms();
            let run = dry_run_report(
                job,
                agent,
                opts.trigger.unwrap_or(JobTrigger::Harness),
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
        // The admission window (slot, start marker with its ledger writer lease) has the same
        // budget as the session start; the body keeps the caller's token (RE-D164).
        let admit = budgeted(cancel);
        // The registry answers `job-session-busy` only for its admission phase. A run whose
        // body has begun keeps the registry's own error (it stays started: its marker is
        // recorded at the next session start), never "not started" (RE-D164, review I1).
        self.watched(cancel, &admit, || match authority {
            Some(authority) => {
                registry.run_authorized(job, agent, &opts, cancel, &admit, authority)
            }
            None => registry.run_admitted(job, agent, &opts, cancel, &admit),
        })
        .map_err(|error| match error {
            EngineError::NotAvailable { reason }
                if reason == SESSION_BUSY
                    && (self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled()) =>
            {
                unavailable("closed")
            }
            error => error,
        })
    }
}
