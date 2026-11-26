//! Bounds for labels displayed from remote protocol descriptors.

use icu_properties::{
    props::{DefaultIgnorableCodePoint, GeneralCategory},
    CodePointMapData, CodePointSetData,
};

/// Remove invisible display controls and stop at a complete Unicode scalar
/// within the given UTF-16 budget.
pub fn sanitize(text: &str, max_units: usize) -> String {
    let mut units = 0;
    let categories = CodePointMapData::<GeneralCategory>::new();
    let ignorable = CodePointSetData::new::<DefaultIgnorableCodePoint>();
    text.chars()
        .filter(|&ch| {
            !matches!(
                categories.get(ch),
                GeneralCategory::Control
                    | GeneralCategory::Format
                    | GeneralCategory::PrivateUse
                    | GeneralCategory::Unassigned
                    | GeneralCategory::LineSeparator
                    | GeneralCategory::ParagraphSeparator
            ) && !ignorable.contains(ch)
        })
        .take_while(|character| {
            units += character.len_utf16();
            units <= max_units
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    fn assert_removed(characters: &[char]) {
        for &ch in characters {
            assert_eq!(
                sanitize(&format!("A{ch}B"), 2),
                "AB",
                "U+{:04X}",
                u32::from(ch)
            );
        }
    }

    #[test]
    fn removes_control() {
        assert_removed(&['\u{0001}']);
    }

    #[test]
    fn removes_format() {
        assert_removed(&[
            '\u{0600}',
            '\u{2068}',
            '\u{feff}',
            '\u{e0041}',
            '\u{fff9}',
            '\u{1d173}',
        ]);
    }

    #[test]
    fn removes_private_use() {
        assert_removed(&['\u{e000}']);
    }

    #[test]
    fn removes_unassigned() {
        assert_removed(&['\u{0378}']);
    }

    #[test]
    fn removes_line_separator() {
        assert_removed(&['\u{2028}']);
    }

    #[test]
    fn removes_paragraph_separator() {
        assert_removed(&['\u{2029}']);
    }

    #[test]
    fn removes_default_ignorables() {
        assert_removed(&[
            '\u{e0100}',
            '\u{fe0f}',
            '\u{180b}',
            '\u{115f}',
            '\u{1160}',
            '\u{3164}',
            '\u{ffa0}',
        ]);
    }

    #[test]
    fn stops_at_a_complete_scalar_within_utf16_budget() {
        assert_eq!(sanitize("A🌱Ω", 3), "A🌱");
        assert_eq!(sanitize("A🌱Ω", 2), "A");
    }
}
