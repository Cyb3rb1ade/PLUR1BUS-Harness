//! The generic rmcp HTTP backend on the Harness's pinned blocking connector.
use std::{
    collections::HashMap,
    fmt,
    io::{self, Read},
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

use futures::stream::BoxStream;
use plur1bus_providers::pinned_http_agent;
use rmcp::{
    model::{
        ClientJsonRpcMessage, ClientRequest, ErrorCode, ErrorData, ProtocolVersion,
        ServerJsonRpcMessage,
    },
    transport::streamable_http_client::{
        AuthRequiredError, HttpStatusError, InsufficientScopeError, SseError, StreamableHttpClient,
        StreamableHttpError, StreamableHttpPostResponse,
    },
};
use sse_stream::Sse;
use tokio::task::spawn_blocking;
use ureq::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response};
use url::{Host, Url};

use crate::auth::challenge::{Challenge, Observer};

pub(crate) mod encode;
mod sse;

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;

type SdkError = StreamableHttpError<Error>;
type SdkResult<T> = Result<T, SdkError>;
type SseStream = BoxStream<'static, Result<Sse, SseError>>;
type Headers = HashMap<HeaderName, HeaderValue>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidEndpoint,
    InvalidHeader,
    InvalidBody,
    Denied,
    Network,
    Timeout,
    BodyCoding,
    FrameLimit,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidEndpoint => "invalid MCP endpoint",
            Self::InvalidHeader => "invalid MCP header",
            Self::InvalidBody => "invalid MCP body",
            Self::Denied => "MCP egress denied",
            Self::Network => "MCP connection failed",
            Self::Timeout => "MCP request deadline reached",
            Self::BodyCoding => "unsupported MCP body coding",
            Self::FrameLimit => "MCP frame exceeds byte limit",
        })
    }
}

impl std::error::Error for Error {}

/// The host admits the URL and resolves it once for this connection.
pub trait Admission: Send + Sync {
    fn pin(&self, target: &Url, deadline: Instant) -> Result<SocketAddr, Error>;
}

#[derive(Clone)]
pub struct HttpClient {
    endpoint: Url,
    admission: Arc<dyn Admission>,
    timeout: Duration,
    frame_limit: usize,
    include_progress: bool,
    challenges: Option<Arc<dyn Observer>>,
    allow_legacy_probe: bool,
}

impl fmt::Debug for HttpClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpClient").finish_non_exhaustive()
    }
}

struct Outbound {
    method: Method,
    uri: Arc<str>,
    session_id: Option<Arc<str>>,
    last_event_id: Option<String>,
    bearer: Option<String>,
    headers: Headers,
    body: Option<Vec<u8>>,
}

impl HttpClient {
    pub fn new(
        endpoint: &str,
        admission: Arc<dyn Admission>,
        timeout: Duration,
    ) -> Result<Self, Error> {
        if timeout.is_zero() || Instant::now().checked_add(timeout).is_none() {
            return Err(Error::Timeout);
        }
        Ok(Self {
            endpoint: checked_url(endpoint)?,
            admission,
            timeout,
            frame_limit: MAX_FRAME_BYTES,
            include_progress: true,
            challenges: None,
            allow_legacy_probe: false,
        })
    }

    /// A caller may apply a smaller frame limit, such as the legacy Core's 1 MiB.
    pub fn with_frame_limit(mut self, limit: usize) -> Self {
        self.frame_limit = limit.min(MAX_FRAME_BYTES);
        self
    }

    pub fn with_challenges(mut self, observer: Arc<dyn Observer>) -> Self {
        self.challenges = Some(observer);
        self
    }

    fn challenge(&self, response: &Response<ureq::Body>) -> Option<SdkError> {
        let status = response.status().as_u16();
        if !matches!(status, 401 | 403) {
            return None;
        }
        let challenge = response
            .headers()
            .get_all(header::WWW_AUTHENTICATE)
            .iter()
            .filter_map(|header| header.to_str().ok())
            .find_map(Challenge::parse)
            .unwrap_or_default();
        if status == 403 && !challenge.insufficient_scope() {
            return None;
        }
        if let Some(observer) = &self.challenges {
            observer.required(&self.endpoint, challenge);
        }
        Some(if status == 401 {
            SdkError::AuthRequired(AuthRequiredError::new(String::new()))
        } else {
            SdkError::InsufficientScope(InsufficientScopeError::new(String::new(), None))
        })
    }

    pub(crate) fn allow_legacy_probe(mut self, allow: bool) -> Self {
        self.allow_legacy_probe = allow;
        self
    }

