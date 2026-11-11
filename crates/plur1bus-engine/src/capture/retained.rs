//! Retained capture work by key, and the one recovery attempt in flight per key (RE-D162).
//!
//! A key is an owner scope (admission records) or an owner binding (Neo plans). The startup
//! inventory marks keys; the background pass and each owner's own next turn start attempts.
//! Every attempt runs on its own thread: whoever waits for it holds nothing another owner
//! needs, and an attempt whose host call never returns keeps only its own key busy.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::contract::Cancel;

#[derive(Default)]
struct State {
    /// Keys with retained work and no attempt in flight.
    pending: BTreeSet<String>,
    /// Keys whose attempt is in flight.
    running: BTreeSet<String>,
    /// Of those, the keys whose attempt only applies the age bound and resumes nothing.
    sweeping: BTreeSet<String>,
    /// After close no attempt starts.
    closed: bool,
}

/// The retained work of one kind (owner scopes, or Neo bindings).
#[derive(Default)]
pub(crate) struct Retained {
    state: Mutex<State>,
    changed: Condvar,
}

/// Ends an attempt: the key leaves the running set and, unless settled, waits again.
struct Flight {
    owner: Arc<Retained>,
    key: String,
    settled: bool,
}
impl Flight {
    fn finish(mut self, attempt: impl FnOnce() -> bool) {
        self.settled = attempt();
    }
}
impl Drop for Flight {
    fn drop(&mut self) {
        let mut state = self.owner.lock();
        state.running.remove(&self.key);
        state.sweeping.remove(&self.key);
        if !self.settled {
            state.pending.insert(std::mem::take(&mut self.key));
        }
        self.owner.changed.notify_all();
    }
}

impl Retained {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Take a fresh inventory's keys as pending; keys in flight are left to their attempt.
    pub(crate) fn replace(&self, keys: impl IntoIterator<Item = String>) {
        let mut state = self.lock();
        state.pending = keys
            .into_iter()
            .filter(|key| !state.running.contains(key))
            .collect();
        self.changed.notify_all();
    }

    /// Note retained work for a key.
    pub(crate) fn mark(&self, key: &str) {
        self.lock().pending.insert(key.to_owned());
    }

    /// The key's work was finished outside an attempt (for example by its owner's turn).
    pub(crate) fn settle(&self, key: &str) {
        self.lock().pending.remove(key);
    }

    /// The keys waiting for an attempt.
    pub(crate) fn keys(&self) -> Vec<String> {
        self.lock().pending.iter().cloned().collect()
    }

    /// Whether any key waits or is in flight (the status, and the cheap test before a turn
    /// resolves its own key).
    pub(crate) fn waiting(&self) -> bool {
        let state = self.lock();
        !state.pending.is_empty() || !state.running.is_empty()
    }

    /// Whether this key waits or is in flight.
    pub(crate) fn concerns(&self, key: &str) -> bool {
        let state = self.lock();
        state.pending.contains(key) || state.running.contains(key)
    }

    /// Start one attempt for a waiting key on its own thread; `attempt` returns whether the
    /// key's work is finished. True when an attempt for the key is in flight afterwards
    /// (this one or an earlier one): a second attempt is never started.
    pub(crate) fn start(
        self: &Arc<Self>,
        key: &str,
        thread_name: &str,
        attempt: impl FnOnce() -> bool + Send + 'static,
    ) -> bool {
        self.start_as(key, thread_name, false, attempt) != Started::None
    }

    /// [`Self::start`], telling what happened. `sweep` marks an attempt that only applies
    /// the age bound: whoever joins it knows that it resumes nothing.
    pub(crate) fn start_as(
        self: &Arc<Self>,
        key: &str,
        thread_name: &str,
        sweep: bool,
        attempt: impl FnOnce() -> bool + Send + 'static,
    ) -> Started {
        let mut state = self.lock();
        if state.running.contains(key) {
            return Started::Joined {
                sweep: state.sweeping.contains(key),
            };
        }
        if state.closed || !state.pending.remove(key) {
            return Started::None;
        }
        state.running.insert(key.to_owned());
        if sweep {
            state.sweeping.insert(key.to_owned());
        }
        drop(state);
        let flight = Flight {
            owner: self.clone(),
            key: key.to_owned(),
            settled: false,
        };
        // The thread owns the whole flight. A closure that never runs, or an attempt that
        // panics, drops it unsettled, which returns the key to pending.
        match thread::Builder::new()
            .name(thread_name.to_owned())
            .spawn(move || flight.finish(attempt))
        {
            Ok(_) => Started::Own,
            Err(_) => Started::None,
        }
    }

