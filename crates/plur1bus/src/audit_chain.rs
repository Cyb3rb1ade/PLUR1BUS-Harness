//! D1: offline Rust writers share the core's chain and SQLite OS byte-range lock.
//! We do not interpret or modify the SQLite database: an exclusive lock covering its
//! locking bytes conflicts with BEGIN EXCLUSIVE on Unix and Windows alike.
use crate::audit::create_private;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const ACTIVE: &str = "audit-chain.jsonl";
const ANCHOR: &str = "audit-chain.anchor";
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SEQ: u64 = 9_007_199_254_740_991;
/// Written by a writer that moved a trailing anchor up after an interrupted append (the core's `ANCHOR_ADVANCED_ACTION`).
const ANCHOR_ADVANCED_ACTION: &str = "audit.chain.anchor-advanced";
/// First event of a new chain era, written by `audit reanchor` (the core's `REANCHORED_ACTION`).
pub(crate) const REANCHORED_ACTION: &str = "audit.chain.reanchored";
static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn invalid(message: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("audit-chain: {message}; refusing to append"),
    )
}
pub(crate) fn hash_line(line: &str) -> String {
    format!("{:x}", Sha256::digest(line.as_bytes()))
}
fn hex64(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
struct Parsed {
    seq: u64,
    prev: String,
}
fn parse_line(line: &str) -> io::Result<Parsed> {
    let v: Value =
        serde_json::from_str(line).map_err(|_| invalid("last line is not a chain line"))?;
    let seq = v["seq"].as_u64().filter(|s| *s > 0 && *s <= MAX_SEQ);
    if !hex64(&v["prev"]) || !v["rec"].is_object() {
        return Err(invalid("last line is not a chain line"));
    }
    let prev = v["prev"].as_str().unwrap_or_default().to_string();
    seq.map(|seq| Parsed { seq, prev })
        .ok_or_else(|| invalid("last line is not a chain line"))
}
fn rotated(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for e in fs::read_dir(dir)? {
        let p = e?.path();
        let Some(n) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(seq) = n
            .strip_prefix("audit-chain.")
            .and_then(|s| s.strip_suffix(".jsonl"))
        {
            if seq.len() == 10 && seq.bytes().all(|c| c.is_ascii_digit()) {
                files.push(p);
            }
        }
    }
    files.sort();
    Ok(files)
}

/// The newest line of the chain as the writers see it. `prev` is that line's own back-link; an empty chain is
/// `(0, GENESIS)` with a genesis back-link.
struct Tail {
    seq: u64,
    hash: String,
    prev: String,
}
fn tail(dir: &Path) -> io::Result<Tail> {
    let mut candidates = rotated(dir)?;
    candidates.push(dir.join(ACTIVE));
    for p in candidates.into_iter().rev() {
        let bytes = match fs::read(&p) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        if end < bytes.len() {
            let evidence = p.with_file_name(format!(
                "{}.torn-{}",
                p.file_name().unwrap().to_string_lossy(),
                uuid::Uuid::new_v4()
            ));
            let mut f = create_private(&evidence, false)?;
            f.write_all(&bytes[end..])?;
            f.sync_all()?;
            OpenOptions::new()
                .write(true)
                .open(&p)?
                .set_len(end as u64)?;
        }
        if end == 0 {
            continue;
        }
        let start = bytes[..end - 1]
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |i| i + 1);
        let raw = std::str::from_utf8(&bytes[start..end - 1])
            .map_err(|_| invalid("last line is not UTF-8"))?;
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let parsed = parse_line(line)?;
        return Ok(Tail {
            seq: parsed.seq,
            hash: hash_line(line),
            prev: parsed.prev,
        });
    }
    Ok(Tail {
        seq: 0,
        hash: GENESIS.into(),
        prev: GENESIS.into(),
    })
}

/// What `audit-chain.anchor` says. Anything that is not a well-formed anchor, including bytes that are not UTF-8, is
/// `Invalid`; only a missing file is `Absent`.
enum Anchor {
    Absent,
    Invalid,
    At(u64, String),
}
fn read_anchor(dir: &Path) -> io::Result<Anchor> {
    let bytes = match fs::read(dir.join(ANCHOR)) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Anchor::Absent),
        Err(e) => return Err(e),
    };
    let Ok(a) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(Anchor::Invalid);
    };
    let seq = a["seq"].as_u64().filter(|s| *s > 0 && *s <= MAX_SEQ);
    match (seq, a["hash"].as_str()) {
        (Some(seq), Some(hash)) if a["v"] == 1 && hex64(&a["hash"]) => {
            Ok(Anchor::At(seq, hash.to_string()))
        }
        _ => Ok(Anchor::Invalid),
    }
}

/// Why a writer refuses. The messages are the ones `append` has always used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Disagreement {
    TailMalformed,
    AnchorMissing,
    AnchorInvalid,
    ChainShorterThanAnchor,
    TailMismatch,
}
impl Disagreement {
    fn message(self) -> &'static str {
        match self {
            Self::TailMalformed => "last line is not a chain line",
            Self::AnchorMissing => "anchor is missing",
            Self::AnchorInvalid => "anchor is invalid",
            Self::ChainShorterThanAnchor => "chain is shorter than its anchor",
            Self::TailMismatch => "tail does not match the anchor",
        }
    }
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::TailMalformed => "tail-malformed",
            Self::AnchorMissing => "anchor-missing",
            Self::AnchorInvalid => "anchor-invalid",
            Self::ChainShorterThanAnchor => "chain-shorter-than-anchor",
            Self::TailMismatch => "tail-mismatch",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    /// The tail is what the anchor remembers.
    Agree,
    /// The one crash state a writer heals: see [`judge`].
    Advance,
    Refuse(Disagreement),
}

/// What a writer does about the anchor. Only one disagreement is healed: the newest line is exactly one line past the
/// anchor and chains to the anchor's hash, i.e. the line is complete and correctly linked and only the anchor write after
/// it was lost (a crash or SIGKILL between the fsync of the line and the rename of the anchor). A missing anchor is never
/// healed, not even for a one-line chain (`cli_events_join_the_chain_and_refuse_tampered_anchors` pins that deleting the
/// anchor is a refusal); a crash during the very first write of an installation is left to `audit reanchor`. Every other
/// disagreement is a refusal as well. `verdict` additionally checks that the line before the newest one still hashes to
/// the anchor's hash.
fn judge(tail: &Tail, anchor: &Anchor) -> Verdict {
    match anchor {
        Anchor::Invalid => Verdict::Refuse(Disagreement::AnchorInvalid),
        Anchor::Absent if tail.seq == 0 => Verdict::Agree,
        Anchor::Absent => Verdict::Refuse(Disagreement::AnchorMissing),
        Anchor::At(seq, _) if *seq > tail.seq => {
            Verdict::Refuse(Disagreement::ChainShorterThanAnchor)
        }
        Anchor::At(seq, hash) if *seq == tail.seq && *hash == tail.hash => Verdict::Agree,
        Anchor::At(seq, hash) if *seq + 1 == tail.seq && *hash == tail.prev => Verdict::Advance,
        Anchor::At(..) => Verdict::Refuse(Disagreement::TailMismatch),
    }
}

