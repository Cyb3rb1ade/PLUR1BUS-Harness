//! Compose the existing stage-7 and finalisation implementations for one leased table.
//! Namespaces own leases/merge; T5 owns prompt assembly and maintenance writes.

use super::acl::{AclMemory, DenialSink};
use super::candidate::RecallCandidate;
use super::finalise::{self, FinaliseLimits, FinaliseRequest};
use super::graph::GraphEdge;
use super::merge::NamespaceResult;
use super::namespace_entry::project_entry;
use super::namespace_query::RequestQueries;
use super::namespaces::{CanonicalSource, NamespaceError, TableRecall};
use super::stages::{self, StageClocks, StageFlags, StageInput, StageLimits};
use super::{namespace_identity, namespace_rerank};
use crate::context::RequestContext;
use crate::contract::MemoryRow;
use crate::embedding::{Cancel, EmbeddingProvider, Reranker};
use crate::store::Store;
use serde_json::json;
use std::path::Path;

/// Per-table dependencies shared across a namespace fan-out.
pub struct Pipeline<'a> {
    /// Optional emotional-state factor applied by the scoring stage.
    pub emotion: Option<&'a dyn super::score::EmotionalRecallState>,
    /// Optional providers keyed by their complete identities; no cross-space fallback.
    pub identity_providers: &'a [&'a dyn EmbeddingProvider],
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
    /// Native metadata source; when configured, replaces preauthorized in-memory edges.
    pub bound_graph: Option<&'a super::graph_source::BoundGraphSource>,
    /// Committed-deletion mask for every row source (RE-D153); `None` reads unmasked.
    pub tombstones: Option<&'a super::tombstone_mask::TombstoneMask>,
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
    fn has_reranker(&self) -> bool {
        self.reranker.is_some()
    }

    fn rerank_merged(
        &self,
        result: &mut NamespaceResult,
        queries: &RequestQueries,
    ) -> Result<(), NamespaceError> {
        if let Some(reranker) = self.reranker {
            namespace_rerank::apply(
                result,
                queries.query(),
                reranker,
                self.cancel,
                self.finalise_limits.reranker_fallback_on_error,
            )?;
        }
        Ok(())
    }

    fn recall(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
    ) -> Result<NamespaceResult, NamespaceError> {
        self.recall_controlled(namespace, store, canonical, queries, None, None)
    }
}

