//! Record-boundary and aggregate UTF-16 caps from `lib/inject-budget.js`.

use super::blocks::{ContextBlock, Deferral};
use super::render_value::{concat, find, join};
use crate::text::js::JsString;
use std::sync::OnceLock;

/// Shared truncation marker; repeat caps strip it before finding record boundaries.
pub const TRUNCATION_MARKER: &str = "\n<!-- memory context truncated -->";
const RECORD_CLOSE: &str = "</memory-record>";

/// Host injection text plus only actual global-cap changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InjectionPlan {
    /// Joined/capped text, distinct from original result blocks.
    pub text: JsString,
    /// Changes in reverse droppable-block order.
    pub deferrals: Vec<Deferral>,
}

impl InjectionPlan {
    /// Node-order raw JSON, preserving surrogate escapes.
    #[must_use]
    pub fn to_json_line(&self) -> String {
        let deferrals = serde_json::to_string(&self.deferrals).unwrap_or_else(|_| "[]".into());
        format!(
            "{{\"text\":{},\"deferrals\":{deferrals}}}",
            self.text.to_json()
        )
    }
}

fn tag_tokens(text: &JsString) -> Vec<(bool, String, bool)> {
    // Tags are ASCII; lossy replacement of evidence surrogates cannot create a tag.
    let scalar = text.to_utf8_lossy();
    static TOKEN_REGEX: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let Some(regex) = TOKEN_REGEX.get_or_init(|| {
        let whitespace = crate::text::js::JS_WHITESPACE_CLASS;
        regex::Regex::new(&format!(
            concat!(
                r"(?s)<!--.*?-->|</([a-zA-Z][A-Za-z0-9_-]*){whitespace}*>",
                r"|<([a-zA-Z][A-Za-z0-9_-]*)(?:{whitespace}[^<>]*)?>"
            ),
            whitespace = whitespace
        ))
        .ok()
    }) else {
        return Vec::new();
    };
    regex
        .captures_iter(&scalar)
        .filter_map(|cap| {
            let whole = cap.get(0)?.as_str();
            if let Some(close) = cap.get(1) {
                return Some((true, close.as_str().into(), false));
            }
            cap.get(2)
                .map(|open| (false, open.as_str().into(), whole.ends_with("/>")))
        })
        .collect()
}

/// Close the actual open-element stack, including unknown wrappers and mismatches.
#[must_use]
pub fn close_open_elements(text: &JsString) -> JsString {
    let mut stack = Vec::<String>::new();
    for (close, name, self_closing) in tag_tokens(text) {
        if close {
            if let Some(index) = stack.iter().rposition(|open| open == &name) {
                stack.truncate(index);
            }
        } else if !self_closing {
            stack.push(name);
        }
    }
    let closing = stack
        .iter()
        .rev()
        .map(|name| format!("\n</{name}>"))
        .collect::<String>();
    JsString::from(closing)
}

/// Largest whole-record prefix including a marker and the remaining element closings.
#[must_use]
pub fn trim_at_record_boundary(text: &JsString, allowed: f64) -> Option<JsString> {
    if allowed <= 0.0 || find(text, RECORD_CLOSE, 0).is_none() {
        return None;
    }
    let base = text.utf16_slice(
        0,
        find(text, TRUNCATION_MARKER, 0).unwrap_or(text.utf16_len()),
    );
    let mut reserve = 0;
    let mut previous = None;
    loop {
        let budget = allowed - TRUNCATION_MARKER.len() as f64 - reserve as f64;
        if budget <= 0.0 {
            return None;
        }
        let mut start = 0;
        let mut cut = None;
        while let Some(at) = find(&base, RECORD_CLOSE, start) {
            start = at + RECORD_CLOSE.len();
            if start as f64 > budget {
                break;
            }
            cut = Some(start);
        }
        let cut = cut?;
        if previous == Some(cut) {
            return None;
        }
        previous = Some(cut);
        let prefix = base.utf16_slice(0, cut);
        let closings = close_open_elements(&prefix);
        if (cut + TRUNCATION_MARKER.len() + closings.utf16_len()) as f64 <= allowed {
            return Some(join(
                &[prefix, JsString::from(TRUNCATION_MARKER), closings],
                "",
            ));
        }
        reserve = reserve.max(closings.utf16_len());
    }
}

