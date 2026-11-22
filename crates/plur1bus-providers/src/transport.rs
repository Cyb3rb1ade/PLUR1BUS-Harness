use crate::cache::{self, CacheInput};
use crate::local::{self, ManagedSocket};
use crate::request::gemini_model;
use crate::response::{self, Delivery, Redactor, ToolRepair, ToolRepairInput};
use crate::{ErrorKind, Json, ProviderError, RequestOptions, TimeoutPhase, Wire};
use serde_json::Value;
use socket2::Socket;
use std::fmt;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime};
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, RustlsConnector, Transport,
};
use url::Url;

type Result<T> = std::result::Result<T, ProviderError>;

const MAX_SOCKET_TIMEOUT: Duration = Duration::from_secs(600);

/// Call ports supplied by the owner of the connection policy and the credential lease.
pub trait Ports {
    /// Permit this destination and give the one address that may be dialled, including its port.
    fn pin(&self, uri: &Url) -> Result<SocketAddr>;

    /// The prepared Authorization value for OpenAI wires, or the API key for Anthropic and Gemini.
    fn credential(&self, wire: Wire) -> Result<Option<String>>;

    /// Positive wall-clock budget for a wire call, capped at 600 seconds. It still applies
    /// when a provider's phase timeouts are disabled.
    fn socket_timeout(&self) -> Duration;

    fn cancelled(&self) -> bool {
        false
    }

    fn cache_input(&self) -> Option<CacheInput<'_>> {
        None
    }

    fn managed_uid(&self) -> Option<u32> {
        None
    }

    fn managed_available(&self) -> bool {
        false
    }

    fn retain_anthropic_thinking(&self, _model: &str, _blocks: Vec<Json>) {}

    /// Return a corrected object or its wire text when the model's arguments cannot be parsed.
    fn repair_tool_arguments(&self, _input: ToolRepairInput<'_>) -> Option<ToolRepair> {
        None
    }

    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub headers: Option<Duration>,
    pub idle: Option<Duration>,
    pub total: Option<Duration>,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            headers: Some(Duration::from_secs(60)),
            idle: Some(Duration::from_secs(60)),
            total: Some(Duration::from_secs(600)),
        }
    }
}

#[derive(Clone)]
pub struct Config {
    pub request: RequestOptions,
    pub extra_headers: Vec<(String, String)>,
    pub allow_insecure_http: bool,
    pub allow_missing_done: bool,
    pub anthropic_version: String,
    pub timeouts: Option<Timeouts>,
    pub max_body_bytes: usize,
    pub max_event_bytes: usize,
    pub max_tool_argument_bytes: usize,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let header_names: Vec<_> = self.extra_headers.iter().map(|(name, _)| name).collect();
        f.debug_struct("Config")
            .field("request", &self.request)
            .field("extra_header_names", &header_names)
            .field("allow_insecure_http", &self.allow_insecure_http)
            .field("allow_missing_done", &self.allow_missing_done)
            .field("anthropic_version", &self.anthropic_version)
            .field("timeouts", &self.timeouts)
            .field("max_body_bytes", &self.max_body_bytes)
            .field("max_event_bytes", &self.max_event_bytes)
            .field("max_tool_argument_bytes", &self.max_tool_argument_bytes)
            .finish()
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            request: RequestOptions::default(),
            extra_headers: Vec::new(),
            allow_insecure_http: false,
            allow_missing_done: false,
            anthropic_version: "2023-06-01".into(),
            timeouts: None,
            max_body_bytes: 16 * 1024 * 1024,
            max_event_bytes: 4 * 1024 * 1024,
            max_tool_argument_bytes: 1024 * 1024,
        }
    }
}

pub struct Adapter {
    wire: Wire,
    base: Url,
    config: Config,
    managed: Option<ManagedSocket>,
    keyless_loopback: bool,
}

#[derive(Debug)]
struct Pin(SocketAddr);

