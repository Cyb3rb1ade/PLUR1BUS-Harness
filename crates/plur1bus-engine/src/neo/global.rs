//! Caller-bound global candidate search over the real Node metadata index or journal fallback.
use super::{
    acl, index,
    merged::{MetadataReader, Record, RecordKind},
    merged_order::{field, record_id, time, truthy},
    vectors,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    text::{js::JsString, json::TolerantJsonValue as Json},
};
/// Explicit native search inputs; the caller supplies time and an already authorized query vector.
pub struct Options<'a> {
    /// Query vector. An empty vector performs no index or journal read.
    pub query_vector: &'a [f64],
    /// Top result count, capped at 200; zero uses 30.
    pub top_k: usize,
    /// Minimum cosine, inclusive; non-finite uses 0.35, otherwise clamped to 0–1.
    pub min_similarity: f64,
    /// Positive finite recency half-life in days; nonpositive uses 30.
    pub half_life_days: f64,
    /// Visible unique candidate budget, at least 100, at most 50,000; zero uses 20,000.
    pub max_candidates: usize,
    /// IDs already in the ordinary Neo window, excluded before vector loading.
    pub exclude_ids: &'a [JsString],
    /// Caller-supplied finite epoch milliseconds, enabling deterministic replay/tests.
    pub now_ms: f64,
}
/// One authorized candidate with a usable vector and recency-adjusted score.
pub struct Hit {
    /// Original metadata plus its selected vector, kept separate for prompt projection.
    pub record: Record,
    /// Raw cosine similarity.
    pub similarity: f64,
    /// Similarity multiplied by Node's recency term.
    pub score: f64,
    /// Nonnegative age, or four half-lives for an undated record.
    pub age_days: f64,
}
/// Caller-visible diagnostics. Raw file line counts and foreign index cardinality are not exposed.
#[derive(Default)]
pub struct ResultSet {
    /// Sorted top hits.
    pub hits: Vec<Hit>,
    /// Visible latest revisions observed before the candidate budget.
    pub scanned: usize,
    /// Visible unique revisions retained for this search.
    pub unique: usize,
    /// Live, non-stale, non-excluded candidates before vector availability checks.
    pub eligible: usize,
    /// Candidates for which the source supplied a vector (including zero/mismatched sidecars).
    pub with_vector: usize,
    /// Whether a complete-line candidate index was present; otherwise journal fallback was used.
    pub from_index: bool,
}
fn eligible(row: &Json, excluded: &[JsString]) -> bool {
    let Some(id) = record_id(row) else {
        return false;
    };
    let status = field(row, "status").filter(|v| truthy(v));
    let accepted = match status {
        None => true,
        Some(Json::String(s)) => matches!(
            s.to_utf8_lossy().as_str(),
            "candidate" | "active" | "promoted"
        ),
        _ => false,
    };
    !excluded.contains(&id)
        && accepted
        && field(row, "stale") != Some(&Json::Bool(true))
        && field(row, "hardDeleted") != Some(&Json::Bool(true))
}
fn cosine(query: &[f64], vector: &[f64], typed: bool) -> f64 {
    if query.is_empty() || query.len() != vector.len() {
        return f64::NAN;
    }
    let mut query_norm = 0.;
    for value in query {
        query_norm += value * value;
    }
    let (mut dot, mut vector_norm) = (0., 0.);
    for (a, b) in query.iter().zip(vector) {
        dot += a * b;
        vector_norm += b * b;
    }
    if query_norm == 0. || vector_norm == 0. {
        return f64::NAN;
    }
    let denominator = if typed {
        query_norm.sqrt() * vector_norm.sqrt()
    } else {
        (query_norm * vector_norm).sqrt()
    };
    dot / denominator
}
impl MetadataReader {
    /// Search actual persisted metadata and vectors without creating indexes or warming writes.
    /// Each bounded snapshot (64 MiB/50,000 IDs) validates the cached complete prefix;
    /// only appended complete lines are reparsed. Full file reads remain necessary to detect rewrites.
    /// Filter latest revisions by D130 before budgets and counts (RE-D59); sidecars are read only
    /// for eligible visible rows. Caller cancellation is never converted to empty success.
    pub fn search_global(
        &self,
        options: &Options<'_>,
        ctx: &RequestContext,
        cancel: &Cancel,
    ) -> Result<ResultSet, EngineError> {
        cancel.check()?;
        if options.query_vector.is_empty() {
            return Ok(ResultSet::default());
        }
        if !options.now_ms.is_finite()
            || !options.half_life_days.is_finite()
            || options.query_vector.iter().any(|n| !n.is_finite())
        {
            return Err(StoreError::InvalidInput.into());
        }
        let maximum = if options.max_candidates == 0 {
            20_000
        } else {
            options.max_candidates.max(100)
        };
        if maximum > index::MAX_IDS {
            return Err(StoreError::InvalidInput.into());
        }
        let top_k = if options.top_k == 0 {
            30
        } else {
            options.top_k.min(200)
        };
        let minimum = if options.min_similarity.is_finite() {
            options.min_similarity.clamp(0., 1.)
        } else {
            0.35
        };
        let half_life = if options.half_life_days > 0. {
            options.half_life_days
        } else {
            30.
        };
        let indexed = index::read(self, cancel)?;
        let from_index = indexed.is_some();
        let mut window = match indexed {
            Some(index) => index,
            None => self.window(RecordKind::Candidates, maximum, ctx)?,
        };
        window.rows.retain(|r| acl::visible(&r.metadata, Some(ctx)));
        let scanned = window.rows.len();
        window.rows.retain(|r| record_id(&r.metadata).is_some());
        if from_index && window.rows.len() > maximum {
            window.rows.sort_by(|a, b| {
                time(&b.metadata, true)
                    .partial_cmp(&time(&a.metadata, true))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            window.rows.truncate(maximum);
        }
        let unique = window.rows.len();
        window
            .rows
            .retain(|r| eligible(&r.metadata, options.exclude_ids));
        let typed: Vec<_> = window
            .rows
            .iter()
            .map(|r| from_index || field(&r.metadata, "embedding").is_none())
            .collect();
        let mut result = ResultSet {
            scanned,
            unique,
            eligible: window.rows.len(),
            from_index,
            ..ResultSet::default()
        };
        cancel.check()?;
        let records = vectors::attach(
            RecordKind::Candidates,
            window.rows,
            window.canonical.as_ref(),
            window.legacy.as_ref(),
        )?;
        for (record, typed) in records.into_iter().zip(typed) {
            cancel.check()?;
            let Some(vector) = &record.embedding else {
                continue;
            };
            if !typed && vector.len() != options.query_vector.len() {
                continue;
            }
            result.with_vector += 1;
            let similarity = cosine(options.query_vector, vector, typed);
            if !similarity.is_finite() || similarity < minimum {
                continue;
            }
            let created = time(&record.metadata, false);
            let age_days = if created.is_finite() {
                ((options.now_ms - created) / 86_400_000.).max(0.)
            } else {
                half_life * 4.
            };
            let recency = 0.5_f64.powf(age_days / half_life);
            result.hits.push(Hit {
                record,
                similarity,
                score: similarity * (0.85 + 0.15 * recency),
                age_days,
            });
        }
        result.hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(b.similarity.total_cmp(&a.similarity))
        });
        result.hits.truncate(top_k);
        cancel.check()?;
        self.root.assert_unchanged()?;
        Ok(result)
    }
}
