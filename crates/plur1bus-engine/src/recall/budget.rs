//! Recall budget resolution and tier allocation.
//!
//! Ports `resolveRecallBudget` and `applyRecallBudget` from `lib/recall-budget.js`.
//! Without `preserve_order` the result is the tier concatenation
//! core, canonical, project, episodic, associative. It is not a score sort.

use super::candidate::RecallCandidate;
use serde_json::Value;
use std::time::{Duration, Instant};

const DEFAULT_SOFT_MS: f64 = 35_000.0;
const DEFAULT_HARD_MS: f64 = 45_000.0;
const DEFAULT_CAP_CHARS: f64 = 17_000.0;

/// Request time/character budgets; item selection is resolved independently below.
#[derive(Clone, Copy, Debug)]
pub struct RecallBudget {
    /// Elapsed milliseconds after which optional work takes the fast path.
    pub soft_ms: f64,
    /// Maximum request duration before returning classified partial output.
    pub hard_ms: f64,
    /// Host aggregate UTF-16 cap, with the renderer's non-positive uncapped semantics.
    pub cap_chars: f64,
}

impl RecallBudget {
    /// Resolve query overrides against the existing engine config and Node defaults.
    #[must_use]
    pub fn resolve(overrides: &Value, config: &Value) -> Self {
        let soft = valid_milliseconds(&config["recall"]["softBudgetMs"]).unwrap_or(DEFAULT_SOFT_MS);
        let hard =
            valid_milliseconds(&config["runtime"]["recallTimeoutMs"]).unwrap_or(DEFAULT_HARD_MS);
        Self {
            soft_ms: valid_milliseconds(&overrides["softMs"]).unwrap_or(soft),
            hard_ms: valid_milliseconds(&overrides["hardMs"]).unwrap_or(hard),
            cap_chars: overrides["capChars"]
                .as_f64()
                .or_else(|| config["recall"]["globalInjectMaxChars"].as_f64())
                .unwrap_or(DEFAULT_CAP_CHARS),
        }
    }

    /// Hard deadline anchored at request entry; caller deadlines can only shorten it.
    #[must_use]
    pub fn cancellation(
        &self,
        started: Instant,
        caller: &crate::contract::Cancel,
    ) -> crate::contract::Cancel {
        let duration = Duration::try_from_secs_f64(self.hard_ms / 1000.0)
            .ok()
            .filter(|duration| !duration.is_zero())
            .unwrap_or(Duration::from_millis(DEFAULT_HARD_MS as u64));
        caller.limited_to(started.checked_add(duration).unwrap_or(started))
    }
}

fn valid_milliseconds(value: &Value) -> Option<f64> {
    let milliseconds = value
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)?;
    let duration = Duration::try_from_secs_f64(milliseconds / 1000.0).ok()?;
    (!duration.is_zero() && Instant::now().checked_add(duration).is_some()).then_some(milliseconds)
}

/// The pinned runtime's automatic item limit, separate from time and character budgets.
/// Only boolean `enabled: true` enables adaptation; invalid ceilings default to twelve.
#[must_use]
pub fn resolve_runtime_recall_budget(query: &str, ceiling: f64, adaptive: &Value) -> usize {
    let cap = super::namespace_budget::normalize_bounded_recall_integer(ceiling, 12.0, 1.0, 100.0);
    if adaptive.get("enabled") != Some(&Value::Bool(true)) {
        return cap as usize;
    }
    let pct = adaptive
        .get("tokenBudgetPct")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.3)
        .clamp(0.0, 1.0);
    // JavaScript's word boundary is ASCII: accented letters are separators too.
    let project_signal = query
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|word| {
            ["project", "plan", "milestone", "roadmap", "deadline"]
                .iter()
                .any(|signal| word.eq_ignore_ascii_case(signal))
        });
    let resolved = resolve_recall_budget(
        crate::text::js::utf16_len(query) as f64,
        project_signal,
        cap,
        pct,
    );
    resolved.budget.floor().max(1.0).min(cap) as usize
}

/// `resolveRecallBudget` output. `budget` stays a float so a non-integer cap is not rounded away.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BudgetResolution {
    /// Memories the caller should request.
    pub budget: f64,
    /// `small_prompt`, `normal_prompt`, `complex_prompt`, or `project_signals`.
    pub reason: &'static str,
}

/// How many rows each tier contributed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TierCounts {
    /// Rows with `coreMemoryScore >= 0.7`.
    pub core: usize,
    /// Canonical rows passed beside the memory list.
    pub canonical: usize,
    /// `project` and `plan` rows that are not core or associative.
    pub project: usize,
    /// Everything that is not core, canonical, project, or associative.
    pub episodic: usize,
    /// Graph rows, capped at `floor(budget * 0.3)`.
    pub associative: usize,
}

/// Selected rows plus the tier counts from the same allocation.
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetAllocation {
    /// Kept rows. Order depends on `preserve_order`.
    pub selected: Vec<RecallCandidate>,
    /// Counts from the allocation, before a preserve-order rearrange.
    pub tier_counts: TierCounts,
}

