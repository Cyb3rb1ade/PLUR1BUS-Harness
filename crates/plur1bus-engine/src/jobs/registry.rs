//! Native job coordination. Body registration is explicit and does not manufacture caller authority.
use super::{
    authority::{self, JobAuthority},
    ledger::{JobLedger, JobSession},
    metadata::{self, HistorySelection},
};
use crate::{contract::*, store::directory::TrustedDirectory};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
mod health;
pub use health::{health_at, HealthCache, MAX_HEALTH_PROJECTIONS};
/// Idle agent session cache limit (RE-D164). Eviction closes the least recently used
/// idle session and releases its filesystem handles. A launchd process can have a
/// 256-descriptor soft limit. At 32 entries the agent directory and kernel lease alone
/// account for 64 descriptors, leaving room for the ledger roots, stores and sockets.
/// The same conservative cache size applies across platforms: each idle session also
/// holds an exclusive filesystem lease, and eviction costs only a session reopen and
/// orphan recovery on that agent's next job. Concurrent active sessions can exceed it.
pub const MAX_AGENT_SESSIONS: usize = 32;
/// The run error while the admission phase did not finish within its budget (RE-D164).
pub const SESSION_BUSY: &str = "job-session-busy";
/// Bounded metadata cleanup after a body ran (`finish`), and the retraction of a marker.
const SETTLE_BUDGET: Duration = Duration::from_secs(5);
mod notes;
mod record;
mod startup;

/// Context for an explicitly installed native body. An agent identifier is not a memory-data grant.
#[derive(Clone, Debug)]
pub struct JobContext {
    /// Selected agent's job metadata namespace.
    pub agent: AgentId,
    /// The host's declared trigger.
    pub trigger: JobTrigger,
    /// Host clock at admission.
    pub now_ms: i64,
    authority: Option<Arc<JobAuthority>>,
    notes: Arc<notes::State>,
}

impl JobContext {
    /// Request identity for a body registered with `Registry::bind_scoped`.
    pub fn authority(&self) -> Result<&JobAuthority, EngineError> {
        self.authority.as_deref().ok_or_else(authority::unbound)
    }
}

/// One native body owner. Any data access must independently retain its original proven authority.
pub trait JobBody: Send + Sync {
    /// Public catalog name owned by this implementation.
    fn name(&self) -> JobName;
    /// Execute with cooperative cancellation; errors are recorded without their private messages.
    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError>;
}
/// Body outcome; registry owns identifiers, clocks, attempts, cost and durable metadata.
#[derive(Clone, Debug)]
pub struct JobReport {
    /// Declared outcome.
    pub outcome: JobOutcome,
    /// Bounded diagnostic reason, without private card content.
    pub reason: Option<String>,
}
impl JobReport {
    /// Successful deterministic body completion.
    #[must_use]
    pub fn completed() -> Self {
        Self {
            outcome: JobOutcome::Completed,
            reason: None,
        }
    }
}
/// Additive native availability inventory; the frozen JobSpec wire remains unchanged.
#[derive(Clone, Debug)]
pub struct JobAvailability {
    /// Frozen public specification.
    pub spec: JobSpec,
    /// Whether an actual owner has been installed.
    pub available: bool,
    /// Unavailability explanation.
    pub reason: Option<String>,
}
struct AgentState {
    session: JobSession,
    active: BTreeMap<JobName, String>,
}
type Slot = Arc<Mutex<Option<AgentState>>>;
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
type IdFactory = Arc<dyn Fn() -> String + Send + Sync>;
#[cfg(any(test, feature = "testkit"))]
type Observer = Arc<dyn Fn(&str) + Send + Sync>;
type Events = Arc<dyn Fn(&JobRun) -> Result<(), EngineError> + Send + Sync>;
#[derive(Clone)]
struct Body {
    implementation: Arc<dyn JobBody>,
    scoped: bool,
}

