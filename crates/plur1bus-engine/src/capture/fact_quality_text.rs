//! ECMAScript word/phrase matching for the deterministic quality and category ports.
//!
//! Legacy regexes execute on UCS-2; Unicode classes use separately recorded Unicode 17
//! algorithm data. The bounded pattern cache is keyed by exact source and flags.

use super::lexicon::STOP_WORDS;
use crate::{
    contract::EngineError,
    text::js::{self, JsRegex, JsString},
};
use regress::Regex;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

enum Matcher {
    Legacy(Regex),
    Unicode(JsRegex),
}
type PatternCache = HashMap<(String, String), Arc<Matcher>>;
const MAX_PATTERNS: usize = 128;
static PATTERNS: OnceLock<Mutex<PatternCache>> = OnceLock::new();
fn pattern(pattern: &str, flags: &str) -> Result<Arc<Matcher>, EngineError> {
    let mut cache = PATTERNS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let key = (pattern.to_owned(), flags.to_owned());
    if let Some(value) = cache.get(&key) {
        return Ok(value.clone());
    }
    let value = if flags.contains('u') {
        // RE-D17: the pinned runtime is Unicode 17. Existing regex tables omit new
        // letters such as Tolong Siki; expand only the L|N class used by these ports.
        // Data is generated independently from Node, with its Unicode-3.0 notice.
        let pattern = if pattern.contains(r"\p{L}\p{N}") {
            pattern.replace(r"\p{L}\p{N}", letter_number_class()?)
        } else {
            pattern.to_owned()
        };
        Matcher::Unicode(js::js_regex(&pattern, flags).map_err(|_| pattern_error())?)
    } else {
        Matcher::Legacy(Regex::with_flags(pattern, flags).map_err(|_| pattern_error())?)
    };
    let value = Arc::new(value);
    if cache.len() >= MAX_PATTERNS {
        cache.clear();
    }
    cache.insert(key, value.clone());
    Ok(value)
}

fn letter_number_class() -> Result<&'static str, EngineError> {
    use std::fmt::Write;
    static CLASS: OnceLock<Result<String, ()>> = OnceLock::new();
    CLASS
        .get_or_init(|| {
            let data: serde_json::Value =
                serde_json::from_str(include_str!("quality-unicode17.json")).map_err(|_| ())?;
            if data["node"] != "v24.21.0" || data["unicode"] != "17.0" || data["icu"] != "78.3" {
                return Err(());
            }
            let mut out = String::new();
            let mut last = None;
            for range in data["ranges"].as_array().ok_or(())? {
                let start = range[0].as_u64().ok_or(())?;
                let end = range[1].as_u64().ok_or(())?;
                if end > 0x10ffff || start > end || last.is_some_and(|last| start <= last) {
                    return Err(());
                }
                write!(out, "\\x{{{start:X}}}").map_err(|_| ())?;
                if end != start {
                    write!(out, "-\\x{{{end:X}}}").map_err(|_| ())?;
                }
                last = Some(end);
            }
            Ok(out)
        })
        .as_ref()
        .map(String::as_str)
        .map_err(|()| pattern_error())
}
fn pattern_error() -> EngineError {
    EngineError::NotAvailable {
        reason: "fact-quality-pattern".to_owned(),
    }
}

pub(crate) fn pattern_test(
    source: &str,
    flags: &str,
    text: &JsString,
) -> Result<bool, EngineError> {
    match &*pattern(source, flags)? {
        Matcher::Legacy(re) => Ok(re.find_from_ucs2(text.as_utf16_units(), 0).next().is_some()),
        Matcher::Unicode(re) => re
            .is_match(&text.to_utf8_lossy())
            .map_err(|_| pattern_error()),
    }
}

pub(crate) fn pattern_count(
    source: &str,
    flags: &str,
    text: &JsString,
) -> Result<usize, EngineError> {
    match &*pattern(source, flags)? {
        Matcher::Legacy(re) => Ok(re.find_from_ucs2(text.as_utf16_units(), 0).count()),
        Matcher::Unicode(re) => Ok(re
            .find_all(&text.to_utf8_lossy())
            .map_err(|_| pattern_error())?
            .len()),
    }
}

