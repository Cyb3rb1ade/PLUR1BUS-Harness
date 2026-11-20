//! `collab/limits.ts` and `collab/defaults.ts` (D124): the collaboration limits, resolved once from the configuration's
//! defaults and the narrowing overrides a project stores, and the per-delegation work budget.
//!
//! **JavaScript number rules.** A project's settings are stored JSON, so an override can be any value. `narrow` accepts a value
//! only when `Number.isFinite(value) && value >= 0` (a string `"5"`, `null`, `true` and `-1` all fall back to the maximum:
//! an invalid number never widens a bound), floors it and caps it at the configured maximum. `repeatWindowMs` and
//! `tokenBudget` are not floored, and an invalid `tokenBudget` becomes `0` (nothing may be spent), where an absent or `null`
//! one means no cap.
use super::errors::{CollabError, GuardrailReason};
use super::types::CollabSettings;
use crate::approvals::js_json::J;
use std::sync::{Arc, Mutex};

/// `CollaborationTaskClass`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskClass {
    /// `consult`
    Consult,
    /// `research`
    Research,
    /// `review`
    Review,
    /// `code-small`
    CodeSmall,
    /// `code-large`
    CodeLarge,
}

impl TaskClass {
    /// Every class, in the order the configuration lists them.
    pub const ALL: [TaskClass; 5] = [
        Self::Consult,
        Self::Research,
        Self::Review,
        Self::CodeSmall,
        Self::CodeLarge,
    ];

    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Consult => "consult",
            Self::Research => "research",
            Self::Review => "review",
            Self::CodeSmall => "code-small",
            Self::CodeLarge => "code-large",
        }
    }

    /// The class a name spells.
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == text)
    }

    fn index(self) -> usize {
        Self::ALL.iter().position(|c| *c == self).unwrap_or(0)
    }
}

/// `CallClass`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallClass {
    /// `read`
    Read,
    /// `write`
    Write,
    /// `review`
    Review,
}

impl CallClass {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Review => "review",
        }
    }
}

/// One task class's limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskLimits {
    /// Work rounds.
    pub rounds: i64,
    /// Wall time.
    pub wall_time_ms: i64,
    /// Time without progress.
    pub stall_time_ms: i64,
}

/// `CollaborationLimitsConfig`: what the installation's configuration says (`defaults().collaboration.limits`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollaborationLimitsConfig {
    /// `readHelpers.perTurn`
    pub read_helpers_per_turn: i64,
    /// `readHelpers.depth`
    pub read_helpers_depth: i64,
    /// `writers.perProject`
    pub writers_per_project: i64,
    /// `consults.perPairPerTurn`
    pub consults_per_pair_per_turn: i64,
    /// `workTokens`
    pub work_tokens: i64,
    /// `taskClasses`, in [`TaskClass::ALL`] order.
    pub task_classes: [TaskLimits; 5],
}

impl Default for CollaborationLimitsConfig {
    fn default() -> Self {
        let t = |rounds, wall_time_ms, stall_time_ms| TaskLimits {
            rounds,
            wall_time_ms,
            stall_time_ms,
        };
        Self {
            read_helpers_per_turn: 8,
            read_helpers_depth: 2,
            writers_per_project: 4,
            consults_per_pair_per_turn: 4,
            work_tokens: 131_072,
            task_classes: [
                t(25, 300_000, 120_000),
                t(50, 900_000, 300_000),
                t(40, 1_200_000, 300_000),
                t(100, 2_700_000, 600_000),
                t(200, 7_200_000, 900_000),
            ],
        }
    }
}

/// `DEFAULT_COLLAB_LIMITS.writers.perProject`, which `writerCapacity` compares a project's value against.
pub const DEFAULT_WRITERS_PER_PROJECT: i64 = 4;

