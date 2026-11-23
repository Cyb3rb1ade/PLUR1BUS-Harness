use super::{xmp, Dimensions, Metadata};
use crate::jobs::{Error, Result};

const EXIF: u8 = 0x08;
const XMP: u8 = 0x04;
const ALPHA: u8 = 0x10;

struct Chunk<'a> {
    kind: &'a [u8; 4],
    data: &'a [u8],
}

impl<'a> Chunk<'a> {
    fn split(bytes: &'a [u8]) -> Option<(Self, &'a [u8])> {
        let kind = bytes.get(..4)?.try_into().ok()?;
        let size = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
        let data = bytes.get(8..)?.get(..size)?;
        let next = (8 + size + (size & 1)).min(bytes.len());
        Some((Self { kind, data }, &bytes[next..]))
    }

    fn canvas(&self, strict: bool) -> Option<(Dimensions, u8)> {
        let data = self.data;
        match self.kind {
            b"VP8X" => {
                let width = le24(data.get(4..7)?)? + 1;
                let height = le24(data.get(7..10)?)? + 1;
                Some((Dimensions { width, height }, data[0]))
            }
            b"VP8L" if data.first() == Some(&0x2f) => {
                let bits = u32::from_le_bytes(data.get(1..5)?.try_into().ok()?);
                let width = (bits & 0x3fff) + 1;
                let height = ((bits >> 14) & 0x3fff) + 1;
                let flags = if (bits >> 28) & 1 == 1 { ALPHA } else { 0 };
                Some((Dimensions { width, height }, flags))
            }
            b"VP8 " if data.get(3) == Some(&0x9d) => {
                if strict && data.get(4..6) != Some(b"\x01\x2a") {
                    return None;
                }
                let width = u16::from_le_bytes(data.get(6..8)?.try_into().ok()?) & 0x3fff;
                let height = u16::from_le_bytes(data.get(8..10)?.try_into().ok()?) & 0x3fff;
                Some((
                    Dimensions {
                        width: width.into(),
                        height: height.into(),
                    },
                    0,
                ))
            }
            _ => None,
        }
    }
}

fn le24(bytes: &[u8]) -> Option<u32> {
    let [a, b, c] = *bytes else { return None };
    Some(u32::from_le_bytes([a, b, c, 0]))
}

fn body(bytes: &[u8], strict: bool) -> Option<&[u8]> {
    let size = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    let end = size.checked_add(8)?;
    bytes.get(12..if strict { end } else { end.min(bytes.len()) })
}

pub(super) fn dimensions(bytes: &[u8]) -> Option<Dimensions> {
    let mut remaining = body(bytes, false)?;
    while let Some((chunk, next)) = Chunk::split(remaining) {
        if let Some((dimensions, _)) = chunk.canvas(false) {
            return Some(dimensions);
        }
        remaining = next;
    }
    None
}

fn append(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) -> Result<()> {
    let size = u32::try_from(data.len()).map_err(|_| Error::TooLarge)?;
    output.extend_from_slice(kind);
    output.extend_from_slice(&size.to_le_bytes());
    output.extend_from_slice(data);
    if size & 1 != 0 {
        output.push(0);
    }
    Ok(())
}

fn seal(mut output: Vec<u8>) -> Result<Vec<u8>> {
    let size = u32::try_from(output.len() - 8).map_err(|_| Error::TooLarge)?;
    output[4..8].copy_from_slice(&size.to_le_bytes());
    Ok(output)
}

pub(super) fn strip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut remaining = body(bytes, true).ok_or(Error::UnsupportedParameter)?;
    let mut output = b"RIFF\0\0\0\0WEBP".to_vec();
    let mut saw_image = false;
    while !remaining.is_empty() {
        let (chunk, next) = Chunk::split(remaining).ok_or(Error::UnsupportedParameter)?;
        remaining = next;
        match chunk.kind {
            b"VP8X" if !chunk.data.is_empty() => {
                let start = output.len() + 8;
                append(&mut output, chunk.kind, chunk.data)?;
                output[start] &= !(EXIF | XMP);
            }
            b"VP8 " | b"VP8L" | b"ANMF" => {
                saw_image = true;
                append(&mut output, chunk.kind, chunk.data)?;
            }
            b"VP8X" | b"ICCP" | b"ANIM" | b"ALPH" => append(&mut output, chunk.kind, chunk.data)?,
            _ => {}
        }
    }
    if !saw_image {
        return Err(Error::UnsupportedParameter);
    }
    seal(output)
}

pub(super) fn embed(bytes: &[u8], metadata: &Metadata<'_>) -> Result<Vec<u8>> {
    let mut remaining = body(bytes, true).ok_or(Error::InvalidResponse)?;
    let mut output = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
    const CANVAS_START: usize = 20;
    output.resize(CANVAS_START + 10, 0);
    let mut canvas = [None, None, None];
    while !remaining.is_empty() {
        let (chunk, next) = Chunk::split(remaining).ok_or(Error::InvalidResponse)?;
        remaining = next;
        let preferred = match chunk.kind {
            b"VP8X" => Some(0),
            b"VP8L" => Some(1),
            b"VP8 " => Some(2),
            _ => None,
        };
        if let Some(index) = preferred {
            canvas[index].get_or_insert_with(|| chunk.canvas(true));
        }
        if !matches!(chunk.kind, b"VP8X" | b"XMP ") {
            append(&mut output, chunk.kind, chunk.data)?;
        }
    }
    let (dimensions, flags) = canvas
        .into_iter()
        .flatten()
        .next()
        .flatten()
        .ok_or(Error::InvalidResponse)?;
    let width = dimensions
        .width
        .checked_sub(1)
        .ok_or(Error::InvalidResponse)?;
    let height = dimensions
        .height
        .checked_sub(1)
        .ok_or(Error::InvalidResponse)?;
    output[CANVAS_START] = XMP | flags;
    output[CANVAS_START + 4..CANVAS_START + 7].copy_from_slice(&width.to_le_bytes()[..3]);
    output[CANVAS_START + 7..CANVAS_START + 10].copy_from_slice(&height.to_le_bytes()[..3]);
    let packet = xmp(metadata, false)?;
    append(&mut output, b"XMP ", packet.as_bytes())?;
    seal(output)
}
