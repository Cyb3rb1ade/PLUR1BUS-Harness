//! Bounded LanceDB fragment compaction after capture (RE-D161), the port of the pin's
//! `engine/store/fragment-compactor.js` (`9f34008c`, cited below as `FC:<line>`).
//!
//! Every stored capture row is a new fragment. The compactor counts table writes per agent,
//! checks the agent table's fragment count every `checkEveryWrites` writes and every
//! `checkIntervalMs`, and compacts the table once it has `fragmentThreshold` fragments.
//! Capture only notes its writes; the check runs detached on one worker, one at a time, as
//! the pin's FIFO chain (FC:110, FC:201). Native bounds beyond the pin (RE-D161): the
//! per-agent state is bounded, a running step is cancelled by close and dropped at its
//! budget, and the table work runs on its own store handle, so it never holds the handle
//! that capture and recall of the agent use.
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::lance::fragment_optimize::OptimizeRun;
use super::{OpenMode, Store, StorePool};
use crate::contract::Cancel;

/// `runtime.lancedbCompaction`, validated and merged over the pin's defaults (FC:26-39, 58-68).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompactionSettings {
    /// FC:27, default `true`; the only off switch.
    pub enabled: bool,
    /// FC:28, default 64, minimum 8 (FC:35).
    pub fragment_threshold: u64,
    /// FC:29, default 16, minimum 1 (FC:36).
    pub check_every_writes: u64,
    /// FC:30, default 600 000 ms, minimum 60 000 (FC:37).
    pub check_interval_ms: u64,
    /// FC:31, default 60 000 ms, minimum 10 000 (FC:38).
    pub timeout_ms: u64,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            fragment_threshold: 64,
            check_every_writes: 16,
            check_interval_ms: 600_000,
            timeout_ms: 60_000,
        }
    }
}

/// `Number.isInteger(value) && value >= minimum` (FC:65).
fn integer_at_least(value: Option<&Value>, minimum: u64) -> Option<u64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number >= minimum as f64)
        .then_some(number as u64)
}

impl CompactionSettings {
    /// `resolveLancedbCompaction(raw)` (FC:58-68): a non-object is empty, a non-boolean
    /// `enabled` and an out-of-range or non-integer value take the default.
    #[must_use]
    pub fn resolve(raw: &Value) -> Self {
        let defaults = Self::default();
        let Some(source) = raw.as_object() else {
            return defaults;
        };
        Self {
            enabled: source
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.enabled),
            fragment_threshold: integer_at_least(source.get("fragmentThreshold"), 8)
                .unwrap_or(defaults.fragment_threshold),
            check_every_writes: integer_at_least(source.get("checkEveryWrites"), 1)
                .unwrap_or(defaults.check_every_writes),
            check_interval_ms: integer_at_least(source.get("checkIntervalMs"), 60_000)
                .unwrap_or(defaults.check_interval_ms),
            timeout_ms: integer_at_least(source.get("timeoutMs"), 10_000)
                .unwrap_or(defaults.timeout_ms),
        }
    }
}

/// `lib/lancedb-optimize.js:13`: the version retention when none is configured.
const DEFAULT_KEEP_VERSIONS_HOURS: f64 = 24.0;
/// `lib/lancedb-optimize.js:14`.
const MIN_KEEP_VERSIONS_HOURS: f64 = 1.0;

/// JavaScript `Number(value)` for the JSON values a configuration can hold; `None` is NaN.
fn js_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(f64::from(*value)),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse().ok()
            }
        }
        _ => None,
    }
}

/// `resolveLancedbOptimizePlan(dailyConsolidation.lancedbOptimize).keepVersionsHours`
/// (`lib/lancedb-optimize.js:24-28`), as `create-engine.js:1585` hands it to the compactor.
#[must_use]
pub fn keep_versions_hours(raw: &Value) -> f64 {
    let source = raw
        .as_object()
        .map(|object| object.get("keepVersionsHours"));
    match js_number(source.flatten()) {
        Some(hours) if hours.is_finite() && hours >= MIN_KEEP_VERSIONS_HOURS => hours,
        _ => DEFAULT_KEEP_VERSIONS_HOURS,
    }
}

