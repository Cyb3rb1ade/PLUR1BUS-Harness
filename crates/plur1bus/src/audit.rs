//! `logs/audit.log` (HB12, ADR-006, D66): one JSON line per privileged CLI action,
//! `{ at, actor: { user, host }, action, target, detail }`, append-only, private to the user (0600; user and SYSTEM
//! on Windows). Actions in 2a-H3b-b: `licence.accept-nc`, `setup.complete`, `repair.<step id>`.
// The writers (setup, repair) land in 2a-H3b-b Tasks 4 and 7; until then only the tests call `append`.
#![allow(dead_code)]
#[path = "audit_chain.rs"]
pub(crate) mod chain;
#[path = "audit_health.rs"]
pub(crate) mod health;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Opens `path` for writing, creating it private to the user: mode 0600 on unix (also applied to an existing file),
/// a protected DACL for the user and SYSTEM on Windows, set before any content is written. `truncate` empties an
/// existing file; without it, a new file is created and an existing one is left as it is (`create_new` semantics are
/// not needed by the callers).
pub(crate) fn create_private(path: &Path, truncate: bool) -> io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Foundation::GENERIC_WRITE;
        use windows_sys::Win32::Storage::FileSystem::WRITE_DAC;
        o.access_mode(GENERIC_WRITE | WRITE_DAC);
    }
    let f = o.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        plur1bus_rpc::win::restrict_to_user(f.as_raw_handle())?;
    }
    Ok(f)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Appends one audit line. The line is written with a single `write_all` on an `O_APPEND` handle, so a crash never
/// leaves a partial line in the middle of the file, and it is fsynced before this returns.
pub fn append(layout: &Layout, action: &str, target: &str, detail: Value) -> io::Result<()> {
    let caller = crate::identity::caller();
    append_as(
        layout,
        (caller.user_id.as_str(), caller.account_id.as_str()),
        action,
        target,
        detail,
    )
}

/// `append` for a writer that knows better who acted than the OS user of this process: the supervisor records a
/// config change under the authenticated person (`actor` = `(user, host)`). It is the one implementation behind
/// `append`: the same `audit.log`, the same chain line, the same single write; only `actor` differs. Fails closed like
/// `append`: a chain that refuses the line fails the call, and nothing reaches `audit.log` that the chain does not hold.
pub fn append_as(
    layout: &Layout,
    actor: (&str, &str),
    action: &str,
    target: &str,
    detail: Value,
) -> io::Result<()> {
    append_inner(layout, actor, action, target, detail, OnRefusal::Fail).map(|_| ())
}

/// That the chain declined a line that [`append_as_degrading`] wrote anyway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainRefusal {
    /// Short fixed code, never content: `anchor-missing`, `anchor-invalid`, `chain-shorter-than-anchor`,
    /// `tail-anchor-mismatch`, `tail-malformed`, `sequence-exhausted`, `rotation-target-exists` or `lock-timeout`.
    pub reason: &'static str,
    /// The line is in the pending journal and joins the chain once it accepts appends again.
    pub queued: bool,
    /// Oldest pending lines the journal's size limit discarded for this line (counted, and noted in `audit.log`).
    pub dropped: u64,
}

/// [`append_as`] for a user action that must never be blocked by the chain (the supervisor's `config.set`: saving the
/// configuration is something a person does and must always be able to do; every other caller of `append` records a
/// machine event and stays fail-closed, see `docs/audit-chain.md`).
///
/// * The chain takes the line: the same as `append_as`, `Ok(None)`. Pending lines are then drained into the chain.
/// * Only the chain refuses (anchor missing or invalid, tail does not match the anchor, lock timeout): the line still
///   goes to `audit.log`, with `chain: "refused"` and `chainReason`, and into the pending journal, and the result is
///   `Ok(Some(refusal))`. The chain is never touched, so tampering is not papered over.
/// * `audit.log` cannot be written, or the chain fails for a storage reason: `Err`, fail-closed as always.
pub fn append_as_degrading(
    layout: &Layout,
    actor: (&str, &str),
    action: &str,
    target: &str,
    detail: Value,
) -> io::Result<Option<ChainRefusal>> {
    append_inner(
        layout,
        actor,
        action,
        target,
        detail,
        OnRefusal::Queue {
            max_lines: PENDING_MAX_LINES,
            max_bytes: PENDING_MAX_BYTES,
        },
    )
}

/// What a chain refusal does to an append.
#[derive(Clone, Copy)]
enum OnRefusal {
    /// The append fails (every caller but the config audit).
    Fail,
    /// The line goes to `audit.log` flagged and to the pending journal, which keeps at most these many lines and bytes.
    Queue { max_lines: usize, max_bytes: u64 },
}

