//! `auth/errors.ts`: the one error type of the auth package. Every message is built from constants and profile display
//! names, never from a token, a header, a response body or a foreign error's text, and no cause is kept, so an
//! [`AuthError`] may be logged, serialised and shown as it is (its derived `Debug` holds nothing secret).
use serde_json::{json, Map, Value};
use std::fmt;

/// `AuthErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AuthErrorCode {
    /// `login_failed`
    LoginFailed,
    /// `login_timeout`
    LoginTimeout,
    /// `state_mismatch`
    StateMismatch,
    /// `access_denied`
    AccessDenied,
    /// `persist_failed`
    PersistFailed,
    /// `reauth_required`: the stored login is dead; a person must sign in again.
    ReauthRequired,
    /// `refresh_failed`: the token endpoint could not be reached; the login is intact.
    RefreshFailed,
    /// `no_credential`
    NoCredential,
    /// `all_cooling_down`
    AllCoolingDown,
    /// `unknown_profile`
    UnknownProfile,
    /// `delegated_login`: the profile's login belongs to a vendor CLI.
    DelegatedLogin,
    /// `adc_unavailable`
    AdcUnavailable,
    /// `invalid_profile`
    InvalidProfile,
    /// `invalid_secret_record`
    InvalidSecretRecord,
}

impl AuthErrorCode {
    /// The TypeScript string.
    pub fn as_str(self) -> &'static str {
        match self {
            AuthErrorCode::LoginFailed => "login_failed",
            AuthErrorCode::LoginTimeout => "login_timeout",
            AuthErrorCode::StateMismatch => "state_mismatch",
            AuthErrorCode::AccessDenied => "access_denied",
            AuthErrorCode::PersistFailed => "persist_failed",
            AuthErrorCode::ReauthRequired => "reauth_required",
            AuthErrorCode::RefreshFailed => "refresh_failed",
            AuthErrorCode::NoCredential => "no_credential",
            AuthErrorCode::AllCoolingDown => "all_cooling_down",
            AuthErrorCode::UnknownProfile => "unknown_profile",
            AuthErrorCode::DelegatedLogin => "delegated_login",
            AuthErrorCode::AdcUnavailable => "adc_unavailable",
            AuthErrorCode::InvalidProfile => "invalid_profile",
            AuthErrorCode::InvalidSecretRecord => "invalid_secret_record",
        }
    }
}

/// `AuthError`: a code, a constant message and the ids, never a secret.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthError {
    /// What went wrong.
    pub code: AuthErrorCode,
    /// The fixed text.
    pub message: String,
    /// The profile, when known.
    pub profile_id: Option<String>,
    /// The pooled credential, when known.
    pub credential_id: Option<String>,
    /// Whether a retry can succeed.
    pub retryable: bool,
    /// Milliseconds until a retry can succeed, when known.
    pub retry_after_ms: Option<f64>,
    /// What the person should run, e.g. `plur1bus login <profile>`.
    pub action: Option<String>,
}

impl AuthError {
    /// `new AuthError(code, message)` without options.
    pub fn new(code: AuthErrorCode, message: impl Into<String>) -> AuthError {
        AuthError {
            code,
            message: message.into(),
            profile_id: None,
            credential_id: None,
            retryable: false,
            retry_after_ms: None,
            action: None,
        }
    }

    /// Sets the profile id.
    pub fn profile(mut self, id: &str) -> AuthError {
        self.profile_id = Some(id.to_owned());
        self
    }

    /// Sets the credential id.
    pub fn credential(mut self, id: &str) -> AuthError {
        self.credential_id = Some(id.to_owned());
        self
    }

    /// Marks it retryable.
    pub fn retryable(mut self, yes: bool) -> AuthError {
        self.retryable = yes;
        self
    }

    /// Sets the wait.
    pub fn retry_after(mut self, ms: f64) -> AuthError {
        self.retry_after_ms = Some(ms);
        self
    }

    /// Sets the action.
    pub fn action(mut self, action: String) -> AuthError {
        self.action = Some(action);
        self
    }

    /// The fields a vector records (`errOf` of the exporter).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), json!("auth"));
        m.insert("code".into(), json!(self.code.as_str()));
        m.insert("message".into(), json!(self.message));
        m.insert("retryable".into(), json!(self.retryable));
        if let Some(p) = &self.profile_id {
            m.insert("profileId".into(), json!(p));
        }
        if let Some(c) = &self.credential_id {
            m.insert("credentialId".into(), json!(c));
        }
        if let Some(r) = self.retry_after_ms {
            m.insert("retryAfterMs".into(), json!(r));
        }
        if let Some(a) = &self.action {
            m.insert("action".into(), json!(a));
        }
        Value::Object(m)
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AuthError {}
