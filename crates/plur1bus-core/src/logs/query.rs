//! `query.ts`: the query engine behind `logs.query` and `logs.tail`. It streams the protected log files (rotation
//! included), merges them in timestamp order, filters, redacts and pages with a cursor that does not depend on file
//! names or offsets.
//!
//! Everything here is synchronous: the TypeScript async generators become iterators that are pulled exactly as lazily,
//! so the bytes a call reads (`scanned.bytes`, the scan budget) match the TypeScript engine's.
//!
//! The fixed patterns of `query.ts` (the cursor timestamp, the zoneless timestamp form, the `{"ts":...}` prefix peek) and
//! the parts of JavaScript's `Date.parse` and `Buffer.from(_, "base64url")` they rest on are written by hand, because the
//! core crate takes no regular-expression dependency; vectors (`fixtures/parity/logs/query.json`) pin them.
//!
//! Differences from the TypeScript engine, all deliberate:
//!  * `Date.parse` here reads the ECMAScript date-time format (also with a space or lower-case `t`/`z`, and an offset
//!    written `+HHMM`, as V8 does), not V8's legacy fallback (`Oct 7, 2026`, `2026/10/07`, RFC 2822 text, a bare
//!    five-digit year ...): such a timestamp is a corrupt line here. That fallback reads a form without a zone as *local*
//!    time; this port reads every zoneless form as UTC.
//!  * A record is returned as a `serde_json::Value`: object keys are sorted, and a float with no fraction prints `1.0`.
//!    The `text` filter searches that serialisation of the redacted record.
//!  * A line `serde_json` cannot parse (nesting deeper than 128, a lone surrogate escape, a number beyond `f64`) is a
//!    corrupt line; JavaScript's `JSON.parse` accepts some of these.
use super::files::{open_log_files, OpenLogFile, OpenOptions, Stream};
use super::lines::{
    align_forward, backward_lines, forward_lines, seek_by_ts, ForwardOptions, RawLine, ScanStats,
    MAX_LINE,
};
use super::redact::TextRedactor;
use plur1bus_log_schema::redact::{RedactOptions, Redactor};
use plur1bus_log_schema::Level;
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::path::Path;
use std::sync::Arc;

/// The default scan budget: bytes read from files per call.
pub const DEFAULT_MAX_SCAN_BYTES: u64 = 128 * 1024 * 1024;
/// A scan that lies outside the requested range keeps this much of the file beyond the seek point (one search window).
const SEEK_SLACK: u64 = 64 * 1024;
/// Lines with one timestamp are ordered in groups of at most this many.
const GROUP_CAP: usize = 10_000;
/// Identical lines held back at a page boundary.
const SAME_KEY_EXTRA: usize = 100;

/// The direction of a read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    /// Oldest first.
    Asc,
    /// Newest first.
    Desc,
}

impl Order {
    /// The schema spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Order::Asc => "asc",
            Order::Desc => "desc",
        }
    }

    /// `asc` or `desc`.
    pub fn parse(name: &str) -> Option<Order> {
        match name {
            "asc" => Some(Order::Asc),
            "desc" => Some(Order::Desc),
            _ => None,
        }
    }
}

/// The name of a stream in a result and in the fingerprint.
pub fn stream_name(stream: Stream) -> &'static str {
    match stream {
        Stream::Diagnostic => "diagnostic",
        Stream::Audit => "audit",
    }
}

/// `LogFilter`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogFilter {
    /// Which files are read.
    pub stream: Stream,
    /// Inclusive RFC 3339 lower bound, normalised to `YYYY-MM-DDTHH:MM:SS.mmmZ`.
    pub from: Option<String>,
    /// Inclusive upper bound, normalised the same way.
    pub to: Option<String>,
    /// Keeps this level and above (diagnostic stream only).
    pub min_level: Option<Level>,
    /// The file's role, a record's `source.id` or `source.kind`, its `role`; for the audit stream the action's first segment.
    pub component: Option<String>,
    /// Case-insensitive substring of the *redacted* record text.
    pub text: Option<String>,
    /// Exact match on the record's `trace_id`.
    pub trace_id: Option<String>,
}

impl LogFilter {
    /// A filter that keeps everything of `stream`.
    pub fn new(stream: Stream) -> LogFilter {
        LogFilter {
            stream,
            from: None,
            to: None,
            min_level: None,
            component: None,
            text: None,
            trace_id: None,
        }
    }
}

/// `LogRecordOut`.
#[derive(Clone, Debug, PartialEq)]
pub struct LogRecordOut {
    /// The normalised timestamp.
    pub ts: String,
    /// `None` on the audit stream.
    pub level: Option<Level>,
    /// The file's role.
    pub component: String,
    /// The stream read.
    pub stream: Stream,
    /// The record as parsed from the line, after redaction.
    pub record: Value,
}

/// A position in the merged order: the normalised timestamp and a hash of the line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    /// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
    pub ts: String,
    /// The first 16 hex digits of the SHA-1 of the line.
    pub h: String,
}

