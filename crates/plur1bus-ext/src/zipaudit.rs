//! The strict ZIP audit of a `.p1x` (spec 2026-09-27 §5.1, §8.4 steps 1–3; X1-R3, X1-R7). It never extracts: it
//! hashes the whole stream, parses the end-of-central-directory record and the central directory itself (little-endian
//! field reads over the `Read + Seek` handle, not the `zip` crate), checks every local header against its central
//! entry, and checks every name, file type and size. [`hash_entry`] then streams one entry through `flate2` with no
//! write, so a lying size, a CRC mismatch and a deflate bomb are found at inspect.
//!
//! Refusals use the frozen ⟂EXT 2 reasons (X1-R4): an unsupported ZIP feature is `archive-unsupported`, an unsafe name
//! or entry type `archive-unsafe-entry`, any cap `download-too-large`, and a size or CRC mismatch `digest-mismatch`.
use crate::refusal::{reason, Refusal};
use flate2::{read::DeflateDecoder, Crc};
use icu_normalizer::ComposingNormalizerBorrowed;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Seek, SeekFrom};

const SIG_LOCAL: u32 = 0x0403_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_DESCRIPTOR: u32 = 0x0807_4b50;
const LOCAL_LEN: u64 = 30;
const CENTRAL_LEN: usize = 46;
const EOCD_LEN: u64 = 22;
/// General-purpose flags: bit 0 encrypted, bit 6 strong encryption, bit 13 encrypted central directory.
const FLAGS_ENCRYPTED: u16 = 0x0001 | 0x0040 | 0x2000;
const FLAG_DESCRIPTOR: u16 = 0x0008;
/// The ZIP64 extended-information extra field.
const EXTRA_ZIP64: u16 = 0x0001;
/// Info-ZIP Unicode Path and Unicode Comment extra fields. The `zip` crate replaces an entry's name with the Unicode
/// Path when its CRC matches the header name, and `install::archive` extracts by that name: a parser differential.
const EXTRA_UNICODE_PATH: u16 = 0x7075;
const EXTRA_UNICODE_COMMENT: u16 = 0x6375;
/// Characters Windows refuses in a file name (besides `\\`, `/` and controls, checked on their own).
const WINDOWS_FORBIDDEN: &[char] = &[':', '<', '>', '"', '|', '?', '*'];
/// Unicode bidirectional marks, embeddings, overrides and isolates: they make a name display as another.
const BIDI_CONTROLS: &[char] = &[
    '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}', '\u{202e}', '\u{2066}',
    '\u{2067}', '\u{2068}', '\u{2069}',
];
const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;
const S_IFDIR: u32 = 0o040000;
/// The MS-DOS directory attribute in the low byte of the external attributes.
const DOS_DIRECTORY: u32 = 0x10;

/// The audit's caps (§8.4). `package_bytes` also caps the sum of the declared uncompressed sizes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    pub package_bytes: u64,
    pub entry_bytes: u64,
    pub max_entries: usize,
    /// Uncompressed ÷ compressed, per entry.
    pub max_ratio: u64,
    pub max_segments: usize,
    pub max_name_bytes: usize,
    /// Cap for `p1x.json` and `p1x.json.minisig`, read by later steps through [`read_entry`].
    pub manifest_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            package_bytes: 256 << 20,
            entry_bytes: 128 << 20,
            max_entries: 20_000,
            max_ratio: 100,
            max_segments: 16,
            max_name_bytes: 240,
            manifest_bytes: 1 << 20,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Method {
    Stored,
    Deflate,
}

/// One audited entry, in central-directory order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Valid UTF-8, NFC, `/`-separated, never a directory.
    pub name: String,
    pub method: Method,
    pub compressed: u64,
    pub uncompressed: u64,
    pub crc32: u32,
    /// Any of `0o111` in the Unix mode of the external attributes.
    pub exec: bool,
    /// Where the entry's (compressed) data starts in the stream.
    pub data_offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audited {
    /// Length of the whole stream in bytes.
    pub size: u64,
    /// SHA-256 of the whole stream, lowercase hex.
    pub sha256: String,
    pub entries: Vec<Entry>,
}

