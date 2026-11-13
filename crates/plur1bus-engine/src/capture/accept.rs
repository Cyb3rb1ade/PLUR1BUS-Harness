//! Non-blocking capture receipts, admission and replay/queue composition (RE-05/T1).
//!
//! The row-producing worker is supplied by the later capture stages. It receives the
//! real planned/settled callbacks; Neo journal event construction remains in RE-05/T5.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::context::RequestContext;
use crate::contract::{
    Cancel, CaptureHandle, CaptureInlineFeature, CaptureInlineReason, CaptureOptions,
    CaptureResult, EngineError, HostError, HostServices, PerCallDiagnostic, TurnRecord,
};

use crate::neo::turn_batch::{valid_metadata, MessageMetadata};

use super::cancel_link::CancellationLinks;
use super::queue::{CaptureQueue, QueueMeta};
use super::replay_guard::{turn_key_of, ReplayGuard, ReplayRows};
use super::result::counts;
use super::retained::{Bounds, HostCalls, PLACE_PATIENCE};

/// How long an admitted turn keeps its place in its agent's order while it has no identity:
/// while it waits for a place for its lookup and while the host has not answered. It is
/// counted from the moment the turn begins to ask, which is before it waits in that order
/// (RE-D163). After that the turn steps aside until the answer arrives: later turns of the
/// agent pass, as at the pin, where the lookup holds no agent-wide order.
const ADMISSION_PATIENCE: Duration = Duration::from_secs(1);
/// How often retained input is checked against its age bound while the engine runs. The
/// hour is the host's (RE-D163), as the age bound itself is.
const EXPIRY_SWEEP_MS: i64 = 60 * 60 * 1000;
/// How often the recovery pass looks at the host's clock.
const CLOCK_LOOK: Duration = Duration::from_secs(60);

/// What a recovery attempt gets from the runtime (RE-D162).
#[derive(Clone)]
pub struct RecoverySteps {
    /// The replay guard that leases a recovered turn.
    pub replay: ReplayGuard,
    /// The per-agent queue: a recovered record's row work is one job in it, as a turn's.
    pub queue: Arc<CaptureQueue>,
    /// Ends all recovery (close); admitted turns keep their own cancellation.
    pub shutdown: Cancel,
    /// The places for outstanding host lookups (RE-D163).
    pub(crate) calls: Arc<HostCalls>,
}
impl RecoverySteps {
    /// What a recovery step outside this module is bound by.
    pub(crate) fn bounds(&self) -> Bounds {
        Bounds {
            shutdown: self.shutdown.clone(),
            calls: self.calls.clone(),
        }
    }
}

/// Row work supplied by the composed capture pipeline, not by the public contract.
///
/// Retained work (RE-D162): the composition only takes an inventory. Recovery runs behind
/// it, one owner at a time, and before a turn only for that turn's own owner. Stateless or
/// foreign workers have nothing retained and keep the defaults.
pub trait CaptureWorker: Send + Sync {
    /// Classify retained work from directory entries before the runtime accepts turns: no
    /// host callback, no provider call and no waiting for a lock.
    fn inventory(&self, _cancel: &Cancel) -> Result<(), EngineError> {
        Ok(())
    }

    /// Whether retained work waits or is being recovered. Asks no host.
    fn has_retained(&self) -> bool {
        false
    }

    /// One pass over everything that waits: owners one after the other, each under its own
    /// budget, holding nothing another owner's turn waits for.
    fn recover_retained(self: Arc<Self>, _steps: &RecoverySteps) {}

    /// Discard retained input that is past its age bound; no recovery attempt is made.
    fn expire_retained(self: Arc<Self>, _steps: &RecoverySteps) {}

    /// Before a turn: join the recovery of this caller's own retained work, or start it. It
    /// waits for nobody else's and never refuses or aborts the turn.
    fn recover_owner(
        self: Arc<Self>,
        _steps: &RecoverySteps,
        _turn: &TurnRecord,
        _context: &RequestContext,
        _cancel: &Cancel,
    ) {
    }

    /// Start no further attempt and wait within `budget` for those in flight.
    fn close_retained(&self, _budget: Duration) -> bool {
        true
    }

