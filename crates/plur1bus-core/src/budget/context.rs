//! `budget/context.ts`: the split of a model's context window into the five prompt zones. Pure allocation; it never edits
//! prompt bytes, and the caller subtracts the output headroom first.
use super::{BudgetError, MAX_SAFE};

/// `ZoneName` of `prompt/types.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    /// Tool definitions.
    Tools,
    /// The system prompt.
    System,
    /// Frozen memory.
    Memory,
    /// The conversation.
    Conversation,
    /// Volatile context.
    Volatile,
}

/// The zones in allocation order.
pub const ZONES: [Zone; 5] = [
    Zone::Tools,
    Zone::System,
    Zone::Memory,
    Zone::Conversation,
    Zone::Volatile,
];

impl Zone {
    /// The name TypeScript uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tools => "tools",
            Self::System => "system",
            Self::Memory => "memory",
            Self::Conversation => "conversation",
            Self::Volatile => "volatile",
        }
    }

    pub(crate) fn index(self) -> usize {
        self as usize
    }
}

/// One zone's share of the window: a floor and a ceiling as fractions, and an optional ceiling in tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZoneShare {
    /// `minShare`.
    pub min_share: f64,
    /// `maxShare`.
    pub max_share: f64,
    /// `maxTokens`.
    pub max_tokens: Option<i64>,
}

/// `ZonePolicy`, in [`ZONES`] order.
pub type ZonePolicy = [ZoneShare; 5];
/// `ZoneBudgets`: tokens per zone, in [`ZONES`] order.
pub type ZoneBudgets = [i64; 5];

/// `DEFAULT_ZONE_POLICY`. Frozen memory defaults to the engine's 17,000 character budget at four characters per token.
pub const DEFAULT_ZONE_POLICY: ZonePolicy = [
    ZoneShare {
        min_share: 0.0,
        max_share: 0.2,
        max_tokens: None,
    },
    ZoneShare {
        min_share: 0.0,
        max_share: 0.2,
        max_tokens: None,
    },
    ZoneShare {
        min_share: 0.0,
        max_share: 0.25,
        max_tokens: Some(4250),
    },
    ZoneShare {
        min_share: 0.0,
        max_share: 0.8,
        max_tokens: None,
    },
    ZoneShare {
        min_share: 0.0,
        max_share: 0.2,
        max_tokens: None,
    },
];

/// `ContextAllocation`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContextAllocation {
    /// A split; `unallocated` is what no zone can take.
    Allocated {
        /// Tokens per zone.
        budgets: ZoneBudgets,
        /// The rest of the window.
        unallocated: i64,
    },
    /// No split satisfies the policy.
    Infeasible {
        /// Why.
        reason: String,
    },
}

/// `allocateContext`: minima first, then spare capacity evenly, never past a maximum.
pub fn allocate_context(
    model_window: i64,
    policy: &ZonePolicy,
) -> Result<ContextAllocation, BudgetError> {
    if !(0..=MAX_SAFE).contains(&model_window) {
        return Err(BudgetError::Range("invalid model window".into()));
    }
    let window = model_window as f64;
    let mut budgets = [0_i64; 5];
    let mut maxima = [0_i64; 5];
    for z in ZONES {
        let p = policy[z.index()];
        let tokens_ok = p.max_tokens.is_none_or(|t| (0..=MAX_SAFE).contains(&t));
        if !p.min_share.is_finite()
            || !p.max_share.is_finite()
            || p.min_share < 0.0
            || p.max_share > 1.0
            || p.min_share > p.max_share
            || !tokens_ok
        {
            return Err(BudgetError::Range(format!(
                "invalid policy for {}",
                z.as_str()
            )));
        }
        budgets[z.index()] = (window * p.min_share).ceil() as i64;
        maxima[z.index()] =
            ((window * p.max_share).floor() as i64).min(p.max_tokens.unwrap_or(model_window));
        if budgets[z.index()] > maxima[z.index()] {
            return Ok(ContextAllocation::Infeasible {
                reason: format!("minimum exceeds maximum for {}", z.as_str()),
            });
        }
    }
    let mut remaining = model_window - budgets.iter().sum::<i64>();
    if remaining < 0 {
        return Ok(ContextAllocation::Infeasible {
            reason: "sum of minima exceeds window".into(),
        });
    }
    while remaining > 0 {
        let open: Vec<usize> = (0..5).filter(|i| budgets[*i] < maxima[*i]).collect();
        if open.is_empty() {
            break;
        }
        let share = (remaining / open.len() as i64).max(1);
        for i in open {
            let add = remaining.min(share).min(maxima[i] - budgets[i]);
            budgets[i] += add;
            remaining -= add;
        }
    }
    Ok(ContextAllocation::Allocated {
        budgets,
        unallocated: remaining,
    })
}

/// `checkZones`' result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ZoneCheck {
    /// Every zone is within its budget.
    WithinBudget,
    /// These zones are over.
    ZoneExceeded(Vec<ZoneOver>),
}

/// One zone over its budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZoneOver {
    /// The zone.
    pub zone: Zone,
    /// Its budget.
    pub limit: i64,
    /// What it used.
    pub used: i64,
}

/// `checkZones`: `used[i]` is `None` for a zone with no count (counted as 0).
pub fn check_zones(
    budgets: &ZoneBudgets,
    used: &[Option<i64>; 5],
) -> Result<ZoneCheck, BudgetError> {
    let mut over = Vec::new();
    for z in ZONES {
        let n = used[z.index()].unwrap_or(0);
        let b = budgets[z.index()];
        if !(0..=MAX_SAFE).contains(&n) || !(0..=MAX_SAFE).contains(&b) {
            return Err(BudgetError::Range("invalid zone counts".into()));
        }
        if n > b {
            over.push(ZoneOver {
                zone: z,
                limit: b,
                used: n,
            });
        }
    }
    Ok(if over.is_empty() {
        ZoneCheck::WithinBudget
    } else {
        ZoneCheck::ZoneExceeded(over)
    })
}
