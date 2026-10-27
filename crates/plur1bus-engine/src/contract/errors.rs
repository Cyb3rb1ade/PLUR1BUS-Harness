//! Typed failures with bounded, body-free diagnostic formatting.

use std::collections::BTreeMap;
use std::fmt;
use std::io;

use super::{Cancelled, MemoryOpErrorCode};

/// Store failures represented without filesystem contents or backend response bodies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StoreError {
    /// The store's vector-space identity differs from the expected identity.
    IdentityMismatch,
    /// A required store is unavailable.
    Unavailable,
    /// Persisted store metadata failed validation.
    Corrupt,
    /// Another writer owns the store lock.
    Busy,
    /// A filesystem operation failed with this bounded standard-library error kind.
    Io {
        /// The filesystem error category, without paths or operating-system messages.
        kind: io::ErrorKind,
    },
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::IdentityMismatch => "vector-space identity mismatch",
            Self::Unavailable => "store unavailable",
            Self::Corrupt => "invalid persisted metadata",
            Self::Busy => "store is busy",
            Self::Io { .. } => "filesystem operation failed",
        })
    }
}
impl std::error::Error for StoreError {}

/// Embedding failures without provider bodies, prompts or credentials.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EmbedError {
    /// The operation ended through caller cancellation or its deadline.
    Cancelled(Cancelled),
    /// No embedding provider is available.
    Unavailable,
    /// The provider request failed; only its numeric HTTP status may be retained.
    ProviderFailed {
        /// The HTTP status when the provider returned one.
        status: Option<u16>,
    },
    /// The provider returned an empty or non-finite vector.
    InvalidVector,
    /// The returned vector's width differs from the requested vector space.
    DimensionMismatch {
        /// Required vector width.
        expected: usize,
        /// Returned vector width.
        actual: usize,
    },
}

impl fmt::Display for EmbedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(reason) => write!(formatter, "cancelled: {reason}"),
            Self::Unavailable => formatter.write_str("embedding provider unavailable"),
            Self::ProviderFailed { .. } => formatter.write_str("embedding provider failed"),
            Self::InvalidVector => formatter.write_str("invalid embedding vector"),
            Self::DimensionMismatch { expected, actual } => {
                write!(
                    formatter,
                    "vector dimension mismatch (expected {expected}, got {actual})"
                )
            }
        }
    }
}
impl std::error::Error for EmbedError {}

/// Host callback failures without provider responses or secret values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostError {
    /// The operation ended through caller cancellation or its deadline.
    Cancelled(Cancelled),
    /// The required host port is unavailable, including while the core is down.
    Unavailable,
    /// Host policy denied the operation.
    Denied,
    /// A host response did not satisfy its contract.
    InvalidResponse,
    /// A host operation failed without a safe finer-grained category.
    Failed,
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(reason) => write!(formatter, "cancelled: {reason}"),
            Self::Unavailable => formatter.write_str("host service unavailable"),
            Self::Denied => formatter.write_str("host policy denied the operation"),
            Self::InvalidResponse => formatter.write_str("invalid host response"),
            Self::Failed => formatter.write_str("host operation failed"),
        }
    }
}
impl std::error::Error for HostError {}

impl From<Cancelled> for HostError {
    fn from(value: Cancelled) -> Self {
        Self::Cancelled(value)
    }
}

/// A bounded machine identifier that may be used for non-secret recovery details.
/// Callers must supply identifiers, never credentials, provider messages or text bodies.
#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub struct ErrorId(String);

impl ErrorId {
    /// Accept at most 128 ASCII identifier characters; reject text and control characters.
    pub fn new(value: &str) -> Option<Self> {
        (!value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte)))
        .then(|| Self(value.to_owned()))
    }

    /// Read this recovery identifier explicitly.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A memory-operation failure with a stable schema-defined code and bounded recovery ids.
#[derive(Clone)]
pub struct MemoryOpError {
    /// Stable reason code; not-found also covers hidden and tombstoned cards.
    pub code: MemoryOpErrorCode,
    detail: BTreeMap<ErrorId, ErrorId>,
}

