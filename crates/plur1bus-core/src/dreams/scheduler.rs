//! Deterministic policies for dreaming schedules and run admission.

use super::store::DreamStore;
use super::types::{Breaker, Phase, RunCounts, ScheduleSeed};
use crate::budget::zones::TzdbZones;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::jobs::cron::{is_valid_timezone, next_after, parse_cron};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type R<T> = Result<T, CollabError>;

/// Host scheduling settings. The timezone is supplied by composition.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Default timezone for new rows.
    pub timezone: String,
    /// Upper bound of the deterministic start offset in seconds.
    pub stagger_window_s: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            timezone: "UTC".to_owned(),
            stagger_window_s: 1800,
        }
    }
}

/// A registered job's scheduling features.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// Registered job name.
    pub name: String,
    /// Whether it consumes a model session.
    pub needs_llm: bool,
}

/// The current plan shown before opening a run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Whether admission would proceed with the supplied facts.
    pub would_run: bool,
    /// First admission rule that failed.
    pub reason: Option<&'static str>,
    /// Jobs in plan order.
    pub jobs: Vec<String>,
    /// Stable key for this agent, phase and content window.
    pub idempotency_key: String,
    /// Explanatory quota or corpus counts.
    pub counts: RunCounts,
}

/// The ADR-009 defaults for a phase.
#[derive(Clone, Copy)]
pub struct PhaseDefaults {
    /// Cron floor.
    pub cron: &'static str,
    /// Minimum captures before jobs may begin.
    pub min_corpus: i64,
    /// Accumulated importance required for an early run.
    pub importance_threshold: f64,
    /// Minimum spacing of importance-triggered runs.
    pub min_gap_ms: i64,
    /// Configured job order.
    pub jobs: &'static [&'static str],
    /// Job that determines whether the phase skipped.
    pub primary: &'static str,
}

/// The default phase table shared by planning and execution.
pub fn phase_defaults(phase: Phase) -> PhaseDefaults {
    const HOUR: i64 = 3_600_000;
    match phase {
        Phase::Light => PhaseDefaults {
            cron: "0 */4 * * *",
            min_corpus: 1,
            importance_threshold: 150.0,
            min_gap_ms: HOUR,
            jobs: &["light-dream", "embedding-drain"],
            primary: "light-dream",
        },
        Phase::Rem => PhaseDefaults {
            cron: "15 1 * * *",
            min_corpus: 3,
            importance_threshold: 300.0,
            min_gap_ms: 6 * HOUR,
            jobs: &["rem-dream", "discover-semantic-links"],
            primary: "rem-dream",
        },
        Phase::Deep => PhaseDefaults {
            cron: "0 4 * * *",
            min_corpus: 3,
            importance_threshold: 450.0,
            min_gap_ms: 12 * HOUR,
            jobs: &["consolidate-daily", "auto-accept-stale", "gc-run"],
            primary: "consolidate-daily",
        },
    }
}

fn invalid(reason: impl Into<String>) -> CollabError {
    CollabError::new(C::Invalid, reason)
}

/// Stable per-agent and phase offset in seconds.
pub fn stagger_offset(agent: &str, phase: Phase, window: i64) -> i64 {
    if window <= 0 {
        return 0;
    }
    let hash = Sha256::digest(format!("{agent}\0{}", phase.as_str()));
    let prefix = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]);
    i64::from(prefix) % window
}

/// Calculate the next enabled window from its stored offset and timezone.
pub fn next_scheduled(seed: &ScheduleSeed, now: i64) -> R<Option<i64>> {
    let offset = seed
        .stagger_offset_s
        .checked_mul(1000)
        .ok_or_else(|| invalid("invalid schedule offset"))?;
    let base = now
        .checked_sub(offset)
        .ok_or_else(|| invalid("invalid schedule instant"))?;
    let cron = parse_cron(&seed.cron).map_err(|error| invalid(error.0))?;
    next_after(&cron, &seed.timezone, base)
        .map_err(|error| invalid(error.0))?
        .map(|when| {
            when.checked_add(offset)
                .ok_or_else(|| invalid("invalid schedule instant"))
        })
        .transpose()
}

