//! Coalesced provider probes whose caller waits have independent cancellation.

use super::{Cancel, Cancelled};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) struct Completion<T> {
    result: Mutex<Option<T>>,
    changed: Condvar,
}
impl<T> Completion<T> {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            changed: Condvar::new(),
        }
    }
}

struct State<T> {
    last: Option<T>,
    success: Option<T>,
    running: Option<Arc<Completion<T>>>,
    queued: Option<Arc<Completion<T>>>,
}

pub(crate) enum Ticket<T> {
    Cached(T),
    Pending(Arc<Completion<T>>),
}

/// One provider probe in flight, at most one refreshed call queued behind it.
pub(crate) struct Probe<T> {
    state: Mutex<State<T>>,
    run: Box<dyn Fn() -> T + Send + Sync>,
    successful: fn(&T) -> bool,
}

impl<T: Clone + Send + 'static> Probe<T> {
    pub(crate) fn new(
        run: impl Fn() -> T + Send + Sync + 'static,
        successful: fn(&T) -> bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                last: None,
                success: None,
                running: None,
                queued: None,
            }),
            run: Box::new(run),
            successful,
        })
    }

    pub(crate) fn start(self: &Arc<Self>, refresh: bool) -> Ticket<T> {
        let mut state = lock(&self.state);
        if !refresh {
            if let Some(result) = &state.success {
                return Ticket::Cached(result.clone());
            }
        }
        if let Some(running) = &state.running {
            if !refresh {
                return Ticket::Pending(running.clone());
            }
            let queued = state
                .queued
                .get_or_insert_with(|| Arc::new(Completion::new()));
            return Ticket::Pending(queued.clone());
        }
        let entry = Arc::new(Completion::new());
        state.running = Some(entry.clone());
        let probe = self.clone();
        let first = entry.clone();
        std::thread::spawn(move || probe.run_queue(first));
        Ticket::Pending(entry)
    }

    fn run_queue(&self, mut entry: Arc<Completion<T>>) {
        loop {
            let result = (self.run)();
            let next = {
                let mut state = lock(&self.state);
                state.last = Some(result.clone());
                if (self.successful)(&result) {
                    state.success = Some(result.clone());
                }
                let next = state.queued.take();
                state.running = next.clone();
                next
            };
            *lock(&entry.result) = Some(result);
            entry.changed.notify_all();
            if let Some(next) = next {
                entry = next;
            } else {
                break;
            }
        }
    }

    pub(crate) fn wait(ticket: Ticket<T>, cancel: &Cancel) -> Result<(T, bool), Cancelled> {
        match ticket {
            Ticket::Cached(result) => Ok((result, true)),
            Ticket::Pending(entry) => {
                let mut result = lock(&entry.result);
                loop {
                    cancel.check()?;
                    if let Some(result) = &*result {
                        return Ok((result.clone(), false));
                    }
                    let wait = cancel
                        .remaining()
                        .unwrap_or(Duration::from_millis(5))
                        .min(Duration::from_millis(5));
                    result = entry
                        .changed
                        .wait_timeout(result, wait)
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .0;
                }
            }
        }
    }

    pub(crate) fn snapshot(&self) -> (Option<T>, bool) {
        let state = lock(&self.state);
        (state.last.clone(), state.running.is_some())
    }
}
