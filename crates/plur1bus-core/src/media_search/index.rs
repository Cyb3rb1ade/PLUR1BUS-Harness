//! Bounded in-memory reference index and deletion-aware publication.

use super::{Caller, Error, Kind, Scope};
use crate::js::{compare_utf16, js_trim, utf16_len};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Timed segment returned by the trusted encoding port.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    /// Segment number.
    pub idx: u32,
    /// Offset at start.
    pub start_ms: u64,
    /// Offset at end.
    pub end_ms: u64,
}
/// Output of the trusted media encoding port.
#[derive(Debug, Deserialize)]
pub struct Encoded {
    /// Embedding vectors in segment order.
    pub vectors: Vec<Vec<f64>>,
    /// Optional timed segments, indexed in vector order.
    pub segments: Vec<Segment>,
}
/// Recorded result of an index attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Successful result.
    Indexed,
    /// Work replaced or removed while encoding.
    Pending,
    /// Unsupported modality.
    UnsupportedKind,
    /// Encoder reported failure.
    Failed,
}
/// Wire shape for an index result.
#[derive(Debug, Serialize)]
pub struct Outcome {
    /// Number of timed segments.
    pub segments: usize,
    /// Current item state.
    pub state: State,
}
/// Caption evidence returned by the scoped ranking port.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionHit {
    /// Media identifier.
    pub media_id: String,
    /// Caption memory identifier if known.
    pub caption_memory_id: Option<String>,
}
/// Scoped read-only query port.
pub trait Ranker {
    /// Fixed media-space text encoding.
    fn embed_text(&self, text: &str, scope: &Scope) -> Result<Vec<f64>, Error>;
    /// Ranked caption keys for the same scoped search.
    fn captions(&self, text: &str, limit: usize, scope: &Scope) -> Result<Vec<CaptionHit>, Error>;
}
/// Search input. Exactly one of text or a known medium is required.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    /// Text to encode.
    pub text: Option<String>,
    /// Use vectors of a visible medium.
    pub like_media_id: Option<String>,
    /// Optional modality filter.
    pub kinds: Option<Vec<Kind>>,
    /// Maximum number of results.
    pub limit: usize,
    /// Minimum cosine score.
    pub min_score: Option<f64>,
    /// Combine caption and vector ranks.
    #[serde(default)]
    pub fuse_captions: bool,
}
/// Public search result with a rank or cosine score.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// Media identifier.
    pub media_id: String,
    /// Media kind.
    pub kind: Kind,
    /// Ranking score.
    pub score: f64,
    /// Best timed segment when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment: Option<Segment>,
    /// Scoped caption identifier when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption_memory_id: Option<String>,
}
/// Per-scope count snapshot.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Counts {
    /// Successfully indexed.
    pub indexed: usize,
    /// Waiting.
    pub pending: usize,
    /// Encoder failed.
    pub failed: usize,
    /// Unsupported modality.
    pub unsupported: usize,
}
/// Unique save authorization for one in-flight index operation.
#[derive(Debug)]
pub struct Ticket {
    id: String,
    revision: u64,
}

struct Pending {
    scope: Scope,
    user_id: String,
    revision: u64,
    kind: Kind,
}

struct Item {
    scope: Scope,
    kind: Kind,
    state: State,
    encoded: Encoded,
    caption: Option<String>,
}

/// Scoped, bounded index.
pub struct Index {
    dim: usize,
    kinds: Option<Vec<Kind>>,
    revision: u64,
    entries: BTreeMap<String, Item>,
    running: BTreeMap<String, Pending>,
    vector_count: usize,
}

const MAX_ENTRIES: usize = 10_000;
const MAX_IN_FLIGHT: usize = 64;
const MAX_SEGMENTS: usize = 2_000;
const MAX_VALUES: usize = 8_000_000;
const MAX_DIM: usize = 8_192;
const MAX_TEXT: usize = 4_096;
const MAX_CAPTION: usize = 10_000;
const MAX_LIMIT: usize = 200;
const MAX_SEARCH_OPERATIONS: usize = 25_000_000;

