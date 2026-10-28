//! Batched OpenAI-compatible embeddings over the guarded transport.
use super::rerank::{signal, Credential, ProviderError, ProviderErrorKind, SecretStore};
use super::{EmbedError, EmbedKind, EmbeddingProvider};
use crate::contract::{Cancel, SecretPort, VectorSpaceIdentity};
use crate::transport::{GuardedClient, HttpRequest};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
/// OpenAI-compatible provider with byte-compatible request shapes and dimension checks.
pub struct OpenAiEmbeddingProvider<'a> {
    identity: VectorSpaceIdentity,
    client: Arc<GuardedClient<'a>>,
    credential: Credential<'a>,
    endpoint: String,
    model: String,
    dimension: usize,
    timeout: Duration,
}
#[derive(Clone)]
enum RemoteEmbedError {
    Provider(ProviderError),
    InvalidVector,
    Dimension { expected: usize, actual: usize },
}
impl From<ProviderError> for RemoteEmbedError {
    fn from(value: ProviderError) -> Self {
        Self::Provider(value)
    }
}
impl<'a> OpenAiEmbeddingProvider<'a> {
    /// Configure an endpoint, identity and secret-store name.
    /// Borrowed synchronous secret callbacks account elapsed time but cannot be interrupted;
    /// use new_owned to bound a blocking host callback by the call deadline.
    pub fn new(
        config: &Value,
        identity: VectorSpaceIdentity,
        client: Arc<GuardedClient<'a>>,
        secrets: Option<&'a dyn SecretPort>,
    ) -> Result<Self, EmbedError> {
        Self::configure(config, identity, client, secrets.map(SecretStore::Borrowed))
    }
    /// Configure a provider retaining owned host-port adapters.
    pub fn new_owned(
        config: &Value,
        identity: VectorSpaceIdentity,
        client: Arc<GuardedClient<'static>>,
        secrets: Option<Arc<dyn SecretPort>>,
    ) -> Result<OpenAiEmbeddingProvider<'static>, EmbedError> {
        OpenAiEmbeddingProvider::configure(
            config,
            identity,
            client,
            secrets.map(SecretStore::Owned),
        )
    }
    /// Execute one batch request while retaining the full packages/providers taxonomy.
    /// The EmbeddingProvider port additionally applies Node's retries and individual fallback.
    pub fn embed_remote(
        &self,
        texts: &[String],
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, ProviderError> {
        let deadline = signal::request_deadline(cancel, self.timeout)?;
        if texts.is_empty() {
            signal::check(cancel)?;
            return Ok(vec![]);
        }
        self.once(json!(texts), texts.len(), cancel, deadline)
            .map_err(|error| match error {
                RemoteEmbedError::Provider(error) => error,
                _ => ProviderError::invalid_response(),
            })
    }

    fn configure(
        config: &Value,
        identity: VectorSpaceIdentity,
        client: Arc<GuardedClient<'a>>,
        store: Option<SecretStore<'a>>,
    ) -> Result<Self, EmbedError> {
        let width = identity
            .dimension
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0 && n.fract() == 0.0 && *n < usize::MAX as f64)
            .ok_or(EmbedError::Unavailable)?;
        let dimension = width as usize;
        let model = config
            .get("model")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or(&identity.model)
            .to_owned();
        if model != identity.model
            || config
                .get("provider")
                .filter(|value| !value.is_null())
                .is_some_and(|value| value.as_str() != Some(identity.provider.as_str()))
            || config
                .get("dimensions")
                .filter(|value| !value.is_null())
                .is_some_and(|value| value.as_f64() != Some(width))
        {
            return Err(EmbedError::Unavailable);
        }
        let base = config
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or("https://api.openai.com/v1");
        let (mut endpoint, _) =
            crate::transport::target::parse_url(base).map_err(|_| EmbedError::Unavailable)?;
        endpoint.set_path(&format!(
            "{}/embeddings",
            endpoint.path().trim_end_matches('/')
        ));
        let milliseconds = config
            .get("requestTimeoutMs")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 1000.0)
            .unwrap_or(15_000.0)
            .floor();
        let timeout = Duration::try_from_secs_f64(milliseconds / 1000.0)
            .map_err(|_| EmbedError::Unavailable)?;
        Ok(Self {
            identity,
            client,
            credential: Credential::new(config, Some("OPENAI_API_KEY"), store)
                .map_err(|_| EmbedError::Unavailable)?,
            endpoint: endpoint.into(),
            model,
            dimension,
            timeout,
        })
    }

    fn once(
        &self,
        input: Value,
        count: usize,
        cancel: &Cancel,
        deadline: Instant,
    ) -> Result<Vec<Vec<f32>>, RemoteEmbedError> {
        signal::check(cancel)?;
        let mut body = json!({"model":self.model,"encoding_format":"float"});
        body["input"] = input;
        let canonical = self.model.strip_prefix("openai/").unwrap_or(&self.model);
        if matches!(
            canonical,
            "text-embedding-3-small" | "text-embedding-3-large"
        ) {
            body["dimensions"] = json!(self.dimension);
        }
        let mut request = HttpRequest::get(self.endpoint.clone());
        request.method = "POST".into();
        request.body = serde_json::to_vec(&body)
            .map_err(|_| ProviderError::simple(ProviderErrorKind::InvalidRequest))?;
        request.max_response_bytes = 16 * 1024 * 1024;
        request.auth_rejection_counter = self.credential.rejection_counter();
        request.headers = vec![
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json".into()),
        ];
        if let Some(value) = self.credential.authorization(deadline)? {
            request.headers.push(("Authorization".into(), value));
        }
        signal::check(cancel)?;
        let response = self
            .client
            .request(request, deadline)
            .map_err(ProviderError::from)?;
        signal::check(cancel)?;
        if !(200..300).contains(&response.status) {
            return Err(ProviderError::http(response.status, &response.body).into());
        }
        let payload: Value = serde_json::from_slice(&response.body)
            .map_err(|_| ProviderError::invalid_response())?;
        let entries = payload
            .get("data")
            .and_then(Value::as_array)
            .filter(|rows| rows.len() == count)
            .ok_or_else(ProviderError::invalid_response)?;
        entries
            .iter()
            .map(|entry| {
                let values = entry
                    .get("embedding")
                    .and_then(Value::as_array)
                    .ok_or_else(ProviderError::invalid_response)?;
                if values.len() != self.dimension {
                    return Err(RemoteEmbedError::Dimension {
                        expected: self.dimension,
                        actual: values.len(),
                    });
                }
                if values.is_empty() {
                    return Err(RemoteEmbedError::InvalidVector);
                }
                values
                    .iter()
                    .map(|value| {
                        value
                            .as_f64()
                            .filter(|v| v.is_finite())
                            .map(|v| v as f32)
                            .filter(|v| v.is_finite())
                            .ok_or(RemoteEmbedError::InvalidVector)
                    })
                    .collect()
            })
            .collect()
    }

    fn compute(
        &self,
        texts: &[String],
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, RemoteEmbedError> {
        signal::check(cancel)?;
        if texts.is_empty() {
            return Ok(vec![]);
        }
        let deadline = signal::request_deadline(cancel, self.timeout)?;
        let mut last = None;
        for attempt in 0..=3 {
            match self.once(json!(texts), texts.len(), cancel, deadline) {
                Ok(vectors) => return Ok(vectors),
                Err(error) => {
                    signal::check(cancel)?;
                    if matches!(&error,RemoteEmbedError::Provider(error) if error.kind==ProviderErrorKind::Aborted || error.kind==ProviderErrorKind::Timeout && error.status!=Some(408))
                    {
                        return Err(error);
                    }
                    let rate_limited = matches!(&error,RemoteEmbedError::Provider(error) if error.kind==ProviderErrorKind::RateLimit);
                    last = Some(error);
                    if attempt < 3 {
                        let delay = Duration::from_millis(if rate_limited {
                            1000 * (1_u64 << attempt)
                        } else {
                            500 * (attempt + 1)
                        });
                        pause(cancel, deadline, delay)?;
                    }
                }
            }
        }
        let mut vectors = Vec::with_capacity(texts.len());
        for text in texts {
            match self.once(json!(text), 1, cancel, deadline) {
                Ok(mut single) => vectors.append(&mut single),
                Err(error) => {
                    signal::check(cancel)?;
                    if matches!(&error,RemoteEmbedError::Provider(error) if error.kind==ProviderErrorKind::Aborted || error.kind==ProviderErrorKind::Timeout && error.status!=Some(408))
                    {
                        return Err(error);
                    }
                    return Err(last.unwrap_or(error));
                }
            }
        }
        Ok(vectors)
    }
}
impl EmbeddingProvider for OpenAiEmbeddingProvider<'_> {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn invalidate_egress(&self) {
        self.client.invalidate();
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        cancel.check().map_err(EmbedError::Cancelled)?;
        let result = self.compute(texts, cancel);
        cancel.check().map_err(EmbedError::Cancelled)?;
        result.map_err(|error| match error {
            RemoteEmbedError::Dimension { expected, actual } => {
                EmbedError::DimensionMismatch { expected, actual }
            }
            RemoteEmbedError::InvalidVector => EmbedError::InvalidVector,
            RemoteEmbedError::Provider(error) => EmbedError::ProviderFailed {
                status: error.status,
            },
        })
    }
}

fn pause(cancel: &Cancel, deadline: Instant, delay: Duration) -> Result<(), RemoteEmbedError> {
    let until = Instant::now()
        .checked_add(delay)
        .ok_or_else(|| ProviderError::simple(ProviderErrorKind::Timeout))?;
    loop {
        signal::check(cancel)?;
        let now = Instant::now();
        if now >= deadline {
            return Err(ProviderError::simple(ProviderErrorKind::Timeout).into());
        }
        if now >= until {
            return Ok(());
        }
        std::thread::sleep(
            (until - now)
                .min(deadline - now)
                .min(Duration::from_millis(10)),
        );
    }
}
