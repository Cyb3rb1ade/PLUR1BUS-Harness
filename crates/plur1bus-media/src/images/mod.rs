//! Media format admission and metadata handling without pixel decoding.

use crate::jobs::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod jpeg;
mod webp;

const PNG_HEADER: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_IMAGE_SIDE: u32 = 32_768;
const MAX_IMAGE_PIXELS: u64 = 1 << 28;
const PNG_COLOUR: [[u8; 4]; 16] = [
    *b"tRNS", *b"gAMA", *b"cHRM", *b"sRGB", *b"iCCP", *b"sBIT", *b"bKGD", *b"hIST", *b"pHYs",
    *b"sPLT", *b"cICP", *b"mDCV", *b"cLLI", *b"acTL", *b"fcTL", *b"fdAT",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Jpeg,
    Webp,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
        }
    }

    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(PNG_HEADER) {
            Some(Self::Png)
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            Some(Self::Webp)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Serialize)]
pub struct Metadata<'a> {
    pub prompt: &'a str,
    pub parameters: &'a Value,
    pub metadata: &'a Value,
}

#[derive(Clone, Copy)]
struct Dimensions {
    width: u32,
    height: u32,
}

pub fn assert_dimensions(bytes: &[u8], format: Format) -> Result<()> {
    let dims = match format {
        Format::Png => png_dimensions(bytes),
        Format::Jpeg => jpeg::dimensions(bytes),
        Format::Webp => webp::dimensions(bytes),
    };
    if dims.is_some_and(|size| {
        !(1..=MAX_IMAGE_SIDE).contains(&size.width)
            || !(1..=MAX_IMAGE_SIDE).contains(&size.height)
            || u64::from(size.width) * u64::from(size.height) > MAX_IMAGE_PIXELS
    }) {
        return Err(Error::TooLarge);
    }
    Ok(())
}

pub fn verify(bytes: &[u8]) -> Result<Format> {
    let format = Format::sniff(bytes).ok_or(Error::InvalidResponse)?;
    assert_dimensions(bytes, format)?;
    Ok(format)
}

/// Admit and strip metadata before references leave the host.
pub fn sanitize(bytes: &[u8]) -> Result<(Format, Vec<u8>)> {
    let format = Format::sniff(bytes).ok_or(Error::UnsupportedParameter)?;
    assert_dimensions(bytes, format)?;
    let clean = match format {
        Format::Png => strip_png(bytes),
        Format::Jpeg => jpeg::strip(bytes),
        Format::Webp => webp::strip(bytes),
    };
    Ok((format, clean?))
}

pub fn embed(bytes: &[u8], format: Format, metadata: &Metadata<'_>) -> Result<Vec<u8>> {
    if Format::sniff(bytes) != Some(format) {
        return Err(Error::InvalidResponse);
    }
    match format {
        Format::Png => embed_png(bytes, metadata),
        Format::Jpeg => jpeg::embed(bytes, metadata),
        Format::Webp => webp::embed(bytes, metadata),
    }
}

fn png_dimensions(bytes: &[u8]) -> Option<Dimensions> {
    (bytes.get(12..16)? == b"IHDR").then_some(())?;
    Some(Dimensions {
        width: u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?),
        height: u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?),
    })
}

fn png_chunk(bytes: &[u8], cursor: usize) -> Option<(&[u8; 4], &[u8])> {
    let slice = bytes.get(cursor..)?;
    let len = u32::from_be_bytes(slice.get(..4)?.try_into().ok()?) as usize;
    let kind = slice.get(4..8)?.try_into().ok()?;
    Some((kind, slice.get(..len.checked_add(12)?)?))
}

fn strip_png(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = PNG_HEADER.to_vec();
    let mut cursor = PNG_HEADER.len();
    while let Some((kind, chunk)) = png_chunk(bytes, cursor) {
        if cursor == PNG_HEADER.len() && kind != b"IHDR" {
            return Err(Error::UnsupportedParameter);
        }
        if kind[0].is_ascii_uppercase() || PNG_COLOUR.contains(kind) {
            out.extend_from_slice(chunk);
        }
        if kind == b"IEND" {
            return Ok(out);
        }
        cursor += chunk.len();
    }
    Err(Error::UnsupportedParameter)
}

fn embed_png(bytes: &[u8], metadata: &Metadata<'_>) -> Result<Vec<u8>> {
    let mut cursor = PNG_HEADER.len();
    while let Some((kind, chunk)) = png_chunk(bytes, cursor) {
        if kind == b"IEND" {
            break;
        }
        cursor += chunk.len();
    }
    if !matches!(png_chunk(bytes, cursor), Some((b"IEND", chunk)) if chunk.len() == 12 && cursor + 12 == bytes.len())
    {
        return Err(Error::InvalidResponse);
    }
    let mut payload = b"plur1bus\0\0\0\0\0".to_vec();
    serde_json::to_writer(&mut payload, metadata).map_err(|_| Error::InvalidResponse)?;
    let len = u32::try_from(payload.len()).map_err(|_| Error::TooLarge)?;
    let mut out = Vec::with_capacity(bytes.len() + 12 + payload.len());
    out.extend_from_slice(&bytes[..cursor]);
    out.extend_from_slice(&len.to_be_bytes());
    let crc_start = out.len();
    out.extend_from_slice(b"iTXt");
    out.extend_from_slice(&payload);
    let crc = crc32fast::hash(&out[crc_start..]);
    out.extend_from_slice(&crc.to_be_bytes());
    out.extend_from_slice(&bytes[cursor..]);
    Ok(out)
}

fn xmp(metadata: &Metadata<'_>, truncated: bool) -> Result<String> {
    #[derive(Serialize)]
    struct Packet<'a> {
        #[serde(flatten)]
        payload: Metadata<'a>,
        #[serde(skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
    }
    let packet = serde_json::to_string(&Packet {
        payload: *metadata,
        truncated: truncated.then_some(true),
    })
    .map_err(|_| Error::InvalidResponse)?;
    let mut text = String::from("<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:plur1bus=\"https://plur1bus.dev/ns/media/1/\"><plur1bus:payload>");
    for character in packet.chars() {
        match character {
            '&' => text.push_str("&amp;"),
            '<' => text.push_str("&lt;"),
            '>' => text.push_str("&gt;"),
            _ => text.push(character),
        }
    }
    text.push_str(
        "</plur1bus:payload></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>",
    );
    Ok(text)
}
