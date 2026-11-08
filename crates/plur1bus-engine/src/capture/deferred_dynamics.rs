//! Per-agent deferred reply-outcome dynamics, ported from the pinned queue.
//!
//! Recall kicks a lane; a cancellable fallback starts otherwise. Waiting work drops
//! oldest at the backlog cap; running work is retained. `close` stops admission and
//! timers, while `drain` remains available to settle queued/running work on shutdown.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::{
    contract::{Cancel, EngineError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};

/// Process singleton key shared by capture and recall instances at the Node pin.
pub const SHARED_DYNAMICS_QUEUE_KEY: &str = "plur1bus.deferredDynamics.v1";

#[path = "deferred_options.rs"]
mod options;
pub use options::DeferredOptions;

#[path = "deferred_workers.rs"]
mod workers;

const MAX_BACKLOG: usize = 1024;
const MAX_WAITING: usize = 4096;
const MAX_AGENT_BYTES: usize = 128;

type Job = Box<dyn FnOnce() -> Result<(), EngineError> + Send>;
struct Timer {
    cancelled: Mutex<bool>,
    changed: Condvar,
}
impl Timer {
    fn new() -> Self {
        Self {
            cancelled: Mutex::new(false),
            changed: Condvar::new(),
        }
    }
    fn cancel(&self) {
        *lock(&self.cancelled) = true;
        self.changed.notify_all();
    }
}

struct Lane {
    key: String,
    jobs: VecDeque<Job>,
    running: bool,
    timer: Option<Arc<Timer>>,
    dropped: usize,
}

#[derive(Default)]
struct State {
    lanes: Vec<Lane>,
    closed: bool,
    failures: usize,
}
struct Inner {
    options: DeferredOptions,
    state: Mutex<State>,
    changed: Condvar,
    controlled: bool,
    lane_limit: usize,
    timers: Mutex<Vec<JoinHandle<()>>>,
    workers: Mutex<Vec<(String, JoinHandle<()>)>>,
}

/// Cloneable process-local FIFO lanes with explicit shutdown and drain operations.
#[derive(Clone)]
pub struct DeferredDynamicsQueue(Arc<Inner>);

impl DeferredDynamicsQueue {
    /// Construct an independent queue with real cancellable fallback timers.
    #[must_use]
    pub fn new(options: DeferredOptions) -> Self {
        Self::build(options, false)
    }

    /// Constructor with deterministic injected fallback delivery for parity tests.
    #[cfg(any(test, feature = "testkit"))]
    #[must_use]
    pub fn new_controlled(options: DeferredOptions) -> Self {
        Self::build(options, true)
    }

    fn build(mut options: DeferredOptions, controlled: bool) -> Self {
        if options.max_backlog == 0.0 || options.max_backlog.is_nan() {
            options.max_backlog = 20.0;
        }
        options.max_backlog = options.max_backlog.clamp(1.0, 1024.0);
        if options.fallback_delay.as_millis() > 2_147_483_647 {
            options.fallback_delay = Duration::from_millis(1);
        }
        Self(Arc::new(Inner {
            options,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            controlled,
            lane_limit: std::thread::available_parallelism()
                .map_or(2, std::num::NonZeroUsize::get)
                .saturating_mul(2)
                .clamp(4, 64),
            timers: Mutex::new(Vec::new()),
            workers: Mutex::new(Vec::new()),
        }))
    }

