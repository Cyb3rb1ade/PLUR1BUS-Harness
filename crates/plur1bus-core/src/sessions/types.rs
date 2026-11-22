//! `session/types.ts`: the session store's and turn loop's shared vocabulary (D92 section 2.1, ADR-001, ADR-003).
use crate::approvals::js_json::J;

macro_rules! text_enum {
    ($(#[$m:meta])* $name:ident { $($(#[$vm:meta])* $v:ident = $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[allow(missing_docs)]
        pub enum $name { $($(#[$vm])* $v),+ }
        impl $name {
            /// Every value, in the TypeScript order.
            pub const ALL: &'static [$name] = &[$($name::$v),+];
            /// The stored spelling.
            pub fn as_str(self) -> &'static str { match self { $($name::$v => $s),+ } }
            /// The value of a stored spelling.
            pub fn parse(text: &str) -> Option<Self> { match text { $($s => Some($name::$v),)+ _ => None } }
        }
    };
}

text_enum! {
    /// `SESSION_KINDS`.
    SessionKind { Direct = "direct", Card = "card", Project = "project", Channel = "channel", Acp = "acp" }
}
text_enum! {
    /// `SESSION_ORIGINS`: the external protocol a session came in through (NULL = internal).
    SessionOrigin { Mcp = "mcp", A2a = "a2a", AcpAgent = "acp-agent" }
}
text_enum! {
    /// `MemoryMode`.
    MemoryMode { Remember = "remember", Incognito = "incognito" }
}
text_enum! {
    /// `TurnState`.
    TurnState { Running = "running", Completed = "completed", Failed = "failed" }
}
text_enum! {
    /// `MessageRole`.
    MessageRole { System = "system", User = "user", Assistant = "assistant", Tool = "tool" }
}
text_enum! {
    /// `EVENT_TYPES`: the events a turn emits (the submit/event contract, ADR-010 L2).
    EventType {
        TurnStarted = "turn.started", Delta = "delta", ToolCall = "tool.call", ToolResult = "tool.result",
        TurnCompleted = "turn.completed", TurnFailed = "turn.failed", SessionModelChanged = "session.model.changed",
        DecisionCompleted = "decision.completed", ModelSelected = "model.selected", CompactionPrune = "compaction.prune",
        SkillsSelected = "skills.selected", SessionRewind = "session.rewind", SessionRewindUndone = "session.rewind.undone",
        SessionRewindProposed = "session.rewind.proposed",
    }
}
text_enum! {
    /// `SummaryRecord.state`.
    SummaryState { Prepared = "prepared", Applied = "applied", Superseded = "superseded" }
}
text_enum! {
    /// `RewindRecord.trigger`.
    RewindTrigger { User = "user", Agent = "agent" }
}
text_enum! {
    /// `ArchivedFilter`.
    ArchivedFilter { Exclude = "exclude", Only = "only", Any = "any" }
}

/// `SessionRecord`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionRecord {
    /// The id.
    pub id: String,
    /// I1: immutable.
    pub kind: SessionKind,
    /// I1: immutable.
    pub agent_id: String,
    /// I1: immutable. The user principal hash, derived by the core from the caller.
    pub owner: String,
    /// I1: immutable.
    pub scope: String,
    /// D21: set on `channel` sessions only; at most one active session per chat key. Immutable.
    pub chat_key: Option<String>,
    /// The title.
    pub title: String,
    /// Pinned.
    pub pinned: bool,
    /// The memory mode.
    pub memory_mode: MemoryMode,
    /// Creation instant (ms).
    pub created_at: i64,
    /// Last update (ms).
    pub updated_at: i64,
    /// Last turn start (ms).
    pub last_turn_at: Option<i64>,
    /// Archive instant (ms).
    pub archived_at: Option<i64>,
    /// Turns begun.
    pub turn_count: i64,
    /// I1: immutable external protocol origin; `None` when internal.
    pub origin: Option<SessionOrigin>,
}

/// `TurnRecord`.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnRecord {
    /// The id.
    pub id: String,
    /// The session.
    pub session_id: String,
    /// 1-based turn number.
    pub seq: i64,
    /// The state.
    pub state: TurnState,
    /// Start (ms).
    pub started_at: i64,
    /// End (ms).
    pub ended_at: Option<i64>,
    /// The failure text.
    pub error: Option<String>,
    /// Whether the turn ran incognito.
    pub incognito: bool,
}

/// `MessageRecord`.
#[derive(Clone, Debug, PartialEq)]
pub struct MessageRecord {
    /// The id.
    pub id: String,
    /// The session.
    pub session_id: String,
    /// The turn, or `None` for a harness note.
    pub turn_id: Option<String>,
    /// Per-session sequence.
    pub seq: i64,
    /// The role.
    pub role: MessageRole,
    /// The text.
    pub text: String,
    /// Estimated tokens.
    pub tokens: i64,
    /// Creation instant (ms).
    pub created_at: i64,
}

/// `EventRecord`. `kind` is the stored `type` text: the TypeScript store casts it without checking, so a file from a newer
/// core with a type this build does not know still reads.
#[derive(Clone, Debug, PartialEq)]
pub struct EventRecord {
    /// The session.
    pub session_id: String,
    /// The turn, if the event belongs to one.
    pub turn_id: Option<String>,
    /// Per-session sequence.
    pub seq: i64,
    /// The event type (see [`EventType`]).
    pub kind: String,
    /// The payload: a JSON object, members in the order they were written.
    pub data: J,
    /// Instant (ms).
    pub at: i64,
}

/// `SummaryRecord`.
#[derive(Clone, Debug, PartialEq)]
pub struct SummaryRecord {
    /// The id.
    pub id: String,
    /// The session.
    pub session_id: String,
    /// First covered message seq, inclusive.
    pub from_seq: i64,
    /// Last covered message seq, inclusive.
    pub to_seq: i64,
    /// The summary text.
    pub text: String,
    /// Estimated tokens.
    pub tokens: i64,
    /// Tier 1 summarises messages; tier n+1 summarises tier n summaries (D23 "tiered").
    pub tier: i64,
    /// The state.
    pub state: SummaryState,
    /// Creation instant (ms).
    pub created_at: i64,
}

/// A summary before the store gives it an id and a time (`Omit<SummaryRecord, "id" | "createdAt">`).
#[derive(Clone, Debug, PartialEq)]
pub struct NewSummary {
    /// The session.
    pub session_id: String,
    /// First covered message seq.
    pub from_seq: i64,
    /// Last covered message seq.
    pub to_seq: i64,
    /// The text.
    pub text: String,
    /// Tokens.
    pub tokens: i64,
    /// Tier.
    pub tier: i64,
    /// State.
    pub state: SummaryState,
}

/// `RewindRecord`: the overlay and audit digest persist independently of the immutable transcript.
#[derive(Clone, Debug, PartialEq)]
pub struct RewindRecord {
    /// The id.
    pub id: String,
    /// The session.
    pub session_id: String,
    /// The last message that stays.
    pub parent_seq: i64,
    /// First hidden seq.
    pub hidden_from_seq: i64,
    /// Last hidden seq.
    pub hidden_to_seq: i64,
    /// The lesson message, if any.
    pub lesson_message_id: Option<String>,
    /// SHA-256 of the hidden messages (64 hex characters).
    pub hidden_digest: String,
    /// Who asked.
    pub trigger: RewindTrigger,
    /// The actor.
    pub actor: String,
    /// Creation instant (ms).
    pub created_at: i64,
    /// Undo instant (ms).
    pub undone_at: Option<i64>,
}

/// `SearchHit`.
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    /// The session.
    pub session_id: String,
    /// The message.
    pub message_id: Option<String>,
    /// The message seq.
    pub seq: Option<i64>,
    /// The snippet, hits in `[` `]`.
    pub snippet: String,
    /// The bm25 rank (lower is better).
    pub rank: f64,
    /// Present (true) when the hit lies in a rewound range.
    pub rewound: bool,
}

/// `WorktreeBinding`: CLI-1 metadata only. Every access still checks the live root/grant and, for cards, D115 assignment.
#[derive(Clone, Debug, PartialEq)]
pub struct WorktreeBinding {
    /// The session.
    pub session_id: String,
    /// The worktree root.
    pub root: String,
    /// The project.
    pub project_id: Option<String>,
    /// The card.
    pub card_id: Option<String>,
    /// Who bound it.
    pub created_by: String,
    /// Creation instant (ms).
    pub created_at: i64,
}

/// `StoredCheckpoint`: harness-owned checkpoint identity. A mutable Git ref alone is never proof of its original contents.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredCheckpoint {
    /// The session.
    pub session_id: String,
    /// The turn.
    pub turn_id: String,
    /// The project.
    pub project_id: String,
    /// The card.
    pub card_id: String,
    /// The worktree root.
    pub root: String,
    /// The common git dir.
    pub common_git_dir: String,
    /// The ref.
    pub ref_name: String,
    /// The tree.
    pub tree: String,
    /// The commit.
    pub commit_id: String,
}

