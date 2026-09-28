//! Why a package is refused: an `ErrorCode` name, a frozen or X1 `reason` string (X1-R4) and a human detail. The RPC
//! and CLI layers turn it into `error.data.{error,reason}` and `error/1` unchanged.

/// A refusal of a package or one of its entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// The `ErrorCode` name, e.g. `E_INVALID_PARAMS`.
    pub code: &'static str,
    /// One of [`reason`].
    pub reason: &'static str,
    /// What exactly was wrong, for the person (never parsed).
    pub detail: String,
}

impl Refusal {
    /// `E_INVALID_PARAMS` with `reason`: the package is at fault.
    pub fn invalid(reason: &'static str, detail: impl Into<String>) -> Self {
        Refusal {
            code: "E_INVALID_PARAMS",
            reason,
            detail: detail.into(),
        }
    }

    /// `E_INTERNAL reason=io`: reading the package failed for a reason other than its content (the convention of
    /// `modules::install::InstallError::Io`).
    pub fn io(e: &std::io::Error) -> Self {
        Refusal {
            code: "E_INTERNAL",
            reason: "io",
            detail: e.to_string(),
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.code, self.reason, self.detail)
    }
}

impl std::error::Error for Refusal {}

/// Reason strings. The `archive-*`, `download-too-large`, `digest-mismatch` and `reserved-name` names are the frozen
/// ⟂EXT 2 vocabulary (X1-R4); the others are new in X1.
pub mod reason {
    pub const PACKAGE_INVALID: &str = "package-invalid";
    pub const SIGNATURE_INVALID: &str = "signature-invalid";
    pub const SCRIPTS_MISMATCH: &str = "scripts-mismatch";
    pub const INCOMPATIBLE: &str = "incompatible";
    /// Unsafe name, symlink, hard link, special file or explicit directory entry.
    pub const UNSAFE_ENTRY: &str = "archive-unsafe-entry";
    /// A ZIP feature `.p1x` does not allow (§5.1).
    pub const UNSUPPORTED: &str = "archive-unsupported";
    /// Any size, count or ratio cap.
    pub const TOO_LARGE: &str = "download-too-large";
    /// A per-entry or whole-file hash, size or CRC mismatch.
    pub const DIGEST: &str = "digest-mismatch";
    pub const RESERVED: &str = "reserved-name";
    pub const KIND_UNSUPPORTED: &str = "kind-unsupported";
}
