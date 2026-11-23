//! Pinned HTTP transport for media adapters. Secrets are scoped to the API origin.

use std::{
    io::{self, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::LazyLock,
    time::{Duration, Instant, SystemTime},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_providers::{pinned_http_agent, retry_after_date_ms};
use serde::Serialize;
use serde_json::Value;
use ureq::http::{HeaderValue, Request};
use url::{Host, Url};

use crate::{
    images::{self, Format},
    jobs::{Error, Result},
};

const MAX_JSON: usize = 1024 * 1024;
const MAX_ERROR: usize = 64 * 1024;
const MAX_IMAGE: usize = 64 * 1024 * 1024;
const MAX_VIDEO: usize = 512 * 1024 * 1024;
const MAX_DEADLINE: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Default)]
pub enum Auth {
    #[default]
    None,
    Bearer,
    Fal,
    Google,
}

#[derive(Clone, Copy)]
pub enum Method {
    Get,
    Post,
    Put,
}

impl Method {
    fn name(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
        }
    }

    fn retryable(self, status: u16) -> bool {
        status == 429 || (matches!(self, Self::Get) && matches!(status, 500 | 502 | 503 | 504))
    }
}

pub trait Ports {
    /// The host checks egress policy, resolves once, and supplies the sole address allowed to connect.
    fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr>;
    fn credential(&self, auth: Auth, deadline: Instant) -> Result<Option<String>>;
    /// A uniform sample in [0, 1), injected for deterministic retry fixtures.
    fn random(&self) -> f64;
    fn wait(&self, delay: Duration, deadline: Instant) -> Result<()>;
    fn cancelled(&self) -> bool {
        false
    }
    /// Return the local application installation state when the host is macOS.
    fn draw_things_installed_on_mac(&self) -> Option<bool> {
        None
    }
    fn wall_time(&self) -> SystemTime {
        SystemTime::now()
    }
}

#[derive(Clone, Copy)]
pub enum Cleartext {
    Loopback,
    PrivateLan,
}

#[derive(Clone, Copy)]
pub struct Retry {
    pub attempts: u8,
    pub base_ms: u64,
    pub max_ms: u64,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            attempts: 3,
            base_ms: 500,
            max_ms: 30000,
        }
    }
}

#[derive(Clone, Copy, Default)]
pub struct Options<'a> {
    pub auth: Auth,
    pub cleartext: Option<Cleartext>,
    pub download_hosts: &'a [&'a str],
    pub retry: Retry,
}

#[derive(Clone, Copy)]
pub struct Body<'a> {
    bytes: &'a [u8],
    content_type: &'a str,
}

