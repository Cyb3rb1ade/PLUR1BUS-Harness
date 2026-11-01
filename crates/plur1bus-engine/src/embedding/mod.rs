//! Embedding providers, model construction and the engine service facade.

use crate::contract::{
    Decision, EgressGate, EngineConfig, EngineError, HostError, HostServices, SecretPort,
    SecretValue, Target,
};
use crate::transport::{GuardedClient, SystemResolver};
use serde_json::{json, Value};
use std::fmt;
use std::{path::PathBuf, sync::Arc};

pub use crate::contract::{
    Cancel, Cancelled, EmbedError, EmbedKind, RerankHit, VectorSpaceIdentity,
};

/// Canonical vector-space identity and batched query/passage embeddings.
pub trait EmbeddingProvider: Send + Sync {
    /// Identity of every vector returned by this provider.
    fn identity(&self) -> &VectorSpaceIdentity;
    /// Embed a batch with the purpose-specific instruction and cancellation budget.
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError>;
    /// Drop cached outbound policy decisions after the host emits `egress.changed`.
    /// Local providers have no outbound transport and need no invalidation.
    fn invalidate_egress(&self) {}
}

/// Document reranking with a shared caller cancellation budget.
pub trait Reranker: Send + Sync {
    /// Return document indices and finite scores, ordered best first.
    fn rerank(
        &self,
        query: &str,
        docs: &[String],
        top_n: usize,
        cancel: &Cancel,
    ) -> Result<Vec<RerankHit>, RerankError>;
    /// Whether an empty successful result is meaningful for this provider.
    fn empty_result_is_valid(&self) -> bool;
    /// Drop cached outbound policy decisions, forwarding to every chained provider.
    fn invalidate_egress(&self) {}
}

/// Reranking failures without request bodies, response bodies or secret values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RerankError {
    /// The caller cancelled or its shared deadline elapsed.
    Cancelled(Cancelled),
    /// The configured provider is unavailable.
    Unavailable,
    /// Credentials were refused.
    Auth,
    /// The provider refused its rate limit.
    RateLimit,
    /// The shared provider deadline elapsed.
    Timeout,
    /// The response did not contain valid document indices and finite scores.
    InvalidResponse,
    /// A provider failed with an optional numeric HTTP status.
    ProviderFailed {
        /// Numeric status, excluding provider response content.
        status: Option<u16>,
    },
}

impl fmt::Display for RerankError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Cancelled(_) => "reranker cancelled",
            Self::Unavailable => "reranker unavailable",
            Self::Auth => "auth",
            Self::RateLimit => "rate-limit",
            Self::Timeout => "timeout",
            Self::InvalidResponse => "invalid-response",
            Self::ProviderFailed { .. } => "reranker provider failed",
        })
    }
}

impl std::error::Error for RerankError {}

/// Artifact catalogue and verified local cache lookup.
pub mod artifacts;
/// Validation of batched provider vectors.
pub mod batch;
/// Complete Node v2 cache-key construction and cache policy.
pub mod cache;
/// Canonical embedding-configuration fingerprint calculation.
pub mod fingerprint;
/// Canonical identity and fingerprint calculation.
pub mod identity;
/// Local ONNX embedding providers and process-wide sessions.
pub mod local_ort;
/// Local cross-encoder rerankers.
pub mod local_rerank;
/// Configuration normalization shared with the Node engine.
pub mod normalize;
/// Model probe coalescing and caller wait cancellation.
pub mod readiness;
/// OpenAI-compatible embedding provider over the guarded transport.
pub mod remote_openai;
/// Remote, local and chained reranking providers.
pub mod rerank;

fn invalid_config(field: &str, message: &str) -> EngineError {
    EngineError::Invalid {
        field: field.into(),
        message: message.into(),
    }
}

fn configuration(config: &EngineConfig) -> Result<Value, EngineError> {
    serde_json::to_value(config)
        .map_err(|_| invalid_config("embedding", "invalid engine configuration"))
}

