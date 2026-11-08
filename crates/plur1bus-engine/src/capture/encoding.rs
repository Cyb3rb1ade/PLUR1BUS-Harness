//! Frozen encoding prompts and judgments. No model access occurs outside the supplied host port.
use super::{
    dynamics,
    emotion_json::{clamp01, data, entries, get, invalid, num, numeric, object, string, text},
    emotion_legacy::{self, DIMENSIONS},
    fact_quality::AUTOMATIC_IMPORTANCE_MAX,
    output_unicode::external,
};
use crate::{
    contract::{Cancel, EngineError, LlmParams, LlmPort, Message, MessageRole},
    text::{
        js::{js_to_lower_case, JsString},
        json::{parse_json, TolerantJsonValue as Json},
    },
};
/// Node's prompt budget in UTF-16 units, including its trailing-high-surrogate repair.
pub const PROMPT_TEXT_MAX: usize = 2000;
/// Pure lossless reference projection; the host boundary additionally drops unpaired units (F3).
#[must_use]
pub fn truncate_for_prompt(text: &JsString, max: usize) -> JsString {
    let units = text.as_utf16_units();
    let mut end = units.len().min(max);
    if end > 0 && (0xd800..=0xdbff).contains(&units[end - 1]) {
        end -= 1;
    }
    text.utf16_slice(0, end)
}
/// Exact pinned messages for well-formed text; provider/model selection remains host-owned.
pub fn params(input: &JsString) -> Result<LlmParams, EngineError> {
    let constants = data()?;
    let prefix = text(get(constants, "encodingPromptPrefix")).ok_or_else(invalid)?;
    Ok(LlmParams {
        messages: vec![
            Message {
                role: MessageRole::System,
                content: text(get(constants, "encodingSystemPrompt")).ok_or_else(invalid)?,
            },
            Message {
                role: MessageRole::User,
                content: format!(
                    "{prefix}{}",
                    external(&truncate_for_prompt(input, PROMPT_TEXT_MAX))
                ),
            },
        ],
        model: None,
        temperature: None,
        max_tokens: None,
    })
}
fn failure(call: bool) -> Json {
    let mut fields = vec![("ok", Json::Bool(false))];
    if call {
        fields.push(("callFailed", Json::Bool(true)));
    }
    object(fields)
}
/// Parse actual model text without inventing importance. Raw reason slices retain Node UTF-16 for parity.
#[must_use]
pub fn parse_response(raw: &str) -> Json {
    let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}')) else {
        return failure(false);
    };
    if end < start {
        return failure(false);
    }
    let Ok(value) = parse_json(&raw[start..=end]) else {
        return failure(false);
    };
    let Some(importance) = numeric(get(&value, "importance")).filter(|v| v.is_finite()) else {
        return failure(false);
    };
    let intensity = numeric(get(&value, "intensity"))
        .filter(|v| v.is_finite())
        .map(clamp01)
        .unwrap_or(0.);
    let dominant = js_to_lower_case(&dynamics::js_string(get(&value, "dominant")));
    let dominant = if DIMENSIONS.contains(&dominant.as_str()) {
        dominant.as_str()
    } else {
        "neutral"
    };
    let mut emotion = vec![
        ("emotionalDominant", string(dominant)),
        ("emotionalIntensity", num(intensity)),
    ];
    for dim in DIMENSIONS {
        let v = numeric(get(get(&value, "emotions"), dim))
            .filter(|v| v.is_finite())
            .map(clamp01)
            .unwrap_or(0.);
        emotion.push((dim, num(if dim == dominant { v.max(intensity) } else { v })));
    }
    let reason = if let Json::String(v) = get(&value, "reason") {
        v.utf16_slice(0, 200)
    } else {
        JsString::from("")
    };
    object([
        ("ok", Json::Bool(true)),
        (
            "importance",
            num(importance.clamp(0., AUTOMATIC_IMPORTANCE_MAX)),
        ),
        ("emotion", object(emotion)),
        ("reason", Json::String(reason)),
    ])
}
/// One caller-bound completion. Distinguish route failure from an unusable but received judgment.
/// Cancellation is an error and never becomes an ordinary unresolved result.
pub fn classify(
    input: &JsString,
    port: Option<&dyn LlmPort>,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    cancel.check()?;
    let Some(port) = port else {
        return Ok(failure(true));
    };
    let answer = port.complete(params(input)?, cancel);
    cancel.check()?;
    let answer = match answer {
        Ok(v) if !v.text.is_empty() => v.text,
        _ => return Ok(failure(true)),
    };
    let parsed = parse_response(&answer);
    Ok(external_reason(&parsed))
}
fn external_reason(value: &Json) -> Json {
    object(entries(value).into_iter().map(|(key, value)| {
        let value = if key == "reason" {
            if let Json::String(ref s) = value {
                string(&external(s))
            } else {
                value
            }
        } else {
            value
        };
        (key, value)
    }))
}
/// Deterministic storage patch. Manual agent-band importance and rollback evidence are untouched.
/// This performs no writes and schedules no RE-06 background work.
#[must_use]
pub fn refine_patch(
    row: &Json,
    encoding: &Json,
    now: i64,
    flashbulb_enabled: bool,
) -> Option<Json> {
    if !dynamics::truthy(Some(get(encoding, "ok"))) {
        return None;
    }
    let emotion = get(encoding, "emotion");
    let intensity = dynamics::number(Some(get(emotion, "emotionalIntensity")));
    let intensity = if intensity.is_nan() { 0. } else { intensity };
    let importance = get(encoding, "importance");
    let flash = if flashbulb_enabled {
        dynamics::apply_flashbulb_encoding(
            &object([
                ("emotionalIntensity", num(intensity)),
                ("importance", importance.clone()),
            ]),
            now as f64,
            dynamics::FLASHBULB_THRESHOLD,
            dynamics::resolve_half_life_from_encoding(importance, false),
            dynamics::FLASHBULB_HALF_LIFE_DAYS,
        )
    } else {
        None
    };
    let agent_band = dynamics::number(Some(get(row, "importance"))) >= dynamics::AGENT_BAND_MIN;
    let dominant = get(emotion, "emotionalDominant");
    let mut patch = vec![
        ("importanceStatus", string("final")),
        ("emotionStatus", string("final")),
        (
            "emotionalValence",
            string(&emotion_legacy::serialize(emotion)),
        ),
        ("emotionalIntensity", num(intensity)),
        (
            "emotionalDominant",
            if dynamics::truthy(Some(dominant)) {
                dominant.clone()
            } else {
                string("neutral")
            },
        ),
    ];
    if !agent_band {
        let reason = get(encoding, "reason");
        let reason = if !dynamics::truthy(Some(reason)) {
            JsString::from("")
        } else if let Json::String(s) = reason {
            s.clone()
        } else {
            JsString::from(dynamics::js_string(reason).as_str())
        };
        patch.extend([
            ("importance", importance.clone()),
            (
                "halfLifeDays",
                flash.as_ref().map_or_else(
                    || num(dynamics::resolve_half_life_from_encoding(importance, false)),
                    |v| get(v, "halfLifeDays").clone(),
                ),
            ),
            (
                "coreMemoryReason",
                string(&external(&reason.utf16_slice(0, 200))),
            ),
        ]);
    }
    if let Some(flash) = flash.filter(|_| !agent_band) {
        let strength = dynamics::number(Some(get(row, "memoryStrength")));
        let strength = if strength.is_nan() { 0. } else { strength };
        patch.extend([
            (
                "memoryStrength",
                num(strength.max(dynamics::number(Some(get(&flash, "memoryStrength"))))),
            ),
            ("lastStrengthenedAt", num(now as f64)),
            ("lastDynamicsAt", num(now as f64)),
            ("memoryClass", string("flashbulb")),
        ]);
    }
    Some(object(patch))
}
