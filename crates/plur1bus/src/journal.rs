//! `state/journal/<agentId>.jsonl`: the CLI's fallback when the core is unavailable. Every
//! `memory add` that cannot reach the core appends one line here; the core's journal replay
//! (`packages/core/src/journal.ts`) renames the file before reading and appends kept lines back,
//! so this module must only ever append whole lines (one write per line, trailing newline).
use crate::identity::CallerIdentity;
use crate::paths::Layout;
use serde::Serialize;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{self, Write};

#[derive(Serialize)]
pub struct Message<'a> {
    pub role: &'static str,
    pub content: &'a str,
}

#[derive(Serialize)]
pub struct JournalLine<'a> {
    pub v: u8,
    pub id: String,
    pub at: u64,
    #[serde(rename = "agentId")]
    pub agent_id: &'a str,
    #[serde(rename = "sessionKey", skip_serializing_if = "Option::is_none")]
    pub session_key: Option<&'a str>,
    pub caller: &'a CallerIdentity,
    pub messages: Vec<Message<'a>>,
}

/// Appends one whole JSONL line to `state/journal/<agentId>.jsonl`, creating the directory
/// (mode 0700) and file (mode 0600) as needed. Uses `O_APPEND` so a partial write from a crash
/// never corrupts an earlier line, and the core's rename-then-replay dance never races a
/// half-written line.
pub fn append(layout: &Layout, line: &JournalLine<'_>) -> io::Result<()> {
    let dir = layout.journal();
    create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(dir.join(format!("{}.jsonl", line.agent_id)))?;
    let mut text = serde_json::to_string(line).unwrap();
    text.push('\n');
    f.write_all(text.as_bytes())?;
    f.flush()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
