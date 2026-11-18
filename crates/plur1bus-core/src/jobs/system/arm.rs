//! `armApprovalsIntegrity(jobs, timers)` (`approvals/integrity-job.ts`, composed in `core.ts`): the host arms one timer for the
//! `approvals.integrity` job's `nextRunAt`; when it fires the job runs as `cron` and the timer is armed again. There is no
//! timer here (R-K-2): [`IntegrityTimers::set_timer`] records the delay the host must wait, and the host calls
//! [`IntegrityArm::fire`] when it has waited. The handler of the job itself (`createApprovalsIntegrityJob`) belongs to the
//! approvals package and is not part of K7a.
use super::registry::{RunOptions, SystemJobs};
use std::cell::Cell;

/// `IntegrityArmTimers`.
pub trait IntegrityTimers {
    /// The current instant (epoch ms).
    fn now(&self) -> f64;
    /// Asks the host to call [`IntegrityArm::fire`] after `ms` milliseconds.
    fn set_timer(&self, ms: f64);
}

/// The name of the job the arm keeps running.
pub const APPROVALS_INTEGRITY_JOB: &str = "approvals.integrity";

/// The handle `armApprovalsIntegrity` returns, with the timer callback as a method.
#[derive(Default)]
pub struct IntegrityArm {
    cancelled: Cell<bool>,
}

impl IntegrityArm {
    /// `armApprovalsIntegrity(jobs, timers)`: arms the first timer.
    pub fn start(jobs: &SystemJobs, timers: &dyn IntegrityTimers) -> Self {
        let arm = Self::default();
        arm.schedule(jobs, timers);
        arm
    }

    /// `cancel()`: a timer that fires afterwards does nothing and arms nothing.
    pub fn cancel(&self) {
        self.cancelled.set(true);
    }

    /// The delay is `max(0, (nextRunAt ?? now) - now)`.
    fn schedule(&self, jobs: &SystemJobs, timers: &dyn IntegrityTimers) {
        if self.cancelled.get() {
            return;
        }
        let next = jobs
            .list()
            .into_iter()
            .find(|j| j.name == APPROVALS_INTEGRITY_JOB)
            .and_then(|j| j.next_run_at);
        let now = timers.now();
        let delay = (next.unwrap_or(now) - now).max(0.0);
        timers.set_timer(delay);
    }

    /// The timer's callback: runs the job as `cron` (a failure is ignored) and arms the next timer.
    pub fn fire(&self, jobs: &SystemJobs, timers: &dyn IntegrityTimers) {
        if self.cancelled.get() {
            return;
        }
        let _ = jobs.run(
            APPROVALS_INTEGRITY_JOB,
            None,
            &RunOptions {
                trigger: "cron".into(),
                signal: None,
            },
        );
        self.schedule(jobs, timers);
    }
}
