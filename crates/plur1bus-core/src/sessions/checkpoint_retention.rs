//! `session/checkpoint-retention.ts`: the lifecycle of the private checkpoint refs. Bounded turn retention, cleanup when a
//! session is archived or erased, and the sweep that notices a finished card. Every pruning step writes its audit line first
//! and releases the ref second, so an interrupted cleanup stays discoverable and repeats.
//!
//! **No timer and no task.** The TypeScript class queues promises per session and arms a 10 second `setTimeout`. Here
//! everything is synchronous and the host drives it (R-K-2): [`CheckpointRetention::tick`] is the timer (it sweeps when the
//! 10 s armed after the last job have passed on the [`Clock`]), [`CheckpointRetention::idle`] runs what is pending (an
//! archive observed by the listener, the sweep a restart starts, a prune deferred behind a running job), and
//! [`CheckpointRetention::run`] is the per-session queue. The store is not owned: every call takes it, so a restore that waits
//! for a person can be given the store to run maintenance with (see [`super::rewind_checkpoints::RestoreApproval`]).
//!
//! Per-session serialisation is kept by a busy set: work for a session that is already running (a sweep started from inside
//! the approval wait of a restore) is deferred and runs when that job ends, as the TypeScript queue runs it after the job. A
//! second [`CheckpointRetention::run`] for a running session cannot wait (nothing runs concurrently here) and is refused with
//! `rewind-checkpoint-busy`; TypeScript would queue it.
use super::rewind_git::{AbortReason, Cancel, RewindError};
use super::types::StoredCheckpoint;
use super::{Clock, SessionError, SessionStore};
use crate::rbac::audit::{AuditEvent, AuditSink};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::{Arc, Mutex, PoisonError};

const SWEEP_MS: i64 = 10_000;
const DEFAULT_TURNS: i64 = 50;

/// The audit sink shared by the checkpoint code and its retention (TypeScript passes one object to both).
pub type SharedAudit = Rc<RefCell<Box<dyn AuditSink>>>;
/// `cardEnded(projectId, cardId)`. An `Err` is a throw: the card counts as not ended and cleanup warns once.
pub type CardEndedFn = Rc<dyn Fn(&str, &str) -> Result<bool, String>>;
/// `retentionTurns()`: a JavaScript number, so the value is judged as `Number.isSafeInteger(n) && 1 <= n <= 500`.
pub type RetentionTurnsFn = Rc<dyn Fn() -> f64>;

/// What a checkpoint remover does: `remove(row, signal)`, the owner's way to release one stored checkpoint.
pub trait Remover {
    /// Releases the ref of `row` and nothing else.
    fn remove(
        &self,
        store: &mut SessionStore,
        row: &StoredCheckpoint,
        cancel: &Cancel,
    ) -> Result<(), RewindError>;
}

impl<T> Remover for T
where
    T: Fn(&mut SessionStore, &StoredCheckpoint, &Cancel) -> Result<(), RewindError>,
{
    fn remove(
        &self,
        store: &mut SessionStore,
        row: &StoredCheckpoint,
        cancel: &Cancel,
    ) -> Result<(), RewindError> {
        self(store, row, cancel)
    }
}

/// `CheckpointRetentionDeps` without `store` (passed per call) and `remove` (a [`Remover`] passed per call).
#[derive(Clone)]
pub struct RetentionDeps {
    /// The audit sink.
    pub audit: SharedAudit,
    /// `now()`.
    pub clock: Arc<dyn Clock>,
    /// `retentionTurns`.
    pub retention_turns: Option<RetentionTurnsFn>,
    /// `cardEnded`.
    pub card_ended: Option<CardEndedFn>,
    /// `onCleanupError`.
    pub on_cleanup_error: Option<Rc<dyn Fn()>>,
}

#[derive(Default)]
struct Shared {
    active: HashMap<String, Cancel>,
    archived: Vec<String>,
}

#[derive(Default)]
struct State {
    warned: HashSet<String>,
    timer_at: Option<i64>,
    sweeping: bool,
    busy: HashSet<String>,
    deferred: Vec<String>,
    initial_sweep: bool,
}

