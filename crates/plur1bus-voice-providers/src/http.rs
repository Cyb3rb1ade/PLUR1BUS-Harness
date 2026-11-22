//! Bounded HTTP response processing for the cloud voice providers.
use plur1bus_providers::pinned_http_agent;
use serde_json::Value;
use std::{
    fmt,
    io::{self, Read},
    net::SocketAddr,
    time::{Duration, Instant},
};
use ureq::http::{HeaderValue, Request};
use url::{Host, Url};

/// Maximum decoded bytes in a single successful JSON reply (P4D-202).
pub const MAX_JSON_BYTES: usize = 1024 * 1024;

/// Maximum decoded audio bytes retained by a one-shot cloud request.
pub const MAX_BUFFERED_AUDIO_BYTES: usize = 4 * 1024 * 1024;

pub trait Ports {
    /// Authorize and resolve one socket address before the absolute deadline.
    fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr>;

    fn cancelled(&self) -> bool {
        false
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Auth,
    RateLimited,
    Timeout,
    Overloaded,
    InvalidRequest,
    Unsupported,
    UpstreamProtocol,
    Closed,
    BadResponse,
    Network,
    Aborted,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimited => "rate_limited",
            Self::Timeout => "timeout",
            Self::Overloaded => "overloaded",
            Self::InvalidRequest => "invalid_request",
            Self::Unsupported => "unsupported",
            Self::UpstreamProtocol => "upstream_protocol",
            Self::Closed => "closed",
            Self::BadResponse => "bad_response",
            Self::Network => "network",
            Self::Aborted => "aborted",
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimited | Self::Timeout | Self::Overloaded | Self::Network
        )
    }

    fn status(status: u16) -> Self {
        match status {
            401 | 403 => Self::Auth,
            429 => Self::RateLimited,
            408 | 504 => Self::Timeout,
            500..=599 => Self::Overloaded,
            400 | 404 | 413 | 422 => Self::InvalidRequest,
            _ => Self::BadResponse,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for Error {}

pub struct Client<'a> {
    ports: &'a dyn Ports,
    allow_loopback_http: bool,
}

impl<'a> Client<'a> {
    pub fn new(ports: &'a dyn Ports) -> Self {
        Self {
            ports,
            allow_loopback_http: false,
        }
    }

    /// Permit cleartext only when the supplied pin is a loopback address.
    pub fn with_loopback_http(mut self) -> Self {
        self.allow_loopback_http = true;
        self
    }

    pub fn json(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        timeout: Duration,
    ) -> Result<Value, Error> {
        self.json_until(endpoint, method, headers, request, deadline(timeout))
    }

    pub(crate) fn json_until(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        deadline: Instant,
    ) -> Result<Value, Error> {
        let body =
            self.bytes_until(endpoint, method, headers, request, deadline, MAX_JSON_BYTES)?;
        serde_json::from_slice(&body).map_err(|_| Error::BadResponse)
    }

    pub(crate) fn bytes_until(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        deadline: Instant,
        limit: usize,
    ) -> Result<Vec<u8>, Error> {
        let mut response = self.request(endpoint, method, headers, request, deadline)?;
        let gzip = response
            .headers()
            .get("content-encoding")
            .is_some_and(|enc| enc.as_bytes().eq_ignore_ascii_case(b"gzip"));
        let mut reader = response.body_mut().as_reader();
        if gzip {
            read_bounded(
                &mut flate2::read::MultiGzDecoder::new(reader),
                self.ports,
                deadline,
                limit,
            )
        } else {
            read_bounded(&mut reader, self.ports, deadline, limit)
        }
    }

    fn request(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        deadline: Instant,
    ) -> Result<ureq::http::Response<ureq::Body>, Error> {
        let insecure = endpoint.scheme() == "http" && self.allow_loopback_http;
        if (endpoint.scheme() != "https" && !insecure)
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(Error::InvalidRequest);
        }
        check(self.ports, deadline)?;
        let pin = self
            .ports
            .pin(endpoint, deadline)
            .ok_or(Error::InvalidRequest)?;
        if Some(pin.port()) != endpoint.port_or_known_default()
            || (insecure && !pin.ip().is_loopback())
            || match endpoint.host() {
                None => true,
                Some(Host::Ipv4(ip)) => pin.ip() != ip,
                Some(Host::Ipv6(ip)) => pin.ip() != ip,
                Some(Host::Domain(_)) => false,
            }
        {
            return Err(Error::InvalidRequest);
        }
        check(self.ports, deadline)?;

        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .max_idle_connections(0)
            .max_response_header_size(64 * 1024)
            .timeout_global(Some(deadline.saturating_duration_since(Instant::now())))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        let agent = pinned_http_agent(config, pin, deadline);
        let mut builder = Request::builder()
            .method(method)
            .uri(endpoint.as_str())
            .header("accept-encoding", "gzip");
        for (name, value) in headers {
            if name.eq_ignore_ascii_case("accept-encoding") {
                return Err(Error::InvalidRequest);
            }
            let mut header = HeaderValue::from_str(value).map_err(|_| Error::InvalidRequest)?;
            header.set_sensitive(true);
            builder = builder.header(*name, header);
        }
        let request = builder.body(request).map_err(|_| Error::InvalidRequest)?;
        let response = agent.run(request).map_err(|err| {
            if self.ports.cancelled() {
                Error::Aborted
            } else if matches!(err, ureq::Error::Timeout(_)) {
                Error::Timeout
            } else {
                Error::Network
            }
        })?;
        check(self.ports, deadline)?;
        let status = response.status();
        if !status.is_success() {
            // Provider diagnostics are neither consumed nor surfaced.
            return Err(Error::status(status.as_u16()));
        }
        if let Some(encoding) = response.headers().get("content-encoding") {
            if response
                .headers()
                .get_all("content-encoding")
                .iter()
                .count()
                > 1
                || ![b"identity".as_slice(), b"gzip"]
                    .iter()
                    .any(|allowed| encoding.as_bytes().eq_ignore_ascii_case(allowed))
            {
                return Err(Error::BadResponse);
            }
        }
        Ok(response)
    }
}