/// `CreateSessionInput`.
#[derive(Clone, Debug)]
pub struct CreateSessionInput {
    /// The kind.
    pub kind: SessionKind,
    /// The agent.
    pub agent_id: String,
    /// The owner principal.
    pub owner: String,
    /// I1; default `user`.
    pub scope: Option<String>,
    /// The title (cut to 200 UTF-16 units).
    pub title: Option<String>,
    /// Default `remember`.
    pub memory_mode: Option<MemoryMode>,
    /// Required for, and only allowed on, `channel` sessions (D21).
    pub chat_key: Option<String>,
    /// D21 `/new`: archive the chat's active session and open the next in one transaction.
    pub replace_active: bool,
    /// I1: immutable external protocol origin.
    pub origin: Option<SessionOrigin>,
}

impl CreateSessionInput {
    /// The three required fields; everything else defaulted.
    pub fn new(kind: SessionKind, agent_id: &str, owner: &str) -> Self {
        Self {
            kind,
            agent_id: agent_id.to_owned(),
            owner: owner.to_owned(),
            scope: None,
            title: None,
            memory_mode: None,
            chat_key: None,
            replace_active: false,
            origin: None,
        }
    }
}

/// `ListFilter`.
#[derive(Clone, Debug, Default)]
pub struct ListFilter {
    /// The owner.
    pub owner: String,
    /// Only this kind.
    pub kind: Option<SessionKind>,
    /// Only this agent.
    pub agent_id: Option<String>,
    /// Default `exclude`.
    pub archived: Option<ArchivedFilter>,
    /// Free text for the full-text index.
    pub search: Option<String>,
    /// Page size; default 50, at most 200.
    pub limit: Option<i64>,
}

