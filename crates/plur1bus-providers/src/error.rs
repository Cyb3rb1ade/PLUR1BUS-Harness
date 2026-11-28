use serde::Serialize;
use serde_json::Value;
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Auth,
    RateLimit,
    Overloaded,
    ContextLength,
    InvalidRequest,
    Network,
    Timeout,
    Aborted,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeoutPhase {
    Headers,
    Idle,
    Total,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: Box<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_phase: Option<TimeoutPhase>,
    pub retryable: bool,
    pub content_filtered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<Box<Value>>,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into().into_boxed_str(),
            code: None,
            status: None,
            provider_type: None,
            provider_message: None,
            retry_after_ms: None,
            timeout_phase: None,
            retryable: matches!(
                kind,
                ErrorKind::RateLimit
                    | ErrorKind::Overloaded
                    | ErrorKind::Network
                    | ErrorKind::Timeout
            ),
            content_filtered: false,
            partial: None,
        }
    }

    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        let mut error = Self::new(ErrorKind::Unknown, message);
        error.code = Some("protocol".into());
        error
    }

    pub(crate) fn invalid(message: impl fmt::Display) -> Self {
        Self::new(
            ErrorKind::InvalidRequest,
            format!("invalid request: {message}"),
        )
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}