fn normalized_embedding(
    config: &Value,
    host: &dyn HostServices,
) -> Result<normalize::NormalizedEmbeddingConfig, EngineError> {
    let mut raw = config
        .get("embedding")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let block = raw
        .as_object_mut()
        .ok_or_else(|| invalid_config("embedding", "embedding must be an object"))?;
    if !block.contains_key("provider") {
        if ["baseUrl", "apiKey", "apiKeyRef", "apiKeyEnv"]
            .iter()
            .any(|key| block.get(*key).is_some_and(|value| !value.is_null()))
        {
            return Err(invalid_config(
                "embedding.provider",
                "remote embeddings require an explicit provider",
            ));
        }
        block.insert("provider".into(), json!("local-transformers"));
    }
    if block.get("provider").and_then(Value::as_str) == Some("local-transformers") {
        let outer_cache = block.get("cacheDir").cloned();
        let local = block
            .entry("local")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| invalid_config("embedding.local", "local settings must be an object"))?;
        if !local.contains_key("cacheDir") {
            local.insert(
                "cacheDir".into(),
                outer_cache.unwrap_or_else(|| json!(host.state_dir().join("models"))),
            );
        }
    }
    normalize::normalize_embedding_config(&raw).map_err(|error| EngineError::Invalid {
        field: error.path,
        message: error.message,
    })
}

fn accept_nc(config: &Value) -> bool {
    config.pointer("/modelPreparation/acceptNonCommercialLicense") == Some(&Value::Bool(true))
}

fn local_cache(normalized: &normalize::NormalizedEmbeddingConfig) -> Result<PathBuf, EngineError> {
    normalized
        .pointer("/local/cacheDir")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            invalid_config(
                "embedding.local.cacheDir",
                "a literal model cache directory is required",
            )
        })
}

/// Construct a lazy local provider through the original host-borrowing interface.
/// Remote configurations require [`build_embedding_owned`]: arbitrary synchronous
/// borrowed host callbacks cannot safely be interrupted at the caller's deadline.
pub fn build_embedding(
    config: &EngineConfig,
    host: &dyn HostServices,
) -> Result<Box<dyn EmbeddingProvider>, EngineError> {
    let raw = configuration(config)?;
    let normalized = normalized_embedding(&raw, host)?;
    if normalized.provider() == "local-transformers" {
        return local_ort::build_local_embedding(
            &normalized,
            &local_cache(&normalized)?,
            accept_nc(&raw),
        );
    }
    Err(invalid_config(
        "embedding.provider",
        "remote providers require build_embedding_owned with Arc<dyn HostServices>",
    ))
}

struct HostGate(Arc<dyn HostServices>);
impl EgressGate for HostGate {
    fn decide(&self, target: &Target) -> Decision {
        self.0.egress().decide(target)
    }
}
struct HostSecrets(Arc<dyn HostServices>);
impl SecretPort for HostSecrets {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        self.0.secrets().ok_or(HostError::Unavailable)?.get(name)
    }
}

fn owned_client(host: Arc<dyn HostServices>) -> Arc<GuardedClient<'static>> {
    Arc::new(GuardedClient::new_owned(
        Arc::new(HostGate(host)),
        Box::new(SystemResolver),
    ))
}

/// Construct the complete local/remote mapping with owned live host ports.
/// Remote production services must use this factory so host-port waits can honor
/// cancellation and the single absolute request deadline without leaked borrows.
pub fn build_embedding_owned(
    config: &EngineConfig,
    host: Arc<dyn HostServices>,
) -> Result<Box<dyn EmbeddingProvider>, EngineError> {
    let raw = configuration(config)?;
    let normalized = normalized_embedding(&raw, host.as_ref())?;
    if normalized.provider() == "local-transformers" {
        return local_ort::build_local_embedding(
            &normalized,
            &local_cache(&normalized)?,
            accept_nc(&raw),
        );
    }
    let identity = identity::identity_from_value(normalized.as_value()).map_err(|error| {
        EngineError::Invalid {
            field: error.path,
            message: error.message,
        }
    })?;
    let client = owned_client(host.clone());
    Ok(Box::new(remote_openai::OpenAiEmbeddingProvider::new_owned(
        normalized.as_value(),
        identity,
        client,
        Some(Arc::new(HostSecrets(host))),
    )?))
}

