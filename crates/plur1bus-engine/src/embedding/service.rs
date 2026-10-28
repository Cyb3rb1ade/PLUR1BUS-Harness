//! Engine embedding/model facade with cache isolation and independent probe waits.

use super::{
    batch::validate_vectors, cache::Cache, identity::try_identity_id, readiness::Probe, Cancel,
    EmbedError, EmbedKind, EmbeddingProvider, RerankError, RerankHit, Reranker,
};
use crate::{
    contract::{
        EmbeddingEnvelopeIdentity, EmbeddingIdentity, EmbeddingProbeError, EmbeddingProbeResult,
        EmbeddingServeResult, EmbeddingService, EngineConfig, EngineError, ModelState,
        ModelsService, ModelsStatus, ModelsStatusEmbedder, ModelsStatusEmbedderError,
        ModelsStatusReranker, ModelsStatusRerankerError,
    },
    store::sqlite::EmbeddingCache,
};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// Cache, scope and host clock configuration for one embedding facade.
#[derive(Clone)]
pub struct ServiceOptions {
    /// Maximum texts per facade provider request (top-level EngineConfig.embeddingBatchSize).
    pub embedding_batch_size: usize,
    /// Enable the bounded in-memory and optional persistent cache.
    pub cache_enabled: bool,
    /// Maximum number of memory cache entries.
    pub cache_max_entries: usize,
    /// Absolute-entry lifetime in milliseconds.
    pub cache_ttl_ms: i64,
    /// Agent id or explicit shared scope (Node defaults to `default`).
    pub scope_id: String,
    /// Reranker provider id included in ModelsService.status.
    pub reranker_provider: Option<String>,
    /// Host clock, expressed as Unix milliseconds.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for ServiceOptions {
    fn default() -> Self {
        Self {
            embedding_batch_size: 8,
            cache_enabled: true,
            cache_max_entries: 128,
            cache_ttl_ms: 300_000,
            scope_id: "default".into(),
            reranker_provider: None,
            clock: Arc::new(now_ms),
        }
    }
}