/// The complete lines of a file (terminated by `\n`, a trailing `\r` removed); an unterminated tail is not one.
fn complete_lines(bytes: &[u8]) -> Vec<&[u8]> {
    let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let mut lines: Vec<&[u8]> = bytes[..end]
        .split(|b| *b == b'\n')
        .map(|l| l.strip_suffix(b"\r").unwrap_or(l))
        .collect();
    lines.pop(); // the empty piece after the last terminator
    lines
}
fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
/// Whether the complete line before the newest one (across rotated files) hashes to `expected`.
fn line_before_tail_hashes(dir: &Path, expected: &str) -> io::Result<bool> {
    let mut files = rotated(dir)?;
    files.push(dir.join(ACTIVE));
    let mut seen = 0;
    for p in files.into_iter().rev() {
        let bytes = match fs::read(&p) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for line in complete_lines(&bytes).into_iter().rev() {
            seen += 1;
            if seen == 2 {
                return Ok(hash_bytes(line) == expected);
            }
        }
    }
    Ok(false)
}
/// [`judge`], plus the check an advance needs: the line the anchor pinned must still be that line.
fn verdict(dir: &Path, tail: &Tail, anchor: &Anchor) -> io::Result<Verdict> {
    let v = judge(tail, anchor);
    if v == Verdict::Advance && !line_before_tail_hashes(dir, &tail.prev)? {
        return Ok(Verdict::Refuse(Disagreement::TailMismatch));
    }
    Ok(v)
}

/// Lock SQLite's pending/reserved/shared locking range at 0x40000000.
/// Keep the database header outside the lock (Windows locks also restrict reads). Do not use flock: SQLite uses fcntl and the namespaces differ.
struct OsLock(File);
impl OsLock {
    fn acquire(dir: &Path) -> io::Result<Self> {
        let file = create_private(&dir.join("audit-chain.lock"), false)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match try_lock(&file) {
                Ok(true) => return Ok(Self(file)),
                Ok(false) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Ok(false) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "audit-chain: lock timeout",
                    ))
                }
                Err(e) => return Err(e),
            }
        }
    }
}
#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<bool> {
    use std::os::fd::AsRawFd;
    // SAFETY: zero is a valid starting representation of flock; all relevant fields
    // are set below, and the pointer remains valid for this synchronous fcntl call.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _;
    lock.l_whence = libc::SEEK_SET as _;
    lock.l_start = 0x4000_0000;
    lock.l_len = 512; // SQLite pending + reserved + shared bytes, beyond present EOF
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) } == 0 {
        return Ok(true);
    }
    let e = io::Error::last_os_error();
    if matches!(e.raw_os_error(), Some(libc::EACCES | libc::EAGAIN)) {
        Ok(false)
    } else {
        Err(e)
    }
}
#[cfg(windows)]
fn try_lock(file: &File) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::{OVERLAPPED, OVERLAPPED_0, OVERLAPPED_0_0};
    let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
    ov.Anonymous = OVERLAPPED_0 {
        Anonymous: OVERLAPPED_0_0 {
            Offset: 0x4000_0000,
            OffsetHigh: 0,
        },
    };
    if unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            512,
            0,
            &mut ov,
        )
    } != 0
    {
        return Ok(true);
    }
    let e = io::Error::last_os_error();
    if e.raw_os_error() == Some(33) {
        Ok(false)
    } else {
        Err(e)
    } // ERROR_LOCK_VIOLATION
}
impl Drop for OsLock {
    fn drop(&mut self) {
        // Closing the file releases the OS lock, including on process termination.
        let _ = &self.0;
    }
}

fn write_anchor(dir: &Path, seq: u64, hash: &str) -> io::Result<()> {
    let tmp = dir.join(format!("{ANCHOR}.tmp"));
    let mut a = create_private(&tmp, true)?;
    writeln!(a, "{}", json!({"v": 1, "seq": seq, "hash": hash}))?;
    a.sync_all()?;
    drop(a);
    fs::rename(&tmp, dir.join(ANCHOR))
}

/// Rotates when the active file is full, then writes one line chained to `start`, fsyncs it and moves the anchor.
/// Returns the new tail. The caller holds the chain lock.
fn write_line(dir: &Path, start: &Tail, rec: &Value) -> io::Result<Tail> {
    if start.seq >= MAX_SEQ {
        return Err(invalid("sequence exhausted"));
    }
    let active = dir.join(ACTIVE);
    if active.metadata().is_ok_and(|m| m.len() >= MAX_BYTES) {
        let text = fs::read_to_string(&active)?;
        if let Some(first) = text.lines().next() {
            let target = dir.join(format!("audit-chain.{:010}.jsonl", parse_line(first)?.seq));
            if target.exists() {
                return Err(invalid("rotation target exists"));
            }
            fs::rename(&active, target)?;
        }
    }
    let seq = start.seq + 1;
    let line = format!(
        "{{\"seq\":{seq},\"prev\":\"{}\",\"rec\":{rec}}}",
        start.hash
    );
    drop(create_private(&active, false)?);
    let mut f = OpenOptions::new().append(true).open(&active)?;
    f.write_all(format!("{line}\n").as_bytes())?;
    f.sync_all()?;
    let hash = hash_line(&line);
    write_anchor(dir, seq, &hash)?;
    Ok(Tail {
        seq,
        hash,
        prev: start.hash.clone(),
    })
}

/// The event a writer records when it moves a trailing anchor up (see [`judge`]), ahead of the event it was asked to write.
fn anchor_advanced_event(from: u64, to: u64) -> Value {
    let caller = crate::identity::caller();
    json!({
        "at": crate::audit::now_ms(),
        "actor": { "user": caller.user_id, "host": caller.account_id },
        "action": ANCHOR_ADVANCED_ACTION,
        "target": ANCHOR,
        "detail": { "fromSeq": from, "toSeq": to, "writer": "cli" },
    })
}

