//! Content-free monotonic phase timing, independent for each namespace worker.

use serde_json::{json, Value};
use std::time::Instant;

const MAX_COMPLETED_PHASES: usize = 32;

/// One completed bounded phase, without request text or collaborator errors.
#[derive(Clone, Debug)]
pub struct Phase {
    /// Engine-owned phase name.
    pub name: &'static str,
    /// Non-negative monotonic duration.
    pub milliseconds: f64,
}

/// A request or child-table clock. Namespace workers never mutate a shared active phase.
pub struct PhaseTimer {
    started: Instant,
    active: Option<(&'static str, Instant)>,
    completed: Vec<Phase>,
    errors: Vec<(&'static str, String)>,
    soft_ms: f64,
    hard_ms: f64,
}

impl PhaseTimer {
    /// Anchor at request entry, including earlier admission/queue time.
    #[must_use]
    pub fn new(started: Instant, soft_ms: f64, hard_ms: f64) -> Self {
        Self {
            started,
            active: None,
            completed: Vec::new(),
            errors: Vec::new(),
            soft_ms,
            hard_ms,
        }
    }

    /// Begin an engine-owned phase, closing a different outstanding phase first.
    pub fn start(&mut self, name: &'static str) {
        if let Some((previous, at)) = self.active {
            if previous != name {
                self.record(previous, at.elapsed().as_secs_f64() * 1000.0);
            }
        }
        self.active = Some((name, Instant::now()));
    }

    /// Close only the matching phase; unmatched ends cannot corrupt another phase.
    pub fn end(&mut self, name: &'static str) {
        if let Some((active, at)) = self.active {
            if active == name {
                self.record(name, at.elapsed().as_secs_f64() * 1000.0);
                self.active = None;
            }
        }
    }

    /// Record a classified failure, never retaining a collaborator error payload.
    pub fn fail(&mut self, name: &'static str) {
        self.errors.push((
            name,
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ));
        cap(&mut self.errors);
        if self.active.is_some_and(|(active, _)| active == name) {
            self.active = None;
        }
    }

    /// Add an independently measured phase without touching the current phase.
    pub fn record(&mut self, name: &'static str, milliseconds: f64) {
        self.completed.push(Phase {
            name,
            milliseconds: if milliseconds.is_finite() {
                milliseconds.max(0.0)
            } else {
                0.0
            },
        });
        cap(&mut self.completed);
    }

    /// Elapsed monotonic request time in milliseconds.
    #[must_use]
    pub fn elapsed_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    /// Node uses a strict comparison against the soft budget.
    #[must_use]
    pub fn soft_exceeded(&self) -> bool {
        self.elapsed_ms() > self.soft_ms
    }

    /// Completed phases for bounded namespace timing delivery.
    #[must_use]
    pub fn completed(&self) -> &[Phase] {
        &self.completed
    }

    /// Node-shaped summary; failure strings and phase names are engine-owned.
    #[must_use]
    pub fn summary(&self) -> Value {
        json!({"elapsedMs":self.elapsed_ms(), "softBudgetMs":self.soft_ms, "hardTimeoutMs":self.hard_ms,
            "activePhase":self.active.map(|(name,_)|name),
            "completed":self.completed.iter().map(|phase|json!({"phase":phase.name,"ms":phase.milliseconds})).collect::<Vec<_>>(),
            "errors":self.errors.iter().map(|(name, at)|json!({"phase":name,"error":"phase failed","at":at})).collect::<Vec<_>>(),
            "exceededBudget":self.soft_exceeded()})
    }
}

fn cap<T>(values: &mut Vec<T>) {
    let excess = values.len().saturating_sub(MAX_COMPLETED_PHASES);
    values.drain(..excess);
}
