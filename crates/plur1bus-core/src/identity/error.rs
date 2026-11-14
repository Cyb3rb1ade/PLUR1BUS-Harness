//! The failure type of identity (`IdentityError` and `IdentityErrorCode` of `identity/store.ts`). Only the type is here; the
//! store and the service that raise most of the codes are P4-12 task 4.

/// The closed vocabulary the RPC layer maps (`IdentityErrorCode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityErrorCode {
    /// `invalid-params`
    InvalidParams,
    /// `not-found`
    NotFound,
    /// `invalid-code`
    InvalidCode,
    /// `expired`
    Expired,
    /// `rate-limited`
    RateLimited,
    /// `conflict`
    Conflict,
    /// `limit`
    Limit,
    /// `storage`
    Storage,
    /// `denied`
    Denied,
}

impl IdentityErrorCode {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            IdentityErrorCode::InvalidParams => "invalid-params",
            IdentityErrorCode::NotFound => "not-found",
            IdentityErrorCode::InvalidCode => "invalid-code",
            IdentityErrorCode::Expired => "expired",
            IdentityErrorCode::RateLimited => "rate-limited",
            IdentityErrorCode::Conflict => "conflict",
            IdentityErrorCode::Limit => "limit",
            IdentityErrorCode::Storage => "storage",
            IdentityErrorCode::Denied => "denied",
        }
    }
}

/// Raised for every failure of the identity store and service.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityError {
    /// What kind of failure.
    pub code: IdentityErrorCode,
    /// The message.
    pub message: String,
    /// The offending field, when there is one.
    pub field: Option<String>,
    /// How long to wait before retrying, in milliseconds (rate limits).
    pub retry_after_ms: Option<i64>,
}

impl IdentityError {
    /// An error without field or retry hint.
    pub fn new(code: IdentityErrorCode, message: impl Into<String>) -> IdentityError {
        IdentityError {
            code,
            message: message.into(),
            field: None,
            retry_after_ms: None,
        }
    }

    /// `bad(field, message)` of `service.ts`: `invalid-params` naming a field.
    pub fn bad(field: &str, message: impl Into<String>) -> IdentityError {
        IdentityError {
            field: Some(field.to_owned()),
            ..IdentityError::new(IdentityErrorCode::InvalidParams, message)
        }
    }
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for IdentityError {}
