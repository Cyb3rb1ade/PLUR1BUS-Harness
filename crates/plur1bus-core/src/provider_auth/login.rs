//! `auth/login.ts`: the interactive login flows of the in-process engine API: OAuth with PKCE over a loopback redirect (a
//! browser on this machine, or over `ssh -L`), paste-callback, and the device code. Callers retry a selected fallback
//! explicitly; a denial or a state failure never silently starts another login. No credential leaves the result.
//!
//! **The loopback listener** ([`LoopbackListener`]) is a port: [`TcpLoopback`] is the real one (127.0.0.1, port 0, never a
//! wildcard, `localhost` or IPv6), the tests script it. Each request it receives is judged here ([`CallbackGate`]): only a
//! `GET` of `/auth/callback` whose `Host` is the redirect's host and whose single `state` equals the issued one (SHA-256 of
//! both sides, compared in constant time) ends the one-shot listener. Every other request to the path gets a constant 400
//! (nothing echoed) and leaves the listener open until a genuine callback, the deadline or a cancellation; more than ten such
//! requests within one second are answered 429. A genuine callback whose other parameters are wrong (an `error`, no code,
//! two codes) also ends the login, with that refusal.
//!
//! **Randomness, time and the person** are ports: `state` and the PKCE verifier are 32 random bytes each (base64url), the
//! deadline is measured on the [`Clock`], the browser, the prompts and the device-code sleep go through [`LoginUi`].
use super::env::EnvSnapshot;
use super::errors::{AuthError, AuthErrorCode};
use super::http::{
    client_fields, parse_token_response, Form, OAuthHttp, OAuthHttpError, TokenResponse,
};
use super::ladder::{plan_login, LoginMethod};
use super::ports::{base64url, AuthLog, Clock, NoLog, PortFailure, RandomBytes};
use super::profile::{AuthKind, AuthProfile, ClientRegistration};
use super::record::{OAuthRecord, SecretStore};
use super::secret::{digest_equal, Secret};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fmt;

/// The fixed text of a refused callback.
pub const FIXED_FAILURE: &str = "Sign-in failed. Close this window and try again.";
/// Forged callbacks answered with 400 per second before further ones get 429.
pub const FAILED_LIMIT: usize = 10;

/// `AuthorizationPrompt`: an explicit UI port may read the URL; generic printing never sees it.
#[derive(Clone)]
pub struct AuthorizationPrompt {
    url: Secret,
    redirect: String,
    /// The `ssh -L` hint for `loopback_ssh`.
    pub ssh_hint: Option<String>,
}

impl AuthorizationPrompt {
    /// The authorization URL (it carries `state` and the PKCE challenge).
    pub fn authorization_url(&self) -> &Secret {
        &self.url
    }
    /// The redirect URI.
    pub fn redirect_uri(&self) -> &str {
        &self.redirect
    }
    /// `JSON.stringify(prompt)`.
    pub fn redacted_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("authorizationUrl".into(), json!("[redacted]"));
        if let Some(h) = &self.ssh_hint {
            m.insert("sshHint".into(), json!(h));
        }
        Value::Object(m)
    }
}

impl fmt::Debug for AuthorizationPrompt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthorizationPrompt")
            .field("authorizationUrl", &"[redacted]")
            .field("sshHint", &self.ssh_hint)
            .finish()
    }
}

/// `DevicePrompt`.
#[derive(Clone)]
pub struct DevicePrompt {
    /// The code the person types.
    pub user_code: Secret,
    /// Where they type it.
    pub verification_uri: Secret,
    /// The URI with the code in it, when the server sent one.
    pub verification_uri_complete: Option<Secret>,
}

impl DevicePrompt {
    /// `JSON.stringify(prompt)`.
    pub fn redacted_json(&self) -> Value {
        json!({ "userCode": "[redacted]", "verificationUri": "[redacted]" })
    }
}

impl fmt::Debug for DevicePrompt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DevicePrompt { userCode: [redacted], verificationUri: [redacted] }")
    }
}