    /// Process a turn under its resolved identity; plan before writes and settle after commits.
    /// Returning a result with a reason leaves the turn eligible for replay unless already settled.
    fn capture(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        replay: ReplayRows,
        cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError>;

    /// Native capture with authenticated metadata. Other workers decline the extension.
    fn capture_host_turn(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        metadata: Option<&[MessageMetadata]>,
        replay: ReplayRows,
        cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        if metadata.is_some() {
            return Err(EngineError::NotAvailable {
                reason: "neo-host-metadata-unavailable".into(),
            });
        }
        self.capture(turn, context, options, replay, cancel)
    }
}

struct Inner {
    host: Arc<dyn HostServices>,
    worker: Arc<dyn CaptureWorker>,
    queue: Arc<CaptureQueue>,
    replay: ReplayGuard,
    scheduled: bool,
    links: CancellationLinks,
    admissions: Arc<AdmissionTickets>,
    submissions: Mutex<Submissions>,
    /// Ends recovery; never an admitted turn.
    shutdown: Cancel,
    pass: Arc<Pass>,
    owners: OwnerGate,
    /// Bounds the threads that wait for a host answer: two per agent, 32 in this runtime.
    calls: Arc<HostCalls>,
}

impl Inner {
    fn steps(&self) -> RecoverySteps {
        RecoverySteps {
            replay: self.replay.clone(),
            queue: self.queue.clone(),
            shutdown: self.shutdown.clone(),
            calls: self.calls.clone(),
        }
    }
}

/// The background recovery pass and its periodic age sweep.
#[derive(Default)]
struct Pass {
    state: Mutex<PassState>,
    changed: Condvar,
}
#[derive(Default)]
struct PassState {
    started: bool,
    /// The first pass over everything that waited at composition has finished.
    first_done: bool,
    stop: bool,
    thread: Option<JoinHandle<()>>,
    /// Look at the clock now instead of at the next minute.
    poked: bool,
    /// How often the pass looked at the clock, and how often it swept then.
    looks: u64,
    sweeps: u64,
}
impl Pass {
    fn stop(&self) -> Option<JoinHandle<()>> {
        let mut state = lock(&self.state);
        state.stop = true;
        self.changed.notify_all();
        state.thread.take()
    }
}

/// One step of the recovery pass. A panic in it ends that step only (RE-D163): it is
/// logged, the first pass still counts as finished and the next sweep still runs. No key
/// stays in flight, because an attempt's key returns when its own thread ends.
fn guarded(step: &str, run: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)).is_err() {
        log::error!("capture: the recovery pass panicked in its {step}; the pass goes on");
    }
}

