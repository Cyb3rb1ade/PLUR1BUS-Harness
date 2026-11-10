//! Bounded fragment statistics and compaction of one table (RE-D161), the native
//! counterpart of the pin's `lib/db-adapter.js` `fragmentCount` and `optimizeTable`.
//!
//! Every step runs under the caller's cancellation and its own deadline: a cancelled or
//! overdue step is dropped at its next await point instead of being left running, so no
//! caller waits past its budget for LanceDB.
use super::Store;
use crate::contract::Cancel;
use crate::store::fragment_compactor::OptimizePlan;
use std::future::Future;
use std::time::{Duration, Instant};

/// `lib/db-adapter.js:1020-1039` at the pin: opening the table and reading its stats are
/// bounded together by five seconds.
pub(crate) const FRAGMENT_COUNT_BUDGET: Duration = Duration::from_secs(5);
/// Count threads that may still be stuck in a hung open at once; further counts answer
/// "unknown" at once instead of piling up threads (RE-D161).
const MAX_STUCK_COUNTS: usize = 4;
static COUNTS_RUNNING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Run `count` (open the table, read its stats) on its own short-lived thread and wait at
/// most `budget` or until `cancel` fires; otherwise the count is unknown (`None`). A hung
/// open (a blocked filesystem) therefore holds the caller at most `budget`; the thread ends
/// with the system call and is not waited for. `count` gets a token that ends with the wait.
pub(crate) fn count_within(
    budget: Duration,
    cancel: &Cancel,
    count: impl FnOnce(&Cancel) -> Option<u64> + Send + 'static,
) -> Option<u64> {
    use std::sync::atomic::Ordering;
    struct Running;
    impl Drop for Running {
        fn drop(&mut self) {
            COUNTS_RUNNING.fetch_sub(1, Ordering::AcqRel);
        }
    }
    if cancel.is_cancelled() {
        return None;
    }
    if COUNTS_RUNNING.fetch_add(1, Ordering::AcqRel) >= MAX_STUCK_COUNTS {
        COUNTS_RUNNING.fetch_sub(1, Ordering::AcqRel);
        return None;
    }
    let token = cancel.limited_to(Instant::now() + budget);
    let inner = token.clone();
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("fragment-count".into())
        .spawn(move || {
            let _running = Running;
            let _ = sent.send(count(&inner));
        });
    if spawned.is_err() {
        COUNTS_RUNNING.fetch_sub(1, Ordering::AcqRel);
        return None;
    }
    loop {
        if token.is_cancelled() {
            return None;
        }
        match received.recv_timeout(POLL) {
            Ok(count) => return count,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}
/// `lib/db-adapter.js:995` at the pin: one optimize attempt gets at least ten seconds.
const ATTEMPT_FLOOR: Duration = Duration::from_secs(10);
/// `lib/db-adapter.js:983` at the pin: retry delays grow up to one minute.
const RETRY_DELAY_CAP_MS: u64 = 60_000;
/// How often a waiting step looks at its cancellation (as `migration_table.rs` does).
const POLL: Duration = Duration::from_millis(25);

/// How one bounded table compaction ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptimizeRun {
    /// Compact, prune and index optimization all committed.
    Compacted,
    /// Every attempt lost to concurrent writes (`conflict: true` at the pin).
    Conflict,
    /// The caller cancelled (engine shutdown); the step was dropped.
    Cancelled,
    /// The attempt outlived its budget and was dropped.
    TimedOut,
    /// Any other backend failure; the cause is not reported (it may name paths).
    Failed,
}

enum Bounded<T> {
    Done(T),
    Cancelled,
    TimedOut,
}

/// Poll `future` until it finishes, `cancel` fires or `deadline` passes.
async fn bounded<T>(
    future: impl Future<Output = T>,
    cancel: &Cancel,
    deadline: Instant,
) -> Bounded<T> {
    let mut future = std::pin::pin!(future);
    loop {
        if cancel.is_cancelled() {
            return Bounded::Cancelled;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Bounded::TimedOut;
        }
        if let Ok(value) = tokio::time::timeout(left.min(POLL), &mut future).await {
            return Bounded::Done(value);
        }
    }
}

/// `lib/db-adapter.js:974` at the pin: LanceDB's own wording for a retryable conflict.
fn is_retryable_conflict(error: &lancedb::Error) -> bool {
    let text = error.to_string().to_lowercase();
    [
        "retryable commit conflict",
        "preempted by concurrent",
        "please retry",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

impl Store {
    /// The table's fragment count, or `None` when it is unknown (no stats, an error,
    /// cancellation or five seconds spent), so the caller can tell "unknown" from "0".
    pub fn fragment_count(&self, cancel: &Cancel) -> Option<u64> {
        let table = self.table.clone();
        let cancel = cancel.clone();
        let deadline = Instant::now() + FRAGMENT_COUNT_BUDGET;
        self.executor
            .run(async move {
                match bounded(table.stats(), &cancel, deadline).await {
                    Bounded::Done(Ok(stats)) => {
                        Ok(u64::try_from(stats.fragment_stats.num_fragments).ok())
                    }
                    _ => Ok(None),
                }
            })
            .ok()
            .flatten()
    }

    /// Compact the table's fragments, prune versions older than the plan keeps and optimize
    /// its indices, as the pin's `table.optimize({ cleanupOlderThan })` does
    /// (`@lancedb/lancedb` 0.26.2: compact, prune, index). A retryable commit conflict is
    /// retried with a doubling delay while attempts and the plan's budget allow
    /// (`lib/db-adapter.js:914-1016`).
    pub fn optimize_fragments(&self, plan: &OptimizePlan, cancel: &Cancel) -> OptimizeRun {
        if self.writable().is_err() {
            return OptimizeRun::Failed;
        }
        let table = self.table.clone();
        let cancel = cancel.clone();
        let plan = plan.clone();
        let outcome = self.executor.run(async move {
            let deadline = Instant::now() + Duration::from_millis(plan.timeout_ms);
            let older_than = chrono::Duration::milliseconds(plan.cleanup_ago_ms);
            let mut attempts = 0_u32;
            loop {
                attempts += 1;
                let attempt_deadline = Instant::now()
                    + deadline
                        .saturating_duration_since(Instant::now())
                        .max(ATTEMPT_FLOOR);
                let work = async {
                    table
                        .optimize(lancedb::table::OptimizeAction::Compact {
                            options: Default::default(),
                            remap_options: None,
                        })
                        .await?;
                    table
                        .optimize(lancedb::table::OptimizeAction::Prune {
                            older_than: Some(older_than),
                            delete_unverified: None,
                            error_if_tagged_old_versions: None,
                        })
                        .await?;
                    table
                        .optimize(lancedb::table::OptimizeAction::Index(
                            lancedb::table::OptimizeOptions::default(),
                        ))
                        .await?;
                    Ok::<(), lancedb::Error>(())
                };
                let error = match bounded(work, &cancel, attempt_deadline).await {
                    Bounded::Done(Ok(())) => return Ok(OptimizeRun::Compacted),
                    Bounded::Cancelled => return Ok(OptimizeRun::Cancelled),
                    Bounded::TimedOut => return Ok(OptimizeRun::TimedOut),
                    Bounded::Done(Err(error)) => error,
                };
                let conflict = is_retryable_conflict(&error);
                let delay = Duration::from_millis(
                    plan.retry_delay_ms
                        .saturating_mul(1_u64 << (attempts - 1).min(32))
                        .min(RETRY_DELAY_CAP_MS),
                );
                if !conflict || attempts >= plan.max_attempts || Instant::now() + delay >= deadline
                {
                    return Ok(if conflict {
                        OptimizeRun::Conflict
                    } else {
                        OptimizeRun::Failed
                    });
                }
                if let Bounded::Cancelled = bounded(
                    tokio::time::sleep(delay),
                    &cancel,
                    Instant::now() + delay + POLL,
                )
                .await
                {
                    return Ok(OptimizeRun::Cancelled);
                }
            }
        });
        outcome.unwrap_or(OptimizeRun::Failed)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "test assertions")]
    use super::*;

    /// An open that blocks until released, as a hung filesystem would.
    fn hanging() -> (
        std::sync::mpsc::Sender<()>,
        impl FnOnce(&Cancel) -> Option<u64> + Send + 'static,
    ) {
        let (release, released) = std::sync::mpsc::channel::<()>();
        (release, move |_: &Cancel| {
            let _ = released.recv();
            Some(7)
        })
    }

    #[test]
    fn a_hanging_open_counts_as_unknown_within_the_budget() {
        let (release, open) = hanging();
        let started = Instant::now();
        let count = count_within(Duration::from_millis(100), &Cancel::never(), open);
        assert_eq!(count, None);
        // Bounded by the budget plus one poll, far below the pin's five seconds.
        assert!(started.elapsed() < Duration::from_secs(2));
        release.send(()).unwrap();
    }

    #[test]
    fn shutdown_ends_the_wait_for_a_hanging_open() {
        let (release, open) = hanging();
        let cancel = Cancel::never();
        let stopper = cancel.clone();
        let started = Instant::now();
        let waiter =
            std::thread::spawn(move || count_within(Duration::from_secs(60), &cancel, open));
        std::thread::sleep(Duration::from_millis(50));
        stopper.cancel();
        assert_eq!(waiter.join().unwrap(), None);
        assert!(started.elapsed() < Duration::from_secs(10));
        release.send(()).unwrap();
    }

    #[test]
    fn a_finished_count_is_returned() {
        assert_eq!(
            count_within(Duration::from_secs(5), &Cancel::never(), |_| Some(3)),
            Some(3)
        );
    }
}
