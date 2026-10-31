//! Coalesce the original query by identity for one namespace recall, including failures.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::embedding::identity::try_identity_id;
use crate::embedding::{Cancel, EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity};

type QueryResult = Result<Vec<Vec<f32>>, EmbedError>;
type QueryFlight = Arc<OnceLock<QueryResult>>;

/// Request-local query results. Never reuse this object between merged recalls.
/// Passages and queries other than the original text go directly to the provider.
pub struct RequestQueries {
    query: String,
    flights: Mutex<HashMap<String, QueryFlight>>,
}

impl RequestQueries {
    /// Start an empty scope before spawning the table workers.
    #[must_use]
    pub fn new(query: &str) -> Self {
        Self {
            query: query.to_owned(),
            flights: Mutex::new(HashMap::new()),
        }
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
        flight
            .get_or_init(|| self.provider.embed(texts, kind, cancel))
            .clone()
    }

    fn invalidate_egress(&self) {
        self.provider.invalidate_egress();
    }
}