impl MemoryOpError {
    /// Create a failure with no recovery identifiers.
    pub fn new(code: MemoryOpErrorCode) -> Self {
        Self {
            code,
            detail: BTreeMap::new(),
        }
    }

    /// Add a bounded recovery identifier, retaining at most sixteen entries.
    pub fn with_detail(mut self, name: ErrorId, value: ErrorId) -> Self {
        if self.detail.len() < 16 || self.detail.contains_key(&name) {
            self.detail.insert(name, value);
        }
        self
    }

    /// Access non-secret recovery identifiers without formatting them into diagnostics.
    pub fn detail(&self) -> &BTreeMap<ErrorId, ErrorId> {
        &self.detail
    }
}

impl fmt::Display for MemoryOpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code)
    }
}
impl fmt::Debug for MemoryOpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "MemoryOpError({self})")
    }
}
impl std::error::Error for MemoryOpError {}

/// The engine's typed public error boundary. Diagnostics contain only fixed categories
/// and typed numeric metadata, never caller text, provider bodies or secret values.
pub enum EngineError {
    /// Caller cancellation or deadline expiry.
    Cancelled(Cancelled),
    /// A persistent-store failure.
    Store(StoreError),
    /// An embedding-provider failure.
    Embedding(EmbedError),
    /// A host callback failure.
    Host(HostError),
    /// An ACL-filtered memory-operation failure.
    MemoryOp(MemoryOpError),
    /// An unavailable capability. Diagnostic formatting does not echo this reason.
    NotAvailable {
        /// Internal reason retained for programmatic handling, never formatted.
        reason: String,
    },
    /// Invalid input. Diagnostic formatting does not echo caller-controlled input.
    Invalid {
        /// The input field, retained for programmatic handling, never formatted.
        field: String,
        /// The validation detail, retained for programmatic handling, never formatted.
        message: String,
    },
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(error) => write!(formatter, "cancelled: {error}"),
            Self::Store(error) => write!(formatter, "store: {error}"),
            Self::Embedding(error) => write!(formatter, "embedding: {error}"),
            Self::Host(error) => write!(formatter, "host: {error}"),
            Self::MemoryOp(error) => write!(formatter, "memory-op: {error}"),
            Self::NotAvailable { .. } => {
                formatter.write_str("not-available: required capability unavailable")
            }
            Self::Invalid { .. } => formatter.write_str("invalid: input validation failed"),
        }
    }
}

impl fmt::Debug for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "EngineError({self})")
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Cancelled(error) => Some(error),
            Self::Store(error) => Some(error),
            Self::Embedding(error) => Some(error),
            Self::Host(error) => Some(error),
            Self::MemoryOp(error) => Some(error),
            Self::NotAvailable { .. } | Self::Invalid { .. } => None,
        }
    }
}

impl From<Cancelled> for EngineError {
    fn from(value: Cancelled) -> Self {
        Self::Cancelled(value)
    }
}

impl From<StoreError> for EngineError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}
impl From<EmbedError> for EngineError {
    fn from(value: EmbedError) -> Self {
        Self::Embedding(value)
    }
}
impl From<HostError> for EngineError {
    fn from(value: HostError) -> Self {
        Self::Host(value)
    }
}
impl From<MemoryOpError> for EngineError {
    fn from(value: MemoryOpError) -> Self {
        Self::MemoryOp(value)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::contract::CancelReason;

    #[test]
    fn engine_diagnostics_never_echo_untrusted_reason_or_invalid_text() {
        let body = "Bearer-secret-credential-private-prompt";
        let errors = [
            EngineError::NotAvailable {
                reason: body.into(),
            },
            EngineError::Invalid {
                field: body.into(),
                message: body.repeat(1000),
            },
        ];
        for error in errors {
            assert!(!error.to_string().contains(body));
            assert!(!format!("{error:?}").contains(body));
            assert!(error.to_string().len() <= 128);
        }
    }

    #[test]
    fn caller_cancellation_preserves_the_typed_reason() {
        let error = EngineError::from(Cancelled {
            reason: CancelReason::Caller,
        });
        assert!(matches!(
            error,
            EngineError::Cancelled(Cancelled {
                reason: CancelReason::Caller
            })
        ));
        assert_eq!(error.to_string(), "cancelled: caller");
    }
}
