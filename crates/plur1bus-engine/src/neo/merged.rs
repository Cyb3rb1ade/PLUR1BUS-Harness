//! Trusted C4 metadata reads: latest revision, then D130 ACL, then result limit.
//! Vectors are deliberately not projected here: sidecar attachment is a separate operation.
use super::{acl, merged_order, tail, vectors};
use crate::{
    context::RequestContext,
    contract::StoreError,
    store::directory::TrustedDirectory,
    text::{js::js_trim, json::TolerantJsonValue as Json},
};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Canonical hashed workspace directory plus an unambiguous old directory, when safe.
#[derive(Debug, Clone)]
pub struct Layout {
    /// Hash-suffixed single directory segment, compatible with Node stableHash.
    pub canonical: String,
    /// Old directory segment; absent for lossy aliases and parent-directory aliases.
    pub legacy: Option<String>,
}
impl Layout {
    /// Compute paths from a host-authenticated workspace key, never from a record's claims.
    pub fn for_key(key: &str) -> Self {
        let old_raw = js_trim(if key.is_empty() { "default" } else { key });
        let raw = if old_raw.is_empty() {
            "default"
        } else {
            old_raw
        };
        let mut slug = String::new();
        let mut replacing = false;
        for ch in raw.chars() {
            if ch.is_ascii_alphanumeric() || ".-_".contains(ch) {
                slug.push(ch);
                replacing = false;
            } else if !replacing {
                slug.push('_');
                replacing = true;
            }
        }
        let slug = slug.trim_matches('_');
        let slug = if slug.is_empty() { "default" } else { slug };
        let slug: String = slug.chars().take(120).collect();
        // These are UTF-8 strings and a fixed ordered array; serde emits Node-compatible JSON.
        let bytes = serde_json::json!(["neo-stable-id-v1", "workspace", raw]).to_string();
        let hash = format!("{:x}", Sha256::digest(bytes.as_bytes()));
        Self {
            canonical: format!("{}--{}", &slug[..slug.len().min(80)], &hash[..20]),
            legacy: (slug == old_raw && !matches!(slug.as_str(), "." | "..")).then_some(slug),
        }
    }
}
/// Closed file routing: callers cannot supply arbitrary filenames or relative paths.
#[derive(Debug, Clone, Copy)]
pub enum RecordKind {
    /// Turn journal metadata.
    Turns,
    /// Proposed memory cards.
    Candidates,
    /// Reactions to turns.
    Reactions,
    /// Derived behavior cards.
    Behavior,
    /// Embedding queue metadata.
    EmbeddingQueue,
    /// Dream diary.
    Dreams,
    /// Episodes.
    Episodes,
    /// Memory graph edges.
    Graph,
    /// Pattern analysis.
    Patterns,
}
impl RecordKind {
    /// Node-compatible fixed JSONL filename.
    pub const fn file_name(self) -> &'static str {
        match self {
            Self::Turns => "turn-journal.jsonl",
            Self::Candidates => "memory-candidates.jsonl",
            Self::Reactions => "reaction-ledger.jsonl",
            Self::Behavior => "behavior-cards.jsonl",
            Self::EmbeddingQueue => "embedding-queue.jsonl",
            Self::Dreams => "dream-diary.jsonl",
            Self::Episodes => "episodes.jsonl",
            Self::Graph => "memory-graph.jsonl",
            Self::Patterns => "pattern-analysis.jsonl",
        }
    }
}
/// Authorized metadata and its optional vector. Sidecar values stay separate from JSON
/// so serializing the metadata preserves Node's non-enumerable lazy-vector behavior.
#[derive(Debug)]
pub struct Record {
    /// Original metadata, without injected sidecar properties.
    pub metadata: Json,
    /// Inline f64 values or losslessly widened float32 sidecar values.
    pub embedding: Option<Vec<f64>>,
}
struct Window {
    rows: Vec<merged_order::Sourced>,
    canonical: Option<TrustedDirectory>,
    legacy: Option<TrustedDirectory>,
}
impl Window {
    fn empty() -> Self {
        Self {
            rows: Vec::new(),
            canonical: None,
            legacy: None,
        }
    }
}

