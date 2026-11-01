//! Coalesce the original query by identity for one namespace recall, including failures.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::namespace_trace::TraceLimits;
use crate::embedding::identity::try_identity_id;
use crate::embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity};

type QueryResult = Result<Vec<Vec<f32>>, EmbedError>;
type QueryFlight = Arc<OnceLock<QueryResult>>;

/// Request-local query results. Never reuse this object between merged recalls.
/// Passages and queries other than the original text go directly to the provider.
pub struct RequestQueries {
    query: String,
    multi_identity: bool,
    trace_limits: Option<TraceLimits>,
    flights: Mutex<HashMap<String, QueryFlight>>,
}

impl RequestQueries {
    /// The sole query text for child stages, reranking and the global ledger hash.
    #[must_use]
    pub fn query(&self) -> &str {
        &self.query
    }
    /// Start an empty scope before spawning the table workers.
    #[must_use]
    pub fn new(query: &str) -> Self {
        Self {
            query: query.to_owned(),
            multi_identity: false,
            trace_limits: Some(TraceLimits::default()),
            flights: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn for_identity_count(
        query: &str,
        count: usize,
        limits: Option<TraceLimits>,
    ) -> Self {
        Self {
            multi_identity: count > 1,
            trace_limits: limits,
            ..Self::new(query)
        }
    }

    pub(crate) fn trace_limits(&self) -> Option<TraceLimits> {
        self.trace_limits
    }

    /// Independent vector spaces require fusion and a single global reranker.
    #[must_use]
    pub fn is_multi_identity(&self) -> bool {
        self.multi_identity
    }

    pub(crate) fn wrap<'a>(
        &'a self,
        provider: &'a dyn EmbeddingProvider,
    ) -> impl EmbeddingProvider + 'a {
        RequestEmbedder {
            queries: self,
            provider,
        }
    }
}

struct RequestEmbedder<'a> {
    queries: &'a RequestQueries,
    provider: &'a dyn EmbeddingProvider,
}

impl EmbeddingProvider for RequestEmbedder<'_> {
    fn identity(&self) -> &VectorSpaceIdentity {
        self.provider.identity()
    }

    fn embed(&self, texts: &[String], kind: EmbedKind, cancel: &Cancel) -> QueryResult {
        if kind != EmbedKind::Query || texts.len() != 1 || texts[0] != self.queries.query {
            return self.provider.embed(texts, kind, cancel);
        }
        cancel.check().map_err(EmbedError::Cancelled)?;
        let identity =
            try_identity_id(self.provider.identity()).map_err(|_| EmbedError::InvalidVector)?;
        let flight = self
            .queries
            .flights
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(identity)
            .or_default()
            .clone();
        // The map lock is released before provider code runs. OnceLock also releases
        // waiters after an initializer panic, so the outer settle-all can finish.
        let vectors = flight
            .get_or_init(|| self.provider.embed(texts, kind, cancel))
            .clone()?;
        if self.queries.multi_identity {
            let expected = self
                .provider
                .identity()
                .dimension
                .as_u64()
                .and_then(|width| usize::try_from(width).ok())
                .ok_or(EmbedError::InvalidVector)?;
            let vector = vectors.first().ok_or(EmbedError::InvalidVector)?;
            if vectors.len() != 1 || !vector.iter().all(|value| value.is_finite()) {
                return Err(EmbedError::InvalidVector);
            }
            if vector.len() != expected {
                return Err(EmbedError::DimensionMismatch {
                    expected,
                    actual: vector.len(),
                });
            }
        }
        Ok(vectors)
    }

    fn invalidate_egress(&self) {
        self.provider.invalidate_egress();
    }
}
