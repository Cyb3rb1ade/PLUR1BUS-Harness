//! Frozen normal-store merge decision over the existing host LLM port.
//! Source access, model-route selection and the write decision belong to the native caller.
use super::{
    conflict_resolution::text,
    dynamics,
    emotion_json::{get, object, string},
    interference::bounded,
};
use crate::{
    contract::{Cancel, EngineError, LlmParams, LlmPort, Message, MessageRole, StoreError},
    text::{
        js::{js_trim, JsString},
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use std::collections::HashMap;
/// Fixed purpose of this adapter; frozen LlmParams carries no dynamic purpose field.
pub const PURPOSE: &str = "merge-decision";
const START: &str = "Two memory fragments — should they be merged into one?\n\nFragment A: ";
const END:&str="\n\nRespond with JSON only: {\"merge\": boolean, \"reason\": \"brief explanation\", \"mergedText\": \"merged version (only if merge=true)\"}\nRules:\n- merge=true only if both fragments describe the same subject/fact from different angles\n- mergedText must contain ALL information from both fragments\n- mergedText must be longer than the shorter of the two fragments";
fn fragment(value: &Json) -> JsString {
    if dynamics::truthy(Some(value)) {
        text(value).utf16_slice(0, 2000)
    } else {
        JsString::from("")
    }
}
/// Exact Node messages, including JavaScript coercion and lossless 2,000-unit cuts.
/// This pure representation is for parity/hash evidence, not outbound malformed text.
pub fn messages(a: &Json, b: &Json, cancel: &Cancel) -> Result<Json, EngineError> {
    let mut budget = (0, 0);
    bounded(a, cancel, &mut budget)?;
    bounded(b, cancel, &mut budget)?;
    let mut units = JsString::from(START).into_utf16_units();
    units.extend_from_slice(fragment(a).as_utf16_units());
    units.extend("\nFragment B: ".encode_utf16());
    units.extend_from_slice(fragment(b).as_utf16_units());
    units.extend(END.encode_utf16());
    cancel.check()?;
    Ok(Json::Array(vec![object([
        ("role", string("user")),
        ("content", Json::String(JsString::from_utf16_units(units))),
    ])]))
}
/// Required boolean merge and string reason; true additionally requires string mergedText.
/// Malformed JSON returns no decision. Unknown fields and internal UTF-16 units are preserved.
pub fn parse_response(response: &str, cancel: &Cancel) -> Result<Option<Json>, EngineError> {
    cancel.check()?;
    if response.len() > 1_048_576 {
        return Err(StoreError::InvalidInput.into());
    }
    let response = js_trim(response);
    if response.is_empty() {
        return Ok(None);
    }
    let Ok(parsed) = parse_json(response) else {
        return Ok(None);
    };
    let parsed = normalize(parsed, cancel, &mut 0)?;
    bounded(&parsed, cancel, &mut (0, 0))?;
    if !matches!(get(&parsed, "merge"), Json::Bool(_))
        || !matches!(get(&parsed, "reason"), Json::String(_))
        || (get(&parsed, "merge") == &Json::Bool(true)
            && !matches!(get(&parsed, "mergedText"), Json::String(_)))
    {
        return Ok(None);
    }
    Ok(Some(parsed))
}
/// One bounded host call, with no temperature override. Missing route returns no decision;
/// provider failure/cancellation stays an error for normal-store's explicit no-merge fallback.
/// No direct provider/credential fallback or result cache is introduced here.
pub fn check(
    port: Option<&dyn LlmPort>,
    a: &Json,
    b: &Json,
    model: Option<&str>,
    cancel: &Cancel,
) -> Result<Option<Json>, EngineError> {
    cancel.check()?;
    let Some(port) = port else {
        return Ok(None);
    };
    let raw = messages(a, b, cancel)?;
    let Json::Array(rows) = raw else {
        return Err(StoreError::Corrupt.into());
    };
    let Json::String(content) = get(&rows[0], "content") else {
        return Err(StoreError::Corrupt.into());
    };
    let model = model.map(js_trim).filter(|v| !v.is_empty());
    if model.is_some_and(|v| v.len() > 4096) {
        return Err(StoreError::InvalidInput.into());
    }
    let cancel = cancel.limited_to(std::time::Instant::now() + std::time::Duration::from_secs(30));
    let response = port.complete(
        LlmParams {
            messages: vec![Message {
                role: MessageRole::User,
                content: super::output_unicode::external(content),
            }],
            model: model.map(str::to_owned),
            temperature: None,
            max_tokens: Some(300.into()),
        },
        &cancel,
    );
    cancel.check()?;
    parse_response(&response?.text, &cancel)
}
fn index(key: &JsString) -> Option<u32> {
    let text = String::from_utf16(key.as_utf16_units()).ok()?;
    let index = text.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == text).then_some(index)
}
// JSON.parse uses last duplicate value in first insertion position; integer keys enumerate first.
fn normalize(value: Json, cancel: &Cancel, nodes: &mut usize) -> Result<Json, EngineError> {
    cancel.check()?;
    *nodes += 1;
    if *nodes > 50_000 {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(match value {
        Json::Object(values) => {
            let mut positions = HashMap::new();
            let mut fields: Vec<(JsString, Json)> = Vec::new();
            for (k, v) in values {
                let v = normalize(v, cancel, nodes)?;
                if let Some(&i) = positions.get(&k) {
                    fields[i] = (k, v);
                } else {
                    positions.insert(k.clone(), fields.len());
                    fields.push((k, v));
                }
            }
            fields.sort_by_key(|(k, _)| index(k).map_or((1, 0), |i| (0, i)));
            Json::Object(fields)
        }
        Json::Array(values) => Json::Array(
            values
                .into_iter()
                .map(|v| normalize(v, cancel, nodes))
                .collect::<Result<_, _>>()?,
        ),
        Json::Number(value) => {
            let n = value.parse::<f64>().map_err(|_| StoreError::InvalidInput)?;
            if n.is_finite() {
                Json::Number(ryu_js::Buffer::new().format(n).into())
            } else {
                Json::Null
            }
        }
        other => other,
    })
}