const DEFAULT_LOCAL_RERANKER: &str = "woxpas-ai/bge-reranker-v2-m3-onnx";

fn non_empty(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !crate::text::js::js_trim(value).is_empty())
        .map(str::to_owned)
}

fn reranker_configuration(
    config: &Value,
    host: &dyn HostServices,
) -> Result<Option<Value>, EngineError> {
    let mut raw = config
        .get("reranker")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if raw.get("provider").and_then(Value::as_str) == Some("disabled")
        || raw.get("enabled") == Some(&Value::Bool(false))
    {
        return Ok(None);
    }
    if !raw.is_object() {
        return Err(invalid_config("reranker", "reranker must be an object"));
    }
    let credential = ["apiKey", "apiKeyEnv", "apiKeyRef"]
        .iter()
        .any(|key| raw.get(*key).is_some_and(normalize::truthy));
    let provider = non_empty(&raw, "provider").unwrap_or_else(|| {
        if credential {
            "cohere".into()
        } else if non_empty(&raw, "baseUrl").is_some() {
            "remote".into()
        } else {
            "disabled".into()
        }
    });
    if !matches!(
        provider.as_str(),
        "local-transformers" | "cohere" | "jina" | "voyage" | "remote"
    ) {
        return Ok(None);
    }
    if matches!(provider.as_str(), "cohere" | "jina" | "voyage") && !credential {
        return Ok(None);
    }
    raw["provider"] = json!(provider);
    raw["enabled"] = json!(true);
    if raw.get("timeoutMs").is_none_or(Value::is_null) {
        raw["timeoutMs"] = json!(5000);
    }
    if provider == "local-transformers" {
        let mut local = raw
            .get("local")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let model = non_empty(&local, "model")
            .or_else(|| non_empty(&raw, "model"))
            .unwrap_or_else(|| DEFAULT_LOCAL_RERANKER.into());
        local["model"] = json!(model);
        if local.get("cacheDir").is_none_or(Value::is_null) {
            local["cacheDir"] = json!(host.state_dir().join("models"));
        }
        raw["model"] = json!(model);
        raw["local"] = local;
    }
    Ok(Some(raw))
}

fn local_reranker(
    raw: &Value,
    host: &dyn HostServices,
    consent: bool,
) -> Result<Box<dyn Reranker>, EngineError> {
    let local = raw.get("local").unwrap_or(raw);
    let cache = local
        .get("cacheDir")
        .and_then(Value::as_str)
        .map_or_else(|| host.state_dir().join("models"), PathBuf::from);
    local_rerank::build_local_reranker(local, &cache, consent)
}

fn fallback_reranker(
    raw: &Value,
    host: &dyn HostServices,
    consent: bool,
) -> Result<Option<Box<dyn Reranker>>, EngineError> {
    if raw.get("fallbackProvider").and_then(Value::as_str) != Some("local-transformers") {
        return Ok(None);
    }
    let model = non_empty(raw, "fallbackModel").unwrap_or_else(|| DEFAULT_LOCAL_RERANKER.into());
    let mut fallback = json!({"model":model,"cacheDir":raw.get("fallbackCacheDir").filter(|value|!value.is_null()).cloned().unwrap_or_else(||json!(host.state_dir().join("models")))});
    if let Some(revision) = raw.get("fallbackRevision").filter(|value| !value.is_null()) {
        fallback["revision"] = revision.clone();
    }
    Ok(Some(local_reranker(&fallback, host, consent)?))
}

fn rerank_error(error: &RerankError) -> EngineError {
    match error {
        RerankError::Cancelled(reason) => EngineError::Cancelled(*reason),
        _ => EngineError::Embedding(EmbedError::ProviderFailed { status: None }),
    }
}

