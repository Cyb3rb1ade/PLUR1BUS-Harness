//! Canonical JSON and the tool-call action hash, byte-identical to the TypeScript dispatcher
//! (`packages/core/src/tools/dispatcher.ts`: `canonicalJson` and `ToolDispatcher.#buildCall`).
//!
//! Two processes need the same bytes: the dispatcher in `plur1bus-core` mints the action hash that approvals and one-time
//! grants bind to (P4-43), and `plur1bus-tools` recomputes it to check a dispatcher ticket before any effect (D120 §11.2).
//! That second consumer is why this is a crate of its own and not a module of `plur1bus-core`.
//!
//! Parity: `tests/vectors.rs` reads the vectors `scripts/parity/export-dispatcher.ts` recorded from the TypeScript code
//! (`fixtures/parity/dispatcher/`). JavaScript semantics this crate reproduces on purpose:
//! - object keys sort by UTF-16 code unit (not by UTF-8 byte), at every depth; arrays keep their order;
//! - every number is a double, printed the way `Number.prototype.toString` prints it (`1e+21`, `1e-7`, `-0` as `0`), so an
//!   integer above 2^53 that `serde_json` holds exactly is first rounded to the double `JSON.parse` would have produced;
//! - strings are escaped exactly as `JSON.stringify` escapes them (`\u007f`, U+2028 and U+2029 stay raw).
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// `canonicalJson(value)`: the JSON text of `value` with object keys sorted (UTF-16 code unit order), no whitespace,
/// numbers and strings written as JavaScript writes them.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// The text the dispatcher hashes for a tool call:
/// `canonicalJson({capability, tool, args, targets: targets ?? [], ...(hashExtra ? {hashExtra} : {})})`.
///
/// An empty `hash_extra` is left out, as JavaScript's truthiness test leaves it out; `targets` is the classifier's list in
/// its own order (an absent list is `[]`).
pub fn action_hash_input(
    capability: &str,
    tool: &str,
    args: &Value,
    targets: &[String],
    hash_extra: Option<&str>,
) -> String {
    let mut fields = Map::new();
    fields.insert("capability".into(), Value::String(capability.into()));
    fields.insert("tool".into(), Value::String(tool.into()));
    fields.insert("args".into(), args.clone());
    fields.insert(
        "targets".into(),
        Value::Array(targets.iter().cloned().map(Value::String).collect()),
    );
    if let Some(extra) = hash_extra.filter(|extra| !extra.is_empty()) {
        fields.insert("hashExtra".into(), Value::String(extra.into()));
    }
    canonical_json(&Value::Object(fields))
}

/// The action hash: SHA-256 of [`action_hash_input`], lower-case hex (64 characters).
pub fn action_hash(
    capability: &str,
    tool: &str,
    args: &Value,
    targets: &[String],
    hash_extra: Option<&str>,
) -> String {
    let input = action_hash_input(capability, tool, args, targets, hash_extra);
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(input.as_bytes()) {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// A JSON number as JavaScript prints it after `JSON.parse`: the value as a double, through [`format_double`].
pub fn js_number(number: &Number) -> String {
    // Without `arbitrary_precision` every Number converts. An integer `serde_json` kept exactly as i64/u64 rounds to the
    // nearest double (ties to even), which is what JSON.parse does with the same decimal text.
    match number.as_f64() {
        Some(x) => format_double(x),
        None => number.to_string(),
    }
}

/// `Number.prototype.toString()` (ECMA-262 Number::toString with radix 10) for a double.
///
/// The digits are the shortest that read back as the same double; Rust's `{:e}` produces exactly those, and the
/// ECMAScript rules then choose between plain and exponent notation.
pub fn format_double(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into(); // +0 and -0
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", format_double(-x));
    }
    let scientific = format!("{x:e}");
    let Some((mantissa, exponent)) = scientific.split_once('e') else {
        return x.to_string();
    };
    let Ok(exponent) = exponent.parse::<i64>() else {
        return x.to_string();
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    // x = 0.<digits> × 10^n, with k digits.
    let k = digits.len() as i64;
    let n = exponent + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(n as usize);
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e >= 0 { '+' } else { '-' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", e.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", e.abs())
        }
    }
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&js_number(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(text)`: `"` and `\` escaped, the six short escapes, every other control character below U+0020 as
/// `\u00xx` (lower-case hex), everything else raw (including U+007F, U+2028 and U+2029).
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::format_double;

    #[test]
    fn doubles_print_as_javascript_prints_them() {
        for (x, js) in [
            (100.0, "100"),
            (123.456, "123.456"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (9007199254740992.0, "9007199254740992"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (-0.0, "0"),
        ] {
            assert_eq!(format_double(x), js, "{x:e}");
        }
    }
}
