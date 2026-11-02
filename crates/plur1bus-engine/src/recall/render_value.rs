//! Small JavaScript scalar/UTF-16 operations used only by the T5 port.

use crate::text::js::{is_js_whitespace, JsString};
use serde_json::{Number, Value};

pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub(super) fn number_text(value: &Number) -> String {
    if value.as_f64() == Some(0.0) {
        return "0".into();
    }
    let mut text = value.to_string();
    if text.ends_with(".0") {
        text.truncate(text.len() - 2);
    }
    text
}

pub(super) fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => number_text(n),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items.iter().map(text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub(super) fn number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(*b),
        Value::Null => 0.0,
        Value::String(s) if crate::text::js::js_trim(s).is_empty() => 0.0,
        Value::String(s) => {
            let s = crate::text::js::js_trim(s);
            let prefix = s.get(..2).unwrap_or("");
            let radix = match prefix {
                "0x" | "0X" => Some(16),
                "0o" | "0O" => Some(8),
                "0b" | "0B" => Some(2),
                _ => None,
            };
            radix.map_or_else(
                || s.parse().unwrap_or(f64::NAN),
                |radix| u128::from_str_radix(&s[2..], radix).map_or(f64::NAN, |n| n as f64),
            )
        }
        _ => f64::NAN,
    }
}

pub(super) fn bounded(value: &Value, default: usize, minimum: usize, maximum: usize) -> usize {
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .map_or(default, |n| {
            n.floor().max(minimum as f64).min(maximum as f64) as usize
        })
}

pub(super) fn join(parts: &[JsString], separator: &str) -> JsString {
    let mut out = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.extend(separator.encode_utf16());
        }
        out.extend_from_slice(part.as_utf16_units());
    }
    JsString::from_utf16_units(out)
}

pub(super) fn concat(prefix: &str, body: &JsString, suffix: &str) -> JsString {
    let mut out = prefix.encode_utf16().collect::<Vec<_>>();
    out.extend_from_slice(body.as_utf16_units());
    out.extend(suffix.encode_utf16());
    JsString::from_utf16_units(out)
}

pub(super) fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace)
}

pub(super) fn trim(value: &JsString) -> JsString {
    let units = value.as_utf16_units();
    let start = units
        .iter()
        .position(|&u| !whitespace(u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|&u| !whitespace(u))
        .map_or(start, |n| n + 1);
    value.utf16_slice(start, end)
}

pub(super) fn find(value: &JsString, needle: &str, start: usize) -> Option<usize> {
    let needle = needle.encode_utf16().collect::<Vec<_>>();
    value
        .as_utf16_units()
        .get(start..)?
        .windows(needle.len())
        .position(|slice| slice == needle)
        .map(|index| start + index)
}

/// Exact binary64-to-decimal rounding used by Number.toFixed for prompt scores.
pub(super) fn fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value.abs() >= 1e21 {
        return value.to_string();
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let significand = if exponent == 0 {
        fraction
    } else {
        fraction | (1_u64 << 52)
    };
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let scaled = u128::from(significand) * 10_u128.pow(digits);
    let rounded = if shift >= 0 {
        scaled.checked_shl(shift as u32).unwrap_or(0)
    } else if -shift >= 128 {
        0
    } else {
        let divisor = 1_u128 << (-shift as u32);
        scaled / divisor + u128::from(scaled % divisor >= divisor / 2)
    };
    let scale = 10_u128.pow(digits);
    let sign = if value < 0.0 { "-" } else { "" };
    format!(
        "{sign}{}.{:0width$}",
        rounded / scale,
        rounded % scale,
        width = digits as usize
    )
}
