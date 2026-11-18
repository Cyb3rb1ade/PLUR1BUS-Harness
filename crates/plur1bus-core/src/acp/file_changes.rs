//! ACP change presentation consumes Core events; it never reads or writes editor or worktree files (port of
//! `packages/core/src/acp/file-changes.ts`).
//!
//! A standard ACP diff is shown only for a proved complete new-file write; every other patch stays labelled text. The module
//! keeps only bounded call details (16 calls, 2 MiB of text at most, 1024 ids seen) and treats a reused call id as ambiguous.
use super::json::{parse, V};
use super::text::{acp_text, AcpLanguage, AcpText};
use crate::js::utf16_len;
use std::collections::HashSet;

/// Even JSON's worst-case six-byte escapes fit under ACP's 1 MiB line budget, including the path and the envelope.
pub const MAX_DIFF_CONTENT_BYTES: usize = 128 * 1024;
/// How many file calls are kept while their results are awaited.
pub const MAX_RETAINED_FILE_CALLS: usize = 16;
const MAX_SEEN_FILE_CALLS: usize = 1024;
const MAX_PATCH_BYTES: usize = 32 * 1024;
const MAX_RESULT_PARSE_BYTES: usize = 2 * 1024 * 1024;

/// What the editor is shown for a finished file tool.
#[derive(Clone, Debug, PartialEq)]
pub enum AcpFileContent {
    /// A standard ACP diff of a new file.
    Diff {
        /// The absolute path inside the granted worktree.
        path: String,
        /// The new contents.
        new_text: String,
    },
    /// Labelled text.
    Text(String),
}

impl AcpFileContent {
    /// The ACP `ToolCallContent` object.
    pub fn to_value(&self) -> V {
        match self {
            AcpFileContent::Diff { path, new_text } => V::obj([
                ("type", V::s("diff")),
                ("path", V::s(path)),
                ("oldText", V::Null),
                ("newText", V::s(new_text)),
            ]),
            AcpFileContent::Text(text) => V::obj([
                ("type", V::s("content")),
                (
                    "content",
                    V::obj([("type", V::s("text")), ("text", V::s(text))]),
                ),
            ]),
        }
    }
}

struct FileCall {
    is_write: bool,
    content: Option<String>,
    oversized: bool,
    utf8: bool,
    ambiguous: bool,
}

fn clipped(text: &str, notice: &str) -> String {
    let bytes = text.as_bytes();
    if bytes.len() <= MAX_PATCH_BYTES {
        return text.to_owned();
    }
    let mut end = MAX_PATCH_BYTES;
    while (bytes[end] & 0xc0) == 0x80 {
        end -= 1;
    }
    format!("{}\n{notice}", String::from_utf8_lossy(&bytes[..end]))
}

/// Node's `path.win32` / `path.posix` `resolve(root, relative)` for a relative path that has no empty, `.` or `..` part.
fn native_resolve(root: &str, relative: &str) -> Option<String> {
    let b = root.as_bytes();
    let drive = b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/');
    let unc = b.len() >= 2 && b[0] == b'\\' && b[1] == b'\\';
    if !drive && !unc {
        if !root.starts_with('/') {
            return None;
        }
        let mut segs: Vec<&str> = Vec::new();
        for part in root.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    segs.pop();
                }
                p => segs.push(p),
            }
        }
        segs.push(relative);
        return Some(format!("/{}", segs.join("/")));
    }
    let (device, rest) = if drive {
        (root[..2].to_owned(), &root[3..])
    } else {
        // `\\server\share\rest`: both names are needed for a UNC root; anything else is left to the plain-text path.
        let body = &root[2..];
        let mut parts = body.splitn(3, ['\\', '/']);
        let server = parts.next().filter(|s| !s.is_empty())?;
        let share = parts.next().filter(|s| !s.is_empty())?;
        (format!("\\\\{server}\\{share}"), parts.next().unwrap_or(""))
    };
    let mut segs: Vec<&str> = Vec::new();
    for part in rest.split(['\\', '/']) {
        match part {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            p => segs.push(p),
        }
    }
    let rel = relative.replace('/', "\\");
    segs.push(&rel);
    Some(format!("{device}\\{}", segs.join("\\")))
}

fn full_path(root: Option<&str>, value: &V) -> Option<String> {
    let root = root.filter(|r| !r.is_empty())?;
    if value.get("rootId").and_then(V::as_str) != Some("coding-worktree") {
        return None;
    }
    let relative = value.get("path").and_then(V::as_str)?;
    if relative.is_empty()
        || utf16_len(relative) > 4096
        || relative.contains(['\\', '\0', ':'])
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return None;
    }
    native_resolve(root, relative)
}

fn layers(envelope: Option<&V>) -> Vec<&V> {
    let mut rows = Vec::new();
    let mut value = envelope;
    while let Some(v) = value {
        if !v.is_obj() || rows.len() >= 5 {
            break;
        }
        rows.push(v);
        value = ["value", "data", "result"]
            .iter()
            .find_map(|k| v.get(k).filter(|x| !matches!(x, V::Null)));
    }
    rows
}

/// Keeps only bounded call details needed to explain completed file operations.
pub struct AcpFileChanges {
    root: Option<String>,
    text: &'static AcpText,
    calls: Vec<(String, FileCall)>,
    seen: HashSet<String>,
}