/// `cmp(a, b)`: by timestamp, then hash, both compared as JavaScript compares strings (by UTF-16 code unit).
pub fn cmp_key(a: &Key, b: &Key) -> Ordering {
    cmp_js(&a.ts, &b.ts).then_with(|| cmp_js(&a.h, &b.h))
}

fn cmp_js(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        a.cmp(b)
    } else {
        a.encode_utf16().cmp(b.encode_utf16())
    }
}

/// `QueryResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryResult {
    /// The page.
    pub records: Vec<LogRecordOut>,
    /// Opaque; resume after the last line looked at. `None` when nothing more lies in this direction.
    pub next_cursor: Option<String>,
    /// Lines that were not records (not JSON, no usable timestamp or level, over the line cap, unredactable).
    pub corrupt: u64,
    /// Files read.
    pub scanned_files: usize,
    /// Bytes read from them.
    pub scanned_bytes: u64,
    /// The scan budget ran out: `next_cursor` continues from the last line looked at, not the last one returned.
    pub truncated: bool,
    /// Internal: the first line looked at in scan order (matching or not); never part of an RPC result.
    pub first_key: Option<Key>,
    /// Internal: the last line looked at.
    pub last_key: Option<Key>,
}

/// Why a cursor was refused (`CursorError.reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorError {
    /// Not a cursor this engine minted.
    BadCursor,
    /// A cursor of another query (other filters or order).
    CursorMismatch,
}

impl CursorError {
    /// `bad-cursor` or `cursor-mismatch`.
    pub fn reason(self) -> &'static str {
        match self {
            CursorError::BadCursor => "bad-cursor",
            CursorError::CursorMismatch => "cursor-mismatch",
        }
    }
}

impl fmt::Display for CursorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason())
    }
}

/// What a query can fail with besides a refused cursor.
#[derive(Debug)]
pub enum QueryError {
    /// The cursor was refused.
    Cursor(CursorError),
    /// A file could not be read.
    Io(io::Error),
    /// The default redactor could not be built (its data could not be read).
    Redactor(String),
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QueryError::Cursor(e) => fmt::Display::fmt(e, f),
            QueryError::Io(e) => fmt::Display::fmt(e, f),
            QueryError::Redactor(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for QueryError {}

impl From<io::Error> for QueryError {
    fn from(e: io::Error) -> Self {
        QueryError::Io(e)
    }
}

impl From<CursorError> for QueryError {
    fn from(e: CursorError) -> Self {
        QueryError::Cursor(e)
    }
}

/// `QueryOptions`.
pub struct QueryOptions<'a> {
    /// `<home>/logs`.
    pub dir: &'a Path,
    /// What to keep.
    pub filter: LogFilter,
    /// The direction.
    pub order: Order,
    /// Records per page (a few more when identical lines straddle the boundary).
    pub limit: usize,
    /// Resume after this position.
    pub cursor: Option<String>,
    /// Redacts each record before it is matched or returned; default `Redactor` with no options.
    pub redactor: Option<Arc<dyn TextRedactor>>,
    /// Bytes read from files per call; default 128 MiB.
    pub max_scan_bytes: Option<u64>,
    /// The line cap; default [`MAX_LINE`].
    pub max_line: Option<usize>,
    /// Test seam: runs after the files were listed and before they are opened (a rotation can be injected here).
    pub on_listed: Option<&'a dyn Fn()>,
}

impl<'a> QueryOptions<'a> {
    /// Options with the defaults for everything else.
    pub fn new(dir: &'a Path, filter: LogFilter, order: Order, limit: usize) -> QueryOptions<'a> {
        QueryOptions {
            dir,
            filter,
            order,
            limit,
            cursor: None,
            redactor: None,
            max_scan_bytes: None,
            max_line: None,
            on_listed: None,
        }
    }
}

// ---- SHA-1 (the line hash and the fingerprint of a cursor; Node's `createHash("sha1")`) ----

/// SHA-1 of `data`. Used only to key lines and cursors, never for security.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut msg = Vec::with_capacity(data.len() + 72);
    msg.extend_from_slice(data);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_be_bytes());
    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6u32),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (slot, v) in h.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(v);
        }
    }
    let mut out = [0u8; 20];
    for (chunk, v) in out.chunks_exact_mut(4).zip(h) {
        chunk.copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// The first `n` hex digits of the SHA-1 of `text`'s UTF-8 bytes (`digest("hex").slice(0, n)`).
fn sha1_hex_prefix(text: &str, n: usize) -> String {
    let digest = sha1(text.as_bytes());
    let mut hex = String::with_capacity(40);
    for b in digest {
        hex.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        hex.push(char::from_digit(u32::from(b & 15), 16).unwrap_or('0'));
    }
    hex.truncate(n);
    hex
}

fn hash_of(line: &str) -> String {
    sha1_hex_prefix(line, 16)
}

// ---- base64url as Node reads it ----

fn b64_value(c: char) -> Option<u32> {
    match c {
        'A'..='Z' => Some(c as u32 - 'A' as u32),
        'a'..='z' => Some(c as u32 - 'a' as u32 + 26),
        '0'..='9' => Some(c as u32 - '0' as u32 + 52),
        '+' | '-' => Some(62),
        '/' | '_' => Some(63),
        _ => None,
    }
}

/// `Buffer.from(text, "base64url")`: both alphabets are read, a character outside them is skipped, the first `=` ends the
/// input and a trailing partial byte is dropped.
pub fn base64_decode_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.chars() {
        if c == '=' {
            break;
        }
        let Some(v) = b64_value(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// `Buffer#toString("base64url")`: no padding.
pub fn base64url_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = match *chunk {
            [a, b, c] => (u32::from(a) << 16) | (u32::from(b) << 8) | u32::from(c),
            [a, b] => (u32::from(a) << 16) | (u32::from(b) << 8),
            [a] => u32::from(a) << 16,
            _ => 0,
        };
        let digits = chunk.len() + 1;
        for i in 0..digits {
            let idx = ((n >> (18 - 6 * i)) & 63) as usize;
            out.push(char::from(ALPHABET[idx]));
        }
    }
    out
}

// ---- cursors ----

fn json_string(s: &str) -> String {
    // serde_json and JSON.stringify escape the same characters for a well-formed string.
    serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""))
}

