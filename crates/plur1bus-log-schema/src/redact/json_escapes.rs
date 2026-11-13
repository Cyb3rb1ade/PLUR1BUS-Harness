//! Decode one syntactic JSON-escape layer while retaining sparse source offsets (`json-escapes.ts`); public text is
//! never rewritten by decoding alone. Works on UTF-16 code units, like the TypeScript original, so a lone surrogate
//! escape (`\ud83d`) decodes to the lone unit.
use super::utf16::is_well_formed;

/// The value of a simple JSON escape (`\n` -> 10), `None` for a character that is no escape.
pub(crate) fn simple_escape(unit: i32) -> Option<i32> {
    match unit {
        34 => Some(34),
        92 => Some(92),
        47 => Some(47),
        98 => Some(8),
        102 => Some(12),
        110 => Some(10),
        114 => Some(13),
        116 => Some(9),
        _ => None,
    }
}

/// Value of a hexadecimal digit, `-1` for any other unit.
pub(crate) fn hex_digit(unit: i32) -> i32 {
    match unit {
        48..=57 => unit - 48,
        65..=70 => unit - 55,
        97..=102 => unit - 87,
        _ => -1,
    }
}

/// A decoded view of a string and the way back to its source offsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonEscapeView {
    /// The text with every legal escape replaced by the character it names.
    pub text: Vec<u16>,
    ends: Vec<usize>,
    deltas: Vec<usize>,
}

impl JsonEscapeView {
    /// The offset in the source string of `offset` in [`text`](Self::text).
    pub fn source_offset(&self, offset: usize) -> usize {
        let (mut low, mut high) = (0usize, self.ends.len());
        while low < high {
            let middle = (low + high) >> 1;
            if self.ends[middle] <= offset {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        offset + if low == 0 { 0 } else { self.deltas[low - 1] }
    }
}

/// One legal escape at `at`: its length in source units and the unit it names.
fn escape_at(input: &[u16], at: usize) -> Option<(usize, u16)> {
    if input[at] != 92 {
        return None;
    }
    let next = i32::from(*input.get(at + 1)?);
    if let Some(simple) = simple_escape(next) {
        return u16::try_from(simple).ok().map(|u| (2, u));
    }
    if next == 117 {
        let mut decoded = 0i32;
        for i in 2..6 {
            let digit = hex_digit(i32::from(*input.get(at + i)?));
            if digit < 0 {
                return None;
            }
            decoded = decoded * 16 + digit;
        }
        return u16::try_from(decoded).ok().map(|u| (6, u));
    }
    None
}

/// Only legal escapes change the view. Invalid escapes and every unmatched source unit remain intact. `None` when the
/// input holds no legal escape.
pub fn json_escape_view(input: &[u16]) -> Option<JsonEscapeView> {
    if !input.contains(&92) {
        return None;
    }
    let mut text: Vec<u16> = Vec::with_capacity(input.len());
    let (mut ends, mut deltas) = (Vec::new(), Vec::new());
    let (mut last, mut delta, mut at) = (0usize, 0usize, 0usize);
    while at < input.len() {
        let Some((len, decoded)) = escape_at(input, at) else {
            at += 1;
            continue;
        };
        text.extend_from_slice(&input[last..at]);
        text.push(decoded);
        ends.push(at - delta + 1);
        delta += len - 1;
        deltas.push(delta);
        at += len;
        last = at;
    }
    if last == 0 {
        return None;
    }
    text.extend_from_slice(&input[last..]);
    Some(JsonEscapeView { text, ends, deltas })
}

/// One JSON string token starting at `at` (the opening quote): the index just past the closing quote, or `None`.
/// `"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`.
fn string_token_end(json: &[u16], at: usize) -> Option<usize> {
    let mut i = at + 1;
    while i < json.len() {
        match json[i] {
            34 => return Some(i + 1),
            92 => {
                let (len, _) = escape_at(json, i)?;
                i += len;
            }
            0..=0x1f => return None,
            _ => i += 1,
        }
    }
    None
}

/// Inspect decoded payloads and one nested escape layer only inside strings and keys; structural punctuation is not
/// secret text. Empty when the JSON text has no backslash.
pub fn json_secret_views(json: &[u16]) -> Vec<Vec<u16>> {
    if !json.contains(&92) {
        return Vec::new();
    }
    let mut views: Vec<Vec<u16>> = Vec::new();
    let mut retain = |text: &[u16]| {
        views.push(text.to_vec());
        if !is_well_formed(text) {
            let fixed: Vec<u16> = super::utf16::to_well_formed(text).encode_utf16().collect();
            views.push(fixed);
        }
    };
    let mut at = 0usize;
    while at < json.len() {
        if json[at] != 34 {
            at += 1;
            continue;
        }
        let Some(end) = string_token_end(json, at) else {
            at += 1;
            continue;
        };
        let token = &json[at..end];
        if token.contains(&92) {
            if let Some(payload) = json_escape_view(&token[1..token.len() - 1]) {
                retain(&payload.text);
                if let Some(nested) = json_escape_view(&payload.text) {
                    retain(&nested.text);
                }
            }
        }
        at = end;
    }
    views
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::utf16::utf16;

    fn text(units: &[u16]) -> String {
        String::from_utf16_lossy(units)
    }

    #[test]
    fn only_legal_escapes_change_the_view() {
        let view = json_escape_view(&utf16(r"a\nb\u0041\q\u00zz")).unwrap();
        assert_eq!(text(&view.text), "a\nbA\\q\\u00zz");
        assert!(json_escape_view(&utf16("plain")).is_none());
        assert!(json_escape_view(&utf16(r"\q")).is_none());
    }

    #[test]
    fn source_offsets_map_back_through_every_escape() {
        let source = utf16(r"a\nb\u0041c");
        let view = json_escape_view(&source).unwrap();
        // decoded "a\nbAc": a=0 \n=1 b=2 A=3 c=4; source a=0 \n=1..3 b=3 A=4..10 c=10
        assert_eq!(view.source_offset(0), 0);
        assert_eq!(view.source_offset(2), 3);
        assert_eq!(view.source_offset(4), 10);
    }

    #[test]
    fn secret_views_cover_the_payload_and_one_nested_layer() {
        let json = utf16(r#"{"k":"a\\u0041 \ud83d"}"#);
        let views: Vec<String> = json_secret_views(&json).iter().map(|v| text(v)).collect();
        assert_eq!(views[0], "a\\u0041 \u{fffd}");
        assert!(views.iter().any(|v| v == "aA \u{fffd}"));
        assert!(json_secret_views(&utf16(r#"{"k":"plain"}"#)).is_empty());
    }
}
