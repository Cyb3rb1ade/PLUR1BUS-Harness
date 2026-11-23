//! The HTTP request gate and JSON-RPC endpoint. Core owns agent sessions and task retention.
mod commands;
mod rates;

pub use commands::{Command, PushAuthentication, PushConfig, Start};

use crate::{
    card::{self, AgentInfo, Features},
    events::{envelope, object, sse},
    parts,
};
use plur1bus_providers::Json;
use rates::Buckets;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, SocketAddr},
    sync::Mutex,
    time::Instant,
};
use subtle::{Choice, ConstantTimeEq};

const ROOT_CARD: &str = "/.well-known/agent-card.json";
const MAX_STRUCTURED: usize = 1024 * 1024;
const MAX_HEADERS: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Card,
    Send,
    Read,
    Cancel,
    Push,
}

pub struct Peer {
    id: String,
    sha256: [u8; 32],
    grants: BTreeMap<String, Vec<Action>>,
}

impl Peer {
    pub fn new(
        id: impl Into<String>,
        sha256: [u8; 32],
        grants: BTreeMap<String, Vec<Action>>,
    ) -> Self {
        Self {
            id: id.into(),
            sha256,
            grants,
        }
    }

    pub fn from_bearer(
        id: impl Into<String>,
        token: &str,
        grants: BTreeMap<String, Vec<Action>>,
    ) -> Self {
        Self::new(id, Sha256::digest(token).into(), grants)
    }
}

#[derive(Clone, Copy)]
pub struct Window<'a> {
    pub deadline: Instant,
    pub canceled: &'a dyn Fn() -> bool,
}

impl Window<'_> {
    pub fn active(self) -> bool {
        Instant::now() < self.deadline && !(self.canceled)()
    }
}

pub struct Config {
    pub base_url: String,
    pub version: String,
    pub default_agent: Option<String>,
    pub features: Features,
    pub max_body_bytes: usize,
    pub parts: parts::Limits,
    pub address_per_minute: u32,
    pub peer_per_minute: u32,
    pub failed_auth_per_minute: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1".into(),
            version: "0.1.0".into(),
            default_agent: None,
            features: Features::default(),
            max_body_bytes: MAX_STRUCTURED,
            parts: parts::Limits::default(),
            address_per_minute: 240,
            peer_per_minute: 60,
            failed_auth_per_minute: 10,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigError {
    InvalidLimits,
    InvalidPeer,
    InvalidAdvertisement,
}

pub struct Endpoint {
    config: Config,
    peers: Vec<Peer>,
    rates: Mutex<Rates>,
}

struct Rates {
    address: Buckets,
    peer: Buckets,
    failed_auth: Buckets,
}

#[derive(Clone, Copy)]
pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    /// Lowercase field names. The HTTP host rejects ambiguous header framing.
    pub headers: &'a BTreeMap<String, String>,
    /// Canonical socket address without a port. Never use a forwarded address.
    pub remote: &'a str,
    pub window: Window<'a>,
}

