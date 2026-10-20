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
static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The chain declined to take an append (as opposed to an I/O failure while writing): the anchor is missing or
/// invalid, the tail does not match the anchor, the file is not a chain, or the lock was not free in time. `reason` is
/// a short fixed code, never content; `text` is what the error prints.
#[derive(Debug)]
pub(crate) struct Refusal {
    pub(crate) reason: &'static str,
    text: String,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}
impl std::error::Error for Refusal {}

fn invalid(reason: &'static str, message: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        Refusal {
            reason,
            text: format!("audit-chain: {message}; refusing to append"),
        },
    )
}

/// The refusal code when `e` is the chain declining an append, `None` for any other failure (a storage error is not a
/// refusal).
pub(crate) fn refusal_reason(e: &io::Error) -> Option<&'static str> {
    e.get_ref()
        .and_then(|inner| inner.downcast_ref::<Refusal>())
        .map(|r| r.reason)
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
fn parse_line(line: &str) -> io::Result<u64> {
    let v: Value = serde_json::from_str(line)
        .map_err(|_| invalid("tail-malformed", "last line is not a chain line"))?;
    let seq = v["seq"].as_u64().filter(|s| *s > 0 && *s <= MAX_SEQ);
    if !hex64(&v["prev"]) || !v["rec"].is_object() {
        return Err(invalid("tail-malformed", "last line is not a chain line"));
    }
    seq.ok_or_else(|| invalid("tail-malformed", "last line is not a chain line"))
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
fn tail(dir: &Path) -> io::Result<(u64, String)> {
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
            .map_err(|_| invalid("tail-malformed", "last line is not UTF-8"))?;
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        return Ok((parse_line(line)?, hash_line(line)));
    }
    Ok((0, GENESIS.into()))
}
fn check_anchor(dir: &Path, seq: u64, hash: &str) -> io::Result<()> {
    let text = match fs::read_to_string(dir.join(ANCHOR)) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound && seq == 0 => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(invalid("anchor-missing", "anchor is missing"))
        }
        Err(e) => return Err(e),
    };
    let a: Value =
        serde_json::from_str(&text).map_err(|_| invalid("anchor-invalid", "anchor is invalid"))?;
    let s = a["seq"].as_u64().filter(|s| *s > 0 && *s <= MAX_SEQ);
    if a["v"] != 1 || !hex64(&a["hash"]) || s.is_none() {
        return Err(invalid("anchor-invalid", "anchor is invalid"));
    }
    let s = s.unwrap();
    if s > seq {
        return Err(invalid(
            "chain-shorter-than-anchor",
            "chain is shorter than its anchor",
        ));
    }
    if s != seq || a["hash"] != hash {
        return Err(invalid(
            "tail-anchor-mismatch",
            "tail does not match the anchor",
        ));
    }
    Ok(())
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
                        Refusal {
                            reason: "lock-timeout",
                            text: "audit-chain: lock timeout".into(),
                        },
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

pub(crate) fn append(dir: &Path, rec: &Value) -> io::Result<()> {
    append_batch(dir, std::slice::from_ref(rec))
}

