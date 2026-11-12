//! Capture trust and injected-context detection from the pinned Node Neo helpers.
//!
//! Legacy matches run on UCS-2 code units (without JavaScript's `u` flag), including
//! bounded timestamp/tag regexes cut next to surrogate pairs. No shared text helper is changed.

use std::sync::OnceLock;

use regress::Regex;

use crate::contract::EngineError;
use crate::text::js::{js_to_lower_case, js_trim, JsString};

struct Matchers {
    header: Regex,
    timestamp: Regex,
    json: Vec<Regex>,
    injection: Regex,
    quick: Vec<String>,
}

fn unavailable() -> EngineError {
    EngineError::NotAvailable {
        reason: "capture-pattern-initialization".into(),
    }
}

fn matchers() -> Result<&'static Matchers, EngineError> {
    static MATCHERS: OnceLock<Result<Matchers, ()>> = OnceLock::new();
    MATCHERS.get_or_init(|| {
        let compile = |pattern: &str| Regex::with_flags(pattern, "i").map_err(|_| ());
        let host = ["open", "claw"].concat();
        let header = compile(&format!(r"^(?:user:\s*)?(?:<<<)?begin_{host}_internal_context\b|^\[subagent context\]|^\[inter-session message\]|^\[system\] your previous turn was interrupted\b|^\[queued user message from a previous active turn\b"))?;
        let timestamp = compile(r"^\[[^\]]{0,80}\]\s+")?;
        let json = [r#"capturedBy"\s*:\s*"agent_end_capture"#, r#"embeddingStatus"\s*:\s*"pending"#,
            r#""chat_id"\s*:\s*"telegram:"#, r#""message_id"\s*:\s*""#, r#""sender_id"\s*:\s*""#]
            .iter().map(|pattern| compile(pattern)).collect::<Result<Vec<_>, _>>()?;
        let injection = compile(r"\b(ignore (all )?(previous|prior|above|instructions?)|disregard (all )?(prior|previous|instructions?)|system prompt|developer message|tool_call|act as|pretend (to be|you are)|you are now|new (role|persona|instruction)|forget (?:\w+\s+){0,3}(previous|prior|above|instructions?)|jailbreak|prompt injection)\b|<\/?(?:tool|system|s|assistant|human|prompt)[^>]{0,30}>|<\|im_start\||<\|im_end\||#{3,}\s*(system|assistant|user)\b")?;
        let mut quick: Vec<String> = ["<plur1bus-recall", "</plur1bus-recall", "<plur1bus-start-notice",
            "</plur1bus-start-notice", "plur1bus — make your agent yours", "<temporal-context>",
            "</temporal-context>", "<relevant-memories", "</relevant-memories", "<knowledge-update-reminder",
            "</knowledge-update-reminder", "<reminder-nudge", "</reminder-nudge", "<adaptive-learning",
            "</adaptive-learning", "recall safety rules", "plur1bus internal classify-recent",
            "critical-memory-classifier", "tts-status", "[cron:", "heartbeat_ok", "reference utc:", "current time:",
            "you are a memory search agent", "memory search agent. another model", "bounded search query",
            "use only the available memory tools", "conversation info (untrusted metadata)",
            "write a dream diary entry from these memory fragments", "your previous turn was interrupted by a gateway restart"]
            .iter().map(|marker| (*marker).to_owned()).collect();
        quick.extend([format!("[{host} heartbeat"), format!("this content was routed by {host} from another session"), format!("⟦{host}:ctx⟧")]);
        Ok(Matchers { header, timestamp, json, injection, quick })
    }).as_ref().map_err(|()| unavailable())
}

fn matches(pattern: &Regex, text: &JsString) -> bool {
    pattern
        .find_from_ucs2(text.as_utf16_units(), 0)
        .next()
        .is_some()
}

/// Detect the pinned feedback-loop markers without treating ordinary user prose as injected context.
pub fn is_injected_context(text: &JsString) -> Result<bool, EngineError> {
    let patterns = matchers()?;
    for units in text
        .as_utf16_units()
        .split(|unit| *unit == u16::from(b'\n'))
    {
        let line = JsString::from_utf16_units(units.to_vec());
        // Replacement of lone surrogates cannot introduce any ASCII/header marker; bounds
        // still match on the original code units after JS whitespace trimming.
        let utf8 = line.to_utf8_lossy();
        let trimmed = JsString::from(js_trim(&utf8));
        if matches(&patterns.header, &trimmed) {
            return Ok(true);
        }
        if let Some(prefix) = patterns
            .timestamp
            .find_from_ucs2(trimmed.as_utf16_units(), 0)
            .next()
        {
            let remainder =
                JsString::from_utf16_units(trimmed.as_utf16_units()[prefix.end()..].to_vec());
            if matches(&patterns.header, &remainder) {
                return Ok(true);
            }
        }
    }
    let lower = js_to_lower_case(&text.to_utf8_lossy());
    if patterns.quick.iter().any(|marker| lower.contains(marker)) {
        return Ok(true);
    }
    if ![
        "capturedby",
        "embeddingstatus",
        "\"chat_id\"",
        "\"message_id\"",
        "\"sender_id\"",
    ]
    .iter()
    .any(|hint| lower.contains(hint))
    {
        return Ok(false);
    }
    Ok(patterns.json.iter().any(|pattern| matches(pattern, text)))
}

/// Apply the exact legacy injection classifier, retaining bounded UTF-16 tag matching.
pub fn looks_like_prompt_injection(text: &JsString) -> Result<bool, EngineError> {
    Ok(matches(&matchers()?.injection, text))
}

/// Trust a normal user write only after the restore-safe cutoff has initialized successfully.
/// Every other new write is `untrusted`; the pin never stores the empty legacy value here.
pub fn decide_capture_status(
    text: &JsString,
    role: &str,
    origin: &str,
    cutoff_failed: bool,
) -> Result<&'static str, EngineError> {
    let role = js_to_lower_case(js_trim(role));
    let origin = js_to_lower_case(js_trim(origin));
    if cutoff_failed || role != "user" || ["cron", "internal", "dream"].contains(&origin.as_str()) {
        return Ok("untrusted");
    }
    if is_injected_context(text)? || looks_like_prompt_injection(text)? {
        return Ok("untrusted");
    }
    Ok("observed")
}
