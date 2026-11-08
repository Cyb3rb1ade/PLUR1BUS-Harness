//! Request-local cooperative deadlines and safe partial-return classification.

use std::time::Instant;

use super::{budget::RecallBudget, timing::PhaseTimer};
use crate::contract::{Cancel, CancelReason};
use crate::embedding::{EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity};
use crate::embedding::{RerankError, RerankHit, Reranker};

/// Why optional recall work stopped. Store errors never become this classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stop {
    /// A safe fast path, not a failed capability.
    SoftBudget,
    /// The effective monotonic request deadline expired.
    Timeout,
    /// Explicit caller cancellation takes precedence over expiry.
    Aborted,
}

/// Bind legacy stage helpers to the request token; borrowed providers cannot escape recall.
pub(crate) struct BoundEmbedder<'a> {
    pub provider: &'a dyn EmbeddingProvider,
    pub cancel: &'a Cancel,
}

impl EmbeddingProvider for BoundEmbedder<'_> {
    fn identity(&self) -> &VectorSpaceIdentity {
        self.provider.identity()
    }

    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.cancel.check().map_err(EmbedError::Cancelled)?;
        let result = self.provider.embed(texts, kind, self.cancel);
        self.cancel.check().map_err(EmbedError::Cancelled)?;
        result
    }
}

/// The optional filter can consume the remaining deadline; recheck before reranker dispatch.
pub(crate) struct BoundReranker<'a> {
    pub provider: &'a dyn Reranker,
    pub cancel: &'a Cancel,
}
impl Reranker for BoundReranker<'_> {
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        _: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        self.cancel.check().map_err(RerankError::Cancelled)?;
        let result = self.provider.rerank(query, docs, top_n, self.cancel);
        self.cancel.check().map_err(RerankError::Cancelled)?;
        result
    }
    fn empty_result_is_valid(&self) -> bool {
        self.provider.empty_result_is_valid()
    }
}

/// One pipeline clock and the shared request cancellation flag.
/// Create separate clocks per table, anchored at the same request entry instant.
pub struct RecallControl {
    /// Passed to every embedding and reranking operation.
    pub cancel: Cancel,
    /// Bounded content-free phase observations.
    pub timer: PhaseTimer,
    stop: Option<Stop>,
    pub(crate) soft_fallback: bool,
    pub(crate) trace_policy: Option<std::sync::Arc<super::trace::TracePolicy>>,
}

impl RecallControl {
    /// Start a child clock without extending the caller's deadline.
    #[must_use]
    pub fn new(started: Instant, budget: RecallBudget, caller: &Cancel) -> Self {
        Self {
            cancel: budget.cancellation(started, caller),
            timer: PhaseTimer::new(started, budget.soft_ms, budget.hard_ms),
            stop: None,
            soft_fallback: true,
            trace_policy: None,
        }
    }

    /// Legacy stage fixtures run the same implementation without an imposed deadline.
    pub(crate) fn unbounded() -> Self {
        Self {
            cancel: Cancel::never(),
            timer: PhaseTimer::new(Instant::now(), f64::INFINITY, f64::INFINITY),
            stop: None,
            soft_fallback: true,
            trace_policy: None,
        }
    }

    /// Check a stage boundary. A caller abort always supersedes a previous soft stop.
    pub fn checkpoint(&mut self, allow_soft: bool) -> bool {
        if let Err(cancelled) = self.cancel.check() {
            self.stop = Some(match cancelled.reason {
                CancelReason::Caller => Stop::Aborted,
                CancelReason::Deadline => Stop::Timeout,
            });
        } else if self.stop.is_none()
            && self.soft_fallback
            && allow_soft
            && self.timer.soft_exceeded()
        {
            self.stop = Some(Stop::SoftBudget);
        }
        self.stop.is_none()
    }

    /// Last boundary classification; error text from providers is never retained.
    #[must_use]
    pub fn stopped(&self) -> Option<Stop> {
        self.stop
    }
}