/// Warm read handle. Opening or reading never creates directories, ledgers, indexes or locks.
/// The root must already exist. Retrieval/reconsolidation ledgers are intentionally excluded:
/// their idempotency and watermark semantics are canonical-only, not merged metadata.
pub struct MetadataReader {
    root: TrustedDirectory,
    layout: Layout,
}
impl MetadataReader {
    /// Bind a trusted existing Neo root and a host-proven workspace storage key.
    pub fn open(root: &Path, key: &str) -> Result<Self, StoreError> {
        Ok(Self {
            root: TrustedDirectory::open(root)?,
            layout: Layout::for_key(key),
        })
    }
    /// Read the newest distinct accessible metadata in stable creation-time order.
    /// Each source scans at most 50,000 tail lines and 64 MiB per window. Requests above
    /// that line bound fail explicitly; unavailable/corrupt paths never become empty success.
    pub fn read_metadata(
        &self,
        kind: RecordKind,
        limit: usize,
        ctx: &RequestContext,
    ) -> Result<Vec<Json>, StoreError> {
        Ok(self
            .window(kind, limit, ctx)?
            .rows
            .into_iter()
            .map(|row| row.metadata)
            .collect())
    }
    /// Attach only the winning revision's own physical-source vector, after authorization.
    /// Malformed indexed data is an error, while an absent index/entry is an absent vector.
    /// This takes manifest snapshots; it is not a cross-ledger writer transaction.
    pub fn read_records(
        &self,
        kind: RecordKind,
        limit: usize,
        ctx: &RequestContext,
    ) -> Result<Vec<Record>, StoreError> {
        let window = self.window(kind, limit, ctx)?;
        let rows = vectors::attach(
            kind,
            window.rows,
            window.canonical.as_ref(),
            window.legacy.as_ref(),
        )?;
        self.root.assert_unchanged()?;
        Ok(rows)
    }
    fn window(
        &self,
        kind: RecordKind,
        limit: usize,
        ctx: &RequestContext,
    ) -> Result<Window, StoreError> {
        if limit > tail::MAX_LINES {
            return Err(StoreError::InvalidInput);
        }
        self.root.assert_unchanged()?;
        if limit == 0 {
            return Ok(Window::empty());
        }
        let Some(workspaces) = optional(self.root.open_child("workspaces"))? else {
            return Ok(Window::empty());
        };
        let canonical = optional(workspaces.open_child(&self.layout.canonical))?;
        let legacy = self
            .layout
            .legacy
            .as_ref()
            .map(|name| optional(workspaces.open_child(name)))
            .transpose()?
            .flatten();
        let mut window = limit;
        loop {
            let a = tail::read(canonical.as_ref(), kind.file_name(), window)?;
            let b = tail::read(legacy.as_ref(), kind.file_name(), window)?;
            let exhausted = a.len() < window && b.len() < window;
            let mut rows = merged_order::merge(&a, &b);
            rows.retain(|row| acl::visible(&row.metadata, Some(ctx)));
            if rows.len() >= limit || exhausted || window == tail::MAX_LINES {
                self.root.assert_unchanged()?;
                workspaces.assert_unchanged()?;
                if let Some(dir) = &canonical {
                    dir.assert_unchanged()?;
                }
                if let Some(dir) = &legacy {
                    dir.assert_unchanged()?;
                }
                return Ok(Window {
                    rows: merged_order::select(rows, limit),
                    canonical,
                    legacy,
                });
            }
            window = (window * 4).min(tail::MAX_LINES);
        }
    }
}
pub(super) fn optional<T>(result: Result<T, StoreError>) -> Result<Option<T>, StoreError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => Ok(None),
        Err(error) => Err(error),
    }
}