fn build_local_reranker_chain(
    raw: &Value,
    host: &dyn HostServices,
    consent: bool,
) -> Result<Box<dyn Reranker>, EngineError> {
    if raw.get("fallbackOnError") != Some(&Value::Bool(false))
        && raw.get("fallbackProvider").and_then(Value::as_str) == Some("local-transformers")
    {
        let primary_model = raw
            .pointer("/local/model")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_LOCAL_RERANKER);
        let fallback_model = raw
            .get("fallbackModel")
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
            .unwrap_or(DEFAULT_LOCAL_RERANKER);
        if primary_model == fallback_model {
            return Err(invalid_config(
                "reranker.fallbackModel",
                "local reranker fallback model must differ from primary",
            ));
        }
        return Ok(Box::new(rerank::chained::ChainedReranker::new(
            local_reranker(raw, host, consent)?,
            fallback_reranker(raw, host, consent)?,
        )));
    }
    local_reranker(raw, host, consent)
}

/// Construct local rerankers through the original host-borrowing interface.
/// Remote primaries, including those with local fallbacks, require [`build_reranker_owned`].
pub fn build_reranker(
    config: &EngineConfig,
    host: &dyn HostServices,
) -> Result<Option<Box<dyn Reranker>>, EngineError> {
    let config = configuration(config)?;
    let Some(raw) = reranker_configuration(&config, host)? else {
        return Ok(None);
    };
    if raw["provider"] == "local-transformers" {
        return Ok(Some(build_local_reranker_chain(
            &raw,
            host,
            accept_nc(&config),
        )?));
    }
    Err(invalid_config(
        "reranker.provider",
        "remote providers require build_reranker_owned with Arc<dyn HostServices>",
    ))
}

/// Construct Node's full local/remote/fallback mapping with owned live host ports.
/// Use this factory for remote production services, including a remote primary
/// with a local fallback; the borrowing factory never captures remote host ports.
pub fn build_reranker_owned(
    config: &EngineConfig,
    host: Arc<dyn HostServices>,
) -> Result<Option<Box<dyn Reranker>>, EngineError> {
    let config = configuration(config)?;
    let Some(raw) = reranker_configuration(&config, host.as_ref())? else {
        return Ok(None);
    };
    if raw["provider"] == "local-transformers" {
        return Ok(Some(build_local_reranker_chain(
            &raw,
            host.as_ref(),
            accept_nc(&config),
        )?));
    }
    let fallback = fallback_reranker(&raw, host.as_ref(), accept_nc(&config))?;
    let client = owned_client(host.clone());
    let secrets: Option<Arc<dyn SecretPort>> = Some(Arc::new(HostSecrets(host)));
    let primary: Box<dyn Reranker> = if raw["provider"] == "cohere" {
        Box::new(
            rerank::cohere::CohereReranker::new_owned(&raw, client, secrets)
                .map_err(|error| rerank_error(&error))?,
        )
    } else {
        Box::new(
            rerank::remote::RemoteReranker::new_owned(&raw, client, secrets)
                .map_err(|error| rerank_error(&error))?,
        )
    };
    Ok(Some(Box::new(rerank::chained::ChainedReranker::new(
        primary, fallback,
    ))))
}