/// A listener accepts only loopback IPs and Host values for its actual port.
pub fn listener_accepts(bound: IpAddr, port: u16, authority: &str, target: &str) -> bool {
    if !bound.is_loopback() || !target.starts_with('/') || target.starts_with("//") {
        return false;
    }
    let bound = if bound.is_ipv6() {
        format!("[{bound}]")
    } else {
        bound.to_string()
    };
    [bound.as_str(), "127.0.0.1", "[::1]", "localhost"]
        .iter()
        .any(|host| authority.eq_ignore_ascii_case(&format!("{host}:{port}")))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BodyError {
    TooLarge,
    Unreadable,
}

pub struct Response {
    pub status: u16,
    pub headers: BTreeMap<&'static str, String>,
    pub body: Body,
}

pub enum Body {
    Text(String),
    Stream(Box<Stream>),
}

pub struct Stream {
    id: Json,
    task_id: String,
    context_id: String,
    source: Option<Box<dyn EventSource>>,
    deadline: Instant,
}

pub trait EventSource {
    /// Use the same request window for a blocking wait. Dropping the source releases the stream
    /// slot without canceling the task. Core owns retention, coalescing and subscription limits.
    fn next(&mut self, window: Window<'_>) -> Result<Option<Json>, RpcError>;
}

impl Stream {
    pub fn next_frame(&mut self, window: Window<'_>) -> Result<Option<String>, RpcError> {
        let window = Window {
            deadline: window.deadline.min(self.deadline),
            ..window
        };
        if !window.active() {
            self.source.take();
            return Ok(None);
        }
        let Some(source) = self.source.as_mut() else {
            return Ok(None);
        };
        let item = source.next(window);
        if !window.active() {
            self.source.take();
            return Ok(None);
        }
        let result = item.and_then(|event| {
            event
                .map(|event| {
                    let id_field = match event["kind"].text() {
                        "task" => "id",
                        "status-update" | "artifact-update" => "taskId",
                        _ => return Err(RpcError::InvalidAgentResponse),
                    };
                    if event[id_field].string() != Some(&self.task_id)
                        || event["contextId"].string() != Some(&self.context_id)
                    {
                        return Err(RpcError::InvalidAgentResponse);
                    }
                    let final_event = event["kind"].text() == "status-update"
                        && event["final"].boolean() == Some(true);
                    let frame = sse(&self.id, event);
                    if frame.len() > MAX_STRUCTURED {
                        return Err(RpcError::InvalidAgentResponse);
                    }
                    Ok((frame, final_event))
                })
                .transpose()
        });
        match result {
            Ok(Some((frame, final_event))) => {
                if final_event {
                    self.source.take();
                }
                Ok(Some(frame))
            }
            other => {
                self.source.take();
                other.map(|_| None)
            }
        }
    }
}

pub enum Output {
    Json(Json),
    Stream {
        task_id: String,
        context_id: String,
        source: Box<dyn EventSource>,
    },
}

pub struct TaskScope<'a> {
    pub peer: &'a str,
    pub provenance: plur1bus_providers::provenance::Provenance,
    pub agent: &'a str,
}

pub trait Host {
    fn now_ms(&self) -> u64;
    fn agent(&self, agent: &str) -> Option<AgentInfo>;
    /// Apply additional Core session consent/policy and the peer/agent ownership check before
    /// accessing any existing task. A start/set with a push configuration must admit its URL
    /// before mutation. Task IDs cannot be used across scopes.
    fn task(
        &self,
        scope: TaskScope<'_>,
        op: Command,
        window: Window<'_>,
    ) -> Result<Output, RpcError>;
    fn audit(&self, event: Audit);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Audit {
    RateAddress,
    RatePeer,
    RateAuth,
    NoCredential,
    BadCredential,
    UnknownAgent,
    HiddenAgent,
    AgentNotGranted,
    ActionNotGranted,
    BodyTooLarge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RpcError {
    Params(&'static str),
    Part(parts::Error),
    TaskNotFound,
    TaskNotCancelable,
    TaskLimit,
    NoProvider,
    StreamingDisabled,
    PushNotSupported,
    PushDenied,
    InvalidAgentResponse,
    Internal,
}

fn rpc_error(
    id: &Json,
    code: i32,
    message: &'static str,
    reason: Option<&'static str>,
) -> Response {
    let mut error = object([
        ("code", f64::from(code).into()),
        ("message", message.into()),
    ]);
    if let Some(reason) = reason {
        error.set("data", object([("reason", reason.into())]));
    }
    json_response(200, &envelope(id, "error", error))
}

impl RpcError {
    fn response(self, id: &Json) -> Response {
        use RpcError::*;
        let (code, msg, reason) = match self {
            Params(msg) => (-32602, msg, None),
            Part(part) => match part {
                parts::Error::Unsupported => (-32005, part.message(), None),
                parts::Error::Invalid(_) => (-32602, part.message(), None),
                parts::Error::TooLarge(_, reason) => (-32602, part.message(), Some(reason)),
                parts::Error::TooMany => (-32602, part.message(), Some("too-many-parts")),
            },
            TaskNotFound => (-32001, "task not found", None),
            TaskNotCancelable => (-32002, "task is not cancelable", None),
            TaskLimit => (-32000, "too many live tasks", Some("task-limit")),
            NoProvider => (-32603, "the agent is not available", Some("no-provider")),
            StreamingDisabled => (
                -32004,
                "streaming is not supported",
                Some("not-implemented"),
            ),
            PushNotSupported => (-32003, "push notifications are not supported", None),
            PushDenied => (
                -32602,
                "push destination was denied",
                Some("push-url-denied"),
            ),
            InvalidAgentResponse => (-32006, "invalid agent response", None),
            Internal => (-32603, "internal error", None),
        };
        rpc_error(id, code, msg, reason)
    }
}

fn headers(content_type: &'static str) -> BTreeMap<&'static str, String> {
    BTreeMap::from([
        ("content-type", content_type.into()),
        ("cache-control", "no-store".into()),
        ("x-content-type-options", "nosniff".into()),
    ])
}

fn json_response(status: u16, json: &Json) -> Response {
    Response {
        status,
        headers: headers("application/json; charset=utf-8"),
        body: Body::Text(json.encode()),
    }
}

fn http_error(status: u16, reason: &'static str) -> Response {
    json_response(status, &object([("error", reason.into())]))
}

fn extra(mut response: Response, name: &'static str, value: impl Into<String>) -> Response {
    response.headers.insert(name, value.into());
    response
}

fn too_large(host: &dyn Host) -> Response {
    host.audit(Audit::BodyTooLarge);
    extra(http_error(413, "body-too-large"), "connection", "close")
}

fn valid_agent(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !matches!(id, "." | "..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn route<'a>(path: &'a str, default: Option<&'a str>) -> Option<(&'a str, bool)> {
    let path = path.split('?').next()?;
    if path == ROOT_CARD {
        return default.map(|id| (id, true));
    }
    let (agent, tail) = path.strip_prefix("/a2a/")?.split_once('/')?;
    if !valid_agent(agent) {
        return None;
    }
    match tail {
        "" => Some((agent, false)),
        ".well-known/agent-card.json" => Some((agent, true)),
        _ => None,
    }
}

fn bearer(header: Option<&String>) -> Option<&str> {
    let token = header?.strip_prefix("Bearer ")?;
    (!token.is_empty() && token.len() <= 512 && token.bytes().all(|b| b.is_ascii_graphic()))
        .then_some(token)
}

impl Endpoint {
    pub fn new(config: Config, peers: Vec<Peer>) -> Result<Self, ConfigError> {
        if config.address_per_minute == 0
            || config.peer_per_minute == 0
            || config.failed_auth_per_minute == 0
            || config.max_body_bytes == 0
            || config.max_body_bytes > MAX_STRUCTURED
        {
            return Err(ConfigError::InvalidLimits);
        }
        if config
            .default_agent
            .as_deref()
            .is_some_and(|name| !valid_agent(name))
            || crate::peer_card::peer_url(&config.base_url).is_none()
            || config.version.is_empty()
        {
            return Err(ConfigError::InvalidAdvertisement);
        }
        if peers.len() > 1024 {
            return Err(ConfigError::InvalidPeer);
        }
        let mut ids = BTreeSet::new();
        let mut keys = BTreeSet::new();
        for peer in &peers {
            if !valid_agent(&peer.id)
                || !ids.insert(&peer.id)
                || !keys.insert(peer.sha256)
                || peer.grants.keys().any(|agent| !valid_agent(agent))
            {
                return Err(ConfigError::InvalidPeer);
            }
        }
        let rates = Rates {
            address: Buckets::new(config.address_per_minute),
            peer: Buckets::new(config.peer_per_minute),
            failed_auth: Buckets::new(config.failed_auth_per_minute),
        };
        Ok(Self {
            config,
            peers,
            rates: Mutex::new(rates),
        })
    }

    fn authenticate(&self, host: &dyn Host, request: &Request<'_>) -> Result<&Peer, Response> {
        let now = host.now_ms();
        let Ok(mut rates) = self.rates.lock() else {
            return Err(http_error(500, "internal"));
        };
        let limited = |event, wait: u32| {
            host.audit(event);
            extra(
                http_error(429, "rate-limited"),
                "retry-after",
                wait.to_string(),
            )
        };
        if let Err(wait) = rates.address.take(request.remote, now) {
            drop(rates);
            return Err(limited(Audit::RateAddress, wait));
        }
        if !rates.failed_auth.has(request.remote, now) {
            drop(rates);
            return Err(limited(Audit::RateAuth, 60));
        }
        let provided = bearer(request.headers.get("authorization"));
        let mut found = None;
        if let Some(token) = provided {
            let hash: [u8; 32] = Sha256::digest(token).into();
            let mut seen = Choice::from(0);
            for peer in &self.peers {
                let matched = hash.ct_eq(&peer.sha256);
                if bool::from(matched & !seen) {
                    found = Some(peer);
                }
                seen |= matched;
            }
        }
        let Some(peer) = found else {
            let _ = rates.failed_auth.take(request.remote, now);
            drop(rates);
            host.audit(if provided.is_some() {
                Audit::BadCredential
            } else {
                Audit::NoCredential
            });
            return Err(extra(
                http_error(401, "unauthenticated"),
                "www-authenticate",
                "Bearer",
            ));
        };
        if let Err(wait) = rates.peer.take(&peer.id, now) {
            drop(rates);
            return Err(limited(Audit::RatePeer, wait));
        }
        Ok(peer)
    }

    /// Adapter entry point for the HTTP host. Supply the socket's actual local address.
    pub fn handle_http(
        &self,
        bound: SocketAddr,
        host: &dyn Host,
        request: Request<'_>,
        read_body: impl FnOnce(usize, Window<'_>) -> Result<Vec<u8>, BodyError>,
    ) -> Response {
        let authority = request.headers.get("host").map_or("", String::as_str);
        if !listener_accepts(bound.ip(), bound.port(), authority, request.path) {
            return Response {
                status: 421,
                headers: BTreeMap::from([("content-type", "application/json".into())]),
                body: Body::Text("{\"error\":\"misdirected\"}".into()),
            };
        }
        self.handle(host, request, read_body)
    }

    /// Handle an already-admitted in-process request.
    pub fn handle(
        &self,
        host: &dyn Host,
        request: Request<'_>,
        read_body: impl FnOnce(usize, Window<'_>) -> Result<Vec<u8>, BodyError>,
    ) -> Response {
        let Some((agent, is_card)) = route(request.path, self.config.default_agent.as_deref())
        else {
            return http_error(404, "not-found");
        };
        let expected = if is_card { "GET" } else { "POST" };
        if request.method != expected {
            return extra(http_error(405, "method-not-allowed"), "allow", expected);
        }
        let header_bytes = request.headers.iter().try_fold(
            request.path.len().saturating_add(request.method.len()),
            |size, (key, value)| {
                size.checked_add(key.len())?
                    .checked_add(value.len())?
                    .checked_add(4)
            },
        );
        if header_bytes.is_none_or(|size| size > MAX_HEADERS) {
            return http_error(431, "headers-too-large");
        }
        if !request.window.active() {
            return http_error(408, "unreadable-body");
        }
        let peer = match self.authenticate(host, &request) {
            Ok(peer) => peer,
            Err(response) => return response,
        };
        let info = match host.agent(agent) {
            Some(info) if info.opt_in => info,
            other => {
                host.audit(if other.is_some() {
                    Audit::HiddenAgent
                } else {
                    Audit::UnknownAgent
                });
                return http_error(404, "not-found");
            }
        };
        let Some(actions) = peer.grants.get(agent) else {
            host.audit(Audit::AgentNotGranted);
            return http_error(404, "not-found");
        };
        if is_card {
            if !actions.contains(&Action::Card) {
                host.audit(Audit::ActionNotGranted);
                return http_error(403, "forbidden");
            }
            return match card::wire_card(
                agent,
                &info,
                &self.config.base_url,
                &self.config.version,
                self.config.features,
            ) {
                Ok(card) => json_response(200, &card),
                Err(_) => http_error(500, "internal"),
            };
        }
        let media = request
            .headers
            .get("content-type")
            .and_then(|s| s.split(';').next())
            .map(str::trim);
        if !media.is_some_and(|s| s.eq_ignore_ascii_case("application/json")) {
            return http_error(415, "unsupported-media-type");
        }
        let limit = self.config.max_body_bytes;
        if request.headers.get("content-length").is_some_and(|v| {
            !v.bytes().all(|b| b.is_ascii_digit()) || v.parse::<usize>().map_or(true, |n| n > limit)
        }) {
            return too_large(host);
        }
        let body = match read_body(limit, request.window) {
            Ok(body) if body.len() <= limit => body,
            Ok(_) | Err(BodyError::TooLarge) => return too_large(host),
            Err(BodyError::Unreadable) => return http_error(400, "unreadable-body"),
        };
        if !request.window.active() {
            return http_error(408, "unreadable-body");
        }
        self.rpc(
            host,
            TaskScope {
                peer: &peer.id,
                provenance: crate::peer_provenance(&peer.id, false),
                agent,
            },
            actions,
            &body,
            request.window,
        )
    }

    fn rpc(
        &self,
        host: &dyn Host,
        scope: TaskScope<'_>,
        actions: &[Action],
        body: &[u8],
        window: Window<'_>,
    ) -> Response {
        let Ok(input) = serde_json::from_slice::<Json>(body) else {
            return rpc_error(&Json::Null, -32700, "parse error", None);
        };
        if input.array().is_some() {
            return rpc_error(
                &Json::Null,
                -32600,
                "batch requests are not supported",
                Some("batch"),
            );
        }
        let id = &input["id"];
        if input["jsonrpc"].string() != Some("2.0")
            || input["method"].string().is_none()
            || (id.string().is_none() && id.number().is_none())
            || id
                .string()
                .is_some_and(|id| id.encode_utf16().count() > 128)
        {
            return rpc_error(&Json::Null, -32600, "invalid request", None);
        }
        let Some(method) = commands::Method::parse(input["method"].text()) else {
            return rpc_error(id, -32601, "method not found", None);
        };
        if method.streams() && !self.config.features.streaming {
            return RpcError::StreamingDisabled.response(id);
        }
        if method.action() == Action::Push && !self.config.features.push_notifications {
            return RpcError::PushNotSupported.response(id);
        }
        if !actions.contains(&method.action()) {
            host.audit(Audit::ActionNotGranted);
            return rpc_error(id, -32600, "not permitted", Some("forbidden"));
        }
        let output = commands::command(
            method,
            &input["params"],
            self.config.parts,
            self.config.features,
        )
        .and_then(|command| host.task(scope, command, window));
        match output {
            Ok(Output::Json(result)) if !method.streams() => {
                json_response(200, &envelope(id, "result", result))
            }
            Ok(Output::Stream {
                task_id,
                context_id,
                source,
            }) if method.streams() && !task_id.is_empty() && !context_id.is_empty() => {
                let mut headers = headers("text/event-stream; charset=utf-8");
                headers.insert("connection", "keep-alive".into());
                Response {
                    status: 200,
                    headers,
                    body: Body::Stream(Box::new(Stream {
                        id: id.clone(),
                        task_id,
                        context_id,
                        source: Some(source),
                        deadline: window.deadline,
                    })),
                }
            }
            Ok(_) => RpcError::InvalidAgentResponse.response(id),
            Err(error) => error.response(id),
        }
    }
}
