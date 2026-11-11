//! Configured namespace routes and settle-all recall orchestration.
//! A required table failure rejects the complete recall before any ledger append.
//! T4 routes are all private: index zero is the first private canonical source.
//! Shared/optional sources and strict single-source deadlines remain T6/RE-07 work.

use sha2::{Digest, Sha256};

use super::merge::{merge, MergeOptions, NamespaceResult};
use super::namespace_budget::{self, MergedBudget};
use super::namespace_query::RequestQueries;
use super::stages::StageError;
use super::{namespace_fanout, namespace_identity};
use crate::contract::{EngineError, StoreError};
use crate::store::ledger::JsonlLedger;
use crate::store::ledger_types::RetrievalLedgerLine;
use crate::store::{Store, StoreRoutes};
use crate::text::js::JsString;

pub(crate) use super::namespace_routes::writer_layout;
pub use super::namespace_routes::NamespaceStores;

// Node caps the deferred per-child and per-identity candidate set at 100.
pub(crate) const CANDIDATE_HARD_LIMIT: usize = 100;

/// One synchronous table pipeline. Providers are shared; borrowed stores never escape return.
pub trait TableRecall: Sync {
    /// Whether independent identity results need one final provider rerank.
    fn has_reranker(&self) -> bool {
        false
    }
    /// Rerank only after fusion, after every child passed its provider ACL.
    fn rerank_merged(
        &self,
        _result: &mut NamespaceResult,
        _queries: &RequestQueries,
    ) -> Result<(), NamespaceError> {
        Ok(())
    }

    /// Run one leased table with the shared request query scope; a failure cannot
    /// become a partial global answer.
    fn recall(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
    ) -> Result<NamespaceResult, NamespaceError>;
}

/// Exactly one private table reads the shared workspace knowledge file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalSource {
    /// The first table may read canonical knowledge when enabled.
    Read,
    /// Other tables must not embed or persist the same knowledge again.
    Skip,
}

/// Dependencies and the already-authorized context for one merged recall.
pub struct NamespaceRequest<'a> {
    /// Reciprocal-rank denominator offset, positive and finite.
    pub rrf_k: f64,
    /// Global tier budget. The default applies even without an adaptive-budget object.
    pub budget: MergedBudget,
    /// RE-02 physical routes.
    pub routes: &'a dyn StoreRoutes,
    /// Provider-ACL-aware table pipeline.
    pub pipeline: &'a dyn TableRecall,
    /// Requesting agent.
    pub agent_id: &'a str,
    /// Resolved workspace key, used only in the ledger envelope.
    pub workspace_key: &'a str,
    /// Query, hashed before persistence.
    pub query: &'a str,
    /// Request clock for the global ledger line.
    pub timestamp_ms: i64,
    /// Optional protected Node JSONL retrieval ledger.
    pub ledger: Option<&'a JsonlLedger<RetrievalLedgerLine>>,
    /// Global merge controls.
    pub merge: MergeOptions,
}

/// Successful merged output and the independent, bounded ledger delivery diagnostic.
pub struct NamespaceOutput {
    /// Global candidates and trace.
    pub result: NamespaceResult,
    /// A failed ledger append does not replace an otherwise successful Node recall.
    pub ledger_error: Option<StoreError>,
}

/// Bounded failures from a required namespace, never containing row text or paths.
#[derive(Debug)]
pub enum NamespaceError {
    /// Route, lease or store failure.
    Store(StoreError),
    /// Stage 1–7 failure.
    Stage(StageError),
    /// Reranker/finalisation failure.
    Finalise(EngineError),
    /// A child worker could not start or failed to return normally.
    WorkerFailed,
}
impl std::fmt::Display for NamespaceError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(StoreError::IdentityMismatch) => {
                out.write_str("store identity differs; re-embedding migration required")
            }
            Self::Store(error) => write!(out, "{error}"),
            Self::Stage(error) => write!(out, "{error}"),
            Self::Finalise(error) => write!(out, "{error}"),
            Self::WorkerFailed => out.write_str("namespace worker failed"),
        }
    }
}
impl std::error::Error for NamespaceError {}

/// Acquire required leases and reject lease/identity errors before starting any child worker.
/// Then settle every started child; select failures in route order before merging or ledger delivery.
pub fn recall(request: &NamespaceRequest<'_>) -> Result<NamespaceOutput, NamespaceError> {
    let leases = namespace_fanout::lease(request.routes, request.agent_id)?;
    let queries =
        namespace_fanout::query_scope(request.query, &leases, request.merge.trace_limits)?;
    let children = namespace_fanout::settle(request, &leases, &queries)?;
    let mut options = request.merge.clone();
    let global_rerank = queries.is_multi_identity() && request.pipeline.has_reranker();
    if global_rerank {
        options.max_out = CANDIDATE_HARD_LIMIT;
    }
    let mut result = if queries.is_multi_identity() {
        namespace_identity::merge_spaces(&children, &options, request.rrf_k)?
    } else {
        merge(&children, &options)
    };
    if global_rerank {
        request.pipeline.rerank_merged(&mut result, &queries)?;
        result
            .memories
            .truncate(request.merge.max_out.saturating_sub(result.canonical.len()));
    }
    if let Some(degraded) = namespace_identity::degradation(&children) {
        result.degraded = Some(degraded);
    }
    namespace_budget::apply(&mut result, request.budget);
    let ledger_error = if children.is_empty() {
        None
    } else {
        request
            .ledger
            .and_then(|ledger| ledger.append(&retrieval_line(request, &result)).err())
    };
    Ok(NamespaceOutput {
        result,
        ledger_error,
    })
}

pub(crate) fn retrieval_line(
    request: &NamespaceRequest<'_>,
    result: &NamespaceResult,
) -> RetrievalLedgerLine {
    let nullable = |value: &str| (!value.is_empty()).then(|| JsString::from(value));
    let hash = (!request.query.is_empty()).then(|| {
        JsString::from(format!("{:x}", Sha256::digest(request.query.as_bytes())).as_str())
    });
    let selected_ids = result
        .memories
        .iter()
        .map(|memory| memory["entry"]["id"].as_str().map(JsString::from))
        .collect();
    RetrievalLedgerLine::selected(
        JsString::from(uuid::Uuid::new_v4().to_string().as_str()),
        nullable(request.agent_id),
        nullable(request.workspace_key),
        hash,
        selected_ids,
        request.timestamp_ms,
    )
}
