//! Cuts of a JavaScript string at UTF-16 code units, for ported code that clips text (`text.slice(0, n)`, `trimEnd`, a
//! `safeKeep` length) and whose result reaches a prompt or a model request byte for byte.
//!
//! A JavaScript `slice` can cut a surrogate pair in two and leave a lone high surrogate at the end. A Rust `String`
//! cannot hold one, so [`prefix_lossy`] and [`slice_lossy`] put U+FFFD in its place, which is what `toWellFormed` and
//! `Buffer.from(s, "utf8")` make of it. The length in code units is the same either way, so every later comparison
//! against a cap takes the same branch. The vectors that cover a cut pair are in `fixtures/parity/prompt/skills.json`
//! and `fixtures/parity/decision/` (cases with `$u16` in the TypeScript answer).
use super::is_space_unit;

/// Whether `u` is a high (leading) surrogate.
pub fn is_high_surrogate(u: u16) -> bool {
    (0xd800..=0xdbff).contains(&u)
}

/// `text.slice(start, end)` for non-negative indices, in code units, as a well-formed string (a half pair is U+FFFD).
pub fn slice_lossy(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(&units[start..end])
}

/// `text.slice(0, n)` in code units, as a well-formed string (a half pair at the cut is U+FFFD).
pub fn prefix_lossy(text: &str, n: usize) -> String {
    // The common case costs no allocation of code units: a text of at most `n` bytes has at most `n` units.
    if text.len() <= n {
        return text.to_owned();
    }
    slice_lossy(text, 0, n)
}

/// `text.trimEnd()` over code units.
pub fn trim_end_units(units: &[u16]) -> &[u16] {
    let end = units
        .iter()
        .rposition(|u| !is_space_unit(*u))
        .map_or(0, |i| i + 1);
    &units[..end]
}

/// The `safeKeep` of the TypeScript join and prompt builder: `keep`, or one less when that would end on a high
/// surrogate, so a character outside the BMP is kept or cut whole. `keep` is clamped to the text.
pub fn safe_keep(units: &[u16], keep: usize) -> usize {
    let keep = keep.min(units.len());
    if keep == 0 {
        return 0;
    }
    if is_high_surrogate(units[keep - 1]) {
        keep - 1
    } else {
        keep
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_pair_becomes_the_replacement_character_and_keeps_its_length() {
        let text = "ab\u{1f600}c";
        assert_eq!(prefix_lossy(text, 2), "ab");
        assert_eq!(prefix_lossy(text, 3), "ab\u{fffd}");
        assert_eq!(prefix_lossy(text, 3).encode_utf16().count(), 3);
        assert_eq!(prefix_lossy(text, 4), "ab\u{1f600}");
        assert_eq!(prefix_lossy(text, 99), text);
        assert_eq!(slice_lossy(text, 3, 5), "\u{fffd}c");
        assert_eq!(slice_lossy(text, 9, 2), "");
    }

    #[test]
    fn safe_keep_never_ends_on_a_high_surrogate() {
        let units: Vec<u16> = "a\u{1f600}b".encode_utf16().collect();
        assert_eq!(safe_keep(&units, 0), 0);
        assert_eq!(safe_keep(&units, 1), 1);
        assert_eq!(safe_keep(&units, 2), 1);
        assert_eq!(safe_keep(&units, 3), 3);
        assert_eq!(safe_keep(&units, 40), 4);
    }

    #[test]
    fn trim_end_takes_javascript_white_space_only() {
        let units: Vec<u16> = " a \u{a0}\u{feff}\n\u{85}\u{3000} "
            .encode_utf16()
            .collect();
        let kept = String::from_utf16_lossy(trim_end_units(&units));
        assert_eq!(kept, " a \u{a0}\u{feff}\n\u{85}");
        assert!(trim_end_units(&[0x20, 0x09]).is_empty());
    }
}
