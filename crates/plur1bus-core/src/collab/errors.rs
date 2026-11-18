//! `collab/errors.ts`: the typed failures of the collaboration library. A guardrail refusal is `code: "guardrail"` plus a
//! `guardrail` reason. The wire text of the code and of the reason is the TypeScript text; the message is part of what the
//! vectors compare, because a caller (the tool that tells the model why a delegation was refused) reads it.
use std::fmt;

/// `CollabErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollabErrorCode {
    /// `unauthorized`
    Unauthorized,
    /// `not-found`
    NotFound,
    /// `conflict`
    Conflict,
    /// `invalid`
    Invalid,
    /// `archived`
    Archived,
    /// `guardrail`
    Guardrail,
    /// `no-scope`
    NoScope,
    /// `aborted`
    Aborted,
    /// `storage`
    Storage,
}

impl CollabErrorCode {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::NotFound => "not-found",
            Self::Conflict => "conflict",
            Self::Invalid => "invalid",
            Self::Archived => "archived",
            Self::Guardrail => "guardrail",
            Self::NoScope => "no-scope",
            Self::Aborted => "aborted",
            Self::Storage => "storage",
        }
    }
}

/// `GuardrailReason`: why a consult or delegation was refused before it ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardrailReason {
    /// `depth`
    Depth,
    /// `cycle`
    Cycle,
    /// `self-call`
    SelfCall,
    /// `fanout`
    Fanout,
    /// `pair-limit`
    PairLimit,
    /// `timeout`
    Timeout,
    /// `token-budget`
    TokenBudget,
    /// `repeat`
    Repeat,
    /// `project-boundary`
    ProjectBoundary,
    /// `agent-inactive`
    AgentInactive,
}

impl GuardrailReason {
    /// The TypeScript spelling (also what a refused span stores in `spans.guardrail`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Depth => "depth",
            Self::Cycle => "cycle",
            Self::SelfCall => "self-call",
            Self::Fanout => "fanout",
            Self::PairLimit => "pair-limit",
            Self::Timeout => "timeout",
            Self::TokenBudget => "token-budget",
            Self::Repeat => "repeat",
            Self::ProjectBoundary => "project-boundary",
            Self::AgentInactive => "agent-inactive",
        }
    }

    /// The reason a stored `spans.guardrail` text names, `None` for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "depth" => Self::Depth,
            "cycle" => Self::Cycle,
            "self-call" => Self::SelfCall,
            "fanout" => Self::Fanout,
            "pair-limit" => Self::PairLimit,
            "timeout" => Self::Timeout,
            "token-budget" => Self::TokenBudget,
            "repeat" => Self::Repeat,
            "project-boundary" => Self::ProjectBoundary,
            "agent-inactive" => Self::AgentInactive,
            _ => return None,
        })
    }
}

/// `CollabError`. `raw` marks what TypeScript throws as a plain `Error` (a SQLite constraint, a malformed stored value): the
/// caller sees the failure but no typed code, so the vectors record only that it failed.
#[derive(Clone, Debug, PartialEq)]
pub struct CollabError {
    /// The code.
    pub code: CollabErrorCode,
    /// The message.
    pub message: String,
    /// `reason`, when the thrower gave one.
    pub reason: Option<String>,
    /// `cause`, only ever `macos-acceptance-pending`.
    pub cause: Option<&'static str>,
    /// The guardrail, for a `guardrail` code.
    pub guardrail: Option<GuardrailReason>,
    /// Whether TypeScript would have thrown something that is not a `CollabError`.
    pub raw: bool,
    /// Set when TypeScript would have thrown a `BoardError`: its code (`invalid`, `not-found`, `conflict`, `wip`, `archived`,
    /// `denied`). A board refusal is a different class from a collaboration refusal, so `code` is not meaningful then.
    pub board_code: Option<&'static str>,
}

impl CollabError {
    /// `new CollabError(code, message)`.
    pub fn new(code: CollabErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            reason: None,
            cause: None,
            guardrail: None,
            raw: false,
            board_code: None,
        }
    }

    /// `new BoardError(code, message)`.
    pub fn board(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            board_code: Some(code),
            ..Self::new(CollabErrorCode::Invalid, message)
        }
    }

    /// `new CollabError(code, message, { reason })`.
    pub fn with_reason(
        code: CollabErrorCode,
        message: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            reason: Some(reason.into()),
            ..Self::new(code, message)
        }
    }

    /// `new CollabError("guardrail", message, { guardrail, reason })`: the service always sets both to the same text.
    pub fn guardrail(message: impl Into<String>, reason: GuardrailReason) -> Self {
        Self {
            guardrail: Some(reason),
            reason: Some(reason.as_str().to_owned()),
            ..Self::new(CollabErrorCode::Guardrail, message)
        }
    }

    /// A guardrail refusal without a `reason` (`delegationWorkBudget` throws it that way).
    pub fn guardrail_only(message: impl Into<String>, reason: GuardrailReason) -> Self {
        Self {
            guardrail: Some(reason),
            ..Self::new(CollabErrorCode::Guardrail, message)
        }
    }

    /// A failure TypeScript would throw as a plain `Error`.
    pub fn raw(message: impl Into<String>) -> Self {
        Self {
            raw: true,
            ..Self::new(CollabErrorCode::Storage, message)
        }
    }

    /// `isCollabError`.
    pub fn is_typed(&self) -> bool {
        !self.raw
    }
}

impl fmt::Display for CollabError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CollabError {}

impl From<plur1bus_store::rusqlite::Error> for CollabError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        Self::raw(e.to_string())
    }
}

impl From<plur1bus_store::StoreError> for CollabError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        use plur1bus_store::StoreError as S;
        match e {
            S::NewerSchema {
                supported, found, ..
            } => Self::with_reason(
                CollabErrorCode::Storage,
                format!(
                    "collab store schema v{found} is newer than this core supports (v{supported})"
                ),
                "schema-too-new",
            ),
            S::Migration { to, error, .. } => Self::with_reason(
                CollabErrorCode::Storage,
                format!("collab store migration to v{to} failed: {error}"),
                "migration-failed",
            ),
            other => Self::raw(other.to_string()),
        }
    }
}
