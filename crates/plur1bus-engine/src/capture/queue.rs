//! Per-agent capture admission and scheduling at the pinned Node scheduler's boundaries.
//!
//! A timeout settles the receipt, not the underlying work: its agent slot is retained until
//! the work actually exits. Distinct agents and configured same-agent slots may overlap.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::contract::{Cancel, CaptureResult, EngineError};

use super::logging::{CaptureLogSink, CaptureLogStage, SafeCaptureLog, StandardCaptureLog};

#[path = "queue_policy.rs"]
mod policy;
pub use policy::{
    is_background_turn, should_skip_auto_capture, BoundedPush, BoundedQueue, PressureLevel,
    PressureSnapshot, Priority, PushResult, RuntimeConfig,
};

/// Capture-specific metadata snapshotted at acceptance.
#[derive(Clone)]
pub struct QueueMeta {
    /// Whether this is background work.
    pub background: bool,
    /// Explicit priority, or the configured default for the work class.
    pub priority: Option<Priority>,
    /// Call-local timeout, measured only after a slot is acquired.
    pub timeout_ms: Option<u64>,
    /// Caller cancellation, independent of the scheduler's timeout signal.
    pub cancel: Cancel,
}

impl Default for QueueMeta {
    fn default() -> Self {
        Self {
            background: false,
            priority: None,
            timeout_ms: None,
            cancel: Cancel::never(),
        }
    }
}

/// A scheduler receipt, separate from the capture callback's own memory counters.
pub struct QueueOutcome {
    /// The callback settled successfully before its timeout.
    pub ok: bool,
    /// Its capture result, when successful work settled before timeout.
    pub result: Option<CaptureResult>,
    /// The original typed callback failure, retained without logging its contents.
    pub error: Option<EngineError>,
    /// The worker exceeded its execution budget.
    pub timed_out: bool,
    /// Admission observed an already-aborted caller.
    pub aborted: bool,
    /// Pressure or the bounded queue refused the work.
    pub skipped: bool,
    /// Stable refusal reason or the Node pressure explanation.
    pub reason: Option<String>,
    /// Work's background flag.
    pub background: bool,
    /// Pressure details on a pressure refusal.
    pub pressure: Option<PressureSnapshot>,
    /// Pending depth on an eviction/full refusal.
    pub queue_depth: Option<usize>,
    /// Active worker count on an eviction/full refusal.
    pub active_count: Option<usize>,
    /// Queue wait at an eviction/full refusal.
    pub duration_ms: Option<u64>,
    /// Work's configured execution budget on an eviction/full refusal.
    pub timeout_ms: Option<u64>,
}

impl QueueOutcome {
    fn empty(background: bool) -> Self {
        Self {
            ok: false,
            result: None,
            error: None,
            timed_out: false,
            aborted: false,
            skipped: false,
            reason: None,
            background,
            pressure: None,
            queue_depth: None,
            active_count: None,
            duration_ms: None,
            timeout_ms: None,
        }
    }

