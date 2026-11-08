//! Pinned capture text selection and provenance, before summarization and chunking.

use std::collections::HashSet;

use crate::contract::{EngineError, MessageRole, TurnRecord};
use crate::text::js::{is_js_whitespace, js_regex, JsString};

use super::super::epistemic::is_injected_context;

#[derive(Clone)]
pub(super) struct CaptureItem {
    pub(super) text: JsString,
    pub(super) role: String,
    pub(super) is_user_url: bool,
    pub(super) source_url: JsString,
}

fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

fn extract_url(text: &JsString) -> JsString {
    let units = text.as_utf16_units();
    for start in 0..units.len() {
        let tail = &units[start..];
        let prefix = if tail.starts_with(&[104, 116, 116, 112, 58, 47, 47]) {
            7
        } else if tail.starts_with(&[104, 116, 116, 112, 115, 58, 47, 47]) {
            8
        } else {
            continue;
        };
        let suffix = tail[prefix..]
            .iter()
            .take_while(|unit| !whitespace(**unit))
            .count();
        if suffix >= 10 {
            return text.utf16_slice(start, start + (prefix + suffix).min(500));
        }
    }
    JsString::default()
}

fn strip_media_leading(text: &str) -> &str {
    let prefix = "<!-- media-output-id: ";
    let Some(head) = text.get(..prefix.len()) else {
        return text;
    };
    if !head.eq_ignore_ascii_case(prefix) {
        return text;
    }
    let rest = &text[prefix.len()..];
    let id_length = rest
        .bytes()
        .take_while(|byte| byte.is_ascii_hexdigit() || *byte == b'-')
        .count();
    if id_length == 0 || !rest[id_length..].starts_with(" -->") {
        return text;
    }
    let tail = &rest[id_length + " -->".len()..];
    tail.strip_prefix('\n').unwrap_or(tail)
}

pub(super) fn select_items(turn: &TurnRecord) -> Result<Vec<CaptureItem>, EngineError> {
    let mut items = Vec::new();
    for message in &turn.messages {
        if !matches!(message.role, MessageRole::User | MessageRole::Assistant)
            || message.content.encode_utf16().count() <= 20
        {
            continue;
        }
        let original = JsString::from(message.content.as_str());
        let source_url = if message.role == MessageRole::User {
            extract_url(&original)
        } else {
            JsString::default()
        };
        let text = JsString::from(strip_media_leading(&message.content));
        if is_injected_context(&text)? {
            continue;
        }
        items.push(CaptureItem {
            text,
            role: message.role.to_string(),
            is_user_url: !source_url.is_empty(),
            source_url,
        });
    }
    let user_urls = items
        .iter()
        .filter(|item| item.is_user_url)
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    for item in user_urls
        .into_iter()
        .skip(
            items
                .iter()
                .filter(|item| item.is_user_url)
                .count()
                .saturating_sub(3),
        )
        .chain(items.iter().skip(items.len().saturating_sub(5)))
    {
        if seen.insert(item.text.clone()) {
            selected.push(item.clone());
        }
        if selected.len() >= 8 {
            break;
        }
    }
    Ok(selected)
}

pub(super) fn capture_origin(
    turn: &TurnRecord,
    items: &[CaptureItem],
) -> Result<&'static str, EngineError> {
    if turn
        .session_key
        .as_deref()
        .is_some_and(|key| key.contains(":group:") || key.contains(":channel:"))
    {
        return Ok("group");
    }
    let structured_group = js_regex(
        r#""is_group_chat"\s*:\s*true|"group_subject"\s*:|"group_channel"\s*:"#,
        "",
    )
    .map_err(|_| EngineError::NotAvailable {
        reason: "capture-origin-pattern".into(),
    })?;
    for item in items {
        let text = item.text.to_utf8_lossy();
        let lower = text.to_lowercase();
        if structured_group
            .is_match(&text)
            .map_err(|_| EngineError::NotAvailable {
                reason: "capture-origin-pattern".into(),
            })?
            || lower.contains("guild #")
            || lower.contains("[discord guild ")
        {
            return Ok("group");
        }
    }
    Ok("dm")
}
