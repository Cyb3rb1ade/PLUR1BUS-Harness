//! Approved fallback: a per-window authenticated, origin-bound Rust HTTP/SSE/WS proxy.
use crate::{
    client::{ClientError, HarnessClient},
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
use futures_util::{SinkExt, StreamExt};
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
    client: HarnessClient,
    origin: crate::connections::Origin,
    jar: Mutex<Jar>,
    active: AtomicBool,
    shutdown: tokio::sync::watch::Sender<bool>,
    user_agent: SecretString,
    error_settings: Mutex<crate::settings::Settings>,
    #[cfg(debug_assertions)]
    observed_secrets: Mutex<Vec<SecretString>>,
}
const SHELL_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

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
            client,
            origin,
            jar: Mutex::new(Jar::default()),
            active: AtomicBool::new(true),
            shutdown,
            user_agent,
            error_settings: Mutex::new(Default::default()),
            #[cfg(debug_assertions)]
            observed_secrets: Mutex::new(Vec::new()),
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
    /// Reserved port (retired origins cannot be leased again by this process).
    pub fn port(&self) -> u16 {
        self.port
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
    let origin_optional = req.method() == Method::GET || req.method() == Method::HEAD;
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
    // A cookie is authentication too: refuse a replacement installation before sending it.
    match s.client.meta().await {
        Ok(meta) if meta.installation_id == s.installation_id => {}
        Ok(_) => {
            *s.jar.lock().unwrap() = Jar::default();
            return StatusCode::BAD_GATEWAY.into_response();
        }
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
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
            .on_upgrade(move |mut down| async move {
                let mut up = socket;
                let mut shutdown = s.shutdown.subscribe();
                if *shutdown.borrow() {
                    let _ = up.close(None).await;
                    return;
                }
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => break,
                        incoming = down.recv() => {
                            let Some(Ok(message)) = incoming else { break };
                            let message = match message {
                                axum::extract::ws::Message::Text(value) => Message::Text(value.as_str().into()),
                                axum::extract::ws::Message::Binary(value) => Message::Binary(value),
                                axum::extract::ws::Message::Ping(value) => Message::Ping(value),
                                axum::extract::ws::Message::Pong(value) => Message::Pong(value),
                                axum::extract::ws::Message::Close(_) => Message::Close(None),
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
                                Message::Close(_) => axum::extract::ws::Message::Close(None),
                                Message::Frame(_) => continue,
                            };
                            if down.send(message).await.is_err() { break }
                        }
                    }
                }
                let _ = down.close().await;
                let _ = up.close(None).await;
            })
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
