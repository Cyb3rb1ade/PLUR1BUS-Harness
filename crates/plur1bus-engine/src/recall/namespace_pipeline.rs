//! Compose the existing stage-7 and finalisation implementations for one leased table.
//! Namespaces own leases/merge; T5 owns prompt assembly and maintenance writes.

use super::acl::{AclMemory, DenialSink};
use super::candidate::RecallCandidate;
use super::finalise::{self, FinaliseLimits, FinaliseRequest};
use super::graph::GraphEdge;
use super::merge::NamespaceResult;
use super::namespace_query::RequestQueries;
use super::namespace_trace::NamespaceTrace;
use super::namespaces::{CanonicalSource, NamespaceError, TableRecall};
use super::stages::{self, StageClocks, StageFlags, StageInput, StageLimits};
use crate::context::RequestContext;
use crate::contract::MemoryRow;
use crate::embedding::{Cancel, EmbeddingProvider, Reranker};
use crate::store::Store;
use serde_json::json;
use std::path::Path;

/// Per-table dependencies shared across a namespace fan-out.
pub struct Pipeline<'a> {
    /// User query.
    pub query: &'a str,
    /// Resolved ACL subject.
    pub context: &'a RequestContext,
    /// Thread-safe caller sink; namespace workers must not discard denials.
    pub denials: &'a (dyn DenialSink + Sync),
    /// Embedding provider for these physical tables.
    pub embedder: &'a dyn EmbeddingProvider,
    /// Optional reranker, always reached after the existing ACL checks.
    pub reranker: Option<&'a dyn Reranker>,
    /// Optional workspace for canonical knowledge.
    pub workspace_dir: Option<&'a Path>,
    /// Bound graph edges.
    pub edges: &'a [GraphEdge],
    /// Shared caller/deadline cancellation.
    pub cancel: &'a Cancel,
    /// Stage 1–7 limits.
    pub limits: StageLimits,
    /// Stage switches.
    pub flags: StageFlags,
    /// Explicit clocks.
    pub clocks: StageClocks,
    /// Post-hydration controls; child caps are deferred to the global merge.
    pub finalise_limits: FinaliseLimits,
}

impl TableRecall for Pipeline<'_> {
    fn recall(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
    ) -> Result<NamespaceResult, NamespaceError> {
        let embedder = queries.wrap(self.embedder);
        let mut flags = self.flags.clone();
        flags.canonical &= canonical == CanonicalSource::Read;
        flags.defer_final_cap = true;
        let mut limits = self.limits.clone();
        limits.candidate_hard_limit = 100;
        let mut finalise_limits = self.finalise_limits;
        finalise_limits.defer_final_cap = true;
        finalise_limits.candidate_hard_limit = 100.0;
        let snapshot = stages::run_through_stage_7(
            &StageInput {
                query: self.query,
                store,
                embedder: &embedder,
                context: self.context,
                workspace_dir: self.workspace_dir,
                edges: self.edges,
                limits,
                flags,
                clocks: self.clocks.clone(),
            },
            self.denials,
        )
        .map_err(NamespaceError::Stage)?;
        let candidates = snapshot
            .rows
            .iter()
            .zip(&snapshot.scores)
            .zip(&snapshot.sources)
            .map(|((row, score), source)| candidate(row, *score, source))
            .collect::<Result<Vec<_>, _>>()?;
        let finalised = finalise::apply(
            &FinaliseRequest {
                query: self.query,
                rows: &candidates,
                context: self.context,
                reranker: self.reranker,
                filter: None,
                cancel: self.cancel,
                limits: finalise_limits,
                leaked: &[],
            },
            self.denials,
        )
        .map_err(|failure| NamespaceError::Finalise(failure.error))?;
        let memories = finalised.ids.iter().zip(&finalised.rerank_scores).zip(&finalised.sources)
            .filter_map(|((id,rerank),source)| snapshot.rows.iter().position(|row| &row.id == id).map(|index| {
                let mut wrapper = json!({"entry":snapshot.rows[index],"score":snapshot.scores[index],"source":source});
                if let Some(score) = rerank { wrapper["rerankScore"] = json!(score); }
                wrapper
            })).collect();
        let mut trace = NamespaceTrace {
            candidates: snapshot
                .candidate_ids
                .iter()
                .map(|id| json!({"id":id}))
                .collect(),
            decisions: snapshot
                .rejections
                .iter()
                .map(|r| {
                    json!({"memoryId":r.memory_id,"action":"rejection",
            "stage":r.stage,"reason":r.reason})
                })
                .collect(),
            ..NamespaceTrace::default()
        };
        if !snapshot.rows.is_empty() {
            trace.guards.push(json!({"name":"score-recompute","passed":true,"reason":"strength/epistemic re-scoring applied"}));
            trace.decisions.extend(snapshot.rows.iter().map(|row| {
                json!({"memoryId":row.id,"action":"inclusion",
                "stage":"score-recompute","reason":"re-scored"})
            }));
        }
        trace.decisions.extend(finalised.decisions.iter().map(|r| {
            json!({"memoryId":r.memory_id,"action":r.action,
            "stage":r.stage,"reason":r.reason})
        }));
        trace.guards.extend(finalised.guards.iter().map(|g| {
            let mut value = json!({"name":g.name,"passed":g.passed,"reason":g.reason});
            if let Some(id) = &g.memory_id {
                value["memoryId"] = json!(id);
            }
            value
        }));
        Ok(NamespaceResult {
            namespace: namespace.map(str::to_owned),
            source_kind: Some("private".to_owned()),
            query_vector: Some(snapshot.query_vector),
            memories,
            trace: Some(trace),
            canonical: snapshot
                .canonical
                .iter()
                .map(|c| json!({"heading":c.heading,"text":c.text,"score":c.score}))
                .collect(),
        })
    }
}

fn candidate(row: &MemoryRow, score: f64, source: &str) -> Result<RecallCandidate, NamespaceError> {
    let ownership = AclMemory::from_row(row)
        .ok_or(NamespaceError::Store(crate::contract::StoreError::Corrupt))?;
    Ok(RecallCandidate {
        id: row.id.clone(),
        text: row.text.clone(),
        summary: row.summary.clone(),
        category: row.category.clone(),
        agent_id: row.agent_id.clone(),
        scope: row.scope.clone(),
        chunk_group_id: row.chunk_group_id.clone(),
        source_turn_id: row.source_turn_id.clone(),
        core_memory_score: row.core_memory_score.as_f64().unwrap_or(0.0),
        valid_from: row.valid_from.as_f64().unwrap_or(0.0),
        valid_until: row.valid_until.as_f64().unwrap_or(0.0),
        score: Some(score),
        source: source.to_owned(),
        ownership: Some(ownership),
        ..RecallCandidate::default()
    })
}