fn json_opt(s: Option<&str>) -> String {
    s.map_or_else(|| String::from("null"), json_string)
}

/// `fingerprint(filter, order)`: 12 hex digits identifying the query a cursor belongs to.
pub fn fingerprint(f: &LogFilter, order: Order) -> String {
    let text = format!(
        "[{},{},{},{},{},{},{},{}]",
        json_string(stream_name(f.stream)),
        json_string(order.as_str()),
        json_opt(f.from.as_deref()),
        json_opt(f.to.as_deref()),
        json_opt(f.min_level.map(Level::as_str)),
        json_opt(f.component.as_deref()),
        json_opt(f.text.as_deref()),
        json_opt(f.trace_id.as_deref()),
    );
    sha1_hex_prefix(&text, 12)
}

fn encode_cursor(k: &Key, fp: &str) -> String {
    let text = format!(
        "{{\"v\":1,\"ts\":{},\"h\":{},\"fp\":{}}}",
        json_string(&k.ts),
        json_string(&k.h),
        json_string(fp)
    );
    base64url_encode(text.as_bytes())
}

/// `mintCursor(filter, order, key)`.
pub fn mint_cursor(f: &LogFilter, order: Order, k: &Key) -> String {
    encode_cursor(k, &fingerprint(f, order))
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
fn is_cursor_ts(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 24
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'.',
            23 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// `decodeCursor(cursor, fp)`.
pub fn decode_cursor(cursor: &str, fp: &str) -> Result<Key, CursorError> {
    let bytes = base64_decode_lenient(cursor);
    let text = String::from_utf8_lossy(&bytes);
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) else {
        return Err(CursorError::BadCursor);
    };
    let version_ok = o.get("v").and_then(Value::as_f64).is_some_and(|v| v == 1.0);
    let (Some(Value::String(ts)), Some(Value::String(h)), Some(Value::String(cfp))) =
        (o.get("ts"), o.get("h"), o.get("fp"))
    else {
        return Err(CursorError::BadCursor);
    };
    if !version_ok || !is_cursor_ts(ts) {
        return Err(CursorError::BadCursor);
    }
    if cfp != fp {
        return Err(CursorError::CursorMismatch);
    }
    Ok(Key {
        ts: ts.clone(),
        h: h.clone(),
    })
}

// ---- timestamps (`Date.parse`, `Date#toISOString`) ----

use plur1bus_config::js_date::MAX_TIME;
pub use plur1bus_config::js_date::{date_parse, iso_string};

/// A JSON number as a time value: `Number.isFinite`, then `new Date(ms)` (the value is truncated toward zero and must lie
/// within `TimeClip`'s range).
fn number_to_ms(v: f64) -> Option<i64> {
    if !v.is_finite() || v.abs() > MAX_TIME as f64 {
        return None;
    }
    Some(v.trunc() as i64)
}

fn value_to_ms(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => number_to_ms(n.as_f64()?),
        Value::String(s) => date_parse(s),
        _ => None,
    }
}

/// `normalTs(r)`: `ts` (D111) or the legacy `at` (ISO text or epoch milliseconds), normalised to
/// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn normal_ts(r: &Map<String, Value>) -> Option<String> {
    let v = match r.get("ts") {
        Some(v) if !v.is_null() => v,
        _ => r.get("at")?,
    };
    iso_string(value_to_ms(v)?)
}

/// `\s` of JavaScript regular expressions.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `PREFIX = /^\s*\{\s*"(?:ts|at)"\s*:\s*("[^"]*"|\d+)/`: the raw value (with its quotes for a string) of a leading
/// `ts` or `at` member.
fn prefix_value(line: &str) -> Option<&str> {
    let skip = |s: &'_ str| -> usize { s.len() - s.trim_start_matches(is_js_space).len() };
    let mut rest = line;
    rest = &rest[skip(rest)..];
    rest = rest.strip_prefix('{')?;
    rest = &rest[skip(rest)..];
    rest = rest.strip_prefix('"')?;
    rest = rest
        .strip_prefix("ts")
        .or_else(|| rest.strip_prefix("at"))?;
    rest = rest.strip_prefix('"')?;
    rest = &rest[skip(rest)..];
    rest = rest.strip_prefix(':')?;
    rest = &rest[skip(rest)..];
    if let Some(body) = rest.strip_prefix('"') {
        let close = body.find('"')?;
        Some(&rest[..close + 2])
    } else {
        let n = rest.bytes().take_while(u8::is_ascii_digit).count();
        (n > 0).then(|| &rest[..n])
    }
}