    fn legacy_probe(&self, message: &ClientJsonRpcMessage, reply: &mut ServerJsonRpcMessage) {
        if !self.allow_legacy_probe {
            return;
        }
        let ClientJsonRpcMessage::Request(request) = message else {
            return;
        };
        if !matches!(request.request, ClientRequest::DiscoverRequest(_)) {
            return;
        }
        let ServerJsonRpcMessage::Error(reply) = reply else {
            return;
        };
        if reply.error.code != ErrorCode::UNSUPPORTED_PROTOCOL_VERSION {
            return;
        }
        if reply
            .error
            .data
            .as_ref()
            .and_then(|data| data["supported"].as_array())
            .is_some_and(|supported| {
                !supported
                    .iter()
                    .any(|version| version == ProtocolVersion::V_2026_07_28.as_str())
                    && supported.iter().any(|version| {
                        matches!(
                            version.as_str(),
                            Some("2025-11-25" | "2025-06-18" | "2025-03-26")
                        )
                    })
            })
        {
            reply.error = ErrorData::invalid_request("MCP peer advertises a legacy version", None);
        }
    }

    pub(crate) fn passive(mut self) -> Self {
        self.include_progress = false;
        self
    }

    fn open(&self, request: Outbound) -> Result<(Response<ureq::Body>, Instant), Error> {
        let target = checked_url(&request.uri)?;
        if target != self.endpoint {
            return Err(Error::Denied);
        }
        let deadline = Instant::now()
            .checked_add(self.timeout)
            .ok_or(Error::Timeout)?;
        let headers = self.headers(&request)?;
        let mut builder = Request::builder()
            .method(request.method)
            .uri(target.as_str());
        *builder.headers_mut().ok_or(Error::InvalidEndpoint)? = headers;
        let response = if let Some(body) = request.body {
            if body.len() > self.frame_limit {
                return Err(Error::FrameLimit);
            }
            pinned_run(
                &target,
                self.admission.as_ref(),
                deadline,
                builder.body(body).map_err(|_| Error::InvalidBody)?,
            )?
        } else {
            pinned_run(
                &target,
                self.admission.as_ref(),
                deadline,
                builder.body(()).map_err(|_| Error::InvalidBody)?,
            )?
        };
        Ok((response, deadline))
    }

