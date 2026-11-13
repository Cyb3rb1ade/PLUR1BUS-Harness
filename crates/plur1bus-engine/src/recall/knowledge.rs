//! Canonical sections from `memory/KNOWLEDGE.md`.
//!
//! C1 serves successfully embedded sections but persists only a complete set.
//! A failed section must be retried even when the source mtime is unchanged.
//! The pinned recorder leaves `embeddings.identity` unset, so the cache identity
//! is `"legacy"`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::text::js::utf16_slice;
use crate::{
    context::RequestContext,
    embedding::{Cancel, EmbedKind, EmbeddingProvider},
    store::{directory::TrustedDirectory, Store},
};
use std::io::Read;

use super::hash_embed::cosine_similarity;

const CACHE_NAME: &str = "knowledge-cache.json";
const LEGACY_IDENTITY: &str = "legacy";
pub(crate) const PRIVATE_ROOT: &str = "_knowledge";
pub(crate) const PRIVATE_MAX_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn private_key(context: &RequestContext) -> Option<String> {
    if context.owner_user_id.is_empty()
        || context.workspace_key.is_empty()
        || context.trust() != "proved"
    {
        return None;
    }
    let binding = serde_json::to_vec(&[
        context.agent_id.as_str(),
        &context.owner_user_id,
        &context.workspace_key,
    ])
    .ok()?;
    Some(format!("{:x}", Sha256::digest(binding)))
}

/// One H1–H3 section. `text` includes the heading line and a trailing newline per source line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnowledgeSection {
    /// Trimmed heading text, without the hashes.
    pub heading: String,
    /// Section body as `parseKnowledgeMd` builds it.
    pub text: String,
}

/// A canonical hit kept beside the memory list.
#[derive(Clone, Debug, PartialEq)]
pub struct CanonicalHit {
    /// Knowledge file mtime carried by Node's canonical wrapper.
    pub mtime_ms: i64,
    /// Section heading.
    pub heading: String,
    /// Exact section text retained for namespace dedupe and later rendering.
    pub text: String,
    /// Cosine against the query vector.
    pub score: f64,
}

/// Split `content` on H1–H3 headings. Frontmatter is removed. Sections whose trimmed
/// text is 30 characters or shorter are dropped.
#[must_use]
pub fn parse_knowledge_md(content: &str) -> Vec<KnowledgeSection> {
    let mut body = content;
    if let Some(rest) = body.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            body = &rest[end + 5..];
        }
    }
    let mut sections = Vec::new();
    let mut current: Option<KnowledgeSection> = None;
    for line in body.split('\n') {
        if let Some(heading) = heading_of(line) {
            push_section(&mut sections, current.take());
            current = Some(KnowledgeSection {
                heading,
                text: format!("{line}\n"),
            });
        } else if let Some(section) = current.as_mut() {
            section.text.push_str(line);
            section.text.push('\n');
        }
    }
    push_section(&mut sections, current);
    sections
}

/// Embed `memory/KNOWLEDGE.md` and return the sections at or above `min_score`.
///
/// Failed passage embeddings are skipped and prevent cache persistence for this call.
/// The query vector is the one `embedQuery` already produced.
pub fn search_canonical(
    workspace: &Path,
    query_vector: &[f32],
    embedder: &dyn EmbeddingProvider,
    min_score: f64,
    top_n: usize,
    persist: bool,
) -> Vec<CanonicalHit> {
    search_canonical_with_cancel(
        workspace,
        query_vector,
        embedder,
        min_score,
        top_n,
        persist,
        &Cancel::never(),
    )
}

pub(crate) fn search_canonical_with_cancel(
    workspace: &Path,
    query_vector: &[f32],
    embedder: &dyn EmbeddingProvider,
    min_score: f64,
    top_n: usize,
    persist: bool,
    cancel: &Cancel,
) -> Vec<CanonicalHit> {
    rank(
        knowledge_chunks(workspace, embedder, persist, cancel),
        query_vector,
        min_score,
        top_n,
    )
}

pub(crate) fn search_private(
    context: &RequestContext,
    query_vector: &[f32],
    embedder: &dyn EmbeddingProvider,
    limits: (f64, usize),
    cancel: &Cancel,
    source: (&Store, &super::tombstone_mask::TombstoneMask, i64),
) -> Vec<CanonicalHit> {
    let (store, mask, now) = source;
    let (min_score, top_n) = limits;
    let document = || {
        let key = private_key(context)?;
        if context.background() || context.chat_kind() != "private" || cancel.is_cancelled() {
            return None;
        }
        let root = TrustedDirectory::open(mask.base())
            .ok()?
            .open_child(PRIVATE_ROOT)
            .ok()?
            .open_child(&key)
            .ok()?;
        let file = root.open_file("KNOWLEDGE.md").ok()?;
        let identity = crate::store::directory::regular_file_identity(&file).ok()?;
        let metadata = file.metadata().ok()?;
        let mtime = i64::try_from(
            metadata
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis(),
        )
        .ok()?;
        let mut text = String::new();
        file.take(PRIVATE_MAX_BYTES as u64 + 1)
            .read_to_string(&mut text)
            .ok()?;
        if text.len() > PRIVATE_MAX_BYTES
            || crate::store::directory::regular_file_identity(&root.open_file("KNOWLEDGE.md").ok()?)
                .ok()?
                != identity
        {
            return None;
        }
        Some((text, mtime))
    };
    let Some((text, mtime)) = document() else {
        return vec![];
    };
    let sections = parse_knowledge_md(&text)
        .into_iter()
        .filter(|section| {
            section
                .heading
                .split_once(" · ")
                .is_some_and(|(_, id)| private_source_live(store, id, context, now, mask))
        })
        .collect::<Vec<_>>();
    rank(
        embed_sections(&sections, mtime, embedder, cancel),
        query_vector,
        min_score,
        top_n,
    )
}

