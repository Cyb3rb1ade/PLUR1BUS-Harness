//! Owned worker/timer startup, serialized with queue close.

use super::*;

impl DeferredDynamicsQueue {
    pub(super) fn arm(&self, state: &mut State, key: &str, timer: Arc<Timer>) {
        if self.0.controlled {
            return;
        }
        let queue = self.clone();
        let timer_key = key.to_owned();
        let duration = self.0.options.fallback_delay;
        let handle = std::thread::Builder::new()
            .name("dynamics-fallback".to_owned())
            .spawn(move || {
                let flag = lock(&timer.cancelled);
                let (flag, _) = timer
                    .changed
                    .wait_timeout_while(flag, duration, |cancelled| !*cancelled)
                    .unwrap_or_else(PoisonError::into_inner);
                let cancelled = *flag;
                drop(flag);
                if !cancelled {
                    let _ = queue.start(&timer_key, Some(&timer));
                }
            });
        match handle {
            Ok(handle) => {
                lock(&self.0.timers).push(handle);
                self.reap_finished();
            }
            Err(_) => {
                state.failures = state.failures.saturating_add(1);
                if let Some(lane) = state.lanes.iter_mut().find(|lane| lane.key == key) {
                    lane.timer = None;
                }
                log::warn!("deferred-dynamics: timer-unavailable count=1");
            }
        }
    }

    pub(super) fn launch(&self, state: &mut State, key: String, first: Job) -> bool {
        self.reap_finished();
        if lock(&self.0.workers).len() >= 2 * self.0.lane_limit {
            Self::restore_job(state, &key, first);
            self.0.changed.notify_all();
            return false;
        }
        let queue = self.clone();
        let worker_key = key.clone();
        let job = Arc::new(Mutex::new(Some(first)));
        let worker_job = job.clone();
        let worker = std::thread::Builder::new()
            .name("deferred-dynamics".to_owned())
            .spawn(move || {
                if let Some(job) = lock(&worker_job).take() {
                    queue.run_lane(&worker_key, job);
                }
            });
        match worker {
            Ok(worker) => {
                lock(&self.0.workers).push((key, worker));
                self.reap_finished();
                true
            }
            Err(_) => {
                if let Some(job) = lock(&job).take() {
                    Self::restore_job(state, &key, job);
                }
                self.0.changed.notify_all();
                log::warn!("deferred-dynamics: worker-unavailable count=1");
                false
            }
        }
    }

    fn restore_job(state: &mut State, key: &str, job: Job) {
        state.failures = state.failures.saturating_add(1);
        if let Some(lane) = state.lanes.iter_mut().find(|lane| lane.key == key) {
            lane.jobs.push_front(job);
            lane.running = false;
        }
    }

    pub(super) fn run_lane(&self, key: &str, first: Job) {
        let mut current = Some(first);
        while let Some(job) = current {
            let failed = !matches!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)),
                Ok(Ok(()))
            );
            let mut state = lock(&self.0.state);
            if failed {
                state.failures = state.failures.saturating_add(1);
                log::warn!("deferred-dynamics: job-failed count=1");
            }
            let Some(lane) = state.lanes.iter_mut().find(|lane| lane.key == key) else {
                return;
            };
            current = lane.jobs.pop_front();
            if current.is_none() {
                lane.running = false;
                self.0.changed.notify_all();
            }
        }
    }

    pub(super) fn reap_finished(&self) {
        let mut workers = lock(&self.0.workers);
        let mut index = 0;
        while index < workers.len() {
            if workers[index].1.is_finished() {
                let (_, worker) = workers.swap_remove(index);
                let _ = worker.join();
            } else {
                index += 1;
            }
        }
        drop(workers);
        let mut timers = lock(&self.0.timers);
        let mut index = 0;
        while index < timers.len() {
            if timers[index].is_finished() {
                let timer = timers.swap_remove(index);
                let _ = timer.join();
            } else {
                index += 1;
            }
        }
    }
}