/// `quickTs(line)`: the timestamp of a line without parsing all of it (the writer puts `ts` first); `None` when it cannot
/// be told.
pub fn quick_ts(line: &str) -> Option<String> {
    let Some(raw) = prefix_value(line) else {
        return match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(o)) => normal_ts(&o),
            _ => None,
        };
    };
    let mut o = Map::new();
    if let Some(inner) = raw.strip_prefix('"') {
        o.insert(
            "ts".into(),
            Value::String(inner.get(..inner.len() - 1)?.to_string()),
        );
    } else {
        o.insert(
            "ts".into(),
            serde_json::Number::from_f64(raw.parse().ok()?)?.into(),
        );
    }
    normal_ts(&o)
}

// ---- reading ----

struct Cand {
    key: Key,
    ts: String,
    rec: Value,
    level: Option<Level>,
    component: String,
    pre: bool,
}

enum Item {
    Cand(Box<Cand>),
    Corrupt,
    Long,
}

fn parse_line(line: &str, f: &OpenLogFile, filter: &LogFilter) -> Option<Cand> {
    let rec: Value = serde_json::from_str(line).ok()?;
    let Value::Object(r) = &rec else { return None };
    let ts = normal_ts(r)?;
    let mut level = None;
    if filter.stream == Stream::Diagnostic {
        level = Some(Level::parse(r.get("level")?.as_str()?)?);
    }
    let mut pre = true;
    if filter
        .from
        .as_deref()
        .is_some_and(|from| ts.as_str() < from)
    {
        pre = false;
    }
    if filter.to.as_deref().is_some_and(|to| ts.as_str() > to) {
        pre = false;
    }
    if pre {
        if let (Some(min), Some(level)) = (filter.min_level, level) {
            if !level.at_least(min) {
                pre = false;
            }
        }
    }
    if pre {
        if let Some(component) = &filter.component {
            let src = r.get("source").and_then(Value::as_object);
            let text_of = |key: &str| src.and_then(|s| s.get(key)).and_then(Value::as_str);
            let action = r
                .get("action")
                .and_then(Value::as_str)
                .map(|a| a.split('.').next().unwrap_or(""));
            pre = *component == f.file_ref.component
                || text_of("id") == Some(component.as_str())
                || text_of("kind") == Some(component.as_str())
                || r.get("role").and_then(Value::as_str) == Some(component.as_str())
                || action == Some(component.as_str());
        }
    }
    if pre {
        if let Some(trace_id) = &filter.trace_id {
            pre = r.get("trace_id").and_then(Value::as_str) == Some(trace_id.as_str());
        }
    }
    Some(Cand {
        key: Key {
            ts: ts.clone(),
            h: hash_of(line),
        },
        ts,
        rec,
        level,
        component: f.file_ref.component.clone(),
        pre,
    })
}

/// `fileCands`: one file's candidates in scan order, lines with one timestamp put in key order.
struct FileCands<'a> {
    file: &'a OpenLogFile,
    filter: &'a LogFilter,
    order: Order,
    after: Option<&'a Key>,
    lines: Box<dyn Iterator<Item = io::Result<RawLine>> + 'a>,
    group: Vec<Cand>,
    out: VecDeque<Cand>,
    done: bool,
}

