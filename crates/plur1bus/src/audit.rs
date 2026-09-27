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
}