    /// Serialize only Node scheduler fields, in the exact construction order of its selected branch.
    /// Capture callback counters remain available through `result` and are not scheduler fields.
    #[must_use]
    pub fn node_json(&self) -> String {
        let mut fields = vec![("ok", Value::Bool(self.ok))];
        if self.aborted {
            fields.push(("aborted", Value::Bool(true)));
        }
        if self.skipped {
            fields.push(("skipped", Value::Bool(true)));
        }
        if let Some(reason) = &self.reason {
            fields.push(("reason", Value::String(reason.clone())));
        }
        if let Some(depth) = self.queue_depth {
            fields.push(("queueDepth", depth.into()));
            fields.push(("activeCount", self.active_count.unwrap_or(0).into()));
            fields.push(("operation", Value::String("capture".into())));
            fields.push(("durationMs", self.duration_ms.unwrap_or(0).into()));
            fields.push(("timeoutMs", self.timeout_ms.unwrap_or(0).into()));
        }
        let mut text = String::from("{");
        for (name, value) in fields {
            if text.len() > 1 {
                text.push(',');
            }
            append_field(&mut text, name, &value.to_string());
        }
        if let Some(pressure) = &self.pressure {
            text.push(',');
            append_field(
                &mut text,
                "pressure",
                &serde_json::to_string(pressure).unwrap_or_else(|_| "null".into()),
            );
        }
        if self.timed_out {
            text.push_str(",\"timedOut\":true");
        }
        if let Some(error) = &self.error {
            text.push(',');
            let value = match error {
                EngineError::Invalid { message, .. } => message.clone(),
                EngineError::NotAvailable { reason } => reason.clone(),
                other => other.to_string(),
            };
            append_field(&mut text, "error", &Value::String(value).to_string());
        }
        text.push_str(if self.background {
            ",\"background\":true}"
        } else {
            ",\"background\":false}"
        });
        text
    }
}

fn append_field(text: &mut String, name: &str, value: &str) {
    text.push('"');
    text.push_str(name);
    text.push_str("\":");
    text.push_str(value);
}

/// The Node capture-status projection, replacing only its volatile ISO timestamp with presence.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    /// Agent state objects retained by the Node drain/get-state behavior.
    pub queued_agents: usize,
    /// Pending jobs across all agents.
    pub queued_total: usize,
    /// Workers that have not physically settled, including timed-out workers.
    pub active: usize,
    /// Successful callbacks that won their timeout race.
    pub completed: u64,
    /// Receipts settled by execution timeout.
    pub timed_out: u64,
    /// Callback failures that won their timeout race.
    pub failed: u64,
    /// Pressure refusals, as counted by Node.
    pub skipped: u64,
    /// A successful background capture has written the last-background timestamp.
    pub background_timestamp_written: bool,
}

/// A capture worker owns its inputs and receives a combined caller/deadline cancellation token.
pub type CaptureWork =
    Box<dyn FnOnce(Cancel) -> Result<CaptureResult, EngineError> + Send + 'static>;
/// Process-pressure sampling is injected; the production host must supply its real process sampler.
pub type PressureCheck = dyn Fn() -> PressureSnapshot + Send + Sync;

struct Job {
    id: u64,
    agent: String,
    background: bool,
    priority: Priority,
    timeout_ms: u64,
    enqueued: Instant,
    caller: Cancel,
    work: CaptureWork,
    receipt: mpsc::Sender<QueueOutcome>,
}

struct Active {
    agent: String,
    background: bool,
    receipt: Option<mpsc::Sender<QueueOutcome>>,
    caller: Cancel,
    cancel: Cancel,
    deadline: Instant,
    thread: Option<JoinHandle<()>>,
}

struct AgentQueue {
    pending: BoundedQueue<Job>,
    active: usize,
}
enum Command {
    Enqueue(Job),
    Finished(u64, Result<CaptureResult, EngineError>),
    Barrier(mpsc::Sender<()>),
    Close,
}

struct Shared {
    config: RuntimeConfig,
    pressure: Arc<PressureCheck>,
    sender: mpsc::Sender<Command>,
    log: Mutex<Arc<dyn CaptureLogSink>>,
    status: Mutex<QueueStatus>,
    changed: Condvar,
    next: AtomicU64,
    closed: AtomicBool,
    stopped: AtomicBool,
}

/// One coordinator with owned execution tasks. Slots release only on actual callback settlement.
pub struct CaptureQueue {
    shared: Arc<Shared>,
    coordinator: Mutex<Option<JoinHandle<()>>>,
}

