//! Recall budget resolution and tier allocation.
//!
//! Ports `resolveRecallBudget` and `applyRecallBudget` from `lib/recall-budget.js`.
//! Without `preserve_order` the result is the tier concatenation
//! core, canonical, project, episodic, associative. It is not a score sort.

use super::candidate::RecallCandidate;

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