    /// Enqueue without waiting for the callback. An empty agent routes to `default`.
    /// Closed queues reject; a full lane drops its oldest waiting callback.
    /// Native resource limits reject excess lanes, total waiting jobs and oversized keys.
    /// Callbacks must retain and revalidate their original authority before effects.
    pub fn enqueue(
        &self,
        agent: &str,
        run: impl FnOnce() -> Result<(), EngineError> + Send + 'static,
    ) -> bool {
        let key = key(agent);
        let mut state = lock(&self.0.state);
        if state.closed || key.len() > MAX_AGENT_BYTES {
            return false;
        }
        let existing = state.lanes.iter().find(|lane| lane.key == key);
        if existing.is_none() && state.lanes.len() >= self.0.lane_limit {
            return false;
        }
        // At the global cap, replacement within an already full lane is still allowed.
        let replacing = existing.is_some_and(|lane| {
            lane.jobs.len() >= MAX_BACKLOG
                || usize_as_number(lane.jobs.len() + 1) > self.0.options.max_backlog
        });
        if !replacing
            && state
                .lanes
                .iter()
                .map(|lane| lane.jobs.len())
                .sum::<usize>()
                >= MAX_WAITING
        {
            return false;
        }
        self.reap_finished();
        let needs_timer = self.0.options.fallback_enabled
            && !self.0.options.fallback_delay.is_zero()
            && state
                .lanes
                .iter()
                .find(|lane| lane.key == key)
                .is_none_or(|lane| !lane.running && lane.timer.is_none());
        if needs_timer && lock(&self.0.timers).len() >= 2 * self.0.lane_limit {
            return false;
        }
        let lane = lane(&mut state, key);
        lane.jobs.push_back(Box::new(run));
        trim(lane, self.0.options.max_backlog);
        let mut timer = None;
        let first = if !lane.running
            && self.0.options.fallback_enabled
            && self.0.options.fallback_delay.is_zero()
        {
            take_work(lane)
        } else {
            if !lane.running && self.0.options.fallback_enabled && lane.timer.is_none() {
                let created = Arc::new(Timer::new());
                lane.timer = Some(created.clone());
                timer = Some(created);
            }
            None
        };
        if let Some(first) = first {
            self.launch(&mut state, key.to_owned(), first);
        }
        if let Some(timer) = timer {
            self.arm(&mut state, key, timer);
        }
        true
    }

    /// Start without waiting, as the Node recall boundary does with its unawaited promise.
    /// This is an explicit kick; unlike automatic timers it remains available after close.
    pub fn kick_background(&self, agent: &str) -> Result<(), EngineError> {
        self.start(key(agent), None)
    }

    /// Start and await the agent's lane, equivalent to awaiting Node `kick(agentId)`.
    pub fn kick(&self, agent: &str) -> Result<(), EngineError> {
        self.drain_lane_cancel(key(agent), &Cancel::never())
    }

    /// Await one agent, or every existing lane in insertion order. Works after close.
    pub fn drain(&self, agent: Option<&str>) -> Result<(), EngineError> {
        self.drain_with_cancel(agent, &Cancel::never())
    }

    /// Stop waiting when cancelled; the active callback remains owned until it returns.
    /// Cancellation here does not cancel effects: callbacks retain their own original token.
    pub fn drain_with_cancel(
        &self,
        agent: Option<&str>,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        let keys = match agent.filter(|agent| !agent.is_empty()) {
            Some(agent) => vec![agent.to_owned()],
            None => lock(&self.0.state)
                .lanes
                .iter()
                .map(|lane| lane.key.clone())
                .collect(),
        };
        for key in keys {
            self.drain_lane_cancel(&key, cancel)?;
        }
        Ok(())
    }

    /// Hardware-derived maximum of retained agent lanes (twice logical CPUs, within 4..=64).
    #[must_use]
    pub fn lane_limit(&self) -> usize {
        self.0.lane_limit
    }

    /// Waiting callbacks plus one active lane, exactly as the Node queue reports.
    #[must_use]
    pub fn pending(&self, agent: &str) -> usize {
        lock(&self.0.state)
            .lanes
            .iter()
            .find(|lane| lane.key == key(agent))
            .map_or(0, |lane| lane.jobs.len() + usize::from(lane.running))
    }

    /// Ordered Node-shaped lane snapshots: waiting, running and cumulative dropped count.
    #[must_use]
    pub fn stats(&self) -> Json {
        Json::Object(
            lock(&self.0.state)
                .lanes
                .iter()
                .map(|lane| {
                    (
                        JsString::from(lane.key.as_str()),
                        Json::Object(vec![
                            (
                                JsString::from("waiting"),
                                Json::Number(lane.jobs.len().to_string()),
                            ),
                            (JsString::from("running"), Json::Bool(lane.running)),
                            (
                                JsString::from("dropped"),
                                Json::Number(lane.dropped.to_string()),
                            ),
                        ]),
                    )
                })
                .collect(),
        )
    }

    /// Number of fallback timers currently armed across all lanes.
    #[must_use]
    pub fn scheduled_count(&self) -> usize {
        lock(&self.0.state)
            .lanes
            .iter()
            .filter(|lane| lane.timer.is_some())
            .count()
    }

