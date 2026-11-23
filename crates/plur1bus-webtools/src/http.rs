//! One deadline and one admitted socket per hop of a web request.

use std::{
    io::{self, Read},
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use flate2::read::{MultiGzDecoder, ZlibDecoder};
use plur1bus_providers::pinned_http_agent;
use ureq::http::{header, HeaderMap, Method, Request};
use url::{Host, Url};

pub const DEFAULT_BODY_BYTES: usize = 20 * 1024 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DIAGNOSTIC_BYTES: usize = 64 * 1024;
const MAX_ENCODING_LAYERS: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    InvalidUrl,
    PrivateAddress,
    EgressDenied,
    RobotsDisallowed,
    NotFound,
    TooLarge,
    TooManyRedirects,
    UnsupportedType,
    Tls,
    Timeout,
    Network,
}

impl Failure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidUrl => "invalid-url",
            Self::PrivateAddress => "private-address",
            Self::EgressDenied => "egress-denied",
            Self::RobotsDisallowed => "robots-disallowed",
            Self::NotFound => "not-found",
            Self::TooLarge => "too-large",
            Self::TooManyRedirects => "too-many-redirects",
            Self::UnsupportedType => "unsupported-type",
            Self::Tls => "tls-error",
            Self::Timeout => "timeout",
            Self::Network => "network-error",
        }
    }
}

type Result<T> = std::result::Result<T, Failure>;

pub trait Admission {
    /// Apply the host's URL policy, guarded resolver and address classification
    /// before making any connection. Return one approved address for this URL.
    fn pin(&self, target: &Url, deadline: Instant) -> Result<SocketAddr>;

    /// Optional crawl policy for the next URL, before its DNS or HTTP request.
    fn before_redirect(&self, _target: &Url, _deadline: Instant) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Redirects {
    Follow,
    Manual,
    Refuse,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Coding {
    Compressed,
    Identity,
}

pub type AcceptType<'a> = &'a dyn Fn(Option<&str>) -> bool;

pub struct Options<'a> {
    pub method: Method,
    pub headers: &'a HeaderMap,
    pub body: Option<&'a [u8]>,
    pub user_agent: &'a str,
    pub accept: &'a str,
    pub coding: Coding,
    pub redirects: Redirects,
    pub max_redirects: usize,
    pub max_bytes: usize,
    pub max_request_bytes: usize,
    pub error_body_bytes: usize,
    pub accept_type: Option<AcceptType<'a>>,
    pub discard_body: bool,
    pub deadline: Instant,
}

impl<'a> Options<'a> {
    pub fn get(
        headers: &'a HeaderMap,
        user_agent: &'a str,
        accept: &'a str,
        deadline: Instant,
    ) -> Self {
        Self {
            method: Method::GET,
            headers,
            body: None,
            user_agent,
            accept,
            coding: Coding::Compressed,
            redirects: Redirects::Follow,
            max_redirects: 10,
            max_bytes: DEFAULT_BODY_BYTES,
            max_request_bytes: DEFAULT_BODY_BYTES,
            error_body_bytes: 0,
            accept_type: None,
            discard_body: false,
            deadline,
        }
    }
}

pub struct Response {
    pub url: Url,
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub redirects: Vec<Url>,
}

fn checked_target(mut url: Url) -> Result<Url> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Failure::InvalidUrl);
    }
    url.set_fragment(None);
    Ok(url)
}

fn request_parts(options: &Options<'_>) -> Result<HeaderMap> {
    if !matches!(
        options.method,
        Method::GET | Method::HEAD | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) || (matches!(options.method, Method::GET | Method::HEAD) && options.body.is_some())
    {
        return Err(Failure::InvalidUrl);
    }
    if options
        .body
        .is_some_and(|body| body.len() > options.max_request_bytes)
    {
        return Err(Failure::TooLarge);
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::USER_AGENT,
        options
            .user_agent
            .parse()
            .map_err(|_| Failure::InvalidUrl)?,
    );
    headers.insert(
        header::ACCEPT,
        options.accept.parse().map_err(|_| Failure::InvalidUrl)?,
    );
    headers.insert(
        header::ACCEPT_ENCODING,
        header::HeaderValue::from_static(match options.coding {
            Coding::Compressed => "gzip, deflate, br",
            Coding::Identity => "identity",
        }),
    );
    headers.insert(
        header::CONNECTION,
        header::HeaderValue::from_static("close"),
    );
    for (name, value) in options.headers {
        if matches!(
            name.as_str(),
            "host"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "te"
                | "trailer"
                | "upgrade"
                | "keep-alive"
                | "expect"
                | "accept-encoding"
                | "cookie"
        ) || name.as_str().starts_with("proxy-")
        {
            return Err(Failure::InvalidUrl);
        }
        let mut field = value.clone();
        field.set_sensitive(true);
        headers.insert(name, field);
    }
    Ok(headers)
}

fn remaining(deadline: Instant, aborted: &dyn Fn() -> bool) -> Result<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.as_millis() == 0 || aborted() {
        return Err(Failure::Timeout);
    }
    Ok(left)
}

