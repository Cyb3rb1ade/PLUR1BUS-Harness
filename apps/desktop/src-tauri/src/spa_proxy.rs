//! Approved fallback: a per-window authenticated, origin-bound Rust HTTP/SSE/WS proxy.
use crate::{
    client::{ClientError, HarnessClient, Meta},
    connections::Connection,
    secrets::SecretString,
};
use axum::{
    body::Body,
    extract::{State, WebSocketUpgrade},
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use rand::{rngs::OsRng, TryRngCore};
use reqwest::cookie::{CookieStore, Jar};
use std::{
    borrow::Cow,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use url::Url;

struct Inner {
    installation_id: String,
    session_meta: Mutex<Meta>,
    client: HarnessClient,
    origin: crate::connections::Origin,
    jar: Mutex<Jar>,
    active: AtomicBool,
    shutdown: tokio::sync::watch::Sender<bool>,
    user_agent: SecretString,
    error_settings: Mutex<crate::settings::Settings>,
    #[cfg(debug_assertions)]
    observed_secrets: Mutex<Vec<SecretString>>,
    #[cfg(debug_assertions)]
    secondary_probe_403: AtomicBool,
}
#[cfg(debug_assertions)]
const SECONDARY_PROBE_MARKER: &str = "wp05-secondary-probe=1";
#[cfg(debug_assertions)]
const SECONDARY_PROBE_USER_AGENT: &str = "WP05-Secondary-Probe/1";
const SHELL_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
#[cfg(debug_assertions)]
const OLD_ORIGIN_DENIAL_CSP: &str = "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
#[cfg(debug_assertions)]
const OLD_ORIGIN_DENIAL_BODY: &str = "<!doctype html><meta charset=\"utf-8\"><title>WP05 diagnostic forbidden document</title><body>Forbidden</body>";

fn shell_response(kind: &'static str, body: Cow<'static, str>) -> Response {
    (
        [
            (header::CONTENT_TYPE, kind),
            (header::CONTENT_SECURITY_POLICY, SHELL_CSP),
        ],
        body,
    )
        .into_response()
}

#[cfg(debug_assertions)]
fn old_origin_probe_response(req: &Request<Body>, s: &Inner) -> Option<Response> {
    if s.active.load(Ordering::SeqCst)
        || req.method() != Method::GET
        || req.uri().path() != "/"
        || req.uri().query() != Some("wp05-old-check")
    {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CONTENT_SECURITY_POLICY, OLD_ORIGIN_DENIAL_CSP),
            ],
            OLD_ORIGIN_DENIAL_BODY,
        )
            .into_response(),
    )
}

