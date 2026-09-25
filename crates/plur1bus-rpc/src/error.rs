use crate::types::ErrorCode;
use std::fmt;

#[derive(Debug)]
pub enum RpcError {
    Call {
        error: ErrorCode,
        jsonrpc: i64,
        message: String,
        reason: Option<String>,
        detail: Option<String>,
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