impl<'a> Body<'a> {
    pub fn json(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            content_type: "application/json",
        }
    }

    pub fn multipart(bytes: &'a [u8], content_type: &'a str) -> Self {
        Self {
            bytes,
            content_type,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    AuthInvalid,
    AuthForbidden,
    #[serde(rename = "drawthings_api_off")]
    DrawThingsApiOff,
    #[serde(rename = "drawthings_not_installed")]
    DrawThingsNotInstalled,
    #[serde(rename = "coreml_unavailable_platform")]
    CoreMlUnavailablePlatform,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct Failure {
    pub code: Error,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
}

impl From<Error> for Failure {
    fn from(code: Error) -> Self {
        Self { code, reason: None }
    }
}

pub struct Image {
    pub bytes: Vec<u8>,
    pub format: Format,
}

pub struct Client<'a> {
    ports: &'a dyn Ports,
    base: Url,
    options: Options<'a>,
}

impl<'a> Client<'a> {
    pub(crate) fn probe_origin(&self, deadline: Instant) -> Result<()> {
        let endpoint = self
            .base
            .join("/")
            .map_err(|_| Error::UnsupportedParameter)?;
        let response = self.request(&endpoint, Method::Get, None, false, deadline)?;
        if response.status().is_redirection() {
            Err(Error::BackendUnavailable)
        } else {
            Ok(())
        }
    }

    pub(crate) fn local_installation(&self) -> Option<bool> {
        let local = match self.base.host() {
            Some(Host::Domain("localhost")) => true,
            Some(Host::Ipv4(address)) => address == Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(address)) => address.is_loopback(),
            _ => false,
        };
        local
            .then(|| self.ports.draw_things_installed_on_mac())
            .flatten()
    }

    pub(crate) fn check(&self, deadline: Instant) -> Result<()> {
        check(self.ports, deadline)
    }

    pub(crate) fn wall_time(&self) -> SystemTime {
        self.ports.wall_time()
    }

    pub(crate) fn close_remote(&self, method: Method, route: &str, budget: Duration) {
        struct Detached<'a>(&'a dyn Ports);
        impl Ports for Detached<'_> {
            fn pin(&self, endpoint: &Url, deadline: Instant) -> Option<SocketAddr> {
                self.0.pin(endpoint, deadline)
            }
            fn credential(&self, auth: Auth, deadline: Instant) -> Result<Option<String>> {
                self.0.credential(auth, deadline)
            }
            fn random(&self) -> f64 {
                self.0.random()
            }
            fn wait(&self, delay: Duration, deadline: Instant) -> Result<()> {
                self.0.wait(delay, deadline)
            }
        }
        let detached = Detached(self.ports);
        let mut options = self.options;
        options.retry.attempts = 1;
        let client = Client {
            ports: &detached,
            base: self.base.clone(),
            options,
        };
        let _ = client.json(
            method,
            route,
            Some(Body::json(b"{}")),
            Instant::now() + budget,
        );
    }

    pub fn new(ports: &'a dyn Ports, base: &str, options: Options<'a>) -> Result<Self> {
        let base = Url::parse(base).map_err(|_| Error::UnsupportedParameter)?;
        let retry = options.retry;
        if !web_url(&base)
            || base.query().is_some()
            || !(1..=10).contains(&retry.attempts)
            || retry.max_ms == 0
            || (base.scheme() == "http"
                && (options.cleartext.is_none() || !matches!(options.auth, Auth::None)))
        {
            return Err(Error::UnsupportedParameter);
        }
        Ok(Self {
            ports,
            base,
            options,
        })
    }

    pub fn origin(&self) -> String {
        self.base.origin().ascii_serialization()
    }

    pub fn endpoint(&self, relative: &str) -> Result<Url> {
        let url = Url::parse(&format!(
            "{}/{}",
            self.base.as_str().trim_end_matches('/'),
            relative.trim_start_matches('/')
        ))
        .map_err(|_| Error::UnsupportedParameter)?;
        if !web_url(&url) || url.origin() != self.base.origin() {
            return Err(Error::UnsupportedParameter);
        }
        Ok(url)
    }

    pub fn json(
        &self,
        method: Method,
        route: &str,
        body: Option<Body<'_>>,
        deadline: Instant,
    ) -> std::result::Result<Value, Failure> {
        let url = self.endpoint(route)?;
        let deadline = deadline.min(Instant::now() + MAX_DEADLINE);
        let retry = self.options.retry;
        for attempt in 0..retry.attempts {
            let response = self.request(&url, method, body, true, deadline)?;
            let status = response.status();
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let success = status.is_success();
            let reader = Binary::new(
                response,
                if success { MAX_JSON } else { MAX_ERROR },
                self.ports,
                deadline,
            )?;
            let data = reader.read_bytes()?;
            let parsed = serde_json::from_slice::<Value>(&data);
            if success {
                let parsed = parsed.map_err(|_| Error::InvalidResponse)?;
                let object = parsed.as_object().ok_or(Error::InvalidResponse)?;
                if !object.get("error").is_some_and(truthy) {
                    return Ok(parsed);
                }
                return Err(classify(status.as_u16(), &parsed));
            }
            if method.retryable(status.as_u16()) && attempt + 1 < retry.attempts {
                if let Some(wait) = delay(self.ports, retry, attempt, retry_after.as_deref()) {
                    self.ports.wait(wait, deadline)?;
                    check(self.ports, deadline)?;
                    continue;
                }
            }
            return Err(classify(
                status.as_u16(),
                parsed.as_ref().unwrap_or(&Value::Null),
            ));
        }
        Err(Error::BackendUnavailable.into())
    }

    pub fn wait(&self, delay: Duration, deadline: Instant) -> Result<()> {
        check(self.ports, deadline)?;
        self.ports.wait(delay, deadline)?;
        check(self.ports, deadline)
    }

    pub fn image(&self, value: &str, deadline: Instant) -> Result<Image> {
        let bytes = if let Some((_, data)) = value
            .strip_prefix("data:image/")
            .and_then(|data| data.split_once(";base64,"))
            .filter(|(mime, _)| matches!(*mime, "png" | "jpeg" | "webp"))
        {
            decode_base64(data)?
        } else if value.starts_with("http://") || value.starts_with("https://") {
            self.download(value, false, MAX_IMAGE, deadline)?
                .read_bytes()?
        } else {
            decode_base64(value)?
        };
        let format = images::verify(&bytes)?;
        Ok(Image { bytes, format })
    }

    pub fn stream(
        &self,
        value: &str,
        authenticated: bool,
        deadline: Instant,
    ) -> Result<Binary<'_>> {
        self.download(value, authenticated, MAX_VIDEO, deadline)
    }

    fn download(
        &self,
        value: &str,
        authenticated: bool,
        limit: usize,
        deadline: Instant,
    ) -> Result<Binary<'_>> {
        let url = Url::parse(value).map_err(|_| Error::InvalidResponse)?;
        if !web_url(&url) {
            return Err(Error::InvalidResponse);
        }
        self.check_download_url(&url, authenticated)?;
        let deadline = deadline.min(Instant::now() + MAX_DEADLINE);
        let response = self.request(&url, Method::Get, None, authenticated, deadline)?;
        if !response.status().is_success() {
            return Err(classify(response.status().as_u16(), &Value::Null).code);
        }
        Binary::new(response, limit, self.ports, deadline)
    }

    fn check_download_url(&self, url: &Url, authenticated: bool) -> Result<()> {
        if url.origin() != self.base.origin()
            && (authenticated
                || url.scheme() != "https"
                || !url
                    .host_str()
                    .is_some_and(|host| self.options.download_hosts.contains(&host)))
        {
            return Err(Error::BackendUnavailable);
        }
        Ok(())
    }

    fn check_download_pin(&self, url: &Url, ip: IpAddr, same_origin: bool) -> Result<()> {
        let local = private(ip);
        if (!same_origin && local) || (url.scheme() == "http" && !self.cleartext(ip)) {
            return Err(Error::BackendUnavailable);
        }
        Ok(())
    }

    fn request(
        &self,
        url: &Url,
        method: Method,
        body: Option<Body<'_>>,
        authenticated: bool,
        deadline: Instant,
    ) -> Result<ureq::http::Response<ureq::Body>> {
        check(self.ports, deadline)?;
        let pin = self
            .ports
            .pin(url, deadline)
            .ok_or(Error::BackendUnavailable)?;
        let literal = match url.host() {
            Some(Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
            _ => None,
        };
        if url.port_or_known_default() != Some(pin.port())
            || literal.is_some_and(|ip| ip != pin.ip())
        {
            return Err(Error::BackendUnavailable);
        }
        let same_origin = url.origin() == self.base.origin();
        let local = private(pin.ip());
        self.check_download_pin(url, pin.ip(), same_origin)?;
        let mut request = Request::builder()
            .method(method.name())
            .uri(url.as_str())
            .header("accept-encoding", "gzip");
        if authenticated && same_origin && !matches!(self.options.auth, Auth::None) {
            if local {
                return Err(Error::UnsupportedParameter);
            }
            if let Some(secret) = self.ports.credential(self.options.auth, deadline)? {
                let (key, value) = match self.options.auth {
                    Auth::Bearer => ("authorization", format!("Bearer {secret}")),
                    Auth::Fal => ("authorization", format!("Key {secret}")),
                    Auth::Google => ("x-goog-api-key", secret),
                    Auth::None => return Err(Error::UnsupportedParameter),
                };
                let mut header =
                    HeaderValue::from_str(&value).map_err(|_| Error::UnsupportedParameter)?;
                header.set_sensitive(true);
                request = request.header(key, header);
            }
        }
        check(self.ports, deadline)?;
        if let Some(body) = body {
            request = request.header("content-type", body.content_type);
        }
        let request = request
            .body(body.map_or(&[][..], |body| body.bytes))
            .map_err(|_| Error::UnsupportedParameter)?;
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .max_idle_connections(0)
            .max_response_header_size(MAX_ERROR)
            .timeout_global(Some(deadline.saturating_duration_since(Instant::now())))
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        let response = pinned_http_agent(config, pin, deadline).run(request);
        check(self.ports, deadline)?;
        response.map_err(|error| {
            if matches!(error, ureq::Error::Timeout(_)) {
                Error::Timeout
            } else {
                Error::BackendUnavailable
            }
        })
    }

    fn cleartext(&self, address: IpAddr) -> bool {
        match self.options.cleartext {
            Some(Cleartext::Loopback) => address.is_loopback(),
            Some(Cleartext::PrivateLan) => {
                address.is_loopback()
                    || match address {
                        IpAddr::V4(ip) => ip.is_private(),
                        IpAddr::V6(ip) => ip.is_unique_local(),
                    }
            }
            None => false,
        }
    }
}