impl Resolver for Pin {
    fn resolve(
        &self,
        _: &ureq::http::Uri,
        _: &ureq::config::Config,
        _: NextTimeout,
    ) -> std::result::Result<ResolvedSocketAddrs, ureq::Error> {
        let mut addresses = self.empty();
        addresses.push(self.0);
        Ok(addresses)
    }
}

#[derive(Debug)]
struct PinnedTcp {
    address: SocketAddr,
    deadline: SocketDeadline,
}

impl Connector for PinnedTcp {
    type Out = SocketTransport;

    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        _: Option<()>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        let timeout = self.deadline.bound(details.timeout)?;
        let stream = TcpStream::connect_timeout(&self.address, *timeout.after)
            .map_err(|error| socket_error(error, timeout))?;
        stream.set_nodelay(details.config.no_delay())?;
        Ok(Some(SocketTransport::new(
            stream.into(),
            details,
            self.deadline,
        )))
    }
}

// TLS can perform several raw reads or writes with the same relative timeout.
// Recheck the absolute deadline underneath TLS before every raw socket operation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SocketDeadline(Instant);

impl SocketDeadline {
    pub(crate) fn bound(self, next: NextTimeout) -> std::result::Result<NextTimeout, ureq::Error> {
        let remaining = self.0.saturating_duration_since(Instant::now()).into();
        let next = if remaining < next.after {
            NextTimeout {
                after: remaining,
                reason: ureq::Timeout::Global,
            }
        } else {
            next
        };
        // A sub-millisecond socket timeout rounds down to zero (unbounded) on Windows.
        if next.after.as_millis() == 0 {
            return Err(ureq::Error::Timeout(next.reason));
        }
        Ok(next)
    }
}

#[derive(Debug)]
pub(crate) struct SocketTransport {
    socket: Socket,
    buffers: LazyBuffers,
    deadline: SocketDeadline,
}

impl SocketTransport {
    pub(crate) fn new(
        socket: Socket,
        details: &ConnectionDetails<'_>,
        deadline: SocketDeadline,
    ) -> Self {
        Self {
            socket,
            buffers: LazyBuffers::new(
                details.config.input_buffer_size(),
                details.config.output_buffer_size(),
            ),
            deadline,
        }
    }
}

impl Transport for SocketTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(
        &mut self,
        amount: usize,
        timeout: NextTimeout,
    ) -> std::result::Result<(), ureq::Error> {
        let timeout = self.deadline.bound(timeout)?;
        let deadline = (Instant::now() + *timeout.after).min(self.deadline.0);
        let mut pending = &self.buffers.output()[..amount];
        while !pending.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.as_millis() == 0 {
                return Err(ureq::Error::Timeout(timeout.reason));
            }
            self.socket.set_write_timeout(Some(remaining))?;
            match self.socket.write(pending) {
                Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero).into()),
                Ok(written) => pending = &pending[written..],
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(socket_error(error, timeout)),
            }
        }
        Ok(())
    }

    fn await_input(&mut self, timeout: NextTimeout) -> std::result::Result<bool, ureq::Error> {
        let timeout = self.deadline.bound(timeout)?;
        self.socket.set_read_timeout(Some(*timeout.after))?;
        let amount = self
            .socket
            .read(self.buffers.input_append_buf())
            .map_err(|error| socket_error(error, timeout))?;
        self.buffers.input_appended(amount);
        Ok(amount != 0)
    }

    fn is_open(&mut self) -> bool {
        // A pinned provider connection belongs to one call and cannot enter the pool.
        false
    }
}

pub(crate) fn socket_error(error: io::Error, timeout: NextTimeout) -> ureq::Error {
    if matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    ) {
        ureq::Error::Timeout(timeout.reason)
    } else {
        ureq::Error::Io(error)
    }
}

// ureq's receive-body timeout covers the whole body. Bound each read instead,
// while still honoring ureq's earlier total deadline.
#[derive(Debug)]
struct IdleRead {
    headers_received: Arc<AtomicBool>,
    idle: Option<Duration>,
}

