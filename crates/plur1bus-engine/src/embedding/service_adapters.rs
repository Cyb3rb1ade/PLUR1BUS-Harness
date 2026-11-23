//! Native pipeline views over one existing service; no second provider or cache.
use super::*;
use crate::embedding::{model_selection::ModelSelection, VectorSpaceIdentity};

impl Service {
    /// Reuse this service's identity, batching, cache and shutdown gates in native pipelines.
    pub fn pipeline_embedder(self: &Arc<Self>) -> Arc<dyn EmbeddingProvider> {
        Arc::new(PipelineEmbedder {
            service: self.clone(),
            cache: true,
        })
    }
    /// The same provider and batching, without reading or publishing embedding-cache entries.
    pub(crate) fn diagnostic_embedder(self: &Arc<Self>) -> Arc<dyn EmbeddingProvider> {
        Arc::new(PipelineEmbedder {
            service: self.clone(),
            cache: false,
        })
    }
    /// A warm request may share this facade only when its cache has no disk tier.
    pub(crate) fn memory_only_embedder(self: &Arc<Self>) -> Option<Arc<dyn EmbeddingProvider>> {
        (!self.cache.has_persistence()).then(|| self.pipeline_embedder())
    }
    /// Preserve the distinction between an absent reranker and a successful empty result.
    pub fn pipeline_reranker(self: &Arc<Self>) -> Option<Arc<dyn Reranker>> {
        self.reranker
            .as_ref()
            .map(|_| Arc::new(PipelineReranker(self.clone())) as Arc<dyn Reranker>)
    }
}
struct PipelineEmbedder {
    service: Arc<Service>,
    cache: bool,
}
impl EmbeddingProvider for PipelineEmbedder {
    fn model_selection(&self) -> ModelSelection {
        self.service.provider.model_selection()
    }
    fn identity(&self) -> &VectorSpaceIdentity {
        self.service.provider.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        let result = if self.cache {
            EmbeddingService::embed(
                self.service.as_ref(),
                texts,
                kind,
                &self.service.identity,
                cancel,
            )
        } else {
            self.service.embed_uncached(texts, kind, cancel)
        };
        result.map_err(|error| match error {
            EngineError::Cancelled(reason) => EmbedError::Cancelled(reason),
            EngineError::Embedding(error) => error,
            _ => EmbedError::Unavailable,
        })
    }
    fn invalidate_egress(&self) {
        self.service.invalidate_egress();
    }
}
struct PipelineReranker(Arc<Service>);
impl Reranker for PipelineReranker {
    fn model_selections(&self) -> Vec<ModelSelection> {
        self.0
            .reranker
            .as_ref()
            .map_or_else(Vec::new, |provider| provider.model_selections())
    }
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        EmbeddingService::rerank(self.0.as_ref(), query, docs, top_n, cancel).map_err(|error| {
            match error {
                EngineError::Cancelled(reason) => RerankError::Cancelled(reason),
                EngineError::Embedding(
                    EmbedError::InvalidVector | EmbedError::DimensionMismatch { .. },
                ) => RerankError::InvalidResponse,
                EngineError::Embedding(EmbedError::ProviderFailed { status }) => {
                    RerankError::ProviderFailed { status }
                }
                _ => RerankError::Unavailable,
            }
        })
    }
    fn empty_result_is_valid(&self) -> bool {
        self.0
            .reranker
            .as_ref()
            .is_some_and(|provider| provider.empty_result_is_valid())
    }
    fn invalidate_egress(&self) {
        self.0.invalidate_egress();
    }
}