/// The keyset of a direct-chat page.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatCursor {
    /// `pinned` of the last row of the previous page.
    pub pinned: bool,
    /// `updated_at` of that row.
    pub updated_at: i64,
    /// Its id.
    pub id: String,
}

/// `listChatSessions`' extra filter fields.
#[derive(Clone, Debug, Default)]
pub struct ChatListFilter {
    /// The common filter.
    pub filter: ListFilter,
    /// Only these agents (an empty list is an empty page).
    pub allowed_agents: Vec<String>,
    /// Continue after this row.
    pub after: Option<ChatCursor>,
}

/// One page of sessions.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionPage {
    /// The rows, at most the limit.
    pub sessions: Vec<SessionRecord>,
    /// Whether more rows exist.
    pub truncated: bool,
}

/// `SessionPatch`: the only fields `updateSession` may change; everything else is I1-immutable.
#[derive(Clone, Debug, Default)]
pub struct SessionPatch {
    /// New title.
    pub title: Option<String>,
    /// New pin state.
    pub pinned: Option<bool>,
    /// New memory mode.
    pub memory_mode: Option<MemoryMode>,
}

/// One row of `listOverview`: the session with its model and token usage.
#[derive(Clone, Debug, PartialEq)]
pub struct OverviewRow {
    /// The session.
    pub session: SessionRecord,
    /// The last model (or provider) a completed turn reported.
    pub model: Option<String>,
    /// Summed input tokens of the completed turns.
    pub input_tokens: i64,
    /// Summed output tokens.
    pub output_tokens: i64,
}