impl<T: Transport> Connector<T> for IdleRead {
    type Out = IdleTransport<T>;

    fn connect(
        &self,
        _: &ConnectionDetails<'_>,
        chained: Option<T>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        Ok(chained.map(|inner| IdleTransport {
            inner,
            headers_received: self.headers_received.clone(),
            idle: self.idle,
        }))
    }
}

#[derive(Debug)]
struct IdleTransport<T> {
    inner: T,
    headers_received: Arc<AtomicBool>,
    idle: Option<Duration>,
}

impl<T: Transport> Transport for IdleTransport<T> {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }

    fn transmit_output(
        &mut self,
        amount: usize,
        timeout: NextTimeout,
    ) -> std::result::Result<(), ureq::Error> {
        self.inner.transmit_output(amount, timeout)
    }

    fn await_input(&mut self, mut timeout: NextTimeout) -> std::result::Result<bool, ureq::Error> {
        if let Some(idle) = self
            .idle
            .filter(|_| self.headers_received.load(Ordering::Relaxed))
        {
            let after = ureq::unversioned::transport::time::Duration::from(idle);
            if after < timeout.after {
                timeout = NextTimeout {
                    after,
                    reason: ureq::Timeout::RecvBody,
                };
            }
        }
        self.inner.await_input(timeout)
    }

    fn is_open(&mut self) -> bool {
        self.inner.is_open()
    }

    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}

fn abort(ports: &dyn Ports) -> Result<()> {
    if ports.cancelled() {
        return Err(ProviderError::new(
            ErrorKind::Aborted,
            "call aborted by the caller",
        ));
    }
    Ok(())
}

fn standard_header(name: &str) -> bool {
    [
        "authorization",
        "proxy-authorization",
        "cookie",
        "host",
        "content-length",
        "content-type",
        "accept",
        "transfer-encoding",
        "connection",
        "upgrade",
        "expect",
        "te",
        "trailer",
        "proxy-connection",
    ]
    .contains(&name)
}

