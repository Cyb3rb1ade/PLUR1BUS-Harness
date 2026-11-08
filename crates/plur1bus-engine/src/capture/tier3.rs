//! Host-owned emotion completion: exact pinned messages, bounded diagnostics and local fallbacks.
use super::{
    emotion_json::{data, get, invalid, num, object, string, text},
    emotion_score::EmotionScore,
};
use crate::{
    contract::{Cancel, EngineError, HostError, LlmParams, LlmPort, Message, MessageRole},
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};

/// Build Node's injected-completion messages; model/routing policy belongs to the host.
pub fn params(input: &JsString) -> Result<LlmParams, EngineError> {
    Ok(LlmParams {
        messages: vec![
            Message {
                role: MessageRole::System,
                content: text(get(data()?, "tier3SystemPrompt")).ok_or_else(invalid)?,
            },
            Message {
                role: MessageRole::User,
                content: super::output_unicode::external(input),
            },
        ],
        model: None,
        temperature: None,
        max_tokens: None,
    })
}

pub(super) fn neutral(source: &str, tier: u8, now: i64) -> Result<EmotionScore, EngineError> {
    EmotionScore::from_props(
        &object([
            ("valence", num(0.)),
            ("arousal", num(0.)),
            ("dominance", num(0.)),
            ("intensity", num(0.)),
            ("primary_emotion", string("neutral")),
            ("secondary_emotion", Json::Null),
            ("emotion_labels", object([("neutral", num(1.))])),
            ("language", string("unknown")),
            ("source", string(source)),
            ("tier_used", num(f64::from(tier))),
            ("confidence", num(0.)),
        ]),
        now,
    )
}
fn fallback(
    local: Option<&EmotionScore>,
    source: &str,
    now: i64,
) -> Result<EmotionScore, EngineError> {
    local.cloned().map_or_else(|| neutral(source, 3, now), Ok)
}
fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(value) => *value,
        Json::String(value) => !value.is_empty(),
        Json::Number(value) => value.parse::<f64>().is_ok_and(|v| v != 0. && !v.is_nan()),
        _ => true,
    }
}
pub(super) fn classify(
    port: &dyn LlmPort,
    input: &JsString,
    source: &str,
    local: Option<&EmotionScore>,
    clock: &(dyn Fn() -> i64 + Send + Sync),
    cancel: &Cancel,
) -> Result<EmotionScore, EngineError> {
    cancel.check()?;
    let response = match port.complete(params(input)?, cancel) {
        Ok(result) => result.text,
        Err(_) => return fallback(local, source, clock()),
    };
    cancel.check()?;
    let now = clock();
    let slice = match (response.find('{'), response.rfind('}')) {
        (Some(start), Some(end)) if start <= end => &response[start..=end],
        _ => &response,
    };
    let parsed = match parse_json(slice) {
        Ok(value) => value,
        Err(_) => {
            return local
                .cloned()
                .map(Ok)
                .unwrap_or(Err(HostError::InvalidResponse.into()))
        }
    };
    if parsed == Json::Null {
        return fallback(local, source, now);
    }
    let nullish = |name: &str, default: Json| {
        let v = get(&parsed, name);
        if v == &Json::Null {
            default
        } else {
            v.clone()
        }
    };
    let or = |name: &str, default: Json| {
        let v = get(&parsed, name);
        if truthy(v) {
            v.clone()
        } else {
            default
        }
    };
    let props = object([
        ("valence", nullish("valence", num(0.))),
        ("arousal", nullish("arousal", num(0.))),
        ("dominance", nullish("dominance", num(0.))),
        ("intensity", nullish("intensity", num(0.))),
        ("primary_emotion", or("primary_emotion", string("neutral"))),
        ("secondary_emotion", or("secondary_emotion", Json::Null)),
        (
            "emotion_labels",
            or("emotion_labels", object(Vec::<(String, Json)>::new())),
        ),
        ("language", or("language", string("unknown"))),
        ("source", string(source)),
        ("tier_used", num(3.)),
        ("confidence", nullish("confidence", num(0.8))),
    ]);
    EmotionScore::from_props(&props, now).or_else(|_| fallback(local, source, now))
}
