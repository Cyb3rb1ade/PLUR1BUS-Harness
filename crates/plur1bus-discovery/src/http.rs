//! Origin-pinned HTTP page transport using the shared provider connector.

use std::{
    io::{self, Read},
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use chrono::DateTime;
use flate2::read::{GzDecoder, ZlibDecoder};
use plur1bus_providers::pinned_http_agent;
use ureq::http::{HeaderValue, Request, Uri};

use crate::scanners::{Error, Page, Port, Result};

const MAX_REDIRECTS: usize = 3;
const CONNECT: Duration = Duration::from_secs(5);
const MAX_RETRY_MS: u64 = 86_400_000;

pub trait Admission {
    /// Resolve the page relative to the configured base and encode its query.
    fn endpoint(&self, page: &Page<'_>) -> Result<Uri>;
    /// Resolve a Location relative to a previously admitted URI.
    fn redirect(&self, from: &Uri, location: &str) -> Result<Uri>;
    /// Resolve and admit one address. The connector dials only this pin.
    fn pin(&self, uri: &Uri, deadline: Instant) -> Result<SocketAddr>;
    fn now_ms(&self) -> i64;
}

pub enum Lease<'a> {
    /// Complete Authorization header prepared by the host.
    Bearer(&'a str),
    Anthropic(&'a str),
    Google(&'a str),
}

pub struct Http<'a> {
    host: &'a dyn Admission,
    base: &'a Uri,
    agent: HeaderValue,
    credential: Option<(&'static str, HeaderValue)>,
    loopback: bool,
}

impl<'a> Http<'a> {
    pub fn new(
        host: &'a dyn Admission,
        base: &'a Uri,
        agent: &str,
        lease: Option<Lease<'_>>,
        allow_loopback: bool,
    ) -> Result<Self> {
        let loopback = base.scheme_str() == Some("http") && allow_loopback;
        let (scheme, host_name, _) = origin(base)?;
        if scheme != "https"
            && !(loopback
                && (host_name.eq_ignore_ascii_case("localhost")
                    || literal(host_name).is_some_and(|ip| ip.is_loopback())))
        {
            return Err(Error::invalid("insecure_transport"));
        }
        let mut credential = None;
        if let Some(lease) = lease {
            let (name, value) = match lease {
                Lease::Bearer(value) => ("authorization", value),
                Lease::Anthropic(value) => ("x-api-key", value),
                Lease::Google(value) => ("x-goog-api-key", value),
            };
            let mut value =
                HeaderValue::from_str(value).map_err(|_| Error::invalid("credential_header"))?;
            value.set_sensitive(true);
            credential = Some((name, value));
        }
        Ok(Self {
            host,
            base,
            agent: HeaderValue::from_str(agent).map_err(|_| Error::invalid("user_agent"))?,
            credential,
            loopback,
        })
    }
}

fn origin(uri: &Uri) -> Result<(&str, &str, u16)> {
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| Error::invalid("invalid_base_url"))?;
    let authority = uri
        .authority()
        .filter(|value| !value.as_str().contains('@'))
        .ok_or_else(|| Error::invalid("invalid_base_url"))?;
    let port = match scheme {
        "http" => 80,
        "https" => 443,
        _ => return Err(Error::invalid("invalid_base_url")),
    };
    Ok((
        scheme,
        authority.host(),
        authority.port_u16().unwrap_or(port),
    ))
}

fn literal(host: &str) -> Option<IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

fn deadline_remaining(deadline: Instant) -> Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.as_millis() == 0 {
        return Err(Error::network("request_timeout"));
    }
    Ok(remaining)
}

impl Port for Http<'_> {
    fn get(&mut self, page: Page<'_>) -> Result<Vec<u8>> {
        let mut uri = self.host.endpoint(&page)?;
        let (expected_scheme, expected_host, expected_port) = origin(self.base)?;
        for hop in 0..=MAX_REDIRECTS {
            let (scheme, host, port) = origin(&uri)?;
            if scheme != expected_scheme
                || !host.eq_ignore_ascii_case(expected_host)
                || port != expected_port
            {
                return Err(Error::invalid("redirect_foreign_origin"));
            }
            deadline_remaining(page.deadline)?;
            let pin = self.host.pin(&uri, page.deadline)?;
            if pin.port() != port
                || (self.loopback && !pin.ip().is_loopback())
                || literal(host).is_some_and(|address| pin.ip() != address)
            {
                return Err(Error::invalid("egress_pin"));
            }
            let remaining = deadline_remaining(page.deadline)?;
            let config = ureq::Agent::config_builder()
                .proxy(None)
                .max_redirects(0)
                .http_status_as_error(false)
                .max_idle_connections(0)
                .max_response_header_size(64 * 1024)
                .timeout_connect(Some(CONNECT))
                .timeout_global(Some(remaining))
                .tls_config(
                    ureq::tls::TlsConfig::builder()
                        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                        .build(),
                )
                .build();
            let agent = pinned_http_agent(config, pin, page.deadline);
            let mut request = Request::get(&uri)
                .header("accept", "application/json")
                .header("accept-encoding", "gzip, deflate, br")
                .header("user-agent", self.agent.clone());
            for (name, value) in &page.headers {
                if *name != "anthropic-version" {
                    return Err(Error::invalid("request_header"));
                }
                request = request.header(*name, *value);
            }
            if let Some((name, value)) = &self.credential {
                request = request.header(*name, value.clone());
            }
            let request = request
                .body(())
                .map_err(|_| Error::invalid("invalid_request"))?;
            let mut response = agent.run(request).map_err(|err| match err {
                ureq::Error::Timeout(_) => Error::network("request_timeout"),
                _ => Error::network("network"),
            })?;
            let status = response.status();
            if status.is_success() {
                let mut encodings = response.headers().get_all("content-encoding").iter();
                let encoding = encodings.next().cloned();
                if encodings.next().is_some() {
                    return Err(Error::invalid("unsupported_encoding"));
                }
                let body = read_bounded(
                    response.body_mut().as_reader(),
                    page.max_bytes,
                    page.deadline,
                )?;
                let kind = encoding
                    .as_ref()
                    .map_or(b"identity".as_slice(), HeaderValue::as_bytes);
                let bytes = if kind.eq_ignore_ascii_case(b"identity") {
                    body
                } else if kind.eq_ignore_ascii_case(b"gzip") {
                    read_bounded(
                        GzDecoder::new(body.as_slice()),
                        page.max_bytes,
                        page.deadline,
                    )?
                } else if kind.eq_ignore_ascii_case(b"deflate") {
                    read_bounded(
                        ZlibDecoder::new(body.as_slice()),
                        page.max_bytes,
                        page.deadline,
                    )?
                } else if kind.eq_ignore_ascii_case(b"br") {
                    read_bounded(
                        brotli::Decompressor::new(body.as_slice(), 8192),
                        page.max_bytes,
                        page.deadline,
                    )?
                } else {
                    return Err(Error::invalid("unsupported_encoding"));
                };
                return Ok(bytes);
            }
            if status.is_redirection() {
                if hop == MAX_REDIRECTS {
                    return Err(Error::invalid("too_many_redirects"));
                }
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| Error::invalid("bad_redirect"))?;
                uri = self.host.redirect(&uri, location)?;
                continue;
            }
            let mut error = Error::http_status(status.as_u16());
            if status.as_u16() == 429 {
                error.retry_after_ms = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|value| retry_after(value, self.host.now_ms()));
            }
            return Err(error);
        }
        Err(Error::invalid("too_many_redirects"))
    }
}

