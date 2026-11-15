//! The failure type of the secret store (`SecretError` and `SecretErrorCode` of `secrets/types.ts`). Messages are fixed text
//! built from codes and secret *names* only (a name is metadata, never a value); every message the ported code raises is a
//! constructor here, byte for byte as TypeScript words it.
use super::leases::MAX_LEASE_TTL_MS;
use super::types::{MAX_DESCRIPTION_CHARS, MAX_VALUE_BYTES};
use serde_json::{json, Value};

/// The closed vocabulary of the secret store (`SecretErrorCode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretErrorCode {
    /// `denied`
    Denied,
    /// `not-found`
    NotFound,
    /// `invalid-name`
    InvalidName,
    /// `invalid-value`
    InvalidValue,
    /// `invalid-description`
    InvalidDescription,
    /// `invalid-ttl`
    InvalidTtl,
    /// `no-backend`
    NoBackend,
    /// `backend-unavailable`
    BackendUnavailable,
    /// `corrupt`
    Corrupt,
    /// `storage`
    Storage,
    /// `audit-unavailable`
    AuditUnavailable,
    /// `lease-invalid`
    LeaseInvalid,
}

impl SecretErrorCode {
    /// Every code, in the order of the TypeScript union.
    pub const ALL: [SecretErrorCode; 12] = [
        SecretErrorCode::Denied,
        SecretErrorCode::NotFound,
        SecretErrorCode::InvalidName,
        SecretErrorCode::InvalidValue,
        SecretErrorCode::InvalidDescription,
        SecretErrorCode::InvalidTtl,
        SecretErrorCode::NoBackend,
        SecretErrorCode::BackendUnavailable,
        SecretErrorCode::Corrupt,
        SecretErrorCode::Storage,
        SecretErrorCode::AuditUnavailable,
        SecretErrorCode::LeaseInvalid,
    ];

    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            SecretErrorCode::Denied => "denied",
            SecretErrorCode::NotFound => "not-found",
            SecretErrorCode::InvalidName => "invalid-name",
            SecretErrorCode::InvalidValue => "invalid-value",
            SecretErrorCode::InvalidDescription => "invalid-description",
            SecretErrorCode::InvalidTtl => "invalid-ttl",
            SecretErrorCode::NoBackend => "no-backend",
            SecretErrorCode::BackendUnavailable => "backend-unavailable",
            SecretErrorCode::Corrupt => "corrupt",
            SecretErrorCode::Storage => "storage",
            SecretErrorCode::AuditUnavailable => "audit-unavailable",
            SecretErrorCode::LeaseInvalid => "lease-invalid",
        }
    }

    /// The code a wire name stands for.
    pub fn from_wire(name: &str) -> Option<SecretErrorCode> {
        SecretErrorCode::ALL
            .into_iter()
            .find(|c| c.as_str() == name)
    }
}

/// Raised for every failure of the secret store.
#[derive(Clone, Debug, PartialEq)]
pub struct SecretError {
    /// What kind of failure.
    pub code: SecretErrorCode,
    /// The fixed message.
    pub message: String,
    /// `detail` of the TypeScript error: always a JSON object (`{}` when none), values only strings, numbers and booleans.
    pub detail: Value,
}

impl SecretError {
    /// An error without detail (`detail` is `{}`).
    pub fn new(code: SecretErrorCode, message: impl Into<String>) -> SecretError {
        SecretError::with_detail(code, message, json!({}))
    }

    /// An error with a detail object.
    pub fn with_detail(
        code: SecretErrorCode,
        message: impl Into<String>,
        detail: Value,
    ) -> SecretError {
        SecretError {
            code,
            message: message.into(),
            detail,
        }
    }

    /// `{ code, message, detail }`, the form the vectors record.
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code.as_str(), "message": self.message, "detail": self.detail })
    }

    /// `checkName`'s refusal.
    pub fn invalid_name() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidName,
            "secret name must match [A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}",
        )
    }

    /// `checkValue`: not a string, or empty.
    pub fn value_not_text() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidValue,
            "secret value must be a non-empty string",
        )
    }

    /// `checkValue`: a NUL character.
    pub fn value_has_nul() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidValue,
            "secret value must not contain NUL",
        )
    }

    /// `checkValue`: more than [`MAX_VALUE_BYTES`] bytes of UTF-8.
    pub fn value_too_large() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidValue,
            format!("secret value exceeds {MAX_VALUE_BYTES} bytes"),
        )
    }

    /// `checkDescription`: not a string.
    pub fn description_not_text() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidDescription,
            "secret description must be a string",
        )
    }

    /// `checkDescription`: more than [`MAX_DESCRIPTION_CHARS`] code points.
    pub fn description_too_long() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidDescription,
            format!("secret description exceeds {MAX_DESCRIPTION_CHARS} characters"),
        )
    }

    /// `checkDescription`: a control character or line separator.
    pub fn description_not_plain() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidDescription,
            "secret description must be one line of plain text",
        )
    }

    /// `checkDescription`: the whole value.
    pub fn description_has_value() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidDescription,
            "secret description must not contain the secret value",
        )
    }

    /// `checkDescription`: a fragment of eight or more code points of the value.
    pub fn description_has_fragment() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidDescription,
            "secret description must not contain a secret fragment",
        )
    }

    /// The lease table's refusal of a `ttlMs`.
    pub fn invalid_ttl() -> SecretError {
        SecretError::new(
            SecretErrorCode::InvalidTtl,
            format!("lease ttlMs must be an integer in 1..{MAX_LEASE_TTL_MS}"),
        )
    }

    /// An expired, revoked or unknown lease.
    pub fn lease_invalid() -> SecretError {
        SecretError::new(
            SecretErrorCode::LeaseInvalid,
            "lease is expired, revoked or unknown",
        )
    }

    /// The memory backend's answer for a name it does not hold.
    pub fn not_found() -> SecretError {
        SecretError::new(SecretErrorCode::NotFound, "secret does not exist")
    }

    /// The memory backend while `available` is off.
    pub fn memory_backend_off() -> SecretError {
        SecretError::new(SecretErrorCode::BackendUnavailable, "memory backend is off")
    }

    /// The audit sink that could not make a line durable.
    pub fn audit_unavailable() -> SecretError {
        SecretError::new(
            SecretErrorCode::AuditUnavailable,
            "the audit log cannot be written; no secret was released or changed",
        )
    }

    /// `backendFailure` of something that is not a `SecretError`: `<what> failed (<code>)`, the code in `detail.cause`.
    pub fn storage_failed(what: &str, code: &str) -> SecretError {
        SecretError::with_detail(
            SecretErrorCode::Storage,
            format!("{what} failed ({code})"),
            json!({ "cause": code }),
        )
    }

    /// What V8 throws for `new Date(ms).toISOString()` with a time value outside `TimeClip`'s range: a `RangeError`, which is
    /// not a `SecretError` in TypeScript. Rust has no such second kind of error, so it is a `storage` error with V8's text.
    pub fn invalid_time() -> SecretError {
        SecretError::new(SecretErrorCode::Storage, "Invalid time value")
    }
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SecretError {}