#[cfg(test)]
mod factory_tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::contract::{
        testing::FakeHost, AgentId, EngineConfig, JournalBacklog, LlmPort, PlatformCapabilities,
    };
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    struct BlockingHost {
        fake: FakeHost,
        gate_blocks: bool,
        calls: AtomicUsize,
    }
    impl HostServices for BlockingHost {
        fn state_dir(&self) -> &Path {
            self.fake.state_dir()
        }
        fn config(&self) -> EngineConfig {
            self.fake.config()
        }
        fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
            self.fake.workspace_dir(agent)
        }
        fn llm(&self) -> Option<&dyn LlmPort> {
            None
        }
        fn secrets(&self) -> Option<&dyn SecretPort> {
            Some(self)
        }
        fn egress(&self) -> &dyn EgressGate {
            self
        }
        fn emit(&self, event: &str, payload: Value) {
            self.fake.emit(event, payload);
        }
        fn now_ms(&self) -> i64 {
            self.fake.now_ms()
        }
        fn platform(&self) -> &PlatformCapabilities {
            self.fake.platform()
        }
        fn journal_backlog(&self) -> Option<JournalBacklog> {
            self.fake.journal_backlog()
        }
    }
    impl SecretPort for BlockingHost {
        fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
            if !self.gate_blocks {
                self.calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(500));
            }
            SecretPort::get(&self.fake, name)
        }
    }
    impl EgressGate for BlockingHost {
        fn decide(&self, target: &Target) -> Decision {
            if self.gate_blocks {
                self.calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(500));
            }
            EgressGate::decide(&self.fake, target)
        }
    }

    #[test]
    fn factories_construct_local_defaults_without_loading_models() {
        let root = tempfile::tempdir().unwrap();
        let config: EngineConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        let host = FakeHost::new(root.path().into(), config.clone());
        let provider = build_embedding(&config, &host).unwrap();
        assert_eq!(provider.identity().model, "intfloat/multilingual-e5-small");
        assert_eq!(provider.identity().dimension.as_u64(), Some(384));
        assert!(build_reranker(&config, &host).unwrap().is_none());
    }

    #[test]
    fn factories_preserve_jina_profile_and_require_explicit_consent() {
        let root = tempfile::tempdir().unwrap();
        let raw = serde_json::json!({"embedding":{"provider":"local-transformers","local":{"model":"jinaai/jina-embeddings-v3","dimensions":64}}});
        let config: EngineConfig = serde_json::from_value(raw.clone()).unwrap();
        let host = FakeHost::new(root.path().into(), config.clone());
        assert!(build_embedding(&config, &host).is_err());
        let mut accepted = raw;
        accepted["modelPreparation"] = serde_json::json!({"profile":"jina-v3-multilingual-64","acceptNonCommercialLicense":true});
        let config: EngineConfig = serde_json::from_value(accepted).unwrap();
        let provider = build_embedding(&config, &host).unwrap();
        assert_eq!(provider.identity().model, "jinaai/jina-embeddings-v3");
        assert_eq!(provider.identity().dimension.as_u64(), Some(64));
    }

    #[test]
    fn factories_retain_owned_host_ports_and_disabled_reranker_semantics() {
        let root = tempfile::tempdir().unwrap();
        let config:EngineConfig=serde_json::from_value(serde_json::json!({"embedding":{"provider":"openai-compatible","model":"fixture-model","dimensions":3,"baseUrl":"http://127.0.0.1:1/v1","apiKeyRef":"embedding-key"},"reranker":{"provider":"jina"}})).unwrap();
        let host = Arc::new(FakeHost::new(root.path().into(), config.clone()));
        host.set_secret("embedding-key", "test-only-fixture");
        let provider = build_embedding_owned(&config, host.clone()).unwrap();
        assert_eq!(provider.identity().model, "fixture-model");
        assert!(
            build_reranker_owned(&config, host).unwrap().is_none(),
            "hosted reranker with no configured credential is disabled by Node normalization"
        );
    }

    #[test]
    fn borrowed_embedding_factory_refuses_remote_and_names_the_owned_factory() {
        let root = tempfile::tempdir().unwrap();
        let config: EngineConfig = serde_json::from_value(json!({
            "embedding": { "provider": "openai", "model": "text-embedding-3-small", "dimensions": 3,
                "baseUrl": "http://127.0.0.1:1/v1", "apiKeyRef": "fixture-key" }
        }))
        .unwrap();
        let host = FakeHost::new(root.path().into(), config.clone());
        host.set_secret("fixture-key", "test-only-fixture");
        assert!(matches!(build_embedding(&config, &host),
            Err(EngineError::Invalid { field, message })
            if field == "embedding.provider" && message.contains("build_embedding_owned")));
    }

    #[test]
    fn borrowed_reranker_factory_refuses_remote_even_with_a_local_fallback() {
        let root = tempfile::tempdir().unwrap();
        for provider in ["remote", "cohere", "jina", "voyage"] {
            let config: EngineConfig = serde_json::from_value(json!({
                "reranker": { "provider": provider, "baseUrl": "http://127.0.0.1:1/v1",
                    "apiKeyRef": "fixture-key", "fallbackProvider": "local-transformers",
                    "fallbackModel": "woxpas-ai/bge-reranker-v2-m3-onnx" }
            }))
            .unwrap();
            let host = Arc::new(FakeHost::new(root.path().into(), config.clone()));
            host.set_secret("fixture-key", "test-only-fixture");
            assert!(matches!(build_reranker(&config, host.as_ref()),
                Err(EngineError::Invalid { field, message })
                if field == "reranker.provider" && message.contains("build_reranker_owned")));
            assert!(build_reranker_owned(&config, host).unwrap().is_some());
        }
    }

    #[test]
    fn owned_factories_bound_a_blocking_host_gate_or_secret_to_the_callers_deadline() {
        let root = tempfile::tempdir().unwrap();
        let config: EngineConfig = serde_json::from_value(json!({
            "embedding": { "provider": "openai", "model": "text-embedding-3-small", "dimensions": 3,
                "baseUrl": "http://127.0.0.1:1/v1", "apiKeyRef": "fixture-key" },
            "reranker": { "provider": "remote", "baseUrl": "http://127.0.0.1:1/v1",
                "apiKeyRef": "fixture-key" }
        }))
        .unwrap();
        for gate_blocks in [true, false] {
            let fake = FakeHost::new(root.path().into(), config.clone());
            fake.set_secret("fixture-key", "test-only-fixture");
            let host = Arc::new(BlockingHost {
                fake,
                gate_blocks,
                calls: AtomicUsize::new(0),
            });
            let provider = build_embedding_owned(&config, host.clone()).unwrap();
            let start = Instant::now();
            let cancel = Cancel::with_deadline(start + Duration::from_millis(50));
            assert!(provider
                .embed(&["query".into()], EmbedKind::Query, &cancel)
                .is_err());
            assert!(
                start.elapsed() < Duration::from_millis(300),
                "a 500ms host callback held the 50ms embedding call"
            );
            let reranker = build_reranker_owned(&config, host.clone())
                .unwrap()
                .unwrap();
            let start = Instant::now();
            let cancel = Cancel::with_deadline(start + Duration::from_millis(50));
            assert!(reranker
                .rerank("query", &["document".into()], 1, &cancel)
                .is_err());
            assert!(
                start.elapsed() < Duration::from_millis(300),
                "a 500ms host callback held the 50ms rerank call"
            );
            assert_eq!(host.calls.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn local_compatibility_factories_do_not_retain_host_borrows() {
        let root = tempfile::tempdir().unwrap();
        let config: EngineConfig = serde_json::from_value(json!({
            "reranker": { "provider": "local-transformers" }
        }))
        .unwrap();
        let (provider, reranker) = {
            let host = FakeHost::new(root.path().into(), config.clone());
            (
                build_embedding(&config, &host).unwrap(),
                build_reranker(&config, &host).unwrap(),
            )
        };
        assert_eq!(provider.identity().model, "intfloat/multilingual-e5-small");
        assert!(reranker.is_some());
        assert!(
            serde_json::from_value::<EngineConfig>(json!({
                "reranker": { "provider": "local-transformers", "fallbackProvider": "remote" }
            }))
            .is_err(),
            "the contract must reject unsupported remote fallbacks before factory construction"
        );
    }

    #[test]
    fn local_reranker_fallback_cannot_repeat_the_primary_model() {
        let root = tempfile::tempdir().unwrap();
        let config:EngineConfig=serde_json::from_value(serde_json::json!({"reranker":{"provider":"local-transformers","local":{"model":"woxpas-ai/bge-reranker-v2-m3-onnx"},"fallbackProvider":"local-transformers","fallbackModel":"woxpas-ai/bge-reranker-v2-m3-onnx"}})).unwrap();
        let host = FakeHost::new(root.path().into(), config.clone());
        assert!(build_reranker(&config, &host).is_err());
    }
}
/// Deterministic unit-vector test provider.
pub mod seam;
/// Engine embedding and model-readiness services.
pub mod service;
