//! C4 batch selection with an additive native metadata input.
//!
//! The frozen role/content contract still uses the fallback time and excludes tool results.
//! Pure projections carry no principal authority; persistence must bind and narrow them separately.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::turns::{normalize_statement, stable_turn_id, Role, TurnBuilder, TurnInput};
use crate::{
    capture::epistemic::is_injected_context,
    contract::{Cancel, EngineError, Message, MessageRole, StoreError},
    recall::render_date::iso_timestamp,
    text::{
        js::{is_js_whitespace, js_trim, JsString},
        json::TolerantJsonValue as Json,
    },
};

/// Optional source metadata supplied by the authenticated host, aligned with its messages.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MessageMetadata {
    /// Source timestamp in epoch milliseconds. An omitted value uses the batch time.
    #[serde(rename = "timestamp", default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
    /// Tool name from the dispatched call, if present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Whether the host observed a tool failure.
    #[serde(default)]
    pub is_error: bool,
    /// Tool invocation identity from the dispatch record, if present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Keep validation shared by wire admission and retained-record replay.
pub(crate) fn valid_metadata(messages: &[Message], items: &[MessageMetadata]) -> bool {
    items.len() == messages.len()
        && items.len() <= 256
        && messages.iter().zip(items).all(|(message, item)| {
            item.timestamp_ms
                .is_none_or(|time| time.unsigned_abs() <= 8_640_000_000_000_000)
                && [&item.tool_name, &item.tool_call_id].iter().all(|text| {
                    text.as_ref()
                        .is_none_or(|text| !text.is_empty() && text.chars().count() <= 256)
                })
                && (message.role == MessageRole::Tool
                    || (item.tool_name.is_none() && item.tool_call_id.is_none() && !item.is_error))
        })
}

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
    from_host_messages_since(builder, messages, None, options, raw_message_start, cancel)
}

/// Project authenticated host metadata through the same replay-ID and watermark calculation.
/// When supplied, metadata has exactly one entry per raw message, including filtered messages.
pub fn from_host_messages_since(
    builder: &TurnBuilder,
    messages: &[Message],
    metadata: Option<&[MessageMetadata]>,
    options: &BatchOptions<'_>,
    raw_message_start: usize,
    cancel: &Cancel,
) -> Result<Vec<Json>, EngineError> {
    cancel.check()?;
    if metadata.is_some_and(|items| items.len() != messages.len()) {
        return Err(StoreError::InvalidInput.into());
    }
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
        let metadata = metadata.and_then(|items| items.get(message_index));
        let role = match message.role {
            MessageRole::User => Role::User,
            MessageRole::Assistant => Role::Assistant,
            MessageRole::Tool if metadata.is_some_and(memorable_tool) => Role::Tool,
            MessageRole::System | MessageRole::Tool => continue,
        };
        let content = JsString::from(message.content.as_str());
        let content = if role == Role::Tool {
            truncate_tool(&content)
        } else {
            content
        };
        // The actual source checks raw UTF-16 length before createTurnEvent trims whitespace.
        if content.as_utf16_units().len() < 2 || is_injected_context(&content)? {
            continue;
        }
        let statement = normalize_statement(&content);
        let mut key = role.as_str().encode_utf16().collect::<Vec<_>>();
        key.push(u16::from(b'\n'));
        key.extend(statement.as_utf16_units());
        key.push(u16::from(b'\n'));
        let tool_ids = metadata
            .and_then(|item| item.tool_call_id.as_deref())
            .filter(|id| !id.is_empty())
            .map(JsString::from);
        let tool_ids = tool_ids.as_slice();
        if let Some(id) = tool_ids.first() {
            key.extend(id.as_utf16_units());
        }
        let ordinal = ordinals.entry(JsString::from_utf16_units(key)).or_default();
        let id = stable_turn_id(
            options.workspace_key,
            options.agent_id,
            identity,
            role,
            &content,
            tool_ids,
            *ordinal,
        );
        *ordinal = ordinal.checked_add(1).ok_or(StoreError::InvalidInput)?;
        let replies: Vec<JsString> = if role != Role::Assistant {
            previous_assistant.iter().cloned().collect()
        } else {
            Vec::new()
        };
        let scope = JsString::from(if role == Role::User {
            "workspace_shared"
        } else {
            "agent_private"
        });
        let timestamp = metadata
            .and_then(|item| item.timestamp_ms)
            .map(|ms| iso_timestamp(ms as f64).map(|iso| JsString::from(iso.as_str())))
            .transpose()
            .map_err(|_| StoreError::InvalidInput)?;
        let event = builder.build(&TurnInput {
            id: &id,
            workspace_key: options.workspace_key,
            agent_id: options.agent_id,
            session_id: options.session_id,
            turn_index: index,
            role,
            content: &content,
            scope: &scope,
            source_tool_call_ids: tool_ids,
            replies_to_turn_ids: &replies,
            created_at: timestamp.as_ref().unwrap_or(options.created_at),
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

fn memorable_tool(metadata: &MessageMetadata) -> bool {
    if metadata.is_error {
        return true;
    }
    let Some(name) = metadata
        .tool_name
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    !matches!(
        name.as_str(),
        "bash"
            | "exec"
            | "exec_command"
            | "local_shell"
            | "shell"
            | "read"
            | "write"
            | "edit"
            | "apply_patch"
    ) && !name
        .strip_prefix("str_replace")
        .is_some_and(|tail| tail.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
}

fn truncate_tool(content: &JsString) -> JsString {
    const MAX_TOOL_RESULT: usize = 5_000;
    let units = content.as_utf16_units();
    if units.len() <= MAX_TOOL_RESULT {
        return content.clone();
    }
    let end = units[..MAX_TOOL_RESULT]
        .iter()
        .rposition(|unit| !char::from_u32(u32::from(*unit)).is_some_and(is_js_whitespace))
        .map_or(0, |i| i + 1);
    let mut prefix = units[..end].to_vec();
    prefix.extend(
        format!(
            "\n[… gekürzt, {} Zeichen ausgelassen]",
            units.len() - MAX_TOOL_RESULT
        )
        .encode_utf16(),
    );
    JsString::from_utf16_units(prefix)
}