impl ServiceOptions {
    /// Project the top-level batching limit and embedding cache policy into the facade.
    pub fn from_config(config: &EngineConfig) -> Result<Self, EngineError> {
        let raw = serde_json::to_value(config).map_err(|_| EngineError::Invalid {
            field: "embedding".into(),
            message: "invalid engine configuration".into(),
        })?;
        let positive = |value: Option<&serde_json::Value>,
                        fallback: usize,
                        field: &str|
         -> Result<usize, EngineError> {
            let Some(value) = value.filter(|value| !value.is_null()) else {
                return Ok(fallback);
            };
            value
                .as_f64()
                .filter(|number| {
                    *number >= 1.0
                        && number.fract() == 0.0
                        && *number < usize::MAX as f64
                        && *number <= 9_007_199_254_740_991.0
                })
                .map(|number| number as usize)
                .ok_or_else(|| EngineError::Invalid {
                    field: field.into(),
                    message: "positive integer required".into(),
                })
        };
        let embedding = &raw["embedding"];
        Ok(Self {
            embedding_batch_size: positive(raw.get("embeddingBatchSize"), 8, "embeddingBatchSize")?,
            cache_enabled: embedding.get("embeddingCacheEnabled")
                != Some(&serde_json::Value::Bool(false)),
            cache_max_entries: positive(
                embedding
                    .get("embeddingCacheMaxEntries")
                    .or_else(|| embedding.get("cacheMaxEntries")),
                128,
                "embedding.cacheMaxEntries",
            )?,
            cache_ttl_ms: i64::try_from(positive(
                embedding
                    .get("embeddingCacheTtlMs")
                    .or_else(|| embedding.get("cacheTtlMs")),
                300_000,
                "embedding.cacheTtlMs",
            )?)
            .map_err(|_| EngineError::Invalid {
                field: "embedding.cacheTtlMs".into(),
                message: "cache TTL exceeds supported range".into(),
            })?,
            scope_id: if embedding
                .get("embeddingCacheScope")
                .and_then(serde_json::Value::as_str)
                == Some("shared")
            {
                "shared".into()
            } else {
                "default".into()
            },
            ..Self::default()
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[derive(Clone)]
struct RerankAttempt {
    ok: bool,
    checked_at: i64,
    invalid: bool,
}

/// Owned embedding and model services; probes can finish after an individual caller cancels.
pub struct Service {
    provider: Arc<dyn EmbeddingProvider>,
    reranker: Option<Arc<dyn Reranker>>,
    identity: EmbeddingIdentity,
    identity_hash: String,
    width: usize,
    cache: Cache,
    options: ServiceOptions,
    embedding_probe: Arc<Probe<EmbeddingProbeResult>>,
    reranker_probe: Option<Arc<Probe<RerankAttempt>>>,
    closed: AtomicBool,
}

impl Service {
    /// Bind providers and the identity routing envelope without loading any models.
    pub fn new(
        provider: Box<dyn EmbeddingProvider>,
        reranker: Option<Box<dyn Reranker>>,
        identity: EmbeddingIdentity,
        cache: Option<EmbeddingCache>,
        options: ServiceOptions,
    ) -> Result<Self, EngineError> {
        if options.embedding_batch_size == 0 {
            return Err(EngineError::Invalid {
                field: "embeddingBatchSize".into(),
                message: "positive integer required".into(),
            });
        }
        let width = identity
            .dimensions
            .as_u64()
            .and_then(|width| usize::try_from(width).ok())
            .filter(|width| *width > 0)
            .ok_or_else(|| EngineError::Invalid {
                field: "embedding.dimensions".into(),
                message: "positive integer required".into(),
            })?;
        let provider_hash = try_identity_id(provider.identity())?;
        let envelope_hash = identity.space.as_ref().map(try_identity_id).transpose()?;
        if provider.identity().dimension.as_u64() != u64::try_from(width).ok()
            || provider.identity().provider != identity.provider
            || provider.identity().model != identity.model
            || envelope_hash
                .as_ref()
                .is_some_and(|hash| hash != &provider_hash)
        {
            return Err(EngineError::Invalid {
                field: "embedding.identity".into(),
                message: "provider identity mismatch".into(),
            });
        }
        let provider: Arc<dyn EmbeddingProvider> = provider.into();
        let reranker: Option<Arc<dyn Reranker>> = reranker.map(Into::into);
        let embedding_probe = {
            let provider = provider.clone();
            let identity = identity.clone();
            let clock = options.clock.clone();
            let attempt = AtomicUsize::new(0);
            let nonce = uuid::Uuid::new_v4();
            Probe::new(
                move || {
                    let started = Instant::now();
                    let text = format!(
                        "plur1bus embedding probe {nonce}:{}",
                        attempt.fetch_add(1, Ordering::Relaxed)
                    );
                    let call = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        provider.embed(&[text], EmbedKind::Query, &Cancel::never())
                    }))
                    .unwrap_or(Err(EmbedError::ProviderFailed { status: None }));
                    let error = match call {
                        Ok(vectors) => {
                            validate_vectors(&vectors, 1, width)
                                .err()
                                .map(|error| match error {
                                    EmbedError::DimensionMismatch { .. } => {
                                        EmbeddingProbeError::DimensionMismatch
                                    }
                                    _ => EmbeddingProbeError::InvalidVector,
                                })
                        }
                        Err(EmbedError::DimensionMismatch { .. }) => {
                            Some(EmbeddingProbeError::DimensionMismatch)
                        }
                        Err(EmbedError::InvalidVector) => Some(EmbeddingProbeError::InvalidVector),
                        Err(_) => Some(EmbeddingProbeError::ProviderFailed),
                    };
                    EmbeddingProbeResult {
                        ok: error.is_none(),
                        error,
                        cached: false,
                        identity: identity.clone(),
                        duration_ms: u64::try_from(started.elapsed().as_millis())
                            .unwrap_or(u64::MAX)
                            .into(),
                        checked_at: clock().into(),
                    }
                },
                |result| result.ok,
            )
        };
        let reranker_probe = reranker.as_ref().map(|reranker| {
            let reranker = reranker.clone();
            let clock = options.clock.clone();
            Probe::new(
                move || {
                    let docs = [
                        "plur1bus probe document one".into(),
                        "plur1bus probe document two".into(),
                    ];
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        reranker.rerank("plur1bus reranker probe", &docs, 1, &Cancel::never())
                    }))
                    .unwrap_or(Err(RerankError::ProviderFailed { status: None }));
                    match result {
                        Ok(hits) => {
                            let valid = !hits.is_empty() && valid_hits(&hits, 2);
                            RerankAttempt {
                                ok: valid,
                                invalid: !valid,
                                checked_at: clock(),
                            }
                        }
                        Err(_) => RerankAttempt {
                            ok: false,
                            invalid: false,
                            checked_at: clock(),
                        },
                    }
                },
                |result| result.ok,
            )
        });
        Ok(Self {
            identity_hash: envelope_hash.unwrap_or(provider_hash),
            provider,
            reranker,
            identity,
            width,
            cache: Cache::new(
                cache,
                options.cache_enabled,
                options.cache_max_entries,
                options.cache_ttl_ms,
                options.scope_id.clone(),
            ),
            options,
            embedding_probe,
            reranker_probe,
            closed: AtomicBool::new(false),
        })
    }

    /// Reject subsequent service operations while allowing in-flight probes to settle.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    /// Forward a host `egress.changed` event to every owned outbound provider.
    pub fn invalidate_egress(&self) {
        self.provider.invalidate_egress();
        if let Some(reranker) = &self.reranker {
            reranker.invalidate_egress();
        }
    }

    fn open(&self) -> Result<(), EngineError> {
        if self.closed.load(Ordering::Acquire) {
            Err(EngineError::NotAvailable {
                reason: "closed".into(),
            })
        } else {
            Ok(())
        }
    }

    /// The host transport envelope; no listener or token is created by this engine module.
    pub fn serve_identity_envelope(&self) -> Result<EmbeddingEnvelopeIdentity, EngineError> {
        self.open()?;
        Ok(EmbeddingEnvelopeIdentity {
            model: self.identity.model.clone(),
            dimensions: self.identity.dimensions.clone(),
            fingerprint_id: self.identity.fingerprint_id.clone(),
        })
    }
}