fn invalid(reason: &'static str) -> Error {
    Error::new("E_INVALID_PARAMS", reason)
}
fn missing() -> Error {
    Error::new("E_NOT_FOUND", "media-not-found")
}
fn dimension() -> Error {
    Error::new("E_MEDIA_DIMENSION", "media-vector-dimension")
}
fn unavailable(reason: &'static str) -> Error {
    Error::new("E_MEDIA_UNAVAILABLE", reason)
}

impl Index {
    /// Bind a fixed embedding dimension and optional modalities.
    pub fn new(dim: usize, kinds: Option<Vec<Kind>>) -> Result<Self, Error> {
        if !(1..=MAX_DIM).contains(&dim) {
            return Err(dimension());
        }
        Ok(Self {
            dim,
            kinds,
            revision: 0,
            entries: BTreeMap::new(),
            running: BTreeMap::new(),
            vector_count: 0,
        })
    }

    /// Admit one index operation for an unused or exactly owned identifier.
    pub fn begin(&mut self, caller: &Caller<'_>, id: &str, kind: Kind) -> Result<Ticket, Error> {
        caller.authorize("media.write")?;
        if !valid_id(id) {
            return Err(invalid("media-id"));
        }
        self.owned(caller.scope, id)?;
        if self.running.contains_key(id) {
            return Err(unavailable("index-in-flight"));
        }
        if self.running.len() >= MAX_IN_FLIGHT
            || !self.entries.contains_key(id)
                && self.entries.len() + self.running.len() >= MAX_ENTRIES
        {
            return Err(unavailable("index-capacity"));
        }
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| unavailable("index-revision"))?;
        self.running.insert(
            id.into(),
            Pending {
                scope: caller.scope.clone(),
                user_id: caller.who.user_id.clone(),
                revision: self.revision,
                kind,
            },
        );
        Ok(Ticket {
            id: id.into(),
            revision: self.revision,
        })
    }

    /// Whether the encoding port needs to do any work for this modality.
    pub fn supports(&self, kind: Kind) -> bool {
        self.kinds
            .as_ref()
            .is_none_or(|kinds| kinds.contains(&kind))
    }

    /// Record an outcome only while the ticket is current.
    pub fn finish(
        &mut self,
        caller: &Caller<'_>,
        ticket: Ticket,
        encoding: Result<Encoded, Error>,
        caption: Option<String>,
    ) -> Result<Outcome, Error> {
        let checked = caller.authorize("media.write");
        let Some(pending) = self
            .running
            .get(&ticket.id)
            .filter(|row| row.revision == ticket.revision)
        else {
            checked?;
            return Ok(Outcome {
                segments: 0,
                state: State::Pending,
            });
        };
        if &pending.scope != caller.scope || pending.user_id != caller.who.user_id {
            return Err(missing());
        }
        let kind = pending.kind;
        self.running.remove(&ticket.id);
        checked?;
        if caption
            .as_ref()
            .is_some_and(|text| utf16_len(text) > MAX_CAPTION)
        {
            return Err(invalid("media-caption"));
        }
        let (state, encoded) = self.result(kind, encoding)?;
        let previous = self
            .entries
            .get(&ticket.id)
            .map_or(0, |item| item.encoded.vectors.len());
        let count = self.vector_count - previous + encoded.vectors.len();
        if count > MAX_VALUES / self.dim {
            return Err(unavailable("index-capacity"));
        }
        let outcome = Outcome {
            segments: encoded.segments.len(),
            state,
        };
        self.entries.insert(
            ticket.id,
            Item {
                scope: caller.scope.clone(),
                kind,
                state,
                encoded,
                caption: (state == State::Indexed).then_some(caption).flatten(),
            },
        );
        self.vector_count = count;
        Ok(outcome)
    }

    /// Release work that the trusted encoder could not complete.
    pub fn cancel(&mut self, ticket: &Ticket) {
        if self
            .running
            .get(&ticket.id)
            .is_some_and(|row| row.revision == ticket.revision)
        {
            self.running.remove(&ticket.id);
        }
    }

    /// Forget a medium and invalidate a pending save.
    pub fn remove(&mut self, caller: &Caller<'_>, id: &str) -> Result<(), Error> {
        caller.authorize("media.write")?;
        self.owned(caller.scope, id)?;
        self.running.remove(id);
        if let Some(previous) = self.entries.remove(id) {
            self.vector_count -= previous.encoded.vectors.len();
        }
        Ok(())
    }

    /// Update a caption after resolving ownership and authorization.
    pub fn set_caption(
        &mut self,
        caller: &Caller<'_>,
        id: &str,
        caption: String,
    ) -> Result<(), Error> {
        caller.authorize("media.caption.write")?;
        if utf16_len(&caption) > MAX_CAPTION {
            return Err(invalid("media-caption"));
        }
        let item = self
            .entries
            .get_mut(id)
            .filter(|row| &row.scope == caller.scope)
            .ok_or_else(missing)?;
        item.caption = Some(caption);
        Ok(())
    }

    /// Scoped reference search with optional caption fusion.
    pub fn search(
        &self,
        caller: &Caller<'_>,
        query: &Query,
        port: &dyn Ranker,
    ) -> Result<Vec<Hit>, Error> {
        caller.authorize("media.index.read")?;
        query.validate()?;
        let mut text_vector = Vec::new();
        let (queries, caption_text) = if let Some(text) = &query.text {
            let query = port.embed_text(text, caller.scope)?;
            self.validate_vector(&query)?;
            text_vector.push(query);
            (text_vector.as_slice(), Some(text.as_str()))
        } else {
            let item = query
                .like_media_id
                .as_ref()
                .and_then(|id| self.entries.get(id))
                .filter(|item| caller.scope.sees(&item.scope))
                .ok_or_else(missing)?;
            (item.encoded.vectors.as_slice(), item.caption.as_deref())
        };
        caller.authorize("media.index.read")?;
        let visible = |id: &str, item: &Item| {
            query.like_media_id.as_deref() != Some(id)
                && caller.scope.sees(&item.scope)
                && query
                    .kinds
                    .as_ref()
                    .is_none_or(|kinds| kinds.contains(&item.kind))
        };
        let comparable = self
            .entries
            .iter()
            .filter(|(id, item)| item.state == State::Indexed && visible(id, item))
            .map(|(_, item)| item.encoded.vectors.len())
            .sum::<usize>();
        if queries
            .len()
            .saturating_mul(comparable)
            .saturating_mul(self.dim)
            > MAX_SEARCH_OPERATIONS
        {
            return Err(unavailable("media-search-capacity"));
        }
        let mut vector_hits: Vec<_> = self
            .entries
            .iter()
            .filter(|(id, item)| item.state == State::Indexed && visible(id, item))
            .filter_map(|(id, item)| item.best(id, queries, query.min_score))
            .collect();
        sort_hits(&mut vector_hits);
        if let Some(text) = caption_text.filter(|_| query.fuse_captions) {
            let limit = query.limit.max(50);
            let caps = port.captions(text, limit, caller.scope)?;
            caller.authorize("media.index.read")?;
            vector_hits = self.fuse(vector_hits, caps.into_iter().take(limit), visible);
        }
        vector_hits.truncate(query.limit);
        Ok(vector_hits)
    }

    /// Return only the counts in the requested visible partition.
    pub fn counts(&self, caller: &Caller<'_>) -> Result<Counts, Error> {
        caller.authorize("media.index.read")?;
        let mut counts = Counts::default();
        for item in self
            .entries
            .values()
            .filter(|item| caller.scope.sees(&item.scope))
        {
            match item.state {
                State::Indexed => counts.indexed += 1,
                State::Pending => counts.pending += 1,
                State::UnsupportedKind => counts.unsupported += 1,
                State::Failed => counts.failed += 1,
            }
        }
        counts.pending += self
            .running
            .values()
            .filter(|row| &row.scope == caller.scope)
            .count();
        Ok(counts)
    }

    fn result(
        &self,
        kind: Kind,
        encoding: Result<Encoded, Error>,
    ) -> Result<(State, Encoded), Error> {
        let empty = Encoded {
            vectors: Vec::new(),
            segments: Vec::new(),
        };
        if !self.supports(kind) {
            return Ok((State::UnsupportedKind, empty));
        }
        let encoded = match encoding {
            Ok(encoded) => encoded,
            Err(error) if error.code == "E_MEDIA_UNSUPPORTED_KIND" => {
                return Ok((State::UnsupportedKind, empty))
            }
            Err(_) => return Ok((State::Failed, empty)),
        };
        if encoded.vectors.len() > MAX_SEGMENTS
            || encoded.segments.len() > encoded.vectors.len()
            || encoded
                .segments
                .iter()
                .any(|segment| segment.end_ms < segment.start_ms)
        {
            return Err(invalid("media-segments"));
        }
        for vector in &encoded.vectors {
            self.validate_vector(vector)?;
        }
        Ok((State::Indexed, encoded))
    }

    fn validate_vector(&self, vector: &[f64]) -> Result<(), Error> {
        if vector.len() != self.dim || vector.iter().any(|n| !n.is_finite() || n.abs() > 1e60) {
            return Err(dimension());
        }
        Ok(())
    }

    fn owned(&self, scope: &Scope, id: &str) -> Result<(), Error> {
        if self.entries.get(id).is_some_and(|row| &row.scope != scope)
            || self.running.get(id).is_some_and(|row| &row.scope != scope)
        {
            return Err(missing());
        }
        Ok(())
    }

    fn fuse(
        &self,
        vector: Vec<Hit>,
        caption: impl Iterator<Item = CaptionHit>,
        visible: impl Fn(&str, &Item) -> bool,
    ) -> Vec<Hit> {
        let mut seen = BTreeSet::new();
        let mut fused: BTreeMap<_, _> = vector
            .into_iter()
            .enumerate()
            .map(|(i, mut hit)| {
                hit.score = reciprocal(i + 1);
                (hit.media_id.clone(), hit)
            })
            .collect();
        for hit in caption {
            let Some(item) = self
                .entries
                .get(&hit.media_id)
                .filter(|item| visible(&hit.media_id, item))
            else {
                continue;
            };
            if !seen.insert(hit.media_id.clone()) {
                continue;
            }
            let score = reciprocal(seen.len());
            let id = hit.media_id;
            let entry = fused.entry(id.clone()).or_insert(Hit {
                media_id: id,
                kind: item.kind,
                score: 0.0,
                segment: None,
                caption_memory_id: None,
            });
            entry.score += score;
            entry.caption_memory_id = hit.caption_memory_id.filter(|id| valid_id(id));
        }
        let mut hits: Vec<_> = fused.into_values().collect();
        sort_hits(&mut hits);
        hits
    }
}

