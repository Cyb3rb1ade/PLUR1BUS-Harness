//! Configurable Cohere, Jina, Voyage and TEI rerank wire formats.
use super::{signal, Credential, ProviderError, ProviderErrorKind, SecretStore};
use crate::contract::{Cancel, RerankHit, SecretPort};
use crate::embedding::{RerankError, Reranker};
use crate::transport::{GuardedClient, HttpRequest};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Remote reranker backed exclusively by the guarded transport.
pub struct RemoteReranker<'a> {
    client: Arc<GuardedClient<'a>>,
    credential: Credential<'a>,
    endpoint: String,
    protocol: String,
    model: Option<String>,
    timeout: Duration,
    max_documents: usize,
    max_request_bytes: usize,
    max_response_bytes: usize,
}
impl<'a> RemoteReranker<'a> {
    /// Configure a remote protocol and secret-store name.
    /// Borrowed synchronous secret callbacks must return promptly; new_owned bounds their wait.
    pub fn new(
        config: &Value,
        client: Arc<GuardedClient<'a>>,
        secrets: Option<&'a dyn SecretPort>,
    ) -> Result<Self, RerankError> {
        Self::configure(config, client, secrets.map(SecretStore::Borrowed))
            .map_err(ProviderError::into_rerank)
    }
    /// Configure a remote provider with owned host-port adapters.
    pub fn new_owned(
        config: &Value,
        client: Arc<GuardedClient<'static>>,
        secrets: Option<Arc<dyn SecretPort>>,
    ) -> Result<RemoteReranker<'static>, RerankError> {
        RemoteReranker::configure(config, client, secrets.map(SecretStore::Owned))
            .map_err(ProviderError::into_rerank)
    }
    /// Rerank while retaining the exact provider error taxonomy.
    pub fn rerank_remote(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, ProviderError> {
        signal::check(cancel)?;
        if docs.is_empty() {
            return Ok(vec![]);
        }
        if docs.len() > self.max_documents {
            return Err(ProviderError::simple(ProviderErrorKind::InvalidRequest));
        }
        let count = if top_n == 0 {
            docs.len()
        } else {
            top_n.min(docs.len())
        };
        let mut body = match self.protocol.as_str() {
            "cohere" | "jina" => {
                json!({"query":query,"documents":docs,"top_n":count,"return_documents":false})
            }
            "voyage" => {
                json!({"query":query,"documents":docs,"top_k":count,"return_documents":false})
            }
            "tei" => json!({"query":query,"texts":docs,"raw_scores":false,"return_text":false}),
            _ => return Err(ProviderError::simple(ProviderErrorKind::InvalidRequest)),
        };
        if self.protocol != "tei" {
            if let Some(model) = &self.model {
                body["model"] = json!(model);
            }
        }
        let body = serde_json::to_vec(&body)
            .map_err(|_| ProviderError::simple(ProviderErrorKind::InvalidRequest))?;
        if body.len() > self.max_request_bytes {
            return Err(ProviderError::simple(ProviderErrorKind::InvalidRequest));
        }
        let deadline = signal::request_deadline(cancel, self.timeout)?;
        let mut request = HttpRequest::get(self.endpoint.clone());
        request.method = "POST".into();
        request.body = body;
        request.max_response_bytes = self.max_response_bytes;
        request.auth_rejection_counter = self.credential.rejection_counter();
        request.headers = vec![
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json".into()),
        ];
        if let Some(value) = self.credential.authorization(deadline, cancel)? {
            request.headers.push(("Authorization".into(), value));
        }
        signal::check(cancel)?;
        let response = self
            .client
            .request_cancelled(request, deadline, cancel)
            .map_err(ProviderError::from)?;
        signal::check(cancel)?;
        if !(200..300).contains(&response.status) {
            return Err(ProviderError::http(response.status, &response.body));
        }
        let payload = serde_json::from_slice::<Value>(&response.body)
            .map_err(|_| ProviderError::invalid_response())?;
        normalize_results(&payload, docs.len(), count)
    }

    fn configure(
        config: &Value,
        client: Arc<GuardedClient<'a>>,
        store: Option<SecretStore<'a>>,
    ) -> Result<Self, ProviderError> {
        let (base, protocol, model, secret) = match config
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("remote")
        {
            "cohere" => (
                "https://api.cohere.com/v2",
                "cohere",
                Some("rerank-v3.5"),
                Some("COHERE_API_KEY"),
            ),
            "jina" => (
                "https://api.jina.ai/v1",
                "jina",
                Some("jina-reranker-v2-base-multilingual"),
                Some("JINA_API_KEY"),
            ),
            "voyage" => (
                "https://api.voyageai.com/v1",
                "voyage",
                Some("rerank-2.5"),
                Some("VOYAGE_API_KEY"),
            ),
            _ => ("", "cohere", None, None),
        };
        let protocol = config
            .get("protocol")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or(protocol)
            .to_owned();
        if !["cohere", "jina", "voyage", "tei"].contains(&protocol.as_str()) {
            return Err(ProviderError::simple(ProviderErrorKind::InvalidRequest));
        }
        let base = config
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or(base);
        let (mut endpoint, _) =
            crate::transport::target::parse_url(base).map_err(ProviderError::from)?;
        let path = endpoint.path().trim_end_matches('/');
        let path = if path.to_ascii_lowercase().ends_with("/rerank") {
            path.to_owned()
        } else {
            format!("{path}/rerank")
        };
        endpoint.set_path(&path);
        let model = config
            .get("model")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .or(model)
            .map(str::to_owned);
        let timeout = config
            .get("timeoutMs")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(5000.0);
        let timeout = Duration::try_from_secs_f64(timeout / 1000.0)
            .map_err(|_| ProviderError::simple(ProviderErrorKind::InvalidRequest))?;
        Ok(Self {
            client,
            credential: Credential::new(config, secret, store)?,
            endpoint: endpoint.into(),
            protocol,
            model,
            timeout,
            max_documents: limit(config, "maxDocuments", 1000)?,
            max_request_bytes: limit(config, "maxRequestBytes", 4 * 1024 * 1024)?,
            max_response_bytes: limit(config, "maxResponseBytes", 1024 * 1024)?,
        })
    }
}
impl Reranker for RemoteReranker<'_> {
    fn invalidate_egress(&self) {
        self.client.invalidate();
    }
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError> {
        cancel.check().map_err(RerankError::Cancelled)?;
        let result = self.rerank_remote(query, docs, top_n, cancel);
        cancel.check().map_err(RerankError::Cancelled)?;
        result.map_err(ProviderError::into_rerank)
    }
    fn empty_result_is_valid(&self) -> bool {
        false
    }
}

