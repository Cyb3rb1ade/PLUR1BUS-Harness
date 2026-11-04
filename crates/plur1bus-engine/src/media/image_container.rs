//! Allocation-free container checks before image decoders inspect untrusted metadata or frames.
//!
//! image 0.25.10 does not pass allocation limits to image-webp metadata reads, and VP8
//! allocates using its inner dimensions before checking the VP8X canvas (MM-1 review P1).

use super::ImageError;
use crate::contract::Cancel;
use image::ImageFormat;

type Dimensions = (u32, u32);

/// Validate encoded ranges and WebP allocation dimensions without allocating image data.
pub(super) fn validate(
    bytes: &[u8],
    format: ImageFormat,
    cancel: &Cancel,
) -> Result<(), ImageError> {
    match format {
        ImageFormat::WebP => webp(bytes, cancel),
        ImageFormat::Png => png(bytes, cancel),
        ImageFormat::Jpeg => jpeg(bytes, cancel),
        _ => Err(ImageError::UnsupportedFormat),
    }
}

fn part(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8], ImageError> {
    offset
        .checked_add(length)
        .and_then(|end| bytes.get(offset..end))
        .ok_or(ImageError::InvalidContainer)
}

fn le32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn le24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | u32::from(bytes[1]) << 8 | u32::from(bytes[2]) << 16
}

fn webp(bytes: &[u8], cancel: &Cancel) -> Result<(), ImageError> {
    let header = part(bytes, 0, 12)?;
    if &header[..4] != b"RIFF"
        || &header[8..] != b"WEBP"
        || usize::try_from(le32(&header[4..8]))
            .ok()
            .and_then(|length| length.checked_add(8))
            != Some(bytes.len())
    {
        return Err(ImageError::InvalidContainer);
    }
    let mut offset = 12;
    let mut canvas = None;
    while offset < bytes.len() {
        cancel.check().map_err(ImageError::Cancelled)?;
        let (kind, data) = riff_chunk(bytes, &mut offset)?;
        match kind {
            b"VP8X" if canvas.is_none() => {
                if data.len() != 10 {
                    return Err(ImageError::InvalidContainer);
                }
                let dimensions = (le24(&data[4..7]) + 1, le24(&data[7..10]) + 1);
                bounded_dimensions(dimensions)?;
                canvas = Some(dimensions);
            }
            b"VP8 " | b"VP8L" => {
                let dimensions = image_dimensions(kind, data)?;
                require_dimensions(dimensions, canvas.unwrap_or(dimensions))?;
                canvas = Some(dimensions);
            }
            b"ANMF" => frame(data, canvas.ok_or(ImageError::InvalidContainer)?, cancel)?,
            b"VP8X" => return Err(ImageError::InvalidContainer),
            _ => {}
        }
    }
    canvas.ok_or(ImageError::InvalidContainer).map(|_| ())
}

fn riff_chunk<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<(&'a [u8], &'a [u8]), ImageError> {
    let header = part(bytes, *offset, 8)?;
    let length = le32(&header[4..8]) as usize;
    let data_start = *offset + 8;
    let data = part(bytes, data_start, length)?;
    let padded = length
        .checked_add(length & 1)
        .ok_or(ImageError::InvalidContainer)?;
    part(bytes, data_start, padded)?;
    *offset = data_start + padded;
    Ok((&header[..4], data))
}

fn bounded_dimensions((width, height): Dimensions) -> Result<(), ImageError> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixels > super::MAX_DECODED_PIXELS {
        return Err(ImageError::PixelLimit);
    }
    // Even opaque WebP uses an internal RGBA buffer in the lossless decoder.
    if pixels * 4 > super::MAX_DECODED_BYTES {
        return Err(ImageError::AllocationLimit);
    }
    Ok(())
}

fn require_dimensions(actual: Dimensions, expected: Dimensions) -> Result<(), ImageError> {
    bounded_dimensions(actual)?;
    if actual != expected {
        return Err(ImageError::InvalidContainer);
    }
    Ok(())
}

