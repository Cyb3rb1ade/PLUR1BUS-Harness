//! `session/turn-telemetry.ts`: the per-turn observations (a fresh empty one) and the process-local, bounded, identifier-free
//! aggregate with nearest-rank quantiles over the most recent [`TRIAGE_SAMPLE_LIMIT`] triage samples.
//!
//! Counts are `f64` as in JavaScript: a fraction adds as a fraction, and a negative or non-finite count is taken as zero.
use std::collections::BTreeMap;

/// Tool-choice outcomes observed across the turn.
pub const TOOL_CHOICE_STATUSES: [&str; 4] = ["auto", "required", "named", "unsupported"];
/// Stable reasons why the harness considers tool use necessary.
pub const TOOL_NEED_REASONS: [&str; 7] = [
    "triage",
    "url",
    "path",
    "time",
    "attachment",
    "skill",
    "mode",
];
/// Bounded turn termination reasons.
pub const TURN_END_REASONS: [&str; 12] = [
    "completed",
    "tool-error",
    "provider-error",
    "approval-required",
    "local-only",
    "budget",
    "aborted",
    "cancelled",
    "error-limit",
    "round-limit",
    "command",
    "failed",
];
/// The aggregate keeps at most this many recent triage durations.
pub const TRIAGE_SAMPLE_LIMIT: usize = 1024;

/// The three explicitly counted meta-tools.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MetaCalls {
    /// `search`.
    pub search: f64,
    /// `skillLoad`.
    pub skill_load: f64,
    /// `skillRead`.
    pub skill_read: f64,
}

/// Skills injected and loaded.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SkillCounts {
    /// `injected`.
    pub injected: f64,
    /// `loaded`.
    pub loaded: f64,
}

/// One final snapshot per turn. `tool_calls` excludes the three explicitly counted meta-tools.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnTelemetry {
    /// Rounds.
    pub rounds: f64,
    /// Tool calls.
    pub tool_calls: f64,
    /// Meta-tool calls.
    pub meta_calls: MetaCalls,
    /// Skills.
    pub skills: SkillCounts,
    /// `toolChoice.status`.
    pub tool_choice_status: String,
    /// `toolChoice.forced`.
    pub tool_choice_forced: bool,
    /// `toolNeed.detected`.
    pub tool_need_detected: bool,
    /// `toolNeed.reasons`.
    pub tool_need_reasons: Vec<String>,
    /// Errors returned to the model.
    pub errors_returned: f64,
    /// Why the turn ended.
    pub end_reason: String,
    /// `None` means no triage measurement exists, rather than a measured zero.
    pub triage_duration_ms: Option<f64>,
}

/// `createTurnTelemetry()`: a fresh empty observation.
pub fn create_turn_telemetry() -> TurnTelemetry {
    TurnTelemetry {
        rounds: 0.0,
        tool_calls: 0.0,
        meta_calls: MetaCalls::default(),
        skills: SkillCounts::default(),
        tool_choice_status: "auto".to_owned(),
        tool_choice_forced: false,
        tool_need_detected: false,
        tool_need_reasons: vec![],
        errors_returned: 0.0,
        end_reason: "completed".to_owned(),
        triage_duration_ms: None,
    }
}

/// Lifetime counters plus the triage quantiles.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnTelemetrySummary {
    /// Turns observed.
    pub turns: f64,
    /// Rounds.
    pub rounds: f64,
    /// Tool calls.
    pub tool_calls: f64,
    /// Meta-tool calls.
    pub meta_calls: MetaCalls,
    /// Skills.
    pub skills: SkillCounts,
    /// Errors returned.
    pub errors_returned: f64,
    /// Turns in which a tool was needed.
    pub tool_need_turns: f64,
    /// Turns with a forced tool choice.
    pub forced_turns: f64,
    /// Turns that needed a tool and made no call.
    pub without_needed_tool: f64,
    /// Turns whose tool choice was unsupported.
    pub tool_choice_unsupported: f64,
    /// Turns per end reason.
    pub end_reasons: BTreeMap<String, f64>,
    /// Number of triage samples kept.
    pub triage_count: usize,
    /// Median of the samples.
    pub triage_p50_ms: Option<f64>,
    /// 95th percentile of the samples.
    pub triage_p95_ms: Option<f64>,
}

