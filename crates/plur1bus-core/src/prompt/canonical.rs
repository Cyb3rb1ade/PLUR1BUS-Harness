//! Deterministic text and JSON of the prompt zones (ADR-010 R3; `packages/core/src/prompt/canonical.ts`).
//!
//! Every hash of the prompt builder is taken over the text these functions produce, and a provider's prompt cache keys
//! on the same bytes. The rules: strings in Unicode NFC with LF line ends and no lone surrogate; object keys sorted by
//! code point at every depth (which is the byte order of their UTF-8, so a Rust `String` comparison); numbers as
//! JavaScript prints the shortest round-trip double, with `-0` as `0`; no white space.
use crate::js::json_stringify;
use crate::metrics::registry::js_number_to_string;
use crate::policy::paths::{IcuNfc, Nfc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;

/// `normalizeText`: NFC, then CRLF and CR as LF. A Rust `str` is well-formed already; see [`normalize_text_units`] for
/// the JavaScript strings that are not.
pub fn normalize_text(text: &str) -> String {
    let nfc = IcuNfc.nfc(text).unwrap_or_else(|| text.to_owned());
    if nfc.contains('\r') {
        nfc.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        nfc
    }
}

/// `normalizeText` of a JavaScript string given as code units: a lone surrogate becomes U+FFFD (`toWellFormed`) first.
pub fn normalize_text_units(units: &[u16]) -> String {
    normalize_text(&String::from_utf16_lossy(units))
}

/// Why a value has no canonical form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CanonicalError {
    /// Two keys of one object are the same string after normalisation (an NFC and an NFD spelling of one name).
    DuplicateKey(String),
}

impl fmt::Display for CanonicalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CanonicalError::DuplicateKey(k) => {
                write!(f, "canonicalJson: duplicate key after normalisation: {k}")
            }
        }
    }
}

impl std::error::Error for CanonicalError {}

fn render(value: &Value, out: &mut String) -> Result<(), CanonicalError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // A JSON number is a double in JavaScript; `js_number_to_string` prints `-0` as `0`.
        Value::Number(n) => out.push_str(&js_number_to_string(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => out.push_str(&json_stringify(&normalize_text(s))),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render(item, out)?;
            }
            out.push(']');
        }
        Value::Object(members) => {
            let mut entries: Vec<(String, &Value)> = members
                .iter()
                .map(|(k, v)| (normalize_text(k), v))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            if let Some(pair) = entries.windows(2).find(|pair| pair[0].0 == pair[1].0) {
                return Err(CanonicalError::DuplicateKey(pair[1].0.clone()));
            }
            out.push('{');
            for (i, (k, v)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&json_stringify(k));
                out.push(':');
                render(v, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// `canonicalJson(value)`. What TypeScript refuses beyond a duplicate key (non-finite numbers, `undefined`, cycles,
/// values that are not plain data) cannot be held by a `serde_json::Value`.
pub fn canonical_json(value: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    render(value, &mut out)?;
    Ok(out)
}

/// `sha256Hex(text)`: SHA-256 of the UTF-8 bytes, lower-case hex.
pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
