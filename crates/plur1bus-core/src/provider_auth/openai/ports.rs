//! `openai-auth/ports.ts`: the error type with its closed codes and constant messages (vendor payloads and foreign errors
//! never escape), the HTTP port with `call` (the status and wire-error mapping), the PKCE port, the audit port, and the
//! one serialising owner per credential (`SerialOwner`, the `RefreshPort` of TypeScript).
use super::super::http::Form;
use super::super::ports::PortFailure;
use super::super::secret::Secret;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

/// `ERROR_CODES`.
pub const ERROR_CODES: [&str; 41] = [
    "login-timeout",
    "login-cancelled",
    "access-denied",
    "port-in-use",
    "handle-unknown",
    "handle-expired",
    "handle-replay",
    "handle-binding",
    "handle-revoked",
    "invalid-request",
    "transport-failed",
    "endpoint-rejected",
    "discovery-invalid",
    "state-mismatch",
    "id-token-invalid",
    "scope-denied",
    "auth-required",
    "owner-only",
    "persist-failed",
    "siwc-unsupported",
    "credential-denied",
    "surface-denied",
    "ephemeral-consumed",
    "budget-exceeded",
    "capacity-exceeded",
    "transport-unavailable",
    "policy-denied",
    "session-unknown",
    "subscription_sharing_usage_limit_exceeded",
    "subscription_sharing_authentication_required",
    "subscription_sharing_not_enabled",
    "subscription_sharing_workspace_not_allowed",
    "subscription_sharing_invalid_token",
    "subscription_sharing_user_not_eligible",
    "subscription_sharing_usage_unavailable",
    "subscription_sharing_unsupported_capability",
    "subscription_sharing_route_not_supported",
    "subscription_sharing_invalid_user",
    "subscription_sharing_user_unavailable",
    "chatpass_v2_scope_not_authorized",
    "chatpass_v2_invalid_authorization_context",
];

/// `OpenAIError`: a closed code; an unknown one becomes `endpoint-rejected`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct OpenAIError {
    /// The code.
    pub code: &'static str,
}

impl OpenAIError {
    /// `new OpenAIError(code)`.
    pub fn new(code: &str) -> OpenAIError {
        OpenAIError {
            code: ERROR_CODES
                .iter()
                .find(|c| **c == code)
                .copied()
                .unwrap_or("endpoint-rejected"),
        }
    }

    /// The constant message.
    pub fn message(&self) -> String {
        format!("OpenAI operation refused ({}).", self.code)
    }

    /// `toJSON()`.
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message() })
    }
}

impl fmt::Debug for OpenAIError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OpenAIError({})", self.code)
    }
}

impl fmt::Display for OpenAIError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for OpenAIError {}

/// `new OpenAIError(code)` as an `Err`.
pub fn fail<T>(code: &str) -> Result<T, OpenAIError> {
    Err(OpenAIError::new(code))
}

/// `HttpRequest`. Its `Debug` and JSON forms carry the method only.
#[derive(Clone)]
pub struct HttpRequest {
    /// `GET` or `POST`.
    pub method: &'static str,
    /// The URL.
    pub url: String,
    /// The bearer token for `Authorization`.
    pub authorization: Option<Secret>,
    /// A form body.
    pub form: Option<Form>,
    /// A JSON body.
    pub json: Option<Value>,
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{{ method: {:?}, payload: '[redacted]' }}", self.method)
    }
}

impl HttpRequest {
    /// A `GET`.
    pub fn get(url: impl Into<String>) -> HttpRequest {
        HttpRequest {
            method: "GET",
            url: url.into(),
            authorization: None,
            form: None,
            json: None,
        }
    }

    /// A form `POST`.
    pub fn form(url: impl Into<String>, form: Form) -> HttpRequest {
        HttpRequest {
            method: "POST",
            url: url.into(),
            authorization: None,
            form: Some(form),
            json: None,
        }
    }

    /// `JSON.stringify(request)`.
    pub fn redacted_json(&self) -> Value {
        json!({ "method": self.method, "payload": "[redacted]" })
    }
}