fn log_line(actor: (&str, &str), action: &str, target: &str, detail: Value) -> Value {
    json!({
        "at": now_ms(),
        "actor": { "user": actor.0, "host": actor.1 },
        "action": action,
        "target": target,
        "detail": detail,
    })
}

fn append_inner(
    layout: &Layout,
    actor: (&str, &str),
    action: &str,
    target: &str,
    detail: Value,
    on_refusal: OnRefusal,
) -> io::Result<Option<ChainRefusal>> {
    let path = layout.audit_log();
    fs::create_dir_all(layout.logs())?;
    // Create (or re-restrict) the file privately first; the append handle below cannot also carry WRITE_DAC on
    // Windows without losing append semantics.
    drop(create_private(&path, false)?);
    let mut line = log_line(actor, action, target, detail);
    match chain::append(&layout.logs(), &line) {
        Ok(()) => {
            write_log_line(&path, &line)?;
            // The chain accepts appends: lines it refused earlier join it now. Best effort, the next append retries.
            let _ = drain_pending(layout);
            Ok(None)
        }
        Err(e) => {
            let (
                Some(reason),
                OnRefusal::Queue {
                    max_lines,
                    max_bytes,
                },
            ) = (chain::refusal_reason(&e), on_refusal)
            else {
                return Err(e);
            };
            line["chain"] = json!("refused");
            line["chainReason"] = json!(reason);
            // `audit.log` first: when it cannot take the line, the call fails closed as it always did.
            write_log_line(&path, &line)?;
            let queued = serde_json::to_string(&line)
                .map_err(io::Error::other)
                .and_then(|text| {
                    journal_append(&pending_path(layout), &text, max_lines, max_bytes)
                });
            let (queued, dropped) = match queued {
                Ok(dropped) => (true, dropped),
                Err(_) => (false, 0),
            };
            if dropped > 0 {
                // The discarded lines are gone from the journal; `audit.log` says how many. Best effort: the refused
                // line itself is already in `audit.log`.
                let mut note = log_line(
                    CHAIN_ACTOR,
                    "audit.chain.pending_overflow",
                    "audit-chain",
                    json!({ "dropped": dropped, "limitLines": max_lines, "limitBytes": max_bytes }),
                );
                note["chain"] = json!("refused");
                note["chainReason"] = json!(reason);
                let _ = write_log_line(&path, &note);
            }
            Ok(Some(ChainRefusal {
                reason,
                queued,
                dropped,
            }))
        }
    }
}

/// The `audit.log` half of an append: one line, after the file was created private.
fn write_log_line(path: &Path, line: &Value) -> io::Result<()> {
    let mut f = fs::OpenOptions::new().append(true).read(true).open(path)?;
    let entry = serde_json::to_string(line).map_err(io::Error::other)?;
    {
        // The torn-line check and the write are one step: without the lock a writer checking the last byte can see
        // another writer's half-finished line and add a '\n' of its own, which shows up as an extra, empty line.
        let _guard = APPEND_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // A file that ends without a newline (a crash in the middle of a line): the fragment stays a line of its own and
        // this line starts a fresh one, in the same single write.
        let mut text = String::new();
        if ends_in_a_torn_line(&mut f)? {
            text.push('\n');
        }
        text.push_str(&entry);
        text.push('\n');
        f.write_all(text.as_bytes())?;
    }
    f.sync_all()
}

/// The actor of events the audit chain itself records.
const CHAIN_ACTOR: (&str, &str) = ("audit-chain", "local");

/// Lines the chain refused (see [`append_as_degrading`]), waiting for it to accept appends again: JSON lines, each the
/// exact `audit.log` line, private to the user, fsynced. A first line `{"pendingDropped":N}` counts the oldest lines the
/// size limit discarded.
const PENDING: &str = "audit-chain.pending.jsonl";
/// The journal keeps at most this many lines and bytes (the marker line is not counted); beyond it the oldest lines are
/// discarded, counted, and noted in `audit.log`.
const PENDING_MAX_LINES: usize = 10_000;
const PENDING_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Lines per chain batch while draining (one anchor update per batch).
const DRAIN_CHUNK: usize = 100;

/// Serialises the journal's writers and its drain among the threads of this process.
static PENDING_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn pending_path(layout: &Layout) -> std::path::PathBuf {
    layout.logs().join(PENDING)
}

/// One complete line of the journal: its byte range (through its newline) and, when it is a JSON object, its value.
struct JournalRow {
    start: usize,
    end: usize,
    value: Option<Value>,
}

struct Journal {
    /// From the marker line: how many oldest lines the size limit discarded so far.
    dropped: u64,
    rows: Vec<JournalRow>,
    /// The offset just past the last newline; a torn trailing fragment (a crash mid-write) starts here.
    end: usize,
}

