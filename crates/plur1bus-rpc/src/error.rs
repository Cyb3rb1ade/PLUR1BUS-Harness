use crate::types::ErrorCode;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug)]
pub enum RpcError {
    Call {
        error: ErrorCode,
        jsonrpc: i64,
        message: String,
        reason: Option<String>,
        detail: Option<String>,
        /// `error.data.ids`: non-secret ids a caller needs to recover (e.g. a half-finished shared-copy refresh).
        /// Boxed, with `ext`, so `RpcError` stays small (clippy `result_large_err`).
        ids: Option<Box<BTreeMap<String, String>>>,
        /// `error.data.ext` (X1-C19): what an `ext.*` refusal must show, e.g. an install's inspection, the capabilities
        /// an enable needs acknowledged, the dependents that block an uninstall, the paths that no longer match.
        ext: Option<Box<serde_json::Value>>,
    },
    Unavailable {
        reason: String,
        detail: String,
    },
    Version {
        server: String,
    },
    Protocol(String),
}

/// Media-index codes of the closed set (the generated `ErrorCode` carries them; the CLI exits 1 for each, see docs/errors.md):
/// `E_MEDIA_CAPABILITY`, `E_MEDIA_LICENSE`, `E_MEDIA_PRIVACY`, `E_MEDIA_UNAVAILABLE`, `E_MEDIA_DIMENSION`, `E_MEDIA_UNSUPPORTED_KIND`.
/// The wire name of a closed error code. `ErrorCode` is a generated string enum, so serialising it cannot fail; the
/// fallback only keeps a future non-string variant from panicking the CLI.
fn error_name(error: &ErrorCode) -> String {
    serde_json::to_value(error)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "E_INTERNAL".to_string())
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcError::Call {
                error,
                message,
                reason,
                detail,
                ..
            } => {
                write!(f, "{}: {message}", error_name(error))?;
                if let Some(r) = reason {
                    write!(f, " ({r})")?;
                }
                if let Some(d) = detail {
                    write!(f, ": {d}")?;
                }
                Ok(())
            }
            RpcError::Unavailable { reason, detail } => {
                write!(f, "core unavailable ({reason}): {detail}")
            }
            RpcError::Version { server } => write!(
                f,
                "rpc version mismatch: server {server}, client {}.x",
                crate::SUPPORTED_RPC_MAJOR
            ),
            RpcError::Protocol(s) => write!(f, "protocol error: {s}"),
        }
    }
}
impl std::error::Error for RpcError {}

impl From<std::io::Error> for RpcError {
    fn from(e: std::io::Error) -> Self {
        // Bytes the core sent that are not valid (e.g. not UTF-8) are a protocol fault, not an unavailable core.
        if e.kind() == std::io::ErrorKind::InvalidData {
            return RpcError::Protocol(e.to_string());
        }
        let reason = match e.kind() {
            std::io::ErrorKind::NotFound => "core-unavailable",
            std::io::ErrorKind::ConnectionRefused => "core-unavailable",
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "call-timeout",
            _ => "io",
        };
        RpcError::Unavailable {
            reason: reason.into(),
            detail: e.to_string(),
        }
    }
}

pub fn is_unavailable(e: &RpcError) -> bool {
    matches!(e, RpcError::Unavailable { .. })
}

impl RpcError {
    /// `error.data.ids` of a `Call` error, when the core sent any.
    pub fn ids(&self) -> Option<&BTreeMap<String, String>> {
        match self {
            RpcError::Call { ids, .. } => ids.as_deref(),
            _ => None,
        }
    }

    /// `error.data.ext` of a `Call` error (X1-C19), when the server sent one.
    pub fn ext(&self) -> Option<&serde_json::Value> {
        match self {
            RpcError::Call { ext, .. } => ext.as_deref(),
            _ => None,
        }
    }

    /// The closed error name for `--json` output and exit-code mapping.
    pub fn code_name(&self) -> String {
        match self {
            RpcError::Call { error, .. } => error_name(error),
            RpcError::Unavailable { .. } => "E_CORE_UNAVAILABLE".into(),
            RpcError::Version { .. } => "E_RPC_VERSION".into(),
            RpcError::Protocol(_) => "E_INTERNAL".into(),
        }
    }
}
