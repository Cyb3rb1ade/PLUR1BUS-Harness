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
                write!(
                    f,
                    "{}: {message}",
                    serde_json::to_value(error)
                        .unwrap()
                        .as_str()
                        .unwrap_or("E_INTERNAL")
                )?;
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
            RpcError::Call { error, .. } => serde_json::to_value(error)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
            RpcError::Unavailable { .. } => "E_CORE_UNAVAILABLE".into(),
            RpcError::Version { .. } => "E_RPC_VERSION".into(),
            RpcError::Protocol(_) => "E_INTERNAL".into(),
        }
    }
}