/// One entry streamed once: SHA-256 (lowercase hex) and size of the uncompressed bytes, and their first ≤ 4 bytes
/// (for the script set's shebang and magic-number checks, §8.4 step 6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryDigest {
    pub sha256: String,
    pub size: u64,
    pub head: Vec<u8>,
}

fn unsupported(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::UNSUPPORTED, detail)
}
fn unsafe_entry(name: &str, why: &str) -> Refusal {
    Refusal::invalid(reason::UNSAFE_ENTRY, format!("{name:?}: {why}"))
}
fn too_large(detail: impl Into<String>) -> Refusal {
    Refusal::invalid(reason::TOO_LARGE, detail)
}

/// A read past the end is the archive's fault (a size or offset that points outside it); anything else is I/O.
fn read_err(e: io::Error) -> Refusal {
    if e.kind() == io::ErrorKind::UnexpectedEof {
        unsupported("truncated: a record points past the end of the file")
    } else {
        Refusal::io(&e)
    }
}

fn read_at<R: Read + Seek>(r: &mut R, pos: u64, len: usize) -> Result<Vec<u8>, Refusal> {
    r.seek(SeekFrom::Start(pos)).map_err(read_err)?;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).map_err(read_err)?;
    Ok(buf)
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// The first extra field `.p1x` refuses, named for the refusal's detail: ZIP64, or an Info-ZIP Unicode Path or
/// Comment field (a second name for the entry).
fn forbidden_extra(mut extra: &[u8]) -> Option<&'static str> {
    while extra.len() >= 4 {
        let (id, len) = (u16_at(extra, 0), u16_at(extra, 2) as usize);
        match id {
            EXTRA_ZIP64 => return Some("ZIP64"),
            EXTRA_UNICODE_PATH => return Some("an Info-ZIP Unicode Path extra field"),
            EXTRA_UNICODE_COMMENT => return Some("an Info-ZIP Unicode Comment extra field"),
            _ => {}
        }
        extra = &extra[(4 + len).min(extra.len())..];
    }
    None
}

/// A central-directory entry as parsed, before its local header is checked.
struct Central {
    name: String,
    flags: u16,
    method: u16,
    crc32: u32,
    compressed: u32,
    uncompressed: u32,
    exec: bool,
    offset: u32,
}

