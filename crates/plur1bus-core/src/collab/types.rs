//! `collab/types.ts`: the records the collaboration library stores and returns, and the event vocabulary.
//!
//! Status and role fields are kept as the text the store holds: TypeScript casts a stored column to its union without
//! checking it (`status: t.status as SpanStatus`), so a value this code did not write is passed on as it is. Where this code
//! writes one, it writes one of the constants below.
use crate::approvals::js_json::{num_value, J};
use serde_json::{Map, Value};

/// `ProjectRole` values `addMember` accepts.
pub const PROJECT_ROLES: [&str; 4] = ["member", "lead", "worker", "reviewer"];

/// `TaskStatus` values.
pub mod task_status {
    /// `queued`
    pub const QUEUED: &str = "queued";
    /// `running`
    pub const RUNNING: &str = "running";
    /// `succeeded`
    pub const SUCCEEDED: &str = "succeeded";
    /// `failed`
    pub const FAILED: &str = "failed";
    /// `cancelled`
    pub const CANCELLED: &str = "cancelled";
}

/// `SpanStatus` values.
pub mod span_status {
    /// `partial`
    pub const PARTIAL: &str = "partial";
    /// `running`
    pub const RUNNING: &str = "running";
    /// `succeeded`
    pub const SUCCEEDED: &str = "succeeded";
    /// `failed`
    pub const FAILED: &str = "failed";
    /// `cancelled`
    pub const CANCELLED: &str = "cancelled";
    /// `refused`
    pub const REFUSED: &str = "refused";
}

/// `AgentState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentState {
    /// `active`
    Active,
    /// `paused`
    Paused,
    /// `archived`
    Archived,
}

/// `Provenance["targetKind"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    /// `local`
    Local,
    /// `external`
    External,
    /// `a2a`
    A2a,
}

impl TargetKind {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::External => "external",
            Self::A2a => "a2a",
        }
    }

    /// The kind a stored column names (`None` for anything else, which TypeScript would pass on unchecked).
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "local" => Some(Self::Local),
            "external" => Some(Self::External),
            "a2a" => Some(Self::A2a),
            _ => None,
        }
    }
}

/// `CollabSettings`: what `project.*` shows and what the guardrails read. The two counts that the TypeScript code floors are
/// whole numbers; `repeatWindowMs` and `tokenBudget` keep a fraction (`resolveCollabLimits` does not floor them).
#[derive(Clone, Debug, PartialEq)]
pub struct CollabSettings {
    /// Read-only hops after the root agent (default 2); writers stay at depth 1.
    pub max_depth: i64,
    /// Read helper starts per calling turn (default 8).
    pub max_fanout: i64,
    /// Consult starts per (from, to) pair per calling turn (default 4).
    pub max_pair_per_turn: i64,
    /// Rounds of a consult.
    pub max_turns: i64,
    /// Wall time of a consult.
    pub timeout_ms: i64,
    /// Delegate return cap in tokens.
    pub return_tokens: i64,
    /// Whether an agent outside the project may be called.
    pub allow_cross_project: bool,
    /// The window in which the same question to the same agent is refused.
    pub repeat_window_ms: f64,
    /// The chain's token cap; `None` is none.
    pub token_budget: Option<f64>,
    /// The stored `collaboration` object, passed through as it is (the team policy).
    pub collaboration: Option<J>,
}

impl CollabSettings {
    /// The JSON shape `project.*` shows.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("maxDepth".into(), Value::from(self.max_depth));
        m.insert("maxFanout".into(), Value::from(self.max_fanout));
        m.insert("maxPairPerTurn".into(), Value::from(self.max_pair_per_turn));
        m.insert("maxTurns".into(), Value::from(self.max_turns));
        m.insert("timeoutMs".into(), Value::from(self.timeout_ms));
        m.insert("returnTokens".into(), Value::from(self.return_tokens));
        m.insert(
            "allowCrossProject".into(),
            Value::Bool(self.allow_cross_project),
        );
        m.insert("repeatWindowMs".into(), num_value(self.repeat_window_ms));
        m.insert(
            "tokenBudget".into(),
            self.token_budget.map_or(Value::Null, num_value),
        );
        if let Some(c) = &self.collaboration {
            m.insert("collaboration".into(), c.to_value());
        }
        Value::Object(m)
    }
}

/// `ProjectMember`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectMember {
    /// The person.
    pub user_id: String,
    /// The role as stored.
    pub role: String,
}