/// Metadata registry with persistent history and lifecycle-fenced agent sessions.
/// No body is installed by default; a flat embedding test seam never makes a job available.
pub struct Registry {
    root: TrustedDirectory,
    legacy: BTreeMap<String, Vec<TrustedDirectory>>,
    clock: Clock,
    ids: IdFactory,
    events: Events,
    bodies: Mutex<BTreeMap<JobName, Body>>,
    /// Agent slots with their last use; at most `MAX_AGENT_SESSIONS` idle ones are kept.
    agents: Mutex<BTreeMap<String, (Slot, u64)>>,
    uses: std::sync::atomic::AtomicU64,
    settle: Duration,
    closed: AtomicBool,
    inflight: health::InFlightRuns,
    #[cfg(any(test, feature = "testkit"))]
    observer: Option<Observer>,
}
impl Registry {
    /// Bind an existing jobs directory and the host clock without writing any files.
    pub fn new(root: &Path, clock: Clock) -> Result<Self, EngineError> {
        Ok(Self {
            root: TrustedDirectory::open(root)?,
            legacy: BTreeMap::new(),
            clock,
            ids: Arc::new(|| uuid::Uuid::new_v4().to_string()),
            events: Arc::new(|_| Ok(())),
            bodies: Mutex::new(BTreeMap::new()),
            agents: Mutex::new(BTreeMap::new()),
            uses: std::sync::atomic::AtomicU64::new(0),
            settle: SETTLE_BUDGET,
            closed: AtomicBool::new(false),
            inflight: health::InFlightRuns::default(),
            #[cfg(any(test, feature = "testkit"))]
            observer: None,
        })
    }
    /// Fixtures: a shorter settle budget, to force an unfinished settle without waiting.
    #[cfg(any(test, feature = "testkit"))]
    #[must_use]
    pub fn with_settle_budget(mut self, settle: Duration) -> Self {
        self.settle = settle;
        self
    }
    fn settle_token(&self) -> Cancel {
        Cancel::with_deadline(std::time::Instant::now() + self.settle)
    }
    /// Install the host's best-effort job-run event sink; sink errors do not undo durable completion.
    #[must_use]
    pub fn with_events(mut self, events: Events) -> Self {
        self.events = events;
        self
    }
    /// Deterministic identifiers for isolated registry fixtures only.
    #[cfg(any(test, feature = "testkit"))]
    #[must_use]
    pub fn with_id_factory(mut self, ids: IdFactory) -> Self {
        self.ids = ids;
        self
    }
    /// Observe durable session boundaries in isolated crash fixtures only.
    #[cfg(any(test, feature = "testkit"))]
    #[must_use]
    pub fn with_observer(mut self, observer: Observer) -> Self {
        self.observer = Some(observer);
        self
    }
    /// Register one owner once. Installing a body is a host composition action, not a data grant.
    pub fn bind(&self, body: Arc<dyn JobBody>) -> Result<(), EngineError> {
        self.install(body, false)
    }

    /// Register a body that reads or writes protected data and requires native job authority.
    pub fn bind_scoped(&self, body: Arc<dyn JobBody>) -> Result<(), EngineError> {
        self.install(body, true)
    }

