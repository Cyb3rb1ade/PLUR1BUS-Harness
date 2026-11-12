//! Actual read-side NeoPrelude composition: trusted files, bounded query embedding, global
//! candidate search, authorized lanes and prompt evidence. No hook/injection/checkpoint writer.
use super::{
    format, global,
    merged::{MetadataReader, RecordKind},
    merged_order::record_id,
    routing,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, CancelReason, EngineError, StoreError},
    embedding::{batch::validate_vectors, EmbedError, EmbedKind, EmbeddingProvider},
    recall::{
        neo_prelude::{NeoPrelude, NeoRequest},
        render::RenderError,
    },
    text::js::JsString,
};
use std::time::{Duration, Instant};
/// Explicit global-search configuration. None in Config means the owner's feature is disabled.
#[derive(Clone, Debug)]
pub struct GlobalConfig {
    /// Top candidate count before lane routing.
    pub top_k: usize,
    /// Inclusive cosine threshold.
    pub min_similarity: f64,
    /// Recency half-life in days.
    pub half_life_days: f64,
    /// Maximum authorized unique candidates.
    pub max_candidates: usize,
    /// Cross-block dedupe threshold, clamped to 0–1 as in the host configuration.
    pub dedupe_threshold: f64,
}
/// Request-bound configuration; there is deliberately no implicit global-disabled default.
#[derive(Clone, Debug)]
pub struct Config {
    /// Query embedding soft budget, narrowed by caller cancellation/deadline.
    pub embedding_timeout: Duration,
    /// Host request-clock epoch milliseconds for recency, never a fixture clock inside production.
    pub now_ms: f64,
    /// Explicit enabled settings or explicit feature disablement.
    pub global: Option<GlobalConfig>,
    /// Prompt budgets and the caller-owned optional injection key.
    pub format: format::Options,
}
/// Content-free query-embedding outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EmbeddingOutcome {
    /// Prompt below the five UTF-16-unit gate.
    Skipped,
    /// One validated query vector was returned.
    Available,
    /// Provider unavailable or invalid vector response; lexical routing continues.
    Unavailable,
    /// The feature's soft budget expired while the parent request remained active.
    TimedOut,
}
/// Native observations retained without provider bodies or raw index cardinalities.
pub struct Outcome {
    /// Internal lossless text; ContextBlock owns the existing visible Unicode boundary.
    pub text: JsString,
    /// Query vector availability.
    pub embedding: EmbeddingOutcome,
    /// A real global index/fallback search was invoked.
    pub global_attempted: bool,
    /// A non-cancellation global failure left the successful ordinary window available.
    pub global_failed: bool,
    /// Number of authorized global hits, before cross-block dedupe.
    pub global_hits: usize,
}
/// Request-local implementation of the already consumed NeoPrelude trait.
/// Bind the actual authenticated context and selected raw EmbeddingProvider at construction.
/// This uses the provider port, not the persistent-cache EmbeddingService facade: warm reads
/// cannot access its SQLite cache. Provider implementations must honor the supplied Cancel.
/// The process facade still owns provider construction, workspace policy and injection effects.
pub struct NativePrelude<'a> {
    reader: &'a MetadataReader,
    context: &'a RequestContext,
    provider: &'a dyn EmbeddingProvider,
    config: Config,
    cancel: Cancel,
    width: usize,
}
impl<'a> NativePrelude<'a> {
    /// Validate native settings and bind real request dependencies; does not read files or infer.
    pub fn new(
        reader: &'a MetadataReader,
        context: &'a RequestContext,
        provider: &'a dyn EmbeddingProvider,
        config: Config,
        cancel: Cancel,
    ) -> Result<Self, StoreError> {
        let width = provider
            .identity()
            .dimension
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0)
            .ok_or(StoreError::InvalidInput)?;
        if !config.now_ms.is_finite()
            || config.embedding_timeout.is_zero()
            || Instant::now()
                .checked_add(config.embedding_timeout)
                .is_none()
            || config
                .global
                .as_ref()
                .is_some_and(|g| g.max_candidates > 50_000 || !g.half_life_days.is_finite())
        {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            reader,
            context,
            provider,
            config,
            cancel,
            width,
        })
    }
    fn query(&self, prompt: &str) -> Result<(Option<Vec<f64>>, EmbeddingOutcome), EngineError> {
        self.cancel.check()?;
        let at = Instant::now()
            .checked_add(self.config.embedding_timeout)
            .ok_or(StoreError::InvalidInput)?;
        let limited = self.cancel.limited_to(at);
        let result = self
            .provider
            .embed(&[prompt.to_owned()], EmbedKind::Query, &limited);
        self.cancel.check()?;
        // A successful reply after the feature deadline does not extend the soft budget.
        if limited.is_cancelled() {
            return Ok((None, EmbeddingOutcome::TimedOut));
        }
        match result {
            Ok(mut vectors) if validate_vectors(&vectors, 1, self.width).is_ok() => Ok((
                vectors
                    .pop()
                    .map(|v| v.into_iter().map(f64::from).collect()),
                EmbeddingOutcome::Available,
            )),
            Err(EmbedError::Cancelled(reason)) if reason.reason == CancelReason::Caller => {
                Err(reason.into())
            }
            Err(EmbedError::Cancelled(_)) => Ok((None, EmbeddingOutcome::TimedOut)),
            _ => Ok((None, EmbeddingOutcome::Unavailable)),
        }
    }
    /// Run the actual window/global pipeline. Warm mode performs the same reads/routing but
    /// returns no injection text and owns no persistent counters, marks or maintenance jobs.
    pub fn read_detailed(&self, request: &NeoRequest<'_>) -> Result<Outcome, EngineError> {
        self.cancel.check()?;
        let mut outcome = Outcome {
            text: JsString::default(),
            embedding: EmbeddingOutcome::Skipped,
            global_attempted: false,
            global_failed: false,
            global_hits: 0,
        };
        if request.prompt.encode_utf16().count() < 5 {
            return Ok(outcome);
        }
        let mut items = self
            .reader
            .read_records(RecordKind::Candidates, 500, self.context)?;
        self.cancel.check()?;
        items.extend(
            self.reader
                .read_records(RecordKind::Behavior, 200, self.context)?,
        );
        self.cancel.check()?;
        let (query, embedding) = self.query(request.prompt)?;
        outcome.embedding = embedding;
        let mut global_ids = Vec::new();
        if let (Some(config), Some(query)) = (&self.config.global, query.as_deref()) {
            let excluded: Vec<_> = items
                .iter()
                .filter_map(|record| record_id(&record.metadata))
                .collect();
            outcome.global_attempted = true;
            let result = self.reader.search_global(
                &global::Options {
                    query_vector: query,
                    top_k: config.top_k,
                    min_similarity: config.min_similarity,
                    half_life_days: config.half_life_days,
                    max_candidates: config.max_candidates,
                    exclude_ids: &excluded,
                    now_ms: self.config.now_ms,
                },
                self.context,
                &self.cancel,
            );
            match result {
                Ok(result) => {
                    outcome.global_hits = result.hits.len();
                    for hit in result.hits {
                        if let Some(id) = record_id(&hit.record.metadata) {
                            global_ids.push(id);
                        }
                        items.push(hit.record);
                    }
                }
                Err(EngineError::Cancelled(error)) => return Err(error.into()),
                Err(_) => outcome.global_failed = true,
            }
        }
        self.cancel.check()?;
        let mut lanes = routing::route(
            &items,
            request.prompt,
            self.context,
            &routing::Options {
                max_per_lane: 2,
                min_score: 0.08,
                query_vector: query.as_deref(),
            },
        );
        self.cancel.check()?;
        if request.warm_only {
            return Ok(outcome);
        }
        if !global_ids.is_empty() && !request.exclude_texts.is_empty() {
            let texts: Vec<_> = request
                .exclude_texts
                .iter()
                .map(JsString::to_utf8_lossy)
                .collect();
            let threshold = self.config.global.as_ref().map_or(0.8, |g| {
                if g.dedupe_threshold.is_finite() {
                    g.dedupe_threshold.clamp(0., 1.)
                } else {
                    0.8
                }
            });
            routing::dedupe_lossless(&mut lanes, &items, &texts, Some(&global_ids), threshold);
        }
        outcome.text = format::format(&items, &lanes, self.context, &self.config.format)?;
        self.cancel.check()?;
        Ok(outcome)
    }
}
impl NeoPrelude for NativePrelude<'_> {
    fn read(&self, request: &NeoRequest<'_>) -> Result<JsString, RenderError> {
        self.read_detailed(request)
            .map(|out| out.text)
            .map_err(|error| match error {
                EngineError::Cancelled(_) => RenderError::Aborted,
                _ => RenderError::Unavailable("neo prelude unavailable".into()),
            })
    }
}