fn web_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn private(ip: IpAddr) -> bool {
    fn v4(ip: Ipv4Addr) -> bool {
        let [a, b, ..] = ip.octets();
        ip.is_loopback()
            || ip.is_private()
            || ip.is_link_local()
            || ip.is_broadcast()
            || ip.is_multicast()
            || a == 0
            || (a == 100 && (64..=127).contains(&b))
    }
    match ip {
        IpAddr::V4(ip) => v4(ip),
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unicast_link_local()
                || ip.is_unique_local()
                || ip.is_multicast()
                || ip.to_ipv4().is_some_and(v4)
                || (ip.segments()[..6] == [0x64, 0xff9b, 0, 0, 0, 0]
                    && v4(Ipv4Addr::from(ip.to_bits() as u32)))
        }
    }
}

fn check(ports: &dyn Ports, deadline: Instant) -> Result<()> {
    if ports.cancelled() {
        Err(Error::Cancelled)
    } else if Instant::now() >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}

pub struct Binary<'a> {
    reader: Box<dyn Read + 'a>,
    ports: &'a dyn Ports,
    remaining: usize,
    deadline: Instant,
}

impl<'a> Binary<'a> {
    fn new(
        response: ureq::http::Response<ureq::Body>,
        limit: usize,
        ports: &'a dyn Ports,
        deadline: Instant,
    ) -> Result<Self> {
        let gzip = response
            .headers()
            .get("content-encoding")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|encoding| encoding.eq_ignore_ascii_case("gzip"));
        let body = response.into_body();
        check_content_length(body.content_length(), limit)?;
        let reader = body.into_reader();
        let reader: Box<dyn Read> = if gzip {
            Box::new(flate2::read::MultiGzDecoder::new(reader))
        } else {
            Box::new(reader)
        };
        Ok(Self {
            reader,
            ports,
            remaining: limit,
            deadline,
        })
    }

    pub fn read_bytes(mut self) -> Result<Vec<u8>> {
        let mut output = Vec::new();
        let outcome = self.read_to_end(&mut output);
        check(self.ports, self.deadline)?;
        outcome.map_err(|error| match error.kind() {
            io::ErrorKind::FileTooLarge => Error::TooLarge,
            io::ErrorKind::TimedOut => Error::Timeout,
            _ => Error::InvalidResponse,
        })?;
        Ok(output)
    }
}

