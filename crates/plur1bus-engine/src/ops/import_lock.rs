//! One cancellable FIFO deadline across in-process admission and the Node import lock.
use super::context::error;
use crate::{
    contract::{Cancel, EngineError, MemoryOpErrorCode},
    store::lock::{JobLock, LockBusy, LockGuard},
};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Default)]
struct Queue {
    waiters: Mutex<HashMap<PathBuf, VecDeque<uuid::Uuid>>>,
    changed: Condvar,
}
fn queue() -> &'static Queue {
    static QUEUE: OnceLock<Queue> = OnceLock::new();
    QUEUE.get_or_init(Queue::default)
}
struct Ticket {
    path: PathBuf,
    id: uuid::Uuid,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        let q = queue();
        let mut all = q
            .waiters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(waiters) = all.get_mut(&self.path) {
            waiters.retain(|id| *id != self.id);
            if waiters.is_empty() {
                all.remove(&self.path);
            }
        }
        q.changed.notify_all();
    }
}
/// Import/unimport/link all hold the same process-identity lock and fence every write.
pub struct ImportLease {
    guard: LockGuard,
    _ticket: Ticket,
    last_beat: Instant,
}
impl ImportLease {
    /// Require current nonce ownership. Missing, corrupt or replaced ownership is lock-lost.
    pub fn assert_held(&self) -> Result<(), EngineError> {
        if self.guard.is_owned() {
            Ok(())
        } else {
            Err(error(MemoryOpErrorCode::LockLost))
        }
    }
    /// Call-driven heartbeat, at most once per two seconds, as in Node.
    pub fn heartbeat(&mut self) -> Result<(), EngineError> {
        self.assert_held()?;
        if self.last_beat.elapsed() >= Duration::from_secs(2) {
            if !self
                .guard
                .heartbeat()
                .map_err(|_| error(MemoryOpErrorCode::LockLost))?
            {
                return Err(error(MemoryOpErrorCode::LockLost));
            }
            self.last_beat = Instant::now();
        }
        Ok(())
    }
}
/// Acquire only for apply, never dry-run. The default caller budget is 120 seconds.
pub fn acquire(
    base: &Path,
    agent: &str,
    cancel: &Cancel,
    timeout: Duration,
) -> Result<ImportLease, EngineError> {
    let agent =
        crate::context::safe_agent_id(agent).map_err(|_| error(MemoryOpErrorCode::InvalidInput))?;
    crate::store::paths::assert_trusted_path(base)
        .map_err(|_| error(MemoryOpErrorCode::Storage))?;
    // Existing canonical base binds the queue key; aliases cannot create two local queues.
    let directory = base
        .canonicalize()
        .map_err(|_| error(MemoryOpErrorCode::Storage))?
        .join("_imports/.locks");
    let path = directory.join(format!("{agent}.lock"));
    let id = uuid::Uuid::new_v4();
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| error(MemoryOpErrorCode::InvalidInput))?;
    let q = queue();
    let ticket = Ticket {
        path: path.clone(),
        id,
    };
    {
        let mut all = q
            .waiters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        all.entry(path.clone()).or_default().push_back(id);
        loop {
            if let Err(e) = cancel.check() {
                drop(all);
                return Err(e.into());
            }
            if all.get(&path).and_then(|q| q.front()) == Some(&id) {
                break;
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                drop(all);
                return Err(error(MemoryOpErrorCode::LockBusy));
            };
            all = q
                .changed
                .wait_timeout(all, left.min(Duration::from_millis(25)))
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }
    loop {
        cancel.check()?;
        match JobLock::acquire(&directory, &agent, Duration::from_secs(30)) {
            Ok(guard) => {
                return Ok(ImportLease {
                    guard,
                    _ticket: ticket,
                    last_beat: Instant::now(),
                })
            }
            Err(LockBusy::Store(_)) => return Err(error(MemoryOpErrorCode::Storage)),
            Err(LockBusy::Held) => {}
        }
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            return Err(error(MemoryOpErrorCode::LockBusy));
        };
        std::thread::sleep(left.min(Duration::from_millis(25)));
    }
}