    /// Before an owner's turn: join the attempt in flight for its key, or start one, and
    /// wait for it until `cancel` or `stop`. A joined attempt that only applied the age
    /// bound resumed nothing (RE-D163): if the key still waits afterwards, exactly one
    /// attempt of the owner's own is started and waited for as well.
    pub(crate) fn recover_own<A: FnOnce() -> bool + Send + 'static>(
        self: &Arc<Self>,
        key: &str,
        thread_name: &str,
        cancel: &Cancel,
        stop: &Cancel,
        attempt: impl Fn() -> A,
    ) {
        let first = self.start_as(key, thread_name, false, attempt());
        if first == Started::None || !self.join(key, cancel, stop) {
            return;
        }
        if first == (Started::Joined { sweep: true })
            && self.start_as(key, thread_name, false, attempt()) != Started::None
        {
            self.join(key, cancel, stop);
        }
    }

    /// Wait until no attempt for the key is in flight; false when the waiter's `cancel` or
    /// the end of all recovery (`stop`) ended the wait first.
    pub(crate) fn join(&self, key: &str, cancel: &Cancel, stop: &Cancel) -> bool {
        let mut state = self.lock();
        while state.running.contains(key) {
            if cancel.is_cancelled() || stop.is_cancelled() {
                return false;
            }
            let pause = cancel
                .remaining()
                .unwrap_or(Duration::from_millis(20))
                .min(Duration::from_millis(20));
            state = self
                .changed
                .wait_timeout(state, pause)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }

    /// Start no attempt any more.
    pub(crate) fn close(&self) {
        self.lock().closed = true;
        self.changed.notify_all();
    }

    /// Wait within `budget` until no attempt is in flight.
    pub(crate) fn drained(&self, budget: Duration) -> bool {
        let end = Instant::now() + budget;
        let mut state = self.lock();
        while !state.running.is_empty() {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }
}

/// What starting an attempt for a key gave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Started {
    /// This call started the attempt.
    Own,
    /// An attempt was already in flight; `sweep`: it only applies the age bound.
    Joined {
        /// The attempt in flight resumes nothing.
        sweep: bool,
    },
    /// Nothing waits for the key, or no attempt starts any more.
    None,
}

/// Host lookups one agent may have outstanding (RE-D163).
pub(crate) const HOST_CALLS_PER_AGENT: usize = 2;
/// Host lookups one runtime may have outstanding.
pub(crate) const HOST_CALLS: usize = 32;
/// How long a lookup waits for a place at most, within its caller's own budget: a host
/// whose calls have not returned for this long is not answering. Waiting takes no thread,
/// so the wait may be long without touching the bound; a short one would lose turns to a
/// host that is merely slow.
pub(crate) const PLACE_PATIENCE: Duration = Duration::from_secs(10);