/// Audits a `.p1x` (or any ZIP the pipeline accepts) from the stream's start, whatever the handle's position.
pub fn audit_zip<R: Read + Seek>(r: &mut R, limits: &Limits) -> Result<Audited, Refusal> {
    // Steps 1 and 2: the size cap and the whole-file hash, in one pass.
    r.seek(SeekFrom::Start(0)).map_err(read_err)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Refusal::io(&e)),
        };
        size += n as u64;
        if size > limits.package_bytes {
            return Err(too_large(format!(
                "the package is larger than {} bytes",
                limits.package_bytes
            )));
        }
        hasher.update(&buf[..n]);
    }
    let sha256 = hex(&hasher.finalize());

    // Step 3: exactly one EOCD, at the very end, with no comment, no ZIP64 and one disk.
    if size < EOCD_LEN {
        return Err(unsupported(
            "not a ZIP archive: shorter than an end-of-central-directory record",
        ));
    }
    let eocd_pos = size - EOCD_LEN;
    let eocd = read_at(r, eocd_pos, EOCD_LEN as usize)?;
    if u32_at(&eocd, 0) != SIG_EOCD {
        return Err(unsupported(
            "no end-of-central-directory record at the end of the file (bytes after it, or an archive comment)",
        ));
    }
    let (disk, cd_disk) = (u16_at(&eocd, 4), u16_at(&eocd, 6));
    let (on_disk, total) = (u16_at(&eocd, 8), u16_at(&eocd, 10));
    let (cd_size, cd_offset) = (u32_at(&eocd, 12), u32_at(&eocd, 16));
    if u16_at(&eocd, 20) != 0 {
        return Err(unsupported("an archive comment"));
    }
    if on_disk == 0xFFFF || total == 0xFFFF || cd_size == u32::MAX || cd_offset == u32::MAX {
        return Err(unsupported("ZIP64"));
    }
    if disk != 0 || cd_disk != 0 || on_disk != total {
        return Err(unsupported("a multi-disk archive"));
    }
    if usize::from(total) > limits.max_entries {
        return Err(too_large(format!(
            "{total} entries (at most {})",
            limits.max_entries
        )));
    }
    if u64::from(cd_offset) + u64::from(cd_size) != eocd_pos {
        return Err(unsupported(
            "the central directory does not end at the end-of-central-directory record \
             (data before the first local header, or between the parts)",
        ));
    }
    let cd = read_at(r, cd_offset.into(), cd_size as usize)?;

    let nfc = ComposingNormalizerBorrowed::new_nfc();
    let mut centrals = Vec::with_capacity(total.into());
    let mut folded = Folded::default();
    let mut declared = 0u64;
    let mut p = 0usize;
    for _ in 0..total {
        if cd.len() - p < CENTRAL_LEN || u32_at(&cd, p) != SIG_CENTRAL {
            return Err(unsupported("a malformed central directory"));
        }
        let h = &cd[p..p + CENTRAL_LEN];
        let (n, m, k) = (
            u16_at(h, 28) as usize,
            u16_at(h, 30) as usize,
            u16_at(h, 32) as usize,
        );
        if cd.len() - p - CENTRAL_LEN < n + m + k {
            return Err(unsupported("a malformed central directory"));
        }
        let raw_name = &cd[p + CENTRAL_LEN..p + CENTRAL_LEN + n];
        let extra = &cd[p + CENTRAL_LEN + n..p + CENTRAL_LEN + n + m];
        p += CENTRAL_LEN + n + m + k;
        let shown = String::from_utf8_lossy(raw_name);

        let (flags, method) = (u16_at(h, 8), u16_at(h, 10));
        let (crc32, compressed, uncompressed) = (u32_at(h, 16), u32_at(h, 20), u32_at(h, 24));
        let (disk_start, external, offset) = (u16_at(h, 34), u32_at(h, 38), u32_at(h, 42));
        if flags & FLAGS_ENCRYPTED != 0 {
            return Err(unsupported(format!("{shown:?}: an encrypted entry")));
        }
        if method != 0 && method != 8 {
            return Err(unsupported(format!(
                "{shown:?}: compression method {method} (only stored and deflate)"
            )));
        }
        if compressed == u32::MAX
            || uncompressed == u32::MAX
            || offset == u32::MAX
            || disk_start == 0xFFFF
        {
            return Err(unsupported(format!("{shown:?}: ZIP64")));
        }
        if let Some(what) = forbidden_extra(extra) {
            return Err(unsupported(format!("{shown:?}: {what}")));
        }
        if disk_start != 0 {
            return Err(unsupported("a multi-disk archive"));
        }

        let name = check_name(raw_name, limits, &nfc)?;
        folded.insert(&name, &nfc)?;
        let exec = check_type(&name, external)?;

        let (c, u) = (u64::from(compressed), u64::from(uncompressed));
        if u > limits.entry_bytes {
            return Err(too_large(format!(
                "{name:?}: {u} bytes uncompressed (at most {})",
                limits.entry_bytes
            )));
        }
        if u > c.saturating_mul(limits.max_ratio) {
            return Err(too_large(format!(
                "{name:?}: compression ratio above {}:1 ({u} from {c} bytes)",
                limits.max_ratio
            )));
        }
        declared += u;
        if declared > limits.package_bytes {
            return Err(too_large(format!(
                "more than {} bytes uncompressed in total",
                limits.package_bytes
            )));
        }
        centrals.push(Central {
            name,
            flags,
            method,
            crc32,
            compressed,
            uncompressed,
            exec,
            offset,
        });
    }
    if p != cd.len() {
        return Err(unsupported(
            "bytes in the central directory after its last entry",
        ));
    }

    // Local headers: equal to their central entries, contiguous from offset 0 up to the central directory.
    let mut order: Vec<usize> = (0..centrals.len()).collect();
    order.sort_by_key(|&i| centrals[i].offset);
    let mut data_offsets = vec![0u64; centrals.len()];
    let mut expected = 0u64;
    for i in order {
        let c = &centrals[i];
        let at = u64::from(c.offset);
        if at != expected {
            return Err(unsupported(if expected == 0 {
                format!("{:?}: data before the first local header", c.name)
            } else {
                format!("{:?}: entries overlap or leave a gap", c.name)
            }));
        }
        let end = check_local(r, c, u64::from(cd_offset))?;
        data_offsets[i] = end.0;
        expected = end.1;
    }
    if expected != u64::from(cd_offset) {
        return Err(unsupported(
            "data between the last entry and the central directory",
        ));
    }

    let entries = centrals
        .into_iter()
        .zip(data_offsets)
        .map(|(c, data_offset)| Entry {
            name: c.name,
            method: if c.method == 0 {
                Method::Stored
            } else {
                Method::Deflate
            },
            compressed: c.compressed.into(),
            uncompressed: c.uncompressed.into(),
            crc32: c.crc32,
            exec: c.exec,
            data_offset,
        })
        .collect();
    Ok(Audited {
        size,
        sha256,
        entries,
    })
}