fn parse_journal(bytes: &[u8]) -> Journal {
    let mut journal = Journal {
        dropped: 0,
        rows: Vec::new(),
        end: 0,
    };
    let mut start = 0;
    let mut first = true;
    while let Some(i) = bytes[start..].iter().position(|b| *b == b'\n') {
        let end = start + i + 1;
        let raw = String::from_utf8_lossy(&bytes[start..start + i]).into_owned();
        let row_start = start;
        start = end;
        journal.end = end;
        let text = raw.trim();
        if text.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(text)
            .ok()
            .filter(|v| v.is_object());
        if first {
            first = false;
            if let Some(n) = value
                .as_ref()
                .and_then(|v| v.get("pendingDropped"))
                .and_then(Value::as_u64)
            {
                journal.dropped = n;
                continue;
            }
        }
        journal.rows.push(JournalRow {
            start: row_start,
            end,
            value,
        });
    }
    journal
}

fn marker_line(dropped: u64) -> String {
    format!("{{\"pendingDropped\":{dropped}}}\n")
}

/// Replaces `path` atomically with `content`, private to the user.
fn rewrite_private(path: &Path, content: &[u8]) -> io::Result<()> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    let mut f = create_private(&tmp, true)?;
    f.write_all(content)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

/// Adds `line` to the journal at `path` (one `O_APPEND` write, fsynced). When the journal would then hold more than
/// `max_lines` lines or `max_bytes` bytes, the oldest lines are discarded (the file is rewritten atomically with an
/// updated marker). Returns how many lines this call discarded.
fn journal_append(path: &Path, line: &str, max_lines: usize, max_bytes: u64) -> io::Result<u64> {
    let _guard = PENDING_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    let journal = parse_journal(&existing);
    let max_lines = max_lines.max(1);
    let row_len = |r: &JournalRow| (r.end - r.start) as u64;
    let mut size = journal.rows.iter().map(row_len).sum::<u64>() + line.len() as u64 + 1;
    let mut discard = (journal.rows.len() + 1).saturating_sub(max_lines);
    for row in &journal.rows[..discard] {
        size -= row_len(row);
    }
    while size > max_bytes && discard < journal.rows.len() {
        size -= row_len(&journal.rows[discard]);
        discard += 1;
    }
    if discard == 0 {
        drop(create_private(path, false)?);
        let mut f = fs::OpenOptions::new().append(true).read(true).open(path)?;
        let mut text = String::new();
        // A torn last line (a crash mid-write) stays a line of its own.
        if ends_in_a_torn_line(&mut f)? {
            text.push('\n');
        }
        text.push_str(line);
        text.push('\n');
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        return Ok(0);
    }
    let keep_from = journal
        .rows
        .get(discard)
        .map_or(journal.end, |row| row.start);
    let mut content = marker_line(journal.dropped + discard as u64).into_bytes();
    content.extend_from_slice(&existing[keep_from..journal.end]);
    content.extend_from_slice(line.as_bytes());
    content.push(b'\n');
    rewrite_private(path, &content)?;
    Ok(discard as u64)
}

/// Appends the lines the chain refused earlier to the chain, in their original order and with their original `at`
/// (each is the exact `audit.log` line, `chain: "refused"` included), then records `audit.chain.pending_drained` with the
/// count (and the number of lines the size limit discarded). Returns how many lines joined the chain.
///
/// Called after every successful append; when there is no journal this is one `stat`. While the chain still refuses,
/// nothing changes and the error says why. The journal is cleared only for what the chain took: a crash between the
/// chain write and the clearing can chain a line a second time (never lose one).
pub fn drain_pending(layout: &Layout) -> io::Result<usize> {
    drain_in_chunks(layout, DRAIN_CHUNK)
}

