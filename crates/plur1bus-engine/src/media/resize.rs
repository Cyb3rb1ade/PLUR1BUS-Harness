//! Pillow-compatible RGB bicubic resampling for the MM-1 image tensor edge.
//! Uses the cubic convolution kernel and 22-bit, per-pass rounding of Pillow 12.3.0.

use super::image::ImageError;
use crate::contract::Cancel;

const PRECISION_BITS: u32 = 22;
const ROUNDING: i64 = 1 << (PRECISION_BITS - 1);
const MAX_INTERMEDIATE_BYTES: usize = 64 * 1024 * 1024;

struct Kernel {
    start: usize,
    weights: Vec<i32>,
}

/// Resize RGB bytes with Pillow BICUBIC rounding, checking cancellation between rows.
pub(super) fn bicubic_rgb(
    rgb: &[u8],
    width: usize,
    height: usize,
    out_width: usize,
    out_height: usize,
    cancel: &Cancel,
) -> Result<Vec<u8>, ImageError> {
    cancel.check().map_err(ImageError::Cancelled)?;
    if width == out_width && height == out_height {
        return Ok(rgb.to_vec());
    }
    // A one-column horizontal pass copies the same byte to every output column.
    // Resample that single column once, then expand; this preserves per-pass rounding
    // while avoiding repeated work for very tall, narrow inputs.
    if width == 1 && out_width > 1 {
        let column = bicubic_rgb(rgb, 1, height, 1, out_height, cancel)?;
        return expand_column(&column, out_width, cancel);
    }
    let mut horizontal = Vec::with_capacity(out_width);
    for x in 0..out_width {
        cancel.check().map_err(ImageError::Cancelled)?;
        horizontal.push(kernel(width, out_width, x));
    }
    let row_bytes = out_width * 3;
    let mut output = vec![0; row_bytes * out_height];
    // Normal photos fit this cache. Extreme portrait inputs use a row at a time,
    // avoiding an input-height × output-width intermediate above the MM-1 budget.
    let cached = if width != out_width
        && row_bytes
            .checked_mul(height)
            .is_some_and(|size| size <= MAX_INTERMEDIATE_BYTES)
    {
        let mut buffer = vec![0; row_bytes * height];
        for (y, row) in buffer.chunks_exact_mut(row_bytes).enumerate() {
            cancel.check().map_err(ImageError::Cancelled)?;
            horizontal_row(&rgb[y * width * 3..(y + 1) * width * 3], &horizontal, row);
        }
        Some(buffer)
    } else {
        None
    };
    let mut row = vec![0; row_bytes];
    for (y, destination) in output.chunks_exact_mut(row_bytes).enumerate() {
        cancel.check().map_err(ImageError::Cancelled)?;
        let vertical = kernel(height, out_height, y);
        let mut sums = vec![ROUNDING; row_bytes];
        for (dy, &weight) in vertical.weights.iter().enumerate() {
            let source_y = vertical.start + dy;
            let source = if let Some(buffer) = &cached {
                &buffer[source_y * row_bytes..(source_y + 1) * row_bytes]
            } else if width == out_width {
                &rgb[source_y * row_bytes..(source_y + 1) * row_bytes]
            } else {
                cancel.check().map_err(ImageError::Cancelled)?;
                horizontal_row(
                    &rgb[source_y * width * 3..(source_y + 1) * width * 3],
                    &horizontal,
                    &mut row,
                );
                &row
            };
            for (sum, &value) in sums.iter_mut().zip(source) {
                *sum += i64::from(value) * i64::from(weight);
            }
        }
        for (value, sum) in destination.iter_mut().zip(sums) {
            *value = clip(sum);
        }
    }
    Ok(output)
}

fn expand_column(column: &[u8], width: usize, cancel: &Cancel) -> Result<Vec<u8>, ImageError> {
    let mut output = Vec::with_capacity(column.len() * width);
    for pixel in column.chunks_exact(3) {
        cancel.check().map_err(ImageError::Cancelled)?;
        for _ in 0..width {
            output.extend_from_slice(pixel);
        }
    }
    Ok(output)
}

fn horizontal_row(source: &[u8], kernels: &[Kernel], destination: &mut [u8]) {
    for (pixel, kernel) in destination.chunks_exact_mut(3).zip(kernels) {
        let mut sums = [ROUNDING; 3];
        for (dx, &weight) in kernel.weights.iter().enumerate() {
            for channel in 0..3 {
                sums[channel] +=
                    i64::from(source[(kernel.start + dx) * 3 + channel]) * i64::from(weight);
            }
        }
        for (value, sum) in pixel.iter_mut().zip(sums) {
            *value = clip(sum);
        }
    }
}

fn kernel(input: usize, output: usize, position: usize) -> Kernel {
    if input == output {
        return Kernel {
            start: position,
            weights: vec![1 << PRECISION_BITS],
        };
    }
    // Pillow's resize box is float32; retain that rounding before double arithmetic.
    let scale = f64::from(input as f32) / output as f64;
    let filter_scale = scale.max(1.0);
    let support = 2.0 * filter_scale;
    let center = (position as f64 + 0.5) * scale;
    let start = ((center - support + 0.5) as isize).max(0) as usize;
    let end = ((center + support + 0.5) as usize).min(input);
    let inverse = 1.0 / filter_scale;
    let mut weights: Vec<_> = (start..end)
        .map(|x| cubic((x as f64 - center + 0.5) * inverse))
        .collect();
    let sum: f64 = weights.iter().sum();
    for weight in &mut weights {
        if sum != 0.0 {
            *weight /= sum;
        }
    }
    let weights = weights
        .into_iter()
        .map(|weight| {
            let scaled = weight * f64::from(1 << PRECISION_BITS);
            (scaled + if weight < 0.0 { -0.5 } else { 0.5 }) as i32
        })
        .collect();
    Kernel { start, weights }
}

fn cubic(value: f64) -> f64 {
    let x = value.abs();
    if x < 1.0 {
        return (1.5 * x - 2.5) * x * x + 1.0;
    }
    if x < 2.0 {
        return (((x - 5.0) * x + 8.0) * x - 4.0) * -0.5;
    }
    0.0
}

fn clip(value: i64) -> u8 {
    (value >> PRECISION_BITS).clamp(0, 255) as u8
}
