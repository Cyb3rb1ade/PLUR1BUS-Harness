//! Immutable variants for one current secret set (`secret-forms.ts`). Configured values and old generations never
//! accumulate in a cache. Rule 1 of `redaction.json`: an exact value the process holds, plus its base64, base64url, hex
//! and URL-encoded forms, plus its JSON-escaped spelling.
use super::matcher::SecretMatcher;
use super::utf16::{utf16, utf16_len};
use crate::redaction;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

/// The minimum length (UTF-16 code units) of a registered value; shorter ones are not masked (rule `secret`,
/// `minLength`). Only the shared set applies it, operation-scoped credentials may be shorter.
pub fn min_length() -> usize {
    static MIN: OnceLock<usize> = OnceLock::new();
    *MIN.get_or_init(|| {
        redaction()["rules"]
            .as_array()
            .and_then(|rules| rules.iter().find(|r| r["id"] == "secret"))
            .and_then(|r| r["minLength"].as_u64())
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(8)
    })
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64 of `bytes` with the given alphabet, padded with `=` when `pad` is set.
fn base64(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        let symbols = chunk.len() + 1;
        for i in 0..4 {
            if i < symbols {
                out.push(char::from(alphabet[((n >> (18 - 6 * i)) & 63) as usize]));
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn hex(bytes: &[u8], upper: bool) -> String {
    let digits: &[u8; 16] = if upper {
        b"0123456789ABCDEF"
    } else {
        b"0123456789abcdef"
    };
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(digits[usize::from(b >> 4)]));
        out.push(char::from(digits[usize::from(b & 15)]));
    }
    out
}

/// `encodeURIComponent` of a well-formed string.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(b));
        } else {
            out.push('%');
            out.push_str(&hex(&[b], true));
        }
    }
    out
}

/// `JSON.stringify(s).slice(1, -1)`: the JSON string body of a well-formed string.
pub fn json_string_body(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The spellings under which one value is masked: operation-scoped credentials include short values; only the shared set
/// applies the minimum length.
pub fn secret_forms_of(value: &str) -> Vec<String> {
    let bytes = value.as_bytes();
    let b64 = base64(bytes, B64, true);
    let url = base64(bytes, B64_URL, false);
    let padded = format!("{url}{}", "=".repeat((4 - url.len() % 4) % 4));
    let hex_lower = hex(bytes, false);
    let json = json_string_body(value);
    let candidates = [
        value.to_string(),
        value.to_string(), // `value.toWellFormed()`: a Rust string is well-formed already
        b64.clone(),
        b64.trim_end_matches('=').to_string(),
        url,
        padded,
        hex_lower.clone(),
        hex_lower.to_uppercase(),
        encode_uri_component(value),
        json.clone(),
        json.replace('/', "\\/"),
    ];
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|form| seen.insert(form.clone()))
        .collect()
}

/// Exact registered values and canonical encodings, longest first (by UTF-16 length, ties in derivation order); values
/// shorter than [`min_length`] are skipped.
pub fn secret_forms_in<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut forms: Vec<String> = Vec::new();
    let mut seen_forms = HashSet::new();
    let mut seen_values = HashSet::new();
    for value in values {
        if !seen_values.insert(value) || utf16_len(value) < min_length() {
            continue;
        }
        for form in secret_forms_of(value) {
            if seen_forms.insert(form.clone()) {
                forms.push(form);
            }
        }
    }
    forms.sort_by_key(|f| std::cmp::Reverse(utf16_len(f)));
    forms
}

/// The forms of one secret-set generation and the matcher compiled from them.
#[derive(Debug)]
pub struct SecretFormsSnapshot {
    /// Every form, longest first.
    pub forms: Vec<String>,
    /// The automaton over [`forms`](Self::forms).
    pub matcher: Arc<SecretMatcher>,
}

