//! The few JavaScript string operations the maintenance services lean on, over UTF-16 code units. A Rust `String` cannot hold a
//! lone surrogate, so a cut in the middle of a pair yields U+FFFD, which is one unit long like the half it replaces: lengths and
//! every later cut agree with TypeScript, and the stored form agrees too (`node:sqlite` writes a lone surrogate as U+FFFD, K5-D4).
use crate::approvals::js_json::J;
use crate::js::{is_js_space, utf16};
use crate::metrics::registry::js_number_to_string;

/// `text.length`.
pub(crate) fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(from, to)` for non-negative bounds.
pub(crate) fn slice(text: &str, from: usize, to: usize) -> String {
    let units = utf16(text);
    let to = to.min(units.len());
    let from = from.min(to);
    String::from_utf16_lossy(&units[from..to])
}

/// `text.slice(-n)`: the last `n` units.
pub(crate) fn tail(text: &str, n: usize) -> String {
    let units = utf16(text);
    let from = units.len().saturating_sub(n);
    String::from_utf16_lossy(&units[from..])
}

/// `text.slice(0, max(n, 0))` for a signed bound.
pub(crate) fn head(text: &str, n: i64) -> String {
    slice(text, 0, n.max(0) as usize)
}

/// `s.replace(/\s+/g, " ").trim()`.
pub(crate) fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out.trim_matches(is_js_space).to_owned()
}

/// `String(value)` of a JSON value as `JSON.parse` leaves it; `None` is a missing member (`undefined`).
pub(crate) fn js_string(v: Option<&J>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(J::Null) => "null".to_owned(),
        Some(J::Bool(b)) => b.to_string(),
        Some(J::Num(n)) => js_number_to_string(*n),
        Some(J::Str(s)) => s.clone(),
        Some(J::Arr(a)) => a
            .iter()
            .map(|x| match x {
                J::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(J::Obj(_)) => "[object Object]".to_owned(),
    }
}

/// `/<words>/i.test(text)` for ASCII words: a non-Unicode JavaScript regular expression folds case through `toUpperCase` and
/// never lets a non-ASCII letter match an ASCII one, so an ASCII-only fold is exact.
pub(crate) fn contains_any_ci(text: &str, words: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    words.iter().any(|w| lower.contains(w))
}
