//! Retained capture work by key, and the one recovery attempt in flight per key (RE-D162).
//!
//! A key is an owner scope (admission records) or an owner binding (Neo plans). The startup
//! inventory marks keys; the background pass and each owner's own next turn start attempts.
//! Every attempt runs on its own thread: whoever waits for it holds nothing another owner
//! needs, and an attempt whose host call never returns keeps only its own key busy.

use std::collections::BTreeSet;
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
        let mut state = self.lock();
        if state.running.contains(key) {
            return true;
        }
        if state.closed || !state.pending.remove(key) {
            return false;
        }
        state.running.insert(key.to_owned());
        drop(state);
        let flight = Flight {
            owner: self.clone(),
            key: key.to_owned(),
            settled: false,
        };
        // The thread owns the whole flight. A closure that never runs, or an attempt that
        // panics, drops it unsettled, which returns the key to pending.
        thread::Builder::new()
            .name(thread_name.to_owned())
            .spawn(move || flight.finish(attempt))
            .is_ok()
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

/// Run a call that may never return (a host callback) on its own thread and wait for its
/// answer until `cancel` or `budget` ends the wait. `None`: no answer in time; the thread is
/// left to finish on its own and its answer is dropped.
pub(crate) fn bounded<T: Send + 'static>(
    thread_name: &str,
    cancel: &Cancel,
    budget: Duration,
    call: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (send, answer) = std::sync::mpsc::channel();
    thread::Builder::new()
        .name(thread_name.to_owned())
        .spawn(move || {
            let _ = send.send(call());
        })
        .ok()?;
    let end = Instant::now() + budget;
    loop {
        match answer.recv_timeout(Duration::from_millis(20)) {
            Ok(value) => return Some(value),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if cancel.is_cancelled() || Instant::now() >= end {
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
        let quick = bounded("test-call", &never, Duration::from_secs(5), || 7);
        assert_eq!(quick, Some(7));
        let (release, gate) = mpsc::channel::<()>();
        let slow = bounded("test-call", &never, Duration::from_millis(30), move || {
            let _ = gate.recv();
            7
        });
        assert_eq!(slow, None);
        drop(release);
    }
}
