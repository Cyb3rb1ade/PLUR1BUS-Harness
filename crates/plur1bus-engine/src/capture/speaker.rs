//! Canonical segment projections and non-authoritative contextual name proposals.
use super::{
    dynamics,
    emotion_json::{array, entries, get, num, object, string},
};
use crate::{
    contract::EngineError,
    text::{
        js::{self, JsString},
        json::TolerantJsonValue as Json,
    },
};
use std::collections::{HashMap, HashSet};

fn field<'a>(v: &'a Json, key: &str) -> Option<&'a Json> {
    if let Json::Object(fields) = v {
        fields
            .iter()
            .rev()
            .find(|(k, _)| k == &JsString::from(key))
            .map(|(_, v)| v)
    } else {
        None
    }
}
fn nonempty(v: Option<&Json>, fallback: &str) -> Json {
    if let Some(Json::String(s)) = v.filter(|v| matches!(v,Json::String(s) if !s.is_empty())) {
        Json::String(s.clone())
    } else {
        string(fallback)
    }
}
fn optional(v: Option<&Json>) -> Json {
    match v {
        None | Some(Json::Null) => Json::Null,
        Some(Json::String(s)) => {
            if s.is_empty() {
                Json::Null
            } else {
                Json::String(s.clone())
            }
        }
        Some(v) => {
            let s = dynamics::js_string(v);
            if s.is_empty() {
                Json::Null
            } else {
                string(&s)
            }
        }
    }
}
fn confidence(v: Option<&Json>) -> Json {
    if matches!(v, None | Some(Json::Null)) {
        return Json::Null;
    }
    let n = dynamics::number(v);
    if n.is_finite() {
        num(n.clamp(0., 1.))
    } else {
        Json::Null
    }
}
fn number(v: Option<&Json>, default: f64) -> f64 {
    let n = dynamics::number(v);
    if n.is_finite() {
        n
    } else {
        default
    }
}
fn known(v: Option<&Json>, values: &[&str]) -> Json {
    if let Some(Json::String(s)) = v {
        if values.iter().any(|v| s == &JsString::from(*v)) {
            return Json::String(s.clone());
        }
    }
    string("unknown")
}
/// Normalize one segment without inventing a real speaker identity; unknown fields are discarded.
#[must_use]
pub fn normalize_segment(input: &Json) -> Json {
    let start = number(field(input, "startMs"), 0.);
    let end = number(field(input, "endMs"), start).max(start);
    let words = if let Some(Json::Array(values)) = field(input, "words") {
        Json::Array(
            values
                .iter()
                .map(|w| {
                    object([
                        ("startMs", num(number(field(w, "startMs"), start))),
                        ("endMs", num(number(field(w, "endMs"), start))),
                        ("word", nonempty(field(w, "word"), "")),
                        ("confidence", confidence(field(w, "confidence"))),
                    ])
                })
                .collect(),
        )
    } else {
        Json::Null
    };
    object([
        (
            "source",
            known(
                field(input, "source"),
                &[
                    "discord_voice",
                    "telegram_voice",
                    "youtube",
                    "upload",
                    "podcast",
                    "meeting",
                    "unknown",
                ],
            ),
        ),
        ("sourceId", optional(field(input, "sourceId"))),
        (
            "speakerLabel",
            nonempty(field(input, "speakerLabel"), "unknown"),
        ),
        (
            "speakerDisplayName",
            optional(field(input, "speakerDisplayName")),
        ),
        (
            "speakerConfidence",
            confidence(field(input, "speakerConfidence")),
        ),
        ("startMs", num(start)),
        ("endMs", num(end)),
        ("text", nonempty(field(input, "text"), "")),
        ("words", words),
        (
            "attributionSource",
            known(
                field(input, "attributionSource"),
                &[
                    "discord_user_stream",
                    "asr_diarize",
                    "sortformer",
                    "manual",
                    "contextual_proposal",
                    "enrollment",
                    "unknown",
                ],
            ),
        ),
        (
            "diarizationModel",
            optional(field(input, "diarizationModel")),
        ),
        ("asrModel", optional(field(input, "asrModel"))),
    ])
}
/// A non-array becomes an empty segment list, exactly as in the pin.
#[must_use]
pub fn normalize_segments(input: &Json) -> Json {
    Json::Array(array(input).iter().map(normalize_segment).collect())
}
fn js_string(v: &Json) -> JsString {
    if let Json::String(s) = v {
        s.clone()
    } else {
        JsString::from(dynamics::js_string(v).as_str())
    }
}
/// Apply only caller-supplied confirmed mappings; pending proposals never become active identities.
#[must_use]
pub fn apply_mappings(input: &Json, mappings: &HashMap<JsString, JsString>) -> Json {
    Json::Array(
        array(&normalize_segments(input))
            .iter()
            .map(|segment| {
                let name = mappings
                    .get(&js_string(get(segment, "speakerLabel")))
                    .filter(|s| !s.is_empty());
                object(entries(segment).into_iter().map(|(key, value)| {
                    let value = if key == "speakerDisplayName" {
                        name.map_or(value, |s| Json::String(s.clone()))
                    } else {
                        value
                    };
                    (key, value)
                }))
            })
            .collect(),
    )
}
/// Human-readable projection, still lossless until its outward text boundary.
#[must_use]
pub fn format_segments(input: &Json) -> JsString {
    let mut units = Vec::new();
    for (index, segment) in array(&normalize_segments(input)).iter().enumerate() {
        if index > 0 {
            units.push(10);
        }
        let display = get(segment, "speakerDisplayName");
        let name = if display == &Json::Null {
            get(segment, "speakerLabel")
        } else {
            display
        };
        units.push(91);
        units.extend(js_string(name).into_utf16_units());
        units.extend([93, 58, 32]);
        units.extend(js_string(get(segment, "text")).into_utf16_units());
    }
    JsString::from_utf16_units(units)
}
fn invalid() -> EngineError {
    EngineError::Invalid {
        field: "speaker".into(),
        message: "invalid speaker projection".into(),
    }
}
/// Remove one leading hidden media-id token without dropping remaining source text.
pub fn strip_media_token(input: &JsString) -> Result<JsString, EngineError> {
    let text = input.to_utf8_lossy();
    let re = js::js_ascii_regex(r"^<!-- media-output-id: [a-f0-9-]+ -->\n?", "gi")
        .map_err(|_| invalid())?;
    Ok(re.find(&text).map_or_else(
        || input.clone(),
        |m| input.utf16_slice(js::utf16_len(&text[..m.end()]), input.utf16_len()),
    ))
}
/// Extract only the pinned hexadecimal media-id tokens, preserving their source order and case.
pub fn media_ids(input: &JsString) -> Result<Vec<String>, EngineError> {
    let text = input.to_utf8_lossy();
    let re = js::js_ascii_regex(r"<!-- media-output-id: ([a-f0-9-]+) -->", "gi")
        .map_err(|_| invalid())?;
    Ok(re
        .captures_iter(&text)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_owned()))
        .collect())
}
/// A candidate name; this is never an authoritative or biometric attribution.
pub struct SpeakerProposal {
    /// Exact diarization label, including its original UTF-16 identity.
    pub speaker_label: JsString,
    /// Candidate direct-address name.
    pub display_name: JsString,
    /// Fixed lexical confidence.
    pub confidence: f64,
    /// Matching source phrase, stored privately and never logged.
    pub context_hint: JsString,
}
impl SpeakerProposal {
    /// Exact Node proposal field order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        object([
            ("speakerLabel", Json::String(self.speaker_label.clone())),
            ("displayName", Json::String(self.display_name.clone())),
            ("confidence", num(self.confidence)),
            ("contextHint", Json::String(self.context_hint.clone())),
        ])
    }
}
/// Propose contextual names only for labels with no confirmed mapping. Preserve the pinned alternative order.
pub fn propose(
    input: &Json,
    confirmed: &HashSet<JsString>,
) -> Result<Vec<SpeakerProposal>, EngineError> {
    let re=js::js_regex(r"(?:Hallo|Hi|Hey|Moin|Guten Tag|Guten Morgen|Guten Abend|Danke|Danke schön|Vielen Dank|Bitte|Entschuldigung|Sorry|Excuse me)\s*,?\s*([A-Z][a-zA-ZäöüÄÖÜß]+)(?=\s|[,\.!?]|$)","gi").map_err(|_|invalid())?;
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    for segment in array(&normalize_segments(input)) {
        let label = js_string(get(segment, "speakerLabel"));
        if confirmed.contains(&label) {
            continue;
        }
        let text = js_string(get(segment, "text")).to_utf8_lossy();
        for groups in re.captures_all(&text).map_err(|_| invalid())? {
            let hint = groups
                .first()
                .and_then(Option::as_ref)
                .ok_or_else(invalid)?;
            let name = groups.get(1).and_then(Option::as_ref).ok_or_else(invalid)?;
            let hint = js::js_trim(&hint.matched);
            let name = js::js_trim(&name.matched);
            if js::utf16_len(name) < 2 || !seen.insert((label.clone(), name.to_owned())) {
                continue;
            }
            output.push(SpeakerProposal {
                speaker_label: label.clone(),
                display_name: JsString::from(name),
                confidence: 0.7,
                context_hint: JsString::from(hint),
            });
        }
    }
    Ok(output)
}
