//! Canonical sections from `memory/KNOWLEDGE.md`.
//!
//! The cache is written after the embed loop even when every section threw.
//! A cache whose `chunks` array is empty is not reused, so the next recall reads
//! the file again (CP-5.7). The pinned recorder leaves `embeddings.identity`
//! unset, so the cache identity is `"legacy"`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use crate::embedding::{Cancel, EmbedKind, EmbeddingProvider};
use crate::text::js::utf16_slice;

use super::hash_embed::cosine_similarity;

const CACHE_NAME: &str = "knowledge-cache.json";
const LEGACY_IDENTITY: &str = "legacy";

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
    /// Section heading.
    pub heading: String,
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
/// Passage embeddings that throw are skipped. The cache file is still written when
/// `persist` is set. The query vector is the one `embedQuery` already produced.
pub fn search_canonical(
    workspace: &Path,
    query_vector: &[f32],
    embedder: &dyn EmbeddingProvider,
    min_score: f64,
    top_n: usize,
    persist: bool,
) -> Vec<CanonicalHit> {
    let chunks = knowledge_chunks(workspace, embedder, persist);
    let mut scored = chunks
        .into_iter()
        .map(|chunk| CanonicalHit {
            heading: chunk.heading,
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
    heading: String,
    vector: Vec<f32>,
}

fn knowledge_chunks(
    workspace: &Path,
    embedder: &dyn EmbeddingProvider,
    persist: bool,
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
    let mut chunks = Vec::new();
    for section in &sections {
        let text = utf16_slice(&section.text, 0, 4000).to_utf8_lossy();
        let embedded = embedder.embed(&[text], EmbedKind::Passage, &Cancel::never());
        if let Ok(vectors) = embedded {
            if let Some(vector) = vectors.into_iter().next() {
                chunks.push(Chunk {
                    heading: section.heading.clone(),
                    vector,
                });
            }
        }
    }
    if persist {
        write_cache(workspace, mtime, &chunks);
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
    Some(
        stored
            .iter()
            .filter_map(|chunk| {
                let heading = chunk["heading"].as_str()?.to_owned();
                let vector = chunk["vector"]
                    .as_array()?
                    .iter()
                    .map(|value| value.as_f64().unwrap_or(0.0) as f32)
                    .collect();
                Some(Chunk { heading, vector })
            })
            .collect(),
    )
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