impl Pipeline<'_> {
    pub(super) fn recall_controlled(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
        mut control: Option<&mut super::control::RecallControl>,
        filter: Option<&dyn super::filter::CandidateFilter>,
    ) -> Result<NamespaceResult, NamespaceError> {
        let identity = queries
            .identity_for_namespace(namespace)
            .or_else(|| store.identity());
        let routed = namespace_identity::route(identity, self.embedder, self.identity_providers)?;
        let Some(provider) = routed.provider else {
            return Ok(namespace_identity::unavailable(
                namespace,
                routed.identity,
                "EMBEDDER_UNAVAILABLE",
            ));
        };
        let snapshot =
            match self.snapshot(store, canonical, queries, provider, control.as_deref_mut()) {
                Ok(snapshot) => snapshot,
                Err(stages::StageError::Embed(error))
                    if queries.is_multi_identity()
                        && !matches!(error, crate::embedding::EmbedError::Cancelled(_)) =>
                {
                    return Ok(namespace_identity::unavailable(
                        namespace,
                        routed.identity,
                        namespace_identity::failure_code(&error),
                    ));
                }
                Err(error) => return Err(NamespaceError::Stage(error)),
            };
        self.complete(
            namespace,
            routed.identity,
            snapshot,
            queries,
            control,
            filter,
        )
    }
    fn snapshot(
        &self,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
        provider: &dyn EmbeddingProvider,
        control: Option<&mut super::control::RecallControl>,
    ) -> Result<stages::StageSnapshot, stages::StageError> {
        let embedder = queries.wrap(provider);
        let mut flags = self.flags.clone();
        flags.canonical &= canonical == CanonicalSource::Read;
        flags.defer_final_cap = true;
        let mut limits = self.limits.clone();
        limits.candidate_hard_limit = super::namespaces::CANDIDATE_HARD_LIMIT;
        let input = StageInput {
            query: queries.query(),
            store,
            embedder: &embedder,
            context: self.context,
            workspace_dir: self.workspace_dir,
            edges: self.edges,
            bound_graph: self.bound_graph,
            tombstones: self.tombstones,
            limits,
            flags,
            clocks: self.clocks.clone(),
        };
        match control {
            Some(control) => stages::run_controlled_stage_7(
                &input,
                self.denials,
                queries.trace_limits(),
                self.emotion,
                control,
            ),
            None => stages::run_observed_stage_7(
                &input,
                self.denials,
                queries.trace_limits(),
                self.emotion,
            ),
        }
    }

    fn complete(
        &self,
        namespace: Option<&str>,
        identity: Option<String>,
        snapshot: stages::StageSnapshot,
        queries: &RequestQueries,
        mut control: Option<&mut super::control::RecallControl>,
        filter: Option<&dyn super::filter::CandidateFilter>,
    ) -> Result<NamespaceResult, NamespaceError> {
        let candidates = snapshot
            .hydrated
            .iter()
            .map(|hit| candidate(&hit.row, hit.score, hit.source))
            .collect::<Vec<_>>();
        let mut limits = self.finalise_limits;
        limits.defer_final_cap = true;
        limits.candidate_hard_limit = super::namespaces::CANDIDATE_HARD_LIMIT as f64;
        let stopped = control
            .as_mut()
            .is_some_and(|control| !control.checkpoint(true));
        let cancel = control
            .as_ref()
            .map_or_else(|| self.cancel.clone(), |control| control.cancel.clone());
        let bounded_reranker = self.reranker.filter(|_| control.is_some()).map(|provider| {
            super::control::BoundReranker {
                provider,
                cancel: &cancel,
            }
        });
        let reranker = bounded_reranker
            .as_ref()
            .map(|provider| provider as &dyn Reranker)
            .or(self.reranker);
        let mut request = FinaliseRequest {
            query: queries.query(),
            rows: &candidates,
            context: self.context,
            reranker: if queries.is_multi_identity() || stopped {
                None
            } else {
                reranker
            },
            filter,
            cancel: &cancel,
            limits,
            leaked: &[],
        };
        let output = finalise::apply_timed(
            &request,
            self.denials,
            control.as_mut().map(|control| &mut control.timer),
        );
        // A provider may cooperate by returning cancellation. Preserve the already authorized rows,
        // never retry the provider or reinterpret an ordinary provider/store error as timeout.
        let finalised = if control.is_some() && cancel.is_cancelled() {
            if let Some(control) = control.as_mut() {
                control.checkpoint(false);
            }
            request.reranker = None;
            request.filter = None;
            finalise::apply(&request, self.denials)
        } else {
            output
        }
        .map_err(|failure| NamespaceError::Finalise(failure.error))?;
        let memories = wrappers(&snapshot.hydrated, &finalised);
        let mut trace = snapshot.trace;
        append_final_observations(&mut trace, &finalised);
        Ok(NamespaceResult {
            identity_id: identity, namespace: namespace.map(str::to_owned),
            source_kind: Some("private".to_owned()), query_vector: Some(snapshot.query_vector),
            memories, trace: Some(trace), canonical: snapshot.canonical.iter().map(|c| {
                let mut value = json!({"heading":c.heading,"text":c.text,"score":c.score,"mtimeMs":c.mtime_ms});
                if let Some(policy) = control.as_ref().and_then(|control| control.trace_policy.as_ref()) {
                    // Private intermediate metadata: preserve the heading until T6's UTF-16 cut.
                    value["_traceCanonicalId"] = json!(format!("canonical:{}", policy.redact(&c.heading)));
                }
                value
            }).collect(), ..NamespaceResult::default()
        })
    }
}

fn wrappers(
    hydrated: &[stages::HydratedMemory],
    finalised: &finalise::FinaliseOutput,
) -> Vec<serde_json::Value> {
    finalised
        .ids
        .iter()
        .zip(&finalised.rerank_scores)
        .zip(&finalised.sources)
        .filter_map(|((id, rerank), source)| {
            hydrated.iter().find(|hit| &hit.row.id == id).map(|hit| {
                let mut value =
                    json!({"entry":project_entry(&hit.row),"score":hit.score,"source":source});
                if let Some(score) = rerank {
                    value["rerankScore"] = json!(score);
                }
                if let Some(depth) = hit.depth {
                    value["depth"] = json!(depth);
                }
                value
            })
        })
        .collect()
}

fn append_final_observations(
    trace: &mut super::namespace_trace::NamespaceTrace,
    output: &finalise::FinaliseOutput,
) {
    trace.decisions.extend(output.decisions.iter().map(
        |r| json!({"memoryId":r.memory_id,"action":r.action,"stage":r.stage,"reason":r.reason}),
    ));
    trace.guards.extend(output.guards.iter().map(|g| {
        let mut value = json!({"name":g.name,"passed":g.passed,"reason":g.reason});
        if let Some(id) = &g.memory_id {
            value["memoryId"] = json!(id);
        }
        value
    }));
}

fn candidate(row: &MemoryRow, score: f64, source: &str) -> RecallCandidate {
    let ownership = AclMemory {
        id: row.id.clone(),
        scope: row.scope.clone(),
        agent_id: row.agent_id.clone(),
        stored_by: row.stored_by.clone(),
        workspace_id: row.workspace_id.clone(),
        workspace_key: row.workspace_key.clone(),
        owner_user_id: row.owner_user_id.clone(),
        type_name: row.type_.clone(),
        dream_narrative: row.origin == "dream" && row.memory_class == "dream",
    };
    RecallCandidate {
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
        ..RecallCandidate::new(ownership)
    }
}