fn pin_matches(target: &Url, pin: SocketAddr) -> bool {
    let literal = match target.host() {
        Some(Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    target.port_or_known_default() == Some(pin.port())
        && literal.is_none_or(|ip| ip.to_canonical() == pin.ip().to_canonical())
}

pub fn request(
    target: &str,
    options: &Options<'_>,
    admission: &dyn Admission,
    aborted: &dyn Fn() -> bool,
) -> Result<Response> {
    let headers = request_parts(options)?;
    let mut url = checked_target(Url::parse(target).map_err(|_| Failure::InvalidUrl)?)?;
    let follows = options.redirects == Redirects::Follow
        && matches!(options.method, Method::GET | Method::HEAD)
        && options.headers.is_empty();
    let mut redirects = Vec::new();
    loop {
        remaining(options.deadline, aborted)?;
        let pin = admission.pin(&url, options.deadline)?;
        if !pin_matches(&url, pin) {
            return Err(Failure::EgressDenied);
        }
        let timeout = remaining(options.deadline, aborted)?;
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .max_idle_connections(0)
            .max_response_header_size(64 * 1024)
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        let agent = pinned_http_agent(config, pin, options.deadline);
        let mut builder = Request::builder()
            .method(options.method.clone())
            .uri(url.as_str());
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }
        let response = if let Some(body) = options.body {
            agent.run(builder.body(body).map_err(|_| Failure::InvalidUrl)?)
        } else {
            agent.run(builder.body(()).map_err(|_| Failure::InvalidUrl)?)
        };
        remaining(options.deadline, aborted)?;
        let mut response = response.map_err(wire_failure)?;
        let status = response.status().as_u16();
        let redirection = matches!(status, 301 | 302 | 303 | 307 | 308);
        if redirection && options.redirects == Redirects::Refuse {
            return Err(Failure::InvalidUrl);
        }
        if follows && redirection {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok());
            if let Some(location) = location.filter(|location| !location.is_empty()) {
                if redirects.len() >= options.max_redirects {
                    return Err(Failure::TooManyRedirects);
                }
                let next = checked_target(url.join(location).map_err(|_| Failure::InvalidUrl)?)?;
                admission.before_redirect(&next, options.deadline)?;
                redirects.push(url);
                url = next;
                continue;
            }
        }
        let body = response_body(&mut response, options, aborted)?;
        return Ok(Response {
            url,
            status,
            headers: response.headers().clone(),
            body,
            redirects,
        });
    }
}

fn wire_failure(error: ureq::Error) -> Failure {
    match error {
        ureq::Error::Timeout(_) => Failure::Timeout,
        ureq::Error::Io(error) => io_failure(&error),
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => Failure::Tls,
        _ => Failure::Network,
    }
}

fn io_failure(error: &io::Error) -> Failure {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) || error.get_ref().is_some_and(|cause| {
        matches!(
            cause.downcast_ref::<ureq::Error>(),
            Some(ureq::Error::Timeout(_))
        )
    }) {
        Failure::Timeout
    } else {
        Failure::Network
    }
}

fn response_body(
    response: &mut ureq::http::Response<ureq::Body>,
    options: &Options<'_>,
    aborted: &dyn Fn() -> bool,
) -> Result<Vec<u8>> {
    let status = response.status().as_u16();
    if options.discard_body || options.method == Method::HEAD || (300..400).contains(&status) {
        return Ok(Vec::new());
    }
    let diagnostic = status >= 400;
    let limit = if diagnostic {
        options.error_body_bytes.min(DIAGNOSTIC_BYTES)
    } else {
        options.max_bytes
    };
    if diagnostic && limit == 0 {
        return Ok(Vec::new());
    }
    if (200..300).contains(&status)
        && options.accept_type.is_some_and(|accepts| {
            !accepts(
                response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok()),
            )
        })
    {
        return Err(Failure::UnsupportedType);
    }
    match read_response_body(response, options, aborted, diagnostic, limit) {
        Err(Failure::Network | Failure::UnsupportedType) if diagnostic => Ok(Vec::new()),
        result => result,
    }
}

fn read_response_body(
    response: &mut ureq::http::Response<ureq::Body>,
    options: &Options<'_>,
    aborted: &dyn Fn() -> bool,
    diagnostic: bool,
    limit: usize,
) -> Result<Vec<u8>> {
    let encodings = response
        .headers()
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .map(|value| value.to_str().map_err(|_| Failure::UnsupportedType))
        .collect::<Result<Vec<_>>>()?
        .join(",");
    if options.coding == Coding::Identity
        && !encodings.is_empty()
        && !encodings.eq_ignore_ascii_case("identity")
    {
        return Err(Failure::UnsupportedType);
    }
    let encodings = encodings
        .split(',')
        .map(|coding| coding.trim().to_ascii_lowercase())
        .filter(|coding| !coding.is_empty() && coding != "identity")
        .collect::<Vec<_>>();
    if encodings.len() > MAX_ENCODING_LAYERS {
        return Err(Failure::UnsupportedType);
    }
    if !diagnostic
        && encodings.is_empty()
        && response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > limit as u64)
    {
        return Err(Failure::TooLarge);
    }
    let mut reader: Box<dyn Read + '_> = Box::new(response.body_mut().as_reader());
    for encoding in encodings.iter().rev() {
        reader = match encoding.as_str() {
            "gzip" | "x-gzip" => Box::new(MultiGzDecoder::new(reader)),
            "deflate" => Box::new(ZlibDecoder::new(reader)),
            "br" => Box::new(brotli::Decompressor::new(reader, 8192)),
            _ => return Err(Failure::UnsupportedType),
        };
    }
    let mut body = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0; 8192];
    loop {
        remaining(options.deadline, aborted)?;
        let available = limit - body.len();
        let count = if diagnostic {
            available
        } else {
            available.saturating_add(1)
        };
        if count == 0 {
            return Ok(body);
        }
        let chunk = buffer.len().min(count);
        let received = reader.read(&mut buffer[..chunk]);
        remaining(options.deadline, aborted)?;
        let received = received.map_err(|error| io_failure(&error))?;
        if received == 0 {
            return Ok(body);
        }
        if received > available {
            return Err(Failure::TooLarge);
        }
        body.extend_from_slice(&buffer[..received]);
    }
}