/// The person's side of a login. A method returning `None` is a port the caller did not supply.
pub trait LoginUi {
    /// Opens `url` in the browser (`openBrowser`).
    fn open_browser(&self, url: &Secret) -> Option<Result<(), PortFailure>>;
    /// Shows the authorization prompt (`onAuthorization`).
    fn on_authorization(&self, prompt: &AuthorizationPrompt) -> Option<Result<(), PortFailure>>;
    /// Whether the caller supplied `readCallback`.
    fn has_read_callback(&self) -> bool;
    /// Reads the pasted callback URL (`readCallback`).
    fn read_callback(&self, prompt: &AuthorizationPrompt) -> Option<Result<Secret, PortFailure>>;
    /// Shows the device code (`onDevice`).
    fn on_device(&self, prompt: &DevicePrompt) -> Option<Result<(), PortFailure>>;
    /// Waits `ms` between device-code polls (`sleep`); `Err` when the login was cancelled.
    fn sleep(&self, ms: f64) -> Result<(), PortFailure>;
}

/// One request to the loopback listener.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallbackRequest {
    /// The method.
    pub method: String,
    /// The request target (`req.url`).
    pub target: String,
    /// The `Host` header.
    pub host: Option<String>,
}

/// What the listener delivered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Incoming {
    /// A request, to be answered with [`LoopbackListener::respond`].
    Request(CallbackRequest),
    /// The wait ended without one.
    Timeout,
}

/// An answer to a callback request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallbackResponse {
    /// The status.
    pub status: u16,
    /// The header lines.
    pub headers: Vec<(&'static str, &'static str)>,
    /// The constant body.
    pub body: &'static str,
}

/// The loopback listener port.
pub trait LoopbackListener {
    /// Binds 127.0.0.1 on a free port and returns it.
    fn bind(&mut self) -> Result<u16, PortFailure>;
    /// Waits up to `wait_ms` for the next request.
    fn next(&mut self, wait_ms: f64) -> Incoming;
    /// Answers the request [`next`](Self::next) returned last.
    fn respond(&mut self, response: &CallbackResponse);
    /// Stops listening; later requests are refused.
    fn close(&mut self);
}

/// The state of one listener: what it issued and what it has seen.
pub struct CallbackGate {
    redirect: url::Url,
    state: Secret,
    consumed: bool,
    failures: Vec<f64>,
}

/// What [`CallbackGate::judge`] decided.
pub enum Judged {
    /// Answer and keep listening.
    Refused(CallbackResponse),
    /// The genuine callback: answer, stop listening, and go on with this outcome.
    Genuine(CallbackResponse, Result<String, AuthError>),
}

const BASE_HEADERS: [(&str, &str); 4] = [
    ("content-type", "text/html; charset=utf-8"),
    ("cache-control", "no-store"),
    ("referrer-policy", "no-referrer"),
    ("content-security-policy", "default-src 'none'"),
];

fn respond(
    status: u16,
    body: &'static str,
    extra: Option<(&'static str, &'static str)>,
) -> CallbackResponse {
    let mut headers = BASE_HEADERS.to_vec();
    if let Some(h) = extra {
        headers.push(h);
    }
    CallbackResponse {
        status,
        headers,
        body,
    }
}

fn query_all(u: &url::Url, key: &str) -> Vec<String> {
    u.query_pairs()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .collect()
}

fn host_of(u: &url::Url) -> String {
    let h = u.host_str().unwrap_or("");
    match u.port() {
        Some(p) => format!("{h}:{p}"),
        None => h.to_owned(),
    }
}

impl CallbackGate {
    /// A gate for `redirect` and the issued `state`.
    pub fn new(redirect: &str, state: Secret) -> Option<CallbackGate> {
        Some(CallbackGate {
            redirect: url::Url::parse(redirect).ok()?,
            state,
            consumed: false,
            failures: Vec::new(),
        })
    }

    /// The server's handler for one request at time `now`.
    pub fn judge(&mut self, req: &CallbackRequest, now: f64) -> Judged {
        if self.consumed {
            return Judged::Refused(respond(410, "Sign-in closed.", None));
        }
        let Ok(url) = self.redirect.join(&req.target) else {
            return Judged::Refused(respond(404, "Not found.", None));
        };
        if req.method != "GET" || url.path() != "/auth/callback" {
            return Judged::Refused(respond(404, "Not found.", None));
        }
        let states = query_all(&url, "state");
        let host_ok = req.host.as_deref() == Some(host_of(&self.redirect).as_str());
        // Always evaluated, never short-circuited by the host check.
        let same = states.len() == 1 && digest_equal(&states[0], self.state.expose());
        if !(host_ok && same) {
            self.failures.retain(|t| now - *t < 1000.0);
            self.failures.push(now);
            if self.failures.len() > FAILED_LIMIT {
                return Judged::Refused(respond(
                    429,
                    "Too many attempts.",
                    Some(("retry-after", "1")),
                ));
            }
            return Judged::Refused(respond(400, FIXED_FAILURE, None));
        }
        self.consumed = true;
        let raw = url.as_str().to_owned();
        match callback_code(&raw, self.redirect.as_str(), &self.state) {
            Ok(_) => Judged::Genuine(
                respond(200, "Sign-in complete. You may close this window.", None),
                Ok(raw),
            ),
            Err(e) => Judged::Genuine(respond(400, FIXED_FAILURE, None), Err(e)),
        }
    }
}