/// `RepoBinding`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoBinding {
    /// The repository.
    pub repo_path: String,
    /// The base branch.
    pub base_branch: String,
}

/// `Project`.
#[derive(Clone, Debug, PartialEq)]
pub struct Project {
    /// The id.
    pub id: String,
    /// The name.
    pub name: String,
    /// The owner (always a lead).
    pub owner: String,
    /// The members, by user id.
    pub members: Vec<ProjectMember>,
    /// The agents, by id.
    pub agents: Vec<String>,
    /// The resolved settings.
    pub settings: CollabSettings,
    /// Creation instant.
    pub created_at: i64,
    /// Last change.
    pub updated_at: i64,
    /// When it was archived.
    pub archived_at: Option<i64>,
    /// The repository binding; absent until `project.repo.bind`.
    pub repo: Option<RepoBinding>,
}

impl Project {
    /// The JSON shape of the TypeScript record.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(self.id.clone()));
        m.insert("name".into(), Value::String(self.name.clone()));
        m.insert("owner".into(), Value::String(self.owner.clone()));
        m.insert(
            "members".into(),
            Value::Array(
                self.members
                    .iter()
                    .map(|x| {
                        let mut o = Map::new();
                        o.insert("userId".into(), Value::String(x.user_id.clone()));
                        o.insert("role".into(), Value::String(x.role.clone()));
                        Value::Object(o)
                    })
                    .collect(),
            ),
        );
        m.insert(
            "agents".into(),
            Value::Array(self.agents.iter().cloned().map(Value::String).collect()),
        );
        m.insert("settings".into(), self.settings.to_value());
        m.insert("createdAt".into(), Value::from(self.created_at));
        m.insert("updatedAt".into(), Value::from(self.updated_at));
        m.insert(
            "archivedAt".into(),
            self.archived_at.map_or(Value::Null, Value::from),
        );
        if let Some(r) = &self.repo {
            let mut o = Map::new();
            o.insert("repoPath".into(), Value::String(r.repo_path.clone()));
            o.insert("baseBranch".into(), Value::String(r.base_branch.clone()));
            m.insert("repo".into(), Value::Object(o));
        }
        Value::Object(m)
    }
}

/// Token cost of a hop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Cost {
    /// Input tokens.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
}

/// `Provenance`: where an answer came from.
#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    /// The answering agent.
    pub agent_id: String,
    /// The project.
    pub project_id: String,
    /// The trace.
    pub trace_id: String,
    /// The span.
    pub span_id: String,
    /// When the answer was assembled.
    pub at: i64,
    /// The cost.
    pub cost: Cost,
    /// `a2a` when the answer came over A2A.
    pub origin_a2a: bool,
    /// The kind of the target.
    pub target_kind: TargetKind,
}

impl Provenance {
    /// The JSON shape.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("agentId".into(), Value::String(self.agent_id.clone()));
        m.insert("projectId".into(), Value::String(self.project_id.clone()));
        m.insert("traceId".into(), Value::String(self.trace_id.clone()));
        m.insert("spanId".into(), Value::String(self.span_id.clone()));
        m.insert("at".into(), Value::from(self.at));
        m.insert(
            "cost".into(),
            serde_json::json!({"inputTokens": self.cost.input_tokens, "outputTokens": self.cost.output_tokens}),
        );
        if self.origin_a2a {
            m.insert("origin".into(), Value::String("a2a".into()));
        }
        m.insert(
            "targetKind".into(),
            Value::String(self.target_kind.as_str().into()),
        );
        Value::Object(m)
    }
}

/// `ConsultAnswer`.
#[derive(Clone, Debug, PartialEq)]
pub struct ConsultAnswer {
    /// `done` or `partial`.
    pub status: &'static str,
    /// The answer text.
    pub text: String,
    /// Where it came from.
    pub provenance: Provenance,
    /// The agents on the path, root first.
    pub path: Vec<String>,
    /// The trace.
    pub trace_id: String,
}

impl ConsultAnswer {
    /// The JSON shape.
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "status": self.status, "kind": "consult.answer", "text": self.text,
            "provenance": self.provenance.to_value(), "path": self.path, "traceId": self.trace_id,
        })
    }
}