fn proxy_csp(origin: &crate::connections::Origin) -> String {
    let port = origin.as_str().rsplit(':').next().unwrap();
    format!(
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:{port}; img-src 'self' data:; font-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'; worker-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    )
}

fn strip_reporting(value: &HeaderValue) -> Result<HeaderValue, ()> {
    let policy = value.to_str().map_err(|_| ())?;
    policy
        .split(';')
        .filter(|directive| {
            !directive.split_whitespace().next().is_some_and(|name| {
                name.eq_ignore_ascii_case("report-uri") || name.eq_ignore_ascii_case("report-to")
            })
        })
        .collect::<Vec<_>>()
        .join(";")
        .parse()
        .map_err(|_| ())
}
/// One ephemeral listener and one memory-only session jar per SPA window.
#[derive(Clone)]
pub struct SpaProxy {
    inner: Arc<Inner>,
    lifetime: Arc<()>,
    port: u16,
}
impl SpaProxy {
    /// Start with the same already-prepared origin-bound client as native API calls.
    pub async fn new(conn: &Connection, client: HarnessClient) -> Result<Self, ClientError> {
        if client.origin() != &conn.origin {
            return Err(ClientError::Protocol);
        }
        client.streaming_http()?;
        // Validate once when the authenticated SPA session is created. Every
        // subsequent proxied request reuses this immutable session snapshot;
        // a transient /meta outage must not turn an otherwise valid request
        // into a 502 or double every round trip.
        let session_meta = client.meta().await?;
        if session_meta.installation_id != conn.installation_id {
            return Err(ClientError::InstallationMismatch);
        }
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| ClientError::Network)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| ClientError::Network)?;
        let port = listener
            .local_addr()
            .map_err(|_| ClientError::Network)?
            .port();
        let origin = crate::connections::Origin::parse(&format!("http://127.0.0.1:{port}"))
            .map_err(|_| ClientError::Protocol)?;
        let mut random = [0; 32];
        let mut os_rng = OsRng;
        os_rng
            .try_fill_bytes(&mut random)
            .map_err(|_| ClientError::Network)?;
        let user_agent =
            SecretString::new(format!("PLUR1BUS-SPA/1 {}", URL_SAFE_NO_PAD.encode(random)));
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let inner = Arc::new(Inner {
            installation_id: conn.installation_id.clone(),
            session_meta: Mutex::new(session_meta),
            client,
            origin,
            jar: Mutex::new(Jar::default()),
            active: AtomicBool::new(true),
            shutdown,
            user_agent,
            error_settings: Mutex::new(Default::default()),
            #[cfg(debug_assertions)]
            observed_secrets: Mutex::new(Vec::new()),
            #[cfg(debug_assertions)]
            secondary_probe_403: AtomicBool::new(false),
        });
        // On Windows, handing Tokio a duplicated std listener leaves the two
        // socket handles in a state where accepts can stall. Move the original
        // listener into Tokio; the serving task retains the port for the full
        // process lifetime, including after this handle is retired.
        let serving =
            tokio::net::TcpListener::from_std(listener).map_err(|_| ClientError::Network)?;
        let router = Router::new()
            .fallback(any(forward))
            .with_state(inner.clone());
        tokio::spawn(async move {
            let _ = axum::serve(serving, router).await;
        });
        Ok(Self {
            inner,
            lifetime: Arc::new(()),
            port,
        })
    }
    /// Owned error pages use the same saved language and theme as the local shell.
    pub fn set_error_settings(&self, settings: crate::settings::Settings) {
        *self.inner.error_settings.lock().unwrap() = settings;
    }
    /// The exact active listener origin, used by both navigation and the remote ACL.
    pub fn origin(&self) -> &crate::connections::Origin {
        &self.inner.origin
    }
    /// Native-only per-window carrier. Never expose this through IPC or fixture output.
    pub fn user_agent(&self) -> &str {
        self.inner.user_agent.expose()
    }
    /// Trusted Rust-only seam for the WP6 known-secret registry (including random hash-shaped values).
    pub fn register_launch_secret(&self, register: impl FnOnce(&str)) {
        register(
            self.inner
                .user_agent
                .expose()
                .split_once(' ')
                .expect("fixed carrier")
                .1,
        );
    }
    /// Native fixture only: register browser-cookie values for the isolated disk audit.
    #[cfg(debug_assertions)]
    pub fn register_memory_secrets(&self, mut register: impl FnMut(&str)) {
        for value in self.inner.observed_secrets.lock().unwrap().iter() {
            register(value.expose());
        }
        if let Ok(url) = Url::parse(self.inner.client.origin().as_str()) {
            if let Some(header) = self.inner.jar.lock().unwrap().cookies(&url) {
                if let Ok(header) = header.to_str() {
                    for cookie in header.split(';') {
                        if let Some((_, value)) = cookie.trim().split_once('=') {
                            register(value);
                        }
                    }
                }
            }
        }
    }
    /// Debug-only assertion seam: inspect the actual jar, independent of remembered secrets.
    #[cfg(debug_assertions)]
    pub fn session_jar_is_empty(&self) -> bool {
        let url = Url::parse(self.inner.client.origin().as_str()).expect("validated origin");
        self.inner.jar.lock().unwrap().cookies(&url).is_none()
    }
    /// Refuse the readable launch carrier in HTTP targets and external navigation.
    pub fn has_launch_secret_in_target(&self, target: &str) -> bool {
        contains_launch_secret(target, &self.inner.user_agent)
    }
    /// Retire streams and erase cookies; retain the port until process exit to prevent ACL reuse.
    pub fn retire(&self) {
        self.inner.active.store(false, Ordering::SeqCst);
        self.inner.shutdown.send_replace(true);
        *self.inner.jar.lock().unwrap() = Jar::default();
        #[cfg(debug_assertions)]
        self.inner.observed_secrets.lock().unwrap().clear();
    }
    /// Revalidate the cached session metadata after a reconnect or an explicit
    /// version refresh. Ordinary browser requests deliberately do not call this.
    pub async fn revalidate_session_meta(&self) -> Result<(), ClientError> {
        let fresh = match self.inner.client.meta().await {
            Ok(fresh) => fresh,
            Err(error) => {
                self.retire();
                return Err(error);
            }
        };
        if fresh.installation_id != self.inner.installation_id {
            self.retire();
            return Err(ClientError::InstallationMismatch);
        }
        *self.inner.session_meta.lock().unwrap() = fresh;
        Ok(())
    }
    /// Reserved port (retired origins cannot be leased again by this process).
    pub fn port(&self) -> u16 {
        self.port
    }
    /// Debug-only closed observation for the native secondary-window 403 probe.
    #[cfg(debug_assertions)]
    pub fn reset_secondary_probe_403(&self) {
        self.inner
            .secondary_probe_403
            .store(false, Ordering::SeqCst);
    }
    /// Debug-only closed observation for the native secondary-window 403 probe.
    #[cfg(debug_assertions)]
    pub fn secondary_probe_403_observed(&self) -> bool {
        self.inner.secondary_probe_403.load(Ordering::SeqCst)
    }
}
impl Drop for SpaProxy {
    fn drop(&mut self) {
        if Arc::strong_count(&self.lifetime) == 1 {
            self.retire();
        }
    }
}
fn contains_launch_secret(target: &str, secret: &SecretString) -> bool {
    let nonce = secret.expose().split_once(' ').expect("fixed carrier").1;
    url::form_urlencoded::parse(target.as_bytes())
        .any(|(key, value)| key.contains(nonce) || value.contains(nonce))
}
#[cfg(debug_assertions)]
fn is_secondary_probe_marker(req: &Request<Body>) -> bool {
    req.method() == Method::GET
        && req.uri().path() == "/"
        && req.uri().query() == Some(SECONDARY_PROBE_MARKER)
        && req
            .headers()
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            == Some(SECONDARY_PROBE_USER_AGENT)
}