/// `createTurnTelemetryAggregate()`.
#[derive(Clone, Debug)]
pub struct TurnTelemetryAggregate {
    total: TurnTelemetrySummary,
    samples: Vec<f64>,
    next_sample: usize,
}

impl Default for TurnTelemetryAggregate {
    fn default() -> Self {
        Self::new()
    }
}

/// `Number.isFinite(value) && value >= 0 ? value : 0`.
fn count(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

impl TurnTelemetryAggregate {
    /// An empty aggregate.
    pub fn new() -> Self {
        Self {
            total: TurnTelemetrySummary {
                turns: 0.0,
                rounds: 0.0,
                tool_calls: 0.0,
                meta_calls: MetaCalls::default(),
                skills: SkillCounts::default(),
                errors_returned: 0.0,
                tool_need_turns: 0.0,
                forced_turns: 0.0,
                without_needed_tool: 0.0,
                tool_choice_unsupported: 0.0,
                end_reasons: TURN_END_REASONS
                    .iter()
                    .map(|r| ((*r).to_owned(), 0.0))
                    .collect(),
                triage_count: 0,
                triage_p50_ms: None,
                triage_p95_ms: None,
            },
            samples: Vec::new(),
            next_sample: 0,
        }
    }

    /// `observe(telemetry)`.
    pub fn observe(&mut self, t: &TurnTelemetry) {
        let total = &mut self.total;
        total.turns += 1.0;
        total.rounds += count(t.rounds);
        total.tool_calls += count(t.tool_calls);
        total.meta_calls.search += count(t.meta_calls.search);
        total.meta_calls.skill_load += count(t.meta_calls.skill_load);
        total.meta_calls.skill_read += count(t.meta_calls.skill_read);
        total.skills.injected += count(t.skills.injected);
        total.skills.loaded += count(t.skills.loaded);
        total.errors_returned += count(t.errors_returned);
        if t.tool_need_detected {
            total.tool_need_turns += 1.0;
            // `t.toolCalls === 0`: the raw value, not the counted one.
            if t.tool_calls == 0.0 {
                total.without_needed_tool += 1.0;
            }
        }
        if t.tool_choice_forced {
            total.forced_turns += 1.0;
        }
        if t.tool_choice_status == "unsupported" {
            total.tool_choice_unsupported += 1.0;
        }
        let reason = if TURN_END_REASONS.contains(&t.end_reason.as_str()) {
            t.end_reason.as_str()
        } else {
            "failed"
        };
        *total.end_reasons.entry(reason.to_owned()).or_insert(0.0) += 1.0;
        if let Some(ms) = t.triage_duration_ms {
            if ms.is_finite() && ms >= 0.0 {
                if self.next_sample < self.samples.len() {
                    self.samples[self.next_sample] = ms;
                } else {
                    self.samples.push(ms);
                }
                self.next_sample = (self.next_sample + 1) % TRIAGE_SAMPLE_LIMIT;
            }
        }
    }

    /// `snapshot()`: an independent copy with the nearest-rank quantiles.
    pub fn snapshot(&self) -> TurnTelemetrySummary {
        let mut sorted = self.samples.clone();
        sorted.sort_by(f64::total_cmp);
        let rank = |quantile: f64| -> Option<f64> {
            let at = (sorted.len() as f64 * quantile).ceil() - 1.0;
            if at < 0.0 {
                None
            } else {
                sorted.get(at as usize).copied()
            }
        };
        let mut out = self.total.clone();
        out.triage_count = sorted.len();
        out.triage_p50_ms = rank(0.5);
        out.triage_p95_ms = rank(0.95);
        out
    }
}
