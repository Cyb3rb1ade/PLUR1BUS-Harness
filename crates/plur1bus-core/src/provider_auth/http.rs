//! `auth/http.ts`: the token POST (RFC 6749) and the refresher built on it.
//!
//! **The HTTP port (R-K-14).** `plur1bus-core` has no HTTP client. The TypeScript POST goes through `egress.request` (the
//! guarded client of the web tools); here the same checks run first, in this module, and only then is the request handed to
//! [`HttpTransport`]: the URL must parse, the scheme be `http` or `https`, the URL carry no credentials, and the egress dry run
//! ([`crate::egress::service::Egress::decide`]: the gate, the SSRF range check, the address pin) must allow it. The request
//! carries the pin the gate judged ([`Pin`]) and the limits the TypeScript client is given ([`Limits`]): the real client of the
//! flip connects to that address under the original TLS name, caps the answer, applies one deadline to the whole call and
//! never follows a redirect (the TypeScript client does not follow one for a POST, and a 3xx is refused here). Nothing in this
//! module opens a socket.
//!
//! No response text, endpoint, form or foreign error survives this boundary: [`OAuthHttpError`] holds a code.
use super::profile::{AuthProfile, ClientRegistration};
use super::refresh::{RefreshRejected, RefreshResult, Refresher};
use super::secret::Secret;
use crate::egress::service::{DryRun, Egress, Purpose};
use serde_json::{json, Map, Value};
use std::fmt;

/// The wire error codes a token endpoint may name and that keep their name here.
pub const WIRE_ERRORS: [&str; 8] = [
    "invalid_grant",
    "authorization_pending",
    "slow_down",
    "expired_token",
    "access_denied",
    "invalid_client",
    "invalid_request",
    "unsupported_grant_type",
];

/// `OAuthHttpError`: a code and whether a retry can succeed. The message is always `OAuth endpoint request failed.`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthHttpError {
    /// `egress_denied`, `invalid_response`, `transient`, `redirect_refused`, `endpoint_rejected`, a [`WIRE_ERRORS`] code,
    /// `unsupported_registration` or `invalid_request`.
    pub code: &'static str,
    /// Whether a retry can succeed.
    pub retryable: bool,
}

impl OAuthHttpError {
    /// A non-retryable error.
    pub fn new(code: &'static str) -> OAuthHttpError {
        OAuthHttpError {
            code,
            retryable: false,
        }
    }

    /// `transient`, retryable.
    pub fn transient() -> OAuthHttpError {
        OAuthHttpError {
            code: "transient",
            retryable: true,
        }
    }

    /// The constant message.
    pub fn message(&self) -> &'static str {
        "OAuth endpoint request failed."
    }

    /// The fields a vector records.
    pub fn to_json(&self) -> Value {
        json!({ "kind": "oauth-http", "code": self.code, "retryable": self.retryable, "message": self.message() })
    }
}

/// The address the egress gate judged: the client connects to `address` and presents `host` as the TLS name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    /// The host name of the URL.
    pub host: String,
    /// The vetted address.
    pub address: String,
    /// `4` or `6`.
    pub family: u8,
    /// The effective port.
    pub port: u16,
}

/// What the real client must enforce for this request.
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    /// Cap on the answer in bytes.
    pub max_bytes: Option<f64>,
    /// Bytes of an error answer (status 400 and up) that are read.
    pub error_body_bytes: Option<f64>,
    /// One deadline for the whole call.
    pub timeout_ms: Option<f64>,
    /// Never follow a redirect: always true for the token POST (a POST is never followed).
    pub no_redirects: bool,
}

/// One request handed to the transport. The body holds credentials and has no printable form.
#[derive(Clone)]
pub struct WireRequest {
    /// `GET` or `POST`.
    pub method: String,
    /// The URL as given.
    pub url: String,
    /// The header lines (lower-case names), in the order they are set.
    pub headers: Vec<(String, String)>,
    /// The body.
    pub body: Secret,
    /// The limits.
    pub limits: Limits,
    /// The pinned address.
    pub pin: Pin,
}

impl fmt::Debug for WireRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WireRequest")
            .field("method", &self.method)
            .field("pin", &self.pin)
            .field("payload", &"[redacted]")
            .finish()
    }
}

/// The transport's answer.
#[derive(Clone)]
pub struct WireResponse {
    /// The status.
    pub status: u16,
    /// The header lines.
    pub headers: Vec<(String, String)>,
    /// The (decoded) body.
    pub body: Vec<u8>,
}

impl fmt::Debug for WireResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WireResponse")
            .field("status", &self.status)
            .field("body", &"[redacted]")
            .finish()
    }
}