impl CaptureQueue {
    /// Start the engine's scheduler, without holding references into the accepting stack frame.
    pub fn new(config: RuntimeConfig, pressure: Arc<PressureCheck>) -> Result<Self, EngineError> {
        let (sender, receiver) = mpsc::channel();
        let shared = Arc::new(Shared {
            config,
            pressure,
            sender,
            log: Mutex::new(Arc::new(StandardCaptureLog)),
            status: Mutex::new(QueueStatus::default()),
            changed: Condvar::new(),
            next: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
        });
        let state = shared.clone();
        let coordinator = thread::Builder::new()
            .name("plur1bus-capture-queue".into())
            .spawn(move || coordinate(&state, &receiver))
            .map_err(|_| unavailable())?;
        Ok(Self {
            shared,
            coordinator: Mutex::new(Some(coordinator)),
        })
    }

    /// Replace the content-free event sink before handing the queue to producers.
    #[must_use]
    pub fn with_log_sink(self, sink: Arc<dyn CaptureLogSink>) -> Self {
        *lock(&self.shared.log) = sink;
        self
    }

    /// Accept owned work without waiting for execution; the receipt resolves once, even on timeout.
    pub fn enqueue(
        &self,
        agent: &str,
        meta: QueueMeta,
        work: CaptureWork,
    ) -> mpsc::Receiver<QueueOutcome> {
        let (receipt, receiver) = mpsc::channel();
        let mut refusal = QueueOutcome::empty(meta.background);
        if self.shared.closed.load(Ordering::Acquire) {
            refusal.reason = Some("engine-closed".into());
            let _ = receipt.send(refusal);
            return receiver;
        }
        if meta.cancel.is_cancelled() {
            refusal.aborted = true;
            refusal.reason = Some("aborted".into());
            let _ = receipt.send(refusal);
            return receiver;
        }
        let priority = meta.priority.unwrap_or(if meta.background {
            self.shared.config.background_priority
        } else {
            Priority::Normal
        });
        let pressure = if self.shared.config.pressure_gate_enabled {
            (self.shared.pressure)()
        } else {
            PressureSnapshot::disabled()
        };
        if pressure.skips(meta.background, priority) {
            refusal.skipped = true;
            refusal.reason = Some(pressure.reason.clone());
            refusal.pressure = Some(pressure);
            lock(&self.shared.status).skipped += 1;
            let _ = receipt.send(refusal);
            return receiver;
        }
        let job = Job {
            id: self.shared.next.fetch_add(1, Ordering::Relaxed),
            agent: if agent.is_empty() { "default" } else { agent }.into(),
            background: meta.background,
            priority,
            timeout_ms: meta
                .timeout_ms
                .filter(|value| *value > 0)
                .unwrap_or(self.shared.config.capture_timeout_ms),
            enqueued: Instant::now(),
            caller: meta.cancel,
            work,
            receipt,
        };
        if let Err(error) = self.shared.sender.send(Command::Enqueue(job)) {
            if let Command::Enqueue(job) = error.0 {
                let mut outcome = QueueOutcome::empty(job.background);
                outcome.reason = Some("engine-closed".into());
                let _ = job.receipt.send(outcome);
            }
        }
        receiver
    }

    /// The configured execution budget of one capture job (`runtime.captureTimeoutMs`).
    #[must_use]
    pub fn capture_timeout(&self) -> Duration {
        Duration::from_millis(self.shared.config.capture_timeout_ms)
    }

    /// Copy scheduler counters, never callback contents or errors.
    #[must_use]
    pub fn status(&self) -> QueueStatus {
        self.synchronize();
        lock(&self.shared.status).clone()
    }

    /// Wait within a budget for all queued and active workers to settle.
    #[must_use]
    pub fn wait_idle(&self, budget: Duration) -> bool {
        self.synchronize();
        let deadline = Instant::now()
            .checked_add(budget)
            .unwrap_or_else(Instant::now);
        let mut status = lock(&self.shared.status);
        while status.active > 0 || status.queued_total > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let waited = self
                .shared
                .changed
                .wait_timeout(status, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            status = waited.0;
        }
        true
    }

