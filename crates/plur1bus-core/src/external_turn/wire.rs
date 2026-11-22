//! Existing closed session and turn wire projections for scoped external reads.

use super::{Error, Message};
use crate::sessions::{EventRecord, MessageRecord, MessageRole, SessionRecord};
use serde_json::{json, Map, Value};

const EVENT_BYTES: usize = 256 * 1024;

pub(super) fn session(row: &SessionRecord) -> Value {
    json!({"id":row.id,"kind":row.kind.as_str(),"agentId":row.agent_id,"scope":row.scope,"chatKey":row.chat_key,
        "title":row.title,"pinned":row.pinned,"memoryMode":row.memory_mode.as_str(),"createdAt":row.created_at,
        "updatedAt":row.updated_at,"lastTurnAt":row.last_turn_at,"archivedAt":row.archived_at,"turnCount":row.turn_count})
}

pub(super) fn message(row: &MessageRecord) -> Option<Value> {
    if !matches!(row.role, MessageRole::User | MessageRole::Assistant) {
        return None;
    }
    Some(
        json!({"id":row.id,"seq":row.seq,"turnId":row.turn_id,"role":row.role.as_str(),"text":row.text,"createdAt":row.created_at}),
    )
}

pub(super) fn history(row: MessageRecord, lesson: bool) -> Option<Message> {
    let role = if lesson {
        "user"
    } else {
        match row.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            _ => return None,
        }
    };
    Some(Message {
        role,
        text: row.text,
        turn_id: row.turn_id,
    })
}

pub(super) fn event(row: &EventRecord) -> Result<Option<Value>, Error> {
    let fields: &[&str] = match row.kind.as_str() {
        "turn.started" => &["turnId", "turnSeq", "messageId"],
        "delta" => &["index", "text"],
        "turn.completed" => &["turnId", "messageId", "usage"],
        "turn.failed" => &["turnId", "error"],
        "session.rewind" => &[
            "actor",
            "hiddenDigest",
            "hiddenFrom",
            "hiddenTo",
            "lessonMessageId",
            "parentSeq",
            "rewindId",
            "sessionId",
            "trigger",
        ],
        _ => return Ok(None),
    };
    let data = row.data.stringify();
    if data.len() > EVENT_BYTES {
        return Err(Error::new("E_STORAGE", "external-event-bound"));
    }
    let src: Map<String, Value> =
        serde_json::from_str(&data).map_err(|_| Error::new("E_STORAGE", "external-event-shape"))?;
    let data: Map<_, _> = fields
        .iter()
        .filter_map(|field| {
            src.get(*field)
                .map(|value| ((*field).to_string(), value.clone()))
        })
        .collect();
    Ok(Some(
        json!({"sessionId":row.session_id,"seq":row.seq,"turnId":row.turn_id,"type":row.kind,"data":data,"at":row.at}),
    ))
}