/// `HttpResponse`.
#[derive(Clone, PartialEq)]
pub struct HttpResponse {
    /// The status.
    pub status: u16,
    /// The JSON body.
    pub body: Value,
}

impl fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{{ status: {}, body: '[redacted]' }}", self.status)
    }
}

/// `HttpPort`: an egress-approved, pinned, bounded transport that never follows a redirect.
pub trait HttpPort: Send + Sync {
    /// Sends the request; any failure of the transport is `Err`.
    fn request(&self, request: &HttpRequest) -> Result<HttpResponse, OpenAIError>;
}

/// `PkcePort`: the one-shot loopback redirect of the plan login.
pub trait PkcePort {
    /// Binds the listener and returns the redirect URI.
    fn redirect(&mut self) -> Result<String, OpenAIError>;
    /// Closes the listener.
    fn close(&mut self);
    /// Shows `url` and waits until `deadline_ms` (on `now`) for the callback carrying its `state`; returns the callback URL.
    fn authorize(
        &mut self,
        url: &Secret,
        redirect_uri: &str,
        deadline_ms: f64,
    ) -> Result<Secret, OpenAIError>;
}

/// `AuditPort`: an event object; a failure means the action must not happen.
pub trait AuditPort: Send + Sync {
    /// Records `event` (`{ kind, ... }`).
    fn audit(&self, event: &Value) -> Result<(), PortFailure>;
}

/// `object(v)`.
pub fn object(v: &Value) -> Result<&Map<String, Value>, OpenAIError> {
    v.as_object()
        .ok_or_else(|| OpenAIError::new("endpoint-rejected"))
}

/// `text(v)`: a non-empty string without CR, LF or NUL.
pub fn text(v: Option<&Value>) -> Result<String, OpenAIError> {
    match v {
        Some(Value::String(s)) if !s.is_empty() && !s.contains(['\r', '\n', '\0']) => Ok(s.clone()),
        _ => fail("endpoint-rejected"),
    }
}

/// `positive(v)`: a finite number above zero.
pub fn positive(v: Option<&Value>) -> Result<f64, OpenAIError> {
    match v.and_then(Value::as_f64) {
        Some(n) if v.is_some_and(Value::is_number) && n.is_finite() && n > 0.0 => Ok(n),
        _ => fail("endpoint-rejected"),
    }
}

/// `call(http, request)`: a transport failure is `transport-failed`; a status outside 2xx is the vendor's typed code when it
/// is one of the subscription-sharing codes, `auth-required` for `invalid_grant`, `endpoint-rejected` otherwise.
pub fn call(http: &dyn HttpPort, request: &HttpRequest) -> Result<Value, OpenAIError> {
    let res = http
        .request(request)
        .map_err(|_| OpenAIError::new("transport-failed"))?;
    if !(200..300).contains(&res.status) {
        let err = res.body.get("error");
        let code = err.and_then(|e| e.get("code")).and_then(Value::as_str);
        let wire = code
            .filter(|c| c.starts_with("subscription_sharing_") || c.starts_with("chatpass_v2_"));
        return Err(match wire {
            Some(c) if ERROR_CODES.contains(&c) => OpenAIError::new(c),
            _ if err.and_then(Value::as_str) == Some("invalid_grant") => {
                OpenAIError::new("auth-required")
            }
            _ => OpenAIError::new("endpoint-rejected"),
        });
    }
    Ok(res.body)
}

/// `SerialOwner`: one mutex per key for every login, refresh, logout and metadata update. The owner of a key runs one action
/// at a time; an action that fails does not stop the next.
#[derive(Default)]
pub struct SerialOwner {
    keys: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl SerialOwner {
    /// `exclusive(key, action)`.
    pub fn exclusive<T>(&self, key: &str, action: impl FnOnce() -> T) -> T {
        let lock = {
            let mut keys = self.keys.lock().unwrap_or_else(PoisonError::into_inner);
            keys.entry(key.to_owned()).or_default().clone()
        };
        let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
        action()
    }
}