fn limit(config: &Value, name: &str, fallback: usize) -> Result<usize, ProviderError> {
    let Some(value) = config.get(name).filter(|v| !v.is_null()) else {
        return Ok(fallback);
    };
    value
        .as_f64()
        .filter(|number| (1.0..=9_007_199_254_740_991.0).contains(number) && number.fract() == 0.0)
        .and_then(|n| usize::try_from(n as u64).ok())
        .ok_or_else(|| ProviderError::simple(ProviderErrorKind::InvalidRequest))
}
fn normalize_results(
    payload: &Value,
    document_count: usize,
    top_n: usize,
) -> Result<Vec<RerankHit>, ProviderError> {
    let rows = payload
        .as_array()
        .or_else(|| payload.get("results").and_then(Value::as_array))
        .or_else(|| payload.get("data").and_then(Value::as_array))
        .ok_or_else(ProviderError::invalid_response)?;
    let mut seen = std::collections::HashSet::new();
    let mut hits = Vec::with_capacity(rows.len());
    for row in rows {
        let index = row
            .get("index")
            .and_then(Value::as_f64)
            .filter(|n| {
                n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n < document_count as f64
            })
            .ok_or_else(ProviderError::invalid_response)?;
        let score = row
            .get("relevance_score")
            .filter(|v| !v.is_null())
            .or_else(|| row.get("score"))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .ok_or_else(ProviderError::invalid_response)?;
        if !seen.insert(index as usize) {
            return Err(ProviderError::invalid_response());
        }
        hits.push((index, score));
    }
    hits.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.total_cmp(&b.0)));
    hits.truncate(top_n);
    hits.into_iter()
        .map(|(index, score)| {
            Ok(RerankHit {
                index: serde_json::Number::from_f64(index)
                    .ok_or_else(ProviderError::invalid_response)?,
                score: serde_json::Number::from_f64(score)
                    .ok_or_else(ProviderError::invalid_response)?,
            })
        })
        .collect()
}
