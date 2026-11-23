//! Raw upload manifests and durable accounting decisions.

use crate::{
    images,
    jobs::{Error, Result},
};
use serde::{Deserialize, Serialize};

pub(crate) const MAX_BYTES: usize = 25 * 1024 * 1024;
pub(crate) const MAX_MANIFEST_BYTES: usize = 4096;
const CORRUPT_GRACE_MS: u64 = 60 * 60 * 1000;
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
const MANIFEST_SCHEMA: &str = "media.upload/1";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Image,
    Audio,
    Video,
}

pub struct Upload<'a> {
    pub kind: Kind,
    pub mime_type: &'a str,
    pub filename: Option<&'a str>,
    pub bytes: &'a [u8],
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    schema: String,
    pub id: String,
    pub created_at: i64,
    pub kind: Kind,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub file: File,
}

#[derive(Deserialize, Serialize)]
pub struct File {
    pub path: String,
    pub sha256: String,
    pub bytes: usize,
    pub format: String,
}

pub struct Stored {
    pub manifest: Manifest,
    pub bytes: Vec<u8>,
}

fn upload_type(mime_type: &str) -> Option<(Kind, &'static str)> {
    use Kind::{Audio, Image, Video};
    Some(match mime_type {
        "image/png" => (Image, "png"),
        "image/jpeg" => (Image, "jpeg"),
        "image/webp" => (Image, "webp"),
        "image/gif" => (Image, "gif"),
        "audio/wav" | "audio/x-wav" => (Audio, "wav"),
        "audio/mpeg" | "audio/mp3" => (Audio, "mp3"),
        "audio/ogg" => (Audio, "ogg"),
        "audio/flac" => (Audio, "flac"),
        "audio/aac" => (Audio, "aac"),
        "audio/mp4" | "audio/x-m4a" => (Audio, "m4a"),
        "audio/webm" => (Audio, "webm"),
        "video/mp4" => (Video, "mp4"),
        "video/quicktime" => (Video, "mov"),
        "video/webm" => (Video, "webm"),
        "video/ogg" => (Video, "ogv"),
        _ => return None,
    })
}

