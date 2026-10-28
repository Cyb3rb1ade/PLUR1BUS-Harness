//! Remote rerank protocols, safe provider failures and ordered fallback.
pub mod chained;
pub mod cohere;
pub mod remote;
pub mod signal;

/// Shared provider taxonomy, using the names from packages/providers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderErrorKind {
    /// Missing or rejected credentials.
    Auth,
    /// Rate or quota limit.
    RateLimit,
    /// Provider overload or server failure.
    Overloaded,
    /// Input exceeds a context limit.
    ContextLength,
    /// Malformed or refused request.
    InvalidRequest,
    /// DNS, connection or policy transport failure.
    Network,
    /// Shared request deadline expired.
    Timeout,
    /// Caller cancellation.
    Aborted,
    /// Malformed response or unclassified failure.
    Unknown,
}
impl ProviderErrorKind {
    /// The exact packages/providers machine name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimit => "rate_limit",
            Self::Overloaded => "overloaded",
            Self::ContextLength => "context_length",
            Self::InvalidRequest => "invalid_request",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Aborted => "aborted",
            Self::Unknown => "unknown",
        }
    }
}

/// Body-free provider failure; code is engine-selected, never copied from a response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderError {
    /// Normalized provider failure category.
    pub kind: ProviderErrorKind,
    /// Numeric HTTP response status, when available.
    pub status: Option<u16>,
    /// Stable local code, including protocol for invalid responses.
    pub code: Option<&'static str>,
}
impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.kind.as_str())
    }
}
impl std::error::Error for ProviderError {}