    fn install(&self, body: Arc<dyn JobBody>, scoped: bool) -> Result<(), EngineError> {
        self.check(&Cancel::never())?;
        let mut bodies = self.bodies.lock().map_err(|_| StoreError::Corrupt)?;
        let name = body.name();
        if bodies.contains_key(&name) {
            return Err(StoreError::InvalidInput.into());
        }
        bodies.insert(
            name,
            Body {
                implementation: body,
                scoped,
            },
        );
        Ok(())
    }
    /// Report native availability alongside the unchanged catalog.
    pub fn inventory(&self) -> Result<Vec<JobAvailability>, EngineError> {
        let bodies = self.bodies.lock().map_err(|_| StoreError::Corrupt)?;
        Ok(super::catalog()
            .into_iter()
            .map(|spec| {
                let available =
                    bodies.contains_key(&spec.name) && !self.closed.load(Ordering::Acquire);
                JobAvailability {
                    spec,
                    available,
                    reason: (!available).then(|| "not-implemented".into()),
                }
            })
            .collect())
    }
    /// Reject future work. Active calls retain their own session handles until they finish.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.agents
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
    fn check(&self, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        if self.closed.load(Ordering::Acquire) {
            return Err(EngineError::NotAvailable {
                reason: "closed".into(),
            });
        }
        self.root.assert_unchanged()?;
        Ok(())
    }
    fn slot(&self, agent: &AgentId) -> Result<Slot, EngineError> {
        let mut agents = self.agents.lock().map_err(|_| StoreError::Corrupt)?;
        self.check(&Cancel::never())?;
        let used = self.uses.fetch_add(1, Ordering::Relaxed);
        if let Some((slot, last)) = agents.get_mut(agent.as_str()) {
            *last = used;
            return Ok(slot.clone());
        }
        // Release the least recently used idle slot (its session, directory handle and lease)
        // before a new one exceeds the bound. A slot someone else holds is never released; with
        // every slot in use the map grows by the concurrent callers only (RE-D164).
        while agents.len() >= MAX_AGENT_SESSIONS {
            let idle = agents
                .iter()
                .filter(|(_, (slot, _))| Arc::strong_count(slot) == 1)
                .min_by_key(|(_, (_, last))| *last)
                .map(|(name, _)| name.clone());
            match idle {
                Some(name) => {
                    agents.remove(&name);
                }
                None => break,
            }
        }
        let slot: Slot = Arc::new(Mutex::new(None));
        agents.insert(agent.to_string(), (slot.clone(), used));
        Ok(slot)
    }
}
struct ActiveRun {
    slot: Slot,
    job: JobName,
    owns: bool,
}
impl Drop for ActiveRun {
    fn drop(&mut self) {
        if self.owns {
            if let Ok(mut state) = self.slot.lock() {
                if let Some(state) = state.as_mut() {
                    state.active.remove(&self.job);
                }
            }
        }
    }
}
fn lock<'a, T>(mutex: &'a Mutex<T>, cancel: &Cancel) -> Result<MutexGuard<'a, T>, EngineError> {
    loop {
        cancel.check()?;
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(StoreError::Corrupt.into()),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(5))
            }
        }
    }
}
/// Read a ledger without its session. A read overlapping an append sees the size change and
/// answers `Unavailable` (`ledger/io.rs` `read`); it is retried at most three times with a
/// short pause while less than 250 ms have passed, then the last answer stands (RE-D164).
/// The read itself keeps its own bounds (`MAX_BYTES`, `MAX_ROWS`).
fn direct_snapshot(
    ledger: &JobLedger,
) -> Result<Vec<crate::text::json::TolerantJsonValue>, EngineError> {
    const RETRIES: usize = 3;
    const PAUSE: Duration = Duration::from_millis(5);
    const BUDGET: Duration = Duration::from_millis(250);
    let started = std::time::Instant::now();
    let mut attempt = 0;
    loop {
        match ledger.snapshot(&Cancel::never()) {
            Err(EngineError::Store(StoreError::Unavailable))
                if attempt < RETRIES && started.elapsed() + PAUSE < BUDGET =>
            {
                attempt += 1;
                std::thread::sleep(PAUSE);
            }
            other => return other.map(|snapshot| snapshot.rows),
        }
    }
}
/// The registry's dry-run answer (`skipped/dry_run_unsupported`), built without a registry,
/// session, ledger or file; the caller supplies its clock readings and run identifier.
pub fn dry_run_report(
    job: JobName,
    agent: &AgentId,
    trigger: JobTrigger,
    started: i64,
    finished: i64,
    id: String,
) -> Result<JobRun, EngineError> {
    record::Draft::new(job, agent.clone(), trigger, started, id)?.finish(
        JobReport {
            outcome: JobOutcome::Skipped,
            reason: Some("dry_run_unsupported".into()),
        },
        &[],
        finished,
        notes::Notes::default(),
    )
}
impl JobRegistry for Registry {
    fn list(&self) -> Vec<JobSpec> {
        super::catalog()
    }
    fn run(
        &self,
        job: JobName,
        agent: &AgentId,
        opts: RunOptions,
        cancel: &Cancel,
    ) -> Result<JobRun, EngineError> {
        self.run_admitted(job, agent, &opts, cancel, cancel)
    }
    fn history(&self, agent: &AgentId, filter: HistoryFilter) -> Result<Vec<JobRun>, EngineError> {
        self.history_inner(agent, &filter)
    }
}
impl Registry {
    /// `JobRegistry::run` with a separate token for the admission window: the agent's slot,
    /// a session start and the durable start marker (with its ledger writer lease) wait at
    /// most until `admit` ends; the body and its settle keep the caller's `cancel` (RE-D164).
    pub fn run_admitted(
        &self,
        job: JobName,
        agent: &AgentId,
        opts: &RunOptions,
        cancel: &Cancel,
        admit: &Cancel,
    ) -> Result<JobRun, EngineError> {
        self.run_inner(job, agent, opts, cancel, admit, None)
    }

    /// Admit an owner-bound job. The grant applies to this job and agent only.
    pub fn run_authorized(
        &self,
        job: JobName,
        agent: &AgentId,
        opts: &RunOptions,
        cancel: &Cancel,
        admit: &Cancel,
        authority: JobAuthority,
    ) -> Result<JobRun, EngineError> {
        if !authority.matches(job, agent) {
            return Err(authority::unbound());
        }
        self.run_inner(job, agent, opts, cancel, admit, Some(authority))
    }