/// `listOverview`'s filter: `owner` (one) or `owners` (several), neither for all (the admin RPC's role gate decides).
#[derive(Clone, Debug, Default)]
pub struct OverviewFilter {
    /// The common filter (its `owner` is ignored; see the fields below).
    pub filter: ListFilter,
    /// One owner; empty means "not given".
    pub owner: Option<String>,
    /// Several owners.
    pub owners: Option<Vec<String>>,
}

/// `learningSessions`' filter.
#[derive(Clone, Debug, Default)]
pub struct LearningFilter {
    /// The owner.
    pub owner: String,
    /// Only this agent.
    pub agent_id: Option<String>,
    /// Only this project (`scope`).
    pub project_id: Option<String>,
    /// Window start (ms, inclusive).
    pub from: i64,
    /// Window end (ms, exclusive).
    pub to: i64,
    /// Row limit, clamped to 1..=51.
    pub limit: i64,
    /// Offset.
    pub offset: Option<i64>,
}

/// What `learningToolErrors` projects: trusted metadata only.
#[derive(Clone, Debug, PartialEq)]
pub struct LearningToolError {
    /// The session.
    pub session_id: String,
    /// The turn.
    pub turn_id: String,
    /// Event seq.
    pub seq: i64,
    /// Instant (ms).
    pub at: i64,
    /// `$.learnTool`.
    pub metadata: J,
}

/// `learningTranscript`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct LearningTranscript {
    /// Active messages of the window (caps + 1 at most).
    pub messages: Vec<MessageRecord>,
    /// Events of the window (caps + 1 at most).
    pub events: Vec<EventRecord>,
}

/// `beginTurn`'s options.
#[derive(Clone, Debug, Default)]
pub struct BeginOptions {
    /// Marks the turn as a harness command (`provider: "harness-command"`).
    pub harness_command: bool,
    /// The channel origin object, written as given.
    pub channel_origin: Option<J>,
}

/// What `beginTurn` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct BegunTurn {
    /// The running turn.
    pub turn: TurnRecord,
    /// The user's message.
    pub message: MessageRecord,
    /// The `turn.started` event.
    pub event: EventRecord,
}

/// What `completeTurn` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct CompletedTurn {
    /// The assistant message.
    pub message: MessageRecord,
    /// The `turn.completed` event.
    pub event: EventRecord,
}

/// `listMessages`' options.
#[derive(Clone, Debug, Default)]
pub struct MessageQuery {
    /// Only seq above this.
    pub after_seq: Option<i64>,
    /// Only seq below this.
    pub before_seq: Option<i64>,
    /// Row limit, 1..=100000 (default 10000).
    pub limit: Option<i64>,
    /// `keep: "oldest"`.
    pub keep_oldest: bool,
}

/// `setModelProfile`'s `modelDetails`.
#[derive(Clone, Debug, Default)]
pub struct ModelDetails {
    /// The model.
    pub model: String,
    /// Display name, left out of the event when empty.
    pub display_name: Option<String>,
    /// Effective reasoning, left out of the event when empty.
    pub effective_reasoning: Option<String>,
}

/// `reasoning` of `setModelProfile`: left alone, cleared or set.
#[derive(Clone, Debug, PartialEq)]
pub enum ReasoningChange {
    /// `undefined`: keep the stored choice.
    Keep,
    /// `null`: clear it (provider default).
    Clear,
    /// A new choice.
    Set(String),
}

