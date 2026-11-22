//! `auth/redact.ts`: the last line for text that crossed a port on its way to a log or an error. The package's own messages
//! never hold a token; `scrub` replaces every known secret value, and anything shaped like a bearer credential.
//!
//! This is not the core's log redactor (`logs::redact`, D111): it is the auth package's own, narrower rule, kept because
//! its callers depend on exactly this replacement (`$1 [redacted]`, the scheme word kept in its case).
use crate::js::is_js_space;
use serde_json::Value;

const REDACTED: &str = "[redacted]";

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `\w` without the `u` flag.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `[A-Za-z0-9._~+/=-]`.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._~+/=-".contains(c)
}

/// The length in bytes of `Bearer` or `Basic` (ASCII case-insensitive, as a `/i` regexp without `u` folds) at the start
/// of `s`.
fn scheme_word(s: &str) -> Option<usize> {
    ["bearer", "basic"].into_iter().find_map(|w| {
        let head = s.get(..w.len())?;
        head.eq_ignore_ascii_case(w).then_some(w.len())
    })
}

/// `/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi` replaced by `$1 [redacted]`.
fn mask_bearer(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut prev: Option<char> = None;
    while i < text.len() {
        let rest = &text[i..];
        let boundary = !prev.is_some_and(is_word);
        if boundary {
            if let Some(w) = scheme_word(rest) {
                let after_word = &rest[w..];
                let ws: usize = after_word
                    .chars()
                    .take_while(|c| is_js_space(*c))
                    .map(char::len_utf8)
                    .sum();
                let token: usize = after_word[ws..]
                    .chars()
                    .take_while(|c| is_token_char(*c))
                    .count();
                if ws > 0 && token >= 8 {
                    out.push_str(&rest[..w]);
                    out.push(' ');
                    out.push_str(REDACTED);
                    // The token characters are ASCII: one byte each.
                    let end = w + ws + token;
                    i += end;
                    prev = rest[..end].chars().last();
                    continue;
                }
            }
        }
        let Some(c) = rest.chars().next() else { break };
        out.push(c);
        prev = Some(c);
        i += c.len_utf8();
    }
    out
}

/// `scrub(text, secrets)`.
pub fn scrub<S: AsRef<str>>(text: &str, secrets: &[S]) -> String {
    let mut out = text.to_owned();
    for s in secrets {
        let s = s.as_ref();
        if utf16_len(s) >= 4 {
            out = out.replace(s, REDACTED);
        }
    }
    mask_bearer(&out)
}

/// `safeFields(fields, secrets)`: strings scrubbed, everything else passes, `undefined` (`None`) left out.
pub fn safe_fields<S: AsRef<str>>(
    fields: &[(&str, Option<Value>)],
    secrets: &[S],
) -> Vec<(String, Value)> {
    fields
        .iter()
        .filter_map(|(k, v)| {
            let v = v.as_ref()?;
            Some((
                (*k).to_owned(),
                match v {
                    Value::String(s) => Value::String(scrub(s, secrets)),
                    other => other.clone(),
                },
            ))
        })
        .collect()
}
