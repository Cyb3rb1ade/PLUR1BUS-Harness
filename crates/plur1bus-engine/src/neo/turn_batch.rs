//! C4 batch selection for the frozen role/content-only Message contract.
//!
//! KNOWN-GAP F12: Message has no tool provenance or per-message timestamp. Tools therefore
//! follow Node's missing-metadata exclusion, and accepted messages use the explicit batch time.
//! Pure projections carry no principal authority; persistence must bind and narrow them separately.
use std::collections::HashMap;

use super::turns::{normalize_statement, stable_turn_id, Role, TurnBuilder, TurnInput};
use crate::{
    capture::epistemic::is_injected_context,
    contract::{Cancel, EngineError, Message, MessageRole, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};

/// Host-selected batch identity and explicit fallback time. No message metadata is inferred.
pub struct BatchOptions<'a> {
    /// Actual workspace key, with Node's empty-string default applied in the constructor.
    pub workspace_key: &'a JsString,
    /// Actual capturing agent.
    pub agent_id: &'a JsString,
    /// Stable conversation identity; empty falls back to the current session label.
    pub session_key: &'a JsString,
    /// Current run label, separate from stable identity when session_key is present.
    pub session_id: &'a JsString,
    /// Display position; a nonfinite value starts at zero, as in Node.
    pub start_turn_index: f64,
    /// Required fallback timestamp for the contract's messages without timestamps.
    pub created_at: &'a JsString,
}

/// Select actual conversation messages, maintain duplicate ordinals and reply links, and construct
/// turns. Cancellation never returns a partial batch. Tools without metadata and injected context
/// cannot advance display positions, duplicate ordinals or the previous-assistant reference.
pub fn from_messages(
    builder: &TurnBuilder,
    messages: &[Message],
    options: &BatchOptions<'_>,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    from_messages_since(builder, messages, options, 0, cancel)
}

/// Normalize the full authenticated history, then select turns after the raw-message watermark.
/// Prefix messages still establish duplicate ordinals, assistant reply links and display positions,
/// so episodes refer to the exact full-journal identities (RE-D63). A watermark beyond the shorter
/// history resets to zero, matching S2 compaction handling; no checkpoint is advanced here.
pub fn from_messages_since(
    builder: &TurnBuilder,
    messages: &[Message],
    options: &BatchOptions<'_>,
    raw_message_start: usize,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    cancel.check()?;
    let start = if raw_message_start > messages.len() {
        0
    } else {
        raw_message_start
    };
    if options.created_at.is_empty() {
        return Err(StoreError::InvalidInput.into());
    }
    let identity = if options.session_key.is_empty() {
        options.session_id
    } else {
        options.session_key
    };
    let mut index = if options.start_turn_index.is_finite() {
        options.start_turn_index
    } else {
        0.
    };
    let mut ordinals: HashMap<JsString, u32> = HashMap::new();
    let mut previous_assistant = None;
    let mut events = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        cancel.check()?;
        let role = match message.role {
            MessageRole::User => Role::User,
            MessageRole::Assistant => Role::Assistant,
            MessageRole::System | MessageRole::Tool => continue,
        };
        let content = JsString::from(message.content.as_str());
        // The actual source checks raw UTF-16 length before createTurnEvent trims whitespace.
        if content.as_utf16_units().len() < 2 || is_injected_context(&content)? {
            continue;
        }
        let statement = normalize_statement(&content);
        let mut key = role.as_str().encode_utf16().collect::<Vec<_>>();
        key.push(u16::from(b'\n'));
        key.extend(statement.as_utf16_units());
        key.push(u16::from(b'\n')); // Empty sourceToolCallIds in the existing Message contract.
        let ordinal = ordinals.entry(JsString::from_utf16_units(key)).or_default();
        let id = stable_turn_id(
            options.workspace_key,
            options.agent_id,
            identity,
            role,
            &content,
            &[],
            *ordinal,
        );
        *ordinal = ordinal.checked_add(1).ok_or(StoreError::InvalidInput)?;
        let replies: Vec<JsString> = if role == Role::User {
            previous_assistant.iter().cloned().collect()
        } else {
            Vec::new()
        };
        let scope = JsString::from(if role == Role::Assistant {
            "agent_private"
        } else {
            "workspace_shared"
        });
        let event = builder.build(&TurnInput {
            id: &id,
            workspace_key: options.workspace_key,
            agent_id: options.agent_id,
            session_id: options.session_id,
            turn_index: index,
            role,
            content: &content,
            scope: &scope,
            source_tool_call_ids: &[],
            replies_to_turn_ids: &replies,
            created_at: options.created_at,
        })?;
        if role == Role::Assistant {
            previous_assistant = Some(id);
        }
        if message_index >= start {
            events.push(event);
        }
        index += 1.;
    }
    cancel.check()?;
    Ok(events)
}