impl Adapter {
    pub fn new(wire: Wire, base: &str, mut config: Config) -> Result<Self> {
        let base =
            Url::parse(base).map_err(|_| ProviderError::invalid("baseUrl is not a valid URL"))?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err(ProviderError::invalid("baseUrl must be http(s)"));
        }
        if !base.username().is_empty() || base.password().is_some() {
            return Err(ProviderError::invalid("baseUrl must not carry credentials"));
        }
        if base.query().is_some() || base.fragment().is_some() {
            return Err(ProviderError::invalid(
                "baseUrl must not carry a query or fragment",
            ));
        }
        if config.max_body_bytes == 0
            || config.max_event_bytes == 0
            || config.max_tool_argument_bytes == 0
        {
            return Err(ProviderError::invalid("provider limits must be positive"));
        }
        if let Some(timeouts) = config.timeouts {
            for (field, value) in [
                ("headersMs", timeouts.headers),
                ("idleMs", timeouts.idle),
                ("totalMs", timeouts.total),
            ] {
                if value.is_some_and(|duration| duration.is_zero()) {
                    return Err(ProviderError::new(ErrorKind::InvalidRequest, format!("invalid timeout: {field} must be a positive number of milliseconds, Infinity or null")));
                }
            }
        }
        for (name, value) in &mut config.extra_headers {
            if standard_header(&name.to_ascii_lowercase())
                || (wire == Wire::AnthropicMessages
                    && ["x-api-key", "anthropic-version"]
                        .iter()
                        .any(|n| name.eq_ignore_ascii_case(n)))
                || (wire == Wire::Gemini && name.eq_ignore_ascii_case("x-goog-api-key"))
            {
                return Err(ProviderError::invalid(format!(
                    "header \"{name}\" is managed by the adapter"
                )));
            }
            if ureq::http::HeaderName::from_bytes(name.as_bytes()).is_err()
                || ureq::http::HeaderValue::from_str(value).is_err()
            {
                return Err(ProviderError::invalid("provider header is invalid"));
            }
            name.make_ascii_lowercase();
        }
        Ok(Self {
            wire,
            base,
            config,
            managed: None,
            keyless_loopback: false,
        })
    }

    pub fn keyless_loopback(base: &str, config: Config) -> Result<Self> {
        let mut adapter = Self::new(Wire::ChatCompletions, base, config)?;
        if !local::is_loopback(&adapter.base) || !adapter.config.extra_headers.is_empty() {
            return Err(ProviderError::invalid(
                "keyless local model server requires a loopback endpoint without custom headers",
            ));
        }
        adapter.keyless_loopback = true;
        Ok(adapter)
    }

    pub fn managed_apple_fm(socket: ManagedSocket, mut config: Config) -> Result<Self> {
        if !config.extra_headers.is_empty() {
            return Err(ProviderError::invalid(
                "managed Unix requests only allow adapter-owned accept and content-type headers",
            ));
        }
        config.request.max_completion_tokens = true;
        config.max_body_bytes = config.max_body_bytes.min(16 * 1024 * 1024);
        config.timeouts.get_or_insert(Timeouts {
            headers: Some(Duration::from_secs(30)),
            idle: Some(Duration::from_secs(30)),
            total: Some(Duration::from_secs(120)),
        });
        let mut adapter = Self::new(Wire::ChatCompletions, local::APPLE_FM_BASE_URL, config)?;
        adapter.managed = Some(socket);
        Ok(adapter)
    }

    fn endpoint(&self, req: &Json, stream: bool) -> Result<Url> {
        let suffix = match self.wire {
            Wire::ChatCompletions => "chat/completions".into(),
            Wire::AnthropicMessages => "messages".into(),
            Wire::CodexResponses => "responses".into(),
            Wire::Gemini => format!(
                "models/{}:{}",
                gemini_model(req["model"].text())?,
                if stream {
                    "streamGenerateContent"
                } else {
                    "generateContent"
                }
            ),
        };
        let mut endpoint = self.base.clone();
        endpoint.set_path(&format!(
            "{}/{suffix}",
            self.base.path().trim_end_matches('/')
        ));
        if self.wire == Wire::Gemini && stream {
            endpoint.set_query(Some("alt=sse"));
        }
        Ok(endpoint)
    }

    pub fn complete(&self, request: &Json, ports: &dyn Ports) -> Result<Value> {
        self.call(request, ports, false, &mut |_| {})
    }

    pub fn stream(
        &self,
        request: &Json,
        ports: &dyn Ports,
        emit: &mut dyn FnMut(Value),
    ) -> Result<()> {
        self.call(request, ports, true, emit).map(|_| ())
    }

    fn call(
        &self,
        request: &Json,
        ports: &dyn Ports,
        stream: bool,
        emit: &mut dyn FnMut(Value),
    ) -> Result<Value> {
        let use_sse =
            stream || self.wire == Wire::CodexResponses && self.config.request.chatgpt_plan;
        let _lease = self
            .managed
            .as_ref()
            .map(|managed| managed.admit(request))
            .transpose()?;
        let mut body = self.wire.request(request, use_sse, &self.config.request)?;
        let uri = self.endpoint(request, use_sse)?;
        let start = Instant::now();
        let timeouts = self.config.timeouts.unwrap_or_else(|| {
            let mut timeouts = Timeouts::default();
            if !use_sse {
                timeouts.headers = timeouts.total;
            }
            timeouts
        });
        abort(ports)?;
        let credential = if self.managed.is_some() || self.keyless_loopback {
            None
        } else {
            ports
                .credential(self.wire)
                .map_err(|_| ProviderError::new(ErrorKind::Auth, "credentials provider failed"))?
        };
        abort(ports)?;
        let key_wire = matches!(self.wire, Wire::AnthropicMessages | Wire::Gemini);
        if key_wire && credential.is_none() {
            return Err(ProviderError::new(
                ErrorKind::Auth,
                "no API key is stored for this profile",
            ));
        }
        let mut headers = ureq::http::HeaderMap::new();
        for (name, value) in &self.config.extra_headers {
            let name = ureq::http::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| ProviderError::invalid("provider header is invalid"))?;
            let value = ureq::http::HeaderValue::from_str(value.trim_matches([' ', '\t']))
                .map_err(|_| ProviderError::invalid("provider header is invalid"))?;
            headers.insert(name, value);
        }
        headers.insert(
            "content-type",
            ureq::http::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            "accept",
            ureq::http::HeaderValue::from_static(if use_sse {
                "text/event-stream"
            } else {
                "application/json"
            }),
        );
        if self.wire == Wire::AnthropicMessages {
            let version = ureq::http::HeaderValue::from_str(&self.config.anthropic_version)
                .map_err(|_| ProviderError::invalid("anthropic-version header is invalid"))?;
            headers.insert("anthropic-version", version);
        }
        let mut sent_secret = None;
        if let Some(credential) = credential.as_deref() {
            if credential.is_empty()
                || credential
                    .bytes()
                    .any(|b| b <= if key_wire { 32 } else { 31 } || b == 127)
            {
                return Err(ProviderError::new(
                    ErrorKind::Auth,
                    if key_wire {
                        "the stored API key is unusable (empty, or contains whitespace or control characters)"
                    } else {
                        "credentials provider returned an unusable Authorization value"
                    },
                ));
            }
            let host = uri.host_str().unwrap_or_default();
            if uri.scheme() == "http"
                && !self.config.allow_insecure_http
                && !matches!(host, "localhost" | "127.0.0.1" | "[::1]")
            {
                return Err(ProviderError::new(
                    ErrorKind::InvalidRequest,
                    if key_wire {
                        "refusing to send the API key over plain http to a non-loopback host"
                    } else {
                        "refusing to send credentials over plain http to a non-loopback host"
                    },
                ));
            }
            let key = match self.wire {
                Wire::AnthropicMessages => "x-api-key",
                Wire::Gemini => "x-goog-api-key",
                _ => "authorization",
            };
            let sent = credential.trim_matches(' ');
            let value = ureq::http::HeaderValue::from_str(sent).map_err(|_| {
                ProviderError::new(
                    ErrorKind::Auth,
                    "credentials provider returned an unusable Authorization value",
                )
            })?;
            headers.insert(key, value);
            sent_secret = Some(if key_wire {
                sent
            } else {
                sent.rsplit(' ').next().unwrap_or(sent)
            });
        }
        let additional_header_secrets = self
            .config
            .extra_headers
            .iter()
            .flat_map(|(_, value)| [value.trim_matches([' ', '\t']), value.as_str()]);
        let redact = Redactor::new(
            sent_secret
                .into_iter()
                .chain(credential.as_deref())
                .chain(additional_header_secrets),
        );
        if let Some(context) = ports.cache_input().filter(|_| self.managed.is_none()) {
            cache::emit(self.wire, &mut body, &mut headers, context);
        }
        let body = body.encode();
        if self.managed.is_some() && body.len() > 1024 * 1024 {
            return Err(ProviderError::new(
                ErrorKind::InvalidRequest,
                "managed Unix request body exceeds one MiB",
            ));
        }
        let (agent, headers_received) = self.agent(&uri, ports, start, timeouts)?;
        let mut http_request = ureq::http::Request::post(uri.as_str());
        if let Some(target) = http_request.headers_mut() {
            *target = headers;
        }
        let http_request = http_request
            .body(body.as_bytes())
            .map_err(|_| ProviderError::invalid("provider HTTP request is invalid"))?;
        let reply = agent
            .run(http_request)
            .map_err(|err| io_failure(&err, ports, TimeoutPhase::Headers))?;
        headers_received.store(true, Ordering::Relaxed);
        abort(ports)?;
        let (parts, body) = reply.into_parts();
        let status = parts.status.as_u16();
        // R-W-10: the core bridge refuses redirects before considering the body.
        if parts.status.is_redirection() {
            return Err(ProviderError::new(
                ErrorKind::InvalidRequest,
                "provider redirects refused",
            ));
        }
        // P4D-40: keep a bodyless response distinct from an empty stream.
        let bodyless = matches!(status, 204 | 205) || parts.status.is_informational();
        let on_stream = use_sse;
        let media = parts
            .headers
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or_default();
        let mut reader = CallReader {
            input: body.into_reader(),
            ports,
        };
        if !bodyless && !parts.status.is_success() {
            let mut error_body = Vec::new();
            let limit = self.config.max_body_bytes.min(64 * 1024);
            if reader
                .by_ref()
                .take((limit as u64).saturating_add(1))
                .read_to_end(&mut error_body)
                .is_err()
                || error_body.len() > limit
            {
                error_body.clear();
            }
            abort(ports)?;
            let error = response::http_error(
                self.wire,
                status,
                &parts.headers,
                &error_body,
                &redact,
                ports.now(),
            );
            return Err(if self.managed.is_some() {
                local::managed_failure(error)
            } else {
                error
            });
        }
        let delivery = Delivery {
            wire: self.wire,
            stream: on_stream,
            media,
            redact: &redact,
            allow_missing_done: self.config.allow_missing_done,
            max_body: self.config.max_body_bytes,
            max_event: self.config.max_event_bytes,
            max_args: self.config.max_tool_argument_bytes,
            request,
            ports,
        };
        let input = (!bodyless).then_some(&mut reader as &mut dyn Read);
        let outcome = delivery.run(input, &mut |event| {
            if stream {
                emit(event);
            }
        });
        if self.managed.is_some() {
            outcome.map_err(local::managed_failure)
        } else {
            outcome
        }
    }
    fn agent(
        &self,
        uri: &Url,
        ports: &dyn Ports,
        start: Instant,
        timeouts: Timeouts,
    ) -> Result<(ureq::Agent, Arc<AtomicBool>)> {
        let socket_timeout = ports.socket_timeout().min(MAX_SOCKET_TIMEOUT);
        if socket_timeout.is_zero() {
            return Err(ProviderError::invalid(
                "provider socket timeout must be positive",
            ));
        }
        let total = timeouts.total.unwrap_or(socket_timeout).min(socket_timeout);
        let deadline = SocketDeadline(start + total);
        let pin = if let Some(socket) = &self.managed {
            socket.verify(ports.managed_uid())?;
            if !ports.managed_available() {
                return Err(local::unavailable("unavailable"));
            }
            SocketAddr::from(([127, 0, 0, 1], 80))
        } else {
            let pin = ports.pin(uri)?;
            if pin.port() != uri.port_or_known_default().unwrap_or_default()
                || (self.keyless_loopback && !pin.ip().is_loopback())
                || match uri.host() {
                    Some(url::Host::Ipv4(ip)) => pin.ip() != IpAddr::V4(ip),
                    Some(url::Host::Ipv6(ip)) => pin.ip() != IpAddr::V6(ip),
                    _ => false,
                }
            {
                return Err(ProviderError::invalid(
                    "egress returned a pin for a different endpoint",
                ));
            }
            pin
        };
        abort(ports)?;
        let elapsed = start.elapsed();
        let total = total.saturating_sub(elapsed);
        let headers = timeouts.headers.map(|d| d.saturating_sub(elapsed));
        if total.is_zero() {
            return Err(timeout(TimeoutPhase::Total));
        }
        if headers.is_some_and(|duration| duration.is_zero()) {
            return Err(timeout(TimeoutPhase::Headers));
        }
        // Connect and send are also within the time-to-headers budget.
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .max_idle_connections(0)
            .timeout_global(Some(total))
            .timeout_connect(headers)
            .timeout_send_request(headers)
            .timeout_send_body(headers)
            .timeout_recv_response(headers)
            .max_response_header_size(if self.managed.is_some() {
                16 * 1024
            } else {
                64 * 1024
            })
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        let headers_received = Arc::new(AtomicBool::new(false));
        let idle = IdleRead {
            headers_received: headers_received.clone(),
            idle: timeouts.idle,
        };
        #[cfg(unix)]
        if let Some(socket) = &self.managed {
            let connector = local::UnixConnector(socket.path().to_owned(), deadline).chain(idle);
            return Ok((
                ureq::Agent::with_parts(config, connector, Pin(pin)),
                headers_received,
            ));
        }
        let connector = PinnedTcp {
            address: pin,
            deadline,
        }
        .chain(RustlsConnector::default())
        .chain(idle);
        Ok((
            ureq::Agent::with_parts(config, connector, Pin(pin)),
            headers_received,
        ))
    }

    /// Probe the fixed AF1 endpoints over the same private socket.
    pub fn probe_managed(&self, ports: &dyn Ports, health: bool) -> Result<Value> {
        if self.managed.is_none() {
            return Err(ProviderError::invalid(
                "probe requires a managed Unix provider",
            ));
        }
        abort(ports)?;
        let path = if health { "/health" } else { "/v1/models" };
        let mut uri = self.base.clone();
        uri.set_path(path);
        let timeouts = Timeouts {
            headers: Some(Duration::from_secs(2)),
            idle: Some(Duration::from_secs(2)),
            total: Some(Duration::from_secs(2)),
        };
        let response = self.probe_get(&uri, ports, timeouts)?;
        if !response.status().is_success() {
            return Err(local::unavailable("unavailable"));
        }
        let mut reader = CallReader {
            input: response.into_body().into_reader(),
            ports,
        };
        let limit = if health { 64 * 1024 } else { 1024 * 1024 };
        let mut bytes = Vec::new();
        let read = reader.by_ref().take(limit + 1).read_to_end(&mut bytes);
        abort(ports)?;
        read.map_err(|_| local::unavailable("unavailable"))?;
        if bytes.len() as u64 > limit {
            return Err(ProviderError::protocol(
                "managed Unix response body exceeds its byte limit",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| ProviderError::protocol("response body is not valid JSON"))
    }

    pub(crate) fn probe_get(
        &self,
        uri: &Url,
        ports: &dyn Ports,
        timeouts: Timeouts,
    ) -> Result<ureq::http::Response<ureq::Body>> {
        abort(ports)?;
        let (agent, headers_received) = self.agent(uri, ports, Instant::now(), timeouts)?;
        let response = agent
            .get(uri.as_str())
            .header("accept", "application/json")
            .call()
            .map_err(|error| io_failure(&error, ports, TimeoutPhase::Headers))?;
        headers_received.store(true, Ordering::Relaxed);
        abort(ports)?;
        Ok(response)
    }
}

pub(crate) fn timeout(phase: TimeoutPhase) -> ProviderError {
    let name = match phase {
        TimeoutPhase::Headers => "headers",
        TimeoutPhase::Idle => "idle",
        TimeoutPhase::Total => "total",
    };
    let mut error = ProviderError::new(
        ErrorKind::Timeout,
        format!("provider call timed out ({name})"),
    );
    error.timeout_phase = Some(phase);
    error
}

fn io_failure(error: &ureq::Error, ports: &dyn Ports, phase: TimeoutPhase) -> ProviderError {
    if let Err(error) = abort(ports) {
        return error;
    }
    if let ureq::Error::Timeout(reason) = error {
        return timeout(if matches!(reason, ureq::Timeout::Global) {
            TimeoutPhase::Total
        } else {
            phase
        });
    }
    ProviderError::new(
        ErrorKind::Network,
        "network failure: provider connection failed",
    )
}

struct CallReader<'a, R> {
    input: R,
    ports: &'a dyn Ports,
}