/// `DelegateTask`.
#[derive(Clone, Debug, PartialEq)]
pub struct DelegateTask {
    /// `a2a` when it ran over A2A.
    pub origin_a2a: bool,
    /// The target kind, when the run reported one.
    pub target_kind: Option<String>,
    /// The id.
    pub id: String,
    /// The project.
    pub project_id: String,
    /// The trace.
    pub trace_id: String,
    /// The span.
    pub span_id: String,
    /// The parent task.
    pub parent_task_id: Option<String>,
    /// The delegating agent.
    pub from_agent: String,
    /// The receiving agent.
    pub to_agent: String,
    /// The status as stored.
    pub status: String,
    /// The task text.
    pub task: String,
    /// The acceptance criteria.
    pub acceptance_criteria: String,
    /// The capped result.
    pub result: Option<String>,
    /// Whether the result was cut (the marker names the artifact).
    pub truncated: bool,
    /// The artifact holding the full result.
    pub artifact_id: Option<String>,
    /// `artifact:<id>` when there is one.
    pub artifact_pointer: Option<String>,
    /// The error text.
    pub error: Option<String>,
    /// The agents on the path.
    pub path: Vec<String>,
    /// Creation instant.
    pub created_at: i64,
    /// Start instant.
    pub started_at: Option<i64>,
    /// End instant.
    pub ended_at: Option<i64>,
    /// Token usage, when the run reported one.
    pub usage: Option<Cost>,
}

impl DelegateTask {
    /// The JSON shape.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        if self.origin_a2a {
            m.insert("origin".into(), Value::String("a2a".into()));
        }
        if let Some(k) = &self.target_kind {
            m.insert("targetKind".into(), Value::String(k.clone()));
        }
        let s = |x: &str| Value::String(x.to_owned());
        let os = |x: &Option<String>| x.as_ref().map_or(Value::Null, |v| Value::String(v.clone()));
        let on = |x: Option<i64>| x.map_or(Value::Null, Value::from);
        m.insert("id".into(), s(&self.id));
        m.insert("projectId".into(), s(&self.project_id));
        m.insert("traceId".into(), s(&self.trace_id));
        m.insert("spanId".into(), s(&self.span_id));
        m.insert("parentTaskId".into(), os(&self.parent_task_id));
        m.insert("fromAgent".into(), s(&self.from_agent));
        m.insert("toAgent".into(), s(&self.to_agent));
        m.insert("status".into(), s(&self.status));
        m.insert("task".into(), s(&self.task));
        m.insert("acceptanceCriteria".into(), s(&self.acceptance_criteria));
        m.insert("result".into(), os(&self.result));
        m.insert("truncated".into(), Value::Bool(self.truncated));
        m.insert("artifactId".into(), os(&self.artifact_id));
        m.insert("artifactPointer".into(), os(&self.artifact_pointer));
        m.insert("error".into(), os(&self.error));
        m.insert(
            "path".into(),
            Value::Array(self.path.iter().cloned().map(Value::String).collect()),
        );
        m.insert("createdAt".into(), Value::from(self.created_at));
        m.insert("startedAt".into(), on(self.started_at));
        m.insert("endedAt".into(), on(self.ended_at));
        m.insert(
            "usage".into(),
            self.usage.map_or(Value::Null, |u| {
                serde_json::json!({"inputTokens": u.input_tokens, "outputTokens": u.output_tokens})
            }),
        );
        Value::Object(m)
    }
}

/// `CollabSpan`.
#[derive(Clone, Debug, PartialEq)]
pub struct CollabSpan {
    /// `a2a` when it ran over A2A.
    pub origin_a2a: bool,
    /// The target kind, as stored.
    pub target_kind: Option<String>,
    /// The session holding the transcript.
    pub session_id: Option<String>,
    /// The span id.
    pub span_id: String,
    /// The trace id.
    pub trace_id: String,
    /// The parent span.
    pub parent_span_id: Option<String>,
    /// The agent that ran.
    pub agent_id: String,
    /// `consult`, `delegate` or `guardrail`.
    pub kind: String,
    /// Start instant.
    pub started_at: i64,
    /// End instant.
    pub ended_at: Option<i64>,
    /// The status as stored.
    pub status: String,
    /// Input tokens.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
    /// A masked, capped preview of the input.
    pub input_preview: String,
    /// A masked, capped preview of the output.
    pub output_preview: String,
    /// The error text.
    pub error: Option<String>,
    /// The guardrail reason text, as stored.
    pub guardrail: Option<String>,
}