/// Appends `recs` in order under one lock: the tail and the anchor are checked once, every line is written and
/// fsynced on its own, and the anchor moves once at the end (or, when a later line fails, to the last line that was
/// written, so a partial batch never leaves the anchor behind more than the crash window of a single append).
pub(crate) fn append_batch(dir: &Path, recs: &[Value]) -> io::Result<()> {
    if recs.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    // fcntl locks belong to the process, so threads also need a mutex.
    let _thread = WRITER.lock().unwrap_or_else(|e| e.into_inner());
    let _lock = OsLock::acquire(dir)?;
    let (mut seq, mut hash) = tail(dir)?;
    check_anchor(dir, seq, &hash)?;
    let mut wrote = false;
    let mut outcome = Ok(());
    for rec in recs {
        match write_line(dir, seq, &hash, rec) {
            Ok((next_seq, next_hash)) => {
                seq = next_seq;
                hash = next_hash;
                wrote = true;
            }
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
    }
    if wrote {
        write_anchor(dir, seq, &hash)?;
    }
    outcome
}

/// Writes the chain line that follows `(seq, prev)`, rotating the active file first when it is full. Returns the new
/// line's `seq` and hash. The caller holds the lock and moves the anchor.
fn write_line(dir: &Path, seq: u64, prev: &str, rec: &Value) -> io::Result<(u64, String)> {
    if seq >= MAX_SEQ {
        return Err(invalid("sequence-exhausted", "sequence exhausted"));
    }
    let active = dir.join(ACTIVE);
    if active.metadata().is_ok_and(|m| m.len() >= MAX_BYTES) {
        let text = fs::read_to_string(&active)?;
        if let Some(first) = text.lines().next() {
            let target = dir.join(format!("audit-chain.{:010}.jsonl", parse_line(first)?));
            if target.exists() {
                return Err(invalid("rotation-target-exists", "rotation target exists"));
            }
            fs::rename(&active, target)?;
        }
    }
    let seq = seq + 1;
    let line = format!("{{\"seq\":{seq},\"prev\":\"{prev}\",\"rec\":{rec}}}");
    drop(create_private(&active, false)?);
    let mut f = OpenOptions::new().append(true).open(&active)?;
    f.write_all(format!("{line}\n").as_bytes())?;
    f.sync_all()?;
    Ok((seq, hash_line(&line)))
}

/// Replaces the anchor atomically with `(seq, hash)`, the newest line's.
fn write_anchor(dir: &Path, seq: u64, hash: &str) -> io::Result<()> {
    let tmp = dir.join(format!("{ANCHOR}.tmp"));
    let mut a = create_private(&tmp, true)?;
    writeln!(a, "{}", json!({"v": 1, "seq": seq, "hash": hash}))?;
    a.sync_all()?;
    drop(a);
    fs::rename(&tmp, dir.join(ANCHOR))?;
    Ok(())
}

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

    /// The pending-journal fallback of the config audit tells a chain that declines (anchor, integrity, lock) from a
    /// storage failure by this code, so each refusal carries a short fixed reason and nothing else is a refusal.
    #[test]
    fn a_refusal_carries_its_reason_and_a_storage_failure_is_none() {
        for (failure, reason) in [
            ("missing", "anchor-missing"),
            ("invalid", "anchor-invalid"),
            ("short", "chain-shorter-than-anchor"),
            ("tail", "tail-anchor-mismatch"),
            ("behind", "tail-anchor-mismatch"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let rec = json!({"at":1,"actor":{"user":"u","host":"h"},"action":"test","target":"t","detail":{}});
            append(dir.path(), &rec).unwrap();
            let first = fs::read(dir.path().join(ACTIVE)).unwrap();
            let first_anchor = fs::read(dir.path().join(ANCHOR)).unwrap();
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
            let e = append(dir.path(), &rec).unwrap_err();
            assert_eq!(refusal_reason(&e), Some(reason), "{failure}: {e}");
            assert!(e.to_string().contains("refusing to append"), "{e}");
        }
        // A line that is not a chain line at the tail is an integrity refusal too.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(ACTIVE), "not a chain line\n").unwrap();
        let e = append(dir.path(), &json!({"action":"test"})).unwrap_err();
        assert_eq!(refusal_reason(&e), Some("tail-malformed"), "{e}");
        // A storage failure (the chain directory cannot be created) is no refusal.
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "a file").unwrap();
        let e = append(&blocker.join("logs"), &json!({"action":"test"})).unwrap_err();
        assert_eq!(refusal_reason(&e), None, "{e}");
    }

    #[test]
    fn a_batch_joins_the_chain_in_order_under_one_anchor_update() {
        let dir = tempfile::tempdir().unwrap();
        let recs: Vec<Value> = (0..5)
            .map(|i| json!({"at":i,"actor":{"user":"u","host":"h"},"action":"test","target":format!("t{i}"),"detail":{}}))
            .collect();
        append(dir.path(), &recs[0]).unwrap();
        append_batch(dir.path(), &recs[1..]).unwrap();
        let text = fs::read_to_string(dir.path().join(ACTIVE)).unwrap();
        let mut prev = GENESIS.to_string();
        for (i, raw) in text.lines().enumerate() {
            let line: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(line["seq"], i as u64 + 1);
            assert_eq!(line["prev"], prev.as_str());
            assert_eq!(line["rec"], recs[i]);
            prev = hash_line(raw);
        }
        assert_eq!(text.lines().count(), 5);
        let anchor: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(ANCHOR)).unwrap()).unwrap();
        assert_eq!(anchor["seq"], 5);
        assert_eq!(anchor["hash"], prev.as_str());
        // An empty batch writes nothing and checks nothing.
        append_batch(dir.path(), &[]).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(ACTIVE)).unwrap(), text);
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
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
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
}
