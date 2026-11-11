//! Deterministic robust affine fitting and empirical intervals; no filesystem or provider access.

use super::calibration_store::Sample;
use super::{CalibrationFit, TokenBounds, MIN_CALIBRATION_OBSERVATIONS};

// Three scaled MADs tolerate ordinary residual noise; a one-token floor covers integer rounding.
const RESIDUAL_MULTIPLIER: f64 = 3.0 * 1.4826;
const MINIMUM_MARGIN: f64 = 1.0;

pub(super) fn fit(samples: &[Sample]) -> Option<CalibrationFit> {
    if samples.len() < MIN_CALIBRATION_OBSERVATIONS {
        return None;
    }
    let mut slopes = Vec::with_capacity(samples.len() * (samples.len() - 1) / 2);
    for (index, left) in samples.iter().enumerate() {
        for right in &samples[index + 1..] {
            if left.estimated != right.estimated {
                slopes.push(
                    (right.reported as f64 - left.reported as f64)
                        / (right.estimated as f64 - left.estimated as f64),
                );
            }
        }
    }
    let slope = median(&mut slopes)?;
    if !slope.is_finite() || slope <= 0.0 {
        return None;
    }
    let mut offsets: Vec<_> = samples
        .iter()
        .map(|sample| sample.reported as f64 - slope * sample.estimated as f64)
        .collect();
    let intercept = median(&mut offsets)?;
    let mut residuals: Vec<_> = offsets
        .iter()
        .map(|offset| (offset - intercept).abs())
        .collect();
    let residual = median(&mut residuals)?;
    if !intercept.is_finite() || !residual.is_finite() {
        return None;
    }
    Some(CalibrationFit {
        slope,
        intercept,
        residual,
        minimum: samples.iter().map(|sample| sample.estimated).min()?,
        maximum: samples.iter().map(|sample| sample.estimated).max()?,
        observations: samples.len(),
    })
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        values[middle - 1] / 2.0 + values[middle] / 2.0
    } else {
        values[middle]
    })
}

impl CalibrationFit {
    /// Predict a complete prompt with one intercept, outward-rounded empirical bounds and saturation.
    /// Uncertainty widens linearly with distance outside the observed range. This is not a hard
    /// bound on provider framing. Publicly constructed invalid parameters produce the full u64 interval.
    pub fn predict(&self, tokens: u64) -> TokenBounds {
        if !self.slope.is_finite()
            || self.slope <= 0.0
            || !self.intercept.is_finite()
            || !self.residual.is_finite()
            || self.residual < 0.0
            || self.minimum >= self.maximum
        {
            return TokenBounds {
                tokens,
                lower: 0,
                upper: u64::MAX,
            };
        }
        let center = (self.slope * tokens as f64 + self.intercept).max(0.0);
        let distance = self
            .minimum
            .saturating_sub(tokens)
            .max(tokens.saturating_sub(self.maximum));
        let span = (self.maximum - self.minimum) as f64;
        let margin = (self.residual * RESIDUAL_MULTIPLIER).max(MINIMUM_MARGIN)
            * (1.0 + distance as f64 / span);
        // Rust's float-to-u64 casts saturate (including above MAX); max(0) also protects negative fits.
        TokenBounds {
            tokens: center.round() as u64,
            lower: (center - margin).max(0.0).floor() as u64,
            upper: (center + margin).ceil() as u64,
        }
    }
}