fn display_filename(value: &str) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= 160
        })
        .map(|ch| match ch {
            '/'
            | '\\'
            | '\0'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim_matches(|ch: char| matches!(ch, '\u{feff}') || (ch.is_whitespace() && ch != '\u{85}'))
        .to_owned()
}

impl Manifest {
    pub(crate) fn admit(id: &str, created_at: i64, upload: &Upload<'_>) -> Result<Self> {
        if upload.bytes.is_empty() || !(0..=MAX_SAFE_INTEGER).contains(&created_at) {
            return Err(Error::UnsupportedParameter);
        }
        if upload.bytes.len() > MAX_BYTES {
            return Err(Error::TooLarge);
        }
        let (kind, format) = upload_type(upload.mime_type).ok_or(Error::UnsupportedParameter)?;
        if kind != upload.kind {
            return Err(Error::UnsupportedParameter);
        }
        let bytes = upload.bytes;
        if matches!(format, "png" | "jpeg" | "webp") {
            let actual = images::Format::sniff(bytes).ok_or(Error::UnsupportedParameter)?;
            if format != actual.extension() {
                return Err(Error::UnsupportedParameter);
            }
            images::assert_dimensions(bytes, actual)?;
        } else if !matches_magic(format, bytes) {
            return Err(Error::UnsupportedParameter);
        }
        Ok(Self {
            schema: MANIFEST_SCHEMA.into(),
            id: id.into(),
            created_at,
            kind,
            mime_type: upload.mime_type.into(),
            filename: upload
                .filename
                .map(display_filename)
                .filter(|name| !name.is_empty()),
            file: File {
                path: format!("0.{format}"),
                sha256: crate::output::hash(bytes),
                bytes: bytes.len(),
                format: format.into(),
            },
        })
    }

    pub fn decode(id: &str, data: &[u8]) -> Result<Self> {
        if data.len() > MAX_MANIFEST_BYTES {
            return Err(Error::Storage);
        }
        let manifest: Self = serde_json::from_slice(data).map_err(|_| Error::Storage)?;
        let (kind, format) = upload_type(&manifest.mime_type).ok_or(Error::Storage)?;
        let file = &manifest.file;
        if manifest.schema != MANIFEST_SCHEMA
            || manifest.id != id
            || !(0..=MAX_SAFE_INTEGER).contains(&manifest.created_at)
            || manifest.kind != kind
            || file.format != format
            || file.path != format!("0.{format}")
            || !(1..=MAX_BYTES).contains(&file.bytes)
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || manifest
                .filename
                .as_ref()
                .is_some_and(|name| display_filename(name) != *name)
        {
            return Err(Error::Storage);
        }
        Ok(manifest)
    }
}

fn matches_magic(format: &str, bytes: &[u8]) -> bool {
    match format {
        "gif" => bytes.len() >= 13 && matches!(bytes.get(..6), Some(b"GIF87a" | b"GIF89a")),
        "wav" => {
            bytes.len() >= 44
                && bytes.starts_with(b"RIFF")
                && bytes.get(8..12) == Some(b"WAVE")
                && bytes
                    .get(4..8)
                    .and_then(|n| n.try_into().ok())
                    .is_some_and(|n| u64::from(u32::from_le_bytes(n)) + 8 <= bytes.len() as u64)
        }
        "flac" => bytes.len() >= 42 && bytes.starts_with(b"fLaC"),
        "aac" => matches!(bytes, [0xff, sync, _, _, _, _, _, ..] if sync & 0xf6 == 0xf0),
        "mp3" => mp3_header(bytes),
        "ogg" | "ogv" => ogg_header(format, bytes),
        "webm" => {
            bytes.len() >= 12
                && bytes.starts_with(b"\x1a\x45\xdf\xa3")
                && bytes[4..bytes.len().min(4096)]
                    .windows(7)
                    .any(|part| part == b"\x42\x82\x84webm")
        }
        _ => mp4_header(format, bytes),
    }
}

fn mp3_header(bytes: &[u8]) -> bool {
    let mut offset = 0;
    if bytes.len() >= 10 && bytes.starts_with(b"ID3") {
        let size = &bytes[6..10];
        if size.iter().any(|&byte| byte > 127) {
            return false;
        }
        offset = 10
            + size
                .iter()
                .fold(0, |total, &byte| (total << 7) + usize::from(byte));
    }
    matches!(bytes.get(offset..), Some([0xff, second, third, _, ..])
        if second & 0xe0 == 0xe0 && second & 6 != 0
        && !matches!(third & 0xf0, 0 | 0xf0) && third & 0x0c != 0x0c)
}

fn ogg_header(format: &str, bytes: &[u8]) -> bool {
    if bytes.len() < 28 || !bytes.starts_with(b"OggS\0") {
        return false;
    }
    let Some(packet) = bytes.get(27 + usize::from(bytes[26])..) else {
        return false;
    };
    if format == "ogv" {
        packet.starts_with(b"\x80theora")
    } else {
        [b"OpusHead".as_slice(), b"\x01vorbis", b"\x7fFLAC"]
            .iter()
            .any(|header| packet.starts_with(header))
    }
}

fn mp4_header(format: &str, bytes: &[u8]) -> bool {
    let Some([a, b, c, d, b'f', b't', b'y', b'p', major @ ..]) = bytes.get(..12) else {
        return false;
    };
    let size = u32::from_be_bytes([*a, *b, *c, *d]) as usize;
    if !(16..=bytes.len()).contains(&size) {
        return false;
    }
    match format {
        "mov" => major == b"qt  ",
        "m4a" => matches!(major, b"M4A " | b"M4B " | b"M4P "),
        "mp4" => matches!(
            major,
            b"isom"
                | b"iso2"
                | b"iso4"
                | b"iso5"
                | b"iso6"
                | b"mp41"
                | b"mp42"
                | b"avc1"
                | b"M4V "
                | b"dash"
        ),
        _ => false,
    }
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
enum IndexSchema {
    #[serde(rename = "media.upload-index/1")]
    V1,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexRecord {
    schema: IndexSchema,
    pub created_at: i64,
    pub bytes: u64,
    pub unavailable: bool,
}

impl IndexRecord {
    pub fn new(created_at: i64, bytes: u64, unavailable: bool) -> Self {
        Self {
            schema: IndexSchema::V1,
            created_at,
            bytes,
            unavailable,
        }
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        if data.len() > 512 {
            return Err(Error::Storage);
        }
        let record: Self = serde_json::from_slice(data).map_err(|_| Error::Storage)?;
        if !(0..=MAX_SAFE_INTEGER).contains(&record.created_at)
            || record.bytes > MAX_SAFE_INTEGER as u64
        {
            return Err(Error::Storage);
        }
        Ok(record)
    }
}

#[derive(Clone, Copy)]
pub enum Health {
    Present { created_at: i64 },
    Corrupt,
    Unavailable,
}

pub struct Entry {
    pub id: String,
    pub modified_at: i64,
    pub bytes: u64,
    pub health: Health,
    pub saved: Option<IndexRecord>,
}

impl Entry {
    pub(crate) fn account(&self, now: i64) -> IndexRecord {
        let unavailable = matches!(self.health, Health::Unavailable);
        let observed = match self.health {
            Health::Present { created_at } => created_at,
            _ if self.modified_at != 0 => self.modified_at,
            _ => now,
        };
        let bytes = if unavailable {
            self.bytes.max(
                self.saved
                    .map_or((MAX_BYTES + MAX_MANIFEST_BYTES) as u64, |record| {
                        record.bytes
                    }),
            )
        } else {
            self.bytes
        };
        let created_at = self.saved.map_or(observed, |record| record.created_at);
        IndexRecord::new(created_at, bytes, unavailable)
    }

    pub(crate) fn expired(&self, now: i64, retention: Option<u64>, account: IndexRecord) -> bool {
        let (start, limit) = match self.health {
            Health::Present { created_at } => (created_at, retention),
            Health::Corrupt => (self.modified_at, Some(CORRUPT_GRACE_MS)),
            Health::Unavailable => (account.created_at, retention),
        };
        limit.is_some_and(|ms| i128::from(now) - i128::from(start) >= i128::from(ms))
    }
}