/// `clock() - new Date(clock() - keepHours * 3_600_000)` (FC:146): how far back versions
/// are kept, in whole milliseconds (the Date value drops the fraction toward the past).
#[must_use]
pub fn cleanup_ago_ms(keep_hours: f64) -> i64 {
    let keep = if keep_hours.is_finite() && keep_hours > 0.0 {
        keep_hours
    } else {
        DEFAULT_KEEP_VERSIONS_HOURS // FC:101
    };
    (keep * 3_600_000.0).ceil() as i64
}

/// What one optimize is asked to do (FC:145-152).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OptimizePlan {
    /// Versions older than this many milliseconds are pruned.
    pub cleanup_ago_ms: i64,
    /// The whole run's budget (`timeoutMs`).
    pub timeout_ms: u64,
    /// FC:148: three attempts against commit conflicts.
    pub max_attempts: u32,
    /// FC:149: one second before the first retry.
    pub retry_delay_ms: u64,
}

/// A table's answer to one optimize (the pin's `optimizeTable` result shape, FC:84).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptimizeResult {
    /// `{ ok: true }`.
    Compacted,
    /// `{ busy: true }`: another optimize of the same table runs (`ifBusy: "skip"`).
    Busy,
    /// `{ reason: "no-table" }`.
    NoTable,
    /// `{ reason: "shutdown" }`: the engine is closing.
    Shutdown,
    /// `{ conflict: true }`: every attempt lost to concurrent writes.
    Conflict(String),
    /// Any other failure, with its reason (`None`: the pin's `"unknown"`, FC:169).
    Failed(Option<String>),
}

/// Fragment statistics and compaction of one agent's table.
pub trait FragmentTables: Send + Sync {
    /// The agent table's fragment count; `None` when unknown (FC:125-132).
    fn fragment_count(&self, agent: &str, cancel: &Cancel) -> Option<u64>;
    /// Optimize the agent table under the plan's budget and `cancel`.
    fn optimize(&self, agent: &str, plan: &OptimizePlan, cancel: &Cancel) -> OptimizeResult;
}

/// The result of one check (the pin's `CompactionOutcome`, FC:70-78, without `ms`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// `"skipped"`, `"compacted"` or `"failed"`.
    pub action: &'static str,
    /// Why it was skipped or failed.
    pub reason: Option<String>,
    /// The count before the check, when known.
    pub fragments_before: Option<u64>,
    /// The count after a compaction, when known.
    pub fragments_after: Option<u64>,
}

impl Outcome {
    fn skipped(reason: &str, before: Option<u64>) -> Self {
        Self {
            action: "skipped",
            reason: Some(reason.to_owned()),
            fragments_before: before,
            fragments_after: None,
        }
    }
}

/// What a check logs (FC:176-188). Messages name the agent as the pin does, never a path or backend text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompactionLog {
    /// Debug: lost to concurrent writes, retried at the next check.
    ConflictRetry,
    /// Warn: lost to concurrent writes this many checks in a row (from five on, FC:49).
    ConflictStreak(u32),
    /// Warn: optimize failed with this reason.
    Failed(String),
}

/// FC:49: consecutive conflict-only failures before a warning.
const CONFLICT_WARN_THRESHOLD: u32 = 5;
/// RE-D161: agents tracked at once; the pin keeps every agent it ever saw (FC:103-107).
pub const MAX_TRACKED_AGENTS: usize = 1024;

#[derive(Clone, Copy, Default)]
struct AgentState {
    /// FC:103: writes since the last compaction, the stand-in when stats are unknown.
    since: u64,
    /// FC:105: all writes; the timer checks every agent that has one.
    total: u64,
    /// FC:107: consecutive conflict-only failures.
    conflicts: u32,
    /// First-write order: the pin's `Map` iterates its keys in insertion order (FC:223).
    first: u64,
    /// Last write, for the bound on tracked agents.
    last: u64,
}

/// The pin's per-agent counters and decisions, without any I/O.
pub struct CompactorCore {
    settings: CompactionSettings,
    plan: OptimizePlan,
    agents: HashMap<String, AgentState>,
    clock: u64,
    closed: bool,
}