impl CollabSpan {
    /// The JSON shape.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        if self.origin_a2a {
            m.insert("origin".into(), Value::String("a2a".into()));
        }
        if let Some(k) = &self.target_kind {
            m.insert("targetKind".into(), Value::String(k.clone()));
        }
        if let Some(k) = &self.session_id {
            m.insert("sessionId".into(), Value::String(k.clone()));
        }
        let os = |x: &Option<String>| x.as_ref().map_or(Value::Null, |v| Value::String(v.clone()));
        m.insert("spanId".into(), Value::String(self.span_id.clone()));
        m.insert("traceId".into(), Value::String(self.trace_id.clone()));
        m.insert("parentSpanId".into(), os(&self.parent_span_id));
        m.insert("agentId".into(), Value::String(self.agent_id.clone()));
        m.insert("kind".into(), Value::String(self.kind.clone()));
        m.insert("startedAt".into(), Value::from(self.started_at));
        m.insert(
            "endedAt".into(),
            self.ended_at.map_or(Value::Null, Value::from),
        );
        m.insert("status".into(), Value::String(self.status.clone()));
        m.insert("inputTokens".into(), Value::from(self.input_tokens));
        m.insert("outputTokens".into(), Value::from(self.output_tokens));
        m.insert(
            "inputPreview".into(),
            Value::String(self.input_preview.clone()),
        );
        m.insert(
            "outputPreview".into(),
            Value::String(self.output_preview.clone()),
        );
        m.insert("error".into(), os(&self.error));
        m.insert("guardrail".into(), os(&self.guardrail));
        Value::Object(m)
    }
}

/// `CollabTrace`.
#[derive(Clone, Debug, PartialEq)]
pub struct CollabTrace {
    /// The trace id.
    pub trace_id: String,
    /// The W3C `traceparent` of the root span.
    pub traceparent: String,
    /// The project.
    pub project_id: String,
    /// The root agent.
    pub root_agent: String,
    /// The root span.
    pub root_span_id: String,
    /// Creation instant.
    pub created_at: i64,
    /// End instant.
    pub ended_at: Option<i64>,
    /// The status as stored.
    pub status: String,
    /// The spans, oldest first.
    pub spans: Vec<CollabSpan>,
}

impl CollabTrace {
    /// The JSON shape.
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "traceId": self.trace_id, "traceparent": self.traceparent, "projectId": self.project_id,
            "rootAgent": self.root_agent, "rootSpanId": self.root_span_id, "createdAt": self.created_at,
            "endedAt": self.ended_at, "status": self.status,
            "spans": self.spans.iter().map(CollabSpan::to_value).collect::<Vec<_>>(),
        })
    }
}

/// `COLLAB_EVENT_TYPES`.
pub const COLLAB_EVENT_TYPES: [&str; 32] = [
    "project.created",
    "project.archived",
    "project.member.added",
    "project.member.removed",
    "project.agent.added",
    "project.agent.removed",
    "consult.started",
    "consult.finished",
    "delegate.queued",
    "delegate.started",
    "delegate.finished",
    "delegate.cancelled",
    "guardrail.refused",
    "chain.abandoned",
    "team.created",
    "team.composition.confirmed",
    "team.plan.proposed",
    "team.plan.approved",
    "team.scope.extended",
    "team.state.changed",
    "team.budget.warning",
    "team.capacity.warning",
    "section.state.changed",
    "section.summary",
    "section.merged",
    "package.created",
    "package.state.changed",
    "package.needs-decision",
    "package.round.finished",
    "package.synced",
    "package.merged",
    "message.posted",
];

/// `CollabEvent`: what the emitter port hears. `data` is a JSON object.
#[derive(Clone, Debug, PartialEq)]
pub struct CollabEvent {
    /// One of [`COLLAB_EVENT_TYPES`].
    pub kind: &'static str,
    /// When it happened.
    pub at: i64,
    /// The project.
    pub project_id: String,
    /// The trace, when there is one.
    pub trace_id: Option<String>,
    /// The agent, when there is one.
    pub agent_id: Option<String>,
    /// The payload.
    pub data: Value,
}

impl CollabEvent {
    /// The JSON shape.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("type".into(), Value::String(self.kind.into()));
        m.insert("at".into(), Value::from(self.at));
        m.insert("projectId".into(), Value::String(self.project_id.clone()));
        if let Some(t) = &self.trace_id {
            m.insert("traceId".into(), Value::String(t.clone()));
        }
        if let Some(t) = &self.agent_id {
            m.insert("agentId".into(), Value::String(t.clone()));
        }
        m.insert("data".into(), self.data.clone());
        Value::Object(m)
    }
}