/// One entry of `setToolVisibilities`.
#[derive(Clone, Debug)]
pub struct VisibilityChange {
    /// The tool-result reference.
    pub reference: String,
    /// Hidden or shown.
    pub hidden: bool,
    /// Why.
    pub reason: String,
    /// The completed turn the pruning belongs to (with `detail`).
    pub turn_id: Option<String>,
    /// Pruning detail.
    pub detail: Option<PruneDetail>,
}

/// `{ mode, confidence, tokensSaved }` of a pruning decision.
#[derive(Clone, Debug, PartialEq)]
pub struct PruneDetail {
    /// `truncate` or `drop`.
    pub truncate: bool,
    /// Confidence.
    pub confidence: f64,
    /// Tokens saved.
    pub tokens_saved: i64,
}

/// One `tool_visibility` row as `toolVisibility` reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolVisibility {
    /// The reference.
    pub reference: String,
    /// Hidden.
    pub hidden: bool,
    /// Why.
    pub reason: String,
    /// `truncate` (the only mode the reader reports; `drop` is the default and absent).
    pub truncate: bool,
}

/// One row of `pruneExplanation`.
#[derive(Clone, Debug, PartialEq)]
pub struct PruneExplanation {
    /// The reference.
    pub reference: String,
    /// Hidden.
    pub hidden: bool,
    /// `drop` or `truncate`.
    pub verdict: String,
    /// Confidence.
    pub confidence: Option<f64>,
    /// Tokens saved.
    pub tokens_saved: i64,
}

/// `pruneMetrics`.
#[derive(Clone, Debug, PartialEq)]
pub struct PruneMetrics {
    /// Rows.
    pub pruned: i64,
    /// Sum of tokens saved.
    pub tokens_saved: i64,
    /// Sum of refetches.
    pub refetches: i64,
    /// `refetches / pruned`, 0 without rows.
    pub refetch_rate: f64,
}

/// `erasures()` rows.
#[derive(Clone, Debug, PartialEq)]
pub struct Erasure {
    /// The tombstone id.
    pub id: String,
    /// The erased session.
    pub session_id: String,
    /// Its owner.
    pub owner: String,
    /// Messages erased.
    pub message_count: i64,
    /// Who erased.
    pub actor: String,
    /// Why.
    pub reason: String,
}

/// `eraseSession`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct Erased {
    /// The tombstone id.
    pub tombstone_id: String,
    /// Messages erased.
    pub messages: i64,
}

/// `rewindProposal` / `proposeRewind`'s payload.
#[derive(Clone, Debug, PartialEq)]
pub struct RewindProposal {
    /// The parent seq.
    pub parent_seq: i64,
    /// Failed edit cycles seen.
    pub failed_cycles: i64,
    /// The seq of the last check.
    pub last_check_seq: i64,
    /// The agent.
    pub agent_id: String,
}

/// `planRewind`'s target: a seq or the newest whole turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RewindTarget {
    /// `"last"`.
    Last,
    /// A message seq.
    Seq(i64),
}

/// What `planRewind` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct RewindPlan {
    /// The last message that stays.
    pub parent_seq: i64,
    /// First hidden seq.
    pub hidden_from_seq: i64,
    /// Last hidden seq.
    pub hidden_to_seq: i64,
    /// The messages of the range.
    pub messages: Vec<MessageRecord>,
    /// The session's last event seq (the revision the commit rechecks).
    pub event_seq: i64,
}

/// An audit line a rewind asks the caller to append before it commits (`RewindAudit`).
#[derive(Clone, Debug, PartialEq)]
pub struct RewindAuditEvent {
    /// `session.rewind` or `session.rewind.undone`.
    pub action: &'static str,
    /// Ids and digests only, never transcript text.
    pub detail: J,
}
