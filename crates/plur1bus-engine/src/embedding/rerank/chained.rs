//! Ordered primary/fallback reranking under the caller's shared cancellation budget.
use crate::contract::{Cancel, RerankHit};
use crate::embedding::{RerankError, Reranker};
/// First successful provider result wins; disabled fallback permits an empty result.
pub struct ChainedReranker<'a> {
    primary: Box<dyn Reranker + 'a>,
    fallback: Option<Box<dyn Reranker + 'a>>,
}
impl<'a> ChainedReranker<'a> {
    /// Configure the primary and an optional fallback provider.
    pub fn new(primary: Box<dyn Reranker + 'a>, fallback: Option<Box<dyn Reranker + 'a>>) -> Self {
        Self { primary, fallback }
    }
}
impl Reranker for ChainedReranker<'_> {
    fn invalidate_egress(&self) {
        self.primary.invalidate_egress();
        if let Some(fallback) = &self.fallback {
            fallback.invalidate_egress();
        }
    }
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        cancel.check().map_err(RerankError::Cancelled)?;
        match self.primary.rerank(query, docs, top_n, cancel) {
            Ok(result) => Ok(result),
            Err(error) => {
                cancel.check().map_err(RerankError::Cancelled)?;
                if matches!(error, RerankError::Cancelled(_)) {
                    return Err(error);
                }
                match &self.fallback {
                    Some(fallback) => fallback.rerank(query, docs, top_n, cancel),
                    None => Ok(vec![]),
                }
            }
        }
    }
    fn empty_result_is_valid(&self) -> bool {
        // A failed primary with no fallback returns [] to preserve the recall candidates.
        // Only a decision prefilter may interpret an empty result as "nothing relevant".
        false
    }
}