/// `CollabLimits`: the configuration's shape plus the project's own keys.
#[derive(Clone, Debug, PartialEq)]
pub struct CollabLimits {
    /// `readHelpers.perTurn`
    pub read_helpers_per_turn: i64,
    /// `readHelpers.depth`
    pub read_helpers_depth: i64,
    /// `writers.perProject`
    pub writers_per_project: i64,
    /// `consults.perPairPerTurn`
    pub consults_per_pair_per_turn: i64,
    /// `workTokens`
    pub work_tokens: i64,
    /// `taskClasses`, in [`TaskClass::ALL`] order.
    pub task_classes: [TaskLimits; 5],
    /// `returnTokens`
    pub return_tokens: i64,
    /// `allowCrossProject`
    pub allow_cross_project: bool,
    /// `repeatWindowMs`
    pub repeat_window_ms: f64,
    /// `tokenBudget`
    pub token_budget: Option<f64>,
}

impl CollabLimits {
    /// `limits.taskClasses[class]`.
    pub fn task(&self, class: TaskClass) -> TaskLimits {
        self.task_classes[class.index()]
    }
}

/// `typeof v === "number"` and the double it holds.
fn number(project: &J, key: &str) -> Option<f64> {
    project.get(key).and_then(J::as_f64)
}

/// `narrow`: `Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), maximum) : maximum`.
fn narrow(value: Option<f64>, maximum: i64) -> i64 {
    match value {
        Some(v) if v.is_finite() && v >= 0.0 => {
            let floored = v.floor();
            if floored < maximum as f64 {
                floored as i64
            } else {
                maximum
            }
        }
        _ => maximum,
    }
}

/// `resolveCollabLimits(config, project)`; `project` is the stored settings object (anything else reads as empty).
pub fn resolve_collab_limits(config: &CollaborationLimitsConfig, project: &J) -> CollabLimits {
    let project = if matches!(project, J::Obj(_)) {
        project
    } else {
        &J::Obj(Vec::new())
    };
    let timeout = number(project, "timeoutMs");
    let mut task_classes = config.task_classes;
    for limits in &mut task_classes {
        let wall = narrow(timeout, limits.wall_time_ms);
        *limits = TaskLimits {
            rounds: narrow(number(project, "maxTurns"), limits.rounds),
            wall_time_ms: wall,
            stall_time_ms: limits.stall_time_ms.min(wall),
        };
    }
    CollabLimits {
        read_helpers_per_turn: narrow(number(project, "maxFanout"), config.read_helpers_per_turn),
        read_helpers_depth: narrow(number(project, "maxDepth"), config.read_helpers_depth),
        writers_per_project: config.writers_per_project,
        consults_per_pair_per_turn: narrow(
            number(project, "maxPairPerTurn"),
            config.consults_per_pair_per_turn,
        ),
        work_tokens: config.work_tokens,
        task_classes,
        return_tokens: narrow(number(project, "returnTokens"), 2000),
        allow_cross_project: matches!(project.get("allowCrossProject"), Some(J::Bool(true))),
        repeat_window_ms: match number(project, "repeatWindowMs") {
            Some(v) if v.is_finite() && v >= 0.0 => v,
            _ => 30_000.0,
        },
        token_budget: match project.get("tokenBudget") {
            None | Some(J::Null) => None,
            Some(J::Num(v)) if v.is_finite() && *v >= 0.0 => Some(*v),
            Some(_) => Some(0.0),
        },
    }
}

/// `legacyCollabSettings(limits)`: the projection `project.*` shows.
pub fn legacy_collab_settings(limits: &CollabLimits) -> CollabSettings {
    let consult = limits.task(TaskClass::Consult);
    CollabSettings {
        max_depth: limits.read_helpers_depth,
        max_fanout: limits.read_helpers_per_turn,
        max_pair_per_turn: limits.consults_per_pair_per_turn,
        max_turns: consult.rounds,
        timeout_ms: consult.wall_time_ms,
        return_tokens: limits.return_tokens,
        allow_cross_project: limits.allow_cross_project,
        repeat_window_ms: limits.repeat_window_ms,
        token_budget: limits.token_budget,
        collaboration: None,
    }
}