/// Why the transport gave no answer (the `WebFailure` codes that matter to an OAuth caller).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportError {
    /// A hop was refused by the gate or the address check (`egress-denied`, `private-address`, `not-found`, `invalid-url`).
    Refused,
    /// The answer was larger than allowed.
    TooLarge,
    /// The answer's content type was refused.
    UnsupportedType,
    /// The deadline passed.
    Timeout,
    /// Anything else (a reset connection, a TLS failure).
    Failed,
}

/// The HTTP port: one request in, an answer or a transport failure out.
pub trait HttpTransport: Send + Sync {
    /// Sends `request` to `request.pin` and returns the answer.
    fn send(&self, request: &WireRequest) -> Result<WireResponse, TransportError>;
}

/// A form: names and values, values possibly secret.
pub type Form = Vec<(String, Secret)>;

/// `new URLSearchParams(form).toString()`.
pub fn form_body(form: &Form) -> Secret {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in form {
        s.append_pair(k, v.expose());
    }
    Secret::new(s.finish())
}

/// The JSON object a token endpoint answered. It holds tokens: its `Debug` and its JSON form are redacted.
#[derive(Clone, PartialEq)]
pub struct TokenData(pub Map<String, Value>);

impl fmt::Debug for TokenData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("{ response: '[redacted]' }")
    }
}

impl TokenData {
    /// `JSON.stringify(data)`.
    pub fn redacted_json(&self) -> Value {
        json!({ "response": "[redacted]" })
    }
}

/// `createOAuthHttp({ egress, timeoutMs, maxBytes })`.
pub struct OAuthHttp<'a> {
    egress: &'a Egress<'a>,
    transport: &'a dyn HttpTransport,
    timeout_ms: f64,
    max_bytes: f64,
}

impl<'a> OAuthHttp<'a> {
    /// The defaults are 30 s and 64 KiB.
    pub fn new(
        egress: &'a Egress<'a>,
        transport: &'a dyn HttpTransport,
        timeout_ms: Option<f64>,
        max_bytes: Option<f64>,
    ) -> OAuthHttp<'a> {
        OAuthHttp {
            egress,
            transport,
            timeout_ms: timeout_ms.unwrap_or(30_000.0),
            max_bytes: max_bytes.unwrap_or(64.0 * 1024.0),
        }
    }

    /// The checks the guarded client makes before any I/O, then the egress dry run. Every refusal is `egress_denied`.
    fn admit(&self, raw: &str) -> Result<Pin, OAuthHttpError> {
        let denied = || OAuthHttpError::new("egress_denied");
        let url = url::Url::parse(raw).map_err(|_| denied())?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(denied());
        }
        if !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) {
            return Err(denied());
        }
        match self.egress.decide(raw, Purpose::Ordinary) {
            DryRun::Allowed {
                host,
                port,
                address,
                family,
            } => Ok(Pin {
                host,
                address,
                family,
                port,
            }),
            DryRun::Denied { .. } => Err(denied()),
        }
    }

    /// `post(url, form)`: the JSON object the endpoint answered, or a code.
    pub fn post(&self, raw: &str, form: &Form) -> Result<TokenData, OAuthHttpError> {
        let pin = self.admit(raw)?;
        let request = WireRequest {
            method: "POST".to_owned(),
            url: raw.to_owned(),
            headers: vec![
                ("user-agent".to_owned(), "PLUR1BUS-auth".to_owned()),
                ("accept".to_owned(), "application/json".to_owned()),
                (
                    "content-type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                ),
            ],
            body: form_body(form),
            limits: Limits {
                max_bytes: Some(self.max_bytes),
                error_body_bytes: Some(self.max_bytes),
                timeout_ms: Some(self.timeout_ms),
                no_redirects: true,
            },
            pin,
        };
        let response = self.transport.send(&request).map_err(|e| match e {
            TransportError::Refused => OAuthHttpError::new("egress_denied"),
            TransportError::TooLarge | TransportError::UnsupportedType => {
                OAuthHttpError::new("invalid_response")
            }
            TransportError::Timeout | TransportError::Failed => OAuthHttpError::transient(),
        })?;
        let status = response.status;
        if status >= 500 || status == 429 || status == 408 {
            return Err(OAuthHttpError::transient());
        }
        if (300..400).contains(&status) {
            return Err(OAuthHttpError::new("redirect_refused"));
        }
        let text = String::from_utf8_lossy(&response.body);
        let Ok(Value::Object(data)) = serde_json::from_str::<Value>(&text) else {
            return Err(OAuthHttpError::new("invalid_response"));
        };
        if data.contains_key("error") || !(200..300).contains(&status) {
            let code = data
                .get("error")
                .and_then(Value::as_str)
                .and_then(|e| WIRE_ERRORS.iter().find(|w| **w == e).copied())
                .unwrap_or("endpoint_rejected");
            return Err(OAuthHttpError::new(code));
        }
        Ok(TokenData(data))
    }
}