fn drain_in_chunks(layout: &Layout, chunk: usize) -> io::Result<usize> {
    let path = pending_path(layout);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(0);
    }
    let _guard = PENDING_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let journal = parse_journal(&bytes);
    if journal.rows.is_empty() && journal.dropped == 0 {
        // Nothing but blank lines or a torn fragment.
        return match fs::remove_file(&path) {
            Ok(()) => Ok(0),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
            Err(e) => Err(e),
        };
    }
    let mut items: Vec<(Value, usize)> = journal
        .rows
        .iter()
        .filter_map(|r| r.value.clone().map(|v| (v, r.end)))
        .collect();
    let count = items.len();
    let skipped = journal.rows.len() - count;
    let event = log_line(
        CHAIN_ACTOR,
        "audit.chain.pending_drained",
        "audit-chain",
        json!({ "count": count, "dropped": journal.dropped, "skipped": skipped }),
    );
    items.push((event.clone(), journal.end));
    let mut consumed = 0;
    let mut failure = None;
    for part in items.chunks(chunk.max(1)) {
        let recs: Vec<Value> = part.iter().map(|(v, _)| v.clone()).collect();
        match chain::append_batch(&layout.logs(), &recs) {
            Ok(()) => consumed = part.last().map_or(consumed, |(_, end)| *end),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    if consumed > 0 {
        // Drop what the chain took. Lines another process added meanwhile stay; if the journal was rewritten under us
        // it is left alone.
        let now = fs::read(&path).unwrap_or_default();
        if now.len() >= consumed && now[..consumed] == bytes[..consumed] {
            let mut rest = Vec::new();
            if failure.is_some() && journal.dropped > 0 {
                rest.extend_from_slice(marker_line(journal.dropped).as_bytes());
            }
            rest.extend_from_slice(&now[consumed..]);
            if rest.is_empty() {
                fs::remove_file(&path)?;
            } else {
                rewrite_private(&path, &rest)?;
            }
        }
    }
    if let Some(e) = failure {
        return Err(e);
    }
    write_log_line(&layout.audit_log(), &event)?;
    Ok(count)
}

/// `plur1bus audit reanchor`: the chain side is [`chain::reanchor`] (inspect, set the old chain aside, start a new one with an
/// `audit.chain.reanchored` event). The same event is also written to `audit.log`, which an attacker on the chain would have to
/// change too; a failure of that second copy is reported by the caller and does not undo the repair.
pub(crate) fn reanchor(
    layout: &Layout,
    reason: &str,
    dry_run: bool,
) -> Result<(chain::Reanchored, Option<io::Error>), chain::ReanchorError> {
    let done = chain::reanchor(&layout.logs(), reason, dry_run)?;
    let mirrored = if done.dry_run {
        None
    } else {
        let path = layout.audit_log();
        create_private(&path, false)
            .map(drop)
            .and_then(|()| write_log_line(&path, &done.event))
            .err()
    };
    Ok((done, mirrored))
}

/// Serialises the torn-line check and the append of one entry among the threads of this process.
static APPEND_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Whether the file is non-empty and its last byte is not a newline.
fn ends_in_a_torn_line(f: &mut fs::File) -> io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    let len = f.metadata()?.len();
    if len == 0 {
        return Ok(false);
    }
    f.seek(SeekFrom::Start(len - 1))?;
    let mut last = [0u8; 1];
    f.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_lines_are_json_append_only_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        append(
            &layout,
            "licence.accept-nc",
            "embedding",
            json!({ "useClass": "research" }),
        )
        .unwrap();
        let first = fs::read_to_string(layout.audit_log()).unwrap();
        append(&layout, "setup.complete", "linux-x64", json!({})).unwrap();
        let text = fs::read_to_string(layout.audit_log()).unwrap();
        assert!(
            text.starts_with(&first),
            "the first line is never rewritten"
        );
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["action"], "licence.accept-nc");
        assert_eq!(lines[0]["target"], "embedding");
        assert_eq!(lines[0]["detail"]["useClass"], "research");
        assert_eq!(lines[1]["action"], "setup.complete");
        for l in &lines {
            assert!(l["at"].as_u64().unwrap() > 0);
            assert!(l["actor"]["user"].is_string());
            assert!(l["actor"]["host"].is_string());
            assert_eq!(l.as_object().unwrap().len(), 5);
        }
        assert!(text.ends_with('\n'));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(layout.audit_log())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn cli_events_join_the_chain_and_refuse_tampered_anchors() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        append(&layout, "setup.complete", "test", json!({})).unwrap();
        let chain = layout.logs().join("audit-chain.jsonl");
        let text = fs::read_to_string(&chain).expect("Rust audit must join the shared chain");
        let first: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(first["seq"], 1);
        assert_eq!(first["prev"], "0".repeat(64));
        assert_eq!(first["rec"]["action"], "setup.complete");
        fs::remove_file(layout.logs().join("audit-chain.anchor")).unwrap();
        assert!(append(&layout, "repair.test", "test", json!({})).is_err());
        assert_eq!(fs::read_to_string(chain).unwrap(), text);
    }

    #[test]
    fn a_reanchor_is_copied_to_audit_log_and_the_audit_line_after_it_joins_the_new_chain() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        append(&layout, "setup.complete", "test", json!({})).unwrap();
        append(&layout, "repair.one", "test", json!({})).unwrap();
        fs::remove_file(layout.logs().join("audit-chain.anchor")).unwrap();
        assert!(append(&layout, "repair.two", "test", json!({})).is_err());
        let log_before = fs::read_to_string(layout.audit_log()).unwrap();

        let (done, mirror_error) = reanchor(&layout, "anchor lost", false).unwrap();
        assert!(mirror_error.is_none());
        assert!(!done.dry_run);

        // audit.log keeps its earlier lines untouched and gains the event as one five-key line.
        let log_after = fs::read_to_string(layout.audit_log()).unwrap();
        assert!(log_after.starts_with(&log_before));
        let event: Value = serde_json::from_str(log_after.lines().last().unwrap()).unwrap();
        assert_eq!(event["action"], "audit.chain.reanchored");
        assert_eq!(event["detail"]["reason"], "anchor lost");
        assert_eq!(event.as_object().unwrap().len(), 5);
        assert_eq!(event["detail"]["asideSuffix"], done.suffix.as_str());

        // The chain is writable again, and the next event is line 2 of the new chain.
        append(&layout, "repair.three", "test", json!({})).unwrap();
        let chain = fs::read_to_string(layout.logs().join("audit-chain.jsonl")).unwrap();
        let seqs: Vec<(u64, String)> = chain
            .lines()
            .map(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                (
                    v["seq"].as_u64().unwrap(),
                    v["rec"]["action"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(
            seqs,
            vec![
                (1, "audit.chain.reanchored".to_string()),
                (2, "repair.three".to_string())
            ]
        );
        // Nothing of the old chain is gone.
        assert!(layout
            .logs()
            .join(format!("audit-chain.jsonl.{}", done.suffix))
            .is_file());
    }

    #[test]
    fn a_reanchor_dry_run_touches_neither_audit_log_nor_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        append(&layout, "setup.complete", "test", json!({})).unwrap();
        append(&layout, "repair.one", "test", json!({})).unwrap();
        fs::write(layout.logs().join("audit-chain.anchor"), "{}").unwrap();
        let snapshot = |l: &Layout| {
            let mut all: Vec<(String, Vec<u8>)> = fs::read_dir(l.logs())
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| !p.to_string_lossy().ends_with(".lock"))
                .map(|p| (p.display().to_string(), fs::read(&p).unwrap()))
                .collect();
            all.sort();
            all
        };
        let before = snapshot(&layout);
        let (done, _) = reanchor(&layout, "", true).unwrap();
        assert!(done.dry_run && done.suffix.is_empty());
        assert_eq!(snapshot(&layout), before);
    }

    fn lines(layout: &Layout) -> Vec<String> {
        fs::read_to_string(layout.audit_log())
            .unwrap()
            .split_inclusive('\n')
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn a_detail_with_newlines_unicode_and_a_megabyte_is_still_one_line() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let big = "y".repeat(1 << 20);
        for (i, detail) in [
            json!({ "t": "a\nb\r\nc" }),
            json!({ "t": "ünï ✓ 😀 \u{0} \u{2028}" }),
            json!({ "t": big }),
            json!(null),
            json!([1, 2, 3]),
        ]
        .into_iter()
        .enumerate()
        {
            append(
                &layout,
                &format!("test.action{i}"),
                "target\nwith newline",
                detail.clone(),
            )
            .unwrap();
            let all = lines(&layout);
            assert_eq!(all.len(), i + 1, "one physical line per entry");
            let v: Value = serde_json::from_str(all.last().unwrap()).unwrap();
            assert_eq!(v["detail"], detail);
            assert_eq!(v["target"], "target\nwith newline");
        }
    }

    #[test]
    fn concurrent_writers_never_interleave_audit_lines() {
        let dir = tempfile::tempdir().unwrap();
        let layout = std::sync::Arc::new(Layout::new(dir.path().to_path_buf()));
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let layout = layout.clone();
                std::thread::spawn(move || {
                    for i in 0..60 {
                        let pad = "z".repeat(if i % 6 == 0 { 70_000 } else { 30 });
                        append(
                            &layout,
                            &format!("t{t}.n{i}"),
                            "target",
                            json!({ "pad": pad, "t": t, "i": i }),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let all = lines(&layout);
        assert_eq!(all.len(), 8 * 60);
        let mut seen = std::collections::BTreeSet::new();
        for l in &all {
            let v: Value =
                serde_json::from_str(l).unwrap_or_else(|e| panic!("an interleaved line ({e})"));
            let action = v["action"].as_str().unwrap().to_string();
            assert_eq!(
                action,
                format!("t{}.n{}", v["detail"]["t"], v["detail"]["i"]),
                "a line mixes two writers"
            );
            assert!(seen.insert(action));
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_file_with_wider_permissions_is_made_private_again_before_a_line_is_added() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        fs::create_dir_all(layout.logs()).unwrap();
        fs::write(layout.audit_log(), "{\"old\":true}\n").unwrap();
        fs::set_permissions(layout.audit_log(), fs::Permissions::from_mode(0o666)).unwrap();
        append(&layout, "test.action", "t", json!({})).unwrap();
        assert_eq!(
            fs::metadata(layout.audit_log())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(fs::read_to_string(layout.audit_log())
            .unwrap()
            .starts_with("{\"old\":true}\n"));
    }

    /// A crash in the middle of a line leaves a last line without its newline; the next audit line must not be glued to it, or the
    /// two become one unreadable line and the new audit event is lost.
    #[test]
    fn an_audit_line_after_a_torn_last_line_starts_its_own_line() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        append(&layout, "first", "t", json!({})).unwrap();
        let intact = fs::read(layout.audit_log()).unwrap();
        let mut torn = intact.clone();
        torn.extend_from_slice(b"{\"at\":1,\"actor\":{\"user\":\"u");
        fs::write(layout.audit_log(), &torn).unwrap();
        append(&layout, "after", "t", json!({})).unwrap();
        let now = fs::read(layout.audit_log()).unwrap();
        assert!(
            now.starts_with(&torn),
            "everything that was there stays as it was"
        );
        let all = lines(&layout);
        let last: Value =
            serde_json::from_str(all.last().unwrap()).expect("the new line is a line of its own");
        assert_eq!(last["action"], "after");
        assert_eq!(
            all.iter()
                .filter(|l| serde_json::from_str::<Value>(l).is_ok())
                .count(),
            2,
            "{all:?}"
        );
        append(&layout, "third", "t", json!({})).unwrap();
        assert!(
            !fs::read_to_string(layout.audit_log())
                .unwrap()
                .contains("\n\n"),
            "a terminated file gets no blank line"
        );
    }

    // ---- the config audit's fallback: a refusing chain no longer blocks, its lines wait in the pending journal ----

    fn log_values(layout: &Layout) -> Vec<Value> {
        fs::read_to_string(layout.audit_log())
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// The pending journal's lines (not its marker).
    fn queued(layout: &Layout) -> Vec<Value> {
        fs::read_to_string(pending_path(layout))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|v| v.get("action").is_some())
            .collect()
    }

    /// The chain's `rec`s, checked the way `audit verify` does: `seq` counts up, every `prev` is the hash of the line
    /// before, and the anchor pins the newest line.
    fn chain_rows(layout: &Layout) -> Vec<Value> {
        let text = fs::read_to_string(layout.logs().join("audit-chain.jsonl")).unwrap();
        let mut prev = "0".repeat(64);
        let mut recs = Vec::new();
        for (i, raw) in text.lines().enumerate() {
            let line: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(line["seq"], i as u64 + 1);
            assert_eq!(line["prev"], prev.as_str());
            prev = chain::hash_line(raw);
            recs.push(line["rec"].clone());
        }
        let anchor: Value = serde_json::from_str(
            &fs::read_to_string(layout.logs().join("audit-chain.anchor")).unwrap(),
        )
        .unwrap();
        assert_eq!(anchor["seq"], recs.len() as u64);
        assert_eq!(anchor["hash"], prev.as_str());
        recs
    }

    /// What a repair does: the anchor is written again from the chain's newest line.
    fn restore_anchor(layout: &Layout) {
        let text = fs::read_to_string(layout.logs().join("audit-chain.jsonl")).unwrap();
        let last = text.lines().last().unwrap();
        let seq = serde_json::from_str::<Value>(last).unwrap()["seq"]
            .as_u64()
            .unwrap();
        fs::write(
            layout.logs().join("audit-chain.anchor"),
            json!({"v": 1, "seq": seq, "hash": chain::hash_line(last)}).to_string(),
        )
        .unwrap();
    }

    /// A layout whose chain holds one line and has then lost its anchor.
    fn layout_without_anchor() -> (tempfile::TempDir, Layout) {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        append(&layout, "setup.complete", "t", json!({})).unwrap();
        fs::remove_file(layout.logs().join("audit-chain.anchor")).unwrap();
        (dir, layout)
    }

    fn degrade(layout: &Layout, target: &str) -> Option<ChainRefusal> {
        append_as_degrading(
            layout,
            ("alice", "supervisor"),
            "audit.config.set",
            target,
            json!({ "newValue": 5 }),
        )
        .unwrap()
    }

    #[test]
    fn a_refusing_chain_still_logs_the_line_flagged_and_queues_it() {
        let (_dir, layout) = layout_without_anchor();
        let chain_before = fs::read(layout.logs().join("audit-chain.jsonl")).unwrap();
        let refusal = degrade(&layout, "k").expect("the chain refused");
        assert_eq!(refusal.reason, "anchor-missing");
        assert!(refusal.queued);
        assert_eq!(refusal.dropped, 0);
        assert_eq!(
            fs::read(layout.logs().join("audit-chain.jsonl")).unwrap(),
            chain_before,
            "the refusing chain is not touched"
        );
        let log = log_values(&layout);
        assert_eq!(log.len(), 2);
        assert!(log[0].get("chain").is_none());
        let line = &log[1];
        assert_eq!(line["action"], "audit.config.set");
        assert_eq!(line["actor"]["user"], "alice");
        assert_eq!(line["detail"]["newValue"], 5);
        assert_eq!(line["chain"], "refused");
        assert_eq!(line["chainReason"], "anchor-missing");
        assert_eq!(queued(&layout), vec![line.clone()], "the same line");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(pending_path(&layout))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // A line the chain takes carries no flag and queues nothing.
        let ok_dir = tempfile::tempdir().unwrap();
        let ok = Layout::new(ok_dir.path().to_path_buf());
        assert_eq!(degrade(&ok, "k"), None);
        assert!(log_values(&ok)[0].get("chain").is_none());
        assert!(!pending_path(&ok).exists());
    }

    #[test]
    fn the_plain_append_stays_fail_closed_and_queues_nothing() {
        let (_dir, layout) = layout_without_anchor();
        let log_before = fs::read(layout.audit_log()).unwrap();
        assert!(append(&layout, "repair.test", "t", json!({})).is_err());
        assert!(append_as(&layout, ("u", "h"), "repair.test", "t", json!({})).is_err());
        assert_eq!(fs::read(layout.audit_log()).unwrap(), log_before);
        assert!(!pending_path(&layout).exists());
    }

    #[test]
    fn an_unwritable_audit_log_fails_the_line_even_when_the_chain_refuses() {
        let (_dir, layout) = layout_without_anchor();
        fs::remove_file(layout.audit_log()).unwrap();
        fs::create_dir(layout.audit_log()).unwrap();
        assert!(append_as_degrading(&layout, ("u", "h"), "a.b", "t", json!({})).is_err());
        assert!(
            !pending_path(&layout).exists(),
            "nothing is queued for a line audit.log does not hold"
        );
        // And a healthy chain with an unwritable audit.log fails as before.
        let dir = tempfile::tempdir().unwrap();
        let healthy = Layout::new(dir.path().to_path_buf());
        fs::create_dir_all(healthy.logs()).unwrap();
        fs::create_dir(healthy.audit_log()).unwrap();
        assert!(append_as_degrading(&healthy, ("u", "h"), "a.b", "t", json!({})).is_err());
    }

    #[test]
    fn queued_lines_join_the_chain_in_order_once_it_accepts_appends_again() {
        let (_dir, layout) = layout_without_anchor();
        for i in 0..3 {
            assert!(degrade(&layout, &format!("k{i}")).is_some());
        }
        let refused: Vec<Value> = log_values(&layout)[1..4].to_vec();
        assert_eq!(queued(&layout), refused);
        // Repair: the anchor is back. The next append is taken and drains the journal.
        restore_anchor(&layout);
        assert_eq!(degrade(&layout, "k3"), None);
        let rows = chain_rows(&layout);
        assert_eq!(rows.len(), 1 + 1 + 3 + 1, "first, k3, three queued, event");
        assert_eq!(rows[1]["target"], "k3");
        assert_eq!(
            &rows[2..5],
            &refused[..],
            "original order, original time (`at`) and flag, byte for byte what audit.log holds"
        );
        assert_eq!(rows[5]["action"], "audit.chain.pending_drained");
        assert_eq!(rows[5]["detail"]["count"], 3);
        assert_eq!(rows[5]["detail"]["dropped"], 0);
        assert_eq!(rows[5]["detail"]["skipped"], 0);
        assert!(!pending_path(&layout).exists());
        let log = log_values(&layout);
        assert_eq!(
            log.len(),
            6,
            "queued lines are not written to audit.log twice"
        );
        assert_eq!(log[5], rows[5]);
        // Nothing left to drain: the next append only adds itself.
        append(&layout, "later", "t", json!({})).unwrap();
        assert_eq!(chain_rows(&layout).len(), 7);
        assert_eq!(drain_pending(&layout).unwrap(), 0);
    }

    #[test]
    fn a_drain_while_the_chain_still_refuses_changes_nothing() {
        let (_dir, layout) = layout_without_anchor();
        degrade(&layout, "k0").unwrap();
        degrade(&layout, "k1").unwrap();
        let journal = fs::read(pending_path(&layout)).unwrap();
        let log = fs::read(layout.audit_log()).unwrap();
        let e = drain_pending(&layout).unwrap_err();
        assert_eq!(chain::refusal_reason(&e), Some("anchor-missing"));
        assert_eq!(fs::read(pending_path(&layout)).unwrap(), journal);
        assert_eq!(fs::read(layout.audit_log()).unwrap(), log);
        assert!(!fs::read_to_string(layout.logs().join("audit-chain.jsonl"))
            .unwrap()
            .contains("pending_drained"));
    }

    #[test]
    fn the_journal_discards_the_oldest_lines_over_its_limit_counts_them_and_says_so() {
        let (_dir, layout) = layout_without_anchor();
        let queue = OnRefusal::Queue {
            max_lines: 3,
            max_bytes: 1 << 20,
        };
        let mut dropped = Vec::new();
        for i in 0..5 {
            let refusal = append_inner(
                &layout,
                ("alice", "supervisor"),
                "audit.config.set",
                &format!("k{i}"),
                json!({}),
                queue,
            )
            .unwrap()
            .unwrap();
            dropped.push(refusal.dropped);
        }
        assert_eq!(dropped, vec![0, 0, 0, 1, 1]);
        let text = fs::read_to_string(pending_path(&layout)).unwrap();
        assert!(text.starts_with("{\"pendingDropped\":2}\n"), "{text}");
        let targets: Vec<Value> = queued(&layout)
            .iter()
            .map(|v| v["target"].clone())
            .collect();
        assert_eq!(targets, vec![json!("k2"), json!("k3"), json!("k4")]);
        // audit.log holds every line, and a note for each overflow.
        let log = log_values(&layout);
        let notes: Vec<&Value> = log
            .iter()
            .filter(|v| v["action"] == "audit.chain.pending_overflow")
            .collect();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0]["detail"]["dropped"], 1);
        assert_eq!(notes[0]["detail"]["limitLines"], 3);
        assert_eq!(notes[0]["chain"], "refused");
        assert_eq!(
            log.iter()
                .filter(|v| v["action"] == "audit.config.set")
                .count(),
            5
        );
        // The drain (two lines per chain batch) carries the discarded count into the chain.
        restore_anchor(&layout);
        assert_eq!(drain_in_chunks(&layout, 2).unwrap(), 3);
        let rows = chain_rows(&layout);
        assert_eq!(rows.len(), 1 + 3 + 1);
        let order: Vec<Value> = rows[1..4].iter().map(|v| v["target"].clone()).collect();
        assert_eq!(order, vec![json!("k2"), json!("k3"), json!("k4")]);
        assert_eq!(rows[4]["action"], "audit.chain.pending_drained");
        assert_eq!(rows[4]["detail"]["count"], 3);
        assert_eq!(rows[4]["detail"]["dropped"], 2);
        assert!(!pending_path(&layout).exists());
    }

    #[test]
    fn the_journal_byte_limit_keeps_the_newest_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pending.jsonl");
        let line = |n: u32| format!("{{\"n\":{n}}}");
        let mut dropped = 0;
        for n in 0..6 {
            // 8 bytes per line with its newline: room for three.
            dropped += journal_append(&path, &line(n), 1000, 24).unwrap();
        }
        assert_eq!(dropped, 3);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!(
                "{{\"pendingDropped\":3}}\n{}\n{}\n{}\n",
                line(3),
                line(4),
                line(5)
            )
        );
        // A line larger than the limit on its own is still kept: the newest line is never the one discarded.
        let big = dir.path().join("big.jsonl");
        assert_eq!(journal_append(&big, &line(1), 1000, 1).unwrap(), 0);
        assert_eq!(journal_append(&big, &line(2), 1000, 1).unwrap(), 1);
        assert_eq!(
            fs::read_to_string(&big).unwrap(),
            format!("{{\"pendingDropped\":1}}\n{}\n", line(2))
        );
    }

    #[test]
    fn a_torn_journal_fragment_stays_a_line_of_its_own_and_the_drain_skips_it() {
        let (_dir, layout) = layout_without_anchor();
        degrade(&layout, "k0").unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(pending_path(&layout))
            .unwrap()
            .write_all(b"{\"at\":1,\"acti")
            .unwrap();
        degrade(&layout, "k1").unwrap();
        restore_anchor(&layout);
        assert_eq!(drain_pending(&layout).unwrap(), 2);
        let rows = chain_rows(&layout);
        assert_eq!(rows.len(), 1 + 2 + 1);
        assert_eq!(rows[1]["target"], "k0");
        assert_eq!(rows[2]["target"], "k1");
        assert_eq!(rows[3]["detail"]["skipped"], 1);
        assert!(!pending_path(&layout).exists());
    }
}