/// Checks the local header (and data descriptor) of `c`; returns `(data offset, end of the entry)`.
fn check_local<R: Read + Seek>(r: &mut R, c: &Central, limit: u64) -> Result<(u64, u64), Refusal> {
    let at = u64::from(c.offset);
    let disagree = |what: &str| {
        unsupported(format!(
            "{:?}: the local header's {what} disagrees with the central directory",
            c.name
        ))
    };
    if at + LOCAL_LEN > limit {
        return Err(unsupported(format!(
            "{:?}: local header inside the central directory",
            c.name
        )));
    }
    let h = read_at(r, at, LOCAL_LEN as usize)?;
    if u32_at(&h, 0) != SIG_LOCAL {
        return Err(unsupported(format!("{:?}: no local header", c.name)));
    }
    let (flags, method) = (u16_at(&h, 6), u16_at(&h, 8));
    let local = (u32_at(&h, 14), u32_at(&h, 18), u32_at(&h, 22));
    let (n, m) = (u64::from(u16_at(&h, 26)), u64::from(u16_at(&h, 28)));
    let data = at + LOCAL_LEN + n + m;
    if data > limit {
        return Err(unsupported(format!(
            "{:?}: local header runs into the central directory",
            c.name
        )));
    }
    let tail = read_at(r, at + LOCAL_LEN, (n + m) as usize)?;
    if &tail[..n as usize] != c.name.as_bytes() {
        return Err(disagree("name"));
    }
    if let Some(what) = forbidden_extra(&tail[n as usize..]) {
        return Err(unsupported(format!(
            "{:?}: {what} in the local header",
            c.name
        )));
    }
    if flags != c.flags {
        return Err(disagree("flags"));
    }
    if method != c.method {
        return Err(disagree("method"));
    }
    let central = (c.crc32, c.compressed, c.uncompressed);
    let mut end = data + u64::from(c.compressed);
    if end > limit {
        return Err(unsupported(format!(
            "{:?}: data runs into the central directory",
            c.name
        )));
    }
    if c.flags & FLAG_DESCRIPTOR == 0 {
        if local != central {
            return Err(disagree("CRC or sizes"));
        }
    } else {
        // Bit 3: the local fields are zero (APPNOTE 4.4.4) or already right; the descriptor must equal the central
        // entry, with or without its optional signature.
        if local != (0, 0, 0) && local != central {
            return Err(disagree("CRC or sizes"));
        }
        let avail = (limit - end).min(16) as usize;
        let d = read_at(r, end, avail)?;
        let fields = |b: &[u8]| (u32_at(b, 0), u32_at(b, 4), u32_at(b, 8));
        if avail >= 16 && u32_at(&d, 0) == SIG_DESCRIPTOR && fields(&d[4..]) == central {
            end += 16;
        } else if avail >= 12 && fields(&d) == central {
            end += 12;
        } else {
            return Err(unsupported(format!(
                "{:?}: the data descriptor disagrees with the central directory",
                c.name
            )));
        }
    }
    Ok((data, end))
}