pub(crate) fn deadline(timeout: Duration) -> Instant {
    Instant::now() + timeout.min(Duration::from_secs(600))
}

pub(crate) fn check(ports: &dyn Ports, deadline: Instant) -> Result<(), Error> {
    if ports.cancelled() {
        Err(Error::Aborted)
    } else if Instant::now() >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}

pub(crate) fn read_bounded(
    reader: &mut impl Read,
    ports: &dyn Ports,
    deadline: Instant,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let mut collected = Vec::new();
    let mut buf = [0; 8192];
    loop {
        check(ports, deadline)?;
        let remaining = limit - collected.len();
        let next = buf.len().min(remaining + 1);
        let count = match reader.read(&mut buf[..next]) {
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                check(ports, deadline)?;
                return Err(match error.kind() {
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => Error::Timeout,
                    _ => Error::BadResponse,
                });
            }
        };
        check(ports, deadline)?;
        if count == 0 {
            return Ok(collected);
        }
        if count > remaining {
            return Err(Error::BadResponse);
        }
        collected.extend_from_slice(&buf[..count]);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "finite synthetic reader fixtures")]
mod tests {
    use super::*;
    use std::io::Write;

    struct NoNetwork;

    impl Ports for NoNetwork {
        fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
            None
        }
    }

    #[test]
    fn the_decoded_json_limit_is_inclusive_and_reads_only_one_extra_byte() {
        let exact = format!("\"{}\"", "a".repeat(MAX_JSON_BYTES - 2));
        let mut over = exact.as_bytes().to_vec();
        // Add harmless whitespace to the otherwise valid JSON.
        over.extend_from_slice(b"  ");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut exact = exact.as_bytes();
        let bytes = read_bounded(&mut exact, &NoNetwork, deadline, MAX_JSON_BYTES).unwrap();
        assert!(serde_json::from_slice::<Value>(&bytes).unwrap().is_string());
        let mut over = over.as_slice();
        assert_eq!(
            read_bounded(&mut over, &NoNetwork, deadline, MAX_JSON_BYTES),
            Err(Error::BadResponse)
        );
        assert_eq!(over, b" ");
        assert!(!Error::BadResponse.retryable());
    }

    #[test]
    fn compressed_bytes_are_counted_after_decoding() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&vec![b' '; MAX_JSON_BYTES + 1]).unwrap();
        let encoded = encoder.finish().unwrap();
        assert!(encoded.len() < MAX_JSON_BYTES);
        let mut decoder = flate2::read::MultiGzDecoder::new(encoded.as_slice());
        assert_eq!(
            read_bounded(
                &mut decoder,
                &NoNetwork,
                Instant::now() + Duration::from_secs(5),
                MAX_JSON_BYTES
            ),
            Err(Error::BadResponse)
        );
    }

    #[test]
    fn an_expired_deadline_refuses_a_valid_body() {
        let mut json: &[u8] = b"{}";
        assert_eq!(
            read_bounded(&mut json, &NoNetwork, Instant::now(), MAX_JSON_BYTES),
            Err(Error::Timeout)
        );
        assert_eq!(json, b"{}");
    }
}