/// The checkpoint lifecycle (`CheckpointRetention`).
pub struct CheckpointRetention {
    d: RetentionDeps,
    stop: Cancel,
    shared: Arc<Mutex<Shared>>,
    state: RefCell<State>,
    listener: Cell<Option<u64>>,
    closed: Cell<bool>,
}

fn key(cp: &StoredCheckpoint) -> String {
    format!("{}:{}:{}", cp.session_id, cp.turn_id, cp.commit_id)
}

fn gone() -> RewindError {
    RewindError::Other("checkpoint-lifecycle-closed".into())
}

/// Appends an audit event; the TypeScript sink throws, here an `Err` carries the message.
pub(crate) fn append_audit(
    audit: &SharedAudit,
    at: i64,
    user: &str,
    action: &str,
    target: &str,
    detail: Vec<(String, Value)>,
) -> Result<(), RewindError> {
    audit
        .borrow_mut()
        .append(&AuditEvent {
            at,
            user: user.to_owned(),
            host: "core".to_owned(),
            action: action.to_owned(),
            target: target.to_owned(),
            detail,
        })
        .map_err(RewindError::Other)
}

impl CheckpointRetention {
    /// The constructor: observes archives, and starts the sweep a restart owes when the store holds checkpoints (it runs at
    /// the next [`CheckpointRetention::tick`], [`CheckpointRetention::idle`] or [`CheckpointRetention::run`]).
    pub fn new(store: &mut SessionStore, deps: RetentionDeps) -> Result<Self, SessionError> {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let observed = shared.clone();
        let id = store.on_archived(Arc::new(move |id: &str| {
            let mut s = observed.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(c) = s.active.get(id) {
                c.abort(AbortReason::Session(SessionError::conflict(
                    "checkpoint session was archived",
                    "rewind-checkpoint-unavailable",
                )));
            }
            s.archived.push(id.to_owned());
            Ok(())
        }));
        let initial = store.has_checkpoints()?;
        Ok(Self {
            d: deps,
            stop: Cancel::new(),
            shared,
            state: RefCell::new(State {
                initial_sweep: initial,
                ..State::default()
            }),
            listener: Cell::new(Some(id)),
            closed: Cell::new(false),
        })
    }