    /// Failed callbacks, including unwinding panics; queue diagnostics omit error content.
    /// The process panic hook remains host-owned and may independently report a panic.
    #[must_use]
    pub fn failure_count(&self) -> usize {
        lock(&self.0.state).failures
    }

    /// Stop new enqueues and cancel/join fallback timers. Retain waiting and active work.
    pub fn close(&self) {
        let mut state = lock(&self.0.state);
        state.closed = true;
        for lane in &mut state.lanes {
            if let Some(timer) = lane.timer.take() {
                timer.cancel();
            }
        }
        drop(state);
        let timers = std::mem::take(&mut *lock(&self.0.timers));
        for timer in timers {
            let _ = timer.join();
        }
    }

    /// Fire one injected fallback without blocking for its work; production uses its timer.
    #[cfg(any(test, feature = "testkit"))]
    pub fn fire_fallback(&self, agent: &str) {
        let timer = lock(&self.0.state)
            .lanes
            .iter()
            .find(|lane| lane.key == key(agent))
            .and_then(|lane| lane.timer.clone());
        if let Some(timer) = timer {
            let _ = self.start(key(agent), Some(&timer));
        }
    }

    fn drain_lane_cancel(&self, key: &str, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        self.start(key, None)?;
        let mut state = lock(&self.0.state);
        while state
            .lanes
            .iter()
            .any(|lane| lane.key == key && lane.running)
        {
            cancel.check()?;
            let wait = cancel
                .remaining()
                .unwrap_or(Duration::from_millis(20))
                .min(Duration::from_millis(20));
            state = self
                .0
                .changed
                .wait_timeout(state, wait)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        cancel.check()?;
        // Worker handles are reaped only after is_finished(): a bounded drain never
        // waits on callback destruction or a newly admitted worker beyond its budget.
        drop(state);
        self.reap_finished();
        Ok(())
    }

    fn start(&self, key: &str, automatic: Option<&Arc<Timer>>) -> Result<(), EngineError> {
        let mut state = lock(&self.0.state);
        if automatic.is_some() && state.closed {
            return Ok(());
        }
        let Some(lane) = state.lanes.iter_mut().find(|lane| lane.key == key) else {
            return Ok(());
        };
        if automatic.is_some_and(|timer| {
            !lane
                .timer
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, timer))
        }) {
            return Ok(());
        }
        if let Some(timer) = lane.timer.take() {
            timer.cancel();
        }
        if let Some(first) = take_work(lane) {
            if !self.launch(&mut state, key.to_owned(), first) {
                return Err(EngineError::NotAvailable {
                    reason: "deferred dynamics worker unavailable".into(),
                });
            }
        }
        Ok(())
    }
}

/// Process-wide shared queue; the first constructor's options win, matching the Node singleton.
#[must_use]
pub fn get_shared_deferred_dynamics_queue(options: DeferredOptions) -> DeferredDynamicsQueue {
    static SHARED: OnceLock<DeferredDynamicsQueue> = OnceLock::new();
    SHARED
        .get_or_init(|| DeferredDynamicsQueue::new(options))
        .clone()
}

fn key(agent: &str) -> &str {
    if agent.is_empty() {
        "default"
    } else {
        agent
    }
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
fn lane<'a>(state: &'a mut State, key: &str) -> &'a mut Lane {
    let index = state
        .lanes
        .iter()
        .position(|lane| lane.key == key)
        .unwrap_or_else(|| {
            state.lanes.push(Lane {
                key: key.to_owned(),
                jobs: VecDeque::new(),
                running: false,
                timer: None,
                dropped: 0,
            });
            state.lanes.len() - 1
        });
    &mut state.lanes[index]
}
fn take_work(lane: &mut Lane) -> Option<Job> {
    if lane.running {
        return None;
    }
    let work = lane.jobs.pop_front();
    lane.running = work.is_some();
    work
}
fn trim(lane: &mut Lane, maximum: f64) {
    while usize_as_number(lane.jobs.len()) > maximum {
        lane.jobs.pop_front();
        lane.dropped = lane.dropped.saturating_add(1);
    }
}

// All callers are bounded to 4096 entries, exactly representable as f64.
fn usize_as_number(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

#[cfg(test)]
#[path = "deferred_lifecycle_tests.rs"]
mod tests;