fn private_source_live(
    store: &Store,
    id: &str,
    ctx: &RequestContext,
    now: i64,
    mask: &super::tombstone_mask::TombstoneMask,
) -> bool {
    store.get(id).ok().flatten().is_some_and(|row| {
        row.agent_id == ctx.agent_id.as_str()
            && row.stored_by == ctx.agent_id.as_str()
            && row.owner_user_id == ctx.owner_user_id
            && row.workspace_key == ctx.workspace_key
            && row.workspace_id == ctx.workspace_key
            && row.scope == "agent-private"
            && super::lifecycle::is_recall_entry_live(&row, now, None)
            && mask.masks(&row).is_ok_and(|masked| !masked)
    })
}

fn rank(
    chunks: Vec<Chunk>,
    query_vector: &[f32],
    min_score: f64,
    top_n: usize,
) -> Vec<CanonicalHit> {
    let mut scored = chunks
        .into_iter()
        .map(|chunk| CanonicalHit {
            mtime_ms: chunk.mtime,
            heading: chunk.heading,
            text: chunk.text,
            score: cosine_similarity(query_vector, &chunk.vector),
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.score.total_cmp(&left.score));
    scored.retain(|hit| hit.score >= min_score);
    scored.truncate(top_n);
    scored
}

/// How many chunks the on-disk cache currently holds. `None` when the file is absent.
#[must_use]
pub fn cached_chunk_count(workspace: &Path) -> Option<usize> {
    let text = fs::read_to_string(cache_path(workspace)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    parsed["chunks"].as_array().map(Vec::len)
}

struct Chunk {
    mtime: i64,
    heading: String,
    text: String,
    vector: Vec<f32>,
}

fn knowledge_chunks(
    workspace: &Path,
    embedder: &dyn EmbeddingProvider,
    persist: bool,
    cancel: &Cancel,
) -> Vec<Chunk> {
    let path = workspace.join("memory").join("KNOWLEDGE.md");
    let Some(mtime) = mtime_ms(&path) else {
        return Vec::new();
    };
    if let Some(cached) = read_cache(workspace, mtime) {
        return cached;
    }
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let sections = parse_knowledge_md(&content);
    if sections.is_empty() {
        return Vec::new();
    }
    let chunks = embed_sections(&sections, mtime, embedder, cancel);
    if persist && chunks.len() == sections.len() && !cancel.is_cancelled() {
        write_cache(workspace, mtime, &chunks);
    }
    chunks
}

fn embed_sections(
    sections: &[KnowledgeSection],
    mtime: i64,
    embedder: &dyn EmbeddingProvider,
    cancel: &Cancel,
) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    for section in sections {
        if cancel.is_cancelled() {
            break;
        }
        let text = utf16_slice(&section.text, 0, 4000).to_utf8_lossy();
        let embedded = embedder.embed(&[text], EmbedKind::Passage, cancel);
        if let Ok(vectors) = embedded {
            if let Some(vector) = vectors.into_iter().next() {
                chunks.push(Chunk {
                    mtime,
                    heading: section.heading.clone(),
                    text: section.text.clone(),
                    vector,
                });
            }
        }
    }
    chunks
}

fn read_cache(workspace: &Path, mtime: i64) -> Option<Vec<Chunk>> {
    let text = fs::read_to_string(cache_path(workspace)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    if parsed["identityId"].as_str() != Some(LEGACY_IDENTITY) {
        return None;
    }
    if parsed["mtime"].as_i64() != Some(mtime) {
        return None;
    }
    let stored = parsed["chunks"].as_array()?;
    if stored.is_empty() {
        return None;
    }
    // Pre-T4 caches omit text. Rebuild an incomplete cache as a whole so an
    // upgrade never silently loses canonical sections with an unchanged mtime.
    stored
        .iter()
        .map(|chunk| {
            let heading = chunk["heading"].as_str()?.to_owned();
            let text = chunk["text"].as_str()?.to_owned();
            let vector = chunk["vector"]
                .as_array()?
                .iter()
                .map(|value| value.as_f64().unwrap_or(0.0) as f32)
                .collect();
            Some(Chunk {
                mtime,
                heading,
                text,
                vector,
            })
        })
        .collect()
}

fn write_cache(workspace: &Path, mtime: i64, chunks: &[Chunk]) {
    let directory = workspace.join(".adaptive-learning");
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let payload = json!({
        "mtime": mtime,
        "chunks": chunks.iter().map(|chunk| json!({
            "heading": chunk.heading,
            "text": chunk.text,
            "vector": chunk.vector,
        })).collect::<Vec<_>>(),
        "identityId": LEGACY_IDENTITY,
    });
    let _ = fs::write(cache_path(workspace), payload.to_string());
}

fn cache_path(workspace: &Path) -> PathBuf {
    workspace.join(".adaptive-learning").join(CACHE_NAME)
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(millis).ok()
}

fn heading_of(line: &str) -> Option<String> {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=3).contains(&hashes) {
        return None;
    }
    let rest = line.get(hashes..)?;
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let heading = rest.trim();
    if heading.is_empty() {
        None
    } else {
        Some(heading.to_owned())
    }
}

fn push_section(sections: &mut Vec<KnowledgeSection>, section: Option<KnowledgeSection>) {
    let Some(section) = section else {
        return;
    };
    if section.text.trim().chars().count() > 30 {
        sections.push(section);
    }
}
