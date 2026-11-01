//! The pin escapes after a UTF-16 cut, retaining lone surrogate code units.

use super::render_value::{text, truthy};
use crate::text::js::JsString;
use serde_json::Value;

/// Sanitize a scalar attribute using the pin's ASCII-only word class.
#[must_use]
pub fn attribute(value: &Value, fallback: &str) -> String {
    let source = if truthy(value) {
        text(value)
    } else {
        fallback.into()
    };
    let mut out = String::new();
    let mut in_run = false;
    for ch in source.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '.' | '-') {
            out.push(ch);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
        if out.len() == 160 {
            break;
        }
    }
    if out.is_empty() {
        fallback.into()
    } else {
        out
    }
}

/// Escape evidence, remove the exact control class, and collapse excess spaces/newlines.
#[must_use]
pub fn evidence(value: &JsString, maximum: usize) -> JsString {
    let mut out = Vec::new();
    let (mut newlines, mut spaces) = (0, 0);
    for &unit in value.as_utf16_units().iter().take(maximum) {
        if matches!(unit, 0..=8 | 11..=12 | 14..=31 | 127) {
            continue;
        }
        newlines = if unit == 10 { newlines + 1 } else { 0 };
        spaces = if unit == 32 { spaces + 1 } else { 0 };
        if newlines > 2 || spaces > 4 {
            continue;
        }
        match unit {
            38 => out.extend("&amp;".encode_utf16()),
            60 => out.extend("&lt;".encode_utf16()),
            62 => out.extend("&gt;".encode_utf16()),
            _ => out.push(unit),
        }
    }
    JsString::from_utf16_units(out)
}

/// Plain HTML escaping, without a cut or whitespace normalization.
#[must_use]
pub fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