fn image_dimensions(kind: &[u8], data: &[u8]) -> Result<Dimensions, ImageError> {
    if kind == b"VP8L" {
        let header = part(data, 0, 5)?;
        if header[0] != 0x2f || header[4] >> 5 != 0 {
            return Err(ImageError::InvalidContainer);
        }
        let bits = le32(&header[1..5]);
        return Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
    }
    let header = part(data, 0, 10)?;
    if header[0] & 1 != 0 || &header[3..6] != b"\x9d\x01\x2a" {
        return Err(ImageError::InvalidContainer);
    }
    Ok((
        u32::from(u16::from_le_bytes([header[6], header[7]]) & 0x3fff),
        u32::from(u16::from_le_bytes([header[8], header[9]]) & 0x3fff),
    ))
}

fn frame(data: &[u8], canvas: Dimensions, cancel: &Cancel) -> Result<(), ImageError> {
    let header = part(data, 0, 16)?;
    let dimensions = (le24(&header[6..9]) + 1, le24(&header[9..12]) + 1);
    bounded_dimensions(dimensions)?;
    let x_end = u64::from(le24(&header[..3])) * 2 + u64::from(dimensions.0);
    let y_end = u64::from(le24(&header[3..6])) * 2 + u64::from(dimensions.1);
    if x_end > u64::from(canvas.0) || y_end > u64::from(canvas.1) {
        return Err(ImageError::InvalidContainer);
    }
    let mut offset = 16;
    while offset < data.len() {
        cancel.check().map_err(ImageError::Cancelled)?;
        let (kind, payload) = riff_chunk(data, &mut offset)?;
        match kind {
            b"VP8 " | b"VP8L" => require_dimensions(image_dimensions(kind, payload)?, dimensions)?,
            b"ALPH" => {}
            _ => return Err(ImageError::InvalidContainer),
        }
    }
    Ok(())
}

fn png(bytes: &[u8], cancel: &Cancel) -> Result<(), ImageError> {
    let mut offset = 8;
    while offset < bytes.len() {
        cancel.check().map_err(ImageError::Cancelled)?;
        let header = part(bytes, offset, 8)?;
        let length = be32(&header[..4]) as usize;
        let body_length = length.checked_add(4).ok_or(ImageError::InvalidContainer)?;
        part(bytes, offset + 8, body_length)?;
        offset += 8 + body_length;
        if &header[4..] == b"IEND" {
            return if length == 0 && offset == bytes.len() {
                Ok(())
            } else {
                Err(ImageError::InvalidContainer)
            };
        }
    }
    Err(ImageError::InvalidContainer)
}

fn jpeg(bytes: &[u8], cancel: &Cancel) -> Result<(), ImageError> {
    let mut offset = 2;
    let mut entropy = false;
    while offset < bytes.len() {
        cancel.check().map_err(ImageError::Cancelled)?;
        if entropy {
            while bytes.get(offset).is_some_and(|&value| value != 0xff) {
                offset += 1;
            }
        }
        if part(bytes, offset, 1)?[0] != 0xff {
            return Err(ImageError::InvalidContainer);
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = part(bytes, offset, 1)?[0];
        offset += 1;
        match marker {
            0x00 if entropy => continue,
            0x01 | 0xd0..=0xd7 => continue,
            0xd9 => return Ok(()),
            0x00 | 0xd8 => return Err(ImageError::InvalidContainer),
            _ => {}
        }
        let header = part(bytes, offset, 2)?;
        let length = usize::from(u16::from_be_bytes([header[0], header[1]]));
        if length < 2 {
            return Err(ImageError::InvalidContainer);
        }
        part(bytes, offset, length)?;
        offset += length;
        if marker == 0xda {
            entropy = true;
        }
    }
    Err(ImageError::InvalidContainer)
}