impl<R: Read> Read for CallReader<'_, R> {
    fn read(&mut self, data: &mut [u8]) -> io::Result<usize> {
        if self.ports.cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "call aborted by the caller",
            ));
        }
        let read = self.input.read(data);
        if self.ports.cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "call aborted by the caller",
            ));
        }
        read
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    struct FixturePort(SocketAddr, Duration);

    impl Ports for FixturePort {
        fn pin(&self, _: &Url) -> Result<SocketAddr> {
            Ok(self.0)
        }

        fn credential(&self, _: Wire) -> Result<Option<String>> {
            Ok(None)
        }

        fn socket_timeout(&self) -> Duration {
            self.1
        }
    }

    const NO_PHASE_TIMEOUTS: Timeouts = Timeouts {
        headers: None,
        idle: None,
        total: None,
    };

    fn fixture_agent(
        base: &str,
        pin: SocketAddr,
        budget: Duration,
        keyless: bool,
    ) -> Result<ureq::Agent> {
        let adapter = if keyless {
            Adapter::keyless_loopback(base, Config::default())?
        } else {
            Adapter::new(Wire::ChatCompletions, base, Config::default())?
        };
        adapter
            .agent(
                &Url::parse(base).unwrap(),
                &FixturePort(pin, budget),
                Instant::now(),
                NO_PHASE_TIMEOUTS,
            )
            .map(|(agent, _)| agent)
    }

    #[test]
    fn provider_config_debug_retains_header_names_and_hides_values() {
        let config = Config {
            extra_headers: vec![("x-fixture-scope".into(), "fixture-header-marker".into())],
            ..Config::default()
        };
        let debug = format!("{config:?}");
        assert!(debug.contains("x-fixture-scope"));
        assert!(
            !debug.contains("fixture-header-marker"),
            "config Debug included a header value"
        );
    }

    #[test]
    fn a_long_port_budget_is_actually_capped_in_the_client() {
        let agent = fixture_agent(
            "http://127.0.0.1:8080/v1",
            ([127, 0, 0, 1], 8080).into(),
            Duration::from_secs(10_000),
            false,
        )
        .unwrap();
        let limit = agent.config().timeouts().global.unwrap();
        assert!(limit <= Duration::from_secs(600), "{limit:?}");
        assert!(limit > Duration::from_secs(590), "{limit:?}");
    }

    #[test]
    fn a_pin_has_to_match_both_the_requested_port_and_literal_address() {
        for address in [
            SocketAddr::from(([127, 0, 0, 1], 8081)),
            SocketAddr::from(([127, 0, 0, 2], 8080)),
        ] {
            let error = fixture_agent(
                "http://127.0.0.1:8080/v1",
                address,
                Duration::from_secs(10),
                false,
            )
            .err()
            .unwrap();
            assert_eq!(error.kind, ErrorKind::InvalidRequest);
            assert!(error.message.contains("pin for a different endpoint"));
        }
    }

    #[test]
    fn a_keyless_local_provider_requires_a_loopback_pin() {
        let error = fixture_agent(
            "http://localhost:8080/v1",
            ([192, 0, 2, 1], 8080).into(),
            Duration::from_secs(10),
            true,
        )
        .err()
        .unwrap();
        assert_eq!(error.kind, ErrorKind::InvalidRequest);
        assert!(error.message.contains("pin for a different endpoint"));
    }

    #[test]
    fn the_raw_transport_rechecks_the_absolute_deadline_under_tls() {
        // The TLS connector delegates to these raw methods. No connection is
        // needed: an expired call must return Global before touching the socket.
        let socket = Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, None).unwrap();
        let mut transport = SocketTransport {
            socket,
            buffers: LazyBuffers::new(32, 32),
            deadline: SocketDeadline(Instant::now() - Duration::from_secs(1)),
        };
        let phase = NextTimeout {
            after: Duration::from_secs(10).into(),
            reason: ureq::Timeout::RecvBody,
        };
        assert!(matches!(
            transport.await_input(phase),
            Err(ureq::Error::Timeout(ureq::Timeout::Global)),
        ));
        transport.buffers().output()[0] = b'x';
        assert!(matches!(
            transport.transmit_output(1, phase),
            Err(ureq::Error::Timeout(ureq::Timeout::Global)),
        ));
    }
}
