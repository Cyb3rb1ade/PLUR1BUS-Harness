//! UTF-16 helpers: the TypeScript redactor counts and cuts strings in UTF-16 code units, so the exact-value matcher does
//! too. A Rust `str` is well-formed UTF-8 and cannot hold a lone surrogate; the `*_units` functions take the code units
//! themselves, for input that came from JavaScript (or from a test that pins a lone surrogate).

/// `str.length` of JavaScript: the number of UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The code units of `s`.
pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `unit` is a lead (high) surrogate.
pub(crate) fn is_high(unit: i32) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}

/// `unit` is a trail (low) surrogate.
pub(crate) fn is_low(unit: i32) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

/// `String.prototype.toWellFormed`: every lone surrogate becomes U+FFFD.
pub fn to_well_formed(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `String.prototype.isWellFormed`.
pub fn is_well_formed(units: &[u16]) -> bool {
    char::decode_utf16(units.iter().copied()).all(|r| r.is_ok())
}

/// Bytes `Buffer.byteLength` reports for the string with these units (a lone surrogate encodes as U+FFFD, three bytes).
pub fn utf8_len(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.map_or(3, char::len_utf8))
        .sum()
}

/// `wellFormedPrefix` of `utf16.ts` over code units: bound work to the retained prefix and avoid creating a dangling
/// high surrogate at its cut. `limit` counts UTF-16 code units.
pub fn well_formed_prefix_units(text: &[u16], limit: usize) -> String {
    let mut end = limit.min(text.len());
    if end < text.len() && end > 0 && is_high(i32::from(text[end - 1])) {
        end -= 1;
    }
    to_well_formed(&text[..end])
}

/// `wellFormedPrefix` of `utf16.ts`: the first `limit` UTF-16 code units of `text`, without a dangling high surrogate at
/// the cut. A Rust string is already well-formed; the cut can only split a surrogate pair, and then drops the pair's
/// high half, as the TypeScript function does.
pub fn well_formed_prefix(text: &str, limit: usize) -> String {
    well_formed_prefix_units(&utf16(text), limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prefix_never_ends_in_half_a_pair() {
        assert_eq!(well_formed_prefix("ab😀c", 3), "ab");
        assert_eq!(well_formed_prefix("ab😀c", 4), "ab😀");
        assert_eq!(well_formed_prefix("abc", 10), "abc");
        assert_eq!(well_formed_prefix("abc", 0), "");
        assert_eq!(well_formed_prefix("😀", 1), "");
    }

    #[test]
    fn lone_surrogates_become_the_replacement_character() {
        assert_eq!(well_formed_prefix_units(&[0x61, 0xd83d], 5), "a\u{fffd}");
        assert_eq!(well_formed_prefix_units(&[0x61, 0xd83d, 0x62], 2), "a");
        assert!(!is_well_formed(&[0xdc00]));
        assert_eq!(utf8_len(&[0xd83d]), 3);
        assert_eq!(utf16_len("é😀"), 3);
    }
}