impl<'a> FileCands<'a> {
    fn open(
        file: &'a OpenLogFile,
        filter: &'a LogFilter,
        order: Order,
        after: Option<&'a Key>,
        stats: &ScanStats,
        max_line: Option<usize>,
    ) -> io::Result<FileCands<'a>> {
        let max_line = max_line.filter(|n| *n > 0).unwrap_or(MAX_LINE);
        let lines: Box<dyn Iterator<Item = io::Result<RawLine>> + 'a> = match order {
            Order::Asc => {
                // the later of `from` and the cursor's timestamp
                let from = [filter.from.as_deref(), after.map(|k| k.ts.as_str())]
                    .into_iter()
                    .flatten()
                    .max_by(|a, b| cmp_js(a, b));
                let start = match from {
                    Some(from) => {
                        let at =
                            seek_by_ts(&file.file, file.size, from, &quick_ts, false, Some(stats))?;
                        align_forward(
                            &file.file,
                            i64::try_from(at).unwrap_or(i64::MAX),
                            file.size,
                            Some(stats),
                        )?
                    }
                    None => 0,
                };
                Box::new(forward_lines(
                    &file.file,
                    ForwardOptions {
                        start,
                        end: file.size,
                        max_line,
                        stats: Some(stats.clone()),
                    },
                ))
            }
            Order::Desc => {
                // the earlier of `to` and the cursor's timestamp
                let to = [filter.to.as_deref(), after.map(|k| k.ts.as_str())]
                    .into_iter()
                    .flatten()
                    .min_by(|a, b| cmp_js(a, b));
                // the first line after `to`, and one search window beyond for lines slightly out of order
                let end = match to {
                    Some(to) => {
                        let at =
                            seek_by_ts(&file.file, file.size, to, &quick_ts, true, Some(stats))?;
                        let aligned = align_forward(
                            &file.file,
                            i64::try_from(at).unwrap_or(i64::MAX),
                            file.size,
                            Some(stats),
                        )?;
                        file.size.min(aligned + SEEK_SLACK)
                    }
                    None => file.size,
                };
                Box::new(backward_lines(
                    &file.file,
                    end,
                    max_line,
                    Some(stats.clone()),
                )?)
            }
        };
        Ok(FileCands {
            file,
            filter,
            order,
            after,
            lines,
            group: Vec::new(),
            out: VecDeque::new(),
            done: false,
        })
    }

    fn keep(&self, c: &Cand) -> bool {
        match self.after {
            None => true,
            Some(after) => match self.order {
                Order::Asc => cmp_key(&c.key, after) == Ordering::Greater,
                Order::Desc => cmp_key(&c.key, after) == Ordering::Less,
            },
        }
    }

    /// Puts the group in key order and moves the candidates the cursor has not passed to the output.
    fn flush(&mut self) {
        let mut group = std::mem::take(&mut self.group);
        match self.order {
            Order::Asc => group.sort_by(|x, y| cmp_key(&x.key, &y.key)),
            Order::Desc => group.sort_by(|x, y| cmp_key(&y.key, &x.key)),
        }
        for c in group {
            if self.keep(&c) {
                self.out.push_back(c);
            }
        }
    }

    /// RULING (query.ts): timestamps in a file are non-decreasing, so a scan that has left the range stops.
    fn left_range(&self, ts: &str) -> bool {
        match self.order {
            Order::Desc => self.filter.from.as_deref().is_some_and(|from| ts < from),
            Order::Asc => self.filter.to.as_deref().is_some_and(|to| ts > to),
        }
    }
}

impl Iterator for FileCands<'_> {
    type Item = io::Result<Item>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(c) = self.out.pop_front() {
                return Some(Ok(Item::Cand(Box::new(c))));
            }
            if self.done {
                return None;
            }
            match self.lines.next() {
                None => {
                    self.done = true;
                    self.flush();
                }
                Some(Err(e)) => {
                    self.done = true;
                    return Some(Err(e));
                }
                Some(Ok(raw)) => {
                    if raw.too_long {
                        return Some(Ok(Item::Long));
                    }
                    let Some(c) = parse_line(&raw.text, self.file, self.filter) else {
                        return Some(Ok(Item::Corrupt));
                    };
                    if self.left_range(&c.ts) {
                        self.done = true;
                        self.flush();
                        continue;
                    }
                    if self
                        .group
                        .first()
                        .is_some_and(|g| g.ts != c.ts || self.group.len() >= GROUP_CAP)
                    {
                        self.flush();
                    }
                    self.group.push(c);
                }
            }
        }
    }
}

struct Source<'a> {
    it: FileCands<'a>,
    head: Option<Box<Cand>>,
}

/// Moves a source to its next candidate, counting the lines that produce none. Sets `over_budget` when the budget ran out
/// while skipping them: the sources can no longer be merged in order, so the whole call ends there.
fn advance(
    s: &mut Source<'_>,
    corrupt: &mut u64,
    over_budget: &mut bool,
    stats: &ScanStats,
    budget: u64,
) -> io::Result<()> {
    loop {
        match s.it.next() {
            None => {
                s.head = None;
                return Ok(());
            }
            Some(Err(e)) => return Err(e),
            Some(Ok(Item::Corrupt | Item::Long)) => {
                *corrupt += 1;
                if stats.bytes() > budget {
                    *over_budget = true;
                    s.head = None;
                    return Ok(());
                }
            }
            Some(Ok(Item::Cand(c))) => {
                s.head = Some(c);
                return Ok(());
            }
        }
    }
}

