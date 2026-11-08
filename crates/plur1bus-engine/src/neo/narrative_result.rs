//! Frozen response acceptance and display projection; model output never grants authority.
use super::{display_cut, utf8, voices};
use crate::{
    capture::{
        dynamics::{json_number, number},
        fact_quality::matching::{lower, replace_pattern, trim},
    },
    contract::EngineError,
    neo::{
        derived_fields::{object, set, text},
        episode_emotion::DIMS,
        merged_order::{field, string, truthy},
    },
    text::{
        js::{js_trim, JsString},
        json::{parse_json, TolerantJsonValue as Json},
    },
};
pub(super) fn parse(response: &str) -> Option<Json> {
    let text = js_trim(response);
    if text.is_empty() {
        return None;
    }
    let mut text = text;
    if let Some(rest) = text.strip_prefix("```") {
        text = if rest
            .get(..4)
            .is_some_and(|v| v.eq_ignore_ascii_case("json"))
        {
            &rest[4..]
        } else {
            rest
        };
        text = crate::text::js::js_trim_start(text);
    }
    if let Some(rest) = text.strip_suffix("```") {
        text = crate::text::js::js_trim_end(rest);
    }
    let text = js_trim(text);
    let parse = |text: &str| {
        parse_json(text)
            .ok()
            .filter(|v| matches!(v, Json::Object(_) | Json::Array(_)))
    };
    let parsed = parse(text).or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        (end > start).then(|| parse(&text[start..=end])).flatten()
    })?;
    super::bounded(&parsed, &[]).ok()?;
    // The model JSON may escape isolated UTF-16 units despite its UTF-8 transport.
    // Reject that response instead of silently repairing source text or persisting bad display text.
    let mut pending = vec![&parsed];
    while let Some(v) = pending.pop() {
        match v {
            Json::String(v) => {
                utf8(v).ok()?;
            }
            Json::Array(v) => pending.extend(v),
            Json::Object(v) => {
                for (k, v) in v {
                    utf8(k).ok()?;
                    pending.push(v);
                }
            }
            _ => {}
        }
    }
    Some(parsed)
}
fn collapsed(value: &JsString) -> Result<JsString, EngineError> {
    Ok(trim(&replace_pattern(r"\s+", "g", value, " ")?))
}
fn value<'a>(value: &'a Json, name: &str) -> Option<&'a JsString> {
    match field(value, name) {
        Some(Json::String(v)) => Some(v),
        _ => None,
    }
}
fn strings(
    value: Option<&Json>,
    max_len: usize,
    exclude: &[JsString],
) -> Result<Vec<Json>, EngineError> {
    let Some(Json::Array(items)) = value else {
        return Ok(vec![]);
    };
    let mut out = Vec::<JsString>::new();
    let excludes = exclude.iter().map(lower).collect::<Vec<_>>();
    for item in items {
        let Json::String(item) = item else { continue };
        let v = collapsed(item)?;
        if v.utf16_len() < 2
            || v.utf16_len() > max_len
            || v.as_utf16_units()
                .iter()
                .all(|u| (48..=57).contains(u) || [32, 46, 44, 45].contains(u))
        {
            continue;
        }
        let key = lower(&v);
        if excludes.contains(&key) || out.iter().any(|v| lower(v) == key) {
            continue;
        }
        out.push(v);
        if out.len() >= 5 {
            break;
        }
    }
    Ok(out.into_iter().map(Json::String).collect())
}
fn participants(turns: &[Json], names: (&JsString, &JsString), voices: &[Json]) -> Json {
    let mut out = Vec::<JsString>::new();
    let mut push = |value: &JsString| {
        let v = trim(value);
        if !v.is_empty() && !out.iter().any(|x| lower(x) == lower(&v)) {
            out.push(v);
        }
    };
    if turns
        .iter()
        .any(|t| field(t, "role") == Some(&text("user")))
    {
        push(names.0);
    }
    if turns
        .iter()
        .any(|t| field(t, "role") == Some(&text("assistant")))
    {
        push(names.1);
    }
    for voice in voices {
        if truthy(voice) {
            push(&string(voice));
        }
    }
    Json::Array(out.into_iter().take(10).map(Json::String).collect())
}
pub(super) fn apply(
    episode: &Json,
    parsed: &Json,
    turns: &[Json],
    names: (&JsString, &JsString),
) -> Result<Json, EngineError> {
    let title = value(parsed, "title")
        .map(collapsed)
        .transpose()?
        .map(|v| display_cut(&v, 80))
        .unwrap_or_default();
    let summary = value(parsed, "summary")
        .map(|v| display_cut(&trim(v), 600))
        .unwrap_or_default();
    let turning = value(parsed, "turningPoint")
        .map(|v| display_cut(&trim(v), 300))
        .unwrap_or_default();
    let arc = value(parsed, "narrativeArc")
        .filter(|v| {
            [
                "setup-conflict-resolution",
                "exploration",
                "decision",
                "emotional",
            ]
            .iter()
            .any(|a| *v == &JsString::from(*a))
        })
        .cloned()
        .unwrap_or_else(|| "exploration".into());
    let topics = strings(field(parsed, "topics"), 40, &[])?;
    let voices = voices(episode);
    let mut exclude = vec![names.0.clone(), names.1.clone()];
    exclude.extend(voices.iter().map(string));
    let mentioned = strings(field(parsed, "people"), 60, &exclude)?;
    let mut out = episode.clone();
    if !title.is_empty() {
        set(&mut out, "title", Json::String(title))?;
    }
    if !summary.is_empty() {
        set(&mut out, "summary", Json::String(summary))?;
    }
    set(&mut out, "narrativeArc", Json::String(arc))?;
    set(&mut out, "turningPoint", Json::String(turning))?;
    if !topics.is_empty() {
        set(&mut out, "topics", Json::Array(topics))?;
    }
    set(&mut out, "participants", participants(turns, names, voices))?;
    set(&mut out, "mentioned", Json::Array(mentioned))?;
    if let Some(emotion) = value(parsed, "emotion")
        .map(|v| lower(&trim(v)))
        .filter(|v| {
            DIMS.iter()
                .chain(["disgust", "neutral"].iter())
                .any(|s| v == &JsString::from(*s))
        })
    {
        let raw = field(parsed, "emotionIntensity").map(|v| match v {
            Json::String(v) => Json::String(lower(&trim(v))),
            _ => v.clone(),
        });
        let intensity = number(raw.as_ref());
        let intensity = if intensity.is_finite() {
            intensity.clamp(0., 1.)
        } else {
            match raw
                .as_ref()
                .map(string)
                .as_ref()
                .map(JsString::to_utf8_lossy)
                .as_deref()
            {
                Some("niedrig") => 0.3,
                Some("mittel") => 0.55,
                Some("hoch") => 0.8,
                _ => f64::NAN,
            }
        };
        let intensity = if emotion == JsString::from("neutral") {
            if intensity.is_finite() {
                intensity.min(0.3)
            } else {
                0.1
            }
        } else if intensity.is_finite() {
            intensity
        } else {
            0.55
        };
        set(&mut out, "emotionalDominant", Json::String(emotion.clone()))?;
        set(&mut out, "emotionalIntensity", json_number(intensity))?;
        if DIMS.iter().any(|v| emotion == JsString::from(*v)) {
            let mut tone = spread(field(episode, "emotionalTone"));
            let key = utf8(&emotion)?;
            let previous = field(&tone, &key)
                .filter(|v| truthy(v))
                .map_or(0., |v| number(Some(v)));
            let next = if previous.is_nan() {
                f64::NAN
            } else {
                previous.max(intensity)
            };
            set(&mut tone, &key, json_number(next))?;
            set(&mut out, "emotionalTone", tone)?;
        }
    }
    Ok(out)
}

fn spread(value: Option<&Json>) -> Json {
    match value {
        Some(Json::Object(v)) => Json::Object(v.clone()),
        Some(Json::Array(v)) => Json::Object(
            v.iter()
                .enumerate()
                .map(|(i, v)| (JsString::from(i.to_string()), v.clone()))
                .collect(),
        ),
        Some(Json::String(v)) => Json::Object(
            v.as_utf16_units()
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    (
                        JsString::from(i.to_string()),
                        Json::String(JsString::from_utf16_units(vec![*v])),
                    )
                })
                .collect(),
        ),
        _ => object(vec![]),
    }
}