/// Inner memories cap, including the pin's operational-warning exception.
#[must_use]
pub fn truncate_memories(text: &JsString, maximum: f64) -> JsString {
    let limit = if maximum.is_finite() && maximum > 0.0 {
        maximum.floor() as usize
    } else {
        12_000
    };
    if text.utf16_len() <= limit {
        return text.clone();
    }
    if let Some(warning) = preserve_warning(text, limit) {
        return warning;
    }
    if let Some(trimmed) = trim_at_record_boundary(text, limit as f64) {
        return trimmed;
    }
    let mut cut = find(text, "<memory-record", 0)
        .filter(|&at| at <= limit)
        .unwrap_or(limit);
    let mut reserve = 0;
    loop {
        cut = cut.min(limit.saturating_sub(TRUNCATION_MARKER.len() + reserve));
        let prefix = text.utf16_slice(0, cut);
        let closings = close_open_elements(&prefix);
        let candidate = join(
            &[prefix, JsString::from(TRUNCATION_MARKER), closings.clone()],
            "",
        );
        if candidate.utf16_len() <= limit {
            return candidate;
        }
        if cut == 0 {
            return concat(TRUNCATION_MARKER, &closings, "").utf16_slice(0, limit);
        }
        reserve = reserve.max(closings.utf16_len());
    }
}

/// Join original blocks and cap the last remaining droppable block on each pass.
#[must_use]
pub fn plan(blocks: &[ContextBlock], max_chars: f64) -> InjectionPlan {
    let mut current = blocks
        .iter()
        .filter(|b| !b.text.is_empty())
        .cloned()
        .collect::<Vec<_>>();
    let mut deferrals = Vec::new();
    if max_chars.is_finite() && max_chars > 0.0 {
        while joined(&current).utf16_len() as f64 > max_chars {
            let Some(index) = current.iter().rposition(|b| b.droppable) else {
                break;
            };
            let before = current[index].text.utf16_len();
            let allowed =
                (before as f64 - (joined(&current).utf16_len() as f64 - max_chars)).max(0.0);
            let trimmed =
                trim_at_record_boundary(&current[index].text, allowed).unwrap_or_default();
            deferrals.push(Deferral {
                block: current[index].name.clone(),
                kind: if trimmed.is_empty() {
                    "dropped"
                } else {
                    "clipped"
                }
                .into(),
                from: before,
                to: trimmed.utf16_len(),
                reason: "global-cap".into(),
            });
            if trimmed.is_empty() {
                current.remove(index);
            } else {
                current[index].chars = trimmed.utf16_len();
                current[index].text = trimmed;
            }
        }
    }
    InjectionPlan {
        text: joined(&current),
        deferrals,
    }
}

fn preserve_warning(text: &JsString, limit: usize) -> Option<JsString> {
    let warning_start = find(text, "\n<operational-memory-warning>", 0);
    let warning_end = find(text, "</operational-memory-warning>\n", 0);
    if let (Some(start), Some(end)) = (warning_start, warning_end) {
        let end = end + "</operational-memory-warning>\n".len();
        if limit < end {
            return Some(join(
                &[
                    text.utf16_slice(0, start),
                    JsString::from(TRUNCATION_MARKER),
                    text.utf16_slice(start, end),
                ],
                "",
            ));
        }
    }
    None
}

fn joined(parts: &[ContextBlock]) -> JsString {
    join(
        &parts.iter().map(|b| b.text.clone()).collect::<Vec<_>>(),
        "\n\n",
    )
}