fn is_reserved_device(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    let stem = stem.to_ascii_lowercase();
    if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    // COM1–9 and LPT1–9, and the superscript digits Windows also reserves (COM¹²³, LPT¹²³).
    let port = stem
        .strip_prefix("com")
        .or_else(|| stem.strip_prefix("lpt"));
    matches!(
        port,
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "\u{b9}" | "\u{b2}" | "\u{b3}")
    )
}

fn check_name(
    raw: &[u8],
    limits: &Limits,
    nfc: &ComposingNormalizerBorrowed<'_>,
) -> Result<String, Refusal> {
    let Ok(name) = std::str::from_utf8(raw) else {
        return Err(unsafe_entry(
            &String::from_utf8_lossy(raw),
            "the name is not valid UTF-8",
        ));
    };
    if name.is_empty() {
        return Err(unsafe_entry(name, "an empty name"));
    }
    if name.len() > limits.max_name_bytes {
        return Err(unsafe_entry(
            name,
            &format!("longer than {} bytes", limits.max_name_bytes),
        ));
    }
    if name.ends_with('/') {
        return Err(unsafe_entry(
            name,
            "an explicit directory entry (only implied directories)",
        ));
    }
    if name.starts_with('/') {
        return Err(unsafe_entry(name, "an absolute path"));
    }
    if name.contains('\\') {
        return Err(unsafe_entry(name, "a backslash"));
    }
    if name.chars().any(char::is_control) {
        return Err(unsafe_entry(name, "a NUL or control character"));
    }
    if name.contains(BIDI_CONTROLS) {
        return Err(unsafe_entry(name, "a Unicode bidirectional control"));
    }
    let b = name.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Err(unsafe_entry(name, "a drive letter"));
    }
    if name.contains(WINDOWS_FORBIDDEN) {
        return Err(unsafe_entry(
            name,
            "one of : < > \" | ? * (not allowed on Windows)",
        ));
    }
    if !nfc.is_normalized(name) {
        return Err(unsafe_entry(name, "not in Unicode NFC"));
    }
    if name.split('/').count() > limits.max_segments {
        return Err(unsafe_entry(
            name,
            &format!("more than {} segments", limits.max_segments),
        ));
    }
    for segment in name.split('/') {
        if segment.is_empty() {
            return Err(unsafe_entry(name, "an empty segment"));
        }
        if segment == "." || segment == ".." {
            return Err(unsafe_entry(name, "a . or .. segment"));
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(unsafe_entry(name, "a segment ending in a dot or space"));
        }
        if is_reserved_device(segment) {
            return Err(unsafe_entry(name, "a Windows reserved device name"));
        }
    }
    Ok(name.to_owned())
}

/// Names folded with `to_lowercase` + NFC. No two entries may fold equal; no entry may fold equal to an implied
/// directory of another (a file `a` beside `A/b` cannot be extracted on a case-insensitive file system); and every
/// implied directory has one spelling (`Docs/x` beside `docs/y` is one directory on a case-insensitive file system and
/// two on a case-sensitive one).
#[derive(Default)]
struct Folded {
    files: HashSet<String>,
    /// Folded directory prefix → its first spelling.
    dirs: HashMap<String, String>,
}

impl Folded {
    fn insert(&mut self, name: &str, nfc: &ComposingNormalizerBorrowed<'_>) -> Result<(), Refusal> {
        let fold = |s: &str| nfc.normalize(&s.to_lowercase()).into_owned();
        let collides = || {
            unsafe_entry(
                name,
                "collides with another entry by case or Unicode normalisation",
            )
        };
        let key = fold(name);
        if self.dirs.contains_key(&key) || !self.files.insert(key) {
            return Err(collides());
        }
        for (i, _) in name.match_indices('/') {
            let dir = &name[..i];
            let folded = fold(dir);
            if self.files.contains(&folded) {
                return Err(collides());
            }
            match self.dirs.get(&folded) {
                Some(first) if first != dir => {
                    return Err(unsafe_entry(
                        name,
                        &format!("the directory {first:?} spelled differently"),
                    ));
                }
                Some(_) => {}
                None => {
                    self.dirs.insert(folded, dir.to_owned());
                }
            }
        }
        Ok(())
    }
}

