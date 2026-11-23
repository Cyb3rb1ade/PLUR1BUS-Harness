//! Bounds for labels displayed from remote protocol descriptors.

/// Remove invisible display controls and stop at a complete Unicode scalar
/// within the given UTF-16 budget.
pub fn sanitize(text: &str, max_units: usize) -> String {
    let mut units = 0;
    text.chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '\u{00ad}' | '\u{034f}' | '\u{061c}' | '\u{180e}'
                        | '\u{200b}'..='\u{200f}'
                        | '\u{2028}'..='\u{202e}'
                        | '\u{2060}'..='\u{206f}'
                        | '\u{feff}'
                )
        })
        .take_while(|character| {
            units += character.len_utf16();
            units <= max_units
        })
        .collect()
}
