//! The neutral kit's sRGB contrast computation.
pub const BODY_CONTRAST: f64 = 4.5;
pub const LARGE_TEXT_CONTRAST: f64 = 3.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidColour;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// Parse the four hexadecimal CSS spellings accepted by the document design kit.
    pub fn from_hex(input: &str) -> Result<Self, InvalidColour> {
        let input = input.trim();
        let digits = input.strip_prefix('#').unwrap_or(input);
        if !matches!(digits.len(), 3 | 4 | 6 | 8)
            || !digits.bytes().all(|digit| digit.is_ascii_hexdigit())
        {
            return Err(InvalidColour);
        }
        let stride = if digits.len() <= 4 { 1 } else { 2 };
        let channel = |start: usize| {
            let offset = start * stride;
            let value = u8::from_str_radix(&digits[offset..offset + stride], 16)
                .map_err(|_| InvalidColour)?;
            Ok(if stride == 1 { value * 17 } else { value })
        };
        Ok(Self(channel(0)?, channel(1)?, channel(2)?))
    }

    pub fn luminance(self) -> f64 {
        let channel = |c| {
            let value = f64::from(c) / 255.;
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(self.0) + 0.7152 * channel(self.1) + 0.0722 * channel(self.2)
    }
}

pub fn ratio(foreground: &str, background: &str) -> Result<f64, InvalidColour> {
    let first = Rgb::from_hex(foreground)?.luminance();
    let second = Rgb::from_hex(background)?.luminance();
    Ok((first.max(second) + 0.05) / (first.min(second) + 0.05))
}