fn read_bounded(mut input: impl Read, limit: usize, deadline: Instant) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0; 8192];
    loop {
        deadline_remaining(deadline)?;
        let count = buffer.len().min(limit - bytes.len() + 1);
        let n = input
            .read(&mut buffer[..count])
            .map_err(|error| match error.kind() {
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => {
                    Error::network("request_timeout")
                }
                _ => Error::invalid("response_body"),
            })?;
        deadline_remaining(deadline)?;
        if n == 0 {
            return Ok(bytes);
        }
        if n > limit - bytes.len() {
            return Err(Error::invalid("response_too_large"));
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
}

pub fn retry_after(value: &str, now_ms: i64) -> Option<u64> {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        let seconds = value.parse::<u64>().unwrap_or(u64::MAX);
        return Some(seconds.saturating_mul(1000).min(MAX_RETRY_MS));
    }
    let date = DateTime::parse_from_rfc2822(value).ok()?;
    let delay = date.timestamp_millis().saturating_sub(now_ms).max(0);
    Some(u64::try_from(delay).ok()?.min(MAX_RETRY_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reader_accepts_the_exact_decoded_limit_and_refuses_one_more_byte() {
        let deadline = Instant::now() + Duration::from_secs(5);
        assert_eq!(
            read_bounded(b"abcd".as_slice(), 4, deadline),
            Ok(b"abcd".to_vec())
        );
        assert_eq!(
            read_bounded(b"abcde".as_slice(), 4, deadline),
            Err(Error::invalid("response_too_large"))
        );
    }

    #[test]
    fn an_expired_reader_does_not_start() {
        assert_eq!(
            read_bounded(b"abcd".as_slice(), 4, Instant::now()),
            Err(Error::network("request_timeout"))
        );
    }
}