impl AcpFileChanges {
    /// A tracker for the session's bound worktree root (none: no standard diff is ever produced).
    pub fn new(root: Option<String>, language: AcpLanguage) -> AcpFileChanges {
        AcpFileChanges {
            root,
            text: acp_text(language),
            calls: Vec::new(),
            seen: HashSet::new(),
        }
    }

    /// Retain at most 2 MiB of full text, only for known file tools, and reject ambiguous or reused call ids.
    pub fn call(&mut self, id: &str, name: &str, args: Option<&V>) {
        if (name != "file.write" && name != "file.edit") || id.is_empty() || utf16_len(id) > 256 {
            return;
        }
        let duplicate = self.seen.contains(id);
        if !duplicate && self.seen.len() >= MAX_SEEN_FILE_CALLS {
            return;
        }
        self.seen.insert(id.to_owned());
        if let Some((_, previous)) = self.calls.iter_mut().find(|(k, _)| k == id) {
            previous.ambiguous = true;
            return;
        }
        let object = args.filter(|a| a.is_obj());
        let content = object.and_then(|a| a.get("content")).and_then(V::as_str);
        let oversized = content.is_some_and(|c| c.len() > MAX_DIFF_CONTENT_BYTES);
        let utf8 = object.is_some_and(|a| match a.get("encoding") {
            None => true,
            Some(e) => e.as_str() == Some("utf8"),
        });
        self.calls.push((
            id.to_owned(),
            FileCall {
                is_write: name == "file.write",
                oversized,
                ambiguous: duplicate,
                utf8,
                content: content.filter(|_| !oversized).map(str::to_owned),
            },
        ));
        if self.calls.len() > MAX_RETAINED_FILE_CALLS {
            self.calls.remove(0);
        }
    }

    /// Standard ACP diff only for a proved complete new-file write; all other patches remain labelled text.
    pub fn result(&mut self, id: &str, output: &str) -> Option<Vec<AcpFileContent>> {
        let call = self
            .calls
            .iter()
            .position(|(k, _)| k == id)
            .map(|i| self.calls.remove(i).1);
        let parsed = if output.len() <= MAX_RESULT_PARSE_BYTES {
            parse(output)
        } else {
            None
        };
        let rows = layers(parsed.as_ref());
        let patch: Option<&str> = rows
            .iter()
            .filter_map(|row| match row.get("diff") {
                Some(v) if !matches!(v, V::Null) => v.as_str(),
                _ => row.get("unifiedDiff").and_then(V::as_str),
            })
            .next();
        let tool_named = parsed.as_ref().is_some_and(|p| {
            p.is_obj()
                && matches!(
                    p.get("tool").and_then(V::as_str),
                    Some("file.write" | "file.edit")
                )
        });
        if call.is_none() && !self.seen.contains(id) && patch.is_none() && !tool_named {
            return None;
        }
        let truncated = rows.iter().any(|row| {
            let flag = !matches!(row.get("truncated"), None | Some(V::Bool(false)));
            flag || matches!(row.get("diffTruncated"), Some(V::Bool(true)))
                || row.get("meta").is_some_and(|m| {
                    m.is_obj() && matches!(m.get("truncated"), Some(V::Bool(true)))
                })
        });
        let value = rows.iter().find(|row| {
            row.get("rootId").and_then(V::as_str) == Some("coding-worktree")
                && row.get("path").and_then(V::as_str).is_some()
        });
        let target = value.and_then(|v| full_path(self.root.as_deref(), v));
        let failed = rows
            .iter()
            .any(|row| matches!(row.get("isError"), Some(V::Bool(true))));
        // The persisted public envelope omits dispatcher ids: the owned turn's call/result event pair supplies them. If a
        // producer does include ids, a mismatch is still a refusal of complete-content presentation.
        if let (Some(call), Some(p), Some(value), Some(target)) =
            (&call, parsed.as_ref(), value, &target)
        {
            if let Some(content) = call.content.as_deref() {
                if call.is_write
                    && !call.ambiguous
                    && call.utf8
                    && !call.oversized
                    && !truncated
                    && !failed
                    && p.is_obj()
                    && matches!(p.get("isError"), Some(V::Bool(false)))
                    && p.get("tool")
                        .is_none_or(|t| t.as_str() == Some("file.write"))
                    && p.get("callId").is_none_or(|c| c.as_str() == Some(id))
                    && matches!(value.get("created"), Some(V::Bool(true)))
                    && value.get("bytesWritten").and_then(V::as_f64) == Some(content.len() as f64)
                {
                    return Some(vec![AcpFileContent::Diff {
                        path: target.clone(),
                        new_text: content.to_owned(),
                    }]);
                }
            }
        }
        let text = self.text;
        let mut reasons: Vec<&str> = Vec::new();
        if truncated {
            reasons.push(text.truncated);
        }
        if call.as_ref().is_some_and(|c| c.oversized) {
            reasons.push(text.size_limit);
        }
        if failed {
            reasons.push(text.tool_failed);
        }
        reasons.push(text.unknown_contents);
        let reason = reasons.join("; ");
        let heading = match patch {
            Some(_) => format!("{} ({reason}):", text.patch),
            None => format!("{} ({reason}; {}):", text.tool_result, text.no_patch),
        };
        Some(vec![AcpFileContent::Text(format!(
            "{heading}\n{}",
            clipped(patch.unwrap_or(output), text.display_clipped)
        ))])
    }
}