impl Read for Binary<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        // At the inclusive boundary, probe one byte to distinguish EOF from overflow.
        let bounded = output.len().min(self.remaining.saturating_add(1));
        let check_io = || {
            check(self.ports, self.deadline).map_err(|error| {
                io::Error::from(if error == Error::Cancelled {
                    io::ErrorKind::ConnectionAborted
                } else {
                    io::ErrorKind::TimedOut
                })
            })
        };
        check_io()?;
        let read = self.reader.read(&mut output[..bounded]);
        check_io()?;
        let read = read?;
        if read > self.remaining {
            return Err(io::Error::from(io::ErrorKind::FileTooLarge));
        }
        self.remaining -= read;
        Ok(read)
    }
}

fn check_content_length(length: Option<u64>, limit: usize) -> Result<()> {
    if length.is_some_and(|size| size > limit as u64) {
        return Err(Error::TooLarge);
    }
    Ok(())
}

fn check_encoded_size(length: usize, limit: usize) -> Result<()> {
    if length > limit.div_ceil(3) * 4 {
        return Err(Error::TooLarge);
    }
    Ok(())
}

fn decode_base64(data: &str) -> Result<Vec<u8>> {
    check_encoded_size(data.len(), MAX_IMAGE)?;
    if data.is_empty() {
        return Err(Error::InvalidResponse);
    }
    let bytes = STANDARD
        .decode(data)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(data))
        .map_err(|_| Error::InvalidResponse)?;
    if bytes.len() > MAX_IMAGE {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}