fn local(code: AuthErrorCode) -> AuthError {
    let message = match code {
        AuthErrorCode::StateMismatch => "Sign-in callback did not match this login.",
        AuthErrorCode::LoginTimeout => "Sign-in timed out or was cancelled.",
        AuthErrorCode::AccessDenied => "Sign-in was declined.",
        AuthErrorCode::PersistFailed => "Sign-in could not be saved; try again.",
        _ => "Sign-in failed; try again.",
    };
    AuthError::new(code, message)
}

/// `callbackCode(raw, redirect, state)`: the authorization code of a callback URL, after the checks in TypeScript's order.
pub fn callback_code(raw: &str, redirect: &str, state: &Secret) -> Result<Secret, AuthError> {
    let failed = || local(AuthErrorCode::LoginFailed);
    let url = url::Url::parse(raw).map_err(|_| failed())?;
    let expected = url::Url::parse(redirect).map_err(|_| failed())?;
    if url.origin() != expected.origin()
        || url.path() != expected.path()
        || !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return Err(failed());
    }
    let states = query_all(&url, "state");
    let actual = states.first().map_or("", String::as_str);
    if states.len() != 1 || !state.matches(actual) {
        return Err(local(AuthErrorCode::StateMismatch));
    }
    if url.query_pairs().any(|(k, _)| k == "error") {
        return Err(local(AuthErrorCode::AccessDenied));
    }
    let codes = query_all(&url, "code");
    match codes.as_slice() {
        [code] if !code.is_empty() && code.encode_utf16().count() <= 8192 => {
            Ok(Secret::new(code.clone()))
        }
        _ => Err(failed()),
    }
}

/// `searchParams.set(k, v)` for each pair, then the query written by the form serialiser (as `URL` does after any change).
fn set_params(url: &mut url::Url, params: &[(String, Secret)]) {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    for (k, v) in params {
        let v = v.expose().to_owned();
        match pairs.iter().position(|(x, _)| x == k) {
            Some(first) => {
                pairs[first].1 = v;
                let mut i = 0;
                pairs.retain(|(x, _)| {
                    i += 1;
                    i - 1 == first || x != k
                });
            }
            None => pairs.push((k.clone(), v)),
        }
    }
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in &pairs {
        s.append_pair(k, v);
    }
    let q = s.finish();
    url.set_query(if q.is_empty() { None } else { Some(&q) });
}

/// `LoginOptions`.
pub struct LoginOptions<'a> {
    /// The profile.
    pub profile: &'a AuthProfile,
    /// Where the login is stored.
    pub store: &'a dyn SecretStore,
    /// The clock (the deadline and the device-code window).
    pub clock: &'a dyn Clock,
    /// The token endpoint.
    pub http: &'a OAuthHttp<'a>,
    /// The environment.
    pub env: &'a EnvSnapshot,
    /// `--paste-callback`.
    pub paste_callback: bool,
    /// An explicit retry of a method the plan offers.
    pub method: Option<LoginMethod>,
    /// The handle to store under; the profile's `secret_ref` otherwise.
    pub secret_ref: Option<&'a str>,
    /// The deadline; 10 minutes by default.
    pub timeout_ms: Option<f64>,
    /// The person's side.
    pub ui: &'a dyn LoginUi,
    /// The listener of the PKCE flows.
    pub listener: &'a mut dyn LoopbackListener,
    /// `state` and the PKCE verifier.
    pub random: &'a dyn RandomBytes,
    /// The log sink.
    pub log: Option<&'a dyn AuthLog>,
}

/// `LoginResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct LoginResult {
    /// The profile.
    pub profile_id: String,
    /// The method used.
    pub method: LoginMethod,
    /// When the access token expires.
    pub expires_at: Option<f64>,
}

/// Why a step failed: an error of this file keeps its code, anything else becomes `login_failed` (or `access_denied` for an
/// endpoint that said so).
enum Fail {
    Local(AuthError),
    Http(OAuthHttpError),
    Other,
}

impl From<OAuthHttpError> for Fail {
    fn from(e: OAuthHttpError) -> Fail {
        Fail::Http(e)
    }
}

