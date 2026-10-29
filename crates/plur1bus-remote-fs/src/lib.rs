//! Read-only SSH/SFTP transport for the reusable remote-fs source port (M v2, E1–E8).
//! Authentication follows host-key pinning; no raw SSH client, write method or execution channel is exposed.
mod connection;
pub mod protocol;
mod session;
mod worker;

pub use protocol::{HostIdentity, Metadata};
pub use session::ReadonlySession;
pub use worker::run_worker;

/// Fixed failures never carry backend errors, paths, credentials or file contents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Closed wire/configuration validation failed.
    InvalidRequest,
    /// The supplied host key differs from the authenticated server key.
    HostKeyMismatch,
    /// The numeric endpoint could not complete SSH setup.
    Unavailable,
    /// Public-key authentication was refused.
    Authentication,
    /// The absolute run deadline expired.
    Timeout,
    /// A file, aggregate, packet, entry, operation or metadata budget was exceeded.
    Limit,
    /// A filesystem path was malformed or too deep.
    PathDenied,
    /// The server reports an absent path.
    NotFound,
    /// The server denied access.
    PermissionDenied,
    /// A special file cannot be read.
    UnsupportedType,
    /// The server violated the expected bounded SFTP protocol.
    Protocol,
}

impl Failure {
    /// Stable native wire reason; no server-provided text is included.
    pub fn reason(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::HostKeyMismatch => "host-key-mismatch",
            Self::Unavailable => "unavailable",
            Self::Authentication => "authentication-failed",
            Self::Timeout => "timeout",
            Self::Limit => "limit-exceeded",
            Self::PathDenied => "path-denied",
            Self::NotFound => "not-found",
            Self::PermissionDenied => "permission-denied",
            Self::UnsupportedType => "unsupported-type",
            Self::Protocol => "remote-protocol",
        }
    }

    /// Stable error code, shared with the existing Harness vocabulary.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest | Self::Limit | Self::PathDenied | Self::UnsupportedType => {
                "E_INVALID_PARAMS"
            }
            Self::HostKeyMismatch | Self::Authentication | Self::PermissionDenied => "E_DENIED",
            Self::NotFound => "E_NOT_FOUND",
            Self::Timeout | Self::Unavailable | Self::Protocol => "E_NOT_AVAILABLE",
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason())
    }
}
impl std::error::Error for Failure {}