fn delay(ports: &dyn Ports, retry: Retry, attempt: u8, after: Option<&str>) -> Option<Duration> {
    if let Some(after) = after.map(str::trim) {
        let number = after
            .split_once('.')
            .map_or_else(|| digits(after), |(a, b)| digits(a) && digits(b));
        let advertised = if number {
            after
                .parse::<f64>()
                .ok()
                .map(|seconds| (seconds * 1000.0).round() as u64)
        } else {
            retry_after_date_ms(after, ports.wall_time())
        };
        if let Some(ms) = advertised {
            return (ms <= retry.max_ms).then(|| Duration::from_millis(ms));
        }
    }
    let jitter = (ports.random().clamp(0.0, 1.0) * retry.base_ms as f64) as u64;
    let delay = retry
        .base_ms
        .saturating_mul(1 << attempt)
        .saturating_add(jitter)
        .min(retry.max_ms);
    Some(Duration::from_millis(delay))
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn classify(status: u16, json: &Value) -> Failure {
    static MODERATION: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
        regex::Regex::new("(?i)content.policy|safety|moderation|nsfw|blocked|responsible.ai").ok()
    });
    let moderated = MODERATION
        .as_ref()
        .is_some_and(|words| words.is_match(&json.to_string()));
    if status == 401 {
        return Failure {
            code: Error::BackendUnavailable,
            reason: Some(Reason::AuthInvalid),
        };
    }
    if moderated {
        return Error::ContentPolicy.into();
    }
    if status == 403 {
        return Failure {
            code: Error::BackendUnavailable,
            reason: Some(Reason::AuthForbidden),
        };
    }
    match status {
        402 | 429 => Error::Quota,
        413 => Error::TooLarge,
        400 | 422 => Error::UnsupportedParameter,
        _ => Error::BackendUnavailable,
    }
    .into()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}

#[cfg(test)]
mod policy_tests {
    use super::{
        check_content_length, check_encoded_size, Auth, Client, Duration, Error, Instant, IpAddr,
        Ipv4Addr, Options, Ports, Result, SocketAddr, Url,
    };

    struct Offline;
    impl Ports for Offline {
        fn pin(&self, _: &Url, _: Instant) -> Option<SocketAddr> {
            None
        }
        fn credential(&self, _: Auth, _: Instant) -> Result<Option<String>> {
            Ok(None)
        }
        fn random(&self) -> f64 {
            0.0
        }
        fn wait(&self, _: Duration, _: Instant) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn download_policy_checks_the_configured_host_and_private_addresses(
    ) -> std::result::Result<(), url::ParseError> {
        let base = Url::parse("https://api.example.invalid/")?;
        let allowed = Url::parse("https://cdn.example.invalid/image")?;
        let other = Url::parse("https://other.example.invalid/image")?;
        let client = Client {
            ports: &Offline,
            base,
            options: Options {
                download_hosts: &["cdn.example.invalid"],
                ..Options::default()
            },
        };
        assert_eq!(client.check_download_url(&allowed, false), Ok(()));
        assert_eq!(
            client.check_download_url(&other, false),
            Err(Error::BackendUnavailable)
        );
        assert_eq!(
            client.check_download_pin(&allowed, IpAddr::V4(Ipv4Addr::LOCALHOST), false),
            Err(Error::BackendUnavailable)
        );
        assert_eq!(
            client.check_download_pin(&client.base, IpAddr::V4(Ipv4Addr::LOCALHOST), true),
            Ok(())
        );
        Ok(())
    }

    #[test]
    fn encoded_data_and_declared_lengths_have_preflight_ceilings() {
        assert_eq!(check_content_length(Some(3), 3), Ok(()));
        assert_eq!(check_content_length(Some(4), 3), Err(Error::TooLarge));
        assert_eq!(check_encoded_size(4, 3), Ok(()));
        assert_eq!(check_encoded_size(5, 3), Err(Error::TooLarge));
    }
}
