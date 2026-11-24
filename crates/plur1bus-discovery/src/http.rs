//! Origin-pinned HTTP page transport using the shared provider connector.

use std::{
    io::{self, Read},
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use chrono::DateTime;
use flate2::read::{MultiGzDecoder, ZlibDecoder};
use plur1bus_providers::pinned_http_agent;
use ureq::http::{HeaderValue, Request, Uri};
use url::Url;

use crate::scanners::{Error, Page, Port, Result};

const MAX_REDIRECTS: usize = 3;
const CONNECT: Duration = Duration::from_secs(5);
const MAX_RETRY_MS: u64 = 86_400_000;
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;

pub trait Admission {
    /// Resolve and admit one address. The connector dials only this pin.
    fn pin(&self, uri: &Uri, deadline: Instant) -> Result<SocketAddr>;
    /// Verify this exact HTTP base came from explicit user configuration.
    fn configured_cleartext(&self, _base: &Uri) -> bool {
        false
    }

    fn now_ms(&self) -> i64;
}

/// Host-provided credential and the origin authorized to receive it.
pub struct Lease<'a> {
    pub origin: &'a Url,
    pub header: CredentialHeader<'a>,
}

pub enum CredentialHeader<'a> {
    /// Complete Authorization header prepared by the host.
    Bearer(&'a str),
    Anthropic(&'a str),
    Google(&'a str),
}

pub struct Http<'a> {
    host: &'a dyn Admission,
    base: Url,
    agent: HeaderValue,
    credential: Option<(&'static str, HeaderValue)>,
    loopback: bool,
}

impl<'a> Http<'a> {
    pub fn new(
        host: &'a dyn Admission,
        base: &Uri,
        agent: &str,
        lease: Option<Lease<'_>>,
        allow_loopback: bool,
    ) -> Result<Self> {
        let (scheme, host_name, _) = origin(base)?;
        let base_url =
            Url::parse(&base.to_string()).map_err(|_| Error::invalid("invalid_base_url"))?;
        let local_target = host_name.eq_ignore_ascii_case("localhost")
            || literal(host_name).is_some_and(|ip| ip.is_loopback());
        let normalized_loopback = base_url
            .host_str()
            .and_then(literal)
            .is_some_and(|ip| ip.to_canonical().is_loopback());
        let loopback = scheme == "http" && local_target && allow_loopback;
        if scheme != "https"
            && !loopback
            && (local_target
                || normalized_loopback
                || lease.is_some()
                || !host.configured_cleartext(base))
        {
            return Err(Error::invalid("insecure_transport"));
        }
        let base = base_url;
        if base.query().is_some() || base.fragment().is_some() {
            return Err(Error::invalid("invalid_base_url"));
        }
        let credential = lease
            .map(|lease| {
                if lease.origin.origin() != base.origin() {
                    return Err(Error::invalid("credential_origin"));
                }
                let (name, value) = match lease.header {
                    CredentialHeader::Bearer(value) => ("authorization", value),
                    CredentialHeader::Anthropic(value) => ("x-api-key", value),
                    CredentialHeader::Google(value) => ("x-goog-api-key", value),
                };
                let mut value = HeaderValue::from_str(value)
                    .map_err(|_| Error::invalid("credential_header"))?;
                value.set_sensitive(true);
                Ok((name, value))
            })
            .transpose()?;
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

fn check_pin(pin: SocketAddr, host: &str, port: u16, loopback: bool) -> Result<()> {
    if pin.port() != port
        || (loopback && !pin.ip().is_loopback())
        || literal(host).is_some_and(|address| pin.ip() != address)
    {
        return Err(Error::invalid("egress_pin"));
    }
    Ok(())
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
        let mut url = self.base.clone();
        url.set_path(&format!(
            "{}{}",
            self.base.path().trim_end_matches('/'),
            page.path
        ));
        if !page.query.is_empty() {
            url.query_pairs_mut().extend_pairs(&page.query);
        }
        for hop in 0..=MAX_REDIRECTS {
            if !url.username().is_empty() || url.password().is_some() {
                return Err(Error::invalid("bad_redirect"));
            }
            if url.origin() != self.base.origin() {
                return Err(Error::invalid("redirect_foreign_origin"));
            }
            url.set_fragment(None);
            let uri: Uri = url
                .as_str()
                .parse()
                .map_err(|_| Error::invalid("invalid_request"))?;
            let (_, host, port) = origin(&uri)?;
            deadline_remaining(page.deadline)?;
            let pin = self.host.pin(&uri, page.deadline)?;
            check_pin(pin, host, port, self.loopback)?;
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
                ureq::Error::Io(error) => match error.kind() {
                    io::ErrorKind::ConnectionRefused => Error::network("connection_refused"),
                    io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe => {
                        Error::network("connection_reset")
                    }
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => {
                        Error::network("request_timeout")
                    }
                    _ => Error::network("network_error"),
                },
                ureq::Error::Rustls(_) | ureq::Error::Tls(_) => Error::network("tls_error"),
                _ => Error::network("network_error"),
            })?;
            let status = response.status();
            if status.is_success() {
                if !response
                    .headers()
                    .get("content-type")
                    .and_then(|field| field.to_str().ok())
                    .is_some_and(json_content_type)
                {
                    return Err(Error::invalid("content_type"));
                }
                let encoding = response_encoding(response.headers())?;
                let maximum = page.max_bytes.min(MAX_JSON_BYTES);
                let body = read_bounded(response.body_mut().as_reader(), maximum, page.deadline)?;
                return match encoding.as_str() {
                    "" | "identity" => Ok(body),
                    "gzip" => decode(
                        MultiGzDecoder::new(body.as_slice()),
                        maximum,
                        page.deadline,
                        "bad_gzip",
                    ),
                    "deflate" => decode(
                        ZlibDecoder::new(body.as_slice()),
                        maximum,
                        page.deadline,
                        "bad_deflate",
                    ),
                    "br" => decode(
                        brotli::Decompressor::new(body.as_slice(), 8192),
                        maximum,
                        page.deadline,
                        "bad_brotli",
                    ),
                    _ => Err(Error::invalid("content_encoding")),
                };
            }
            if status.is_redirection() {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| Error::http_status(status.as_u16()))?;
                let next = url
                    .join(location)
                    .map_err(|_| Error::invalid("bad_redirect"))?;
                if !next.username().is_empty() || next.password().is_some() {
                    return Err(Error::invalid("bad_redirect"));
                }
                if next.origin() != self.base.origin() {
                    return Err(Error::invalid("redirect_foreign_origin"));
                }
                if hop == MAX_REDIRECTS {
                    return Err(Error::invalid("too_many_redirects"));
                }
                url = next;
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

fn response_encoding(headers: &ureq::http::HeaderMap) -> Result<String> {
    let mut encodings = headers.get_all("content-encoding").iter();
    let encoding = encodings
        .next()
        .map(|value| {
            value
                .to_str()
                .map(|value| value.trim().to_ascii_lowercase())
                .map_err(|_| Error::invalid("content_encoding"))
        })
        .transpose()?
        .unwrap_or_default();
    if encodings.next().is_some() {
        return Err(Error::invalid("content_encoding"));
    }
    Ok(encoding)
}

fn json_content_type(value: &str) -> bool {
    let mime = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_lowercase();
    let Some(subtype) = mime.strip_prefix("application/") else {
        return false;
    };
    subtype == "json"
        || subtype.strip_suffix("+json").is_some_and(|prefix| {
            !prefix.is_empty()
                && prefix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
        })
}

fn decode(
    input: impl Read,
    limit: usize,
    deadline: Instant,
    invalid: &'static str,
) -> Result<Vec<u8>> {
    read_bounded(input, limit, deadline).map_err(|error| {
        if error.reason == "response_body" {
            Error::invalid(invalid)
        } else {
            error
        }
    })
}

fn read_bounded(mut input: impl Read, limit: usize, deadline: Instant) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0; 8192];
    loop {
        deadline_remaining(deadline)?;
        let count = buffer.len().min(limit - bytes.len() + 1);
        let received = input.read(&mut buffer[..count]);
        deadline_remaining(deadline)?;
        let n = received.map_err(|error| {
            if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) || error.get_ref().is_some_and(|cause| {
                matches!(
                    cause.downcast_ref::<ureq::Error>(),
                    Some(ureq::Error::Timeout(_))
                )
            }) {
                Error::network("request_timeout")
            } else {
                Error::invalid("response_body")
            }
        })?;
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

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "fixture assertions")]
mod additional_tests {
    use super::*;
    use ureq::http::HeaderMap;

    #[test]
    fn pin_matches_port_address_and_loopback() {
        let pin: SocketAddr = "127.0.0.1:3210".parse().unwrap();
        assert!(check_pin(pin, "127.0.0.1", 3210, true).is_ok());
        assert_eq!(
            check_pin(pin, "127.0.0.1", 3211, true),
            Err(Error::invalid("egress_pin"))
        );
        assert_eq!(
            check_pin(pin, "127.0.0.2", 3210, true),
            Err(Error::invalid("egress_pin"))
        );
        let nonlocal: SocketAddr = "192.0.2.4:3210".parse().unwrap();
        assert_eq!(
            check_pin(nonlocal, "localhost", 3210, true),
            Err(Error::invalid("egress_pin"))
        );
    }

    #[test]
    fn a_response_has_at_most_one_content_coding_header() {
        let mut headers = HeaderMap::new();
        headers.append("content-encoding", HeaderValue::from_static("identity"));
        assert_eq!(response_encoding(&headers).as_deref(), Ok("identity"));
        headers.append("content-encoding", HeaderValue::from_static("identity"));
        assert_eq!(
            response_encoding(&headers),
            Err(Error::invalid("content_encoding"))
        );
    }
}
