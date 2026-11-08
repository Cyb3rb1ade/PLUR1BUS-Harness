//! Non-blocking capture receipts, admission and replay/queue composition (RE-05/T1).
//!
//! The row-producing worker is supplied by the later capture stages. It receives the
//! real planned/settled callbacks; Neo journal event construction remains in RE-05/T5.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::context::RequestContext;
use crate::contract::{
    Cancel, CaptureHandle, CaptureInlineFeature, CaptureInlineReason, CaptureOptions,
    CaptureResult, EngineError, HostError, HostServices, PerCallDiagnostic, TurnRecord,
};

use super::cancel_link::CancellationLinks;
use super::queue::{CaptureQueue, QueueMeta};
use super::replay_guard::{turn_key_of, ReplayGuard, ReplayRows};
use super::result::counts;

/// Row work supplied by the composed capture pipeline, not by the public contract.
pub trait CaptureWorker: Send + Sync {
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
}

struct Inner {
    host: Arc<dyn HostServices>,
    worker: Arc<dyn CaptureWorker>,
    queue: Arc<CaptureQueue>,
    replay: ReplayGuard,
    scheduled: bool,
    closing: AtomicBool,
    links: CancellationLinks,
    admissions: Arc<AdmissionTickets>,
    submissions: Mutex<Vec<JoinHandle<()>>>,
}

/// Capture service owning resources that must outlive an immediately returned receipt.
pub struct CaptureRuntime(Arc<Inner>);

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

impl CaptureRuntime {
    /// Compose host, pipeline worker, scheduler and WAL; no store is opened by construction.
    /// `scheduled` is the host's post-turn-refine scheduling capability (CA-R1).
    pub fn new(
        host: Arc<dyn HostServices>,
        worker: Arc<dyn CaptureWorker>,
        queue: Arc<CaptureQueue>,
        replay: ReplayGuard,
        scheduled: bool,
    ) -> Result<Self, EngineError> {
        if !replay.is_durable() {
            return Err(EngineError::Invalid {
                field: "capture".into(),
                message: "durable capture WAL required".into(),
            });
        }
        Ok(Self(Arc::new(Inner {
            host,
            worker,
            queue,
            replay,
            scheduled,
            closing: AtomicBool::new(false),
            links: CancellationLinks::new()?,
            admissions: Arc::new(AdmissionTickets::default()),
            submissions: Mutex::new(Vec::new()),
        })))
    }

    /// Return a receipt without waiting for identity I/O, the agent queue, providers or writes.
    /// Receipt aborts never change the caller's original cancellation token.
    pub fn accept(
        &self,
        turn: TurnRecord,
        options: CaptureOptions,
    ) -> Result<CaptureHandle, EngineError> {
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
        let immediate = if self.0.closing.load(Ordering::Acquire) {
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
            let handle = thread::Builder::new()
                .name("capture-admission".into())
                .spawn(move || {
                    let result = execute(
                        &inner,
                        turn,
                        &options,
                        &cancel,
                        lease,
                        active_cancel,
                        &ticket,
                    )
                    .unwrap_or_else(|error| counts(0, 1, Some(&error_description(&error))));
                    let _ = send.send(with_diagnostic(result, &options, inner.scheduled));
                })
                .map_err(|_| EngineError::Host(HostError::Failed))?;
            let mut submissions = lock(&self.0.submissions);
            let mut active = Vec::with_capacity(submissions.len() + 1);
            for task in submissions.drain(..) {
                if task.is_finished() {
                    let _ = task.join();
                } else {
                    active.push(task);
                }
            }
            active.push(handle);
            *submissions = active;
        }
        Ok(CaptureHandle {
            id,
            accepted_at,
            done,
            abort,
        })
    }

    /// Stop new capture work and drain scheduler/admission threads within one shared budget.
    /// False means some worker has not yet settled; no thread is forcefully terminated.
    pub fn close(&self, budget: Duration) -> bool {
        self.0.closing.store(true, Ordering::Release);
        let started = Instant::now();
        let drained = self.0.queue.close(budget);
        loop {
            let mut tasks = lock(&self.0.submissions);
            let mut active = Vec::new();
            for task in tasks.drain(..) {
                if task.is_finished() {
                    let _ = task.join();
                } else {
                    active.push(task);
                }
            }
            *tasks = active;
            if tasks.is_empty() {
                return drained;
            }
            if started.elapsed() >= budget {
                return false;
            }
            drop(tasks);
            thread::sleep(Duration::from_millis(1));
        }
    }
}

fn execute(
    inner: &Arc<Inner>,
    turn: TurnRecord,
    options: &CaptureOptions,
    cancel: &Cancel,
    lease: Arc<()>,
    active_cancel: Arc<Mutex<Option<Cancel>>>,
    ticket: &AdmissionTicket,
) -> Result<CaptureResult, EngineError> {
    if !ticket.wait(cancel) {
        return Ok(counts(0, 1, Some("aborted")));
    }
    let key = turn_key_of(&turn)?;
    let replay_agent = turn.agent_id.to_string();
    inner.replay.run_with_wait_hook(
        &replay_agent,
        &key,
        cancel,
        || ticket.release(),
        |replay| {
            let context = RequestContext::build(&turn.principal, &turn.agent, inner.host.as_ref())?;
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
                    worker.capture(&turn, &context, &options, replay, &effective)
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
    agents: Mutex<HashMap<String, VecDeque<u64>>>,
    ready: Condvar,
    next: AtomicU64,
}

impl AdmissionTickets {
    fn issue(self: &Arc<Self>, agent: &str) -> AdmissionTicket {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        lock(&self.agents)
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
    fn wait(&self, cancel: &Cancel) -> bool {
        let mut agents = lock(&self.owner.agents);
        while agents
            .get(&self.agent)
            .and_then(|queue| queue.front())
            .copied()
            != Some(self.id)
        {
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

    fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut agents = lock(&self.owner.agents);
        if let Some(queue) = agents.get_mut(&self.agent) {
            if let Some(position) = queue.iter().position(|id| *id == self.id) {
                queue.remove(position);
            }
            if queue.is_empty() {
                agents.remove(&self.agent);
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