pub(crate) fn replace_pattern(
    source: &str,
    flags: &str,
    text: &JsString,
    replacement: &str,
) -> Result<JsString, EngineError> {
    match &*pattern(source, flags)? {
        Matcher::Legacy(re) => {
            let ranges = re
                .find_from_ucs2(text.as_utf16_units(), 0)
                .map(|m| m.range())
                .collect();
            Ok(replace_ranges(text, ranges, replacement))
        }
        Matcher::Unicode(re) => {
            // Every Unicode replacement here removes non-letter/number codepoints.
            // Lone surrogates and U+FFFD are both removed/replaced by the same rule.
            let text = text.to_utf8_lossy();
            let matches = re.find_all(&text).map_err(|_| pattern_error())?;
            let mut out = String::new();
            let mut end = 0;
            for found in matches {
                out.push_str(text.get(end..found.byte_start).ok_or_else(pattern_error)?);
                out.push_str(replacement);
                end = found.byte_end;
            }
            out.push_str(text.get(end..).ok_or_else(pattern_error)?);
            Ok(JsString::from(out))
        }
    }
}

fn replace_ranges(text: &JsString, ranges: Vec<Range<usize>>, replacement: &str) -> JsString {
    let units = text.as_utf16_units();
    let replacement = JsString::from(replacement);
    let mut out = Vec::new();
    let mut end = 0;
    for range in ranges {
        if let Some(before) = units.get(end..range.start) {
            out.extend_from_slice(before);
        }
        out.extend_from_slice(replacement.as_utf16_units());
        end = range.end;
    }
    if let Some(after) = units.get(end..) {
        out.extend_from_slice(after);
    }
    JsString::from_utf16_units(out)
}