/// `TokenResponse`: private fields, a redacted printed form.
#[derive(Clone, PartialEq)]
pub struct TokenResponse {
    /// `access_token`
    pub access_token: Secret,
    /// `refresh_token`
    pub refresh_token: Option<Secret>,
    /// `expires_in`
    pub expires_in_seconds: Option<f64>,
    /// `refresh_expires_in`
    pub refresh_expires_in_seconds: Option<f64>,
}

impl fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("{ token: '[redacted]' }")
    }
}

impl TokenResponse {
    /// `JSON.stringify(response)`.
    pub fn redacted_json(&self) -> Value {
        json!({ "token": "[redacted]" })
    }
}

/// `parseTokenResponse(data)`.
pub fn parse_token_response(data: &TokenData) -> Result<TokenResponse, OAuthHttpError> {
    let d = &data.0;
    let invalid = || OAuthHttpError::new("invalid_response");
    let access = match d.get("access_token") {
        Some(Value::String(s)) if !s.is_empty() && !s.contains(['\r', '\n']) => s.clone(),
        _ => return Err(invalid()),
    };
    match d.get("token_type") {
        Some(Value::String(t)) if crate::js::to_lower_case(t) == "bearer" => {}
        _ => return Err(invalid()),
    }
    let refresh = match d.get("refresh_token") {
        None => None,
        Some(Value::String(s)) if !s.is_empty() => Some(Secret::new(s.clone())),
        Some(_) => return Err(invalid()),
    };
    let positive = |k: &str| match d.get(k) {
        None => Ok(None),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(x) if x.is_finite() && x > 0.0 => Ok(Some(x)),
            _ => Err(invalid()),
        },
        Some(_) => Err(invalid()),
    };
    Ok(TokenResponse {
        access_token: Secret::new(access),
        refresh_token: refresh,
        expires_in_seconds: positive("expires_in")?,
        refresh_expires_in_seconds: positive("refresh_expires_in")?,
    })
}

/// `clientFields(p)`: `client_id` and `audience` when the profile has them; a dynamic registration is not supported here.
pub fn client_fields(p: &AuthProfile) -> Result<Form, OAuthHttpError> {
    if p.client_registration == Some(ClientRegistration::Dynamic) {
        return Err(OAuthHttpError::new("unsupported_registration"));
    }
    let mut f = Form::new();
    if let Some(c) = &p.client_id {
        f.push(("client_id".to_owned(), Secret::new(c.clone())));
    }
    if let Some(a) = &p.audience {
        f.push(("audience".to_owned(), Secret::new(a.clone())));
    }
    Ok(f)
}

/// `HttpRefresher`: the refresh grant against the profile's token endpoint.
pub struct HttpRefresher<'a> {
    http: &'a OAuthHttp<'a>,
}

impl<'a> HttpRefresher<'a> {
    /// The refresher over `http`.
    pub fn new(http: &'a OAuthHttp<'a>) -> HttpRefresher<'a> {
        HttpRefresher { http }
    }
}

impl Refresher for HttpRefresher<'_> {
    fn refresh(
        &self,
        profile: &AuthProfile,
        refresh_token: &Secret,
    ) -> Result<RefreshResult, RefreshRejected> {
        let run = || -> Result<TokenResponse, OAuthHttpError> {
            let endpoint = profile
                .token_url()
                .ok_or_else(|| OAuthHttpError::new("invalid_request"))?;
            let mut form = client_fields(profile)?;
            form.push(("grant_type".to_owned(), Secret::new("refresh_token")));
            form.push(("refresh_token".to_owned(), refresh_token.clone()));
            parse_token_response(&self.http.post(&endpoint, &form)?)
        };
        match run() {
            Ok(t) => Ok(RefreshResult {
                access_token: t.access_token,
                refresh_token: t.refresh_token,
                expires_in_seconds: t.expires_in_seconds,
                refresh_expires_in_seconds: t.refresh_expires_in_seconds,
            }),
            Err(e) if e.code == "invalid_grant" => Err(RefreshRejected::InvalidGrant),
            Err(_) => Err(RefreshRejected::Transient),
        }
    }
}
