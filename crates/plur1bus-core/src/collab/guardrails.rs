//! `collab/guardrails.ts`: the pure admission rules of a consult or delegation, first refusal wins, in this order: self-call,
//! cycle, depth, fan-out, pair limit, repeat, project boundary, token budget. A delegation never gets more reach than its
//! caller: writers stay at depth 1, readers at the project's narrowed depth, and a refused call leaves no work behind.
use super::errors::GuardrailReason;
use super::limits::CallClass;
use super::types::CollabSettings;

/// `GuardrailInput`.
#[derive(Clone, Debug)]
pub struct GuardrailInput {
    /// `callClass`; absent reads as a read.
    pub call_class: Option<CallClass>,
    /// `consult`; `Some(false)` is a delegation (no pair limit), anything else counts as a consult.
    pub consult: Option<bool>,
    /// The project's settings.
    pub settings: CollabSettings,
    /// The calling agent.
    pub from_agent: String,
    /// The target agent.
    pub to_agent: String,
    /// Agents already on this nested path, starting with the root from-agent.
    pub path: Vec<String>,
    /// Read starts so far this turn.
    pub fanout: i64,
    /// Starts of this pair this turn.
    pub pair_count: i64,
    /// Now.
    pub now: i64,
    /// When the chain started (not read by any rule today; part of the input).
    pub chain_started_at: i64,
    /// When the same question to the same agent was last asked.
    pub last_repeat_at: Option<i64>,
    /// Whether both agents belong to the project.
    pub same_project: bool,
    /// Tokens the chain has used.
    pub tokens_used: i64,
    /// Tokens this call would add.
    pub next_tokens: i64,
}

/// `evaluateGuardrails`: the first rule that refuses, or `None`.
pub fn evaluate_guardrails(i: &GuardrailInput) -> Option<GuardrailReason> {
    if i.from_agent == i.to_agent {
        return Some(GuardrailReason::SelfCall);
    }
    if i.path.contains(&i.to_agent) {
        return Some(GuardrailReason::Cycle);
    }
    let write = i.call_class == Some(CallClass::Write);
    let allowed_depth = if write { 1 } else { i.settings.max_depth };
    if i.path.len() as i64 > allowed_depth {
        return Some(GuardrailReason::Depth);
    }
    if !write && i.fanout >= i.settings.max_fanout {
        return Some(GuardrailReason::Fanout);
    }
    if i.consult != Some(false) && i.pair_count >= i.settings.max_pair_per_turn {
        return Some(GuardrailReason::PairLimit);
    }
    if let Some(last) = i.last_repeat_at {
        if ((i.now - last) as f64) < i.settings.repeat_window_ms {
            return Some(GuardrailReason::Repeat);
        }
    }
    if !i.same_project && !i.settings.allow_cross_project {
        return Some(GuardrailReason::ProjectBoundary);
    }
    if let Some(budget) = i.settings.token_budget {
        if ((i.tokens_used + i.next_tokens) as f64) > budget {
            return Some(GuardrailReason::TokenBudget);
        }
    }
    None
}
