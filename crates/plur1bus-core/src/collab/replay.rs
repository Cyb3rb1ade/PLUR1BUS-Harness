//! A session transcript as exposed by the collaboration service.
use super::store::R;
use serde_json::{json, Value};

/// The ownership fields checked before reading a session transcript.
pub struct SessionBinding {
    /// The session id.
    pub id: String,
    /// The stored owner.
    pub owner: String,
    /// The stored project scope.
    pub scope: String,
}

/// Trusted read access to the session store. The port is called after trace authorization.
pub trait ReplaySessions {
    /// The session's immutable binding.
    fn session(&self, id: &str) -> R<Option<SessionBinding>>;
    /// The bounded page of events in session order.
    fn events(&self, id: &str) -> R<Vec<Value>>;
    /// The bounded page of messages in session order.
    fn messages(&self, id: &str) -> R<Vec<Value>>;
}

/// Redacted session transcript linked to a collaboration span.
pub struct ReplayTranscript {
    /// Bound session.
    pub session_id: String,
    /// Authorized trace.
    pub trace_id: String,
    /// Authorized span.
    pub span_id: String,
    /// Redacted messages.
    pub messages: Vec<Value>,
    /// Redacted events.
    pub events: Vec<Value>,
}

impl ReplayTranscript {
    /// The TypeScript replay answer.
    pub fn to_value(&self) -> Value {
        json!({ "sessionId": self.session_id, "traceId": self.trace_id, "spanId": self.span_id,
            "messages": self.messages, "events": self.events })
    }
}

use super::errors::{CollabError, CollabErrorCode as C};
use super::ports::RedactionPort;
use crate::sessions::store::SessionStore;
use crate::sessions::{MessageQuery, SessionError};

fn unreadable(_: SessionError) -> CollabError {
    CollabError::new(C::Storage, "delegation transcript could not be read")
}

impl ReplaySessions for SessionStore {
    fn session(&self, id: &str) -> R<Option<SessionBinding>> {
        Ok(self
            .get_session(id)
            .map_err(unreadable)?
            .map(|s| SessionBinding {
                id: s.id,
                owner: s.owner,
                scope: s.scope,
            }))
    }

    fn events(&self, id: &str) -> R<Vec<Value>> {
        Ok(self.list_events(id, 0, 500).map_err(unreadable)?.into_iter().map(|e| {
            json!({ "sessionId": e.session_id, "turnId": e.turn_id, "seq": e.seq, "type": e.kind,
                "data": e.data.to_value(), "at": e.at })
        }).collect())
    }

    fn messages(&self, id: &str) -> R<Vec<Value>> {
        Ok(self.list_messages(id, &MessageQuery::default()).map_err(unreadable)?.into_iter().map(|m| {
            json!({ "id": m.id, "sessionId": m.session_id, "turnId": m.turn_id, "seq": m.seq,
                "role": m.role.as_str(), "text": m.text, "tokens": m.tokens, "createdAt": m.created_at })
        }).collect())
    }
}

pub(super) fn redacted_rows(rows: Vec<Value>, redactor: &dyn RedactionPort) -> R<Vec<Value>> {
    match redactor.value(&Value::Array(rows)) {
        Value::Array(rows) => Ok(rows),
        _ => Err(CollabError::new(
            C::Storage,
            "delegation transcript redaction failed",
        )),
    }
}

pub(super) fn restore_provenance(
    events: &[Value],
    redacted: &mut [Value],
    trace_id: &str,
    span_id: &str,
) {
    for (original, projected) in events.iter().zip(redacted) {
        let Some(source) = original
            .pointer("/data/provenance")
            .and_then(Value::as_object)
        else {
            continue;
        };
        let Some(target) = projected
            .pointer_mut("/data/provenance")
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        for (key, authorized) in [("traceId", trace_id), ("spanId", span_id)] {
            if source.get(key).and_then(Value::as_str) == Some(authorized) {
                if let Some(value) = target.get_mut(key) {
                    *value = json!(authorized);
                }
            }
        }
    }
}

use crate::approvals::js_json::J;
use crate::sessions::compaction::estimate_tokens;
use crate::sessions::{BeginOptions, CreateSessionInput, EventType, SessionKind};
use std::sync::{Mutex, MutexGuard};