/// The file type from the external attributes: only regular files (Unix type bits `0o100000` or none). Returns the
/// exec bit. ZIP has no hard-link type, so hard links, devices, FIFOs, sockets and unknown types are all "not regular".
fn check_type(name: &str, external: u32) -> Result<bool, Refusal> {
    let mode = external >> 16;
    if external & DOS_DIRECTORY != 0 {
        return Err(unsafe_entry(
            name,
            "an explicit directory entry (only implied directories)",
        ));
    }
    match mode & S_IFMT {
        0 | S_IFREG => Ok(mode & 0o111 != 0),
        S_IFLNK => Err(unsafe_entry(name, "a symlink")),
        S_IFDIR => Err(unsafe_entry(
            name,
            "an explicit directory entry (only implied directories)",
        )),
        _ => Err(unsafe_entry(
            name,
            "a hard link, device, FIFO, socket or other special entry",
        )),
    }
}

/// Reads `source` to its end into `sink`, counting and CRC-ing; a deflate error is the package's fault.
fn pump(
    source: &mut impl Read,
    e: &Entry,
    sink: &mut impl FnMut(&[u8]),
) -> Result<(u64, u32), Refusal> {
    let mut crc = Crc::new();
    let mut count = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match source.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err)
                if e.method == Method::Deflate
                    && matches!(
                        err.kind(),
                        io::ErrorKind::InvalidInput
                            | io::ErrorKind::InvalidData
                            | io::ErrorKind::UnexpectedEof
                    ) =>
            {
                return Err(Refusal::invalid(
                    reason::DIGEST,
                    format!("{:?}: corrupt deflate data ({err})", e.name),
                ));
            }
            Err(err) => return Err(Refusal::io(&err)),
        };
        count += n as u64;
        crc.update(&buf[..n]);
        sink(&buf[..n]);
    }
    Ok((count, crc.sum()))
}

/// Streams the entry's uncompressed bytes into `sink`, at most `uncompressed + 1` of them, and checks the count, the
/// CRC and, for deflate, that the stream ends exactly at the entry's compressed size.
fn stream<R: Read + Seek>(
    r: &mut R,
    e: &Entry,
    mut sink: impl FnMut(&[u8]),
) -> Result<(), Refusal> {
    r.seek(SeekFrom::Start(e.data_offset)).map_err(read_err)?;
    let raw = (&mut *r).take(e.compressed);
    let cap = e.uncompressed.saturating_add(1);
    let (count, crc, consumed) = match e.method {
        Method::Stored => {
            let (count, crc) = pump(&mut raw.take(cap), e, &mut sink)?;
            (count, crc, None)
        }
        Method::Deflate => {
            let mut decoder = DeflateDecoder::new(raw);
            let (count, crc) = pump(&mut (&mut decoder).take(cap), e, &mut sink)?;
            (count, crc, Some(decoder.total_in()))
        }
    };
    if count != e.uncompressed {
        let more = if count > e.uncompressed {
            "more than "
        } else {
            ""
        };
        return Err(Refusal::invalid(
            reason::DIGEST,
            format!(
                "{:?}: {more}{count} bytes uncompressed, {} declared",
                e.name, e.uncompressed
            ),
        ));
    }
    if crc != e.crc32 {
        return Err(Refusal::invalid(
            reason::DIGEST,
            format!("{:?}: CRC-32 mismatch", e.name),
        ));
    }
    if let Some(consumed) = consumed {
        if consumed != e.compressed {
            return Err(Refusal::invalid(
                reason::DIGEST,
                format!(
                    "{:?}: {} compressed bytes after the end of the deflate stream",
                    e.name,
                    e.compressed.saturating_sub(consumed)
                ),
            ));
        }
    }
    Ok(())
}

/// Streams one audited entry once, with no write: SHA-256, size and first ≤ 4 bytes (X1-R7).
pub fn hash_entry<R: Read + Seek>(r: &mut R, e: &Entry) -> Result<EntryDigest, Refusal> {
    let mut hasher = Sha256::new();
    let mut head = Vec::with_capacity(4);
    stream(r, e, |chunk| {
        if head.len() < 4 {
            let take = (4 - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..take]);
        }
        hasher.update(chunk);
    })?;
    Ok(EntryDigest {
        sha256: hex(&hasher.finalize()),
        size: e.uncompressed,
        head,
    })
}

