use crate::runtime::RuntimeKind;
use std::collections::VecDeque;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    Healthy,
    Dead,
    RuntimeMissing,
    MetaUnavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Ready,
    Wait,
    Restart,
    Crashed,
    RuntimeDown,
    RecheckMeta,
    RestartRuntime,
}
pub struct Watch {
    kind: RuntimeKind,
    last: Option<u64>,
    dead: Option<u64>,
    missing: Option<u64>,
    wake: Option<u64>,
    next: Option<u64>,
    failures: VecDeque<u64>,
    latched: bool,
}
impl Watch {
    pub fn new(kind: RuntimeKind) -> Self {
        Self {
            kind,
            last: None,
            dead: None,
            missing: None,
            wake: None,
            next: None,
            failures: VecDeque::new(),
            latched: false,
        }
    }
    pub fn is_crashed(&self) -> bool {
        self.latched
    }
    pub fn manual_start(&mut self) {
        self.failures.clear();
        self.latched = false;
        self.dead = None;
        self.missing = None;
        self.wake = None;
        self.next = None;
        self.last = None;
    }
    pub fn failed(&mut self, now: u64) {
        self.failures.push_back(now);
        self.next = Some(now + (1u64 << self.failures.len().min(6)).min(60));
    }
    pub fn observe(&mut self, now: u64, observation: Observation) -> Action {
        while self
            .failures
            .front()
            .is_some_and(|f| now.saturating_sub(*f) > 600)
        {
            self.failures.pop_front();
        }
        let gap = self.last.is_some_and(|last| now.saturating_sub(last) > 30);
        self.last = Some(now);
        if self.latched {
            return Action::Crashed;
        }
        if gap {
            self.wake = Some(now);
        }
        if gap && observation == Observation::Healthy {
            return Action::RecheckMeta;
        }
        if observation == Observation::RuntimeMissing {
            let since = *self.missing.get_or_insert(now);
            return if now.saturating_sub(since) >= 60 {
                Action::RuntimeDown
            } else {
                Action::Wait
            };
        }
        self.missing = None;
        if observation == Observation::MetaUnavailable {
            if self.kind == RuntimeKind::Apple
                && self.wake.is_some_and(|s| now.saturating_sub(s) >= 30)
            {
                self.wake = None;
                return Action::RestartRuntime;
            }
            return Action::Wait;
        }
        if observation == Observation::Healthy {
            self.dead = None;
            self.wake = None;
            self.next = None;
            return Action::Ready;
        }
        if self.failures.len() >= 5 {
            self.latched = true;
            return Action::Crashed;
        }
        let since = *self.dead.get_or_insert(now);
        let default = since
            + if self.kind == RuntimeKind::Docker {
                20
            } else {
                1
            };
        let next = self.next.unwrap_or(default);
        if now >= next {
            Action::Restart
        } else {
            Action::Wait
        }
    }
}

impl super::Controller {
    /// One supervised task per native owner. AbortHandle is retained by that owner.
    pub fn spawn_watch(self: std::sync::Arc<Self>) -> tokio::task::JoinHandle<()> {
        self.spawn_watch_with(std::sync::Arc::new(|_| Box::pin(async {})))
    }
    pub fn spawn_watch_with(
        self: std::sync::Arc<Self>,
        publish: WatchCallback,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let origin = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                if self.mutation.try_lock().is_err()
                    || self.upgrade_journal().is_err()
                    || self.upgrade_journal().ok().flatten().is_some_and(|j| {
                        !j.step.terminal() || j.step == super::journal::Step::RecoveryFailed
                    })
                {
                    continue;
                }
                if !self.desired_running().unwrap_or(false) {
                    publish(self.status().await).await;
                    continue;
                }
                let now = origin.elapsed().as_secs();
                let Ok(Some(installed)) = self.installed() else {
                    continue;
                };
                let observation = if self.runtime.ping().await.is_err() {
                    Observation::RuntimeMissing
                } else {
                    match self.runtime.state(&installed.container).await {
                        Ok(s) if !s.running => Observation::Dead,
                        Ok(_) if self.health.ready(installed.port).await => Observation::Healthy,
                        Ok(_) => Observation::MetaUnavailable,
                        Err(_) => Observation::RuntimeMissing,
                    }
                };
                let action = match self.watcher.lock() {
                    Ok(mut w) => w.observe(now, observation),
                    Err(_) => return,
                };
                match action {
                    Action::Restart => {
                        if let Ok(mut w) = self.watcher.lock() {
                            w.failed(now);
                        }
                        let _ = self.start_internal(false).await;
                    }
                    Action::RestartRuntime => {
                        let _ = self.runtime.restart_system().await;
                        let _ = self.start_internal(false).await;
                    }
                    Action::RecheckMeta => {
                        let _ = self.health.ready(installed.port).await;
                    }
                    _ => {}
                }
                publish(self.status().await).await;
            }
        })
    }
}

pub type WatchCallback = std::sync::Arc<
    dyn Fn(super::HarnessStatus) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;
