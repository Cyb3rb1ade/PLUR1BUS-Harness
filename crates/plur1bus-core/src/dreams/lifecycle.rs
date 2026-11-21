//! Host-driven dreaming lifecycle. The host owns dispatch, cancellation and timers.

use std::collections::HashSet;

use super::scheduler::{next_scheduled, phase_defaults, sync_agents, Settings};
use super::store::{DreamStore, ObservedCorpus};
use super::types::{DreamRun, FinishRun, Outcome, Phase, RunFailure, Trigger};
use crate::budget::Clock;
use crate::collab::{CollabError, CollabErrorCode as C};
use serde::Serialize;

type R<T> = Result<T, CollabError>;

/// A typed due hint. The runner still checks present authority.
#[derive(Debug, Serialize)]
pub struct Due {
    /// Registered agent for the phase.
    pub agent: String,
    /// Phase ready for the host to dispatch.
    pub phase: Phase,
    /// Reason the phase is due.
    pub trigger: Trigger,
    /// Scheduled occurrence, when there is one.
    pub at: Option<i64>,
}

/// Work and timing for the host to handle.
#[derive(Debug, Default)]
pub struct Tick {
    /// Phase dispatch hints.
    pub due: Vec<Due>,
    /// Next time to call the host tick.
    pub wake_at: Option<i64>,
    /// Whether to poll the separately authorized learning pass.
    pub poll_learning: bool,
    /// Log references detached by retention. The host must scope deletion to its own files.
    pub retired_logs: Vec<String>,
}

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

/// Per-owner lifecycle state, separate from the durable phase ledger.
#[derive(Default)]
pub struct Lifecycle {
    started: bool,
    stopped: bool,
    absent: HashSet<String>,
    last_prune: i64,
}

fn time(clock: &dyn Clock) -> R<i64> {
    let at = clock.now();
    if at < 0 {
        return Err(CollabError::new(
            C::Invalid,
            "invalid dreaming lifecycle time",
        ));
    }
    Ok(at)
}

fn registered(agents: &[&str], agent: &str) -> bool {
    agents.contains(&agent)
}

fn due(agent: &str, phase: Phase, trigger: Trigger, at: Option<i64>) -> Due {
    Due {
        agent: agent.into(),
        phase,
        trigger,
        at,
    }
}

fn catchup(store: &DreamStore, agents: &[&str], run: &DreamRun, now: i64) -> R<Option<Due>> {
    let r = &run.open;
    let Some(at) = r.scheduled_for else {
        return Ok(None);
    };
    if !matches!(r.trigger, Trigger::Cron | Trigger::Catchup)
        || at > now
        || at < now.saturating_sub(DAY)
        || !registered(agents, &r.agent_id)
        || !store
            .schedule(&r.agent_id, r.phase)?
            .is_some_and(|s| s.seed.enabled)
    {
        return Ok(None);
    }
    if store.window_runs(&r.agent_id, r.phase, at)?.len() != 1 {
        return Ok(None);
    }
    Ok(Some(due(&r.agent_id, r.phase, Trigger::Catchup, Some(at))))
}

impl Lifecycle {
    /// Reconcile old sessions and return due catch-up hints. Call only while the owner has no live runner.
    pub fn start(
        &mut self,
        store: &DreamStore,
        agents: &[&str],
        settings: &Settings,
        clock: &dyn Clock,
        learn_at: Option<i64>,
    ) -> R<Tick> {
        if self.started || self.stopped {
            return Ok(Tick::default());
        }
        let now = time(clock)?;
        let crashed = store.open_runs()?;
        for row in &crashed {
            store.finish_phase(
                &row.open.run_id,
                &FinishRun {
                    outcome: Some(Outcome::Aborted),
                    reason: Some("crashed".into()),
                    finished_at: Some(now.max(row.open.started_at)),
                    counts: row.result.counts.clone(),
                    tokens_in: row.result.tokens_in,
                    tokens_out: row.result.tokens_out,
                    error: Some(RunFailure {
                        message: "the process stopped before the run finished".into(),
                        name: None,
                    }),
                },
                ObservedCorpus {
                    captures: 0,
                    importance: 0.0,
                },
            )?;
        }
        let retired_logs = self.prune(store, now)?;
        for schedule in store.schedules(None)? {
            if !registered(agents, &schedule.seed.agent_id) {
                store.delete_schedules(&schedule.seed.agent_id)?;
            }
        }
        sync_agents(store, agents, settings, now)?;
        let mut result = self.collect(store, agents, now, learn_at, true)?;
        result.retired_logs = retired_logs;
        for run in &crashed {
            if result
                .due
                .iter()
                .any(|d| d.agent == run.open.agent_id && d.phase == run.open.phase)
            {
                continue;
            }
            if let Some(retry) = catchup(store, agents, run, now)? {
                result.due.push(retry);
            }
        }
        self.started = true;
        Ok(result)
    }

