//! Frozen relative-time reminder extraction. No dispatch, clock lookup or external service.
use super::emotion_json::{num, object, string};
use crate::{
    contract::EngineError,
    text::{
        js::{self, JsString},
        json::TolerantJsonValue as Json,
    },
};

fn invalid() -> EngineError {
    EngineError::Invalid {
        field: "reminder".into(),
        message: "invalid reminder projection".into(),
    }
}
fn regex(pattern: &str, flags: &str) -> Result<regex::Regex, EngineError> {
    js::js_ascii_regex(pattern, flags).map_err(|_| invalid())
}
/// Parsed relative intent. A nonfinite timestamp is retained only as a pure Node reference;
/// storage must validate its timestamp before constructing a row.
pub struct ReminderIntent {
    /// Epoch milliseconds, or no match. This is not yet a storage-authorized timestamp.
    pub remind_at: Option<f64>,
    /// Node's normalized evidence phrase.
    pub evidence: String,
}
impl ReminderIntent {
    /// Exact pinned field order, including JSON's null encoding of nonfinite numbers.
    #[must_use]
    pub fn to_json(&self) -> Json {
        object([
            ("remindAt", self.remind_at.map_or(Json::Null, num)),
            (
                "timePrecision",
                string(if self.remind_at.is_some() {
                    "relative"
                } else {
                    "none"
                }),
            ),
            ("requiresConfirmation", Json::Bool(false)),
            ("evidence", string(&self.evidence)),
        ])
    }
}
/// Parse only the pinned DE/EN relative expressions using an already-resolved host clock.
pub fn parse_intent(input: &JsString, now: i64) -> Result<ReminderIntent, EngineError> {
    let lower = js::js_to_lower_case(&input.to_utf8_lossy());
    for (pattern, evidence) in [
        (
            r"\bin\s+(?:einer\s+)?halben\s+stunde\b",
            "in einer halben Stunde",
        ),
        (r"\bin\s+half\s+an\s+hour\b", "in half an hour"),
    ] {
        if regex(pattern, "")?.is_match(&lower) {
            return Ok(ReminderIntent {
                remind_at: Some(now as f64 + 30. * 60_000.),
                evidence: evidence.into(),
            });
        }
    }
    for (pattern, german) in [
        (r"\bin\s+(\d+|einer|eine|einem)\s*(\w+)", true),
        (r"\bin\s+(\d+)\s*(\w+)", false),
    ] {
        let re = regex(pattern, "")?;
        let Some(captures) = re.captures(&lower) else {
            continue;
        };
        let amount = captures.get(1).map_or("1", |m| m.as_str());
        let amount = if amount.starts_with("ein") {
            1.
        } else {
            amount.parse::<f64>().unwrap_or(f64::NAN)
        };
        let unit = captures.get(2).map_or("", |m| m.as_str());
        let minutes = match (german, unit) {
            (_, "minute" | "min") | (true, "minuten") | (false, "minutes") => Some(1.),
            (_, "h") | (true, "stunden" | "stunde" | "std") | (false, "hours" | "hour") => {
                Some(60.)
            }
            (_, "d") | (true, "tagen" | "tage" | "tag") | (false, "days" | "day") => Some(1440.),
            // These inherited Object properties are truthy in the frozen lookup, but multiply to NaN.
            (_, "constructor" | "__proto__") => Some(f64::NAN),
            _ => None,
        };
        if let Some(minutes) = minutes.filter(|_| amount.is_finite()) {
            return Ok(ReminderIntent {
                remind_at: Some(now as f64 + amount * minutes * 60_000.),
                evidence: format!("in {} {unit}", super::fact_quality::number_json(amount)),
            });
        }
    }
    Ok(ReminderIntent {
        remind_at: None,
        evidence: String::new(),
    })
}
fn replace(
    input: &JsString,
    pattern: &str,
    flags: &str,
    replacement: &str,
) -> Result<JsString, EngineError> {
    let value = input.to_utf8_lossy();
    let re = regex(pattern, flags)?;
    let mut result = Vec::new();
    let mut end = 0;
    for found in re.find_iter(&value) {
        let start = js::utf16_len(&value[..found.start()]);
        result.extend_from_slice(&input.as_utf16_units()[end..start]);
        result.extend(replacement.encode_utf16());
        end = js::utf16_len(&value[..found.end()]);
        if !flags.contains('g') {
            break;
        }
    }
    result.extend_from_slice(&input.as_utf16_units()[end..]);
    Ok(JsString::from_utf16_units(result))
}
fn trim(input: &JsString) -> JsString {
    let units = input.as_utf16_units();
    let space = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(js::is_js_whitespace);
    let start = units.iter().take_while(|u| space(u)).count();
    let end = units.len() - units[start..].iter().rev().take_while(|u| space(u)).count();
    input.utf16_slice(start, end)
}
/// Remove injected reminder nudges before recognizing any time expression.
pub fn strip_nudge(input: &JsString) -> Result<JsString, EngineError> {
    replace(
        input,
        r"<reminder-nudge>[\s\S]*?</reminder-nudge>",
        "gi",
        " ",
    )
}
/// Extract the sentence containing evidence, retaining Node UTF-16 slices as a pure reference.
pub fn build_text(input: &JsString, evidence: &JsString) -> Result<JsString, EngineError> {
    let text = trim(&replace(input, r"\s+", "g", " ")?);
    let evidence = trim(evidence);
    if text.is_empty() || evidence.is_empty() {
        return Ok(evidence);
    }
    let lower = js::js_to_lower_case(&text.to_utf8_lossy());
    let ev = js::js_to_lower_case(&evidence.to_utf8_lossy());
    let Some(index) = lower.find(&ev) else {
        return Ok(evidence);
    };
    let index = js::utf16_len(&lower[..index]);
    let before = text.utf16_slice(0, index).to_utf8_lossy();
    let start = [". ", "! ", "? "]
        .into_iter()
        .filter_map(|mark| before.rfind(mark))
        .max()
        .map_or(0, |at| js::utf16_len(&before[..at]) + 2);
    let after = text.utf16_slice(index, text.utf16_len()).to_utf8_lossy();
    let end = regex(r"[.!?](\s|$)", "")?
        .find(&after)
        .map_or(text.utf16_len(), |m| {
            index + js::utf16_len(&after[..m.start()]) + 1
        });
    let mut sentence = trim(&text.utf16_slice(start, end));
    if sentence.is_empty() {
        return Ok(evidence);
    }
    if sentence.utf16_len() > 200 {
        sentence = replace(&sentence.utf16_slice(0, 199), r"\s+\S*$", "", "")?;
        let mut units = sentence.into_utf16_units();
        units.push(0x2026);
        sentence = JsString::from_utf16_units(units);
    }
    Ok(sentence)
}
/// Require at least two adjacent letters outside the normalized evidence phrase.
pub fn has_topic(text: &JsString, evidence: &str) -> Result<bool, EngineError> {
    let lower = js::js_to_lower_case(&text.to_utf8_lossy());
    let rest = lower.replacen(&js::js_to_lower_case(evidence), " ", 1);
    let rest = regex(r"[^\p{L}\p{N}]+", "u")?.replace_all(&rest, " ");
    Ok(regex(r"\p{L}{2,}", "u")?.is_match(js::js_trim(&rest)))
}
/// An eligible source sentence, or the exact pinned skip diagnostic.
pub enum ReminderPlan {
    /// Feature/role/time/topic gate refused extraction.
    Skip(&'static str),
    /// Candidate only; host-bound persistence still validates ownership and timestamp.
    Candidate {
        /// Parsed relative timestamp and its normalized evidence.
        intent: ReminderIntent,
        /// Complete source sentence, still in the pure lossless reference representation.
        text: JsString,
    },
}
impl ReminderPlan {
    /// Ordered Node projection for fixture comparison; not an outward storage encoding.
    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            Self::Skip(reason) => object([("skip", Json::Bool(true)), ("reason", string(reason))]),
            Self::Candidate { intent, text } => object([
                ("skip", Json::Bool(false)),
                ("parsed", intent.to_json()),
                ("reminderText", Json::String(text.clone())),
            ]),
        }
    }
}
/// Gate capture extraction: enabled, actual user role, nonempty time and a meaningful topic.
pub fn plan(
    input: &JsString,
    role: &str,
    enabled: bool,
    now: i64,
) -> Result<ReminderPlan, EngineError> {
    if !enabled {
        return Ok(ReminderPlan::Skip("disabled"));
    }
    if role != "user" {
        return Ok(ReminderPlan::Skip("not_user_role"));
    }
    let text = strip_nudge(input)?;
    let intent = parse_intent(&text, now)?;
    if !intent.remind_at.is_some_and(|v| v != 0. && !v.is_nan()) {
        return Ok(ReminderPlan::Skip("no_time"));
    }
    let text = build_text(&text, &JsString::from(intent.evidence.as_str()))?;
    if !has_topic(&text, &intent.evidence)? {
        return Ok(ReminderPlan::Skip("no_topic"));
    }
    Ok(ReminderPlan::Candidate { intent, text })
}
