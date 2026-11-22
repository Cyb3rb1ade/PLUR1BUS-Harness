//! `budget/media.ts`: media units on the call budget (owner decision 2026-10-19). The media package measures a generation in
//! images or video seconds; this maps them onto the call port's `images` and `video_seconds`.
use super::calls::MediaAmounts;
use super::BudgetError;

/// `MediaUnits['unit']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaUnit {
    /// Generated images.
    Image,
    /// Seconds of generated video.
    VideoSecond,
}

/// `MediaUnits`: a generation's usage in its native unit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MediaUnits {
    /// The unit.
    pub unit: MediaUnit,
    /// How many; a video can have a fraction of a second.
    pub quantity: f64,
}

/// `mediaCallUnits`: whole budget units, `n` images, or video seconds rounded up (a 4.2 s clip counts 5). `None` (nothing
/// delivered) is none.
pub fn media_call_units(units: Option<MediaUnits>) -> Result<MediaAmounts, BudgetError> {
    let Some(u) = units else {
        return Ok(MediaAmounts::default());
    };
    if !u.quantity.is_finite() || u.quantity < 0.0 {
        return Err(BudgetError::Range("invalid media units".into()));
    }
    let whole = u.quantity.ceil() as i64;
    Ok(match u.unit {
        MediaUnit::Image => MediaAmounts {
            images: whole,
            video_seconds: 0,
        },
        MediaUnit::VideoSecond => MediaAmounts {
            images: 0,
            video_seconds: whole,
        },
    })
}
