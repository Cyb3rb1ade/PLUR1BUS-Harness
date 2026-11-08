//! Request-local narrative enrichment of already authorized episode sources.
//! The composition owns provider routing, current policy and durable publication.
use super::{
    derived_fields::{set, text, validate_object},
    merged_order::{field, string, truthy},
};
use crate::{
    capture::fact_quality::matching::{replace_pattern, trim},
    contract::{Cancel, EngineError, LlmParams, LlmPort, Message, MessageRole, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
#[path = "narrative_result.rs"]
mod result;

/// Preserve Node's newest-turn budget and conservative response projection. This function
/// grants no source authority and performs no writes or detached work. Hosts must authorize
/// sources and the selected provider before entry and revalidate before publishing its result.
pub fn enrich(
    episode: &Json,
    turns: &[Json],
    names: Option<(&JsString, &JsString)>,
    port: Option<&dyn LlmPort>,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    cancel.check()?;
    validate_object(episode)?;
    if turns.len() > 512 {
        return Err(StoreError::InvalidInput.into());
    }
    bounded(episode, turns)?;
    if turns.len() < 2 {
        let mut out = episode.clone();
        let arc = field(episode, "narrativeArc")
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or_else(|| text("exploration"));
        set(&mut out, "narrativeArc", arc)?;
        return Ok(out);
    }
    let Some(port) = port else {
        return Ok(episode.clone());
    };
    let user = JsString::from("Nutzer");
    let assistant = field(episode, "agentId")
        .filter(|v| truthy(v))
        .map(string)
        .unwrap_or_else(|| JsString::from("Agent"));
    let (user, assistant) = names.unwrap_or((&user, &assistant));
    let user = utf8(user)?;
    let assistant = utf8(assistant)?;
    if user.len() > 4096 || assistant.len() > 4096 {
        return Err(StoreError::InvalidInput.into());
    }
    let mut budget = 6000;
    let mut lines = Vec::new();
    for turn in turns.iter().rev() {
        cancel.check()?;
        if field(turn, "role") == Some(&text("tool")) {
            continue;
        }
        let raw = field(turn, "content")
            .filter(|v| truthy(v))
            .map(string)
            .unwrap_or_default();
        utf8(&raw)?; // Refuse malformed original content before a UTF-8 cleaning/provider boundary.
        let cleaned = super::episode_text::clean(&raw)?;
        let cleaned = trim(&replace_pattern(r"\s+", "g", &cleaned, " ")?);
        let cut = cleaned.utf16_slice(0, 600);
        if cut.is_empty() {
            continue;
        }
        let speaker = if field(turn, "role") == Some(&text("user")) {
            &user
        } else {
            &assistant
        };
        // Budget uses the original UTF-16 cut, even if the external display boundary drops
        // its final half-pair. No budget is reclaimed to add a different older turn.
        let size = speaker.encode_utf16().count() + 3 + cut.utf16_len();
        if size > budget {
            break;
        }
        budget -= size;
        lines.push(format!(
            "[{speaker}] {}",
            utf8(&display_cut(&cleaned, 600))?
        ));
    }
    if lines.is_empty() {
        return Ok(episode.clone());
    }
    lines.reverse();
    let voices = voices(episode);
    let labels = voices
        .iter()
        .map(|v| {
            if *v == Json::Null {
                Ok(String::new())
            } else {
                utf8(&string(v))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let voice = if labels.is_empty() {
        String::new()
    } else {
        format!("\nPer Stimme erkannte Mitsprecher (haben selbst gesprochen, zählen NICHT als „people\"): {}.",labels.join(", "))
    };
    let session = lines.join("\n");
    let prompt = format!(
        include_str!("episode-narrative-prompt.txt"),
        user = user,
        assistant = assistant,
        voice = voice,
        session = session
    );
    if prompt.encode_utf16().count() > 65_536 {
        return Err(StoreError::InvalidInput.into());
    }
    cancel.check()?;
    let response = port.complete(
        LlmParams {
            messages: vec![Message {
                role: MessageRole::User,
                content: prompt,
            }],
            model: None,
            temperature: Some(0.into()),
            max_tokens: Some(500.into()),
        },
        cancel,
    );
    cancel.check()?;
    let Ok(response) = response else {
        return Ok(episode.clone());
    };
    if response.text.len() > 64 * 1024 {
        return Ok(episode.clone());
    }
    let Some(parsed) = result::parse(&response.text) else {
        return Ok(episode.clone());
    };
    let names = (JsString::from(user), JsString::from(assistant));
    let out = result::apply(episode, &parsed, turns, (&names.0, &names.1))?;
    cancel.check()?;
    Ok(out)
}
pub(super) fn voices(episode: &Json) -> &[Json] {
    match field(episode, "voiceSpeakers") {
        Some(Json::Array(v)) => v,
        _ => &[],
    }
}
pub(super) fn utf8(value: &JsString) -> Result<String, EngineError> {
    char::decode_utf16(value.as_utf16_units().iter().copied())
        .collect::<Result<String, _>>()
        .map_err(|_| StoreError::InvalidInput.into())
}
pub(super) fn display_cut(value: &JsString, max: usize) -> JsString {
    let mut units = value.utf16_slice(0, max).into_utf16_units();
    if units.last().is_some_and(|v| (0xd800..=0xdbff).contains(v)) {
        units.pop();
    }
    JsString::from_utf16_units(units)
}
fn bounded(episode: &Json, turns: &[Json]) -> Result<(), EngineError> {
    let mut pending = vec![(episode, 0)];
    pending.extend(turns.iter().map(|v| (v, 0)));
    let mut nodes = 0;
    let mut units = 0;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if nodes > 50_000 || depth > 128 {
            return Err(StoreError::InvalidInput.into());
        }
        match value {
            Json::String(v) => units += v.utf16_len(),
            Json::Number(v) => units += v.len(),
            Json::Array(v) => pending.extend(v.iter().map(|v| (v, depth + 1))),
            Json::Object(v) => {
                for (k, v) in v {
                    units += k.utf16_len();
                    pending.push((v, depth + 1));
                }
            }
            _ => {}
        }
        if units > 1_048_576 || pending.len() > 50_000 {
            return Err(StoreError::InvalidInput.into());
        }
    }
    Ok(())
}