impl Item {
    fn best(&self, id: &str, queries: &[Vec<f64>], floor: Option<f64>) -> Option<Hit> {
        let mut score = f64::NEG_INFINITY;
        let mut best = 0;
        for (n, vector) in self.encoded.vectors.iter().enumerate() {
            for query in queries {
                let candidate = cosine(query, vector);
                if candidate > score {
                    score = candidate;
                    best = n;
                }
            }
        }
        if !score.is_finite() || floor.is_some_and(|floor| score < floor) {
            return None;
        }
        Some(Hit {
            media_id: id.into(),
            kind: self.kind,
            score,
            caption_memory_id: None,
            segment: self
                .encoded
                .segments
                .get(best)
                .filter(|_| self.kind != Kind::Image)
                .cloned(),
        })
    }
}

impl Query {
    fn validate(&self) -> Result<(), Error> {
        if self.text.is_some() == self.like_media_id.is_some() {
            return Err(invalid("media-query-selector"));
        }
        if !(1..=MAX_LIMIT).contains(&self.limit)
            || self
                .text
                .as_ref()
                .is_some_and(|text| js_trim(text).is_empty() || utf16_len(text) > MAX_TEXT)
            || self.like_media_id.as_ref().is_some_and(|id| !valid_id(id))
            || self.min_score.is_some_and(|score| !score.is_finite())
        {
            return Err(invalid("media-query-bound"));
        }
        Ok(())
    }
}

fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for (a, b) in a.iter().zip(b) {
        dot += a * b;
        na += a * a;
        nb += b * b;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    let product = na * nb;
    if product == 0.0 {
        return (dot / na.sqrt()) / nb.sqrt();
    }
    dot / product.sqrt()
}

fn reciprocal(rank: usize) -> f64 {
    1.0 / (60 + rank) as f64
}
fn sort_hits(hits: &mut [Hit]) {
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| compare_utf16(&a.media_id, &b.media_id))
    });
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "index_vectors.rs"]
mod vectors;