impl ProviderError {
    /// A malformed response, named unknown/protocol by packages/providers.
    pub fn invalid_response() -> Self {
        Self {
            kind: ProviderErrorKind::Unknown,
            status: None,
            code: Some("protocol"),
        }
    }
    pub(crate) fn simple(kind: ProviderErrorKind) -> Self {
        Self {
            kind,
            status: None,
            code: None,
        }
    }
    pub(crate) fn http(status: u16, body: &[u8]) -> Self {
        let text = String::from_utf8_lossy(body);
        let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
        let inner = parsed.as_ref().map(|value| {
            value
                .get("error")
                .filter(|value| value.is_object() || value.is_string())
                .unwrap_or(value)
        });
        let code = inner
            .and_then(|v| v.get("code"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let message = inner
            .and_then(|value| {
                value
                    .as_str()
                    .or_else(|| value.get("message").and_then(serde_json::Value::as_str))
                    .or_else(|| value.get("detail").and_then(serde_json::Value::as_str))
            })
            .unwrap_or_else(|| if parsed.is_none() { text.trim() } else { "" })
            .to_ascii_lowercase();
        let kind = match status {
            401..=403 => ProviderErrorKind::Auth,
            408 => ProviderErrorKind::Timeout,
            _ if status == 429 || code == "rate_limit_exceeded" => ProviderErrorKind::RateLimit,
            500.. => ProviderErrorKind::Overloaded,
            400..
                if matches!(
                    code.as_str(),
                    "context_length_exceeded" | "model_context_window_exceeded"
                ) || context_message(&message) =>
            {
                ProviderErrorKind::ContextLength
            }
            400.. => ProviderErrorKind::InvalidRequest,
            _ => ProviderErrorKind::Unknown,
        };
        Self {
            kind,
            status: Some(status),
            code: (300..400).contains(&status).then_some("redirect"),
        }
    }
    pub(crate) fn into_rerank(self) -> crate::embedding::RerankError {
        use crate::embedding::RerankError;
        match self.kind {
            ProviderErrorKind::Auth => RerankError::Auth,
            ProviderErrorKind::RateLimit => RerankError::RateLimit,
            ProviderErrorKind::Timeout => RerankError::Timeout,
            ProviderErrorKind::Unknown if self.code == Some("protocol") => {
                RerankError::InvalidResponse
            }
            _ => RerankError::ProviderFailed {
                status: self.status,
            },
        }
    }
}

fn context_message(message: &str) -> bool {
    [
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "prompt is too long",
        "reduce the length of the messages",
        "exceeds the context",
        "exceeds the token",
        "exceeds the maximum context",
        "exceeds the maximum token",
        "exceeds the model's context",
        "exceeds the model's token",
        "exceeds the model's maximum context",
        "exceeds the model's maximum token",
    ]
    .iter()
    .any(|phrase| message.contains(phrase))
}
impl From<crate::transport::TransportError> for ProviderError {
    fn from(error: crate::transport::TransportError) -> Self {
        use crate::transport::TransportError;
        match error {
            TransportError::ResponseBody { status, failure } => {
                if failure == crate::transport::ResponseBodyFailure::Timeout {
                    Self {
                        kind: ProviderErrorKind::Timeout,
                        status: Some(status),
                        code: None,
                    }
                } else {
                    Self::http(status, &[])
                }
            }
            TransportError::Timeout => Self::simple(ProviderErrorKind::Timeout),
            TransportError::ResponseTooLarge => Self::invalid_response(),
            TransportError::InvalidRequest | TransportError::Redirect => {
                Self::simple(ProviderErrorKind::InvalidRequest)
            }
            TransportError::Denied | TransportError::AddressDenied | TransportError::Network => {
                Self::simple(ProviderErrorKind::Network)
            }
        }
    }
}

pub(crate) enum SecretStore<'a> {
    Borrowed(&'a dyn crate::contract::SecretPort),
    Owned(std::sync::Arc<dyn crate::contract::SecretPort>),
}
impl SecretStore<'_> {
    fn get(
        &self,
        name: &str,
        deadline: std::time::Instant,
    ) -> Result<Option<crate::contract::SecretValue>, ProviderError> {
        let result = match self {
            Self::Borrowed(port) => port.get(name),
            Self::Owned(port) => {
                let port = port.clone();
                let name = name.to_owned();
                crate::transport::guarded::bounded(deadline, move || port.get(&name))
                    .map_err(ProviderError::from)?
            }
        };
        budget_left(deadline)?;
        result.map_err(|_| ProviderError::simple(ProviderErrorKind::Auth))
    }
}

pub(crate) struct Credential<'a> {
    name: Option<String>,
    store: Option<SecretStore<'a>>,
    generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    value: std::sync::Mutex<Option<CachedCredential>>,
}
struct CachedCredential {
    expires: std::time::Instant,
    generation: u64,
    value: crate::contract::SecretValue,
}
impl<'a> Credential<'a> {
    pub(crate) fn new(
        config: &serde_json::Value,
        default: Option<&str>,
        store: Option<SecretStore<'a>>,
    ) -> Result<Self, ProviderError> {
        // apiKeyEnv remains a secret NAME for compatibility; this module never reads environment values.
        let name = config
            .get("apiKeyRef")
            .filter(|v| !v.is_null() && v.as_str() != Some(""))
            .or_else(|| {
                config
                    .get("apiKeyEnv")
                    .filter(|v| !v.is_null() && v.as_str() != Some(""))
            })
            .map(|v| {
                v.as_str()
                    .map(str::trim)
                    .ok_or_else(|| ProviderError::simple(ProviderErrorKind::Auth))
            })
            .transpose()?
            .or(default)
            .map(str::to_owned);
        if name.as_ref().is_some_and(|name| {
            name.is_empty()
                || name.len() > 256
                || !name.as_bytes()[0].is_ascii_alphanumeric()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:/@-".contains(&b))
        }) {
            return Err(ProviderError::simple(ProviderErrorKind::Auth));
        }
        Ok(Self {
            name,
            store,
            generation: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            value: std::sync::Mutex::new(None),
        })
    }
    pub(crate) fn authorization(
        &self,
        deadline: std::time::Instant,
    ) -> Result<Option<String>, ProviderError> {
        use std::sync::{atomic::Ordering, TryLockError};
        budget_left(deadline)?;
        let Some(name) = &self.name else {
            return Ok(None);
        };
        let mut cache = loop {
            match self.value.try_lock() {
                Ok(cache) => break cache,
                Err(TryLockError::Poisoned(error)) => break error.into_inner(),
                Err(TryLockError::WouldBlock) => std::thread::sleep(
                    budget_left(deadline)?.min(std::time::Duration::from_millis(1)),
                ),
            }
        };
        let generation = self.generation.load(Ordering::Acquire);
        if cache.as_ref().is_none_or(|cached| {
            std::time::Instant::now() >= cached.expires || cached.generation != generation
        }) {
            let value = self
                .store
                .as_ref()
                .ok_or_else(|| ProviderError::simple(ProviderErrorKind::Auth))?
                .get(name, deadline)?
                .ok_or_else(|| ProviderError::simple(ProviderErrorKind::Auth))?;
            if value.expose().trim().is_empty() {
                return Err(ProviderError::simple(ProviderErrorKind::Auth));
            }
            budget_left(deadline)?;
            if self.generation.load(Ordering::Acquire) != generation {
                return Ok(Some(format!("Bearer {}", value.expose().trim())));
            }
            *cache = Some(CachedCredential {
                expires: std::time::Instant::now() + std::time::Duration::from_secs(60),
                generation,
                value,
            });
        }
        budget_left(deadline)?;
        Ok(cache
            .as_ref()
            .map(|cached| format!("Bearer {}", cached.value.expose().trim())))
    }
    pub(crate) fn rejection_counter(&self) -> Option<std::sync::Arc<std::sync::atomic::AtomicU64>> {
        self.name.as_ref().map(|_| self.generation.clone())
    }
}

fn budget_left(deadline: std::time::Instant) -> Result<std::time::Duration, ProviderError> {
    deadline
        .checked_duration_since(std::time::Instant::now())
        .filter(|budget| !budget.is_zero())
        .ok_or_else(|| ProviderError::simple(ProviderErrorKind::Timeout))
}