impl CompactorCore {
    /// The compactor for `runtime.lancedbCompaction` and the plan's retention in hours.
    #[must_use]
    pub fn new(settings: CompactionSettings, keep_hours: f64) -> Self {
        Self {
            plan: OptimizePlan {
                cleanup_ago_ms: cleanup_ago_ms(keep_hours),
                timeout_ms: settings.timeout_ms,
                max_attempts: 3,
                retry_delay_ms: 1_000,
            },
            settings,
            agents: HashMap::new(),
            clock: 0,
            closed: false,
        }
    }

    /// From the effective engine configuration (`create-engine.js:1580-1586`).
    #[must_use]
    pub fn from_config(config: &Value) -> Self {
        Self::new(
            CompactionSettings::resolve(&config["runtime"]["lancedbCompaction"]),
            keep_versions_hours(&config["dailyConsolidation"]["lancedbOptimize"]),
        )
    }

    /// The validated settings.
    #[must_use]
    pub fn settings(&self) -> CompactionSettings {
        self.settings
    }

    /// The plan every optimize is asked to follow.
    #[must_use]
    pub fn plan(&self) -> &OptimizePlan {
        &self.plan
    }

    /// No check runs and no write is counted any more (FC:237-244).
    pub fn close(&mut self) {
        self.closed = true;
    }