impl SecretFormsSnapshot {
    /// The snapshot of no secret.
    pub fn empty() -> Arc<SecretFormsSnapshot> {
        static EMPTY: OnceLock<Arc<SecretFormsSnapshot>> = OnceLock::new();
        EMPTY
            .get_or_init(|| {
                Arc::new(SecretFormsSnapshot {
                    forms: Vec::new(),
                    matcher: Arc::new(SecretMatcher::new(Vec::new())),
                })
            })
            .clone()
    }

    fn of_values(values: &[String]) -> Arc<SecretFormsSnapshot> {
        let forms = secret_forms_in(values.iter().map(String::as_str));
        let matcher = Arc::new(SecretMatcher::new(forms.iter().map(|f| utf16(f)).collect()));
        Arc::new(SecretFormsSnapshot { forms, matcher })
    }
}

/// One generation, compared by membership rather than by iteration order.
#[derive(Debug)]
pub struct SecretFormsCache {
    values: HashSet<String>,
    snapshot: Arc<SecretFormsSnapshot>,
}

impl Default for SecretFormsCache {
    fn default() -> Self {
        SecretFormsCache {
            values: HashSet::new(),
            snapshot: SecretFormsSnapshot::empty(),
        }
    }
}

impl SecretFormsCache {
    /// The forms of the current generation of `values`; the same snapshot comes back while the membership is the same.
    pub fn snapshot<'a>(
        &mut self,
        values: impl IntoIterator<Item = &'a str>,
    ) -> Arc<SecretFormsSnapshot> {
        let mut ordered: Vec<String> = Vec::new();
        let mut next: HashSet<String> = HashSet::new();
        for value in values {
            if utf16_len(value) >= min_length() && next.insert(value.to_string()) {
                ordered.push(value.to_string());
            }
        }
        if next == self.values {
            return self.snapshot.clone();
        }
        let snapshot = SecretFormsSnapshot::of_values(&ordered);
        self.values = next;
        self.snapshot = snapshot.clone();
        snapshot
    }

    /// The forms of the current generation of `values`, longest first.
    pub fn forms<'a>(&mut self, values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        self.snapshot(values).forms.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoders_match_the_node_buffer_spellings() {
        assert_eq!(base64(b"hunter2hunter2", B64, true), "aHVudGVyMmh1bnRlcjI=");
        assert_eq!(base64(b"ab?>?>", B64, true), "YWI/Pj8+");
        assert_eq!(base64(b"ab?>?>", B64_URL, false), "YWI_Pj8-");
        assert_eq!(base64(b"a", B64, true), "YQ==");
        assert_eq!(base64(b"a", B64_URL, false), "YQ");
        assert_eq!(hex(b"abc", true), "616263".to_uppercase());
        assert_eq!(encode_uri_component("a b/é!"), "a%20b%2F%C3%A9!");
        assert_eq!(json_string_body("a\"\\\n\u{1}/"), "a\\\"\\\\\\n\\u0001/");
    }

    #[test]
    fn forms_are_unique_longest_first_and_skip_short_values() {
        let (a, b) = ("fixture-form-a-0123456789", "fixture-form-b-0123456789");
        let once = secret_forms_in([a, b]);
        assert_eq!(secret_forms_in([a, b, a, a, "short", b]), once);
        assert_eq!(once.iter().collect::<HashSet<_>>().len(), once.len());
        assert!(once.contains(&a.to_string()) && once.contains(&hex(b.as_bytes(), false)));
        assert!(once
            .windows(2)
            .all(|w| utf16_len(&w[0]) >= utf16_len(&w[1])));
        assert!(secret_forms_in(["short"]).is_empty());
    }

    #[test]
    fn the_cache_follows_membership_not_order() {
        let mut cache = SecretFormsCache::default();
        let first = cache.snapshot(["aaaaaaaa-1", "bbbbbbbb-2"]);
        assert!(Arc::ptr_eq(
            &first,
            &cache.snapshot(["bbbbbbbb-2", "aaaaaaaa-1", "short"])
        ));
        let second = cache.snapshot(["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3"]);
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(Arc::ptr_eq(
            &second,
            &cache.snapshot(["cccccccc-3", "aaaaaaaa-1", "bbbbbbbb-2"])
        ));
    }
}
