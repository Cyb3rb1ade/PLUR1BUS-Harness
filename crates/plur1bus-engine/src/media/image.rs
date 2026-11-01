//! Bounded JPEG, PNG and WebP decoding and Gemma4 image patch preprocessing (MM-1).

use crate::contract::{Cancel, Cancelled};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::fmt;
use std::io::Cursor;

/// Largest accepted encoded image (MM-1 bounded decode edge).
pub const MAX_ENCODED_BYTES: usize = 64 * 1024 * 1024;
/// Largest accepted decoded pixel count (MM-1).
pub const MAX_DECODED_PIXELS: u64 = 40_000_000;
/// Decoder allocation budget, including its output image (MM-1).
pub const MAX_DECODED_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum model-supported image soft-token budget; production photos use 140.
pub const MAX_SOFT_TOKENS: usize = 280;
const PATCH_SIZE: usize = 16;
const POOL_SIZE: usize = 3;
const PATCH_DIM: usize = PATCH_SIZE * PATCH_SIZE * 3;

/// Owned batch-one Gemma4 inputs with padded HWC 16×16 RGB patches.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageTensor {
    /// Float32 pixels shaped [1, max_patches, 768], scaled by 1/255.
    pub pixels: Vec<f32>,
    /// Int64 [column, row] coordinates shaped [1, max_patches, 2]; padding is -1.
    pub positions: Vec<i64>,
    /// Padded patch count, equal to the requested budget times nine.
    pub max_patches: usize,
    /// Valid pooled image features; padding contributes none.
    pub soft_tokens: usize,
}

/// Failures at the bounded image preprocessing edge.
#[derive(Debug)]
pub enum ImageError {
    /// Caller cancellation or deadline expiry.
    Cancelled(Cancelled),
    /// The requested soft-token count is outside 1..=280.
    InvalidBudget(usize),
    /// The encoded input exceeds the 64 MiB limit.
    EncodedLimit,
    /// The image dimensions exceed the decoded pixel limit.
    PixelLimit,
    /// Decoded output exceeds the memory limit.
    AllocationLimit,
    /// The encoded type is not JPEG, PNG or WebP.
    UnsupportedFormat,
    /// A decoder rejected the encoded image or metadata.
    Decode(image::ImageError),
}

/// Preprocess encoded JPEG/PNG/WebP bytes, with a 1..=280 soft-token budget and cancellation.
/// Refuses encoded input over 64 MiB, decoded images over 40 million pixels or 64 MiB.
pub fn preprocess(
    bytes: &[u8],
    soft_tokens: usize,
    cancel: &Cancel,
) -> Result<ImageTensor, ImageError> {
    cancel.check().map_err(ImageError::Cancelled)?;
    if !(1..=MAX_SOFT_TOKENS).contains(&soft_tokens) {
        return Err(ImageError::InvalidBudget(soft_tokens));
    }
    if bytes.len() > MAX_ENCODED_BYTES {
        return Err(ImageError::EncodedLimit);
    }
    let decoded = decode(bytes, cancel)?;
    cancel.check().map_err(ImageError::Cancelled)?;
    let width = decoded.width() as usize;
    let height = decoded.height() as usize;
    let rgb = composite_rgb(decoded, cancel)?;
    let max_patches = soft_tokens * POOL_SIZE * POOL_SIZE;
    let (out_width, out_height) = target_size(width, height, max_patches);
    let resized = super::resize::bicubic_rgb(&rgb, width, height, out_width, out_height, cancel)?;
    cancel.check().map_err(ImageError::Cancelled)?;
    patchify(&resized, out_width, out_height, max_patches, cancel)
}

fn decode(bytes: &[u8], cancel: &Cancel) -> Result<DynamicImage, ImageError> {
    let format = image::guess_format(bytes).map_err(|_| ImageError::UnsupportedFormat)?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
    ) {
        return Err(ImageError::UnsupportedFormat);
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODED_PIXELS as u32);
    limits.max_image_height = Some(MAX_DECODED_PIXELS as u32);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(ImageError::Decode)?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_DECODED_PIXELS {
        return Err(ImageError::PixelLimit);
    }
    if decoder.total_bytes() > MAX_DECODED_BYTES {
        return Err(ImageError::AllocationLimit);
    }
    let orientation = decoder.orientation().map_err(ImageError::Decode)?;
    cancel.check().map_err(ImageError::Cancelled)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(ImageError::Decode)?;
    cancel.check().map_err(ImageError::Cancelled)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