    /// Whether `close` was called.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Count `writes` table writes of one capture (`capture-turn.js:768-772` calls
    /// `noteWrite` once per stored row); true when a check is due (FC:228-235). Several
    /// due points within one capture schedule one check, as the pin's in-flight entry
    /// absorbs the rest (FC:196-200).
    pub fn note_writes(&mut self, agent: &str, writes: u64) -> bool {
        if self.closed || !self.settings.enabled || agent.is_empty() || writes == 0 {
            return false;
        }
        let every = self.settings.check_every_writes.max(1);
        self.state(agent);
        let clock = self.tick();
        let state = self.state(agent);
        state.last = clock;
        if state.total == 0 {
            // The timer's order is the first write's (FC:105, 223).
            state.first = clock;
        }
        let before = state.total;
        state.since = state.since.saturating_add(writes);
        state.total = state.total.saturating_add(writes);
        state.total / every > before / every
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The agent's counters, created on first use (the pin's maps create their entries on
    /// the first `set`, FC:164-165, 177, 186, 231-233). At the bound the agent whose last
    /// activity is oldest is forgotten first (RE-D161).
    fn state(&mut self, agent: &str) -> &mut AgentState {
        if !self.agents.contains_key(agent) {
            if self.agents.len() >= MAX_TRACKED_AGENTS {
                self.evict_idle();
            }
            let clock = self.tick();
            self.agents.insert(
                agent.to_owned(),
                AgentState {
                    first: clock,
                    last: clock,
                    ..AgentState::default()
                },
            );
        }
        self.agents
            .get_mut(agent)
            .unwrap_or_else(|| unreachable!("inserted above"))
    }

    /// RE-D161: forget the agent whose last activity is oldest.
    fn evict_idle(&mut self) {
        if let Some(oldest) = self
            .agents
            .iter()
            .min_by_key(|(_, state)| state.last)
            .map(|(agent, _)| agent.clone())
        {
            self.agents.remove(&oldest);
        }
    }

    /// The agents the timer checks, in first-write order (FC:221-224).
    #[must_use]
    pub fn timer_agents(&self) -> Vec<String> {
        if self.closed || !self.settings.enabled {
            return Vec::new();
        }
        let mut agents = self
            .agents
            .iter()
            .filter(|(_, state)| state.total > 0)
            .map(|(agent, state)| (state.first, agent.clone()))
            .collect::<Vec<_>>();
        agents.sort();
        agents.into_iter().map(|(_, agent)| agent).collect()
    }

    /// How many agents are tracked.
    #[must_use]
    pub fn tracked(&self) -> usize {
        self.agents.len()
    }

    /// Whether to optimize: the count, or the writes since the last compaction when the
    /// count is unknown, reached the threshold (FC:137-141).
    #[must_use]
    pub fn due(&self, agent: &str, count: Option<u64>) -> bool {
        let n = count.unwrap_or_else(|| self.agents.get(agent).map_or(0, |state| state.since));
        n >= self.settings.fragment_threshold
    }

    /// Record an optimize result and say what the check reports and logs (FC:163-189).
    pub fn settle(
        &mut self,
        agent: &str,
        before: Option<u64>,
        result: OptimizeResult,
    ) -> (Outcome, Option<CompactionLog>) {
        let failed = |reason: String| Outcome {
            action: "failed",
            reason: Some(reason),
            fragments_before: before,
            fragments_after: None,
        };
        match result {
            OptimizeResult::Compacted => {
                let state = self.state(agent);
                state.since = 0;
                state.conflicts = 0;
                (
                    Outcome {
                        action: "compacted",
                        reason: None,
                        fragments_before: before,
                        fragments_after: None,
                    },
                    None,
                )
            }
            OptimizeResult::Busy => (Outcome::skipped("busy", before), None),
            OptimizeResult::NoTable => (Outcome::skipped("no-table", before), None),
            OptimizeResult::Shutdown => (Outcome::skipped("closed", before), None),
            OptimizeResult::Conflict(reason) => {
                let state = self.state(agent);
                state.conflicts = state.conflicts.saturating_add(1);
                let streak = state.conflicts;
                let log = if streak >= CONFLICT_WARN_THRESHOLD {
                    CompactionLog::ConflictStreak(streak)
                } else {
                    CompactionLog::ConflictRetry
                };
                (failed(reason), Some(log))
            }
            OptimizeResult::Failed(reason) => {
                self.state(agent).conflicts = 0;
                let reason = reason.unwrap_or_else(|| "unknown".to_owned());
                (failed(reason.clone()), Some(CompactionLog::Failed(reason)))
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One scheduled check (`schedule` and `runCheck`, FC:134-208), with the counters behind
/// `core`. The lock is held only between port calls. `cancel` ends a running step.
pub fn check(
    core: &Mutex<CompactorCore>,
    tables: &dyn FragmentTables,
    agent: &str,
    cancel: &Cancel,
) -> (Outcome, Option<CompactionLog>) {
    check_with(core, tables, agent, cancel, true)
}

/// `check`, with the count after a compaction only when `recount` (the pin reports it in
/// the outcome; the worker discards the outcome, so it skips the extra handle, RE-D161 M8).
fn check_with(
    core: &Mutex<CompactorCore>,
    tables: &dyn FragmentTables,
    agent: &str,
    cancel: &Cancel,
    recount: bool,
) -> (Outcome, Option<CompactionLog>) {
    let (plan, enabled) = {
        let core = lock(core);
        if core.closed || cancel.is_cancelled() {
            return (Outcome::skipped("closed", None), None);
        }
        (core.plan.clone(), core.settings.enabled)
    };
    if !enabled {
        return (Outcome::skipped("disabled", None), None);
    }
    let before = tables.fragment_count(agent, cancel);
    {
        let core = lock(core);
        if core.closed || cancel.is_cancelled() {
            return (Outcome::skipped("closed", before), None);
        }
        if !core.due(agent, before) {
            return (Outcome::skipped("below-threshold", before), None);
        }
    }
    let result = tables.optimize(agent, &plan, cancel);
    let (mut outcome, log) = lock(core).settle(agent, before, result);
    if recount && outcome.action == "compacted" {
        outcome.fragments_after = tables.fragment_count(agent, cancel);
    }
    (outcome, log)
}

/// The log line of a check, naming the agent as the pin does (FC:180,183,187) and nothing
/// else: no path, no backend text (the reason is one of `timeout|backend|open|conflict`).
fn message(agent: &str, log: &CompactionLog) -> (log::Level, String) {
    match log {
        CompactionLog::ConflictRetry => (
            log::Level::Debug,
            format!("compaction: optimize for '{agent}' lost to concurrent writes, retrying at the next check"),
        ),
        CompactionLog::ConflictStreak(streak) => (
            log::Level::Warn,
            format!("compaction: optimize for '{agent}' has lost to concurrent writes {streak} checks in a row, table may not be compacting"),
        ),
        CompactionLog::Failed(reason) => (
            log::Level::Warn,
            format!("compaction: optimize failed for '{agent}': {reason}"),
        ),
    }
}

fn emit(agent: &str, log: Option<CompactionLog>) {
    if let Some(log) = log {
        let (level, text) = message(agent, &log);
        log::log!(level, "{text}");
    }
}

#[derive(Default)]
struct Queue {
    /// Agents waiting for their check, in order.
    pending: VecDeque<String>,
    /// Agents queued or being checked: one check per agent at a time (FC:196-200).
    flight: HashSet<String>,
    started: bool,
    stopping: bool,
    finished: bool,
}

struct Inner {
    core: Mutex<CompactorCore>,
    queue: Mutex<Queue>,
    changed: Condvar,
    tables: Arc<dyn FragmentTables>,
    cancel: Cancel,
    worker: Mutex<Option<JoinHandle<()>>>,
    /// Count again after a compaction (fixtures only; production discards the outcome).
    recount: AtomicBool,
    /// The timer interval when a fixture sets one; otherwise `checkIntervalMs`.
    interval: Mutex<Option<Duration>>,
}

/// The process's fragment compactor: capture notes writes; one worker runs the checks.
pub struct FragmentCompactor {
    inner: Arc<Inner>,
}

impl FragmentCompactor {
    /// Compose a compactor; `cancel` is the engine's shutdown signal. No thread starts
    /// before the first due check.
    #[must_use]
    pub fn new(core: CompactorCore, tables: Arc<dyn FragmentTables>, cancel: Cancel) -> Self {
        Self {
            inner: Arc::new(Inner {
                core: Mutex::new(core),
                queue: Mutex::new(Queue::default()),
                changed: Condvar::new(),
                tables,
                cancel,
                worker: Mutex::new(None),
                recount: AtomicBool::new(false),
                interval: Mutex::new(None),
            }),
        }
    }

    /// Fixtures: count again after each compaction, as `check` reports it.
    #[cfg(any(test, feature = "testkit"))]
    #[must_use]
    pub fn with_recount(self) -> Self {
        self.inner.recount.store(true, AtomicOrdering::Release);
        self
    }

    /// Fixtures: a timer interval below the configuration minimum (set before the first write).
    #[cfg(any(test, feature = "testkit"))]
    #[must_use]
    pub fn with_check_interval(self, interval: Duration) -> Self {
        *lock(&self.inner.interval) = Some(interval);
        self
    }

    /// The compactor over a writer pool's agent tables.
    #[must_use]
    pub fn for_pool(config: &Value, pool: Arc<StorePool>, cancel: Cancel) -> Self {
        Self::new(
            CompactorCore::from_config(config),
            Arc::new(PoolTables { pool }),
            cancel,
        )
    }

    /// Note `writes` stored rows of one capture for `agent`. Never waits for a check: a
    /// due check is queued for the worker and the caller goes on (`capture-turn.js:768-772`,
    /// FC:213-217).
    pub fn note_writes(&self, agent: &str, writes: u64) {
        if self.inner.cancel.is_cancelled() {
            return;
        }
        let due = lock(&self.inner.core).note_writes(agent, writes);
        if due {
            self.enqueue([agent.to_owned()]);
        } else if writes > 0 && lock(&self.inner.core).settings.enabled {
            // The timer belongs to the worker; start it with the first write (FC:219-226).
            self.ensure_worker();
        }
    }

    fn enqueue(&self, agents: impl IntoIterator<Item = String>) {
        {
            let mut queue = lock(&self.inner.queue);
            if queue.stopping {
                return;
            }
            for agent in agents {
                if queue.flight.insert(agent.clone()) {
                    queue.pending.push_back(agent);
                }
            }
        }
        self.inner.changed.notify_all();
        self.ensure_worker();
    }

    fn ensure_worker(&self) {
        let mut queue = lock(&self.inner.queue);
        if queue.started || queue.stopping {
            return;
        }
        queue.started = true;
        drop(queue);
        let inner = self.inner.clone();
        let spawned = std::thread::Builder::new()
            .name("fragment-compaction".into())
            .spawn(move || work(&inner));
        match spawned {
            Ok(handle) => *lock(&self.inner.worker) = Some(handle),
            Err(_) => {
                let mut queue = lock(&self.inner.queue);
                queue.started = false;
                queue.pending.clear();
                queue.flight.clear();
            }
        }
    }

    /// Start no check and count no write any more; a running step ends at its next
    /// cancellation check once the engine's shutdown signal is raised.
    pub fn close(&self) {
        lock(&self.inner.core).close();
        let mut queue = lock(&self.inner.queue);
        queue.stopping = true;
        queue.pending.clear();
        if !queue.started {
            queue.finished = true;
        }
        drop(queue);
        self.inner.changed.notify_all();
    }

    /// Wait within `budget` until the worker has ended; false when it is still running.
    pub fn join(&self, budget: Duration) -> bool {
        let end = Instant::now() + budget;
        let mut queue = lock(&self.inner.queue);
        while queue.started && !queue.finished {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            queue = self
                .inner
                .changed
                .wait_timeout(queue, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        drop(queue);
        if let Some(handle) = lock(&self.inner.worker).take() {
            let _ = handle.join();
        }
        true
    }

    /// Test support: how many agents are tracked and how many checks are queued or running.
    #[must_use]
    pub fn load(&self) -> (usize, usize) {
        let tracked = lock(&self.inner.core).tracked();
        (tracked, lock(&self.inner.queue).flight.len())
    }
}

impl Drop for FragmentCompactor {
    fn drop(&mut self) {
        self.close();
    }
}

/// Marks the worker finished however it leaves (also by a panic in a port).
struct Finished<'a>(&'a Inner);
impl Drop for Finished<'_> {
    fn drop(&mut self) {
        let mut queue = lock(&self.0.queue);
        queue.finished = true;
        queue.pending.clear();
        queue.flight.clear();
        drop(queue);
        self.0.changed.notify_all();
    }
}

fn work(inner: &Inner) {
    let _finished = Finished(inner);
    let interval = lock(&inner.interval)
        .unwrap_or_else(|| Duration::from_millis(lock(&inner.core).settings.check_interval_ms));
    let mut next_tick = Instant::now() + interval;
    loop {
        let agent = {
            let mut queue = lock(&inner.queue);
            loop {
                if queue.stopping || inner.cancel.is_cancelled() {
                    return;
                }
                // The timer fires on time also while checks are queued, as the pin's
                // `setInterval` does (RE-D161, M6); its agents join the end of the queue.
                if Instant::now() >= next_tick {
                    break None;
                }
                if let Some(agent) = queue.pending.pop_front() {
                    break Some(agent);
                }
                let left = next_tick.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break None;
                }
                queue = inner
                    .changed
                    .wait_timeout(queue, left)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
        };
        let Some(agent) = agent else {
            next_tick = Instant::now() + interval;
            let agents = lock(&inner.core).timer_agents();
            let mut queue = lock(&inner.queue);
            for agent in agents {
                if queue.flight.insert(agent.clone()) {
                    queue.pending.push_back(agent);
                }
            }
            continue;
        };
        let recount = inner.recount.load(AtomicOrdering::Acquire);
        let (_, log) = check_with(
            &inner.core,
            inner.tables.as_ref(),
            &agent,
            &inner.cancel,
            recount,
        );
        emit(&agent, log);
        lock(&inner.queue).flight.remove(&agent);
        inner.changed.notify_all();
    }
}

/// Process-wide: the tables being optimized now (the pin's per-path lock, `ifBusy: "skip"`,
/// `lib/db-adapter.js:921-923`).
static OPTIMIZING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

struct Optimizing(PathBuf);
impl Optimizing {
    fn claim(path: PathBuf) -> Option<Self> {
        let mut running = lock(&OPTIMIZING);
        if running.contains(&path) {
            return None;
        }
        running.push(path.clone());
        Some(Self(path))
    }
}
impl Drop for Optimizing {
    fn drop(&mut self) {
        lock(&OPTIMIZING).retain(|path| path != &self.0);
    }
}

/// The agent tables of a writer pool. Each step opens its own handle (own runtime thread),
/// so a slow compaction never queues behind, or in front of, the pool handle that capture
/// and recall of the agent use (the pin's stats-only tables, `lib/db-adapter.js:1041-1060`).
struct PoolTables {
    pool: Arc<StorePool>,
}

impl PoolTables {
    fn table(&self, agent: &str) -> Option<PathBuf> {
        let path = self.pool.agent_path(agent).ok()?;
        self.pool.check_roots().ok()?;
        path.join("memories.lance").is_dir().then_some(path)
    }
}

impl FragmentTables for PoolTables {
    fn fragment_count(&self, agent: &str, cancel: &Cancel) -> Option<u64> {
        if cancel.is_cancelled() {
            return None;
        }
        let path = self.table(agent)?;
        // Opening and the stats read share the pin's five seconds (RE-D161, M1).
        super::lance::fragment_optimize::count_within(
            super::lance::fragment_optimize::FRAGMENT_COUNT_BUDGET,
            cancel,
            move |cancel| {
                Store::open(&path, OpenMode::ReadOnly, None)
                    .ok()?
                    .fragment_count(cancel)
            },
        )
    }

    fn optimize(&self, agent: &str, plan: &OptimizePlan, cancel: &Cancel) -> OptimizeResult {
        if cancel.is_cancelled() {
            return OptimizeResult::Shutdown;
        }
        let Some(path) = self.table(agent) else {
            return OptimizeResult::NoTable;
        };
        let Some(_claim) = Optimizing::claim(path.clone()) else {
            return OptimizeResult::Busy;
        };
        let store = match Store::open(&path, OpenMode::ReadWrite, None) {
            Ok(store) => store,
            Err(_) => return OptimizeResult::Failed(Some("open".into())),
        };
        match store.optimize_fragments(plan, cancel) {
            OptimizeRun::Compacted => OptimizeResult::Compacted,
            OptimizeRun::Conflict => OptimizeResult::Conflict("conflict".into()),
            OptimizeRun::Cancelled => OptimizeResult::Shutdown,
            OptimizeRun::TimedOut => OptimizeResult::Failed(Some("timeout".into())),
            OptimizeRun::Failed => OptimizeResult::Failed(Some("backend".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "test assertions")]
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counted {
        count: Option<u64>,
        optimized: AtomicUsize,
    }
    impl FragmentTables for Counted {
        fn fragment_count(&self, _agent: &str, _cancel: &Cancel) -> Option<u64> {
            self.count
        }
        fn optimize(&self, _agent: &str, _plan: &OptimizePlan, _cancel: &Cancel) -> OptimizeResult {
            self.optimized.fetch_add(1, Ordering::SeqCst);
            OptimizeResult::Compacted
        }
    }

    fn settings(enabled: bool) -> CompactionSettings {
        CompactionSettings::resolve(&serde_json::json!({
            "enabled": enabled, "fragmentThreshold": 8, "checkEveryWrites": 4,
        }))
    }

    fn wait(what: &str, done: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < end, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn below_the_threshold_nothing_is_optimized_and_at_it_exactly_once() {
        let below = Arc::new(Counted {
            count: Some(7),
            optimized: AtomicUsize::new(0),
        });
        let compactor = FragmentCompactor::new(
            CompactorCore::new(settings(true), 24.0),
            below.clone(),
            Cancel::never(),
        );
        compactor.note_writes("a", 8);
        wait("checks done", || compactor.load().1 == 0);
        assert_eq!(below.optimized.load(Ordering::SeqCst), 0);
        let due = Arc::new(Counted {
            count: Some(8),
            optimized: AtomicUsize::new(0),
        });
        let compactor = FragmentCompactor::new(
            CompactorCore::new(settings(true), 24.0),
            due.clone(),
            Cancel::never(),
        );
        compactor.note_writes("a", 3);
        compactor.note_writes("a", 1);
        wait("one compaction", || {
            due.optimized.load(Ordering::SeqCst) == 1
        });
        wait("checks done", || compactor.load().1 == 0);
        assert_eq!(due.optimized.load(Ordering::SeqCst), 1);
        compactor.close();
        assert!(compactor.join(Duration::from_secs(5)));
    }

    #[test]
    fn a_disabled_or_closed_compactor_starts_no_thread_and_counts_nothing() {
        let tables = Arc::new(Counted {
            count: Some(100),
            optimized: AtomicUsize::new(0),
        });
        let off = FragmentCompactor::new(
            CompactorCore::new(settings(false), 24.0),
            tables.clone(),
            Cancel::never(),
        );
        off.note_writes("a", 100);
        assert_eq!(off.load(), (0, 0));
        assert!(off.join(Duration::ZERO));
        let shutdown = Cancel::never();
        let closed = FragmentCompactor::new(
            CompactorCore::new(settings(true), 24.0),
            tables.clone(),
            shutdown.clone(),
        );
        closed.close();
        closed.note_writes("a", 100);
        shutdown.cancel();
        closed.note_writes("b", 100);
        assert_eq!(closed.load(), (0, 0));
        assert!(closed.join(Duration::ZERO));
        assert_eq!(tables.optimized.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn tracked_agents_stay_bounded_and_the_least_recent_is_forgotten() {
        let mut core = CompactorCore::new(settings(true), 24.0);
        for index in 0..MAX_TRACKED_AGENTS + 10 {
            core.note_writes(&format!("agent-{index}"), 1);
        }
        assert_eq!(core.tracked(), MAX_TRACKED_AGENTS);
        let agents = core.timer_agents();
        assert!(!agents.contains(&"agent-0".to_owned()));
        assert!(agents.contains(&format!("agent-{}", MAX_TRACKED_AGENTS + 9)));
        // Settling a check for an unknown agent stays within the bound too.
        core.settle("late", None, OptimizeResult::Conflict(String::new()));
        assert_eq!(core.tracked(), MAX_TRACKED_AGENTS);
    }

    /// Counts every fragment count and optimize.
    struct Probe {
        counts: AtomicUsize,
        optimized: AtomicUsize,
    }
    impl FragmentTables for Probe {
        fn fragment_count(&self, _agent: &str, _cancel: &Cancel) -> Option<u64> {
            self.counts.fetch_add(1, Ordering::SeqCst);
            Some(100)
        }
        fn optimize(&self, _agent: &str, _plan: &OptimizePlan, _cancel: &Cancel) -> OptimizeResult {
            self.optimized.fetch_add(1, Ordering::SeqCst);
            OptimizeResult::Compacted
        }
    }
    fn probe() -> Arc<Probe> {
        Arc::new(Probe {
            counts: AtomicUsize::new(0),
            optimized: AtomicUsize::new(0),
        })
    }

    #[test]
    fn the_worker_does_not_count_again_after_a_compaction_unless_asked() {
        for (recount, expected) in [(false, 1), (true, 2)] {
            let tables = probe();
            let mut compactor = FragmentCompactor::new(
                CompactorCore::new(settings(true), 24.0),
                tables.clone(),
                Cancel::never(),
            );
            if recount {
                compactor = compactor.with_recount();
            }
            compactor.note_writes("a", 4);
            wait("one compaction", || {
                tables.optimized.load(Ordering::SeqCst) == 1
            });
            wait("checks done", || compactor.load().1 == 0);
            assert_eq!(tables.counts.load(Ordering::SeqCst), expected);
            compactor.close();
            assert!(compactor.join(Duration::from_secs(5)));
        }
    }

    #[test]
    fn the_timer_checks_a_tracked_agent_below_the_write_count() {
        let tables = probe();
        let compactor = FragmentCompactor::new(
            CompactorCore::new(settings(true), 24.0),
            tables.clone(),
            Cancel::never(),
        )
        .with_check_interval(Duration::from_millis(20));
        // One write: not a due point (every four writes), but the timer covers the agent.
        compactor.note_writes("a", 1);
        wait("timer compaction", || {
            tables.optimized.load(Ordering::SeqCst) >= 1
        });
        compactor.close();
        assert!(compactor.join(Duration::from_secs(5)));
    }

    #[test]
    fn log_lines_name_the_agent_and_nothing_else() {
        let cases = [
            (CompactionLog::ConflictRetry, log::Level::Debug),
            (CompactionLog::ConflictStreak(5), log::Level::Warn),
            (CompactionLog::Failed("timeout".into()), log::Level::Warn),
        ];
        for (entry, level) in cases {
            let (actual, text) = message("agent-7", &entry);
            assert_eq!(actual, level);
            assert!(text.contains("'agent-7'"), "{text}");
            assert!(!text.contains('/'), "{text}");
        }
    }
}