/// The bound on host lookups that run on a thread of their own because the host may never
/// answer (RE-D163): every such thread holds a place until its host call returns, not
/// until its waiter gives up. So threads cannot pile up behind a host that hangs for one
/// agent, and that agent cannot use up the places of the others beyond its own two.
#[derive(Default)]
pub struct HostCalls {
    state: Mutex<Calls>,
    changed: Condvar,
}
#[derive(Default)]
struct Calls {
    /// Start times of the outstanding lookups, per agent.
    agents: HashMap<String, Vec<Instant>>,
    total: usize,
    /// Callers waiting for a place right now.
    #[cfg(test)]
    waiting: usize,
}
/// One outstanding lookup; dropping it (when the host call has returned) frees the place.
pub(crate) struct HostCall {
    owner: Arc<HostCalls>,
    agent: String,
    started: Instant,
}
impl Drop for HostCall {
    fn drop(&mut self) {
        let mut calls = self
            .owner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let calls = &mut *calls;
        if let Some(started) = calls.agents.get_mut(&self.agent) {
            if let Some(at) = started.iter().position(|at| *at == self.started) {
                started.swap_remove(at);
                calls.total = calls.total.saturating_sub(1);
            }
            if started.is_empty() {
                calls.agents.remove(&self.agent);
            }
        }
        self.owner.changed.notify_all();
    }
}
impl HostCalls {
    /// Ask for a place for one more lookup of `agent`. While the agent's two places or the
    /// runtime's 32 are taken the caller waits, on its own thread and without a new one,
    /// until a place frees or `until` comes. `None`: no place by then, or `cancel` or the
    /// end of all recovery (`stop`) ended the wait. Places are not handed out in order.
    pub(crate) fn begin(
        self: &Arc<Self>,
        agent: &str,
        cancel: &Cancel,
        stop: &Cancel,
        until: Instant,
    ) -> Option<HostCall> {
        let mut calls = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        #[cfg(test)]
        let mut counted = false;
        let place = loop {
            if cancel.is_cancelled() || stop.is_cancelled() {
                break None;
            }
            let now = Instant::now();
            let own = calls.agents.get(agent).map_or(0, Vec::len);
            if own < HOST_CALLS_PER_AGENT && calls.total < HOST_CALLS {
                calls.agents.entry(agent.to_owned()).or_default().push(now);
                calls.total += 1;
                break Some(HostCall {
                    owner: self.clone(),
                    agent: agent.to_owned(),
                    started: now,
                });
            }
            if now >= until {
                break None;
            }
            #[cfg(test)]
            if !counted {
                calls.waiting += 1;
                counted = true;
            }
            let pause = until
                .saturating_duration_since(now)
                .min(Duration::from_millis(20));
            calls = self
                .changed
                .wait_timeout(calls, pause)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        };
        #[cfg(test)]
        if counted {
            calls.waiting -= 1;
        }
        place
    }

    /// Test support: the callers waiting for a place right now.
    #[cfg(test)]
    pub(crate) fn waiting(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .waiting
    }

    /// The lookups outstanding right now.
    pub(crate) fn outstanding(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .total
    }
}

/// What bounds recovery besides each attempt's own budget (RE-D163).
#[derive(Clone)]
pub struct Bounds {
    /// Ends all recovery (close). After it no host lookup starts.
    pub(crate) shutdown: Cancel,
    /// The places for host lookups that run on a thread of their own.
    pub(crate) calls: Arc<HostCalls>,
}
impl Bounds {
    /// Bounds of their own, for a store that is opened outside a capture runtime.
    pub(crate) fn new(shutdown: Cancel) -> Self {
        Self {
            shutdown,
            calls: Arc::default(),
        }
    }

    /// [`bounded`] within these bounds.
    pub(crate) fn host_call<T: Send + 'static>(
        &self,
        agent: &str,
        thread_name: &str,
        cancel: &Cancel,
        budget: Duration,
        call: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        bounded(
            &self.calls,
            agent,
            thread_name,
            cancel,
            &self.shutdown,
            budget,
            call,
        )
    }
}

