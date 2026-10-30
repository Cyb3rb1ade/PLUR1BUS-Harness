//! Cohere applies its preset before using the shared guarded rerank transport.
use crate::contract::{Cancel, RerankHit, SecretPort};
use crate::embedding::{RerankError, Reranker};
use crate::transport::GuardedClient;
use std::sync::Arc;

/// Cohere adapter with the same overrides as the Node Cohere provider.
pub struct CohereReranker<'a>(super::remote::RemoteReranker<'a>);
impl<'a> CohereReranker<'a> {
    /// Apply the Cohere preset while retaining explicit endpoint/model/protocol overrides.
    pub fn new(
        config: &serde_json::Value,
        client: Arc<GuardedClient<'a>>,
        secrets: Option<&'a dyn SecretPort>,
    ) -> Result<Self, RerankError> {
        let config = cohere_config(config)?;
        super::remote::RemoteReranker::new(&config, client, secrets).map(Self)
    }
    /// Apply the Cohere preset with owned host-port adapters.
    pub fn new_owned(
        config: &serde_json::Value,
        client: Arc<GuardedClient<'static>>,
        secrets: Option<Arc<dyn SecretPort>>,
    ) -> Result<CohereReranker<'static>, RerankError> {
        let config = cohere_config(config)?;
        super::remote::RemoteReranker::new_owned(&config, client, secrets).map(CohereReranker)
    }
}
impl Reranker for CohereReranker<'_> {
    fn invalidate_egress(&self) {
        self.0.invalidate_egress();
    }
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        self.0.rerank(query, docs, top_n, cancel)
    }
    fn empty_result_is_valid(&self) -> bool {
        self.0.empty_result_is_valid()
    }
}
fn cohere_config(config: &serde_json::Value) -> Result<serde_json::Value, RerankError> {
    let mut config = config
        .as_object()
        .cloned()
        .ok_or(RerankError::Unavailable)?;
    config.insert("provider".into(), "cohere".into());
    Ok(serde_json::Value::Object(config))
}