#[cfg(debug_assertions)]
fn record_secondary_probe_403(req: &Request<Body>, s: &Inner) {
    if !authorized(req, s) && is_secondary_probe_marker(req) {
        s.secondary_probe_403.store(true, Ordering::SeqCst);
    }
}
fn singleton_header(
    headers: &HeaderMap,
    name: header::HeaderName,
    expected: &str,
    optional: bool,
) -> bool {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return optional;
    };
    values.next().is_none() && value.to_str().ok() == Some(expected)
}
fn authorized(req: &Request<Body>, s: &Inner) -> bool {
    let websocket_upgrade = req
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    let origin_optional =
        !websocket_upgrade && (req.method() == Method::GET || req.method() == Method::HEAD);
    s.active.load(Ordering::SeqCst)
        && singleton_header(
            req.headers(),
            header::USER_AGENT,
            s.user_agent.expose(),
            false,
        )
        && singleton_header(
            req.headers(),
            header::HOST,
            s.origin
                .as_str()
                .strip_prefix("http://")
                .expect("bound HTTP listener"),
            false,
        )
        && singleton_header(
            req.headers(),
            header::ORIGIN,
            s.origin.as_str(),
            origin_optional,
        )
}

fn hop_header(name: &str, headers: &HeaderMap) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    ) || headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|v| v.trim().eq_ignore_ascii_case(name))
}
fn upstream_headers(headers: &HeaderMap, s: &Inner, target: &Url) -> HeaderMap {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        if !hop_header(name.as_str(), headers)
            && !value
                .as_bytes()
                .windows(
                    s.user_agent
                        .expose()
                        .split_once(' ')
                        .expect("fixed carrier")
                        .1
                        .len(),
                )
                .any(|v| {
                    v == s
                        .user_agent
                        .expose()
                        .split_once(' ')
                        .expect("fixed carrier")
                        .1
                        .as_bytes()
                })
            && !matches!(
                name.as_str(),
                "authorization"
                    | "cookie"
                    | "host"
                    | "origin"
                    | "referer"
                    | "user-agent"
                    | "sec-websocket-key"
                    | "sec-websocket-version"
                    | "sec-websocket-extensions"
            )
        {
            result.append(name.clone(), value.clone());
        }
    }
    let origin = s.client.origin().as_str();
    let authority = origin.split_once("://").expect("validated origin").1;
    result.insert(
        header::HOST,
        authority.parse().expect("validated authority"),
    );
    result.insert(header::ORIGIN, origin.parse().expect("validated origin"));
    result.insert(
        header::REFERER,
        format!("{origin}/").parse().expect("validated origin"),
    );
    if let Some(cookies) = s.jar.lock().unwrap().cookies(target) {
        result.insert(header::COOKIE, cookies);
    }
    result
}
fn store_cookies(s: &Inner, headers: &HeaderMap, target: &Url) -> bool {
    let jar = s.jar.lock().unwrap();
    if !s.active.load(Ordering::SeqCst) {
        return false;
    }
    for header in headers.get_all(header::SET_COOKIE).iter() {
        if let Ok(text) = header.to_str() {
            if let Some((_, value)) = text.split(';').next().unwrap_or_default().split_once('=') {
                crate::logging::SecretRegistry::process().register_sensitive(value);
            }
        }
    }
    let mut values = headers.get_all(header::SET_COOKIE).iter();
    jar.set_cookies(&mut values, target);
    true
}
async fn forward(
    State(s): State<Arc<Inner>>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    req: Request<Body>,
) -> Response {
    if !authorized(&req, &s) {
        #[cfg(debug_assertions)]
        if let Some(response) = old_origin_probe_response(&req, &s) {
            return response;
        }
        #[cfg(debug_assertions)]
        record_secondary_probe_403(&req, &s);
        return StatusCode::FORBIDDEN.into_response();
    }
    // The carrier is readable by its renderer. Never reflect it into an upstream request target.
    if contains_launch_secret(&req.uri().to_string(), &s.user_agent) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    #[cfg(debug_assertions)]
    if let Some(csrf) = req
        .headers()
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .filter(|value| (16..=512).contains(&value.len()))
    {
        s.observed_secrets
            .lock()
            .unwrap()
            .push(SecretString::new(csrf.to_owned()));
    }
    if req.uri().path().starts_with("/__shell/") {
        let (kind, body) = match req.uri().path() {
            "/__shell/ticket-error" => (
                "text/html; charset=utf-8",
                std::borrow::Cow::Owned({
                    let settings = *s.error_settings.lock().unwrap();
                    let theme = match settings.theme {
                        crate::settings::Theme::System => "system",
                        crate::settings::Theme::Light => "light",
                        crate::settings::Theme::Dark => "dark",
                    };
                    let locale = match settings.locale {
                        crate::settings::Locale::System => "system",
                        crate::settings::Locale::En => "en",
                        crate::settings::Locale::De => "de",
                    };
                    include_str!("../../ui/src/views/ticket-error.html")
                        .replace("data-theme=\"system\"", &format!("data-theme=\"{theme}\""))
                        .replace(
                            "data-locale=\"system\"",
                            &format!("data-locale=\"{locale}\""),
                        )
                }),
            ),
            "/__shell/error.css" => (
                "text/css; charset=utf-8",
                std::borrow::Cow::Borrowed(include_str!("../../ui/src/views/ticket-error.css")),
            ),
            "/__shell/theme.css" => (
                "text/css; charset=utf-8",
                std::borrow::Cow::Borrowed(include_str!("../../ui/src/theme/tokens.css")),
            ),
            "/__shell/error.js" => (
                "text/javascript; charset=utf-8",
                std::borrow::Cow::Borrowed(include_str!("../../ui/src/views/ticket-error.js")),
            ),
            _ => return StatusCode::NOT_FOUND.into_response(),
        };
        return shell_response(kind, body);
    }
    // The immutable metadata snapshot was validated when this SPA session was
    // created. It is intentionally not re-fetched for each browser request.
    if s.session_meta.lock().unwrap().installation_id != s.installation_id {
        *s.jar.lock().unwrap() = Jar::default();
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let target = match Url::parse(&format!(
        "{}{}",
        s.client.origin().as_str(),
        req.uri().path_and_query().map_or("/", |p| p.as_str())
    )) {
        Ok(v) => v,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let headers = upstream_headers(req.headers(), &s, &target);
    if req
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        let Ok(mut ws) = ws else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let mut ws_target = target.clone();
        let _ = ws_target.set_scheme(if target.scheme() == "https" {
            "wss"
        } else {
            "ws"
        });
        let Ok(mut upstream) = ws_target.as_str().into_client_request() else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        upstream.headers_mut().extend(headers);
        let connector = match s.client.websocket_connector() {
            Ok(v) => v,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        let opened = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async_tls_with_config(upstream, None, false, connector),
        )
        .await;
        let Ok(Ok((socket, response))) = opened else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        if !s.active.load(Ordering::SeqCst) {
            return StatusCode::FORBIDDEN.into_response();
        }
        if !store_cookies(&s, response.headers(), &target) {
            return StatusCode::FORBIDDEN.into_response();
        }
        let mut selected = response
            .headers()
            .get_all(header::SEC_WEBSOCKET_PROTOCOL)
            .iter();
        let selected = match (selected.next(), selected.next()) {
            (Some(value), None) => match value.to_str() {
                Ok(value) if !value.trim().is_empty() && !value.contains(',') => {
                    Some(value.trim().to_owned())
                }
                _ => return StatusCode::BAD_GATEWAY.into_response(),
            },
            (None, None) => None,
            _ => return StatusCode::BAD_GATEWAY.into_response(),
        };
        // Axum mirrors only protocols offered by the browser. Reject an upstream
        // selection outside that offer instead of acknowledging a mismatched socket.
        if let Some(selected) = selected {
            ws = ws.protocols([selected]);
            if ws.selected_protocol().is_none() {
                return StatusCode::BAD_GATEWAY.into_response();
            }
        }
        return ws
            .on_upgrade(move |down| websocket_pump(down, socket, s.shutdown.subscribe()))
            .into_response();
    }
    let http = match s.client.streaming_http() {
        Ok(v) => v,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let (parts, body) = req.into_parts();
    let sent = tokio::time::timeout(
        Duration::from_secs(10),
        http.request(parts.method, target.clone())
            .headers(headers)
            .body(reqwest::Body::wrap_stream(body.into_data_stream()))
            .send(),
    )
    .await;
    let Ok(Ok(response)) = sent else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if !s.active.load(Ordering::SeqCst) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !store_cookies(&s, response.headers(), &target) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut headers = HeaderMap::new();
    for (name, value) in response.headers() {
        if !hop_header(name.as_str(), response.headers())
            && !matches!(
                name.as_str(),
                "set-cookie" | "location" | "reporting-endpoints" | "report-to" | "nel"
            )
            && !name.as_str().starts_with("access-control-")
        {
            if name == header::CONTENT_SECURITY_POLICY
                || name.as_str() == "content-security-policy-report-only"
            {
                // Reporting destinations can bypass connect-src and carry the native User-Agent.
                let Ok(value) = strip_reporting(value) else {
                    return StatusCode::BAD_GATEWAY.into_response();
                };
                headers.append(name.clone(), value);
            } else {
                headers.append(name.clone(), value.clone());
            }
        }
    }
    if let Some(location) = response.headers().get(header::LOCATION) {
        let Some(location) = location.to_str().ok().and_then(|v| target.join(v).ok()) else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        if !crate::policy::same_origin(&location, s.client.origin()) {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        let rewritten = format!(
            "{}{}{}{}",
            s.origin.as_str(),
            location.path(),
            location
                .query()
                .map(|v| format!("?{v}"))
                .unwrap_or_default(),
            location
                .fragment()
                .map(|v| format!("#{v}"))
                .unwrap_or_default()
        );
        let Ok(value) = rewritten.parse() else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        headers.insert(header::LOCATION, value);
    }
    // Intersect with the harness nonce/hash policy. No external resource can carry the native UA secret.
    let restriction = proxy_csp(&s.origin);
    headers.append(
        header::CONTENT_SECURITY_POLICY,
        restriction.parse().expect("fixed CSP"),
    );
    let status = response.status();
    let mut shutdown = s.shutdown.subscribe();
    let stream = response.bytes_stream().take_until(async move {
        if !*shutdown.borrow() {
            let _ = shutdown.changed().await;
        }
    });
    let mut result = Response::new(Body::from_stream(stream));
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    result
}

// Shared by the actual upgrade path and deterministic backpressure regressions.
async fn websocket_pump<D, U, DE, UE>(
    mut down: D,
    mut up: U,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) where
    D: Stream<Item = Result<axum::extract::ws::Message, DE>>
        + Sink<axum::extract::ws::Message>
        + Unpin,
    U: Stream<Item = Result<Message, UE>> + Sink<Message> + Unpin,
{
    // An upgrade may finish after its owner retired. Drop both sockets without
    // polling them, including close/flush, in that case.
    if *shutdown.borrow() {
        return;
    }
    let forwarding = async {
        loop {
            tokio::select! {
                incoming = down.next() => {
                    let Some(Ok(message)) = incoming else { break };
                    let message = match message {
                        axum::extract::ws::Message::Text(value) => Message::Text(value.as_str().into()),
                        axum::extract::ws::Message::Binary(value) => Message::Binary(value),
                        axum::extract::ws::Message::Ping(value) => Message::Ping(value),
                        axum::extract::ws::Message::Pong(value) => Message::Pong(value),
                        axum::extract::ws::Message::Close(_) => break,
                    };
                    if up.send(message).await.is_err() { break }
                }
                incoming = up.next() => {
                    let Some(Ok(message)) = incoming else { break };
                    let message = match message {
                        Message::Text(value) => axum::extract::ws::Message::Text(value.as_str().into()),
                        Message::Binary(value) => axum::extract::ws::Message::Binary(value),
                        Message::Ping(value) => axum::extract::ws::Message::Ping(value),
                        Message::Pong(value) => axum::extract::ws::Message::Pong(value),
                        Message::Close(_) => break,
                        Message::Frame(_) => continue,
                    };
                    if down.send(message).await.is_err() { break }
                }
            }
        }
        // A normal close is best effort across both peers, with one shared grace.
        // Retirement also cancels this grace; it never waits for a stalled peer.
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            let _ = tokio::join!(down.close(), up.close());
        })
        .await;
    };
    // The race must enclose sends as well as reads. Dropping the losing future
    // abandons any pending write, then dropping this function's owned sockets
    // ends the authenticated session. Bytes already handed to the OS stay sent.
    tokio::select! {
        biased;
        _ = shutdown.changed() => {}
        _ = forwarding => {}
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use crate::{client::HarnessClient, connections::Origin};
    use axum::{
        body::Body, extract::ws::rejection::MethodNotGet,
        extract::ws::rejection::WebSocketUpgradeRejection, extract::State,
    };

    use std::{
        pin::Pin,
        sync::atomic::AtomicUsize,
        task::{Context, Poll, Waker},
    };

    #[derive(Clone, Copy, PartialEq)]
    enum BlockAt {
        Ready,
        Flush,
        Close,
    }

    #[derive(Default)]
    struct SocketProbe {
        blocked: tokio::sync::Notify,
        released: AtomicBool,
        waker: Mutex<Option<Waker>>,
        sends: AtomicUsize,
        flushes: AtomicUsize,
        closes: AtomicUsize,
        polls: AtomicUsize,
        dropped: AtomicBool,
    }
    impl SocketProbe {
        fn release(&self) {
            self.released.store(true, Ordering::SeqCst);
            if let Some(waker) = self.waker.lock().unwrap().take() {
                waker.wake();
            }
        }
    }

    // A real Sink::send progresses through readiness, start_send and flush.
    // The barrier is emitted only when the selected operation actually returns Pending.
    struct ControlledSocket<M> {
        incoming: Option<M>,
        eof: bool,
        block: Option<BlockAt>,
        probe: Arc<SocketProbe>,
    }
    impl<M> ControlledSocket<M> {
        fn new(incoming: Option<M>, eof: bool, block: Option<BlockAt>) -> Self {
            Self {
                incoming,
                eof,
                block,
                probe: Arc::default(),
            }
        }
        fn poll_operation(&self, operation: BlockAt, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
            self.probe.polls.fetch_add(1, Ordering::SeqCst);
            if self.block == Some(operation) && !self.probe.released.load(Ordering::SeqCst) {
                *self.probe.waker.lock().unwrap() = Some(cx.waker().clone());
                self.probe.blocked.notify_one();
                Poll::Pending
            } else {
                Poll::Ready(Ok(()))
            }
        }
    }
    impl<M: Unpin> Stream for ControlledSocket<M> {
        type Item = Result<M, ()>;
        fn poll_next(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            self.probe.polls.fetch_add(1, Ordering::SeqCst);
            match self.incoming.take() {
                Some(message) => Poll::Ready(Some(Ok(message))),
                None if self.eof => Poll::Ready(None),
                None => Poll::Pending,
            }
        }
    }
    impl<M: Unpin> Sink<M> for ControlledSocket<M> {
        type Error = ();
        fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
            self.poll_operation(BlockAt::Ready, cx)
        }
        fn start_send(self: Pin<&mut Self>, _: M) -> Result<(), ()> {
            self.probe.sends.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
            let result = self.poll_operation(BlockAt::Flush, cx);
            if result.is_ready() {
                self.probe.flushes.fetch_add(1, Ordering::SeqCst);
            }
            result
        }
        fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
            let result = self.poll_operation(BlockAt::Close, cx);
            if result.is_ready() {
                self.probe.closes.fetch_add(1, Ordering::SeqCst);
            }
            result
        }
    }
    impl<M> Drop for ControlledSocket<M> {
        fn drop(&mut self) {
            self.probe.dropped.store(true, Ordering::SeqCst);
        }
    }
    fn pump_owner() -> SpaProxy {
        SpaProxy {
            inner: test_inner(),
            lifetime: Arc::new(()),
            port: 12345,
        }
    }
    async fn reached_pending(probe: &SocketProbe) {
        tokio::time::timeout(Duration::from_secs(2), probe.blocked.notified())
            .await
            .expect("pump did not reach the controlled pending operation");
    }
    async fn completed_while_stalled(
        task: &mut tokio::task::JoinHandle<()>,
        down: &SocketProbe,
        up: &SocketProbe,
        bound: Duration,
    ) {
        let completed = tokio::time::timeout(bound, &mut *task).await;
        // Abort only on failure, so a failing RED test cannot leak its stuck task.
        if completed.is_err() {
            task.abort();
        }
        completed
            .expect("pump stayed alive while peer remained stalled")
            .unwrap();
        assert!(down.dropped.load(Ordering::SeqCst));
        assert!(up.dropped.load(Ordering::SeqCst));
        let progress = (
            down.polls.load(Ordering::SeqCst),
            up.polls.load(Ordering::SeqCst),
        );
        down.release();
        up.release();
        tokio::task::yield_now().await;
        assert_eq!(
            progress,
            (
                down.polls.load(Ordering::SeqCst),
                up.polls.load(Ordering::SeqCst)
            ),
            "a dropped pump must never resume forwarding after the peer is released"
        );
    }
    async fn blocked_send_retirement(to_upstream: bool, block: BlockAt) {
        let owner = pump_owner();
        let down = ControlledSocket::new(
            to_upstream.then(|| axum::extract::ws::Message::Text("pending".into())),
            false,
            (!to_upstream).then_some(block),
        );
        let up = ControlledSocket::new(
            (!to_upstream).then(|| Message::Text("pending".into())),
            false,
            to_upstream.then_some(block),
        );
        let (down_probe, up_probe) = (down.probe.clone(), up.probe.clone());
        let destination = if to_upstream { &up_probe } else { &down_probe };
        let mut task = tokio::spawn(websocket_pump(down, up, owner.inner.shutdown.subscribe()));
        reached_pending(destination).await;
        assert_eq!(
            destination.sends.load(Ordering::SeqCst),
            usize::from(block == BlockAt::Flush)
        );
        assert_eq!(destination.flushes.load(Ordering::SeqCst), 0);
        owner.retire();
        completed_while_stalled(
            &mut task,
            &down_probe,
            &up_probe,
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(destination.flushes.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn websocket_retirement_cancels_upstream_send_readiness() {
        blocked_send_retirement(true, BlockAt::Ready).await;
    }
    #[tokio::test]
    async fn websocket_retirement_cancels_upstream_send_flush() {
        blocked_send_retirement(true, BlockAt::Flush).await;
    }
    #[tokio::test]
    async fn websocket_retirement_cancels_downstream_send_readiness() {
        blocked_send_retirement(false, BlockAt::Ready).await;
    }
    #[tokio::test]
    async fn websocket_retirement_cancels_downstream_send_flush() {
        blocked_send_retirement(false, BlockAt::Flush).await;
    }
    async fn blocked_close(retire: bool, upstream: bool) {
        let owner = pump_owner();
        let down = ControlledSocket::<axum::extract::ws::Message>::new(
            None,
            true,
            (!upstream).then_some(BlockAt::Close),
        );
        let up = ControlledSocket::<Message>::new(None, false, upstream.then_some(BlockAt::Close));
        let (down_probe, up_probe) = (down.probe.clone(), up.probe.clone());
        let blocked = if upstream { &up_probe } else { &down_probe };
        let mut task = tokio::spawn(websocket_pump(down, up, owner.inner.shutdown.subscribe()));
        reached_pending(blocked).await;
        if retire {
            owner.retire();
        }
        let bound = if retire {
            Duration::from_millis(500)
        } else {
            Duration::from_secs(2)
        };
        completed_while_stalled(&mut task, &down_probe, &up_probe, bound).await;
        assert_eq!(blocked.closes.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn websocket_retirement_cancels_downstream_close() {
        blocked_close(true, false).await;
    }
    #[tokio::test]
    async fn websocket_retirement_cancels_upstream_close() {
        blocked_close(true, true).await;
    }
    #[tokio::test]
    async fn websocket_normal_close_backpressure_is_bounded() {
        blocked_close(false, false).await;
        blocked_close(false, true).await;
    }
    #[tokio::test]
    async fn websocket_retirement_before_upgrade_drops_without_io() {
        let owner = pump_owner();
        owner.retire();
        let down =
            ControlledSocket::<axum::extract::ws::Message>::new(None, false, Some(BlockAt::Close));
        let up = ControlledSocket::<Message>::new(None, false, Some(BlockAt::Close));
        let (down_probe, up_probe) = (down.probe.clone(), up.probe.clone());
        let mut task = tokio::spawn(websocket_pump(down, up, owner.inner.shutdown.subscribe()));
        completed_while_stalled(
            &mut task,
            &down_probe,
            &up_probe,
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(down_probe.polls.load(Ordering::SeqCst), 0);
        assert_eq!(up_probe.polls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn websocket_active_backpressure_can_resume_without_frame_timeout() {
        for to_upstream in [true, false] {
            let owner = pump_owner();
            let down = ControlledSocket::new(
                to_upstream.then(|| axum::extract::ws::Message::Text("delayed".into())),
                to_upstream,
                (!to_upstream).then_some(BlockAt::Flush),
            );
            let up = ControlledSocket::new(
                (!to_upstream).then(|| Message::Text("delayed".into())),
                !to_upstream,
                to_upstream.then_some(BlockAt::Flush),
            );
            let (down_probe, up_probe) = (down.probe.clone(), up.probe.clone());
            let blocked = if to_upstream { &up_probe } else { &down_probe };
            let mut task = tokio::spawn(websocket_pump(down, up, owner.inner.shutdown.subscribe()));
            reached_pending(blocked).await;
            // Hold a genuine in-flight send past the normal-close grace. It must
            // still be active, then complete its flush when the peer resumes.
            assert!(tokio::time::timeout(Duration::from_millis(1100), &mut task)
                .await
                .is_err());
            assert!(!down_probe.dropped.load(Ordering::SeqCst));
            assert!(!up_probe.dropped.load(Ordering::SeqCst));
            blocked.release();
            tokio::time::timeout(Duration::from_millis(500), &mut task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(blocked.sends.load(Ordering::SeqCst), 1);
            assert_eq!(blocked.flushes.load(Ordering::SeqCst), 1);
            assert!(down_probe.dropped.load(Ordering::SeqCst));
            assert!(up_probe.dropped.load(Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn websocket_close_frames_use_bounded_grace() {
        for from_upstream in [true, false] {
            let owner = pump_owner();
            let down = ControlledSocket::new(
                (!from_upstream).then_some(axum::extract::ws::Message::Close(None)),
                false,
                Some(BlockAt::Close),
            );
            let up = ControlledSocket::new(
                from_upstream.then_some(Message::Close(None)),
                false,
                Some(BlockAt::Close),
            );
            let (down_probe, up_probe) = (down.probe.clone(), up.probe.clone());
            let mut task = tokio::spawn(websocket_pump(down, up, owner.inner.shutdown.subscribe()));
            reached_pending(&down_probe).await;
            reached_pending(&up_probe).await;
            completed_while_stalled(&mut task, &down_probe, &up_probe, Duration::from_secs(2))
                .await;
            assert_eq!(down_probe.sends.load(Ordering::SeqCst), 0);
            assert_eq!(up_probe.sends.load(Ordering::SeqCst), 0);
        }
    }

    fn test_inner() -> Arc<Inner> {
        let origin = Origin::parse("http://127.0.0.1:12345").unwrap();
        let (shutdown, _) = tokio::sync::watch::channel(false);
        Arc::new(Inner {
            installation_id: "test-installation".into(),
            session_meta: Mutex::new(Meta {
                api_version: "1.0.0".into(),
                version: "test".into(),
                installation_id: "test-installation".into(),
                capabilities: vec![plur1bus_desktop_contract::capability::SESSION_TICKET.into()],
            }),
            client: HarnessClient::new(origin.clone(), None),
            origin,
            jar: Mutex::new(reqwest::cookie::Jar::default()),
            active: AtomicBool::new(true),
            shutdown,
            user_agent: SecretString::new("PLUR1BUS-SPA/1 expected-secret".to_string()),
            error_settings: Mutex::new(Default::default()),
            observed_secrets: Mutex::new(Vec::new()),
            secondary_probe_403: AtomicBool::new(false),
        })
    }

    fn request(uri: &str, user_agent: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(header::HOST, "127.0.0.1:12345")
            .header(header::USER_AGENT, user_agent)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn secondary_marker_records_only_proxy_generated_403() {
        tokio::time::timeout(Duration::from_secs(60), async {
            let state = test_inner();
            let response = forward(
                State(state.clone()),
                Err(WebSocketUpgradeRejection::MethodNotGet(
                    MethodNotGet::default(),
                )),
                request("/?wp05-secondary-probe=1", SECONDARY_PROBE_USER_AGENT),
            )
            .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap()
                .is_empty());
            assert!(state.secondary_probe_403.load(Ordering::SeqCst));

            state.secondary_probe_403.store(false, Ordering::SeqCst);
            let response = forward(
                State(state.clone()),
                Err(WebSocketUpgradeRejection::MethodNotGet(
                    MethodNotGet::default(),
                )),
                request("/?unrelated=1", SECONDARY_PROBE_USER_AGENT),
            )
            .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(!state.secondary_probe_403.load(Ordering::SeqCst));

            let authorized_request =
                request("/?wp05-secondary-probe=1", "PLUR1BUS-SPA/1 expected-secret");
            assert!(authorized(&authorized_request, &state));
            record_secondary_probe_403(&authorized_request, &state);
            assert!(!state.secondary_probe_403.load(Ordering::SeqCst));
        })
        .await
        .expect("secondary probe observer test timed out");
    }

    #[tokio::test]
    async fn old_origin_marker_gets_inert_html_forbidden_document() {
        let state = test_inner();
        state.active.store(false, Ordering::SeqCst);
        let response = forward(
            State(state.clone()),
            Err(WebSocketUpgradeRejection::MethodNotGet(
                MethodNotGet::default(),
            )),
            request("/?wp05-old-check", "wrong"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .unwrap(),
            OLD_ORIGIN_DENIAL_CSP
        );
        let has_acao = response
            .headers()
            .contains_key("access-control-allow-origin");
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("WP05 diagnostic forbidden document"));
        assert!(!body.contains("<script"));
        assert!(!body.contains("wp05-old-check"));
        assert!(!has_acao);
        assert!(!state.secondary_probe_403.load(Ordering::SeqCst));
    }

    #[test]
    fn old_origin_marker_is_exact_and_does_not_change_other_denials() {
        let state = test_inner();
        state.active.store(false, Ordering::SeqCst);
        assert!(old_origin_probe_response(&request("/?wp05-old-check", "wrong"), &state).is_some());
        assert!(
            old_origin_probe_response(&request("/nested?wp05-old-check", "wrong"), &state)
                .is_none()
        );
        assert!(
            old_origin_probe_response(&request("/?wp05-old-check=1", "wrong"), &state).is_none()
        );
        assert!(
            old_origin_probe_response(&request("/?wp05-secondary-probe=1", "wrong"), &state)
                .is_none()
        );
        assert!(old_origin_probe_response(&request("/", "wrong"), &state).is_none());
    }

    #[tokio::test]
    async fn active_old_origin_marker_keeps_empty_forbidden_response() {
        let state = test_inner();
        let response = forward(
            State(state),
            Err(WebSocketUpgradeRejection::MethodNotGet(
                MethodNotGet::default(),
            )),
            request("/?wp05-old-check", "wrong"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap()
            .is_empty());
    }
}
