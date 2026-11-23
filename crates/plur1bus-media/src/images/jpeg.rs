use super::{xmp, Dimensions, Metadata};
use crate::jobs::{Error, Result};

const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn be16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..)?.get(..2)?.try_into().ok()?,
    ))
}

pub(super) fn dimensions(bytes: &[u8]) -> Option<Dimensions> {
    let mut cursor = 2;
    while let [0xff, marker, ..] = bytes.get(cursor..)? {
        match marker {
            0xff => cursor += 1,
            0x01 | 0xd0..=0xd8 => cursor += 2,
            0xd9 | 0xda => return None,
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                return Some(Dimensions {
                    height: u32::from(be16(bytes, cursor + 5)?),
                    width: u32::from(be16(bytes, cursor + 7)?),
                });
            }
            _ => cursor += 2 + usize::from(be16(bytes, cursor + 2)?),
        }
    }
    None
}

/// Rewrite metadata segments while copying scan data, stuffing and restart markers verbatim.
fn rewrite(bytes: &[u8], mut keep: impl FnMut(&mut Vec<u8>, u8, &[u8], &[u8])) -> Option<Vec<u8>> {
    let mut output = bytes.get(..2)?.to_vec();
    let mut cursor = 2;
    while let [0xff, marker, ..] = bytes.get(cursor..)? {
        match *marker {
            0xff => {
                cursor += 1;
                continue;
            }
            0xd9 => {
                output.extend_from_slice(&bytes[cursor..cursor + 2]);
                return Some(output);
            }
            0x01 | 0xd0..=0xd7 => {
                output.extend_from_slice(&bytes[cursor..cursor + 2]);
                cursor += 2;
                continue;
            }
            _ => {}
        }
        let length = usize::from(be16(bytes, cursor + 2)?);
        let end = cursor + 2 + length;
        let segment = bytes.get(cursor..end)?;
        let payload = segment.get(4..)?;
        if *marker == 0xda {
            let following_marker = scan_end(bytes, end)?;
            output.extend_from_slice(bytes.get(cursor..following_marker)?);
            cursor = following_marker;
        } else {
            keep(&mut output, *marker, payload, segment);
            cursor = end;
        }
    }
    None
}

fn scan_end(bytes: &[u8], mut cursor: usize) -> Option<usize> {
    while let Some(byte) = bytes.get(cursor) {
        if *byte != 0xff {
            cursor += 1;
            continue;
        }
        match bytes.get(cursor + 1)? {
            0x00 | 0xd0..=0xd7 => cursor += 2,
            0xff => cursor += 1,
            _ => return Some(cursor),
        }
    }
    None
}

fn orientation(payload: &[u8]) -> Option<u16> {
    let tiff = payload.strip_prefix(b"Exif\0\0")?;
    let little_endian = match tiff.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let read16 = |at: usize| -> Option<u16> {
        let bytes = tiff.get(at..)?.get(..2)?.try_into().ok()?;
        Some(if little_endian {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    };
    if read16(2)? != 42 {
        return None;
    }
    let offset = tiff.get(4..8)?.try_into().ok()?;
    let offset = if little_endian {
        u32::from_le_bytes(offset)
    } else {
        u32::from_be_bytes(offset)
    };
    let directory = usize::try_from(offset).ok()?;
    let count = read16(directory)?;
    for entry in tiff
        .get(directory + 2..)?
        .chunks_exact(12)
        .take(usize::from(count))
    {
        let mut tag = be16(entry, 0)?;
        let mut value = be16(entry, 8)?;
        if little_endian {
            tag = tag.swap_bytes();
            value = value.swap_bytes();
        }
        if tag == 0x0112 {
            return (2..=8).contains(&value).then_some(value);
        }
    }
    None
}

fn append_orientation(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(
        b"\xff\xe1\0\x22Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01",
    );
    output.extend_from_slice(&value.to_be_bytes());
    output.extend_from_slice(&[0; 6]);
}

pub(super) fn strip(bytes: &[u8]) -> Result<Vec<u8>> {
    rewrite(bytes, |output, marker, payload, segment| match marker {
        0xe1 => {
            if let Some(value) = orientation(payload) {
                append_orientation(output, value);
            }
        }
        0xe0 if !payload.starts_with(b"JFXX\0") => output.extend_from_slice(segment),
        0xe2 if payload.starts_with(b"ICC_PROFILE\0") => output.extend_from_slice(segment),
        0xee if payload.starts_with(b"Adobe") => output.extend_from_slice(segment),
        0xe0..=0xef | 0xfe => {}
        _ => output.extend_from_slice(segment),
    })
    .ok_or(Error::UnsupportedParameter)
}

fn fit_packet(metadata: &Metadata<'_>) -> Result<String> {
    let limit = usize::from(u16::MAX) - 2 - XMP_HEADER.len();
    let mut packet = xmp(metadata, false)?;
    if packet.len() <= limit {
        return Ok(packet);
    }
    let offsets: Vec<_> = metadata
        .prompt
        .char_indices()
        .map(|(index, _)| index)
        .collect();
    let mut keep = offsets.len();
    while packet.len() > limit && keep > 0 {
        keep = (keep * 9 / 10).saturating_sub(1);
        packet = xmp(
            &Metadata {
                prompt: &metadata.prompt[..offsets[keep]],
                ..*metadata
            },
            true,
        )?;
    }
    if packet.len() > limit {
        return Err(Error::TooLarge);
    }
    Ok(packet)
}

pub(super) fn embed(bytes: &[u8], metadata: &Metadata<'_>) -> Result<Vec<u8>> {
    let clean = rewrite(bytes, |output, marker, payload, segment| {
        if marker != 0xe1 || !payload.starts_with(XMP_HEADER) {
            output.extend_from_slice(segment);
        }
    })
    .ok_or(Error::InvalidResponse)?;
    let packet = fit_packet(metadata)?;
    let length = u16::try_from(XMP_HEADER.len() + packet.len() + 2).map_err(|_| Error::TooLarge)?;
    let insertion = if clean.get(2..4) == Some(b"\xff\xe0") {
        4 + usize::from(be16(&clean, 4).ok_or(Error::InvalidResponse)?)
    } else {
        2
    };
    let mut out = Vec::with_capacity(clean.len() + usize::from(length) + 2);
    out.extend_from_slice(&clean[..insertion]);
    out.extend_from_slice(b"\xff\xe1");
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(XMP_HEADER);
    out.extend_from_slice(packet.as_bytes());
    out.extend_from_slice(&clean[insertion..]);
    Ok(out)
}