pub(crate) fn trim(text: &JsString) -> JsString {
    let whitespace =
        |unit: &u16| char::from_u32(u32::from(*unit)).is_some_and(js::is_js_whitespace);
    let units = text.as_utf16_units();
    let start = units
        .iter()
        .position(|u| !whitespace(u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !whitespace(u))
        .map_or(start, |i| i + 1);
    JsString::from_utf16_units(units.get(start..end).unwrap_or_default().to_vec())
}

pub(crate) fn lower(text: &JsString) -> JsString {
    let mut out = Vec::new();
    let mut chunk = String::new();
    for unit in char::decode_utf16(text.as_utf16_units().iter().copied()) {
        match unit {
            Ok(ch) => chunk.push(ch),
            Err(error) => {
                out.extend(js::js_to_lower_case(&chunk).encode_utf16());
                chunk.clear();
                out.push(error.unpaired_surrogate());
            }
        }
    }
    out.extend(js::js_to_lower_case(&chunk).encode_utf16());
    JsString::from_utf16_units(out)
}
pub(crate) fn normalize(text: &JsString) -> JsString {
    trim(&lower(text))
}
pub(crate) fn concat(parts: &[&JsString]) -> JsString {
    JsString::from_utf16_units(
        parts
            .iter()
            .flat_map(|p| p.as_utf16_units().iter().copied())
            .collect(),
    )
}
pub(crate) fn join(parts: &[JsString], separator: &str) -> JsString {
    let mut out = Vec::new();
    let separator = JsString::from(separator);
    for (index, part) in parts.iter().enumerate() {
        if index != 0 {
            out.extend_from_slice(separator.as_utf16_units());
        }
        out.extend_from_slice(part.as_utf16_units());
    }
    JsString::from_utf16_units(out)
}

pub(crate) fn split_whitespace(text: &JsString) -> Vec<JsString> {
    let units = text.as_utf16_units();
    let mut result = Vec::new();
    let mut start = 0;
    let mut cursor = 0;
    while cursor < units.len() {
        if char::from_u32(u32::from(units[cursor])).is_some_and(js::is_js_whitespace) {
            result.push(JsString::from_utf16_units(units[start..cursor].to_vec()));
            cursor += 1;
            while cursor < units.len()
                && char::from_u32(u32::from(units[cursor])).is_some_and(js::is_js_whitespace)
            {
                cursor += 1;
            }
            start = cursor;
        } else {
            cursor += 1;
        }
    }
    result.push(JsString::from_utf16_units(units[start..].to_vec()));
    result
}

pub(crate) fn tokenize(text: &JsString) -> Result<Vec<String>, EngineError> {
    let cleaned = replace_pattern(r"[^\p{L}\p{N}\s]", "u", &normalize(text), " ")?;
    Ok(split_whitespace(&cleaned)
        .into_iter()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_utf8_lossy())
        .collect())
}
pub(crate) fn content_count(text: &JsString) -> Result<usize, EngineError> {
    Ok(tokenize(text)?
        .iter()
        .filter(|token| js::utf16_len(token) > 1 && !STOP_WORDS.contains(&token.as_str()))
        .count())
}
pub(crate) fn contains_any(text: &JsString, words: &[&str]) -> Result<bool, EngineError> {
    Ok(tokenize(text)?
        .iter()
        .any(|token| words.contains(&token.as_str())))
}
pub(crate) fn contains_named_entity(text: &JsString) -> Result<bool, EngineError> {
    for word in split_whitespace(text) {
        let clean = replace_pattern(r"[^\p{L}\p{N}\-]", "u", &word, "")?;
        if clean.utf16_len() > 1
            && pattern_test(r"^[A-ZÄÖÜ][a-zäöüß\-]*(?:\.[a-z]+)?$", "u", &clean)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(crate) fn contains_phrase(text: &JsString, phrases: &[&str]) -> Result<bool, EngineError> {
    let lower = normalize(text);
    for phrase in phrases {
        let mut escaped = String::new();
        for ch in phrase.chars() {
            if ".*+?^${}()|[]\\".contains(ch) {
                escaped.push('\\');
            }
            escaped.push(ch);
        }
        let body = escaped
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(r"\s*[^\p{L}\p{N}]*\s*");
        if pattern_test(
            &format!(r"(?<![\p{{L}}\p{{N}}]){body}(?![\p{{L}}\p{{N}}])"),
            "iu",
            &lower,
        )? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_pattern_cache_keeps_existing_matchers_valid() -> Result<(), EngineError> {
        let old = pattern("^quality-cache$", "")?;
        PATTERNS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        let new = pattern("^quality-cache$", "")?;
        assert!(!Arc::ptr_eq(&old, &new));
        assert!(match &*old {
            Matcher::Legacy(regex) => regex.find("quality-cache").is_some(),
            Matcher::Unicode(_) => false,
        });
        assert!(pattern_test(
            "^quality-cache$",
            "",
            &JsString::from("quality-cache")
        )?);
        Ok(())
    }
    #[test]
    #[allow(clippy::unwrap_used, reason = "recorded Unicode boundary assertions")]
    fn unicode17_property_boundaries_and_production_data_hash_match_the_node_recorder() {
        use sha2::{Digest, Sha256};
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/capture/golden/quality.json"
        ))
        .unwrap();
        let data = include_str!("quality-unicode17.json");
        assert_eq!(
            format!("{:x}", Sha256::digest(data.as_bytes())),
            golden["provenance"]["productionDataSha256"]
                .as_str()
                .unwrap()
        );
        for entry in golden["unicodeChecks"].as_array().unwrap() {
            let codepoint = u32::try_from(entry["codepoint"].as_u64().unwrap()).unwrap();
            let input = if let Some(ch) = char::from_u32(codepoint) {
                JsString::from(ch.to_string())
            } else {
                JsString::from_utf16_units(vec![u16::try_from(codepoint).unwrap()])
            };
            assert_eq!(
                pattern_test(r"[\p{L}\p{N}]", "u", &input).unwrap(),
                entry["matches"].as_bool().unwrap(),
                "U+{codepoint:04X}"
            );
        }
    }
}