/// Run a host call that may never return on its own thread and wait for its answer until
/// `cancel`, the end of all recovery (`stop`) or `budget` ends the wait. The thread holds a
/// place in `calls` until the host call returns; the call waits for that place within its
/// budget, at most [`PLACE_PATIENCE`]. `None`: no place, no thread, or no answer in time;
/// a thread that is still running is left to finish and its answer is dropped.
pub(crate) fn bounded<T: Send + 'static>(
    calls: &Arc<HostCalls>,
    agent: &str,
    thread_name: &str,
    cancel: &Cancel,
    stop: &Cancel,
    budget: Duration,
    call: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let asked = Instant::now();
    let end = asked + budget;
    let place = calls.begin(agent, cancel, stop, asked + budget.min(PLACE_PATIENCE))?;
    let (send, answer) = std::sync::mpsc::channel();
    // A thread that cannot start drops the closure and with it the place.
    thread::Builder::new()
        .name(thread_name.to_owned())
        .spawn(move || {
            let value = call();
            drop(place);
            let _ = send.send(value);
        })
        .ok()?;
    loop {
        match answer.recv_timeout(Duration::from_millis(20)) {
            Ok(value) => return Some(value),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if cancel.is_cancelled() || stop.is_cancelled() || Instant::now() >= end {
                    return None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    #[test]
    fn one_attempt_per_key_and_an_unfinished_key_waits_again() {
        let retained = Arc::new(Retained::default());
        retained.replace(["a".to_owned(), "b".to_owned()]);
        assert!(retained.waiting());
        let (release, gate) = mpsc::channel::<bool>();
        assert!(retained.start("a", "test-attempt", move || gate.recv().unwrap()));
        // A second start joins the attempt in flight instead of starting another.
        assert!(retained.start("a", "test-attempt", || unreachable!()));
        assert!(retained.concerns("a"));
        assert_eq!(retained.keys(), ["b"]);
        // A waiter with a deadline gives up; the attempt goes on.
        let deadline = Cancel::with_deadline(Instant::now() + Duration::from_millis(30));
        let never = Cancel::never();
        assert!(!retained.join("a", &deadline, &never));
        let stopped = Cancel::never();
        stopped.cancel();
        assert!(!retained.join("a", &never, &stopped));
        release.send(false).unwrap();
        assert!(retained.join("a", &never, &never));
        // Unfinished: the key waits again; nothing is in flight.
        assert_eq!(retained.keys(), ["a", "b"]);
        assert!(retained.drained(Duration::ZERO));
        assert!(retained.start("a", "test-attempt", || true));
        assert!(retained.join("a", &never, &never));
        assert_eq!(retained.keys(), ["b"]);
        // No key, no attempt; after close, no attempt at all.
        assert!(!retained.start("unknown", "test-attempt", || unreachable!()));
        retained.close();
        assert!(!retained.start("b", "test-attempt", || unreachable!()));
        assert_eq!(retained.keys(), ["b"]);
        retained.settle("b");
        assert!(!retained.waiting());
    }

    #[test]
    fn a_panicking_attempt_returns_its_key() {
        let retained = Arc::new(Retained::default());
        retained.mark("a");
        assert!(retained.start("a", "test-attempt", || panic!("fixture")));
        assert!(retained.join("a", &Cancel::never(), &Cancel::never()));
        assert_eq!(retained.keys(), ["a"]);
    }

    #[test]
    fn a_bounded_call_answers_or_ends_the_wait() {
        let never = Cancel::never();
        let calls = Arc::new(HostCalls::default());
        let call = |budget, call: Box<dyn FnOnce() -> i32 + Send>| {
            bounded(&calls, "agent", "test-call", &never, &never, budget, call)
        };
        assert_eq!(call(Duration::from_secs(5), Box::new(|| 7)), Some(7));
        assert_eq!(calls.outstanding(), 0);
        let (release, gate) = mpsc::channel::<()>();
        let slow = call(
            Duration::from_millis(30),
            Box::new(move || {
                let _ = gate.recv();
                7
            }),
        );
        assert_eq!(slow, None);
        // The thread still holds its place: the host call has not returned.
        assert_eq!(calls.outstanding(), 1);
        drop(release);
        let end = Instant::now() + Duration::from_secs(5);
        while calls.outstanding() > 0 {
            assert!(Instant::now() < end);
            thread::sleep(Duration::from_millis(1));
        }
        // After the end of all recovery no call starts.
        let stopped = Cancel::never();
        stopped.cancel();
        let late = bounded(
            &calls,
            "agent",
            "test-call",
            &never,
            &stopped,
            Duration::from_secs(5),
            || unreachable!(),
        );
        assert_eq!(late, None::<i32>);
    }

    /// RE-D163 / m5: an owner's turn that joined an attempt which only applied the age bound
    /// starts exactly one attempt of its own afterwards; one that joined a recovery attempt
    /// starts none.
    #[test]
    fn joining_a_sweep_is_followed_by_exactly_one_own_attempt() {
        for sweep in [true, false] {
            let retained = Arc::new(Retained::default());
            retained.mark("scope");
            let (release, gate) = mpsc::channel::<()>();
            // The attempt in flight leaves the key waiting, as a sweep without expired
            // input or a deferred recovery does.
            let started = retained.start_as("scope", "test-attempt", sweep, move || {
                let _ = gate.recv();
                false
            });
            assert_eq!(started, Started::Own);
            let own = Arc::new(AtomicUsize::new(0));
            let turn = {
                let (retained, own) = (retained.clone(), own.clone());
                thread::spawn(move || {
                    let never = Cancel::never();
                    retained.recover_own("scope", "test-attempt", &never, &never, || {
                        let own = own.clone();
                        move || {
                            own.fetch_add(1, Ordering::AcqRel);
                            true
                        }
                    });
                })
            };
            thread::sleep(Duration::from_millis(30));
            assert_eq!(own.load(Ordering::Acquire), 0, "sweep={sweep}");
            drop(release);
            turn.join().unwrap();
            assert_eq!(
                own.load(Ordering::Acquire),
                usize::from(sweep),
                "sweep={sweep}"
            );
            // After the owner's own attempt nothing waits; after a joined recovery attempt
            // the key waits for the next pass, as before.
            assert_eq!(retained.waiting(), !sweep, "sweep={sweep}");
        }
    }

    /// RE-D163 / R1: two outstanding lookups per agent, 32 per runtime, exactly. A lookup
    /// beyond the bound waits for a place until its own limit and takes one that frees; no
    /// place by then is no lookup.
    #[test]
    fn outstanding_host_lookups_are_bounded_per_agent_and_in_the_runtime() {
        let never = Cancel::never();
        let calls = Arc::new(HostCalls::default());
        let now = Instant::now;
        let granted = |agent: &str| calls.begin(agent, &never, &never, now()).unwrap();
        let waiting = |count: usize| {
            let end = now() + Duration::from_secs(30);
            while calls.waiting() != count {
                assert!(now() < end, "{count} waiting");
                thread::yield_now();
            }
        };
        let first = granted("x");
        let second = granted("x");
        // The agent's bound is reached: no place now.
        assert!(calls.begin("x", &never, &never, now()).is_none());
        assert_eq!(calls.outstanding(), 2);
        // Another agent is not affected by this agent's bound.
        let other = granted("y");
        // A lookup that waits takes the place that frees. The hook shows that it waits.
        let waiter = {
            let calls = calls.clone();
            thread::spawn(move || {
                let never = Cancel::never();
                calls.begin(
                    "x",
                    &never,
                    &never,
                    Instant::now() + Duration::from_secs(30),
                )
            })
        };
        waiting(1);
        assert_eq!(calls.outstanding(), 3);
        drop(first);
        let third = waiter.join().unwrap().unwrap();
        waiting(0);
        // The wait ends with its limit, however old the lookups in the way are, and with
        // the waiter's cancellation or the end of all recovery.
        let asked = now();
        let limit = Duration::from_millis(50);
        assert!(calls.begin("x", &never, &never, asked + limit).is_none());
        assert!(asked.elapsed() >= limit);
        let cancelled = Cancel::never();
        cancelled.cancel();
        let far = now() + Duration::from_secs(30);
        assert!(calls.begin("x", &cancelled, &never, far).is_none());
        assert!(calls.begin("x", &never, &cancelled, far).is_none());
        // The runtime's bound: 32 outstanding, then no place for one more agent either.
        let mut held = vec![second, third, other];
        for index in 0..HOST_CALLS - held.len() {
            held.push(granted(&format!("agent-{index}")));
        }
        assert_eq!(calls.outstanding(), HOST_CALLS);
        assert!(calls.begin("one-more", &never, &never, now()).is_none());
        drop(held);
        assert_eq!(calls.outstanding(), 0);
        drop(granted("one-more"));
    }
}
