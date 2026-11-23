//! Bounded HTTP response processing for the cloud voice providers.
use plur1bus_providers::{pinned_http_agent, retry_after_date_ms};
use serde_json::Value;
use std::{
    fmt,
    io::{self, Read},
    net::SocketAddr,
    time::{Duration, Instant, SystemTime},
};
use ureq::http::{HeaderValue, Request};
use url::{Host, Url};

/// Maximum decoded bytes in a single successful JSON reply (P4D-202).
pub const MAX_JSON_BYTES: usize = 1024 * 1024;

/// Maximum decoded audio bytes retained by a one-shot cloud request.
pub const MAX_BUFFERED_AUDIO_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct StreamLimits {
    pub max_audio_bytes: usize,
    pub max_duration: Duration,
}

impl Default for StreamLimits {
    fn default() -> Self {
        Self {
            max_audio_bytes: 64 * 1024 * 1024,
            max_duration: Duration::from_secs(600),
        }
    }
}

impl StreamLimits {
    pub(crate) fn start(self, requested: Duration) -> (Instant, AudioBudget) {
        (
            deadline(requested.min(self.max_duration)),
            AudioBudget {
                remaining: self.max_audio_bytes,
                emitted: false,
            },
        )
    }
}

pub(crate) struct AudioBudget {
    remaining: usize,
    emitted: bool,
}

impl AudioBudget {
    pub(crate) fn charge(&mut self, bytes: usize) -> Result<(), Error> {
        if bytes > self.remaining {
            return Err(Error::StreamLimit);
        }
        self.remaining -= bytes;
        self.emitted |= bytes != 0;
        Ok(())
    }

    pub(crate) fn error(&self, error: Error) -> Error {
        if self.emitted {
            error.after_audio()
        } else {
            error
        }
    }
}

pub trait Ports {
    /// Authorize and resolve one socket address before the absolute deadline.
    fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr>;

    fn cancelled(&self) -> bool {
        false
    }

    fn stream_limits(&self) -> StreamLimits {
        StreamLimits::default()
    }

    fn wall_time(&self) -> SystemTime {
        SystemTime::now()
    }