/// Validate and hash the capture cursor and the agent-private local calendar window.
pub fn idempotency_key(seed: &ScheduleSeed, capture_seq: i64, now: i64) -> R<String> {
    let wall = TzdbZones
        .local_minute(now, &seed.timezone)
        .filter(|wall| wall.y >= 100)
        .ok_or_else(|| invalid("invalid dreaming calendar window"))?;
    let mut window = format!("{:04}-{:02}-{:02}", wall.y, wall.mo, wall.d);
    if seed.phase == Phase::Light {
        use std::fmt::Write as _;
        let _ = write!(window, "T{}", wall.h / 4);
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{capture_seq}", seed.agent_id))
    );
    let bytes = format!(
        "{}\0{}\0agent-private\0{window}\0{digest}",
        seed.phase.as_str(),
        seed.agent_id
    );
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// Creates rows for newly registered agents without replacing stored settings.
pub fn sync_agents(store: &DreamStore, agents: &[&str], settings: &Settings, now: i64) -> R<()> {
    let timezone = if is_valid_timezone(&settings.timezone) {
        settings.timezone.as_str()
    } else {
        "UTC"
    };
    for &agent in agents {
        for phase in Phase::ALL {
            if store.schedule(agent, phase)?.is_some() {
                continue;
            }
            let mut seed = ScheduleSeed {
                agent_id: agent.to_owned(),
                phase,
                cron: phase_defaults(phase).cron.to_owned(),
                timezone: timezone.to_owned(),
                enabled: true,
                stagger_offset_s: stagger_offset(agent, phase, settings.stagger_window_s),
                next_run_at: None,
            };
            seed.next_run_at = next_scheduled(&seed, now)?;
            store.insert_schedule(&seed)?;
        }
    }
    Ok(())
}

pub(super) fn planned_jobs(phase: Phase, available: &[Job]) -> Vec<Job> {
    phase_defaults(phase)
        .jobs
        .iter()
        .filter_map(|name| {
            available
                .iter()
                .rev()
                .find(|job| job.name == *name)
                .cloned()
        })
        .collect()
}

fn breaker_open(store: &DreamStore, agent: &str, now: i64) -> R<bool> {
    for phase in [Phase::Rem, Phase::Deep] {
        if store.schedule(agent, phase)?.is_some_and(|row| {
            row.breaker_state == Breaker::Open && row.breaker_until.is_none_or(|until| until > now)
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Computes a plan for an existing schedule without consuming corpus or changing persisted state.
pub fn plan(store: &DreamStore, agent: &str, phase: Phase, now: i64, available: &[Job]) -> R<Plan> {
    let schedule = store
        .schedule(agent, phase)?
        .ok_or_else(|| CollabError::new(C::NotFound, "dreaming schedule is missing"))?;
    let idempotency_key = idempotency_key(&schedule.seed, schedule.capture_seq, now)?;
    let jobs: Vec<_> = planned_jobs(phase, available)
        .into_iter()
        .map(|job| job.name)
        .collect();
    let mut counts = RunCounts::new();
    let minimum = phase_defaults(phase).min_corpus;
    let reason = if store.key_holder(&idempotency_key)?.is_some() {
        Some("idempotent")
    } else if phase != Phase::Light && breaker_open(store, agent, now)? {
        Some("breaker_open")
    } else if jobs.is_empty() {
        Some("no_jobs")
    } else if schedule.captures_acc < minimum {
        counts.insert("corpus".to_owned(), schedule.captures_acc as f64);
        counts.insert("minCorpus".to_owned(), minimum as f64);
        Some("min_corpus")
    } else {
        None
    };
    Ok(Plan {
        would_run: reason.is_none(),
        reason,
        jobs,
        idempotency_key,
        counts,
    })
}

#[cfg(test)]
#[path = "scheduler_vectors.rs"]
mod vectors;