fn composite_rgb(decoded: DynamicImage, cancel: &Cancel) -> Result<Vec<u8>, ImageError> {
    if !decoded.color().has_alpha() {
        return Ok(decoded.into_rgb8().into_raw());
    }
    let rgba = decoded.into_rgba8();
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for row in rgba.as_raw().chunks(rgba.width() as usize * 4) {
        cancel.check().map_err(ImageError::Cancelled)?;
        for pixel in row.chunks_exact(4) {
            let alpha = u32::from(pixel[3]);
            for &channel in &pixel[..3] {
                rgb.push(((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8);
            }
        }
    }
    Ok(rgb)
}

fn target_size(width: usize, height: usize, max_patches: usize) -> (usize, usize) {
    let multiple = POOL_SIZE * PATCH_SIZE;
    let factor = ((max_patches * PATCH_SIZE * PATCH_SIZE) as f64 / (width * height) as f64).sqrt();
    let mut out_height = (factor * height as f64 / multiple as f64).floor() as usize * multiple;
    let mut out_width = (factor * width as f64 / multiple as f64).floor() as usize * multiple;
    let max_side = max_patches / (POOL_SIZE * POOL_SIZE) * multiple;
    if out_height == 0 {
        out_height = multiple;
        out_width = (width / height * multiple).min(max_side);
    } else if out_width == 0 {
        out_width = multiple;
        out_height = (height / width * multiple).min(max_side);
    }
    (out_width, out_height)
}

fn patchify(
    rgb: &[u8],
    width: usize,
    height: usize,
    max_patches: usize,
    cancel: &Cancel,
) -> Result<ImageTensor, ImageError> {
    let columns = width / PATCH_SIZE;
    let rows = height / PATCH_SIZE;
    let mut pixels = vec![0.0; max_patches * PATCH_DIM];
    let mut positions = vec![-1; max_patches * 2];
    for row in 0..rows {
        cancel.check().map_err(ImageError::Cancelled)?;
        for column in 0..columns {
            let patch = row * columns + column;
            positions[patch * 2] = column as i64;
            positions[patch * 2 + 1] = row as i64;
            for dy in 0..PATCH_SIZE {
                let source = ((row * PATCH_SIZE + dy) * width + column * PATCH_SIZE) * 3;
                let output = patch * PATCH_DIM + dy * PATCH_SIZE * 3;
                for offset in 0..PATCH_SIZE * 3 {
                    // Transformers.js multiplies in float64 then stores into Float32Array.
                    pixels[output + offset] =
                        (f64::from(rgb[source + offset]) * (1.0 / 255.0)) as f32;
                }
            }
        }
    }
    Ok(ImageTensor {
        pixels,
        positions,
        max_patches,
        soft_tokens: rows * columns / (POOL_SIZE * POOL_SIZE),
    })
}

impl fmt::Display for ImageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(reason) => write!(formatter, "image preprocessing cancelled: {reason}"),
            Self::InvalidBudget(budget) => write!(
                formatter,
                "image soft-token budget {budget} is outside 1..=280"
            ),
            Self::EncodedLimit => formatter.write_str("encoded image exceeds 64 MiB"),
            Self::PixelLimit => formatter.write_str("decoded image exceeds 40 million pixels"),
            Self::AllocationLimit => {
                formatter.write_str("decoded image exceeds the 64 MiB allocation budget")
            }
            Self::UnsupportedFormat => {
                formatter.write_str("image format must be JPEG, PNG or WebP")
            }
            Self::Decode(error) => write!(formatter, "image decoding failed: {error}"),
        }
    }
}

impl std::error::Error for ImageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Cancelled(error) => Some(error),
            Self::Decode(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