    fn run_inner(
        &self,
        job: JobName,
        agent: &AgentId,
        opts: &RunOptions,
        cancel: &Cancel,
        admit: &Cancel,
        authority: Option<JobAuthority>,
    ) -> Result<JobRun, EngineError> {
        self.check(cancel)?;
        let body = self
            .bodies
            .lock()
            .map_err(|_| StoreError::Corrupt)?
            .get(&job)
            .cloned()
            .ok_or_else(|| EngineError::NotAvailable {
                reason: "not-implemented".into(),
            })?;
        if body.scoped && authority.is_none() {
            return Err(authority::unbound());
        }
        let trigger = opts.trigger.unwrap_or(JobTrigger::Manual);
        let started = (self.clock)();
        let id = (self.ids)();
        if opts.dry_run == Some(true) {
            let run = dry_run_report(job, agent, trigger, started, (self.clock)(), id)?;
            let _ = (self.events)(&run);
            return Ok(run);
        }
        let draft = record::Draft::new(job, agent.clone(), trigger, started, id)?;
        let slot = self.slot(agent)?;
        let sweep = draft.sweep()?;
        let marker = draft.marker()?;
        let admitted = (|| {
            let mut state = lock(&slot, admit)?;
            if state.is_none() {
                let session = self.start_session(agent, admit)?;
                *state = Some(AgentState {
                    session,
                    active: BTreeMap::new(),
                });
            }
            let state = state.as_mut().ok_or(StoreError::Corrupt)?;
            self.check(cancel)?;
            self.check(admit)?;
            let admission = match state.session.start(&marker, admit) {
                Ok(admission) => admission,
                Err(error) => {
                    // The budget can end right after the marker was written: take it back
                    // rather than leave it until the next session start (RE-D164, M1).
                    let _ = state.session.retract(&marker, &self.settle_token());
                    return Err(error);
                }
            };
            // The admission is complete; the snapshot read waits for nothing (caller token).
            let snapshot = match state.session.snapshot(cancel) {
                Ok(snapshot) => Arc::new(snapshot.rows),
                Err(error) => {
                    let _ = state.session.retract(&marker, &self.settle_token());
                    return Err(error);
                }
            };
            let exclusive = matches!(
                job,
                JobName::KnowledgeUpdate
                    | JobName::GcRun
                    | JobName::RemDream
                    | JobName::ConsolidateDaily
                    // C5 / #261: per-agent execution guards, independent of the
                    // public singleton flag used by the scheduler.
                    | JobName::ClassifyRecent
                    | JobName::Afterthought
                    | JobName::PersonaEvolve
                    | JobName::AutoAcceptStale
                    | JobName::EmotionRefine
                    | JobName::ReminderDispatch
            );
            let mut pre_skip = if exclusive && state.active.contains_key(&job) {
                Some("already_running")
            } else {
                None
            };
            if pre_skip.is_none() && record::uses_breaker(job) {
                let inflight = state
                    .active
                    .iter()
                    .filter(|(name, day)| record::uses_breaker(**name) && *day == &sweep)
                    .count();
                if record::sessions(&snapshot, &sweep) + inflight >= 3 {
                    pre_skip = Some("circuit_open");
                }
            }
            let owns = pre_skip.is_none();
            if owns && exclusive {
                state.active.insert(job, sweep.clone());
            }
            Ok::<_, EngineError>((admission, snapshot, owns, pre_skip))
        })();
        // Only the admission phase answers "not started, try later": its own budget ended
        // while the caller did not cancel. Everything after this point is a started run and
        // keeps the registry's own error (RE-D164, review I1).
        let (admission, snapshot, owns, pre_skip) = match admitted {
            Ok(admitted) => admitted,
            Err(EngineError::Cancelled(_)) if admit.is_cancelled() && !cancel.is_cancelled() => {
                return Err(EngineError::NotAvailable {
                    reason: SESSION_BUSY.into(),
                })
            }
            Err(error) => return Err(error),
        };
        let active = ActiveRun {
            slot: slot.clone(),
            job,
            owns,
        };
        // Health reports the run from its durable marker until it is finished (pin `inflightRuns`).
        let _inflight = self.track(agent, job, sweep, owns && record::uses_breaker(job));
        let context = draft.context(snapshot.clone(), cancel.clone(), authority);
        let _notes_guard = notes::Guard(context.notes.clone());
        let report = if owns {
            self.check(cancel)
                .and_then(|()| body.implementation.run(&context, cancel))
                .unwrap_or_else(|_| JobReport {
                    outcome: JobOutcome::Failed,
                    reason: Some(
                        if cancel.is_cancelled() {
                            "aborted"
                        } else {
                            "error:Error"
                        }
                        .into(),
                    ),
                })
        } else {
            JobReport {
                outcome: JobOutcome::Skipped,
                reason: pre_skip.map(str::to_owned),
            }
        };
        let run = draft.finish(report, &snapshot, (self.clock)(), context.notes.freeze()?)?;
        // A cancelled body still needs bounded metadata cleanup; this never executes body work.
        // When it does not finish, the run stays started: its marker remains and the next
        // session start records it (`failed`, `crash`), it is never reported as not started.
        let settle = self.settle_token();
        {
            let state = lock(&slot, &settle)?;
            self.check(&settle)?;
            state.as_ref().ok_or(StoreError::Corrupt)?.session.finish(
                admission,
                &record::persisted(&run)?,
                &settle,
            )?;
        }
        drop(active);
        let _ = (self.events)(&run);
        cancel.check()?;
        Ok(run)
    }
    fn history_inner(
        &self,
        agent: &AgentId,
        filter: &HistoryFilter,
    ) -> Result<Vec<JobRun>, EngineError> {
        self.check(&Cancel::never())?;
        let ledger = JobLedger::open(self.root.path(), &agent.to_string())?;
        let slot = self
            .agents
            .lock()
            .map_err(|_| StoreError::Corrupt)?
            .get::<str>(agent.as_ref())
            .map(|(slot, _)| slot.clone());
        // A read never waits for the agent's slot: while a session start or run holds it, the
        // ledger file is read directly (the snapshot takes no lock either way).
        let session_rows = match slot.as_deref().map(Mutex::try_lock) {
            Some(Ok(state)) => match state.as_ref() {
                Some(state) => Some(state.session.snapshot(&Cancel::never())?.rows),
                None => None,
            },
            Some(Err(std::sync::TryLockError::Poisoned(_))) => {
                return Err(StoreError::Corrupt.into())
            }
            Some(Err(std::sync::TryLockError::WouldBlock)) | None => None,
        };
        let rows = match session_rows {
            Some(rows) => rows,
            None => direct_snapshot(&ledger)?,
        };
        let job = filter.job.map(|j| j.to_string());
        let selected = metadata::history(
            &rows,
            &HistorySelection {
                job: job.as_deref(),
                since: filter.since.as_ref().and_then(serde_json::Number::as_f64),
                limit: filter.limit.as_ref().and_then(serde_json::Number::as_f64),
            },
            &Cancel::never(),
        )?;
        let output = selected
            .iter()
            .map(|row| record::decode(row, agent))
            .collect::<Result<_, _>>()?;
        self.check(&Cancel::never())?;
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "test assertions")]
    use super::*;

    fn agent(name: &str) -> AgentId {
        name.parse().unwrap()
    }

    #[test]
    fn a_slot_in_use_is_never_released_and_idle_ones_are() {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let registry = Registry::new(root.path(), Arc::new(|| 1_768_305_600_000)).unwrap();
        // A run (or a session start, or a history read) holds this slot.
        let held = registry.slot(&agent("held")).unwrap();
        for index in 0..MAX_AGENT_SESSIONS * 2 {
            drop(registry.slot(&agent(&format!("idle-{index}"))).unwrap());
        }
        let agents = registry.agents.lock().unwrap();
        assert!(agents.contains_key("held"), "a slot in use was released");
        assert!(agents.len() <= MAX_AGENT_SESSIONS);
        // The held slot is still the one the map keeps, not a fresh copy.
        assert!(Arc::ptr_eq(&agents["held"].0, &held));
        // The least recently used idle slots went first.
        assert!(!agents.contains_key("idle-0"));
        assert!(agents.contains_key(&format!("idle-{}", MAX_AGENT_SESSIONS * 2 - 1)));
    }

    #[test]
    fn the_health_cache_keeps_at_most_its_bound_and_evicts_the_least_recent() {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let extra = 6;
        for index in 0..MAX_HEALTH_PROJECTIONS + extra {
            let dir = root.path().join(format!("agent-{index:05}"));
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("ledger.jsonl"), "{}\n").unwrap();
        }
        let cache = HealthCache::default();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = reads.clone();
        cache.set_read_hook(Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let health = health_at(root.path(), 1_768_305_600_000, &cache).unwrap();
        assert_eq!(health.agents.len(), MAX_HEALTH_PROJECTIONS + extra);
        assert_eq!(cache.len(), MAX_HEALTH_PROJECTIONS);
        assert_eq!(reads.load(Ordering::SeqCst), MAX_HEALTH_PROJECTIONS + extra);
        // The first agents were evicted: the next call reads them again, still bounded.
        reads.store(0, Ordering::SeqCst);
        health_at(root.path(), 1_768_305_600_000, &cache).unwrap();
        assert!(reads.load(Ordering::SeqCst) >= extra);
        assert_eq!(cache.len(), MAX_HEALTH_PROJECTIONS);
    }
}
