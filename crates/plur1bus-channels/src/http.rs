//! Blocking HTTP for channel adapters. The host authorizes one concrete remote socket per request.
//!
//! The eventual host must keep dependency wire tracing disabled because it can log paths and bodies.
use serde::Serialize;
use std::fmt;
use std::io::{self, Read};
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use ureq::http::{HeaderMap, Request, Response, StatusCode};
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use url::{Host, Url};

pub trait HttpPorts {
    /// Verify policy and resolve with a bounded deadline. Returning no address denies the request.
    fn pin(&self, endpoint: &Url) -> Option<SocketAddr>;
    fn cancelled(&self) -> bool {
        false
    }
}

#[derive(Clone, Copy)]
pub struct Http<'a> {
    ports: &'a dyn HttpPorts,
    insecure_loopback: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    BadRequest,
    Forbidden,
    NotFound,
    RateLimited,
    Unauthorized,
    Conflict,
    Http,
    Network,
    Timeout,
    Aborted,
    Protocol,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub kind: Kind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<serde_json::Value>,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}

impl std::error::Error for Error {}

impl Error {
    pub(crate) fn new(kind: Kind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            retry_after_ms: None,
            code: None,
        }
    }

    pub(crate) fn status(mut self, value: u16) -> Self {
        self.status = Some(value);
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Failure {
    Aborted,
    TimedOut,
    Denied,
    Network,
    TooLarge,
}

pub struct Attachment {
    pub data: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug)]
struct Pin(SocketAddr);

impl Resolver for Pin {
    fn resolve(
        &self,
        _: &ureq::http::Uri,
        _: &ureq::config::Config,
        _: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut resolved = self.empty();
        resolved.push(self.0);
        Ok(resolved)
    }
}

impl<'a> Http<'a> {
    /// Plain HTTP requires explicit opt-in and is limited to an actual loopback address.
    pub fn new(ports: &'a dyn HttpPorts, insecure_loopback: bool) -> Self {
        Self {
            ports,
            insecure_loopback,
        }
    }

    pub(crate) fn cancelled(self) -> bool {
        self.ports.cancelled()
    }

    pub(crate) fn request(
        self,
        method: &str,
        endpoint: &Url,
        headers: &[(&str, &str)],
        body: &[u8],
        timeout: Duration,
    ) -> Result<Response<ureq::Body>, Failure> {
        if self.cancelled() {
            return Err(Failure::Aborted);
        }
        let start = Instant::now();
        let host = endpoint.host().ok_or(Failure::Denied)?;
        let literal = match host {
            Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
            Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
            Host::Domain(_) => None,
        };
        let plain = endpoint.scheme() == "http" && self.insecure_loopback;
        if (endpoint.scheme() != "https" && !plain)
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(Failure::Denied);
        }
        let pin = self.ports.pin(endpoint).ok_or(Failure::Denied)?;
        if Some(pin.port()) != endpoint.port_or_known_default()
            || literal.is_some_and(|ip| ip != pin.ip())
            || (plain && !pin.ip().is_loopback())
        {
            return Err(Failure::Denied);
        }
        if self.cancelled() {
            return Err(Failure::Aborted);
        }
        let timeout = timeout
            .min(Duration::from_secs(600))
            .saturating_sub(start.elapsed());
        if timeout.is_zero() {
            return Err(Failure::TimedOut);
        }
        let settings = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .max_idle_connections(0)
            .max_response_header_size(64 * 1024)
            .timeout_global(Some(timeout))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        let agent = ureq::Agent::with_parts(settings, DefaultConnector::default(), Pin(pin));
        let mut request = Request::builder().method(method).uri(endpoint.as_str());
        for (name, value) in headers {
            let mut value =
                ureq::http::HeaderValue::from_str(value).map_err(|_| Failure::Denied)?;
            if *name != "content-type" {
                value.set_sensitive(true);
            }
            request = request.header(*name, value);
        }
        agent
            .run(request.body(body).map_err(|_| Failure::Denied)?)
            .map_err(|e| {
                if self.cancelled() {
                    Failure::Aborted
                } else if matches!(e, ureq::Error::Timeout(_)) {
                    Failure::TimedOut
                } else {
                    Failure::Network
                }
            })
    }

    pub(crate) fn body(
        self,
        response: &mut Response<ureq::Body>,
        limit: usize,
    ) -> Result<Vec<u8>, Failure> {
        if header(response.headers(), "content-length")
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|bytes| bytes > limit as u64)
        {
            return Err(Failure::TooLarge);
        }
        let mut reader = response.body_mut().as_reader();
        let mut bytes = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            if self.cancelled() {
                return Err(Failure::Aborted);
            }
            let remaining = limit.saturating_sub(bytes.len()).saturating_add(1);
            let chunk = remaining.min(buffer.len());
            let size = reader
                .read(&mut buffer[..chunk])
                .map_err(|error| match error.kind() {
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => Failure::TimedOut,
                    _ => Failure::Network,
                })?;
            if size == 0 {
                return Ok(bytes);
            }
            if size > limit - bytes.len() {
                return Err(Failure::TooLarge);
            }
            bytes.extend_from_slice(&buffer[..size]);
        }
    }
}

pub(crate) fn endpoint(base: &Url, suffix: &str) -> Result<Url, Error> {
    if base.query().is_some() || base.fragment().is_some() {
        return Err(Error::new(Kind::Protocol, "invalid channel API endpoint"));
    }
    Url::parse(&format!(
        "{}{}",
        base.as_str().trim_end_matches('/'),
        suffix
    ))
    .map_err(|_| Error::new(Kind::Protocol, "invalid channel API endpoint"))
}

pub(crate) fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

pub(crate) fn mime_type(headers: &HeaderMap) -> String {
    header(headers, "content-type")
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// A redirect response must never be forwarded to a credential-bearing API call.
#[cfg(any(feature = "telegram", feature = "slack"))]
pub(crate) fn follow_forbidden(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

#[cfg(any(feature = "telegram", feature = "slack"))]
pub(crate) fn rounded_retry_ms(seconds: Option<f64>) -> u64 {
    let ms = seconds.filter(|s| s.is_finite()).unwrap_or_default() * 1000.;
    ms.round().clamp(1_000., 300_000.) as u64
}

#[cfg(any(feature = "telegram", feature = "discord"))]
pub(crate) fn number(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
}

#[cfg(any(feature = "telegram", feature = "discord"))]
pub(crate) fn truncate_utf16(value: &mut String, max: usize) {
    let mut units = 0;
    for (idx, ch) in value.char_indices() {
        units += ch.len_utf16();
        if units > max {
            value.truncate(idx);
            break;
        }
    }
}