#[derive(Clone)]
struct Tagged {
    row: RecallCandidate,
    index: Option<usize>,
}

/// Resolve the recall budget from the prompt length and the token-budget switch.
///
/// `prompt_length > 200` is strict. `token_budget_pct > 0.3` selects the expanded cap
/// `min(20, floor(max_prompt_memories * 1.5))`; otherwise the hard cap is `max_prompt_memories`.
#[must_use]
pub fn resolve_recall_budget(
    prompt_length: f64,
    has_project_signals: bool,
    max_prompt_memories: f64,
    token_budget_pct: f64,
) -> BudgetResolution {
    let expanded_cap = 20.0_f64.min((max_prompt_memories * 1.5).floor());
    let hard_cap = if token_budget_pct > 0.3 {
        expanded_cap
    } else {
        max_prompt_memories
    };
    let (budget, reason) = if prompt_length > 200.0 || has_project_signals {
        let reason = if has_project_signals && prompt_length <= 200.0 {
            "project_signals"
        } else {
            "complex_prompt"
        };
        (expanded_cap, reason)
    } else if prompt_length >= 50.0 {
        (10.0, "normal_prompt")
    } else {
        (6.0, "small_prompt")
    };
    BudgetResolution {
        budget: budget.min(hard_cap),
        reason,
    }
}

/// Partition `memories` into tiers and keep at most `budget` rows.
///
/// Core wins over graph. Associative is `source == "graph"` or `graph_source == "graph"`.
/// `preserve_order` emits canonical rows that were not in `memories` first, then the
/// selected memories in their original index order.
#[must_use]
pub fn apply_recall_budget(
    memories: &[RecallCandidate],
    canonical: &[RecallCandidate],
    budget: f64,
    preserve_order: bool,
) -> BudgetAllocation {
    let (core, project, episodic, associative) = partition(memories);
    let canonical = tag_canonical(canonical);
    let (core_kept, remaining) = take(&core, budget);
    let (canonical_kept, remaining) = take(&canonical, remaining);
    let (project_kept, remaining) = take(&project, remaining);
    let (episodic_kept, remaining) = take(&episodic, remaining);
    let associative_limit = remaining.min((budget * 0.3).floor());
    let (associative_kept, _) = take(&associative, associative_limit);
    let tier_counts = TierCounts {
        core: core_kept.len(),
        canonical: canonical_kept.len(),
        project: project_kept.len(),
        episodic: episodic_kept.len(),
        associative: associative_kept.len(),
    };
    let mut selected = core_kept;
    selected.extend(canonical_kept);
    selected.extend(project_kept);
    selected.extend(episodic_kept);
    selected.extend(associative_kept);
    if preserve_order {
        selected = preserve(selected);
    }
    BudgetAllocation {
        selected: selected.into_iter().map(|item| item.row).collect(),
        tier_counts,
    }
}

fn partition(memories: &[RecallCandidate]) -> (Vec<Tagged>, Vec<Tagged>, Vec<Tagged>, Vec<Tagged>) {
    let mut core = Vec::new();
    let mut project = Vec::new();
    let mut episodic = Vec::new();
    let mut associative = Vec::new();
    for (index, row) in memories.iter().enumerate() {
        let tagged = Tagged {
            row: row.clone(),
            index: Some(index),
        };
        if row.core_memory_score >= 0.7 {
            core.push(tagged);
        } else if row.source == "graph" || row.graph_source == "graph" {
            associative.push(tagged);
        } else if row.category == "project" || row.category == "plan" {
            project.push(tagged);
        } else {
            episodic.push(tagged);
        }
    }
    (core, project, episodic, associative)
}

fn tag_canonical(canonical: &[RecallCandidate]) -> Vec<Tagged> {
    canonical
        .iter()
        .map(|row| Tagged {
            row: row.clone(),
            index: None,
        })
        .collect()
}

fn take(items: &[Tagged], limit: f64) -> (Vec<Tagged>, f64) {
    let count = take_count(items.len(), limit);
    let selected = items.iter().take(count).cloned().collect::<Vec<_>>();
    let remaining = limit - selected.len() as f64;
    (selected, remaining)
}

fn take_count(len: usize, limit: f64) -> usize {
    if !limit.is_finite() || limit <= 0.0 {
        return 0;
    }
    let capped = (len as f64).min(limit).floor();
    if capped <= 0.0 {
        0
    } else if capped >= len as f64 {
        len
    } else {
        capped as usize
    }
}

fn preserve(selected: Vec<Tagged>) -> Vec<Tagged> {
    let mut canonical = Vec::new();
    let mut memories = Vec::new();
    for item in selected {
        if item.index.is_none() {
            canonical.push(item);
        } else {
            memories.push(item);
        }
    }
    memories.sort_by_key(|item| item.index);
    canonical.extend(memories);
    canonical
}