    /// Advance registered schedules and return newly due work.
    pub fn tick(
        &mut self,
        store: &DreamStore,
        agents: &[&str],
        settings: &Settings,
        clock: &dyn Clock,
        learn_at: Option<i64>,
    ) -> R<Tick> {
        if !self.started || self.stopped {
            return Ok(Tick::default());
        }
        let now = time(clock)?;
        sync_agents(store, agents, settings, now)?;
        let retired_logs = if now.saturating_sub(self.last_prune) >= DAY {
            self.prune(store, now)?
        } else {
            Vec::new()
        };
        for agent in agents {
            store.refresh_breakers(agent, now)?;
        }
        let mut result = self.collect(store, agents, now, learn_at, false)?;
        result.retired_logs = retired_logs;
        Ok(result)
    }

    fn collect(
        &mut self,
        store: &DreamStore,
        agents: &[&str],
        now: i64,
        learn_at: Option<i64>,
        startup: bool,
    ) -> R<Tick> {
        let mut result = Tick {
            wake_at: Some(
                learn_at
                    .map_or(now.saturating_add(HOUR), |t| {
                        t.min(now.saturating_add(HOUR))
                    })
                    .max(now),
            ),
            poll_learning: learn_at.is_some(),
            ..Tick::default()
        };
        let mut returning = HashSet::new();
        for row in store.schedules(None)? {
            let s = &row.seed;
            let agent = &s.agent_id;
            if !registered(agents, agent) {
                self.absent.insert(agent.clone());
                continue;
            }
            if self.absent.remove(agent) {
                returning.insert(agent.clone());
            }
            let Some(mut at) = s.next_run_at.filter(|_| s.enabled) else {
                continue;
            };
            if at <= now {
                let next = next_scheduled(s, now)?;
                if !store.advance_due(s, at, next)? {
                    continue;
                }
                let trigger = if startup || returning.contains(agent) {
                    Trigger::Catchup
                } else {
                    Trigger::Cron
                };
                result.due.push(due(agent, s.phase, trigger, Some(at)));
                let Some(next) = next else { continue };
                at = next;
            }
            result.wake_at = result.wake_at.map(|wake| wake.min(at));
        }
        Ok(result)
    }

    fn prune(&mut self, store: &DreamStore, now: i64) -> R<Vec<String>> {
        let result = store.prune(now.saturating_sub(365 * DAY), now.saturating_sub(30 * DAY))?;
        self.last_prune = now;
        Ok(result.logs)
    }

    /// Record a capture and return eligible importance triggers.
    pub fn record_capture(
        &self,
        store: &DreamStore,
        agents: &[&str],
        settings: &Settings,
        clock: &dyn Clock,
        agent: &str,
        importance: f64,
    ) -> R<Vec<Due>> {
        if self.stopped || !registered(agents, agent) {
            return Ok(Vec::new());
        }
        let now = time(clock)?;
        sync_agents(store, &[agent], settings, now)?;
        store.record_capture(agent, importance, now)?;
        if !self.started {
            return Ok(Vec::new());
        }
        let mut due_now = Vec::new();
        let active = store.open_runs()?;
        for row in store.schedules(Some(agent))? {
            let phase = row.seed.phase;
            let config = phase_defaults(phase);
            if !row.seed.enabled
                || row.importance_acc < config.importance_threshold
                || active
                    .iter()
                    .any(|r| r.open.agent_id == agent && r.open.phase == phase)
            {
                continue;
            }
            if store
                .last_run(agent, phase)?
                .is_some_and(|r| now.saturating_sub(r.open.started_at) < config.min_gap_ms)
            {
                continue;
            }
            due_now.push(due(agent, phase, Trigger::Importance, None));
        }
        Ok(due_now)
    }

    /// Stop emitting due work. The host must cancel its own active calls.
    pub fn stop(&mut self) {
        self.stopped = true;
    }
}

#[cfg(test)]
#[path = "lifecycle_vectors.rs"]
mod vectors;