fn err(code: AuthErrorCode) -> Fail {
    Fail::Local(local(code))
}

fn random_text(random: &dyn RandomBytes) -> Result<Secret, Fail> {
    let mut b = [0u8; 32];
    if !random.fill(&mut b) {
        return Err(Fail::Other);
    }
    Ok(Secret::new(base64url(&b)))
}

fn pkce(
    o: &mut LoginOptions<'_>,
    method: LoginMethod,
    deadline: f64,
) -> Result<TokenResponse, Fail> {
    let p = o.profile;
    let (Some(authorize), Some(endpoint)) = (p.authorize_url(), p.token_url()) else {
        return Err(err(AuthErrorCode::LoginFailed));
    };
    let state = random_text(o.random)?;
    let verifier = random_text(o.random)?;
    let challenge = base64url(&Sha256::digest(verifier.expose().as_bytes()));
    let port = o.listener.bind().map_err(|PortFailure| Fail::Other)?;
    let result = (|| {
        let redirect = format!("http://127.0.0.1:{port}/auth/callback");
        let mut url = url::Url::parse(&authorize).map_err(|_| Fail::Other)?;
        let mut params = client_fields(p)?;
        params.push(("response_type".to_owned(), Secret::new("code")));
        params.push(("redirect_uri".to_owned(), Secret::new(redirect.clone())));
        params.push(("state".to_owned(), state.clone()));
        params.push(("code_challenge".to_owned(), Secret::new(challenge)));
        params.push(("code_challenge_method".to_owned(), Secret::new("S256")));
        if let Some(scopes) = p.scopes.as_ref().filter(|s| !s.is_empty()) {
            params.push(("scope".to_owned(), Secret::new(scopes.join(" "))));
        }
        set_params(&mut url, &params);
        let plan = plan_login(p, o.env, o.paste_callback);
        let prompt = AuthorizationPrompt {
            url: Secret::new(url.as_str()),
            redirect: redirect.clone(),
            ssh_hint: if method == LoginMethod::LoopbackSsh {
                plan.ssh_hint(port)
            } else {
                None
            },
        };
        let raw = if method == LoginMethod::PasteCallback {
            if !o.ui.has_read_callback() {
                return Err(err(AuthErrorCode::LoginFailed));
            }
            // Show the prompt first, then read.
            if let Some(Err(PortFailure)) = o.ui.on_authorization(&prompt) {
                return Err(Fail::Other);
            }
            match o.ui.read_callback(&prompt) {
                Some(Ok(raw)) => raw,
                _ => return Err(Fail::Other),
            }
        } else {
            let shown = if method == LoginMethod::LoopbackPkce {
                o.ui.open_browser(prompt.authorization_url())
            } else {
                o.ui.on_authorization(&prompt)
            };
            match shown {
                None => return Err(err(AuthErrorCode::LoginFailed)),
                Some(Err(PortFailure)) => return Err(Fail::Other),
                Some(Ok(())) => {}
            }
            let mut gate = CallbackGate::new(&redirect, state.clone()).ok_or(Fail::Other)?;
            loop {
                let wait = deadline - o.clock.now();
                if wait <= 0.0 {
                    return Err(err(AuthErrorCode::LoginTimeout));
                }
                match o.listener.next(wait) {
                    Incoming::Timeout => return Err(err(AuthErrorCode::LoginTimeout)),
                    Incoming::Request(req) => match gate.judge(&req, o.clock.now()) {
                        Judged::Refused(r) => o.listener.respond(&r),
                        Judged::Genuine(r, outcome) => {
                            o.listener.respond(&r);
                            o.listener.close();
                            break Secret::new(outcome.map_err(Fail::Local)?);
                        }
                    },
                }
            }
        };
        let code = callback_code(raw.expose(), &redirect, &state).map_err(Fail::Local)?;
        o.listener.close();
        let mut form: Form = client_fields(p)?;
        form.push(("grant_type".to_owned(), Secret::new("authorization_code")));
        form.push(("code".to_owned(), code));
        form.push(("redirect_uri".to_owned(), Secret::new(redirect)));
        form.push(("code_verifier".to_owned(), verifier.clone()));
        Ok(parse_token_response(&o.http.post(&endpoint, &form)?)?)
    })();
    o.listener.close();
    result
}

fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn device(o: &mut LoginOptions<'_>) -> Result<TokenResponse, Fail> {
    let p = o.profile;
    let (Some(endpoint), Some(device_endpoint)) = (p.token_url(), p.device_url()) else {
        return Err(err(AuthErrorCode::LoginFailed));
    };
    let mut form = client_fields(p)?;
    if let Some(scopes) = p.scopes.as_ref().filter(|s| !s.is_empty()) {
        form.push(("scope".to_owned(), Secret::new(scopes.join(" "))));
    }
    let data = o.http.post(&device_endpoint, &form)?.0;
    let text = |k: &str| {
        data.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let (Some(device_code), Some(user_code), Some(Value::String(uri))) = (
        text("device_code"),
        text("user_code"),
        data.get("verification_uri"),
    ) else {
        return Err(err(AuthErrorCode::LoginFailed));
    };
    let Some(expires_in) = number(data.get("expires_in")).filter(|n| *n > 0.0) else {
        return Err(err(AuthErrorCode::LoginFailed));
    };
    let parsed = url::Url::parse(uri).map_err(|_| Fail::Other)?;
    let loop_http = parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1");
    if !parsed.username().is_empty()
        || parsed.password().is_some_and(|x| !x.is_empty())
        || (parsed.scheme() != "https" && !loop_http)
    {
        return Err(err(AuthErrorCode::LoginFailed));
    }
    let interval = match data.get("interval") {
        None => 5.0,
        Some(v) => match number(Some(v)).filter(|n| *n > 0.0) {
            Some(n) => n,
            None => return Err(err(AuthErrorCode::LoginFailed)),
        },
    };
    let end = o.clock.now() + expires_in * 1000.0;
    let mut interval = interval * 1000.0;
    let prompt = DevicePrompt {
        user_code: Secret::new(user_code),
        verification_uri: Secret::new(uri.clone()),
        verification_uri_complete: data
            .get("verification_uri_complete")
            .and_then(Value::as_str)
            .map(Secret::new),
    };
    if let Some(Err(PortFailure)) = o.ui.on_device(&prompt) {
        return Err(Fail::Other);
    }
    let device_code = Secret::new(device_code);
    while o.clock.now() < end {
        o.ui.sleep(interval.min(end - o.clock.now()))
            .map_err(|PortFailure| err(AuthErrorCode::LoginTimeout))?;
        if o.clock.now() >= end {
            break;
        }
        let mut poll = client_fields(p)?;
        poll.push((
            "grant_type".to_owned(),
            Secret::new("urn:ietf:params:oauth:grant-type:device_code"),
        ));
        poll.push(("device_code".to_owned(), device_code.clone()));
        let answer = o
            .http
            .post(&endpoint, &poll)
            .and_then(|d| parse_token_response(&d));
        match answer {
            Ok(t) => return Ok(t),
            Err(e) if e.code == "authorization_pending" => continue,
            Err(e) if e.code == "slow_down" => interval += 5000.0,
            Err(e) if e.retryable => interval = (interval * 2.0).min(60_000.0),
            Err(e) if e.code == "expired_token" => return Err(err(AuthErrorCode::LoginTimeout)),
            Err(e) if e.code == "access_denied" => return Err(err(AuthErrorCode::AccessDenied)),
            Err(_) => return Err(err(AuthErrorCode::LoginFailed)),
        }
    }
    Err(err(AuthErrorCode::LoginTimeout))
}

/// `login(options)`.
pub fn login(mut o: LoginOptions<'_>) -> Result<LoginResult, AuthError> {
    let profile = o.profile;
    // D110 owns these flows; never persist a legacy record for them.
    if profile.client_registration == Some(ClientRegistration::DynamicOnAuthorize)
        || profile.kind == AuthKind::FederatedToken
    {
        return Err(local(AuthErrorCode::LoginFailed));
    }
    let log: &dyn AuthLog = o.log.unwrap_or(&NoLog);
    let timeout_ms = o.timeout_ms.unwrap_or(600_000.0);
    if !timeout_ms.is_finite() || timeout_ms <= 0.0 {
        return Err(local(AuthErrorCode::LoginFailed));
    }
    let deadline = o.clock.now() + timeout_ms;
    let plan = plan_login(profile, o.env, o.paste_callback);
    let method = o.method.unwrap_or(plan.method);
    if !plan.offers(method) {
        return Err(local(AuthErrorCode::LoginFailed));
    }
    let Some(r) = o
        .secret_ref
        .map(str::to_owned)
        .or_else(|| profile.secret_ref.clone())
    else {
        return Err(local(AuthErrorCode::LoginFailed));
    };
    let outcome = (|| -> Result<Option<f64>, Fail> {
        let tokens = match method {
            LoginMethod::DeviceCode => device(&mut o)?,
            LoginMethod::LoopbackPkce | LoginMethod::LoopbackSsh | LoginMethod::PasteCallback => {
                pkce(&mut o, method, deadline)?
            }
            _ => return Err(err(AuthErrorCode::LoginFailed)),
        };
        let now = o.clock.now();
        let expires_at = tokens.expires_in_seconds.map(|s| now + s * 1000.0);
        let mut rec = OAuthRecord::new(tokens.access_token, 0.0);
        rec.refresh_token = tokens.refresh_token;
        rec.expires_at = expires_at;
        rec.refresh_expires_at = tokens.refresh_expires_in_seconds.map(|s| now + s * 1000.0);
        o.store
            .set(&r, &rec.encode())
            .map_err(|_| err(AuthErrorCode::PersistFailed))?;
        Ok(expires_at)
    })();
    match outcome {
        Ok(expires_at) => {
            log.log(
                "auth.login.ok",
                &[
                    ("profileId", json!(profile.id)),
                    ("method", json!(method.as_str())),
                ],
            );
            Ok(LoginResult {
                profile_id: profile.id.clone(),
                method,
                expires_at,
            })
        }
        Err(f) => {
            let safe = match f {
                Fail::Local(e) => e,
                Fail::Http(e) if e.code == "access_denied" => local(AuthErrorCode::AccessDenied),
                Fail::Http(_) | Fail::Other => local(AuthErrorCode::LoginFailed),
            };
            log.log(
                "auth.login.failed",
                &[
                    ("profileId", json!(profile.id)),
                    ("code", json!(safe.code.as_str())),
                ],
            );
            Err(safe)
        }
    }
}

/// The real listener: one socket on 127.0.0.1, port 0, blocking accepts with a deadline, one request per connection.
pub struct TcpLoopback {
    listener: Option<std::net::TcpListener>,
    pending: Option<std::net::TcpStream>,
}

impl Default for TcpLoopback {
    fn default() -> TcpLoopback {
        TcpLoopback::new()
    }
}

impl TcpLoopback {
    /// An unbound listener.
    pub fn new() -> TcpLoopback {
        TcpLoopback {
            listener: None,
            pending: None,
        }
    }

    fn read_head(stream: &mut std::net::TcpStream) -> Option<CallbackRequest> {
        use std::io::Read;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 || buf.len() > 16 * 1024 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let head = String::from_utf8_lossy(&buf);
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let method = first.next()?.to_owned();
        let target = first.next()?.to_owned();
        let host = lines.take_while(|l| !l.is_empty()).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case("host")
                .then(|| v.trim().to_owned())
        });
        Some(CallbackRequest {
            method,
            target,
            host,
        })
    }
}