/// Reads one audited entry into memory, refusing one whose declared size exceeds `cap` before reading it.
pub fn read_entry<R: Read + Seek>(r: &mut R, e: &Entry, cap: u64) -> Result<Vec<u8>, Refusal> {
    if e.uncompressed > cap {
        return Err(too_large(format!(
            "{:?}: {} bytes (at most {cap})",
            e.name, e.uncompressed
        )));
    }
    let mut out = Vec::with_capacity(e.uncompressed as usize);
    stream(r, e, |chunk| out.extend_from_slice(chunk))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_device_names_match_any_extension_and_case() {
        for s in [
            "con",
            "CON",
            "con.txt",
            "Aux.tar.gz",
            "com1",
            "LPT9.x",
            "nul ",
            "con .txt",
            "COM\u{b9}",
            "lpt\u{b3}.txt",
        ] {
            assert!(is_reserved_device(s), "{s}");
        }
        for s in [
            "console",
            "com0",
            "com10",
            "lpt",
            "nul-x",
            ".con",
            "icon",
            "com\u{b4}",
            "lpt\u{b9}\u{b9}",
        ] {
            assert!(!is_reserved_device(s), "{s}");
        }
    }

    #[test]
    fn forbidden_extra_fields_are_found_among_others() {
        assert_eq!(forbidden_extra(&[]), None);
        assert_eq!(forbidden_extra(&[0x55, 0x54, 1, 0, 0]), None);
        assert_eq!(
            forbidden_extra(&[0x55, 0x54, 1, 0, 0, 0x01, 0x00, 0, 0]),
            Some("ZIP64")
        );
        assert!(forbidden_extra(&[0x75, 0x70, 0, 0])
            .unwrap()
            .contains("Unicode Path"));
        assert!(forbidden_extra(&[0x75, 0x63, 0, 0])
            .unwrap()
            .contains("Unicode Comment"));
        // A truncated trailing field ends the scan without panicking.
        assert_eq!(forbidden_extra(&[0x55, 0x54, 9, 0, 0]), None);
    }

    #[test]
    fn names_fold_by_case_and_normalisation() {
        let nfc = ComposingNormalizerBorrowed::new_nfc();
        let mut f = Folded::default();
        f.insert("payload/Docs/x.md", &nfc).unwrap();
        f.insert("payload/Docs/y.md", &nfc).unwrap();
        assert!(f.insert("payload/docs/z.md", &nfc).is_err());
        assert!(f.insert("payload/Docs/X.md", &nfc).is_err());
        assert!(f.insert("payload/docs", &nfc).is_err());
        assert!(f.insert("PAYLOAD", &nfc).is_err());
        // The first spelling holds; a rejected entry leaves no second spelling behind.
        f.insert("payload/Docs/sub/w.md", &nfc).unwrap();
    }

    #[test]
    fn file_types_from_external_attributes() {
        assert_eq!(check_type("a", 0o100755 << 16), Ok(true));
        assert_eq!(check_type("a", 0o100644 << 16), Ok(false));
        assert_eq!(check_type("a", 0o755 << 16), Ok(true));
        assert_eq!(check_type("a", 0), Ok(false));
        assert_eq!(check_type("a", 0x20), Ok(false));
        for mode in [
            0o120777u32,
            0o040755,
            0o020644,
            0o060644,
            0o010644,
            0o140755,
            0o170000,
        ] {
            let e = check_type("a", mode << 16).unwrap_err();
            assert_eq!(e.reason, reason::UNSAFE_ENTRY);
        }
        assert!(check_type("a", 0x10).is_err());
    }

    #[test]
    fn defaults_are_the_spec_caps() {
        let l = Limits::default();
        assert_eq!(
            (l.package_bytes, l.entry_bytes, l.max_entries, l.max_ratio),
            (268_435_456, 134_217_728, 20_000, 100)
        );
        assert_eq!(
            (l.max_segments, l.max_name_bytes, l.manifest_bytes),
            (16, 240, 1_048_576)
        );
    }
}
