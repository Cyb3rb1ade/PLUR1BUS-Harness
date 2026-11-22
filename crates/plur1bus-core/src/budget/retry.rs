//! `budget/retry.ts`: per failure class and turn, at most `max_attempts` retries reserving at most `max_tokens` (input plus
//! output) together, and a ceiling on all retries of one turn. In memory only, as in TypeScript: a restart forgets a turn,
//! which ends with it.
use super::{BudgetError, MAX_SAFE};
use std::collections::HashMap;
use std::fmt;

/// `RetryClass`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RetryClass {
    /// `rate_limit`.
    RateLimit,
    /// `overloaded`.
    Overloaded,
    /// `network`.
    Network,
    /// `timeout`.
    Timeout,
    /// `tool_call_invalid`.
    ToolCallInvalid,
}

/// The classes in the order of [`RetryPolicy`]'s array.
pub const CLASSES: [RetryClass; 5] = [
    RetryClass::RateLimit,
    RetryClass::Overloaded,
    RetryClass::Network,
    RetryClass::Timeout,
    RetryClass::ToolCallInvalid,
];

impl RetryClass {
    /// The name TypeScript uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RateLimit => "rate_limit",
            Self::Overloaded => "overloaded",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::ToolCallInvalid => "tool_call_invalid",
        }
    }

    /// A class by name. An unknown name, `toString` and `__proto__` among them, is a range error (TypeScript checks
    /// `Object.hasOwn` for the same reason).
    pub fn parse(name: &str) -> Result<Self, BudgetError> {
        CLASSES
            .into_iter()
            .find(|c| c.as_str() == name)
            .ok_or_else(|| BudgetError::Range("unknown failure class".into()))
    }

    fn index(self) -> usize {
        CLASSES.iter().position(|c| *c == self).unwrap_or(0)
    }
}

/// `RetryRule`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryRule {
    /// Retries allowed (the initial call is not one).
    pub max_attempts: i64,
    /// Tokens the retries of this class may reserve together.
    pub max_tokens: i64,
}

/// `RetryPolicy`: one rule per class, in [`CLASSES`] order.
pub type RetryPolicy = [RetryRule; 5];

/// `DEFAULT_RETRY_POLICY`.
pub const DEFAULT_RETRY_POLICY: RetryPolicy = [
    RetryRule {
        max_attempts: 3,
        max_tokens: 200_000,
    },
    RetryRule {
        max_attempts: 2,
        max_tokens: 200_000,
    },
    RetryRule {
        max_attempts: 2,
        max_tokens: 100_000,
    },
    RetryRule {
        max_attempts: 1,
        max_tokens: 200_000,
    },
    RetryRule {
        max_attempts: 1,
        max_tokens: 100_000,
    },
];

/// `DEFAULT_RETRY_TURN_TOKENS`: tokens all retries of one turn may reserve together, across classes.
pub const DEFAULT_RETRY_TURN_TOKENS: i64 = 400_000;

/// Why a retry was refused (`RetryBudgetExceededError.reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// The class used its attempts.
    Attempts,
    /// The class or the turn would pass its tokens.
    Tokens,
}

