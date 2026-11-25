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

    #[test]
    fn display_fields_exclude_control_categories_and_default_ignorables() {
        for ch in [
            '\u{0001}',
            '\u{0600}',
            '\u{e000}',
            '\u{0378}',
            '\u{2028}',
            '\u{2029}',
            '\u{2068}',
            '\u{feff}',
            '\u{e0041}',
            '\u{e0100}',
            '\u{fe0f}',
            '\u{fff9}',
            '\u{1d173}',
            '\u{180b}',
            '\u{115f}',
            '\u{1160}',
            '\u{3164}',
            '\u{ffa0}',
        ] {
            assert_eq!(
                sanitize(&format!("A{ch}B"), 2),
                "AB",
                "U+{:04X}",
                u32::from(ch)
            );
        }
        assert_eq!(sanitize("A🌱Ω", 3), "A🌱");
        assert_eq!(sanitize("A🌱Ω", 2), "A");
    }
}
