//! `logs/audit.log` (HB12, ADR-006, D66): one JSON line per privileged CLI action,
//! `{ at, actor: { user, host }, action, target, detail }`, append-only, private to the user (0600; user and SYSTEM
//! on Windows). Actions in 2a-H3b-b: `licence.accept-nc`, `setup.complete`, `repair.<step id>`.
// The writers (setup, repair) land in 2a-H3b-b Tasks 4 and 7; until then only the tests call `append`.
#![allow(dead_code)]
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

/// Appends one audit line. The line is written with a single `write_all` on an `O_APPEND` handle, so a crash never
/// leaves a partial line in the middle of the file, and it is fsynced before this returns.
pub fn append(layout: &Layout, action: &str, target: &str, detail: Value) -> io::Result<()> {
    let path = layout.audit_log();
    fs::create_dir_all(layout.logs())?;
    // Create (or re-restrict) the file privately first; the append handle below cannot also carry WRITE_DAC on
    // Windows without losing append semantics.
    drop(create_private(&path, false)?);
    let caller = crate::identity::caller();
    let line = json!({
        "at": now_ms(),
        "actor": { "user": caller.user_id, "host": caller.account_id },
        "action": action,
        "target": target,
        "detail": detail,
    });
    let mut text = serde_json::to_string(&line).map_err(io::Error::other)?;
    text.push('\n');
    let mut f = fs::OpenOptions::new().append(true).open(&path)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()
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
}