fn valid_hits(hits: &[RerankHit], document_count: usize) -> bool {
    let mut seen = HashSet::new();
    hits.iter().all(|hit| {
        hit.index
            .as_f64()
            .filter(|index| *index >= 0.0 && index.fract() == 0.0 && *index < document_count as f64)
            .is_some_and(|index| seen.insert(index as usize))
            && hit.score.as_f64().is_some_and(f64::is_finite)
    })
}

impl EmbeddingService for Service {
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        identity: &EmbeddingIdentity,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EngineError> {
        self.open()?;
        cancel.check()?;
        let requested_hash = identity.space.as_ref().map(try_identity_id).transpose()?;
        if identity.fingerprint_id != self.identity.fingerprint_id
            || identity.provider != self.identity.provider
            || identity.model != self.identity.model
            || identity.dimensions != self.identity.dimensions
            || requested_hash
                .as_ref()
                .is_some_and(|hash| hash != &self.identity_hash)
        {
            return Err(EngineError::Invalid {
                field: "embedding.identity".into(),
                message: "unknown vector-space identity".into(),
            });
        }
        let mut vectors = Vec::with_capacity(texts.len());
        for batch in texts.chunks(self.options.embedding_batch_size) {
            cancel.check()?;
            vectors.extend(self.cache.embed(
                self.provider.as_ref(),
                batch,
                kind,
                &self.identity_hash,
                self.width,
                self.options.clock.as_ref(),
                cancel,
            )?);
        }
        Ok(vectors)
    }

    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, EngineError> {
        self.open()?;
        cancel.check()?;
        let Some(reranker) = &self.reranker else {
            return Ok(Vec::new());
        };
        if docs.is_empty() || top_n == 0 {
            return Ok(Vec::new());
        }
        let mut hits =
            reranker
                .rerank(query, docs, top_n, cancel)
                .map_err(|error| match error {
                    RerankError::Cancelled(reason) => EngineError::Cancelled(reason),
                    _ => EngineError::Embedding(EmbedError::ProviderFailed { status: None }),
                })?;
        cancel.check()?;
        if !valid_hits(&hits, docs.len()) {
            return Err(EmbedError::InvalidVector.into());
        }
        hits.sort_by(|left, right| {
            right
                .score
                .as_f64()
                .partial_cmp(&left.score.as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    left.index
                        .as_f64()
                        .partial_cmp(&right.index.as_f64())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        hits.truncate(top_n);
        Ok(hits)
    }

    fn probe(&self, refresh: bool, cancel: &Cancel) -> Result<EmbeddingProbeResult, EngineError> {
        self.open()?;
        let started = Instant::now();
        let ticket = self.embedding_probe.start(refresh);
        match Probe::wait(ticket, cancel) {
            Ok((mut result, cached)) => {
                result.cached = cached;
                Ok(result)
            }
            Err(_) => Ok(EmbeddingProbeResult {
                ok: false,
                error: Some(EmbeddingProbeError::Aborted),
                cached: false,
                identity: self.identity.clone(),
                duration_ms: u64::try_from(started.elapsed().as_millis())
                    .unwrap_or(u64::MAX)
                    .into(),
                checked_at: (self.options.clock)().into(),
            }),
        }
    }

    fn identities(&self) -> Vec<EmbeddingIdentity> {
        vec![self.identity.clone()]
    }
    fn serve(&self) -> Result<EmbeddingServeResult, EngineError> {
        Ok(EmbeddingServeResult {
            identity: Some(self.serve_identity_envelope()?),
        })
    }
}

impl ModelsService for Service {
    fn status(&self) -> ModelsStatus {
        let (attempt, warming) = self.embedding_probe.snapshot();
        let embedder = ModelsStatusEmbedder {
            state: attempt.as_ref().map_or(ModelState::Loading, |attempt| {
                if attempt.ok {
                    ModelState::Ready
                } else {
                    ModelState::Failed
                }
            }),
            warming,
            checked_at: attempt.as_ref().map(|attempt| attempt.checked_at.clone()),
            identity: self.identity.clone(),
            error: attempt
                .and_then(|attempt| attempt.error)
                .map(|error| match error {
                    EmbeddingProbeError::Aborted => ModelsStatusEmbedderError::Aborted,
                    EmbeddingProbeError::ProviderFailed => {
                        ModelsStatusEmbedderError::ProviderFailed
                    }
                    EmbeddingProbeError::InvalidVector => ModelsStatusEmbedderError::InvalidVector,
                    EmbeddingProbeError::DimensionMismatch => {
                        ModelsStatusEmbedderError::DimensionMismatch
                    }
                }),
        };
        let reranker = if let Some(probe) = &self.reranker_probe {
            let (attempt, warming) = probe.snapshot();
            ModelsStatusReranker {
                state: attempt.as_ref().map_or(ModelState::Loading, |attempt| {
                    if attempt.ok {
                        ModelState::Ready
                    } else {
                        ModelState::Failed
                    }
                }),
                warming,
                checked_at: attempt.as_ref().map(|attempt| attempt.checked_at.into()),
                provider: self.options.reranker_provider.clone(),
                error: attempt.filter(|attempt| !attempt.ok).map(|attempt| {
                    if attempt.invalid {
                        ModelsStatusRerankerError::InvalidResult
                    } else {
                        ModelsStatusRerankerError::ProviderFailed
                    }
                }),
            }
        } else {
            ModelsStatusReranker {
                state: ModelState::Disabled,
                warming: false,
                checked_at: None,
                provider: None,
                error: None,
            }
        };
        ModelsStatus { embedder, reranker }
    }

    fn warm(&self, cancel: &Cancel, refresh: bool) -> Result<ModelsStatus, EngineError> {
        self.open()?;
        let embedding = self.embedding_probe.start(refresh);
        let reranker = self
            .reranker_probe
            .as_ref()
            .map(|probe| probe.start(refresh));
        let _ = Probe::wait(embedding, cancel);
        if let Some(reranker) = reranker {
            let _ = Probe::wait(reranker, cancel);
        }
        Ok(self.status())
    }
}