/// `DEFAULT_COLLAB_SETTINGS`.
pub fn default_collab_settings() -> CollabSettings {
    legacy_collab_settings(&resolve_collab_limits(
        &CollaborationLimitsConfig::default(),
        &J::Obj(Vec::new()),
    ))
}

/// `SPAN_PREVIEW_CHARS`.
pub const SPAN_PREVIEW_CHARS: usize = 256;

#[derive(Debug, Default)]
struct BudgetState {
    used: i64,
    reserved: i64,
}

/// `DelegationWorkBudget`: a trusted per-delegation budget shared by acceptance, work, retries and return repair.
#[derive(Clone, Debug)]
pub struct DelegationWorkBudget {
    limit: i64,
    state: Arc<Mutex<BudgetState>>,
    parent: Option<Box<DelegationWorkBudget>>,
}

/// One reservation; settle or release it exactly once (a second call does nothing).
#[derive(Debug)]
pub struct Reservation {
    tokens: i64,
    active: bool,
    state: Arc<Mutex<BudgetState>>,
    upstream: Option<Box<Reservation>>,
}

/// `Number.isSafeInteger`.
fn is_safe_integer(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0
}

impl DelegationWorkBudget {
    /// `delegationWorkBudget(limit, parent)`.
    pub fn new(limit: i64, parent: Option<&DelegationWorkBudget>) -> Self {
        Self {
            limit,
            state: Arc::new(Mutex::new(BudgetState::default())),
            parent: parent.map(|p| Box::new(p.clone())),
        }
    }

    /// `limit`.
    pub fn limit(&self) -> i64 {
        self.limit
    }

    /// `used`: what was settled.
    pub fn used(&self) -> i64 {
        self.state.lock().map_or(0, |s| s.used)
    }

    /// `reserve(tokens)`: before a provider call, so concurrent nested calls cannot spend the same allocation twice. The
    /// parent reserves too, so a child can never spend what its parent no longer has. `tokens` is a double because the
    /// check is `Number.isSafeInteger(tokens)`.
    pub fn reserve(&self, tokens: f64) -> Result<Reservation, CollabError> {
        let refuse = || {
            CollabError::guardrail_only(
                "delegation work allocation exceeded",
                GuardrailReason::TokenBudget,
            )
        };
        if !is_safe_integer(tokens) || tokens < 0.0 {
            return Err(refuse());
        }
        let tokens = tokens as i64;
        let mut state = self.state.lock().map_err(|_| refuse())?;
        if state
            .used
            .saturating_add(state.reserved)
            .saturating_add(tokens)
            > self.limit
        {
            return Err(refuse());
        }
        // All acquisitions go from child to parent. The local check and reservation are one operation.
        let upstream = match &self.parent {
            Some(p) => Some(Box::new(p.reserve(tokens as f64)?)),
            None => None,
        };
        state.reserved += tokens;
        Ok(Reservation {
            tokens,
            active: true,
            state: self.state.clone(),
            upstream,
        })
    }
}

impl Reservation {
    /// `settle(actual)`: the reservation is spent as `actual` (which may differ from what was reserved).
    pub fn settle(&mut self, actual: i64) {
        if !self.active {
            return;
        }
        self.active = false;
        if let Ok(mut s) = self.state.lock() {
            s.reserved -= self.tokens;
            s.used += actual;
        }
        if let Some(u) = &mut self.upstream {
            u.settle(actual);
        }
    }

    /// `release()`: the reservation is given back unspent.
    pub fn release(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        if let Ok(mut s) = self.state.lock() {
            s.reserved -= self.tokens;
        }
        if let Some(u) = &mut self.upstream {
            u.release();
        }
    }
}