    fn headers(&self, request: &Outbound) -> Result<HeaderMap, Error> {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
        if request.method == Method::POST {
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
        }
        insert_header(
            &mut headers,
            "mcp-session-id",
            request.session_id.as_deref(),
            true,
        )?;
        insert_header(
            &mut headers,
            "last-event-id",
            request.last_event_id.as_deref(),
            true,
        )?;
        if let Some(bearer) = &request.bearer {
            if bearer.is_empty() || bearer.bytes().any(|byte| byte.is_ascii_whitespace()) {
                return Err(Error::InvalidHeader);
            }
            let mut value = HeaderValue::from_str(&format!("Bearer {bearer}"))
                .map_err(|_| Error::InvalidHeader)?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        for (name, value) in &request.headers {
            if reserved(name) {
                return Err(Error::InvalidHeader);
            }
            let mut value = value.clone();
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        Ok(headers)
    }

    fn post(
        &self,
        request: Outbound,
        message: &ClientJsonRpcMessage,
        sse_limit: usize,
    ) -> SdkResult<StreamableHttpPostResponse> {
        let session_attached = request.session_id.is_some();
        let (mut response, deadline) = self.open(request).map_err(SdkError::Client)?;
        let status = response.status().as_u16();
        if let Some(error) = self.challenge(&response) {
            return Err(error);
        }
        if status == 404 && session_attached {
            return Err(SdkError::SessionExpired);
        }
        if matches!(status, 202 | 204 | 205) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let mime = media_type(response.headers());
        if (200..300).contains(&status) {
            let session = response
                .headers()
                .get("mcp-session-id")
                .map(HeaderValue::to_str)
                .transpose()
                .map_err(|_| SdkError::Client(Error::InvalidHeader))?
                .map(ToOwned::to_owned);
            return match mime {
                Mime::Json => {
                    let body = read_bounded(&mut response, deadline, self.frame_limit)?;
                    let mut reply = decode(&body)?;
                    self.legacy_probe(message, &mut reply);
                    Ok(StreamableHttpPostResponse::Json(reply, session))
                }
                Mime::Sse => Ok(StreamableHttpPostResponse::Sse(
                    sse::stream(response.into_body(), deadline, sse_limit),
                    session,
                )),
                _ => Err(SdkError::UnexpectedContentType(None)),
            };
        }
        let body = read_bounded(&mut response, deadline, MAX_DIAGNOSTIC_BYTES)?;
        if !session_attached && (400..500).contains(&status) && status != 403 {
            if let ClientJsonRpcMessage::Request(request) = message {
                if matches!(request.request, ClientRequest::DiscoverRequest(_)) {
                    let error = match decode(&body) {
                        Ok(mut parsed @ ServerJsonRpcMessage::Error(_)) => {
                            self.legacy_probe(message, &mut parsed);
                            match parsed {
                                ServerJsonRpcMessage::Error(reply) => reply.error,
                                _ => ErrorData::invalid_request("MCP discovery rejected", None),
                            }
                        }
                        _ => ErrorData::invalid_request("MCP discovery rejected", None),
                    };
                    return Ok(StreamableHttpPostResponse::Json(
                        ServerJsonRpcMessage::error(error, Some(request.id.clone())),
                        None,
                    ));
                }
            }
        }
        if mime == Mime::Json {
            if let Ok(reply @ ServerJsonRpcMessage::Error(_)) = decode(&body) {
                return Ok(StreamableHttpPostResponse::Json(reply, None));
            }
        }
        Err(status_error(response.headers(), status))
    }

    fn get(&self, request: Outbound, sse_limit: usize) -> SdkResult<SseStream> {
        let (mut response, deadline) = self.open(request).map_err(SdkError::Client)?;
        if let Some(error) = self.challenge(&response) {
            return Err(error);
        }
        match response.status().as_u16() {
            405 => Err(SdkError::ServerDoesNotSupportSse),
            404 => Err(SdkError::SessionExpired),
            200 if media_type(response.headers()) == Mime::Sse => {
                Ok(sse::stream(response.into_body(), deadline, sse_limit))
            }
            200..=299 => Err(SdkError::UnexpectedContentType(None)),
            status => {
                read_bounded(&mut response, deadline, MAX_DIAGNOSTIC_BYTES)?;
                Err(status_error(response.headers(), status))
            }
        }
    }
}

impl StreamableHttpClient for HttpClient {
    type Error = Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> SdkResult<StreamableHttpPostResponse> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            MAX_FRAME_BYTES,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: Headers,
        max_sse_event_size: usize,
    ) -> SdkResult<StreamableHttpPostResponse> {
        let client = self.clone();
        spawn_blocking(move || {
            let body = encode::message(&message, client.include_progress, false)
                .map_err(|_| SdkError::Client(Error::InvalidBody))?;
            client.post(
                Outbound {
                    method: Method::POST,
                    uri,
                    session_id,
                    last_event_id: None,
                    bearer: auth_header,
                    headers: custom_headers,
                    body: Some(body),
                },
                &message,
                max_sse_event_size.min(client.frame_limit),
            )
        })
        .await
        .map_err(|_| SdkError::Client(Error::Network))?
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> SdkResult<SseStream> {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            MAX_FRAME_BYTES,
        )
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: Headers,
        max_sse_event_size: usize,
    ) -> SdkResult<SseStream> {
        let client = self.clone();
        spawn_blocking(move || {
            client.get(
                Outbound {
                    method: Method::GET,
                    uri,
                    session_id,
                    last_event_id,
                    bearer: auth_header,
                    headers: custom_headers,
                    body: None,
                },
                max_sse_event_size.min(client.frame_limit),
            )
        })
        .await
        .map_err(|_| SdkError::Client(Error::Network))?
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> SdkResult<()> {
        let client = self.clone();
        spawn_blocking(move || {
            let (mut response, deadline) = client
                .open(Outbound {
                    method: Method::DELETE,
                    uri,
                    session_id: Some(session_id),
                    last_event_id: None,
                    bearer: auth_header,
                    headers: custom_headers,
                    body: None,
                })
                .map_err(SdkError::Client)?;
            match response.status().as_u16() {
                200..=299 | 404 | 405 => Ok(()),
                status => {
                    read_bounded(&mut response, deadline, MAX_DIAGNOSTIC_BYTES)?;
                    Err(status_error(response.headers(), status))
                }
            }
        })
        .await
        .map_err(|_| SdkError::Client(Error::Network))?
    }
}

pub(crate) fn pinned_run(
    target: &Url,
    admission: &dyn Admission,
    deadline: Instant,
    request: Request<impl ureq::AsSendBody>,
) -> Result<Response<ureq::Body>, Error> {
    let pin = admission.pin(target, deadline)?;
    if !pin_matches(target, pin) {
        return Err(Error::Denied);
    }
    let config = ureq::config::Config::builder()
        .proxy(None)
        .max_redirects(0)
        .max_idle_connections(0)
        .max_response_header_size(MAX_DIAGNOSTIC_BYTES)
        .http_status_as_error(false)
        .timeout_global(Some(remaining(deadline)?))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .build();
    let result = pinned_http_agent(config, pin, deadline).run(request);
    remaining(deadline)?;
    let response = result.map_err(wire_error)?;
    if response
        .headers()
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .any(|coding| !coding.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(Error::BodyCoding);
    }
    Ok(response)
}

fn reserved(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "upgrade"
            | "te"
            | "trailer"
            | "keep-alive"
            | "proxy-authorization"
            | "proxy-connection"
            | "authorization"
            | "content-type"
            | "accept"
            | "accept-encoding"
            | "mcp-session-id"
            | "last-event-id"
    )
}

fn insert_header(
    headers: &mut HeaderMap,
    name: &'static str,
    value: Option<&str>,
    sensitive: bool,
) -> Result<(), Error> {
    if let Some(value) = value {
        let mut value = HeaderValue::from_str(value).map_err(|_| Error::InvalidHeader)?;
        value.set_sensitive(sensitive);
        headers.insert(name, value);
    }
    Ok(())
}

pub(crate) fn checked_url(raw: &str) -> Result<Url, Error> {
    let url = Url::parse(raw).map_err(|_| Error::InvalidEndpoint)?;
    if matches!(url.scheme(), "https" | "http")
        && url.host().is_some()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
    {
        Ok(url)
    } else {
        Err(Error::InvalidEndpoint)
    }
}

fn pin_matches(url: &Url, pin: SocketAddr) -> bool {
    let address = match url.host() {
        Some(Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    url.port_or_known_default() == Some(pin.port()) && address.is_none_or(|ip| ip == pin.ip())
}

#[derive(PartialEq, Eq)]
enum Mime {
    Json,
    Sse,
    Other,
}

fn media_type(headers: &HeaderMap) -> Mime {
    let value = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    match value {
        Some(value) if value.eq_ignore_ascii_case("application/json") => Mime::Json,
        Some(value) if value.eq_ignore_ascii_case("text/event-stream") => Mime::Sse,
        _ => Mime::Other,
    }
}

fn remaining(deadline: Instant) -> Result<Duration, Error> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(Error::Timeout)
}

fn wire_error(error: ureq::Error) -> Error {
    match error {
        ureq::Error::Timeout(_) => Error::Timeout,
        ureq::Error::Io(error) => io_error(&error),
        _ => Error::Network,
    }
}

fn io_error(error: &io::Error) -> Error {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) || error.get_ref().is_some_and(|cause| {
        matches!(
            cause.downcast_ref::<ureq::Error>(),
            Some(ureq::Error::Timeout(_))
        )
    }) {
        Error::Timeout
    } else {
        Error::Network
    }
}

pub(crate) fn read_bounded(
    response: &mut Response<ureq::Body>,
    deadline: Instant,
    limit: usize,
) -> SdkResult<Vec<u8>> {
    let limit_error = || SdkError::ResponseBodyTooLarge { max_size: limit };
    if response
        .body()
        .content_length()
        .is_some_and(|bytes| bytes > limit as u64)
    {
        return Err(limit_error());
    }
    let mut body = Vec::new();
    let mut buf = [0; 8192];
    let mut reader = response.body_mut().as_reader();
    loop {
        remaining(deadline).map_err(SdkError::Client)?;
        let available = limit - body.len();
        let window = buf.len().min(available + 1);
        let received = reader.read(&mut buf[..window]);
        remaining(deadline).map_err(SdkError::Client)?;
        let received = received.map_err(|error| SdkError::Client(io_error(&error)))?;
        if received == 0 {
            return Ok(body);
        }
        if received > available {
            return Err(limit_error());
        }
        body.extend_from_slice(&buf[..received]);
    }
}

fn decode(body: &[u8]) -> SdkResult<ServerJsonRpcMessage> {
    let mut message: ServerJsonRpcMessage =
        serde_json::from_slice(body).map_err(|_| SdkError::Client(Error::InvalidBody))?;
    if let ServerJsonRpcMessage::Error(reply) = &mut message {
        reply.error.message = "MCP peer rejected request".into();
        reply.error.data = if reply.error.code == ErrorCode::UNSUPPORTED_PROTOCOL_VERSION {
            let versions = reply
                .error
                .data
                .as_ref()
                .and_then(|data| data.get("supported"))
                .and_then(serde_json::Value::as_array);
            versions.map(|versions| {
                let supported = ProtocolVersion::KNOWN_VERSIONS
                    .iter()
                    .filter(|known| {
                        versions
                            .iter()
                            .any(|raw| raw.as_str() == Some(known.as_str()))
                    })
                    .map(ProtocolVersion::as_str)
                    .collect::<Vec<_>>();
                serde_json::json!({"supported":supported})
            })
        } else {
            None
        };
    }
    Ok(message)
}

fn status_error(headers: &HeaderMap, status: u16) -> SdkError {
    let retry_after = headers
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .map(ToOwned::to_owned);
    HttpStatusError::new(status, retry_after).into()
}
