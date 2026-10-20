//! `logs/audit.log` (HB12, ADR-006, D66): one JSON line per privileged CLI action,
//! `{ at, actor: { user, host }, action, target, detail }`, append-only, private to the user (0600; user and SYSTEM
//! on Windows). Actions in 2a-H3b-b: `licence.accept-nc`, `setup.complete`, `repair.<step id>`.
// The writers (setup, repair) land in 2a-H3b-b Tasks 4 and 7; until then only the tests call `append`.
#![allow(dead_code)]
#[path = "audit_chain.rs"]
mod chain;
#[path = "audit_redact.rs"]
mod redact;
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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Appends one audit line; `detail` is redacted first (`audit_redact.rs`, rules from `redaction.json`). The line is
/// written with a single `write_all` on an `O_APPEND` handle, so a crash never leaves a partial line in the middle of
/// the file, and it is fsynced before this returns.
pub fn append(layout: &Layout, action: &str, target: &str, detail: Value) -> io::Result<()> {
    let path = layout.audit_log();
    fs::create_dir_all(layout.logs())?;
    // Create (or re-restrict) the file privately first; the append handle below cannot also carry WRITE_DAC on
    // Windows without losing append semantics.
    drop(create_private(&path, false)?);
    let caller = crate::identity::caller();
    // D111 §4: the detail is redacted once, here, so the chain line and the `audit.log` line carry the same text. When
    // the redaction cannot be set up nothing is written; an audit line never falls back to the raw detail.
    let detail = redact::redact_detail(&detail)?;
    let line = json!({
        "at": now_ms(),
        "actor": { "user": caller.user_id, "host": caller.account_id },
        "action": action,
        "target": target,
        "detail": detail,
    });
    chain::append(&layout.logs(), &line)?;
    let mut f = fs::OpenOptions::new().append(true).read(true).open(&path)?;
    let entry = serde_json::to_string(&line).map_err(io::Error::other)?;
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
        let same = |v: Value| (v.clone(), v);
        for (i, (detail, shown)) in [
            same(json!({ "t": "a\nb\r\nc" })),
            same(json!({ "t": "ünï ✓ 😀 \u{0} \u{2028}" })),
            same(json!({ "t": "y ".repeat(1 << 19) })),
            // A megabyte without a break is a base64url run (a credential shape, D111 §4 rule 3): it is masked, and
            // what is left is still one line.
            (
                json!({ "t": "y".repeat(1 << 20) }),
                json!({ "t": "[REDACTED:pattern]" }),
            ),
            same(json!(null)),
            same(json!([1, 2, 3])),
        ]
        .into_iter()
        .enumerate()
        {
            append(
                &layout,
                &format!("test.action{i}"),
                "target\nwith newline",
                detail,
            )
            .unwrap();
            let all = lines(&layout);
            assert_eq!(all.len(), i + 1, "one physical line per entry");
            let v: Value = serde_json::from_str(all.last().unwrap()).unwrap();
            assert_eq!(v["detail"], shown);
            assert_eq!(v["target"], "target\nwith newline");
        }
    }

    /// The chain's lines, each with the hash its successor must name, checked the way `audit verify` does: `seq`
    /// counts up from 1, every `prev` is the SHA-256 of the line before (the genesis hash for the first), and the
    /// anchor pins the newest (seq, hash).
    fn chain_records(layout: &Layout) -> Vec<Value> {
        let text = fs::read_to_string(layout.logs().join("audit-chain.jsonl")).unwrap();
        let mut prev = "0".repeat(64);
        let mut recs = Vec::new();
        for (i, line) in text.lines().enumerate() {
            let v: Value = serde_json::from_str(line).unwrap();
            assert_eq!(v["seq"], i as u64 + 1);
            assert_eq!(v["prev"], prev.as_str());
            prev = chain::hash_line(line);
            recs.push(v["rec"].clone());
        }
        let anchor: Value = serde_json::from_str(
            fs::read_to_string(layout.logs().join("audit-chain.anchor"))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(anchor["seq"], recs.len() as u64);
        assert_eq!(anchor["hash"], prev.as_str());
        recs
    }

    /// D111 §4: a secret in `detail` reaches neither the chain nor `audit.log`, both hold the same redacted record,
    /// and the chain still verifies (the hash is taken over the redacted line).
    #[test]
    fn a_secret_in_the_detail_reaches_neither_the_chain_nor_the_audit_log() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        // Assembled at run time: no credential-shaped literal sits in the source.
        let token = format!("ghp_{}", "A1b2".repeat(10));
        let bearer = format!("Bearer {}", "Zz9".repeat(8));
        let url = format!("see https://u:p4ss@example.com/x?code=abc{}", 123);
        append(
            &layout,
            "repair.test",
            "t",
            json!({
                "reason": format!("provider said {token}"),
                "message": bearer,
                "password": "hunter2-hunter2",
                "nested": { "list": [url], "ok": 3 },
                "kept": "linux-x64",
            }),
        )
        .unwrap();
        let legacy = fs::read_to_string(layout.audit_log()).unwrap();
        let chain_text = fs::read_to_string(layout.logs().join("audit-chain.jsonl")).unwrap();
        for needle in [token.as_str(), "Zz9Zz9", "hunter2", "p4ss", "abc123"] {
            assert!(!legacy.contains(needle), "{needle} in audit.log");
            assert!(!chain_text.contains(needle), "{needle} in the chain");
        }
        let line: Value = serde_json::from_str(legacy.trim()).unwrap();
        assert_eq!(
            line["detail"],
            json!({
                "reason": "provider said [REDACTED:pattern]",
                "message": "[REDACTED:pattern]",
                "password": "[REDACTED:key]",
                "nested": { "list": ["see https://example.com/x?code=[REDACTED:url]"], "ok": 3 },
                "kept": "linux-x64",
            })
        );
        let recs = chain_records(&layout);
        assert_eq!(recs, vec![line], "the chain holds the audit.log record");
    }

    /// The counterpart: what is not a secret is written byte for byte, in both files, and the chain verifies.
    #[test]
    fn an_ordinary_detail_is_written_byte_for_byte_and_the_chain_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        let details = [
            json!({ "target": "linux-x64", "channel": "stable", "core": "bundled", "profile": "standard" }),
            json!({ "useClass": "research", "acceptedAt": "2026-10-20T10:00:00Z" }),
            json!({ "status": "done", "reason": "stale-files", "detail": { "removed": 2, "paths": ["data/ext/fixture"] } }),
            json!({}),
        ];
        for (i, d) in details.iter().enumerate() {
            append(&layout, &format!("test.action{i}"), "t", d.clone()).unwrap();
        }
        let recs = chain_records(&layout);
        let shown: Vec<Value> = lines(&layout)
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(recs, shown);
        for (i, d) in details.iter().enumerate() {
            assert_eq!(shown[i]["detail"].to_string(), d.to_string());
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
}
