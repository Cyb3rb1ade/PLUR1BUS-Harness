//! Critical classification and source eligibility only; confirmation and push delivery are separate.
use super::{
    dynamics,
    emotion_json::{get, numeric},
    output_unicode::external,
};
use crate::{
    contract::{Cancel, EngineError, LlmParams, LlmPort, Message, MessageRole, StoreError},
    text::{
        js::{js_to_lower_case, js_trim, JsString},
        json::TolerantJsonValue as Json,
    },
};
use std::sync::OnceLock;

/// The pin's exact critical type vocabulary. `fakt` is its noncritical fallback.
pub const TYPES: [&str; 6] = [
    "person",
    "beziehung",
    "geburtstag",
    "geld_konto",
    "gesundheit",
    "zugang_passwort",
];
/// Source-role decision; an assistant classification never becomes user evidence.
#[must_use]
pub fn source_role(card: &Json) -> &'static str {
    let role = js_to_lower_case(&dynamics::js_string(get(card, "sourceMessageRole")));
    match role.as_str() {
        "user" => return "user",
        "assistant" | "agent" => return "assistant",
        _ => {}
    }
    let origin = js_to_lower_case(&dynamics::js_string(get(card, "origin")));
    if matches!(origin.as_str(), "correction" | "correct" | "edit") {
        "correction"
    } else {
        "unknown"
    }
}
/// Whether the row describes assistant-generated content.
#[must_use]
pub fn is_assistant(card: &Json) -> bool {
    source_role(card) == "assistant"
}
/// Explicit importance survives the assistant-source suppression policy.
#[must_use]
pub fn explicit_importance(card: &Json) -> bool {
    let never = get(card, "neverForget");
    if *never == Json::Bool(true) || numeric(never) == Some(1.) {
        return true;
    }
    ["importance", "coreMemoryScore"].iter().any(|key| {
        let value = dynamics::number(Some(get(card, key)));
        value.is_finite() && value >= 0.9
    })
}
/// Dreams must be excluded by the classifier's caller independently of highlight eligibility.
#[must_use]
pub fn is_dream(card: &Json) -> bool {
    ["origin", "memoryClass"]
        .iter()
        .any(|key| matches!(get(card,key),Json::String(v) if v==&JsString::from("dream")))
}
/// Pinned highlight eligibility; this does not grant read access or send a notification.
#[must_use]
pub fn eligible(card: &Json) -> bool {
    !is_assistant(card) || explicit_importance(card)
}
/// Exact trimmed/lowercased reply, with unknown explanations and code fences falling back.
#[must_use]
pub fn parse_type(response: &str) -> &'static str {
    let raw = js_to_lower_case(js_trim(response));
    TYPES
        .into_iter()
        .find(|kind| *kind == raw)
        .unwrap_or("fakt")
}
fn prompt(content: &str) -> Result<String, EngineError> {
    static PARTS: OnceLock<Option<(String, String)>> = OnceLock::new();
    let parts = PARTS
        .get_or_init(|| {
            let value: serde_json::Value =
                serde_json::from_str(include_str!("critical-data.json")).ok()?;
            Some((
                value["promptPrefix"].as_str()?.into(),
                value["promptSuffix"].as_str()?.into(),
            ))
        })
        .as_ref()
        .ok_or(StoreError::Corrupt)?;
    Ok(format!(
        "{}{}{}",
        parts.0,
        external(&JsString::from(content)),
        parts.1
    ))
}
/// One explicit call through an already bound host model port. No timer, scheduling,
/// confirmation write or direct provider access. The native caller owns feature routing.
pub fn classify(
    content: &str,
    port: Option<&dyn LlmPort>,
    cancel: &Cancel,
) -> Result<&'static str, EngineError> {
    cancel.check()?;
    let Some(port) = port.filter(|_| !content.is_empty()) else {
        return Ok("fakt");
    };
    classify_with_limit(content, port, None, cancel)
}

/// Run the same recorded classifier with the limit set by a calling feature.
pub(crate) fn classify_with_limit(
    content: &str,
    port: &dyn LlmPort,
    max_tokens: Option<u32>,
    cancel: &Cancel,
) -> Result<&'static str, EngineError> {
    cancel.check()?;
    if content.is_empty() {
        return Ok("fakt");
    }
    let response = port.complete(
        LlmParams {
            messages: vec![Message {
                role: MessageRole::User,
                content: prompt(content)?,
            }],
            model: None,
            temperature: None,
            max_tokens: max_tokens.map(Into::into),
        },
        cancel,
    );
    cancel.check()?;
    Ok(parse_type(&response?.text))
}