    fn synchronize(&self) {
        if self.shared.stopped.load(Ordering::Acquire) {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        if self.shared.sender.send(Command::Barrier(sender)).is_ok() {
            let _ = receiver.recv();
        }
    }

    /// Refuse new work, cancel active tasks and settle pending receipts, waiting up to the budget.
    /// A non-cooperative host callback can outlive this budget; its slot and resources stay owned.
    #[must_use]
    pub fn close(&self, budget: Duration) -> bool {
        if !self.shared.closed.swap(true, Ordering::AcqRel) {
            let _ = self.shared.sender.send(Command::Close);
        }
        let deadline = Instant::now()
            .checked_add(budget)
            .unwrap_or_else(Instant::now);
        let mut status = lock(&self.shared.status);
        while !self.shared.stopped.load(Ordering::Acquire) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            status = self
                .shared
                .changed
                .wait_timeout(status, remaining)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        drop(status);
        if let Some(handle) = lock(&self.coordinator).take() {
            let _ = handle.join();
        }
        true
    }
}

impl Drop for CaptureQueue {
    fn drop(&mut self) {
        let _ = self.close(Duration::from_secs(1));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
fn unavailable() -> EngineError {
    EngineError::NotAvailable {
        reason: "capture-worker-unavailable".into(),
    }
}

fn coordinate(shared: &Arc<Shared>, receiver: &mpsc::Receiver<Command>) {
    let mut agents: HashMap<String, AgentQueue> = HashMap::new();
    let mut active: HashMap<u64, Active> = HashMap::new();
    let mut closing = false;
    loop {
        let mut barrier = None;
        let command = if active.is_empty() {
            receiver.recv().ok()
        } else {
            receiver.recv_timeout(Duration::from_millis(1)).ok()
        };
        match command {
            Some(Command::Enqueue(job)) => {
                let state = agents
                    .entry(job.agent.clone())
                    .or_insert_with(|| AgentQueue {
                        pending: BoundedQueue::new(shared.config.max_queue_depth_capture_per_agent),
                        active: 0,
                    });
                let background = job.background;
                let priority = job.priority;
                let pushed = state.pending.push(job, background, priority);
                finish_push(shared, state, pushed);
            }
            Some(Command::Finished(id, result)) => {
                settle(shared, &mut agents, &mut active, id, result)
            }
            Some(Command::Barrier(sender)) => barrier = Some(sender),
            Some(Command::Close) => {
                closing = true;
                for state in agents.values_mut() {
                    while let Some(job) = state.pending.take_next() {
                        let mut outcome = QueueOutcome::empty(job.background);
                        outcome.reason = Some("engine-closed".into());
                        let _ = job.receipt.send(outcome);
                    }
                }
                for worker in active.values() {
                    worker.cancel.cancel();
                }
            }
            None => {}
        }
        poll_workers(shared, &mut active);
        if !closing {
            start_ready(shared, &mut agents, &mut active);
        }
        refresh(shared, &agents, active.len());
        if let Some(sender) = barrier {
            let _ = sender.send(());
        }
        if closing && active.is_empty() {
            break;
        }
    }
    shared.stopped.store(true, Ordering::Release);
    shared.changed.notify_all();
}

fn finish_push(shared: &Shared, state: &AgentQueue, pushed: BoundedPush<Job>) {
    for (job, reason) in [
        (pushed.evicted, "queue-depth-evicted"),
        (pushed.rejected, "queue-full"),
    ] {
        if let Some(job) = job {
            let mut outcome = QueueOutcome::empty(job.background);
            outcome.skipped = true;
            outcome.reason = Some(reason.into());
            outcome.queue_depth = Some(if reason == "queue-depth-evicted" {
                state.pending.len().saturating_sub(1)
            } else {
                state.pending.len()
            });
            outcome.active_count = Some(if reason == "queue-depth-evicted" {
                lock(&shared.status).active
            } else {
                state.active
            });
            outcome.duration_ms = Some(job.enqueued.elapsed().as_millis() as u64);
            outcome.timeout_ms = Some(job.timeout_ms);
            let _ = job.receipt.send(outcome);
        }
    }
}

fn start_ready(
    shared: &Arc<Shared>,
    agents: &mut HashMap<String, AgentQueue>,
    active: &mut HashMap<u64, Active>,
) {
    for (agent, state) in agents.iter_mut() {
        while state.active < shared.config.max_concurrent_capture_per_agent {
            let Some(job) = state.pending.take_next() else {
                break;
            };
            let deadline = Instant::now()
                .checked_add(Duration::from_millis(job.timeout_ms))
                .unwrap_or_else(Instant::now);
            let cancel = Cancel::with_deadline(deadline);
            if job.caller.is_cancelled() {
                cancel.cancel();
            }
            let work_cancel = cancel.clone();
            let sender = shared.sender.clone();
            let id = job.id;
            let worker = Active {
                agent: agent.clone(),
                background: job.background,
                receipt: Some(job.receipt),
                caller: job.caller,
                cancel,
                deadline,
                thread: None,
            };
            active.insert(id, worker);
            state.active += 1;
            let handle = thread::Builder::new()
                .name("plur1bus-capture-work".into())
                .spawn(move || {
                    let result = (job.work)(work_cancel);
                    let _ = sender.send(Command::Finished(id, result));
                });
            match handle {
                Ok(handle) => {
                    if let Some(worker) = active.get_mut(&id) {
                        worker.thread = Some(handle);
                    }
                }
                Err(_) => {
                    let _ = shared
                        .sender
                        .send(Command::Finished(id, Err(unavailable())));
                }
            }
        }
    }
}

fn settle(
    shared: &Shared,
    agents: &mut HashMap<String, AgentQueue>,
    active: &mut HashMap<u64, Active>,
    id: u64,
    result: Result<CaptureResult, EngineError>,
) {
    let Some(mut worker) = active.remove(&id) else {
        return;
    };
    if let Some(handle) = worker.thread.take() {
        let _ = handle.join();
    }
    if let Some(state) = agents.get_mut(&worker.agent) {
        state.active = state.active.saturating_sub(1);
    }
    if let Some(receipt) = worker.receipt.take() {
        let mut outcome = QueueOutcome::empty(worker.background);
        match result {
            Ok(result) => {
                let mut status = lock(&shared.status);
                status.completed += 1;
                status.background_timestamp_written |= worker.background;
                outcome.ok = true;
                outcome.result = Some(result);
            }
            Err(error) => {
                lock(&shared.status).failed += 1;
                lock(&shared.log).record(SafeCaptureLog::from_error(
                    CaptureLogStage::CaptureWorker,
                    &error,
                    1,
                ));
                outcome.error = Some(error);
            }
        }
        // Publish settled-slot counters before making the receipt observable.
        refresh(shared, agents, active.len());
        let _ = receipt.send(outcome);
    } else if let Err(error) = result {
        lock(&shared.log).record(SafeCaptureLog::from_error(
            CaptureLogStage::LateCaptureSettlement,
            &error,
            1,
        ));
    }
}

fn poll_workers(shared: &Shared, active: &mut HashMap<u64, Active>) {
    for worker in active.values_mut() {
        if worker.caller.is_cancelled() {
            worker.cancel.cancel();
        }
        if Instant::now() >= worker.deadline {
            if let Some(receipt) = worker.receipt.take() {
                worker.cancel.cancel();
                lock(&shared.status).timed_out += 1;
                let mut outcome = QueueOutcome::empty(worker.background);
                outcome.timed_out = true;
                let _ = receipt.send(outcome);
            }
        }
    }
}

fn refresh(shared: &Shared, agents: &HashMap<String, AgentQueue>, active: usize) {
    let mut status = lock(&shared.status);
    status.queued_agents = agents.len();
    status.queued_total = agents.values().map(|state| state.pending.len()).sum();
    status.active = active;
    shared.changed.notify_all();
}