/// A refused or an invalid retry.
#[derive(Debug, PartialEq, Eq)]
pub enum RetryError {
    /// `RetryBudgetExceededError` (`code` `retry_budget_exceeded`).
    Exceeded {
        /// The class.
        class: RetryClass,
        /// Why.
        reason: Reason,
    },
    /// `RangeError`: invalid input.
    Range(&'static str),
}

impl fmt::Display for RetryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exceeded { class, reason } => write!(
                f,
                "retry {} {} budget exceeded",
                class.as_str(),
                if *reason == Reason::Attempts {
                    "attempts"
                } else {
                    "tokens"
                }
            ),
            Self::Range(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for RetryError {}

#[derive(Clone, Copy, Default)]
struct ClassUse {
    attempts: i64,
    tokens: i64,
}

#[derive(Default)]
struct Turn {
    total: i64,
    classes: [ClassUse; 5],
}

struct Ticket {
    turn_id: String,
    class: RetryClass,
    reserved: i64,
    settled: bool,
}

/// `RetryBudget`: counts retry attempts (the initial call excluded) and their tokens. Tokens remain reserved until the
/// authoritative settlement.
pub struct RetryBudget {
    turns: HashMap<String, Turn>,
    tickets: HashMap<u64, Ticket>,
    next_ticket: u64,
    policy: RetryPolicy,
    max_turn_tokens: i64,
}

fn safe(v: i64) -> bool {
    (0..=MAX_SAFE).contains(&v)
}

impl RetryBudget {
    /// `new RetryBudget(policy, maxTurnTokens)`.
    pub fn new(policy: RetryPolicy, max_turn_tokens: i64) -> Result<Self, RetryError> {
        if policy
            .iter()
            .any(|r| !safe(r.max_attempts) || !safe(r.max_tokens))
        {
            return Err(RetryError::Range("invalid retry policy"));
        }
        if !safe(max_turn_tokens) {
            return Err(RetryError::Range("invalid turn tokens"));
        }
        Ok(Self {
            turns: HashMap::new(),
            tickets: HashMap::new(),
            next_ticket: 0,
            policy,
            max_turn_tokens,
        })
    }

    /// The default policy and turn ceiling.
    pub fn with_defaults() -> Self {
        Self {
            turns: HashMap::new(),
            tickets: HashMap::new(),
            next_ticket: 0,
            policy: DEFAULT_RETRY_POLICY,
            max_turn_tokens: DEFAULT_RETRY_TURN_TOKENS,
        }
    }

    /// Reserves one retry of `class` for `turn_id`; returns its ticket. A refusal changes nothing.
    pub fn consume(
        &mut self,
        turn_id: &str,
        class: RetryClass,
        estimated_tokens: i64,
    ) -> Result<u64, RetryError> {
        if turn_id.is_empty() || !safe(estimated_tokens) {
            return Err(RetryError::Range("invalid retry reservation"));
        }
        let rule = self.policy[class.index()];
        let (total, prev) = self
            .turns
            .get(turn_id)
            .map_or((0, ClassUse::default()), |t| {
                (t.total, t.classes[class.index()])
            });
        if prev.attempts >= rule.max_attempts {
            return Err(RetryError::Exceeded {
                class,
                reason: Reason::Attempts,
            });
        }
        if estimated_tokens > rule.max_tokens - prev.tokens
            || estimated_tokens > self.max_turn_tokens - total
        {
            return Err(RetryError::Exceeded {
                class,
                reason: Reason::Tokens,
            });
        }
        let turn = self.turns.entry(turn_id.to_owned()).or_default();
        turn.classes[class.index()] = ClassUse {
            attempts: prev.attempts + 1,
            tokens: prev.tokens + estimated_tokens,
        };
        turn.total += estimated_tokens;
        self.next_ticket += 1;
        self.tickets.insert(
            self.next_ticket,
            Ticket {
                turn_id: turn_id.to_owned(),
                class,
                reserved: estimated_tokens,
                settled: false,
            },
        );
        Ok(self.next_ticket)
    }

    /// Reconciles a retry's actual tokens once. Actual overages stay counted even when this fails. `Ok(false)`: already settled.
    pub fn settle(&mut self, ticket: u64, actual_tokens: i64) -> Result<bool, RetryError> {
        if !safe(actual_tokens) {
            return Err(RetryError::Range("invalid actual retry tokens"));
        }
        let entry = self
            .tickets
            .get_mut(&ticket)
            .ok_or(RetryError::Range("unknown retry ticket"))?;
        if entry.settled {
            return Ok(false);
        }
        let delta = actual_tokens - entry.reserved;
        let class = entry.class;
        let Some(turn) = self.turns.get_mut(&entry.turn_id) else {
            return Err(RetryError::Range("unknown retry ticket"));
        };
        let usage = &mut turn.classes[class.index()];
        let (new_total, new_class) = (turn.total + delta, usage.tokens + delta);
        if !(-MAX_SAFE..=MAX_SAFE).contains(&new_total)
            || !(-MAX_SAFE..=MAX_SAFE).contains(&new_class)
        {
            return Err(RetryError::Range("retry token overflow"));
        }
        turn.total = new_total;
        usage.tokens = new_class;
        entry.settled = true;
        if new_total > self.max_turn_tokens || new_class > self.policy[class.index()].max_tokens {
            return Err(RetryError::Exceeded {
                class,
                reason: Reason::Tokens,
            });
        }
        Ok(true)
    }

    /// The host calls this only when the turn ends; do not reset between retries.
    pub fn end_turn(&mut self, turn_id: &str) {
        self.turns.remove(turn_id);
        self.tickets.retain(|_, t| t.turn_id != turn_id);
    }
}