/// One append under the chain lock.
fn append_locked(dir: &Path, rec: &Value) -> io::Result<()> {
    let t = tail(dir)?;
    let anchor = read_anchor(dir)?;
    // Fail closed when the chain is not what the anchor remembers: appending would paper over the tampering.
    let t = match verdict(dir, &t, &anchor)? {
        Verdict::Agree => t,
        Verdict::Refuse(why) => return Err(invalid(why.message())),
        Verdict::Advance => {
            // The one recoverable crash state: pull the anchor up to the line it missed and record that in the chain, ahead of
            // the event being appended, so every later verify can see it.
            let from = t.seq - 1;
            write_anchor(dir, t.seq, &t.hash)?;
            eprintln!(
                "plur1bus: audit-chain: the anchor trailed the chain by one complete line (an interrupted write); moved it from seq {from} to {}",
                t.seq
            );
            write_line(dir, &t, &anchor_advanced_event(from, t.seq))?
        }
    };
    write_line(dir, &t, rec).map(drop)
}

pub(crate) fn append(dir: &Path, rec: &Value) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    // fcntl locks belong to the process, so threads also need a mutex.
    let _thread = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let _lock = OsLock::acquire(dir)?;
    append_locked(dir, rec)
}

/// Where the intact part of a chain ends: the first line that does not follow from the ones before it.
pub(crate) struct Break {
    pub(crate) code: &'static str,
    pub(crate) file: String,
    pub(crate) line: u64,
}

/// A read-only look at the chain files and the anchor: what `audit reanchor` shows and acts on. Nothing here changes a file
/// (not even the unterminated tail that a writer sets aside).
pub(crate) struct Inspection {
    /// Chain files that exist, oldest first (rotated ones by their first seq, then the active one).
    pub(crate) files: Vec<String>,
    /// Complete lines in all of them.
    pub(crate) lines: u64,
    /// Lines of the intact prefix: they chain from the genesis hash without a gap up to the first deviation.
    pub(crate) valid_lines: u64,
    pub(crate) first_break: Option<Break>,
    /// `(seq, hash)` of the last line of the intact prefix.
    pub(crate) last_valid: Option<(u64, String)>,
    /// `(seq, hash)` of the newest line as the writers see it; `None` for an empty chain or when that line is malformed.
    pub(crate) end: Option<(u64, String)>,
    pub(crate) end_malformed: bool,
    pub(crate) torn_tail: bool,
    anchor: Anchor,
    verdict: Verdict,
}

impl Inspection {
    /// The disagreement that makes writers refuse, if there is one. `None` also for the state a writer heals by itself.
    pub(crate) fn disagreement(&self) -> Option<Disagreement> {
        match self.verdict {
            Verdict::Refuse(d) => Some(d),
            _ => None,
        }
    }
    /// A crash left the anchor one complete line behind; the next write moves it up.
    pub(crate) fn heals_itself(&self) -> bool {
        self.verdict == Verdict::Advance
    }
    pub(crate) fn anchor_json(&self) -> Value {
        match &self.anchor {
            Anchor::Absent => json!({"status": "missing"}),
            Anchor::Invalid => json!({"status": "invalid"}),
            Anchor::At(seq, hash) => json!({"status": "ok", "seq": seq, "hash": hash}),
        }
    }
    pub(crate) fn end_json(&self) -> Value {
        match &self.end {
            Some((seq, hash)) => json!({"seq": seq, "hash": hash}),
            None => Value::Null,
        }
    }
    pub(crate) fn last_valid_json(&self) -> Value {
        match &self.last_valid {
            Some((seq, hash)) => json!({"seq": seq, "hash": hash}),
            None => Value::Null,
        }
    }
    pub(crate) fn first_break_json(&self) -> Value {
        match &self.first_break {
            Some(b) => json!({"code": b.code, "file": b.file, "line": b.line}),
            None => Value::Null,
        }
    }
    /// The finding as one JSON object (no record content: seqs, hashes, counts and file names).
    pub(crate) fn json(&self) -> Value {
        json!({
            "files": self.files,
            "lines": self.lines,
            "validLines": self.valid_lines,
            "firstBreak": self.first_break_json(),
            "lastValid": self.last_valid_json(),
            "end": self.end_json(),
            "endMalformed": self.end_malformed,
            "tornTail": self.torn_tail,
            "anchor": self.anchor_json(),
            "disagreement": self.disagreement().map(Disagreement::code),
            "healsItself": self.heals_itself(),
        })
    }
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}
/// The chain files in order: rotated ones, then the active one, as far as they exist.
fn chain_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = rotated(dir)?;
    let active = dir.join(ACTIVE);
    if active.is_file() {
        files.push(active);
    }
    Ok(files)
}

fn inspect(dir: &Path) -> io::Result<Inspection> {
    let paths = chain_files(dir)?;
    let mut files = Vec::new();
    let (mut lines, mut valid_lines) = (0u64, 0u64);
    let mut first_break: Option<Break> = None;
    let mut last_valid: Option<(u64, String)> = None;
    // The newest line seen so far: `Ok((seq, hash, prev))`, or `Err(())` when it is not a chain line.
    let mut newest: Option<Result<Tail, ()>> = None;
    let mut torn_tail = false;
    for p in &paths {
        let bytes = match fs::read(p) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let name = file_name(p);
        files.push(name.clone());
        let in_file = complete_lines(&bytes);
        let mut first_seq_in_file: Option<u64> = None;
        for (i, raw) in in_file.iter().enumerate() {
            lines += 1;
            let hash = hash_bytes(raw);
            let parsed = std::str::from_utf8(raw)
                .ok()
                .and_then(|l| parse_line(l).ok());
            newest = Some(match &parsed {
                Some(line) => Ok(Tail {
                    seq: line.seq,
                    hash: hash.clone(),
                    prev: line.prev.clone(),
                }),
                None => Err(()),
            });
            if first_break.is_some() {
                continue;
            }
            let at = (i + 1) as u64;
            let broke = |code| {
                Some(Break {
                    code,
                    file: name.clone(),
                    line: at,
                })
            };
            let Some(parsed) = parsed else {
                first_break = broke("line-malformed");
                continue;
            };
            first_seq_in_file.get_or_insert(parsed.seq);
            let deviation = match &last_valid {
                None if parsed.prev != GENESIS || parsed.seq != 1 => Some("prefix-missing"),
                Some((_, prev_hash)) if parsed.prev != *prev_hash => Some("hash-mismatch"),
                Some((seq, _)) if parsed.seq != *seq + 1 => Some("seq-gap"),
                _ => None,
            };
            match deviation {
                Some(code) => first_break = broke(code),
                None => {
                    valid_lines += 1;
                    last_valid = Some((parsed.seq, hash));
                }
            }
        }
        if first_break.is_none() {
            let named = name
                .strip_prefix("audit-chain.")
                .and_then(|s| s.strip_suffix(".jsonl"))
                .and_then(|s| s.parse::<u64>().ok());
            if let (Some(named), Some(first)) = (named, first_seq_in_file) {
                if named != first {
                    first_break = Some(Break {
                        code: "file-name-mismatch",
                        file: name.clone(),
                        line: 1,
                    });
                }
            }
        }
        let unterminated = bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(!bytes.is_empty(), |i| i + 1 < bytes.len());
        if unterminated {
            torn_tail = true;
            if first_break.is_none() {
                first_break = Some(Break {
                    code: "torn-tail",
                    file: name,
                    line: in_file.len() as u64 + 1,
                });
            }
        }
    }
    let anchor = read_anchor(dir)?;
    let (newest_tail, end, end_malformed) = match newest {
        None => (
            Some(Tail {
                seq: 0,
                hash: GENESIS.into(),
                prev: GENESIS.into(),
            }),
            None,
            false,
        ),
        Some(Ok(t)) => {
            let end = Some((t.seq, t.hash.clone()));
            (Some(t), end, false)
        }
        Some(Err(())) => (None, None, true),
    };
    // A writer meets a malformed newest line before it looks at the anchor.
    let judged = match &newest_tail {
        None => Verdict::Refuse(Disagreement::TailMalformed),
        Some(t) => verdict(dir, t, &anchor)?,
    };
    Ok(Inspection {
        files,
        lines,
        valid_lines,
        first_break,
        last_valid,
        end,
        end_malformed,
        torn_tail,
        anchor,
        verdict: judged,
    })
}