fn recovery_pass(inner: &Weak<Inner>, pass: &Pass) {
    let mut swept_at = None;
    if let Some(inner) = inner.upgrade() {
        guarded("first pass", || {
            inner.worker.clone().recover_retained(&inner.steps());
        });
        // The first pass applied the age bounds too.
        swept_at = Some(inner.host.now_ms());
    }
    lock(&pass.state).first_done = true;
    pass.changed.notify_all();
    loop {
        let end = Instant::now() + CLOCK_LOOK;
        let mut state = lock(&pass.state);
        while !state.stop && !state.poked {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = pass
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        if state.stop {
            return;
        }
        state.poked = false;
        drop(state);
        // The runtime is gone when nothing holds it any more.
        let Some(inner) = inner.upgrade() else {
            return;
        };
        // An hour of the host's clock since the last sweep (or a clock that went back).
        let now = inner.host.now_ms();
        let due = swept_at.is_none_or(|at| now < at || now - at >= EXPIRY_SWEEP_MS);
        if due {
            guarded("sweep", || {
                inner.worker.clone().expire_retained(&inner.steps());
            });
            swept_at = Some(now);
        }
        drop(inner);
        let mut state = lock(&pass.state);
        state.looks += 1;
        state.sweeps += u64::from(due);
        pass.changed.notify_all();
    }
}

#[derive(Default)]
struct Submissions {
    closed: bool,
    tasks: Vec<JoinHandle<()>>,
}

impl Submissions {
    fn reap(&mut self) {
        for task in self.tasks.extract_if(.., |task| task.is_finished()) {
            let _ = task.join();
        }
    }
}

/// Capture service owning resources that must outlive an immediately returned receipt.
pub struct CaptureRuntime(Arc<Inner>);

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Drop for CaptureRuntime {
    fn drop(&mut self) {
        // A runtime dropped without close still ends its recovery.
        self.0.shutdown.cancel();
        drop(self.0.pass.stop());
    }
}

impl CaptureRuntime {
    /// Compose services, take the inventory of retained work and run one recovery pass over
    /// it before returning. An embedder that must not wait for recovery uses
    /// [`Self::compose`] and [`Self::start_recovery`] instead.
    /// `scheduled` is the host's post-turn-refine scheduling capability (CA-R1).
    pub fn new(
        host: Arc<dyn HostServices>,
        worker: Arc<dyn CaptureWorker>,
        queue: Arc<CaptureQueue>,
        replay: ReplayGuard,
        scheduled: bool,
    ) -> Result<Self, EngineError> {
        let runtime = Self::compose(host, worker, queue, replay, scheduled, Cancel::never())?;
        runtime.start_recovery();
        runtime.wait_recovered(None);
        Ok(runtime)
    }

    /// Compose services and take the inventory of retained work, nothing else (RE-D162):
    /// its duration depends on the number of directory entries only. Turns are accepted at
    /// once; recovery starts with [`Self::start_recovery`] and ends when `shutdown` is
    /// cancelled or the runtime is closed.
    pub fn compose(
        host: Arc<dyn HostServices>,
        worker: Arc<dyn CaptureWorker>,
        queue: Arc<CaptureQueue>,
        replay: ReplayGuard,
        scheduled: bool,
        shutdown: Cancel,
    ) -> Result<Self, EngineError> {
        if !replay.is_durable() {
            return Err(EngineError::Invalid {
                field: "capture".into(),
                message: "durable capture WAL required".into(),
            });
        }
        worker.inventory(&shutdown)?;
        Ok(Self(Arc::new(Inner {
            host,
            worker,
            queue,
            replay,
            scheduled,
            links: CancellationLinks::new()?,
            admissions: Arc::new(AdmissionTickets::default()),
            submissions: Mutex::default(),
            shutdown,
            pass: Arc::default(),
            owners: OwnerGate::default(),
            calls: Arc::default(),
        })))
    }

    /// Start the background recovery pass once; afterwards it only checks age bounds.
    pub fn start_recovery(&self) {
        let pass = self.0.pass.clone();
        let mut state = lock(&pass.state);
        if state.started || state.stop {
            return;
        }
        state.started = true;
        let (inner, worker) = (Arc::downgrade(&self.0), self.0.pass.clone());
        state.thread = thread::Builder::new()
            .name("capture-recovery-pass".into())
            .spawn(move || recovery_pass(&inner, &worker))
            .ok();
        // Without a thread nothing runs; retained work then waits for its owners' turns.
        state.first_done = state.thread.is_none();
    }

    /// Wait until the first recovery pass has finished (`None`: without limit; the pass
    /// itself is bounded by the owners' budgets). False when the budget ran out first or
    /// the pass was never started.
    pub fn wait_recovered(&self, budget: Option<Duration>) -> bool {
        let end = budget.and_then(|budget| Instant::now().checked_add(budget));
        let pass = &self.0.pass;
        let mut state = lock(&pass.state);
        // A pass thread that ended without reporting has nothing left to wait for.
        while state.started
            && !state.first_done
            && !state.thread.as_ref().is_some_and(JoinHandle::is_finished)
        {
            let left = end.map_or(Duration::from_secs(1), |end| {
                end.saturating_duration_since(Instant::now())
            });
            if left.is_zero() {
                return false;
            }
            state = pass
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        state.first_done || state.started
    }

    /// Test support: have the recovery pass look at the host's clock now instead of at the
    /// next minute. `Some(true)` when it swept, `Some(false)` when no hour of the host's
    /// clock had passed, `None` when it did not look within `budget`.
    #[cfg(test)]
    pub(crate) fn look_at_clock_for_test(&self, budget: Duration) -> Option<bool> {
        let pass = &self.0.pass;
        let mut state = lock(&pass.state);
        let (looks, sweeps) = (state.looks, state.sweeps);
        state.poked = true;
        pass.changed.notify_all();
        let end = Instant::now() + budget;
        while state.looks == looks {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            state = pass
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        Some(state.sweeps > sweeps)
    }

    /// Return a receipt without waiting for identity I/O, the agent queue, providers or writes.
    /// Receipt aborts never change the caller's original cancellation token.
    pub fn accept(
        &self,
        turn: TurnRecord,
        options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError> {
        self.accept_host_turn(turn, options, None)
    }

    pub(crate) fn accept_host_turn(
        &self,
        turn: TurnRecord,
        options: CaptureOptions,
        metadata: Option<Vec<MessageMetadata>>,
    ) -> Result<CaptureHandle, EngineError> {
        if metadata
            .as_deref()
            .is_some_and(|items| !valid_metadata(&turn.messages, items))
        {
            return Err(crate::contract::StoreError::InvalidInput.into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let accepted_at = self.0.host.now_ms();
        let (send, done) = mpsc::channel();
        let (cancel, lease) = self.0.links.register(&id, &turn.cancel);
        let abort_token = cancel.clone();
        let active_cancel: Arc<Mutex<Option<Cancel>>> = Arc::new(Mutex::new(None));
        let abort_active = active_cancel.clone();
        let abort = Box::new(move |_reason: Option<String>| {
            abort_token.cancel();
            if let Some(active) = lock(&abort_active).as_ref() {
                active.cancel();
            }
        });
        // Closing takes the same lock before it drains the queue. A successful
        // admission is tracked before close can observe the runtime as closed.
        let mut submissions = lock(&self.0.submissions);
        let immediate = if submissions.closed {
            Some("engine-closed")
        } else if turn.incognito {
            Some("incognito")
        } else if turn.principal.agent_id != turn.agent_id {
            Some("principal-agent-mismatch")
        } else {
            None
        };
        if let Some(reason) = immediate {
            let _ = send.send(with_diagnostic(
                counts(0, 1, Some(reason)),
                &options,
                self.0.scheduled,
            ));
        } else {
            let ticket = self.0.admissions.issue(turn.agent_id.as_str());
            let inner = self.0.clone();
            let (unstarted, fallback) = (send.clone(), options.clone());
            let handle = thread::Builder::new()
                .name("capture-admission".into())
                .spawn(move || {
                    let result = execute(
                        &inner,
                        (turn, metadata),
                        &options,
                        &cancel,
                        lease,
                        active_cancel,
                        &ticket,
                    )
                    .unwrap_or_else(|error| counts(0, 1, Some(&error_description(&error))));
                    let _ = send.send(with_diagnostic(result, &options, inner.scheduled));
                });
            submissions.reap();
            match handle {
                Ok(handle) => submissions.tasks.push(handle),
                // No thread for this turn (RE-D163): only this receipt ends, as a turn whose
                // host did not answer. The turn's ticket went with the closure; later turns
                // are accepted as before.
                Err(_) => {
                    let failed = EngineError::Host(HostError::Unavailable);
                    let result = counts(0, 1, Some(&error_description(&failed)));
                    let _ = unstarted.send(with_diagnostic(result, &fallback, self.0.scheduled));
                }
            }
        }
        Ok(CaptureHandle {
            id,
            accepted_at,
            done,
            abort,
        })
    }

    /// Stop new capture work, end recovery and drain scheduler, admission and recovery
    /// threads within one shared budget. After this no recovery step starts. False means
    /// some worker has not yet settled; no thread is forcefully terminated.
    pub fn close(&self, budget: Duration) -> bool {
        let started = Instant::now();
        lock(&self.0.submissions).closed = true;
        // Recovery ends first: attempts in flight observe the signal, and none starts from
        // here on. Those in flight are waited for below, after the queue they may use.
        self.0.shutdown.cancel();
        let _ = self.0.worker.close_retained(Duration::ZERO);
        let pass = self.0.pass.stop();
        let mut settled = self.0.queue.close(budget.saturating_sub(started.elapsed()));
        loop {
            let mut submissions = lock(&self.0.submissions);
            submissions.reap();
            if submissions.tasks.is_empty() {
                break;
            }
            if started.elapsed() >= budget {
                settled = false;
                break;
            }
            drop(submissions);
            thread::sleep(Duration::from_millis(1));
        }
        settled &= self
            .0
            .worker
            .close_retained(budget.saturating_sub(started.elapsed()));
        if let Some(pass) = pass {
            while !pass.is_finished() && started.elapsed() < budget {
                thread::sleep(Duration::from_millis(1));
            }
            if pass.is_finished() {
                let _ = pass.join();
            } else {
                settled = false;
            }
        }
        // A host lookup that is still out is a worker that has not settled (RE-D163): its
        // waiter is gone, its thread is left to finish and its answer is dropped.
        while self.0.calls.outstanding() > 0 && started.elapsed() < budget {
            thread::sleep(Duration::from_millis(1));
        }
        settled && self.0.calls.outstanding() == 0
    }
}

/// An identity lookup in flight.
struct Lookup {
    answer: mpsc::Receiver<Result<RequestContext, EngineError>>,
    /// When the turn began to ask, before it had a place.
    asked: Instant,
}

/// How long a turn waits for a place for its identity lookup at most, counted from when it
/// began to ask: its capture budget, never more than ten seconds, and always within its
/// caller's own cancellation. Only after that does it end as unanswered.
fn place_patience(inner: &Inner) -> Duration {
    inner.queue.capture_timeout().min(PLACE_PATIENCE)
}

/// Resolve a turn's identity on its own thread, so that a host that never answers ends
/// only the wait, never the waiter. Such threads are bounded (RE-D163): the thread holds
/// one of its agent's two places, and one of the 32 of the runtime, until the host call
/// returns. The turn waits for a place until `until`, on the thread it already has.
/// `None`: no lookup was started — no place by then, the turn was cancelled, the runtime
/// is closing, or no thread could start.
fn lookup(
    inner: &Inner,
    turn: &TurnRecord,
    cancel: &Cancel,
    asked: Instant,
    until: Instant,
) -> Option<Lookup> {
    let agent = turn.agent_id.as_str();
    let place = inner.calls.begin(agent, cancel, &inner.shutdown, until)?;
    let (send, answer) = mpsc::channel();
    let host = inner.host.clone();
    let (principal, agent) = (turn.principal.clone(), turn.agent.clone());
    // A thread that cannot start drops the closure and with it the place.
    thread::Builder::new()
        .name("capture-identity".into())
        .spawn(move || {
            let context = RequestContext::build(&principal, &agent, host.as_ref());
            drop(place);
            let _ = send.send(context);
        })
        .ok()?;
    Some(Lookup { answer, asked })
}

/// Wait for a lookup's answer until the caller's cancellation, the end of the runtime or
/// `budget` ends the wait: the answer, or `None` when none came in time.
fn await_lookup(
    inner: &Inner,
    lookup: &Lookup,
    cancel: &Cancel,
    budget: Duration,
) -> Option<Result<RequestContext, EngineError>> {
    let end = Instant::now() + budget;
    loop {
        match lookup.answer.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => return Some(result),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Some(Err(EngineError::Host(HostError::Failed)))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if cancel.is_cancelled() || inner.shutdown.is_cancelled() || Instant::now() >= end {
                    return None;
                }
            }
        }
    }
}

/// The result of a turn whose identity lookup was not started or got no answer in time: the
/// caller's own abort, what the closed queue answers once the runtime closes, or what a
/// failed lookup reports (the pin's `detailOf(error)`).
fn unanswered(inner: &Inner, cancel: &Cancel) -> CaptureResult {
    if cancel.is_cancelled() {
        return counts(0, 1, Some("aborted"));
    }
    if inner.shutdown.is_cancelled() {
        return counts(0, 1, Some("engine-closed"));
    }
    let failed = EngineError::Host(HostError::Unavailable);
    counts(0, 1, Some(&error_description(&failed)))
}

fn execute(
    inner: &Arc<Inner>,
    (turn, metadata): (TurnRecord, Option<Vec<MessageMetadata>>),
    options: &CaptureOptions,
    cancel: &Cancel,
    lease: Arc<()>,
    active_cancel: Arc<Mutex<Option<Cancel>>>,
    ticket: &AdmissionTicket,
) -> Result<CaptureResult, EngineError> {
    // RE-D162: while retained work exists, a turn first joins the recovery of its own
    // owner's work. Its ticket is parked meanwhile, so no other turn waits behind it, and
    // its identity lookup has a deadline that ends only this turn.
    let mut staged = None;
    if inner.worker.has_retained() || inner.owners.busy() {
        ticket.park();
        let mut own = OwnerTurn::enter(inner, ticket.id);
        let asked = Instant::now();
        let Some(first) = lookup(inner, &turn, cancel, asked, asked + place_patience(inner)) else {
            return Ok(unanswered(inner, cancel));
        };
        match await_lookup(inner, &first, cancel, inner.queue.capture_timeout()) {
            Some(Ok(context)) if context.origin_wire() == "user" => {
                own.line_up(format!(
                    "{}\n{}",
                    context.agent_id.as_str(),
                    context.owner_user_id
                ));
                inner
                    .worker
                    .clone()
                    .recover_owner(&inner.steps(), &turn, &context, cancel);
                // Turns of one owner that waited for the same recovery go on in their order.
                if !own.wait_front(cancel) {
                    return Ok(counts(0, 1, Some("aborted")));
                }
            }
            // A failed lookup is reported by the turn's own admission below, as before.
            Some(_) => {}
            None => return Ok(unanswered(inner, cancel)),
        }
        ticket.unpark();
        staged = Some(own);
    }
    // The admission's own lookup starts before the turn waits for its place in its agent's
    // order (RE-D163): the waits of turns in a row run side by side and do not add up. A
    // lookup needs one of the agent's places. Without one after the patience the turn steps
    // aside as it does for a host that has not answered: it waits on for a place and then
    // for the answer with its ticket parked, so it holds the agent's order for one second
    // at most. Only a turn that got no place within the place patience ends unanswered.
    let asked = Instant::now();
    let patient = asked + ADMISSION_PATIENCE.min(place_patience(inner));
    let mut known = None;
    let admission = match lookup(inner, &turn, cancel, asked, patient) {
        Some(lookup) => lookup,
        None => {
            if cancel.is_cancelled() || inner.shutdown.is_cancelled() {
                return Ok(unanswered(inner, cancel));
            }
            ticket.park();
            let last = asked + place_patience(inner);
            let Some(lookup) = lookup(inner, &turn, cancel, asked, last) else {
                return Ok(unanswered(inner, cancel));
            };
            let outcome = await_lookup(inner, &lookup, cancel, inner.queue.capture_timeout());
            ticket.unpark();
            let Some(result) = outcome else {
                return Ok(unanswered(inner, cancel));
            };
            known = Some(result);
            lookup
        }
    };
    if !ticket.wait(cancel) {
        return Ok(counts(0, 1, Some("aborted")));
    }
    // At the front of its agent's order the turn no longer needs its place among its owner's.
    drop(staged);
    let replay_agent = turn.agent_id.to_string();
    let key = turn_key_of(&turn)?;
    inner.replay.run_with_wait_hook(
        &replay_agent,
        &key,
        cancel,
        || ticket.release(),
        |replay| {
            // The lookup has a deadline. A host that has not answered within the patience
            // (what is left of it since the turn began to ask) no longer holds the agent's
            // order: the ticket is parked until the answer arrives. A turn that already
            // stepped aside while it waited for a place comes back with its answer.
            let left =
                (admission.asked + ADMISSION_PATIENCE).saturating_duration_since(Instant::now());
            let answered = match known {
                Some(result) => Some(result),
                None => await_lookup(inner, &admission, cancel, left),
            };
            let context = match answered {
                Some(result) => result?,
                None => {
                    ticket.park();
                    let outcome =
                        await_lookup(inner, &admission, cancel, inner.queue.capture_timeout());
                    ticket.unpark();
                    let Some(result) = outcome else {
                        return Ok(unanswered(inner, cancel));
                    };
                    if !ticket.wait(cancel) {
                        return Ok(counts(0, 1, Some("aborted")));
                    }
                    result?
                }
            };
            // Engine callers provide AgentContext; the pin does not fall back to session-key heuristics.
            if context.origin_wire() != "user" {
                return Ok(counts(0, 1, Some("not_captured")));
            }
            let worker = inner.worker.clone();
            let admission_cancel = cancel.clone();
            let options = options.clone();
            let agent_id = turn.agent_id.to_string();
            let receipt = inner.queue.enqueue(
                &agent_id,
                QueueMeta {
                    background: context.background(),
                    cancel: cancel.clone(),
                    ..QueueMeta::default()
                },
                Box::new(move |effective| {
                    let _lease = lease;
                    *lock(&active_cancel) = Some(effective.clone());
                    if admission_cancel.is_cancelled() || turn.cancel.is_cancelled() {
                        effective.cancel();
                    }
                    worker.capture_host_turn(
                        &turn,
                        &context,
                        &options,
                        metadata.as_deref(),
                        replay,
                        &effective,
                    )
                }),
            );
            // The queue now owns the submission. Never retain an admission ticket while waiting
            // for row work, or an identical replay waiter would block unrelated turns for this agent.
            ticket.release();
            let outcome = receipt
                .recv()
                .map_err(|_| EngineError::Host(HostError::Unavailable))?;
            if outcome.ok {
                Ok(outcome.result.unwrap_or_else(|| counts(0, 0, None)))
            } else {
                Ok(counts(
                    0,
                    1,
                    Some(outcome.reason.as_deref().unwrap_or(if outcome.aborted {
                        "aborted"
                    } else {
                        "not_captured"
                    })),
                ))
            }
        },
    )
}

fn with_diagnostic(
    mut result: CaptureResult,
    options: &CaptureOptions,
    scheduled: bool,
) -> CaptureResult {
    if options.defer_post_turn_llm == Some(true) && !scheduled {
        result.diagnostics = Some(vec![PerCallDiagnostic::Inline {
            feature: CaptureInlineFeature::PostTurnLlm,
            reason: CaptureInlineReason::PostTurnRefineUnscheduled,
        }]);
    }
    result
}

fn error_description(error: &EngineError) -> String {
    // Node's public capture catch uses describeError rather than raw callback text.
    let text = error.to_string();
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    format!(
        "Error textLen={} sha={}",
        text.encode_utf16().count(),
        &hash[..12]
    )
}

#[derive(Default)]
struct AdmissionTickets {
    agents: Mutex<Tickets>,
    ready: Condvar,
    next: AtomicU64,
}
#[derive(Default)]
struct Tickets {
    /// Issued tickets per agent, in the order of their turns.
    queues: HashMap<String, VecDeque<u64>>,
    /// Tickets whose turn stepped aside (RE-D162): they keep their place, but nobody waits
    /// for them.
    parked: HashSet<u64>,
}

impl AdmissionTickets {
    fn issue(self: &Arc<Self>, agent: &str) -> AdmissionTicket {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        lock(&self.agents)
            .queues
            .entry(agent.to_owned())
            .or_default()
            .push_back(id);
        AdmissionTicket {
            owner: self.clone(),
            agent: agent.to_owned(),
            id,
            released: AtomicBool::new(false),
        }
    }
}

struct AdmissionTicket {
    owner: Arc<AdmissionTickets>,
    agent: String,
    id: u64,
    released: AtomicBool,
}

impl AdmissionTicket {
    /// Wait until every earlier ticket of the agent is released or parked.
    fn wait(&self, cancel: &Cancel) -> bool {
        let mut agents = lock(&self.owner.agents);
        loop {
            // A released ticket has left the order and waits for nobody.
            if self.released.load(Ordering::Acquire) {
                return true;
            }
            let front = agents
                .queues
                .get(&self.agent)
                .and_then(|queue| queue.iter().find(|id| !agents.parked.contains(id)))
                .copied();
            if front == Some(self.id) {
                break;
            }
            if cancel.is_cancelled() {
                drop(agents);
                self.release();
                return false;
            }
            let budget = cancel
                .remaining()
                .unwrap_or(Duration::from_millis(5))
                .min(Duration::from_millis(5));
            agents = self
                .owner
                .ready
                .wait_timeout(agents, budget)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        // The ticket mutex is released before touching replay state. The replay wait hook
        // may acquire this mutex while it holds replay state; the reverse order never occurs.
        true
    }

    /// Step aside: keep the place, let later turns of the agent pass.
    fn park(&self) {
        if !self.released.load(Ordering::Acquire) {
            lock(&self.owner.agents).parked.insert(self.id);
            self.owner.ready.notify_all();
        }
    }

    fn unpark(&self) {
        lock(&self.owner.agents).parked.remove(&self.id);
        self.owner.ready.notify_all();
    }

    fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut agents = lock(&self.owner.agents);
        agents.parked.remove(&self.id);
        if let Some(queue) = agents.queues.get_mut(&self.agent) {
            if let Some(position) = queue.iter().position(|id| *id == self.id) {
                queue.remove(position);
            }
            if queue.is_empty() {
                agents.queues.remove(&self.agent);
            }
        }
        self.owner.ready.notify_all();
    }
}

impl Drop for AdmissionTicket {
    fn drop(&mut self) {
        self.release();
    }
}

/// Turns that stepped aside for their own owner's recovery (RE-D162), in order per owner.
#[derive(Default)]
struct OwnerGate {
    state: Mutex<OwnerTurns>,
    changed: Condvar,
}
#[derive(Default)]
struct OwnerTurns {
    /// Turns between stepping aside and reaching the front of their agent's order again.
    staged: usize,
    /// Ticket IDs per owner, ascending.
    lines: HashMap<String, Vec<u64>>,
}
impl OwnerGate {
    /// While a turn is staged, later turns resolve their owner too, so that a turn of the
    /// same owner cannot overtake it.
    fn busy(&self) -> bool {
        lock(&self.state).staged > 0
    }
}

/// One staged turn; dropping it frees its place.
struct OwnerTurn {
    inner: Arc<Inner>,
    id: u64,
    owner: Option<String>,
}
impl OwnerTurn {
    fn enter(inner: &Arc<Inner>, id: u64) -> Self {
        lock(&inner.owners.state).staged += 1;
        Self {
            inner: inner.clone(),
            id,
            owner: None,
        }
    }

    fn line_up(&mut self, owner: String) {
        let mut state = lock(&self.inner.owners.state);
        let line = state.lines.entry(owner.clone()).or_default();
        let at = line.partition_point(|id| *id < self.id);
        line.insert(at, self.id);
        drop(state);
        self.owner = Some(owner);
    }

    fn wait_front(&self, cancel: &Cancel) -> bool {
        let Some(owner) = &self.owner else {
            return true;
        };
        let gate = &self.inner.owners;
        let mut state = lock(&gate.state);
        while state.lines.get(owner).and_then(|line| line.first()) != Some(&self.id) {
            if cancel.is_cancelled() {
                return false;
            }
            let pause = cancel
                .remaining()
                .unwrap_or(Duration::from_millis(5))
                .min(Duration::from_millis(5));
            state = gate
                .changed
                .wait_timeout(state, pause)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }
}
impl Drop for OwnerTurn {
    fn drop(&mut self) {
        let gate = &self.inner.owners;
        let mut state = lock(&gate.state);
        state.staged = state.staged.saturating_sub(1);
        if let Some(owner) = self.owner.take() {
            if let Some(line) = state.lines.get_mut(&owner) {
                line.retain(|id| *id != self.id);
                if line.is_empty() {
                    state.lines.remove(&owner);
                }
            }
        }
        gate.changed.notify_all();
    }
}

#[cfg(test)]
#[path = "accept_lifecycle_tests.rs"]
mod lifecycle_tests;
