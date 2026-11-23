//! JSON-RPC and SSE projections for A2A protocol 0.3.
use plur1bus_providers::Json;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Submitted,
    Working,
    InputRequired,
    AuthRequired,
    Completed,
    Failed,
    Canceled,
    Rejected,
}

impl State {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::Working => "working",
            Self::InputRequired => "input-required",
            Self::AuthRequired => "auth-required",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::Rejected => "rejected",
        }
    }

    pub const fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Canceled | Self::Rejected
        )
    }
}

#[derive(Clone, Copy)]
pub struct TaskRef<'a> {
    pub id: &'a str,
    pub context_id: &'a str,
}

pub(crate) fn object(fields: impl IntoIterator<Item = (&'static str, Json)>) -> Json {
    let mut result = Json::object();
    for (key, value) in fields {
        result.set(key, value);
    }
    result
}

pub(crate) fn envelope(id: &Json, key: &'static str, value: Json) -> Json {
    object([("jsonrpc", "2.0".into()), ("id", id.clone()), (key, value)])
}

fn task_status(state: State, timestamp: &str, message: Option<Json>) -> Json {
    let mut status = object([
        ("state", state.code().into()),
        ("timestamp", timestamp.into()),
    ]);
    if let Some(message) = message {
        status.set("message", message);
    }
    status
}

pub fn task(task: TaskRef<'_>, state: State, timestamp: &str) -> Json {
    object([
        ("kind", "task".into()),
        ("id", task.id.into()),
        ("contextId", task.context_id.into()),
        ("status", task_status(state, timestamp, None)),
    ])
}

#[derive(Clone, Copy)]
pub enum Role {
    User,
    Agent,
}

pub fn message(task: TaskRef<'_>, role: Role, id: &str, parts: Vec<Json>) -> Json {
    object([
        ("kind", "message".into()),
        (
            "role",
            match role {
                Role::User => "user",
                Role::Agent => "agent",
            }
            .into(),
        ),
        ("messageId", id.into()),
        ("parts", parts.into()),
        ("contextId", task.context_id.into()),
        ("taskId", task.id.into()),
    ])
}

pub fn text_part(text: &str) -> Json {
    object([("kind", "text".into()), ("text", text.into())])
}

pub fn reply_artifact(id: &str, name: &str, parts: Vec<Json>) -> Json {
    object([
        ("artifactId", id.into()),
        ("name", name.into()),
        ("parts", parts.into()),
    ])
}

pub fn status(
    task: TaskRef<'_>,
    state: State,
    timestamp: &str,
    message: Option<Json>,
    final_event: bool,
) -> Json {
    let mut value = object([
        ("kind", "status-update".into()),
        ("taskId", task.id.into()),
        ("contextId", task.context_id.into()),
        ("status", task_status(state, timestamp, message)),
    ]);
    if final_event {
        value.set("final", true);
    }
    value
}

pub fn artifact(
    task: TaskRef<'_>,
    artifact_id: &str,
    name: &str,
    text: &str,
    append: bool,
    last_chunk: bool,
) -> Json {
    object([
        ("kind", "artifact-update".into()),
        ("taskId", task.id.into()),
        ("contextId", task.context_id.into()),
        (
            "artifact",
            reply_artifact(artifact_id, name, vec![text_part(text)]),
        ),
        ("append", append.into()),
        ("lastChunk", last_chunk.into()),
    ])
}

pub fn sse(id: &Json, result: Json) -> String {
    format!("data: {}\n\n", envelope(id, "result", result).encode())
}
