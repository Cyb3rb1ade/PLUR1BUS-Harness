//! Embedding and reranking service ports.

use super::{
    Cancel, EmbedKind, EmbeddingIdentity, EmbeddingProbeResult, EmbeddingServeResult, EngineError,
    RerankHit,
};

/// Embedding, reranking and model-probe operations for the configured vector spaces.
pub trait EmbeddingService: Send + Sync {
    /// Embed text as queries or passages in the explicitly selected vector space.
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        identity: &EmbeddingIdentity,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EngineError>;
    /// Rank documents for a query and return at most the requested number of hits.
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, EngineError>;
    /// Probe the provider once and memoize success; refresh forces a new provider call.
    /// Provider failures are represented by the result, while a closed engine rejects.
    fn probe(&self, refresh: bool, cancel: &Cancel) -> Result<EmbeddingProbeResult, EngineError>;
    /// Return every vector-space identity this engine can embed.
    fn identities(&self) -> Vec<EmbeddingIdentity>;
    /// Return the identity envelope for the harness-owned embedding transport.
    fn serve(&self) -> Result<EmbeddingServeResult, EngineError>;
}
