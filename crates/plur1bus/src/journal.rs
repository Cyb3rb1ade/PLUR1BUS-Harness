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
    // Readable too: a file that ends without a newline (a crash in the middle of a write) is noticed below.
    o.read(true);
    let mut f = o.open(dir.join(format!("{}.jsonl", line.agent_id)))?;
    let mut text = String::new();
    if ends_in_a_torn_line(&mut f)? {
        // The fragment stays a line of its own and this entry starts a fresh one, in the same single write.
        text.push('\n');
    }
    text.push_str(&serde_json::to_string(line).unwrap());
    text.push('\n');
    f.write_all(text.as_bytes())?;
    f.flush()
}

/// Whether the file is non-empty and its last byte is not a newline.
fn ends_in_a_torn_line(f: &mut std::fs::File) -> io::Result<bool> {
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

pub fn now_ms() -> u64 {
    epoch_ms(std::time::SystemTime::now())
}

/// Milliseconds since the Unix epoch. A clock set before 1970 reads as 0 instead of panicking (the callers stamp
/// audit and journal lines; a wrong stamp is better than a dead command).
pub fn epoch_ms(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn a_clock_before_1970_reads_as_zero_not_a_panic() {
        assert_eq!(epoch_ms(UNIX_EPOCH - Duration::from_secs(1)), 0);
        assert_eq!(epoch_ms(UNIX_EPOCH), 0);
        assert_eq!(epoch_ms(UNIX_EPOCH + Duration::from_millis(1_234)), 1_234);
        let _ = epoch_ms(SystemTime::now());
    }

    fn line_for<'a>(
        caller: &'a CallerIdentity,
        agent: &'a str,
        id: String,
        content: &'a str,
    ) -> JournalLine<'a> {
        JournalLine {
            v: 1,
            id,
            at: 1,
            agent_id: agent,
            session_key: None,
            caller,
            messages: vec![Message {
                role: "user",
                content,
            }],
        }
    }

    fn lines_of(layout: &Layout, agent: &str) -> Vec<String> {
        let text =
            std::fs::read_to_string(layout.journal().join(format!("{agent}.jsonl"))).unwrap();
        text.split_inclusive('\n').map(str::to_string).collect()
    }

    #[test]
    fn appending_never_rewrites_an_earlier_byte_and_every_line_is_one_json_line() {
        let d = tempfile::tempdir().unwrap();
        let layout = Layout::new(d.path().to_path_buf());
        let caller = crate::identity::caller();
        let path = layout.journal().join("bernd.jsonl");
        let mut previous = Vec::new();
        for (i, content) in [
            "plain",
            "two\nlines",
            "tab\tand \"quotes\"",
            "ünïcödé ✓ 😀",
            "nul\u{0}byte",
            "\r\n",
        ]
        .iter()
        .enumerate()
        {
            append(
                &layout,
                &line_for(&caller, "bernd", format!("id-{i}"), content),
            )
            .unwrap();
            let now = std::fs::read(&path).unwrap();
            assert!(
                now.starts_with(&previous),
                "append {i} changed bytes that were already there"
            );
            assert!(now.len() > previous.len());
            assert_eq!(
                now.iter().filter(|b| **b == b'\n').count(),
                i + 1,
                "one physical line per entry"
            );
            previous = now;
        }
        for (i, l) in lines_of(&layout, "bernd").iter().enumerate() {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            assert_eq!(v["id"], format!("id-{i}"));
            assert_eq!(v["v"], 1);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(layout.journal())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn concurrent_writers_never_interleave_lines() {
        let d = tempfile::tempdir().unwrap();
        let layout = std::sync::Arc::new(Layout::new(d.path().to_path_buf()));
        let (threads, per_thread) = (8usize, 150usize);
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let layout = layout.clone();
                std::thread::spawn(move || {
                    let caller = crate::identity::caller();
                    for i in 0..per_thread {
                        // A mix of short lines and lines far beyond a pipe buffer.
                        let pad = "x".repeat(if i % 10 == 0 { 70_000 } else { 20 + t });
                        let content = format!("t{t}-{i}-{pad}");
                        append(
                            &layout,
                            &line_for(&caller, "bernd", format!("t{t}-{i}"), &content),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let lines = lines_of(&layout, "bernd");
        assert_eq!(lines.len(), threads * per_thread);
        let mut seen = std::collections::BTreeSet::new();
        for l in &lines {
            assert!(l.ends_with('\n'));
            let v: serde_json::Value = serde_json::from_str(l).unwrap_or_else(|e| {
                panic!("an interleaved line ({e}): {}", &l[..l.len().min(120)])
            });
            let id = v["id"].as_str().unwrap().to_string();
            let content = v["messages"][0]["content"].as_str().unwrap();
            assert!(
                content.starts_with(&format!("{id}-")),
                "the content of {id} belongs to another writer"
            );
            assert!(seen.insert(id), "a duplicated line");
        }
    }

    /// A crash in the middle of a write leaves a last line without its newline. The next append must start on a line of its own:
    /// the core's replay counts only `\n`-terminated lines and keeps a torn tail, so a new entry glued to the fragment would
    /// become one malformed line and the memory it carries would be lost without a word.
    #[test]
    fn an_append_after_a_torn_last_line_starts_its_own_line_and_leaves_every_earlier_line_alone() {
        let d = tempfile::tempdir().unwrap();
        let layout = Layout::new(d.path().to_path_buf());
        let caller = crate::identity::caller();
        append(&layout, &line_for(&caller, "bernd", "first".into(), "one")).unwrap();
        let path = layout.journal().join("bernd.jsonl");
        let intact = std::fs::read(&path).unwrap();
        // Half of the next line, as a killed writer leaves it.
        let mut torn = intact.clone();
        torn.extend_from_slice(b"{\"v\":1,\"id\":\"half\",\"at\":1,\"agentId\":\"bern");
        std::fs::write(&path, &torn).unwrap();
        append(&layout, &line_for(&caller, "bernd", "after".into(), "two")).unwrap();
        let now = std::fs::read(&path).unwrap();
        assert!(
            now.starts_with(&torn),
            "the fragment and everything before it stay as they were"
        );
        let lines = lines_of(&layout, "bernd");
        let last: serde_json::Value = serde_json::from_str(lines.last().unwrap())
            .expect("the new entry is a line of its own");
        assert_eq!(last["id"], "after");
        assert_eq!(
            lines
                .iter()
                .filter(|l| serde_json::from_str::<serde_json::Value>(l).is_ok())
                .count(),
            2,
            "{lines:?}"
        );
        // And an already terminated file gets no blank line.
        append(
            &layout,
            &line_for(&caller, "bernd", "third".into(), "three"),
        )
        .unwrap();
        assert!(!String::from_utf8(std::fs::read(&path).unwrap())
            .unwrap()
            .contains("\n\n"));
    }
}