impl LoopbackListener for TcpLoopback {
    fn bind(&mut self) -> Result<u16, PortFailure> {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| PortFailure)?;
        let port = l.local_addr().map_err(|_| PortFailure)?.port();
        l.set_nonblocking(true).map_err(|_| PortFailure)?;
        self.listener = Some(l);
        Ok(port)
    }

    fn next(&mut self, wait_ms: f64) -> Incoming {
        let start = std::time::Instant::now();
        let limit = std::time::Duration::from_millis(wait_ms.clamp(0.0, 86_400_000.0) as u64);
        loop {
            let Some(l) = &self.listener else {
                return Incoming::Timeout;
            };
            match l.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    if let Some(req) = Self::read_head(&mut stream) {
                        self.pending = Some(stream);
                        return Incoming::Request(req);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if start.elapsed() >= limit {
                        return Incoming::Timeout;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(_) => return Incoming::Timeout,
            }
        }
    }

    fn respond(&mut self, r: &CallbackResponse) {
        use std::io::Write;
        let Some(mut s) = self.pending.take() else {
            return;
        };
        let reason = match r.status {
            200 => "OK",
            400 => "Bad Request",
            404 => "Not Found",
            410 => "Gone",
            429 => "Too Many Requests",
            _ => "",
        };
        let mut head = format!("HTTP/1.1 {} {reason}\r\n", r.status);
        for (k, v) in &r.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str(&format!(
            "content-length: {}\r\nconnection: close\r\n\r\n",
            r.body.len()
        ));
        let _ = s.write_all(head.as_bytes());
        let _ = s.write_all(r.body.as_bytes());
    }

    fn close(&mut self) {
        self.pending = None;
        self.listener = None;
    }
}