/// `runQuery(options)`.
pub fn run_query(o: &QueryOptions<'_>) -> Result<QueryResult, QueryError> {
    let fp = fingerprint(&o.filter, o.order);
    let after = o
        .cursor
        .as_deref()
        .map(|c| decode_cursor(c, &fp))
        .transpose()?;
    let redactor: Arc<dyn TextRedactor> = match &o.redactor {
        Some(r) => Arc::clone(r),
        None => Arc::new(
            Redactor::new(RedactOptions::default())
                .map_err(|e| QueryError::Redactor(e.to_string()))?,
        ),
    };
    let files = open_log_files(
        o.dir,
        o.filter.stream,
        &OpenOptions {
            retries: None,
            on_listed: o.on_listed,
        },
    )?;
    let stats = ScanStats::new();
    let mut corrupt = 0u64;
    let budget = o.max_scan_bytes.unwrap_or(DEFAULT_MAX_SCAN_BYTES);
    let mut sources = Vec::with_capacity(files.len());
    for f in &files {
        sources.push(Source {
            it: FileCands::open(f, &o.filter, o.order, after.as_ref(), &stats, o.max_line)?,
            head: None,
        });
    }
    let mut over_budget = false;
    for s in &mut sources {
        advance(s, &mut corrupt, &mut over_budget, &stats, budget)?;
    }
    let mut records: Vec<LogRecordOut> = Vec::new();
    let (mut first, mut last, mut last_returned): (Option<Key>, Option<Key>, Option<Key>) =
        (None, None, None);
    let (mut more, mut truncated) = (false, false);
    let needle = o.filter.text.as_ref().map(|t| t.to_lowercase());
    loop {
        if over_budget {
            truncated = true;
            more = true;
            break;
        }
        let mut pick: Option<usize> = None;
        for (i, s) in sources.iter().enumerate() {
            let Some(head) = &s.head else { continue };
            let better = match pick.and_then(|p| sources[p].head.as_ref()) {
                None => true,
                Some(current) => {
                    let c = cmp_key(&head.key, &current.key);
                    match o.order {
                        Order::Asc => c == Ordering::Less,
                        Order::Desc => c == Ordering::Greater,
                    }
                }
            };
            if better {
                pick = Some(i);
            }
        }
        let Some(pick) = pick else { break };
        if stats.bytes() > budget {
            truncated = true;
            more = true;
            break;
        }
        let Some(c) = sources[pick].head.take() else {
            break;
        };
        advance(
            &mut sources[pick],
            &mut corrupt,
            &mut over_budget,
            &stats,
            budget,
        )?;
        let mut rec: Option<Value> = None;
        if c.pre {
            // (The TypeScript engine withholds a line its redactor cannot walk, nesting deeper than the stack, as
            // corrupt; here such a line does not parse at all, `serde_json` stops at depth 128.)
            rec = Some(redactor.value(&c.rec));
            // The text is matched against the redacted record, so a search cannot confirm a secret.
            if let (Some(v), Some(needle)) = (&rec, &needle) {
                let hay = serde_json::to_string(v).unwrap_or_default().to_lowercase();
                if !hay.contains(needle.as_str()) {
                    rec = None;
                }
            }
        }
        if let Some(record) = rec {
            // RULING: lines with an identical (ts, line hash) at a page boundary stay together (at most 100 extra),
            // because the cursor cannot tell them apart.
            let same_as_last = last_returned
                .as_ref()
                .is_some_and(|l| cmp_key(&c.key, l) == Ordering::Equal)
                && records.len() < o.limit + SAME_KEY_EXTRA;
            if records.len() >= o.limit && !same_as_last {
                more = true;
                break;
            }
            records.push(LogRecordOut {
                ts: c.ts.clone(),
                level: c.level,
                component: c.component.clone(),
                stream: o.filter.stream,
                record,
            });
            last_returned = Some(c.key.clone());
        }
        if first.is_none() {
            first = Some(c.key.clone());
        }
        last = Some(c.key.clone());
    }
    let next_cursor = match (&last, more) {
        (Some(k), true) => Some(encode_cursor(k, &fp)),
        _ => None,
    };
    Ok(QueryResult {
        records,
        next_cursor,
        corrupt,
        scanned_files: files.len(),
        scanned_bytes: stats.bytes(),
        truncated,
        first_key: first,
        last_key: last,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    const BASE: i64 = 1_791_363_600_000;

    fn iso(ms: i64) -> String {
        iso_string(BASE + ms).unwrap()
    }

    fn rec(ms: i64, level: &str, msg: &str) -> String {
        format!(
            "{{\"ts\":\"{}\",\"level\":\"{level}\",\"source\":{{\"kind\":\"harness\",\"id\":\"core\",\"version\":null}},\"event\":\"core.test\",\"msg\":\"{msg}\"}}\n",
            iso(ms)
        )
    }

    fn logs_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        fs::create_dir(&dir).unwrap();
        (root, dir)
    }

    fn put(dir: &Path, name: &str, text: &str) {
        fs::write(dir.join(name), text).unwrap();
    }

    fn msgs(r: &QueryResult) -> Vec<String> {
        r.records
            .iter()
            .map(|x| x.record["msg"].as_str().unwrap().to_string())
            .collect()
    }

    fn q(dir: &Path, order: Order, limit: usize) -> QueryResult {
        run_query(&QueryOptions::new(
            dir,
            LogFilter::new(Stream::Diagnostic),
            order,
            limit,
        ))
        .unwrap()
    }

    #[test]
    fn sha1_matches_the_published_digests() {
        let hex = |s: &str| sha1_hex_prefix(s, 40);
        assert_eq!(hex(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        // 55, 56, 63, 64 and 65 bytes straddle the padding boundary
        assert_eq!(
            hex(&"a".repeat(55)),
            "c1c8bbdc22796e28c0e15163d20899b65621d65a"
        );
        assert_eq!(
            hex(&"a".repeat(56)),
            "c2db330f6083854c99d4b5bfb6e8f29f201be699"
        );
        assert_eq!(
            hex(&"a".repeat(64)),
            "0098ba824b5c16427bd7a1122a5a442a25ec644d"
        );
        assert_eq!(sha1_hex_prefix("abc", 12), "a9993e364706");
    }

    #[test]
    fn base64url_round_trips_and_reads_both_alphabets() {
        for len in 0..40 {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let text = base64url_encode(&data);
            assert!(!text.contains(['+', '/', '=']));
            assert_eq!(base64_decode_lenient(&text), data, "{len}");
        }
        assert_eq!(base64url_encode(&[0xfb, 0xff, 0xbf]), "-_-_");
        assert_eq!(base64_decode_lenient("+/+/"), base64_decode_lenient("-_-_"));
    }

    #[test]
    fn the_prefix_peek_reads_ts_or_at_first_and_nothing_else() {
        let ts = "2026-10-07T09:00:00.000Z";
        let peek = |line: &str| quick_ts(line);
        assert_eq!(
            peek(&format!("{{\"ts\":\"{ts}\",\"x\":1}}")).as_deref(),
            Some(ts)
        );
        assert_eq!(
            peek(&format!("  {{ \"ts\" : \"{ts}\"}}")).as_deref(),
            Some(ts)
        );
        assert_eq!(
            peek(&format!(
                "\u{a0}\u{feff}{{\u{2028}\"at\"\u{3000}:\u{200a}\"{ts}\"}}"
            ))
            .as_deref(),
            Some(ts)
        );
        assert_eq!(peek("{\"at\":1791363600000}").as_deref(), Some(ts));
        assert_eq!(peek("{\"at\":99999999999999999}"), None);
        // a ts that is not first is found by parsing the line
        assert_eq!(
            peek(&format!("{{\"level\":\"info\",\"ts\":\"{ts}\"}}")).as_deref(),
            Some(ts)
        );
        assert_eq!(
            peek("{\"ts\":null,\"at\":0}").as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        // the raw text between the quotes is read as it stands (no unescaping)
        assert_eq!(peek("{\"ts\":\"2026-10-07T09:00:00.000\\u005a\"}"), None);
        assert_eq!(peek("[1,2]"), None);
        assert_eq!(peek("not json"), None);
        assert_eq!(peek(""), None);
        assert_eq!(prefix_value("{\"ts\":12x}"), Some("12"));
        assert_eq!(prefix_value("{\"ts\":x}"), None);
        assert_eq!(prefix_value("{\"tsx\":1}"), None);
    }

    #[test]
    fn dates_outside_the_four_digit_years_print_like_to_iso_string() {
        assert_eq!(iso_string(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(-1).unwrap(), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            iso_string(253_402_300_799_999).unwrap(),
            "9999-12-31T23:59:59.999Z"
        );
        assert_eq!(
            iso_string(253_402_300_800_000).unwrap(),
            "+010000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_string(-62_198_755_200_000).unwrap(),
            "-000001-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_string(8_640_000_000_000_000).unwrap(),
            "+275760-09-13T00:00:00.000Z"
        );
        assert_eq!(
            iso_string(-8_640_000_000_000_000).unwrap(),
            "-271821-04-20T00:00:00.000Z"
        );
        assert_eq!(iso_string(8_640_000_000_000_001), None);
        for ms in [
            0i64,
            951_782_400_000,
            1_791_363_600_123,
            -62_135_596_800_000,
            4_102_444_800_000,
        ] {
            assert_eq!(date_parse(&iso_string(ms).unwrap()), Some(ms));
        }
    }

    #[test]
    fn zoneless_forms_are_read_as_utc_and_the_rest_of_the_grammar_is_strict() {
        let utc = Some(1_791_363_600_000);
        assert_eq!(date_parse("2026-10-07T09:00"), utc);
        assert_eq!(date_parse("2026-10-07 09:00:00"), utc);
        assert_eq!(date_parse("2026-10-07T09:00:00.000"), utc);
        assert_eq!(date_parse("2026-10-07T09:00:00+00:00"), utc);
        assert_eq!(date_parse("2026-10-07T11:00:00+0200"), utc);
        assert_eq!(date_parse("2026-10-07t09:00:00z"), utc);
        // not in the ECMAScript format: V8's legacy parser reads these, this port does not
        for legacy in [
            "Oct 7, 2026",
            "2026/10/07",
            "10/07/2026",
            "Wed, 07 Oct 2026 09:00:00 GMT",
            "12345",
            "2026-1-7",
        ] {
            assert_eq!(date_parse(legacy), None, "{legacy}");
        }
    }

    #[test]
    fn a_symlink_in_the_log_directory_is_not_followed() {
        let (root, dir) = logs_dir();
        let outside = root.path().join("outside.log");
        fs::write(&outside, rec(0, "info", "outside")).unwrap();
        put(&dir, "core.log", &rec(1, "info", "inside"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("evil.log")).unwrap();
        assert_eq!(msgs(&q(&dir, Order::Asc, 100)), ["inside"]);
    }

    #[test]
    fn a_rotation_between_listing_and_opening_is_retried() {
        let (_root, dir) = logs_dir();
        put(
            &dir,
            "core.log",
            &(rec(0, "info", "a") + &rec(1000, "info", "b")),
        );
        let fired = std::cell::Cell::new(false);
        let rotate_once = || {
            if !fired.replace(true) {
                fs::rename(dir.join("core.log"), dir.join("core.log.1")).unwrap();
                fs::write(dir.join("core.log"), rec(2000, "info", "c")).unwrap();
            }
        };
        let mut o = QueryOptions::new(&dir, LogFilter::new(Stream::Diagnostic), Order::Asc, 100);
        o.on_listed = Some(&rotate_once);
        assert_eq!(msgs(&run_query(&o).unwrap()), ["a", "b", "c"]);
    }

    #[test]
    fn a_group_of_equal_timestamps_longer_than_the_cap_is_cut_and_still_delivers_every_line_once() {
        let (_root, dir) = logs_dir();
        let n = 10_050;
        let text: String = (0..n)
            .map(|i| format!("{{\"ts\":\"{}\",\"level\":\"info\",\"n\":{i}}}\n", iso(0)))
            .collect();
        put(&dir, "core.log", &text);
        for order in [Order::Asc, Order::Desc] {
            let r = q(&dir, order, 20_000);
            assert_eq!(r.records.len(), n);
            let unique: std::collections::BTreeSet<u64> = r
                .records
                .iter()
                .map(|x| x.record["n"].as_u64().unwrap())
                .collect();
            assert_eq!(unique.len(), n);
        }
    }

    #[test]
    fn repeated_queries_leave_no_descriptor_behind() {
        let (_root, dir) = logs_dir();
        put(&dir, "core.log", &rec(0, "info", "a"));
        for _ in 0..300 {
            assert_eq!(q(&dir, Order::Asc, 10).records.len(), 1);
        }
    }

    #[test]
    fn the_newest_page_of_a_large_file_reads_a_small_part_of_it() {
        let (_root, dir) = logs_dir();
        let path = dir.join("core.log");
        let mut file = io::BufWriter::new(fs::File::create(&path).unwrap());
        let line = |i: i64| {
            format!(
                "{{\"ts\":\"{}\",\"level\":\"{}\",\"source\":{{\"kind\":\"harness\",\"id\":\"core\",\"version\":null}},\"event\":\"core.test\",\"msg\":\"message number {i} {}\"}}\n",
                iso_string(1_767_225_600_000 + i * 100).unwrap(),
                if i % 1000 == 0 { "error" } else { "info" },
                "word ".repeat(12)
            )
        };
        let total = 330_000;
        for i in 0..total {
            file.write_all(line(i).as_bytes()).unwrap();
        }
        file.flush().unwrap();
        assert!(fs::metadata(&path).unwrap().len() > 55 * 1024 * 1024);
        let at = |i: i64| iso_string(1_767_225_600_000 + i * 100).unwrap();
        let tail = "word ".repeat(12);

        let newest = q(&dir, Order::Desc, 20);
        assert_eq!(newest.records.len(), 20);
        assert_eq!(
            newest.records[0].record["msg"],
            format!("message number {} {tail}", total - 1)
        );
        assert!(newest.scanned_bytes < 1_000_000, "{}", newest.scanned_bytes);

        let mut o = QueryOptions::new(&dir, LogFilter::new(Stream::Diagnostic), Order::Asc, 5);
        o.filter.from = Some(at(150_000));
        let mid = run_query(&o).unwrap();
        assert_eq!(
            mid.records[0].record["msg"],
            format!("message number 150000 {tail}")
        );
        assert!(mid.scanned_bytes < 1_000_000, "{}", mid.scanned_bytes);

        let mut o = QueryOptions::new(&dir, LogFilter::new(Stream::Diagnostic), Order::Desc, 100);
        o.filter.from = Some(at(150_000));
        o.filter.to = Some(at(150_050));
        o.filter.min_level = Some(Level::Error);
        let hit = run_query(&o).unwrap();
        assert_eq!(msgs(&hit), [format!("message number 150000 {tail}")]);
        assert!(hit.scanned_bytes < 2_000_000, "{}", hit.scanned_bytes);
    }

    #[test]
    fn an_injected_redactor_is_applied_before_the_text_match() {
        struct Masking;
        impl TextRedactor for Masking {
            fn text(&self, input: &str) -> String {
                input.to_string()
            }
            fn value(&self, input: &Value) -> Value {
                let mut v = input.clone();
                v["attrs"] = serde_json::json!({"marker": "MASKED"});
                v
            }
        }
        let (_root, dir) = logs_dir();
        put(
            &dir,
            "core.log",
            &format!(
                "{{\"ts\":\"{}\",\"level\":\"info\",\"msg\":\"plain\",\"attrs\":{{\"marker\":\"RAW\"}}}}\n",
                iso(0)
            ),
        );
        let run = |text: &str| {
            let mut o = QueryOptions::new(&dir, LogFilter::new(Stream::Diagnostic), Order::Asc, 10);
            o.filter.text = Some(text.to_string());
            o.redactor = Some(Arc::new(Masking));
            run_query(&o).unwrap()
        };
        let hit = run("masked");
        assert_eq!(hit.records.len(), 1);
        assert_eq!(
            hit.records[0].record["attrs"],
            serde_json::json!({"marker": "MASKED"})
        );
        assert_eq!(run("raw").records.len(), 0);
    }
}