#[derive(Debug)]
pub(crate) enum ReanchorError {
    /// Writers do not refuse this chain (or there is none): there is nothing to repair. `true`: the anchor trails by one
    /// complete line and the next write moves it up by itself.
    NothingToRepair(bool),
    Io(io::Error),
}
impl From<io::Error> for ReanchorError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// What `audit reanchor` found, and, unless it was a dry run, what it did.
pub(crate) struct Reanchored {
    pub(crate) inspection: Inspection,
    pub(crate) dry_run: bool,
    /// `pre-reanchor-<ms>`: the suffix of the set-aside files. Empty for a dry run.
    pub(crate) suffix: String,
    /// Names of the files that were (or would be) set aside: the chain files, then the anchor.
    pub(crate) aside: Vec<String>,
    /// The event that is the first line of the new chain; `Null` for a dry run.
    pub(crate) event: Value,
}

/// The files `audit reanchor` sets aside: every chain file, then the anchor if there is one.
fn aside_candidates(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = chain_files(dir)?;
    let anchor = dir.join(ANCHOR);
    if anchor.is_file() {
        files.push(anchor);
    }
    Ok(files)
}

/// Starts a new era of the chain after writers refused the old one (owner decision of 20 Oct 2026: a damaged anchor must
/// not block the audit for good, and the tampering must stay visible).
///
/// Under the chain lock: the state is inspected; if writers do not refuse it, nothing is done
/// ([`ReanchorError::NothingToRepair`]). Otherwise every chain file and the anchor are renamed to `<name>.pre-reanchor-<ms>`
/// (never deleted, never rewritten), and the first line of a new chain is an `audit.chain.reanchored` event that carries the old
/// anchor, the old end, the redacted `reason`, the actor and the names of the set-aside files; the new anchor follows. `reason`
/// is recorded as given: the caller redacts it. With `dry_run` only the inspection is returned.
///
/// A crash between the renames and the event leaves the old files set aside under their suffix and an empty chain; the next
/// writer starts a chain without the event, and `audit.verify` then reports the set as `announced: false`.
pub(crate) fn reanchor(
    dir: &Path,
    reason: &str,
    dry_run: bool,
) -> Result<Reanchored, ReanchorError> {
    if !dir.is_dir() {
        return Err(ReanchorError::NothingToRepair(false));
    }
    let _thread = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let _lock = OsLock::acquire(dir)?;
    let inspection = inspect(dir)?;
    let Some(disagreement) = inspection.disagreement() else {
        return Err(ReanchorError::NothingToRepair(inspection.heals_itself()));
    };
    let sources = aside_candidates(dir)?;
    let names: Vec<String> = sources.iter().map(|p| file_name(p)).collect();
    if dry_run {
        return Ok(Reanchored {
            inspection,
            dry_run,
            suffix: String::new(),
            aside: names,
            event: Value::Null,
        });
    }
    let at = crate::audit::now_ms();
    let suffix = format!("pre-reanchor-{at}");
    let moves: Vec<(PathBuf, PathBuf)> = sources
        .iter()
        .map(|p| {
            (
                p.clone(),
                p.with_file_name(format!("{}.{suffix}", file_name(p))),
            )
        })
        .collect();
    if let Some((_, target)) = moves.iter().find(|(_, t)| t.exists()) {
        return Err(ReanchorError::Io(invalid(&format!(
            "{} already exists",
            file_name(target)
        ))));
    }
    let caller = crate::identity::caller();
    let aside: Vec<String> = moves.iter().map(|(_, t)| file_name(t)).collect();
    let event = json!({
        "at": at,
        "actor": { "user": caller.user_id, "host": caller.account_id },
        "action": REANCHORED_ACTION,
        "target": "audit-chain",
        "detail": {
            "reason": reason,
            "disagreement": disagreement.code(),
            "previousAnchor": inspection.anchor_json(),
            "previousEnd": inspection.end_json(),
            "lines": inspection.lines,
            "validLines": inspection.valid_lines,
            "lastValid": inspection.last_valid_json(),
            "firstBreak": inspection.first_break_json(),
            "asideSuffix": suffix,
            "aside": aside,
            "asideDir": dir.display().to_string(),
        },
    });
    let mut done: Vec<&(PathBuf, PathBuf)> = Vec::new();
    let mut failure: Option<io::Error> = None;
    for m in &moves {
        match fs::rename(&m.0, &m.1) {
            Ok(()) => done.push(m),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    // The old chain is gone from its names: start the new one. Any failure puts everything back.
    let started = match failure {
        None => append_locked(dir, &event).err(),
        Some(e) => Some(e),
    };
    if let Some(e) = started {
        if done.len() == moves.len() {
            // Remove what the new chain wrote before putting the old files back under their names.
            let _ = fs::remove_file(dir.join(ACTIVE));
            let _ = fs::remove_file(dir.join(ANCHOR));
        }
        for m in done.iter().rev() {
            let _ = fs::rename(&m.1, &m.0);
        }
        return Err(ReanchorError::Io(e));
    }
    Ok(Reanchored {
        inspection,
        dry_run,
        suffix,
        aside,
        event,
    })
}

#[cfg(test)]
#[path = "../tests/common/prerequisites.rs"]
mod test_prerequisites;

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn shared_vectors_preserve_hashes_crlf_and_rotation_continuity() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/audit-chain-v1.json"))
                .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let lines = fixture["lines"].as_array().unwrap();
        let text: String = lines
            .iter()
            .map(|v| {
                let line = v["line"].as_str().unwrap();
                assert_eq!(hash_line(line), v["hash"].as_str().unwrap());
                format!("{line}\r\n")
            })
            .collect();
        fs::write(dir.path().join("audit-chain.0000000001.jsonl"), text).unwrap();
        let last = lines.last().unwrap();
        fs::write(
            dir.path().join(ANCHOR),
            json!({"v":1,"seq":last["seq"],"hash":last["hash"]}).to_string(),
        )
        .unwrap();
        append(dir.path(), &json!({"action":"rust.fixture"})).unwrap();
        let line: Value =
            serde_json::from_str(fs::read_to_string(dir.path().join(ACTIVE)).unwrap().trim())
                .unwrap();
        assert_eq!(line["seq"], 4);
        assert_eq!(line["prev"], last["hash"]);
    }

    #[test]
    fn every_anchor_disagreement_refuses_new_events_without_reanchoring() {
        for failure in ["missing", "invalid", "short", "tail", "behind"] {
            let dir = tempfile::tempdir().unwrap();
            let rec = json!({"at":1,"actor":{"user":"u","host":"h"},"action":"test","target":"t","detail":{}});
            append(dir.path(), &rec).unwrap();
            let first = fs::read(dir.path().join(ACTIVE)).unwrap();
            let first_anchor = fs::read(dir.path().join(ANCHOR)).unwrap();
            append(dir.path(), &rec).unwrap();
            // A third line makes "behind" two lines behind. An anchor exactly one correctly chained line behind is the
            // crash state writers heal themselves (`a_crash_between_the_line_and_the_anchor_is_healed_by_the_next_writer`).
            append(dir.path(), &rec).unwrap();
            match failure {
                "missing" => fs::remove_file(dir.path().join(ANCHOR)).unwrap(),
                "invalid" => fs::write(dir.path().join(ANCHOR), "{}").unwrap(),
                "short" => fs::write(dir.path().join(ACTIVE), &first).unwrap(),
                "tail" => {
                    let bytes = fs::read_to_string(dir.path().join(ACTIVE)).unwrap();
                    fs::write(
                        dir.path().join(ACTIVE),
                        bytes.replace("\"target\":\"t\"", "\"target\":\"changed\""),
                    )
                    .unwrap();
                }
                "behind" => fs::write(dir.path().join(ANCHOR), &first_anchor).unwrap(),
                _ => unreachable!(),
            }
            let before = fs::read(dir.path().join(ACTIVE)).unwrap();
            assert!(
                append(dir.path(), &rec).is_err(),
                "{failure} must fail closed"
            );
            assert_eq!(fs::read(dir.path().join(ACTIVE)).unwrap(), before);
        }
    }

    #[test]
    fn rust_rotation_keeps_the_previous_hash_and_sequence() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &json!({"at":1,"actor":{"user":"u","host":"h"},"action":"test","target":"t","detail":{"pad":"x".repeat(MAX_BYTES as usize)}})).unwrap();
        let first = fs::read_to_string(dir.path().join(ACTIVE)).unwrap();
        append(dir.path(), &json!({"at":2,"actor":{"user":"u","host":"h"},"action":"test","target":"t","detail":{}})).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("audit-chain.0000000001.jsonl")).unwrap(),
            first
        );
        let second: Value =
            serde_json::from_str(fs::read_to_string(dir.path().join(ACTIVE)).unwrap().trim())
                .unwrap();
        assert_eq!(second["seq"], 2);
        assert_eq!(second["prev"], hash_line(first.trim_end_matches('\n')));
    }

    #[test]
    fn torn_chain_fragment_is_preserved_before_the_next_complete_record() {
        let dir = tempfile::tempdir().unwrap();
        let rec = json!({"at":1,"actor":{"user":"u","host":"h"},"action":"test","target":"t","detail":{}});
        append(dir.path(), &rec).unwrap();
        OpenOptions::new()
            .append(true)
            .open(dir.path().join(ACTIVE))
            .unwrap()
            .write_all(b"torn evidence")
            .unwrap();
        append(dir.path(), &rec).unwrap();
        let evidence: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains(".torn-"))
            .collect();
        assert_eq!(evidence.len(), 1);
        assert_eq!(fs::read(&evidence[0]).unwrap(), b"torn evidence");
        let text = fs::read_to_string(dir.path().join(ACTIVE)).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(text.lines().last().unwrap()).unwrap()["seq"],
            2
        );
    }

    // The subprocess branch invokes the actual CLI audit producer, not a replica of
    // the chain algorithm. No production test switch or additional binary is needed.
    #[test]
    fn mixed_typescript_and_rust_processes_share_one_intact_chain() {
        if let Some(home) = std::env::var_os("PLUR1BUS_AUDIT_TEST_CHILD_HOME") {
            let layout = crate::paths::Layout::new(home.into());
            for i in 0..30 {
                crate::audit::append(&layout, "rust.process", "fixture", json!({"i":i})).unwrap();
            }
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        super::test_prerequisites::require("audit", &root);
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
        let mut children = Vec::new();
        for i in 0..3 {
            children.push(Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "audit::chain::tests::mixed_typescript_and_rust_processes_share_one_intact_chain", "--nocapture"])
                .env("PLUR1BUS_AUDIT_TEST_CHILD_HOME", dir.path()).stdout(Stdio::null()).spawn().unwrap());
            children.push(
                Command::new(&node)
                    .current_dir(&root)
                    .args([
                        "--experimental-strip-types",
                        "--conditions=source",
                        "--no-warnings=ExperimentalWarning",
                        "packages/core/test/audit/writer-child.ts",
                    ])
                    .arg(&logs)
                    .arg(format!("ts-{i}"))
                    .arg("30")
                    .stdout(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }
        let verify = |dir: &Path| {
            let output = Command::new(&node).current_dir(&root)
                .args(["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "-e", "import {createAuditChain} from './packages/core/src/audit/chain.ts'; console.log(JSON.stringify(createAuditChain({dir:process.argv[1]}).verify()))"])
                .arg(dir).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice::<Value>(&output.stdout).unwrap()
        };
        let ok = verify(&logs);
        assert_eq!(ok["ok"], true, "{ok}");
        assert_eq!(ok["records"], 180);
        assert_eq!(ok["lastSeq"], 180);
        let active = logs.join(ACTIVE);
        let bytes = fs::read_to_string(&active).unwrap();
        let tampered = bytes.replacen("\"at\":", "\"tampered\":", 1);
        fs::write(&active, tampered).unwrap();
        let bad = verify(&logs);
        assert_eq!(bad["ok"], false);
        assert!(bad["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["code"] == "hash-mismatch"));
    }

    // The same file the TypeScript writer reads (`packages/core/test/audit/shared-recovery.test.ts`).
    #[test]
    fn shared_recovery_vectors_give_the_same_verdicts_as_the_typescript_writer() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/audit-chain-recovery-v1.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let lines: Vec<&str> = case["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap())
                .collect();
            let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
            fs::write(dir.path().join(ACTIVE), &text).unwrap();
            if let Some(anchor) = case["anchor"].as_str() {
                fs::write(dir.path().join(ANCHOR), anchor).unwrap();
            }
            let event = json!({"at":5000,"actor":{"user":"test","host":"fixture"},"action":"vector.event","target":"t","detail":{}});
            let expect = &case["expect"];
            let result = append(dir.path(), &event);
            if expect["outcome"] == "refused" {
                let message = expect["message"].as_str().unwrap();
                let err = result.expect_err(name).to_string();
                assert!(err.contains(message), "{name}: {err}");
                assert_eq!(fs::read_to_string(dir.path().join(ACTIVE)).unwrap(), text);
                if let Some(anchor) = case["anchor"].as_str() {
                    assert_eq!(
                        fs::read_to_string(dir.path().join(ANCHOR)).unwrap(),
                        anchor,
                        "{name}: a refusal leaves the anchor alone"
                    );
                }
                continue;
            }
            result.expect(name);
            let all = fs::read_to_string(dir.path().join(ACTIVE)).unwrap();
            let all: Vec<&str> = all.lines().collect();
            assert_eq!(&all[..lines.len()], &lines[..], "{name}");
            let rest: Vec<Value> = all[lines.len()..]
                .iter()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect();
            assert_eq!(
                rest.len(),
                if expect["advanced"] == true { 2 } else { 1 },
                "{name}"
            );
            if expect["advanced"] == true {
                assert_eq!(rest[0]["rec"]["action"], ANCHOR_ADVANCED_ACTION, "{name}");
                assert_eq!(
                    rest[0]["rec"]["detail"]["fromSeq"], expect["fromSeq"],
                    "{name}"
                );
                assert_eq!(rest[0]["rec"]["detail"]["toSeq"], expect["toSeq"], "{name}");
            }
            assert_eq!(rest.last().unwrap()["rec"]["action"], "vector.event");
            let anchor: Value =
                serde_json::from_str(&fs::read_to_string(dir.path().join(ANCHOR)).unwrap())
                    .unwrap();
            assert_eq!(anchor["seq"], all.len(), "{name}");
            assert_eq!(anchor["hash"], hash_line(all.last().unwrap()), "{name}");
        }
    }

    fn rec(i: u64) -> Value {
        json!({"at":i,"actor":{"user":"u","host":"h"},"action":"test","target":"t","detail":{"i":i}})
    }
    fn active_lines(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join(ACTIVE))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }
    fn anchor_json(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(ANCHOR)).unwrap()).unwrap()
    }
    fn set_anchor(dir: &Path, seq: u64, hash: &str) {
        fs::write(
            dir.join(ANCHOR),
            format!("{}\n", json!({"v":1,"seq":seq,"hash":hash})),
        )
        .unwrap();
    }

    // The crash window of `append`: the line is fsynced first, the anchor replaced second. The states are built directly
    // (no process is killed): a correctly chained line one past the anchor.
    #[test]
    fn a_crash_between_the_line_and_the_anchor_is_healed_by_the_next_writer() {
        let dir = tempfile::tempdir().unwrap();
        for i in 1..=3 {
            append(dir.path(), &rec(i)).unwrap();
        }
        let before = active_lines(dir.path());
        set_anchor(dir.path(), 2, &hash_line(&before[1]));
        append(dir.path(), &rec(4)).unwrap();
        let after = active_lines(dir.path());
        assert_eq!(&after[..3], &before[..], "no earlier line is rewritten");
        assert_eq!(after.len(), 5);
        let note: Value = serde_json::from_str(&after[3]).unwrap();
        assert_eq!(note["seq"], 4);
        assert_eq!(note["prev"], hash_line(&before[2]));
        assert_eq!(note["rec"]["action"], ANCHOR_ADVANCED_ACTION);
        assert_eq!(note["rec"]["target"], ANCHOR);
        assert_eq!(note["rec"]["detail"]["fromSeq"], 2);
        assert_eq!(note["rec"]["detail"]["toSeq"], 3);
        let last: Value = serde_json::from_str(&after[4]).unwrap();
        assert_eq!(last["rec"], rec(4));
        assert_eq!(last["prev"], hash_line(&after[3]));
        let anchor = anchor_json(dir.path());
        assert_eq!(anchor["seq"], 5);
        assert_eq!(anchor["hash"], hash_line(&after[4]));
    }

    // Not healed: a missing anchor stays a refusal, also for a chain of one line (a crash during the very first write of an
    // installation, or the anchor deleted). `audit reanchor` is the way out.
    #[test]
    fn a_missing_anchor_is_not_healed_even_for_a_one_line_chain() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &rec(1)).unwrap();
        fs::remove_file(dir.path().join(ANCHOR)).unwrap();
        let before = files_of(dir.path());
        assert!(append(dir.path(), &rec(2)).is_err());
        assert_eq!(files_of(dir.path()), before);
        let ins = inspect(dir.path()).unwrap();
        assert_eq!(
            ins.disagreement().map(Disagreement::code),
            Some("anchor-missing")
        );
    }

    #[test]
    fn a_missed_anchor_after_a_rotation_is_healed_in_the_new_file() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &rec(1)).unwrap();
        append(dir.path(), &rec(2)).unwrap();
        let rotated = dir.path().join("audit-chain.0000000001.jsonl");
        let old_last = active_lines(dir.path())[1].clone();
        fs::rename(dir.path().join(ACTIVE), &rotated).unwrap();
        append(dir.path(), &rec(3)).unwrap(); // seq 3 chains to the rotated file's last line
        set_anchor(dir.path(), 2, &hash_line(&old_last));
        append(dir.path(), &rec(4)).unwrap();
        let tail = tail(dir.path()).unwrap();
        assert_eq!(tail.seq, 5);
        assert_eq!(anchor_json(dir.path())["seq"], 5);
    }

    #[test]
    fn a_trailing_anchor_is_not_moved_when_the_anchored_line_was_changed_or_the_extra_line_is_not_chained(
    ) {
        let rec1 = rec(1);
        for failure in [
            "anchored-line-altered",
            "not-chained",
            "seq-skips",
            "malformed",
        ] {
            let dir = tempfile::tempdir().unwrap();
            for i in 1..=3 {
                append(dir.path(), &rec(i)).unwrap();
            }
            let mut lines = active_lines(dir.path());
            set_anchor(dir.path(), 2, &hash_line(&lines[1]));
            match failure {
                "anchored-line-altered" => lines[1] = lines[1].replace("\"i\":2", "\"i\":99"),
                "not-chained" => {
                    lines[2] = lines[2].replacen(&hash_line(&lines[1]), &"f".repeat(64), 1)
                }
                "seq-skips" => lines[2] = lines[2].replacen("\"seq\":3", "\"seq\":4", 1),
                _ => lines[2] = "{\"seq\":3,\"prev\":\"x\"}".to_string(),
            }
            let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
            fs::write(dir.path().join(ACTIVE), &text).unwrap();
            let anchor = fs::read(dir.path().join(ANCHOR)).unwrap();
            assert!(append(dir.path(), &rec1).is_err(), "{failure}");
            assert_eq!(
                fs::read_to_string(dir.path().join(ACTIVE)).unwrap(),
                text,
                "{failure}"
            );
            assert_eq!(
                fs::read(dir.path().join(ANCHOR)).unwrap(),
                anchor,
                "{failure}"
            );
        }
    }

    fn files_of(dir: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_file() && !p.to_string_lossy().ends_with(".lock"))
            .map(|p| (file_name(&p), fs::read(&p).unwrap()))
            .collect()
    }

    /// A chain of three lines that writers refuse, one way each.
    fn refused_chain(failure: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &rec(1)).unwrap();
        let first_anchor = fs::read(dir.path().join(ANCHOR)).unwrap();
        append(dir.path(), &rec(2)).unwrap();
        append(dir.path(), &rec(3)).unwrap();
        match failure {
            "anchor-missing" => fs::remove_file(dir.path().join(ANCHOR)).unwrap(),
            "anchor-invalid" => fs::write(dir.path().join(ANCHOR), "{}").unwrap(),
            "chain-shorter-than-anchor" => {
                let first = active_lines(dir.path())[0].clone();
                fs::write(dir.path().join(ACTIVE), format!("{first}\n")).unwrap();
            }
            "tail-mismatch" => {
                let text = fs::read_to_string(dir.path().join(ACTIVE)).unwrap();
                fs::write(dir.path().join(ACTIVE), text.replace("\"i\":3", "\"i\":99")).unwrap();
            }
            "behind-by-two" => fs::write(dir.path().join(ANCHOR), first_anchor).unwrap(),
            "tail-malformed" => OpenOptions::new()
                .append(true)
                .open(dir.path().join(ACTIVE))
                .unwrap()
                .write_all(b"this is not a chain line\n")
                .unwrap(),
            _ => unreachable!(),
        }
        dir
    }

    const REFUSALS: [&str; 6] = [
        "anchor-missing",
        "anchor-invalid",
        "chain-shorter-than-anchor",
        "tail-mismatch",
        "behind-by-two",
        "tail-malformed",
    ];

    #[test]
    fn a_dry_run_reports_the_finding_and_changes_nothing() {
        for failure in REFUSALS {
            let dir = refused_chain(failure);
            let before = files_of(dir.path());
            let done = reanchor(dir.path(), "", true).expect(failure);
            assert!(done.dry_run, "{failure}");
            assert_eq!(
                done.inspection.disagreement().map(Disagreement::code),
                Some(match failure {
                    "behind-by-two" => "tail-mismatch",
                    other => other,
                }),
                "{failure}"
            );
            let anchors = if failure == "anchor-missing" { 0 } else { 1 };
            assert_eq!(
                done.aside.len(),
                1 + anchors,
                "{failure}: the chain file, and the anchor if any"
            );
            assert_eq!(files_of(dir.path()), before, "{failure}");
        }
    }

    #[test]
    fn reanchor_keeps_every_old_byte_and_starts_a_new_chain_with_the_event() {
        for failure in REFUSALS {
            let dir = refused_chain(failure);
            let before = files_of(dir.path());
            let had_anchor = before.contains_key(ANCHOR);
            let done = reanchor(dir.path(), "disk failure", false).expect(failure);
            assert!(!done.dry_run);
            let after = files_of(dir.path());
            // Every old file is there byte for byte under its set-aside name.
            for (name, bytes) in &before {
                let moved = format!("{name}.{}", done.suffix);
                assert_eq!(after.get(&moved), Some(bytes), "{failure}: {moved}");
            }
            assert!(done.suffix.starts_with("pre-reanchor-"));
            assert_eq!(done.aside.len(), if had_anchor { 2 } else { 1 });
            // The new chain: one line, genesis, the event; the anchor names it.
            let lines = active_lines(dir.path());
            assert_eq!(lines.len(), 1, "{failure}");
            let first: Value = serde_json::from_str(&lines[0]).unwrap();
            assert_eq!(first["seq"], 1);
            assert_eq!(first["prev"], GENESIS);
            assert_eq!(first["rec"]["action"], REANCHORED_ACTION);
            let d = &first["rec"]["detail"];
            assert_eq!(d["reason"], "disk failure");
            assert_eq!(
                d["disagreement"],
                done.inspection.disagreement().unwrap().code()
            );
            assert_eq!(d["asideSuffix"], done.suffix.as_str());
            assert_eq!(d["lines"], done.inspection.lines);
            assert_eq!(d["aside"].as_array().unwrap().len(), done.aside.len());
            assert!(d["previousAnchor"]["status"].is_string());
            assert_eq!(anchor_json(dir.path())["hash"], hash_line(&lines[0]));
            // And the chain is usable again.
            append(dir.path(), &rec(9)).unwrap();
            assert_eq!(tail(dir.path()).unwrap().seq, 2, "{failure}");
        }
    }

    #[test]
    fn the_event_records_the_old_anchor_and_the_old_end() {
        let dir = refused_chain("chain-shorter-than-anchor");
        let old_anchor = anchor_json(dir.path());
        let first = active_lines(dir.path())[0].clone();
        let done = reanchor(dir.path(), "cut", false).unwrap();
        let d = &done.event["detail"];
        assert_eq!(d["previousAnchor"]["status"], "ok");
        assert_eq!(d["previousAnchor"]["seq"], old_anchor["seq"]);
        assert_eq!(d["previousAnchor"]["hash"], old_anchor["hash"]);
        assert_eq!(d["previousEnd"]["seq"], 1);
        assert_eq!(d["previousEnd"]["hash"], hash_line(&first));
        assert_eq!((&d["lines"], &d["validLines"]), (&json!(1), &json!(1)));
        assert_eq!(d["firstBreak"], Value::Null);
        assert_eq!(d["asideDir"], dir.path().display().to_string());

        let dir = refused_chain("anchor-missing");
        let done = reanchor(dir.path(), "gone", false).unwrap();
        assert_eq!(
            done.event["detail"]["previousAnchor"],
            json!({"status":"missing"})
        );
        assert_eq!(done.event["detail"]["previousEnd"]["seq"], 3);

        let dir = refused_chain("tail-malformed");
        let done = reanchor(dir.path(), "junk", false).unwrap();
        assert_eq!(done.event["detail"]["previousEnd"], Value::Null);
        assert_eq!(done.event["detail"]["validLines"], 3);
        assert_eq!(done.event["detail"]["lines"], 4);
        assert_eq!(done.event["detail"]["firstBreak"]["code"], "line-malformed");
        assert_eq!(done.event["detail"]["firstBreak"]["line"], 4);
    }

    #[test]
    fn inspection_counts_the_intact_prefix_up_to_the_first_deviation() {
        let dir = refused_chain("behind-by-two");
        let mut lines = active_lines(dir.path());
        lines[1] = lines[1].replace("\"i\":2", "\"i\":99"); // line 3 no longer chains to it
        fs::write(
            dir.path().join(ACTIVE),
            lines.iter().map(|l| format!("{l}\n")).collect::<String>(),
        )
        .unwrap();
        let ins = inspect(dir.path()).unwrap();
        assert_eq!((ins.lines, ins.valid_lines), (3, 2));
        let b = ins.first_break.as_ref().unwrap();
        assert_eq!(
            (b.code, b.file.as_str(), b.line),
            ("hash-mismatch", ACTIVE, 3)
        );
        assert_eq!(ins.last_valid.as_ref().unwrap().0, 2);
        assert_eq!(ins.end.as_ref().unwrap().0, 3);
    }

    #[test]
    fn reanchor_sets_every_rotated_file_aside_and_keeps_an_unterminated_tail_in_place() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &rec(1)).unwrap();
        append(dir.path(), &rec(2)).unwrap();
        fs::rename(
            dir.path().join(ACTIVE),
            dir.path().join("audit-chain.0000000001.jsonl"),
        )
        .unwrap();
        append(dir.path(), &rec(3)).unwrap();
        OpenOptions::new()
            .append(true)
            .open(dir.path().join(ACTIVE))
            .unwrap()
            .write_all(b"torn fragment")
            .unwrap();
        fs::remove_file(dir.path().join(ANCHOR)).unwrap();
        let before = files_of(dir.path());
        let done = reanchor(dir.path(), "lost", false).unwrap();
        assert!(done.inspection.torn_tail);
        let after = files_of(dir.path());
        for name in ["audit-chain.0000000001.jsonl", ACTIVE] {
            assert_eq!(
                after.get(&format!("{name}.{}", done.suffix)),
                before.get(name),
                "{name}"
            );
        }
        assert!(
            String::from_utf8_lossy(&after[&format!("{ACTIVE}.{}", done.suffix)])
                .ends_with("torn fragment")
        );
        assert_eq!(active_lines(dir.path()).len(), 1);
    }

    #[test]
    fn nothing_is_repaired_when_writers_accept_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            reanchor(&dir.path().join("absent"), "x", false).err(),
            Some(ReanchorError::NothingToRepair(false))
        ));
        assert!(matches!(
            reanchor(dir.path(), "x", false).err(),
            Some(ReanchorError::NothingToRepair(false))
        ));
        for i in 1..=2 {
            append(dir.path(), &rec(i)).unwrap();
        }
        let before = files_of(dir.path());
        for dry in [false, true] {
            assert!(matches!(
                reanchor(dir.path(), "x", dry).err(),
                Some(ReanchorError::NothingToRepair(false))
            ));
        }
        // The state a writer heals by itself is not a repair either, and says so.
        let lines = active_lines(dir.path());
        set_anchor(dir.path(), 1, &hash_line(&lines[0]));
        let before_trailing = files_of(dir.path());
        assert!(matches!(
            reanchor(dir.path(), "x", false).err(),
            Some(ReanchorError::NothingToRepair(true))
        ));
        assert_eq!(files_of(dir.path()), before_trailing);
        assert_eq!(before.len(), before_trailing.len());
    }

    #[test]
    fn a_second_reanchor_after_a_repair_has_nothing_to_do() {
        let dir = refused_chain("anchor-invalid");
        reanchor(dir.path(), "first", false).unwrap();
        assert!(matches!(
            reanchor(dir.path(), "second", false).err(),
            Some(ReanchorError::NothingToRepair(false))
        ));
    }

    // Mixed-language check: what Rust leaves behind is read by the TypeScript verifier as one new chain plus a set-aside era.
    #[test]
    fn the_typescript_verifier_reads_a_rust_reanchor_as_an_era_boundary() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        super::test_prerequisites::require("audit", &root);
        let dir = refused_chain("tail-mismatch");
        let logs = dir.path();
        let done = reanchor(logs, "mixed test", false).unwrap();
        append(logs, &rec(9)).unwrap();
        let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
        let output = Command::new(&node).current_dir(&root)
            .args(["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "-e", "import {createAuditChain} from './packages/core/src/audit/chain.ts'; console.log(JSON.stringify(createAuditChain({dir:process.argv[1]}).verify()))"])
            .arg(logs).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let v: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(
            (v["records"].clone(), v["lastSeq"].clone()),
            (json!(2), json!(2))
        );
        assert_eq!(v["reanchors"][0]["seq"], 1);
        assert_eq!(v["reanchors"][0]["suffix"], done.suffix.as_str());
        let previous = &v["previousChains"][0];
        assert_eq!(previous["suffix"], done.suffix.as_str());
        assert_eq!(previous["announced"], true);
        // The old chain's line 3 was changed after its anchor was written: the anchor and the walk disagree, and it says where.
        assert_eq!(previous["intact"], false);
        assert_eq!(previous["anchor"]["status"], "mismatch");
        assert_eq!(previous["records"], 3);
    }
}
