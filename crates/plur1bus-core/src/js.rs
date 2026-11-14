//! JavaScript semantics the ported code needs (P4-12 R5). One module, each helper proved against vectors recorded from Node
//! (`scripts/parity/export-js.ts`, `fixtures/parity/js/`).
//!
//! JavaScript strings are sequences of UTF-16 code units and can hold a lone surrogate; a Rust `str` cannot. Helpers that
//! must give the JavaScript answer for every string therefore have a `*_units` form over `&[u16]`; the `&str` forms are
//! thin wrappers for the (well-formed) strings Rust code holds. A lone surrogate that reaches a place which needs a Rust
//! string is turned into U+FFFD (`String::from_utf16_lossy`), which is what `Buffer.from(s, "utf8")` and `toWellFormed` do.
//!
//! - lengths: [`utf16_len`]; `trim`: [`js_trim`], [`trim_units`]; the `\s` class: [`is_js_space`], [`is_space_unit`];
//! - `toUpperCase` / `toLowerCase`: [`to_upper_case`], [`to_lower_case`] (full Unicode case mapping, no locale);
//! - `\w` and ASCII-only `\b`: [`is_word_unit`], [`is_boundary`] (a letter such as `ü` is **not** a word character);
//! - case-insensitive matching of a non-Unicode regular expression (`/i` without `/u`): [`canonicalize_unit`],
//!   [`eq_ignore_case`] (the spec's `Canonicalize`: upper-case the unit; keep it when the result is not one unit, or when it
//!   would turn a non-ASCII unit into an ASCII one, so `ſ` (U+017F) and `K` (Kelvin sign) never match `s` and `k`; `ß`,
//!   `İ` and `ı` stay themselves; among the non-ASCII letters of the scanner patterns only `ü` and `Ü` match each other);
//! - the default `Array.prototype.sort` order: [`compare_utf16`], [`sort_default`];
//! - `JSON.stringify` of a string: [`json_stringify`], [`json_stringify_units`].
pub use plur1bus_config::privacy_ack::js_trim;
pub use plur1bus_log_schema::redact::utf16::{utf16, utf16_len};
use std::cmp::Ordering;

/// One `\s` / `trim` character: white space and line terminators of ECMAScript (`WhiteSpace` and `LineTerminator`).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// [`is_js_space`] of one UTF-16 code unit (a surrogate is not white space).
pub fn is_space_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(is_js_space)
}

/// `text.trim()` over code units.
pub fn trim_units(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|u| !is_space_unit(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !is_space_unit(*u))
        .map_or(start, |i| i + 1);
    &units[start..end]
}

/// `text.toUpperCase()` (full case mapping without locale: `ß` becomes `SS`).
pub fn to_upper_case(text: &str) -> String {
    text.to_uppercase()
}

/// `text.toLowerCase()` (full case mapping without locale, final sigma included).
pub fn to_lower_case(text: &str) -> String {
    text.to_lowercase()
}

/// `\w` of a regular expression without the `u` and `i`-with-Unicode-folding quirks: `[A-Za-z0-9_]`, ASCII only.
pub fn is_word_unit(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f)
}

/// `\b` at index `i` (between `units[i - 1]` and `units[i]`; the ends count as non-word).
pub fn is_boundary(units: &[u16], i: usize) -> bool {
    let before = i > 0 && units.get(i - 1).is_some_and(|u| is_word_unit(*u));
    let after = units.get(i).is_some_and(|u| is_word_unit(*u));
    before != after
}

/// `Canonicalize(ch)` of a regular expression with the `i` flag and without `u` (ECMA-262, `RegExp` abstract operations).
pub fn canonicalize_unit(u: u16) -> u16 {
    let Some(c) = char::from_u32(u32::from(u)) else {
        return u; // a lone surrogate upper-cases to itself
    };
    let mut upper = c.to_uppercase();
    let (Some(first), None) = (upper.next(), upper.next()) else {
        return u; // more than one character: not one code unit
    };
    let mut buf = [0u16; 2];
    if first.encode_utf16(&mut buf).len() != 1 {
        return u;
    }
    let cu = buf[0];
    if u >= 128 && cu < 128 {
        return u;
    }
    cu
}

/// Two code units match under `/i` (non-Unicode): their canonical forms are equal.
pub fn eq_ignore_case(a: u16, b: u16) -> bool {
    a == b || canonicalize_unit(a) == canonicalize_unit(b)
}

/// Order of two strings by UTF-16 code unit, the order `Array.prototype.sort()` uses without a comparator.
pub fn compare_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `list.sort()` of strings (default comparator; stable).
pub fn sort_default(list: &mut [String]) {
    list.sort_by(|a, b| compare_utf16(a, b));
}

/// `JSON.stringify(text)` over code units: quotes, the short escapes, `\u00xx` for other controls, `\udxxx` (lower case) for a
/// lone surrogate; U+2028, U+2029 and DEL are not escaped.
pub fn json_stringify_units(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

/// `JSON.stringify(text)`.
pub fn json_stringify(text: &str) -> String {
    json_stringify_units(&utf16(text))
}

#[cfg(test)]
mod tests;