/// The local session and turn created for a delegate.
#[derive(Clone)]
pub struct RecordedTurn {
    /// Session id attached to the span.
    pub session_id: String,
    /// Running turn in that session.
    pub turn_id: String,
}

/// Redacted inputs for a new local transcript.
pub struct RecordStart<'a> {
    /// Project to which the transcript is bound.
    pub project_id: &'a str,
    /// Source of the delegation.
    pub from_agent: &'a str,
    /// Agent that runs the turn.
    pub to_agent: &'a str,
    /// Redacted prompt.
    pub prompt: &'a str,
}

/// Redacted terminal outcome written to the session.
pub struct RecordEnd<'a> {
    /// Final tool-result event, if a report was available.
    pub entry: Option<Value>,
    /// Turn terminal data with the trace and span ids.
    pub data: &'a Value,
    /// Redacted final response.
    pub text: &'a str,
    /// Count of output tokens.
    pub tokens: i64,
    /// Terminal error, including a deadline's partial result.
    pub error: Option<&'a str>,
}

/// The collaboration library's session-writing boundary. Local runs may opt into transcript recording.
pub trait RunTranscripts: ReplaySessions + Send + Sync {
    /// Create the project session and record the beginning of its turn.
    fn begin(&self, input: RecordStart<'_>) -> R<RecordedTurn>;
    /// Append an untrusted, redacted result event.
    fn append(&self, turn: &RecordedTurn, data: Value) -> R<()>;
    /// Record the result and close the turn.
    fn end(&self, turn: &RecordedTurn, outcome: RecordEnd<'_>) -> R<()>;
}

/// Adapter over the session store. A host owns and supplies the store.
pub struct SessionRecorder(pub Mutex<SessionStore>);

impl SessionRecorder {
    fn locked(&self) -> R<MutexGuard<'_, SessionStore>> {
        self.0
            .lock()
            .map_err(|_| CollabError::new(C::Storage, "delegation transcript is unavailable"))
    }
}

impl ReplaySessions for SessionRecorder {
    fn session(&self, id: &str) -> R<Option<SessionBinding>> {
        self.locked()?.session(id)
    }

    fn events(&self, id: &str) -> R<Vec<Value>> {
        self.locked()?.events(id)
    }

    fn messages(&self, id: &str) -> R<Vec<Value>> {
        self.locked()?.messages(id)
    }
}

impl RunTranscripts for SessionRecorder {
    fn begin(&self, input: RecordStart<'_>) -> R<RecordedTurn> {
        let mut store = self.locked()?;
        let mut create = CreateSessionInput::new(
            SessionKind::Project,
            input.to_agent,
            &format!("collab-project:{}", input.project_id),
        );
        create.scope = Some(input.project_id.to_owned());
        create.title = Some(format!(
            "Delegation {} → {}",
            input.from_agent, input.to_agent
        ));
        let session = store.create_session(&create).map_err(unreadable)?;
        let turn = store
            .begin_turn(
                &session.id,
                input.prompt,
                estimate_tokens(input.prompt),
                &BeginOptions::default(),
            )
            .map_err(unreadable)?
            .turn;
        Ok(RecordedTurn {
            session_id: session.id,
            turn_id: turn.id,
        })
    }

    fn append(&self, turn: &RecordedTurn, data: Value) -> R<()> {
        self.locked()?
            .append_event(&turn.turn_id, EventType::ToolResult, J::from_value(&data))
            .map_err(unreadable)?;
        Ok(())
    }

    fn end(&self, turn: &RecordedTurn, outcome: RecordEnd<'_>) -> R<()> {
        let mut store = self.locked()?;
        let entry = outcome.entry.map(|entry| {
            store.append_event(&turn.turn_id, EventType::ToolResult, J::from_value(&entry))
        });
        let data = J::from_value(outcome.data);
        // Close the turn even if appending the last report failed.
        if let Some(error) = outcome.error {
            store
                .fail_turn(&turn.turn_id, error, Some(&data))
                .map_err(unreadable)?;
        } else {
            store
                .complete_turn(&turn.turn_id, outcome.text, outcome.tokens, Some(&data))
                .map_err(unreadable)?;
        }
        entry.transpose().map_err(unreadable)?;
        Ok(())
    }
}