    fn shared(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn warn(&self, cp: Option<&StoredCheckpoint>) {
        if self.closed.get() {
            return;
        }
        if let Some(cp) = cp {
            if !self.state.borrow_mut().warned.insert(key(cp)) {
                return;
            }
        }
        if let Some(f) = &self.d.on_cleanup_error {
            f();
        }
    }

    fn ended(&self, cp: &StoredCheckpoint) -> bool {
        match &self.d.card_ended {
            None => false,
            Some(f) => match f(&cp.project_id, &cp.card_id) {
                Ok(v) => v,
                Err(_) => {
                    self.warn(Some(cp));
                    false
                }
            },
        }
    }

    /// `#arm`: a timer exists while checkpoints do.
    fn arm(&self, store: &SessionStore) {
        if self.closed.get() {
            return;
        }
        let mut s = self.state.borrow_mut();
        if !store.has_checkpoints().unwrap_or(false) {
            s.timer_at = None;
        } else if s.timer_at.is_none() {
            s.timer_at = Some(self.d.clock.now() + SWEEP_MS);
        }
    }

    /// `run`: capture, restore and cleanup serialise within a session; `work` gets the store and the combined signal of the
    /// caller, this job and the lifecycle.
    pub fn run<T>(
        &self,
        store: &mut SessionStore,
        remover: &dyn Remover,
        session_id: &str,
        signal: &Cancel,
        work: impl FnOnce(&mut SessionStore, &Cancel) -> Result<T, RewindError>,
    ) -> Result<T, RewindError> {
        if self.closed.get() {
            return Err(gone());
        }
        if self.state.borrow().busy.contains(session_id) {
            return Err(SessionError::conflict(
                "checkpoint session is busy",
                "rewind-checkpoint-busy",
            )
            .into());
        }
        self.drain(store, remover);
        self.stop.throw_if_aborted()?;
        self.state.borrow_mut().busy.insert(session_id.to_owned());
        let local = Cancel::new();
        let combined = Cancel::any(&[signal, &local, &self.stop]);
        self.shared()
            .active
            .insert(session_id.to_owned(), local.clone());
        let result = self
            .prune(store, remover, session_id, &combined)
            .and_then(|()| combined.throw_if_aborted())
            .and_then(|()| work(store, &combined));
        self.shared().active.remove(session_id);
        self.state.borrow_mut().busy.remove(session_id);
        self.run_deferred(store, remover);
        self.arm(store);
        result
    }

    fn run_deferred(&self, store: &mut SessionStore, remover: &dyn Remover) {
        loop {
            let next = {
                let mut s = self.state.borrow_mut();
                if s.deferred.is_empty() {
                    None
                } else {
                    Some(s.deferred.remove(0))
                }
            };
            let Some(id) = next else { break };
            self.queue_prune(store, remover, &id);
        }
    }

    /// `#queue(id, prune)` with the catch the callers add: a failure only warns.
    fn queue_prune(&self, store: &mut SessionStore, remover: &dyn Remover, id: &str) {
        if self.closed.get() {
            self.warn(None);
            return;
        }
        if self.state.borrow().busy.contains(id) {
            let mut s = self.state.borrow_mut();
            if !s.deferred.iter().any(|d| d == id) {
                s.deferred.push(id.to_owned());
            }
            return;
        }
        self.state.borrow_mut().busy.insert(id.to_owned());
        let result = self
            .stop
            .throw_if_aborted()
            .and_then(|()| self.prune(store, remover, id, &self.stop));
        self.state.borrow_mut().busy.remove(id);
        if result.is_err() {
            self.warn(None);
        }
        self.arm(store);
    }

    fn prune(
        &self,
        store: &mut SessionStore,
        remover: &dyn Remover,
        session_id: &str,
        signal: &Cancel,
    ) -> Result<(), RewindError> {
        let session = store.get_session(session_id)?;
        let requested = self
            .d
            .retention_turns
            .as_ref()
            .map_or(DEFAULT_TURNS as f64, |f| f());
        let turns = if requested.fract() == 0.0
            && requested.abs() <= 9_007_199_254_740_991.0
            && (1.0..=500.0).contains(&requested)
        {
            requested as i64
        } else {
            DEFAULT_TURNS
        };
        let cutoff = store.latest_turn_seq(session_id)? - turns;
        let mut ended: HashMap<String, bool> = HashMap::new();
        for (cp, turn_seq) in store.checkpoints(Some(session_id))? {
            signal.throw_if_aborted()?;
            let k = format!("{}\0{}", cp.project_id, cp.card_id);
            let session_ended = session.as_ref().is_none_or(|s| s.archived_at.is_some());
            if !session_ended && !ended.contains_key(&k) {
                let v = self.ended(&cp);
                ended.insert(k.clone(), v);
            }
            let reason = if session_ended {
                Some("session-ended")
            } else if ended.get(&k).copied().unwrap_or(false) {
                Some("card-ended")
            } else if turn_seq <= cutoff {
                Some("turn-retention")
            } else {
                None
            };
            let Some(reason) = reason else { continue };
            let step = (|| -> Result<(), RewindError> {
                append_audit(
                    &self.d.audit,
                    self.d.clock.now(),
                    "core",
                    "session.checkpoint.pruning",
                    session_id,
                    vec![
                        ("turnId".into(), Value::String(cp.turn_id.clone())),
                        ("projectId".into(), Value::String(cp.project_id.clone())),
                        ("cardId".into(), Value::String(cp.card_id.clone())),
                        ("reason".into(), Value::String(reason.into())),
                    ],
                )?;
                remover.remove(store, &cp, signal)?;
                store.forget_checkpoint(&cp)?;
                self.state.borrow_mut().warned.remove(&key(&cp));
                Ok(())
            })();
            if step.is_err() {
                signal.throw_if_aborted()?;
                self.warn(Some(&cp));
            }
        }
        Ok(())
    }

    /// `sweep`: a read-only pass over every stored checkpoint that notices an ended card (aborting the session's running
    /// job) and prunes every session that is not itself in the middle of a job.
    pub fn sweep(
        &self,
        store: &mut SessionStore,
        remover: &dyn Remover,
    ) -> Result<(), RewindError> {
        if self.closed.get() || self.state.borrow().sweeping {
            return Ok(());
        }
        self.state.borrow_mut().sweeping = true;
        let result = self.sweep_body(store, remover);
        self.state.borrow_mut().sweeping = false;
        self.arm(store);
        result
    }

    fn sweep_body(
        &self,
        store: &mut SessionStore,
        remover: &dyn Remover,
    ) -> Result<(), RewindError> {
        let rows: Vec<StoredCheckpoint> = store
            .checkpoints(None)?
            .into_iter()
            .map(|(c, _)| c)
            .collect();
        let mut ended: HashMap<String, bool> = HashMap::new();
        let mut ended_sessions: HashSet<String> = HashSet::new();
        for cp in &rows {
            let k = format!("{}\0{}", cp.project_id, cp.card_id);
            if !ended.contains_key(&k) {
                let v = self.ended(cp);
                ended.insert(k.clone(), v);
            }
            if ended[&k] {
                ended_sessions.insert(cp.session_id.clone());
                if let Some(c) = self.shared().active.get(&cp.session_id) {
                    c.abort(AbortReason::Session(SessionError::conflict(
                        "checkpoint card has ended",
                        "rewind-checkpoint-unavailable",
                    )));
                }
            }
        }
        let mut seen = HashSet::new();
        for cp in &rows {
            if !seen.insert(cp.session_id.clone()) {
                continue;
            }
            if self.closed.get() {
                break;
            }
            let active = self.shared().active.contains_key(&cp.session_id);
            if active && !ended_sessions.contains(&cp.session_id) {
                continue;
            }
            self.queue_prune(store, remover, &cp.session_id);
        }
        Ok(())
    }

    /// Runs what is pending: archives the listener saw, the sweep a restart owes.
    fn drain(&self, store: &mut SessionStore, remover: &dyn Remover) {
        loop {
            let ids: Vec<String> = std::mem::take(&mut self.shared().archived);
            let initial = std::mem::take(&mut self.state.borrow_mut().initial_sweep);
            if ids.is_empty() && !initial {
                break;
            }
            for id in ids {
                self.queue_prune(store, remover, &id);
            }
            if initial && self.sweep(store, remover).is_err() {
                self.warn(None);
            }
        }
    }

    /// `idle`: everything pending has run.
    pub fn idle(&self, store: &mut SessionStore, remover: &dyn Remover) {
        self.drain(store, remover);
        self.run_deferred(store, remover);
    }

    /// The timer: sweeps when the 10 s armed after the last job have passed. Returns whether a sweep ran.
    pub fn tick(&self, store: &mut SessionStore, remover: &dyn Remover) -> bool {
        self.drain(store, remover);
        let due = {
            let mut s = self.state.borrow_mut();
            match s.timer_at {
                Some(t) if self.d.clock.now() >= t => {
                    s.timer_at = None;
                    true
                }
                _ => false,
            }
        };
        if due && self.sweep(store, remover).is_err() {
            self.warn(None);
        }
        due
    }

    /// Whether a timer is armed, and when it fires (the `#timer` of the TypeScript class).
    pub fn timer_at(&self) -> Option<i64> {
        self.state.borrow().timer_at
    }

    /// `close`: stops observing, aborts every running job and forgets the warnings.
    pub fn close(&self, store: &mut SessionStore) {
        self.closed.set(true);
        if let Some(id) = self.listener.take() {
            store.remove_archive_listener(id);
        }
        let mut s = self.state.borrow_mut();
        s.timer_at = None;
        s.warned.clear();
        drop(s);
        self.stop.abort(AbortReason::Closed);
    }
}
