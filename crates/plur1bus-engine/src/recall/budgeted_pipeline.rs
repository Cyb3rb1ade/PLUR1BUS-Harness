//! Budgeted production table pipeline with independent namespace clocks.

use std::{sync::Mutex, time::Instant};

use serde_json::{json, Value};

use super::{
    budget::RecallBudget,
    control::{RecallControl, Stop},
    filter::CandidateFilter,
    merge::NamespaceResult,
    namespace_pipeline::Pipeline,
    namespace_query::RequestQueries,
    namespaces::{CanonicalSource, NamespaceError, TableRecall},
    timing::Phase,
};
use crate::store::Store;

struct Completed {
    namespace: Option<String>,
    phases: Vec<Phase>,
    stop: Option<Stop>,
}

/// One request's table pipeline. All worker scopes settle before this object is read or dropped.
pub struct BudgetedPipeline<'a> {
    pipeline: Pipeline<'a>,
    filter: Option<&'a dyn CandidateFilter>,
    started: Instant,
    budget: RecallBudget,
    completed: Mutex<Vec<Completed>>,
    trace_policy: Option<std::sync::Arc<super::trace::TracePolicy>>,
    soft_fallback: bool,
}

impl<'a> BudgetedPipeline<'a> {
    /// Anchor every child at request entry, so queue time consumes the same hard budget.
    #[must_use]
    pub fn new(
        pipeline: Pipeline<'a>,
        filter: Option<&'a dyn CandidateFilter>,
        started: Instant,
        budget: RecallBudget,
    ) -> Self {
        Self {
            pipeline,
            filter,
            started,
            budget,
            completed: Mutex::new(Vec::new()),
            trace_policy: None,
            soft_fallback: true,
        }
    }

    /// Redact full source previews before any truncation; final serialization applies the caps.
    #[must_use]
    pub fn with_trace_policy(mut self, policy: std::sync::Arc<super::trace::TracePolicy>) -> Self {
        self.trace_policy = Some(policy);
        self
    }

    /// Honor the existing recall.softBudgetFallback switch without changing the hard deadline.
    #[must_use]
    pub fn with_soft_fallback(mut self, enabled: bool) -> Self {
        self.soft_fallback = enabled;
        self
    }

    fn control(&self) -> RecallControl {
        let mut control = RecallControl::new(self.started, self.budget, self.pipeline.cancel);
        control.trace_policy = self.trace_policy.clone();
        control.soft_fallback = self.soft_fallback;
        control
    }

    fn record(&self, namespace: Option<&str>, control: &RecallControl) {
        self.completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Completed {
                namespace: namespace.map(str::to_owned),
                phases: control.timer.completed().to_vec(),
                stop: control.stopped(),
            });
    }

    /// Deterministic delivery, independent of worker completion order.
    #[must_use]
    pub fn namespace_phases(&self) -> Vec<Value> {
        let completed = self
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut ordered = completed.iter().collect::<Vec<_>>();
        ordered.sort_by(|left, right| left.namespace.cmp(&right.namespace));
        ordered
            .into_iter()
            .flat_map(|child| {
                child.phases.iter().map(|phase| {
            json!({"namespace":child.namespace,"phase":phase.name,"ms":phase.milliseconds})
        })
            })
            .collect()
    }

    /// Whether an actual table callback ran (missing read-only tables do not write ledgers).
    #[must_use]
    pub fn has_children(&self) -> bool {
        !self
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
    }

    /// Final stop classification. An explicit caller cancel supersedes all child results.
    #[must_use]
    pub fn stopped(&self) -> Option<Stop> {
        let mut control = self.control();
        if !control.checkpoint(false) {
            return control.stopped();
        }
        let completed = self
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        completed
            .iter()
            .filter_map(|child| child.stop)
            .max_by_key(|stop| match stop {
                Stop::SoftBudget => 0,
                Stop::Timeout => 1,
                Stop::Aborted => 2,
            })
    }
}

impl TableRecall for BudgetedPipeline<'_> {
    fn has_reranker(&self) -> bool {
        self.pipeline.has_reranker()
    }

    fn recall(
        &self,
        namespace: Option<&str>,
        store: &Store,
        canonical: CanonicalSource,
        queries: &RequestQueries,
    ) -> Result<NamespaceResult, NamespaceError> {
        let mut control = self.control();
        let result = self.pipeline.recall_controlled(
            namespace,
            store,
            canonical,
            queries,
            Some(&mut control),
            self.filter,
        );
        control.checkpoint(false);
        self.record(namespace, &control);
        result
    }

    fn rerank_merged(
        &self,
        result: &mut NamespaceResult,
        queries: &RequestQueries,
    ) -> Result<(), NamespaceError> {
        let mut control = self.control();
        if !control.checkpoint(true) {
            self.record(None, &control);
            return Ok(());
        }
        let Some(reranker) = self.pipeline.reranker else {
            return Ok(());
        };
        let bounded = super::control::BoundReranker {
            provider: reranker,
            cancel: &control.cancel,
        };
        control.timer.start("global_rerank");
        let outcome = super::namespace_rerank::apply(
            result,
            queries.query(),
            &bounded,
            &control.cancel,
            self.pipeline.finalise_limits.reranker_fallback_on_error,
        );
        control.timer.end("global_rerank");
        let cancelled = !control.checkpoint(false);
        self.record(None, &control);
        if cancelled {
            Ok(())
        } else {
            outcome
        }
    }
}

/// Contract degradation is content-free and soft-budget fallback is not a capability failure.
#[must_use]
pub fn degradation(stop: Option<Stop>) -> Option<Value> {
    match stop {
        Some(Stop::Timeout) => Some(json!({"reason":"timeout","capability":"recall"})),
        Some(Stop::Aborted) => Some(json!({"reason":"aborted","capability":"recall"})),
        _ => None,
    }
}
