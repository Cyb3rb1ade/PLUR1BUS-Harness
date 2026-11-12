//! One engine-local observer links caller cancellation without mutating the caller's token.
//!
//! A receipt abort cancels only its local token, matching AbortSignal.any at the Node pin.
//! Weak leases keep links alive through a timed-out worker's actual settlement.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::contract::{Cancel, EngineError, HostError};

struct Link {
    caller: Cancel,
    effective: Cancel,
    lease: Weak<()>,
}
struct State {
    links: Mutex<HashMap<String, Link>>,
    stopped: AtomicBool,
}

pub(super) struct CancellationLinks {
    state: Arc<State>,
    worker: Option<JoinHandle<()>>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

impl CancellationLinks {
    pub(super) fn new() -> Result<Self, EngineError> {
        let state = Arc::new(State {
            links: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
        });
        let observer = state.clone();
        let worker = thread::Builder::new()
            .name("capture-cancellation".into())
            .spawn(move || {
                while !observer.stopped.load(Ordering::Acquire) {
                    lock(&observer.links).retain(|_, link| {
                        if link.lease.upgrade().is_none() {
                            return false;
                        }
                        if link.caller.is_cancelled() {
                            link.effective.cancel();
                        }
                        true
                    });
                    thread::sleep(Duration::from_millis(1));
                }
            })
            .map_err(|_| EngineError::Host(HostError::Failed))?;
        Ok(Self {
            state,
            worker: Some(worker),
        })
    }

    pub(super) fn register(&self, id: &str, caller: &Cancel) -> (Cancel, Arc<()>) {
        let effective = caller.remaining().map_or_else(Cancel::never, |remaining| {
            Cancel::with_deadline(Instant::now() + remaining)
        });
        if caller.is_cancelled() {
            effective.cancel();
        }
        let lease = Arc::new(());
        lock(&self.state.links).insert(
            id.to_owned(),
            Link {
                caller: caller.clone(),
                effective: effective.clone(),
                lease: Arc::downgrade(&lease),
            },
        );
        (effective, lease)
    }
}

impl Drop for CancellationLinks {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::Release);
        for link in lock(&self.state.links).values() {
            link.effective.cancel();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