    /// The host can replace the blocking delay for tests or cancellable scheduling.
    fn wait_retry(&self, delay: Duration, deadline: Instant) -> Result<(), Error> {
        let until = (Instant::now() + delay).min(deadline);
        loop {
            if self.cancelled() {
                return Err(Error::Aborted);
            }
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return if Instant::now() < deadline {
                    Ok(())
                } else {
                    Err(Error::Timeout)
                };
            }
            std::thread::sleep(remaining.min(Duration::from_millis(50)));
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Auth,
    RateLimited,
    RateLimitedAfter(u64),
    Timeout,
    Overloaded,
    OverloadedAfter(u64),
    InvalidRequest,
    Unsupported,
    UpstreamProtocol,
    Closed,
    BadResponse,
    Network,
    Aborted,
    StreamLimit,
    AfterAudio(AudioFailure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioFailure {
    Timeout,
    Network,
    RateLimited,
    Overloaded,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimited | Self::RateLimitedAfter(_) => "rate_limited",
            Self::Timeout => "timeout",
            Self::Overloaded | Self::OverloadedAfter(_) => "overloaded",
            Self::InvalidRequest => "invalid_request",
            Self::Unsupported => "unsupported",
            Self::UpstreamProtocol => "upstream_protocol",
            Self::Closed => "closed",
            Self::BadResponse => "bad_response",
            Self::Network => "network",
            Self::Aborted => "aborted",
            Self::StreamLimit => "stream_limit",
            Self::AfterAudio(cause) => match cause {
                AudioFailure::Timeout => "timeout",
                AudioFailure::Network => "network",
                AudioFailure::RateLimited => "rate_limited",
                AudioFailure::Overloaded => "overloaded",
            },
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimited
                | Self::RateLimitedAfter(_)
                | Self::Timeout
                | Self::Overloaded
                | Self::OverloadedAfter(_)
                | Self::Network
        )
    }

    pub fn retry_after_ms(self) -> Option<u64> {
        match self {
            Self::RateLimitedAfter(ms) | Self::OverloadedAfter(ms) => Some(ms),
            _ => None,
        }
    }

    fn after_audio(self) -> Self {
        let cause = match self {
            Self::Timeout => AudioFailure::Timeout,
            Self::Network => AudioFailure::Network,
            Self::RateLimited | Self::RateLimitedAfter(_) => AudioFailure::RateLimited,
            Self::Overloaded | Self::OverloadedAfter(_) => AudioFailure::Overloaded,
            other => return other,
        };
        Self::AfterAudio(cause)
    }

    pub(crate) fn status(status: u16, hint: Option<u64>) -> Self {
        match status {
            401 | 403 => Self::Auth,
            429 => hint.map_or(Self::RateLimited, Self::RateLimitedAfter),
            408 | 504 => Self::Timeout,
            500..=599 => hint.map_or(Self::Overloaded, Self::OverloadedAfter),
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

struct AttemptError {
    error: Error,
    explicit_refusal: bool,
}

impl From<Error> for AttemptError {
    fn from(error: Error) -> Self {
        Self {
            error,
            explicit_refusal: false,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Client<'a> {
    ports: &'a dyn Ports,
    allow_loopback_http: bool,
    retries: u8,
}

impl<'a> Client<'a> {
    pub fn new(ports: &'a dyn Ports) -> Self {
        Self {
            ports,
            allow_loopback_http: false,
            retries: 2,
        }
    }

    /// Permit cleartext only when the supplied pin is a loopback address.
    pub fn with_loopback_http(mut self) -> Self {
        self.allow_loopback_http = true;
        self
    }

    pub fn with_retries(mut self, retries: u8) -> Self {
        self.retries = retries;
        self
    }

    pub(crate) fn stream_limits(&self) -> StreamLimits {
        self.ports.stream_limits()
    }

    pub(crate) fn check(&self, deadline: Instant) -> Result<(), Error> {
        check(self.ports, deadline)
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
        self.with_body(endpoint, method, headers, request, deadline, |_, reader| {
            read_bounded(reader, self.ports, deadline, limit)
        })
    }

    pub(crate) fn with_body<T>(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        deadline: Instant,
        consume: impl FnOnce(u16, &mut dyn Read) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut response = self.request(endpoint, method, headers, request, deadline, None)?;
        let gzip = response
            .headers()
            .get("content-encoding")
            .is_some_and(|enc| enc.as_bytes().eq_ignore_ascii_case(b"gzip"));
        let status = response.status().as_u16();
        let mut reader = response.body_mut().as_reader();
        if gzip {
            consume(status, &mut flate2::read::MultiGzDecoder::new(reader))
        } else {
            consume(status, &mut reader)
        }
    }

    pub(crate) fn read_chunk(
        &self,
        reader: &mut dyn Read,
        deadline: Instant,
        buffer: &mut [u8],
    ) -> Result<usize, Error> {
        checked_read(reader, self.ports, deadline, buffer)
    }

    pub(crate) fn signed_reader_until(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        deadline: Instant,
        signer: &dyn crate::polly::Signer,
    ) -> Result<Box<dyn Read>, Error> {
        let response = self.request(endpoint, method, headers, request, deadline, Some(signer))?;
        Ok(decoded_reader(response))
    }

    fn request(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        deadline: Instant,
        signer: Option<&dyn crate::polly::Signer>,
    ) -> Result<ureq::http::Response<ureq::Body>, Error> {
        let idempotent = matches!(method, "GET" | "HEAD" | "OPTIONS");
        for attempt in 0..self.retries {
            let failure = match self
                .request_once(endpoint, method, headers, request, deadline, signer)
            {
                Err(failure)
                    if failure.error.retryable() && (idempotent || failure.explicit_refusal) =>
                {
                    failure.error
                }
                outcome => return outcome.map_err(|failure| failure.error),
            };
            check(self.ports, deadline)?;
            let backoff = 500 * (1_u64 << attempt.min(6));
            let delay =
                Duration::from_millis(failure.retry_after_ms().unwrap_or(backoff).min(30_000));
            if delay >= deadline.saturating_duration_since(Instant::now()) {
                return Err(Error::Timeout);
            }
            self.ports.wait_retry(delay, deadline)?;
        }
        self.request_once(endpoint, method, headers, request, deadline, signer)
            .map_err(|failure| failure.error)
    }

    fn request_once(
        &self,
        endpoint: &Url,
        method: &str,
        headers: &[(&str, &str)],
        request: &[u8],
        deadline: Instant,
        signer: Option<&dyn crate::polly::Signer>,
    ) -> Result<ureq::http::Response<ureq::Body>, AttemptError> {
        let insecure = endpoint.scheme() == "http" && self.allow_loopback_http;
        if (endpoint.scheme() != "https" && !insecure)
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(Error::InvalidRequest.into());
        }
        check(self.ports, deadline)?;
        let pin = self
            .ports
            .pin(endpoint, deadline)
            .ok_or(Error::InvalidRequest)?;
        check_pin(endpoint, pin, insecure)?;
        check(self.ports, deadline)?;
        let authorization = signer
            .map(|signer| signer.sign(endpoint, method, headers, request, deadline))
            .transpose()?
            .unwrap_or_default();
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
        for (name, value) in headers.iter().copied().chain(
            authorization
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        ) {
            if name.eq_ignore_ascii_case("accept-encoding") {
                return Err(Error::InvalidRequest.into());
            }
            let mut header = HeaderValue::from_str(value).map_err(|_| Error::InvalidRequest)?;
            header.set_sensitive(true);
            builder = builder.header(name, header);
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
            let hint = response
                .headers()
                .get("retry-after")
                .and_then(|raw| raw.to_str().ok())
                .and_then(|value| retry_after_ms(value, self.ports.wall_time()));
            let explicit_refusal = matches!(status.as_u16(), 429 | 503) && hint.is_some();
            let error = if signer.is_some() {
                let error = crate::polly::response_error(response, self.ports, deadline);
                match error {
                    Error::RateLimited => hint.map_or(error, Error::RateLimitedAfter),
                    Error::Overloaded => hint.map_or(error, Error::OverloadedAfter),
                    _ => error,
                }
            } else {
                Error::status(status.as_u16(), hint)
            };
            return Err(AttemptError {
                error,
                explicit_refusal,
            });
        }
        check_encoding(response.headers())?;
        Ok(response)
    }
}

fn check_pin(endpoint: &Url, pin: SocketAddr, insecure: bool) -> Result<(), Error> {
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
    Ok(())
}

pub(crate) fn check_encoding(headers: &ureq::http::HeaderMap) -> Result<(), Error> {
    let mut encodings = headers.get_all("content-encoding").iter();
    if let Some(encoding) = encodings.next() {
        if encodings.next().is_some()
            || ![b"identity".as_slice(), b"gzip"]
                .iter()
                .any(|allowed| encoding.as_bytes().eq_ignore_ascii_case(allowed))
        {
            return Err(Error::BadResponse);
        }
    }
    Ok(())
}

pub(crate) fn decoded_reader(response: ureq::http::Response<ureq::Body>) -> Box<dyn Read> {
    let gzip = response
        .headers()
        .get("content-encoding")
        .is_some_and(|enc| enc.as_bytes().eq_ignore_ascii_case(b"gzip"));
    let reader = response.into_body().into_reader();
    if gzip {
        Box::new(flate2::read::MultiGzDecoder::new(reader))
    } else {
        Box::new(reader)
    }
}

fn retry_after_ms(value: &str, now: SystemTime) -> Option<u64> {
    let value = value.trim();
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if value.split_once('.').map_or_else(
        || digits(value),
        |(head, tail)| digits(head) && digits(tail),
    ) {
        return value
            .parse::<f64>()
            .ok()
            .map(|seconds| (seconds * 1000.).round().min(3_600_000.) as u64);
    }
    retry_after_date_ms(value, now).map(|ms| ms.min(3_600_000))
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
    reader: &mut (impl Read + ?Sized),
    ports: &dyn Ports,
    deadline: Instant,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let mut collected = Vec::new();
    let mut buf = [0; 8192];
    loop {
        let remaining = limit - collected.len();
        let next = buf.len().min(remaining.saturating_add(1));
        let count = checked_read(reader, ports, deadline, &mut buf[..next])?;
        if count == 0 {
            return Ok(collected);
        }
        if count > remaining {
            return Err(Error::BadResponse);
        }
        collected.extend_from_slice(&buf[..count]);
    }
}

fn checked_read(
    reader: &mut (impl Read + ?Sized),
    ports: &dyn Ports,
    deadline: Instant,
    buffer: &mut [u8],
) -> Result<usize, Error> {
    loop {
        check(ports, deadline)?;
        let result = reader.read(buffer);
        check(ports, deadline)?;
        match result {
            Ok(count) if count <= buffer.len() => return Ok(count),
            Ok(_) => return Err(Error::BadResponse),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(match error.kind() {
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => Error::Timeout,
                    _ => Error::BadResponse,
                });
            }
        }
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

#[cfg(test)]
mod guard_tests {
    use super::{check_encoding, check_pin, deadline, Duration, Error, Instant, SocketAddr, Url};
    use ureq::http::{header, HeaderMap, HeaderValue};

    #[test]
    fn cleartext_pins_and_deadlines_are_validated_without_dialing(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let url = Url::parse("http://fixture.invalid:8080/speech")?;
        let loopback: SocketAddr = "127.0.0.1:8080".parse()?;
        let elsewhere: SocketAddr = "192.0.2.5:8080".parse()?;
        assert_eq!(check_pin(&url, loopback, true), Ok(()));
        assert_eq!(check_pin(&url, elsewhere, true), Err(Error::InvalidRequest));
        let before = Instant::now();
        let cutoff = deadline(Duration::from_secs(610));
        assert!(cutoff >= before + Duration::from_secs(600));
        assert!(cutoff <= Instant::now() + Duration::from_secs(600));
        Ok(())
    }

    #[test]
    fn only_identity_and_gzip_are_accepted_body_codings() {
        for (encoding, expected) in [
            ("identity", Ok(())),
            ("gzip", Ok(())),
            ("deflate", Err(Error::BadResponse)),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
            assert_eq!(check_encoding(&headers), expected);
        }
    }
}
