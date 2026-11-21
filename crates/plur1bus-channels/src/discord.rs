//! Discord REST and rate-limit state. A caller serializes access to each bot's client.
use crate::http::{self, Attachment, Error, Failure, Http, Kind};
use regex::Regex;
use serde_json::{value::RawValue, Value};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use ureq::http::HeaderMap;
use url::Url;

const TIMEOUT: Duration = Duration::from_secs(30);
const API_LIMIT: usize = 8 * 1024 * 1024;
const ERROR_LIMIT: usize = 64 * 1024;
pub const CDN_HOSTS: &[&str] = &["cdn.discordapp.com", "media.discordapp.net"];

pub trait Clock {
    fn now_ms(&self) -> u64;
    fn random(&self) -> f64;
    /// Sleep for the requested interval or return false on cancellation.
    fn wait(&self, duration: Duration) -> bool;
}

pub struct Request<'a> {
    method: &'a str,
    path: &'a str,
    body: &'a [u8],
    content_type: Option<&'a str>,
    pub token_route: bool,
}

impl<'a> Request<'a> {
    pub fn new(method: &'a str, path: &'a str) -> Self {
        Self {
            method,
            path,
            body: &[],
            content_type: None,
            token_route: false,
        }
    }

    pub fn json(&mut self, json: &'a RawValue) {
        self.body = json.get().as_bytes();
        self.content_type = Some("application/json");
    }

    pub fn multipart(&mut self, content_type: &'a str, body: &'a [u8]) -> Result<(), Error> {
        if !content_type.starts_with("multipart/form-data; boundary=") {
            return Err(Error::new(Kind::Protocol, "invalid Discord upload"));
        }
        self.content_type = Some(content_type);
        self.body = body;
        Ok(())
    }
}

#[derive(Default)]
struct Limiter {
    states: HashMap<String, Bucket>,
    keys: HashMap<String, String>,
    global_until: u64,
    window_start: u64,
    window_count: u32,
}

struct Bucket {
    remaining: f64,
    reset_at: u64,
}

impl Limiter {
    fn reserve(&mut self, route: &str, use_global: bool, now: u64) -> u64 {
        if now.saturating_sub(self.window_start) >= 1000 {
            self.window_start = now;
            self.window_count = 0;
        }
        let mut wait = 0;
        if use_global {
            wait = self.global_until.saturating_sub(now);
            if self.window_count >= 45 {
                wait = wait.max(self.window_start.saturating_add(1000).saturating_sub(now));
            }
        }
        let key = self.keys.get(route).map(String::as_str).unwrap_or(route);
        if let Some(bucket) = self.states.get_mut(key) {
            if bucket.reset_at <= now {
                self.states.remove(key);
            } else if bucket.remaining <= 0. {
                wait = wait.max(bucket.reset_at - now);
            } else if wait == 0 {
                bucket.remaining -= 1.;
            }
        }
        if wait == 0 && use_global {
            self.window_count += 1;
        }
        wait
    }

    fn update(&mut self, route: &str, headers: &HeaderMap, now: u64) {
        let numeric = |name| {
            http::header(headers, name)
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|n| n.is_finite())
        };
        let Some(remaining) = numeric("x-ratelimit-remaining") else {
            return;
        };
        let reset = numeric("x-ratelimit-reset-after").unwrap_or(0.);
        let key = if let Some(bucket) = http::header(headers, "x-ratelimit-bucket") {
            let major = route
                .split('/')
                .collect::<Vec<_>>()
                .windows(2)
                .find_map(|pair| {
                    (matches!(pair[0], "channels" | "guilds" | "webhooks") && digits(pair[1]))
                        .then_some(pair[1])
                })
                .unwrap_or_default();
            let key = format!("{bucket}|{major}");
            self.keys.insert(route.to_owned(), key.clone());
            key
        } else {
            route.to_owned()
        };
        self.states.insert(
            key,
            Bucket {
                remaining,
                reset_at: now.saturating_add((reset.clamp(0., 300.) * 1000.).ceil() as u64),
            },
        );
    }

    fn penalize(&mut self, route: &str, ms: u64, global: bool, now: u64) {
        let reset_at = now.saturating_add(ms);
        if global {
            self.global_until = self.global_until.max(reset_at);
        } else {
            let key = self.keys.get(route).map(String::as_str).unwrap_or(route);
            self.states.insert(
                key.to_owned(),
                Bucket {
                    remaining: 0.,
                    reset_at,
                },
            );
        }
    }
}

pub struct Discord<'a> {
    http: Http<'a>,
    base: Url,
    token: &'a str,
    clock: &'a dyn Clock,
    retries: u8,
    limiter: Limiter,
}

impl<'a> Discord<'a> {
    pub fn new(
        http: Http<'a>,
        base: Url,
        token: &'a str,
        clock: &'a dyn Clock,
        retries: u8,
    ) -> Self {
        Self {
            http,
            base,
            token,
            clock,
            retries,
            limiter: Limiter::default(),
        }
    }

    pub fn request(&mut self, request: &Request<'_>) -> Result<Value, Error> {
        let route = route_key(request.method, request.path);
        if !matches!(request.method, "GET" | "POST" | "PATCH" | "PUT" | "DELETE")
            || !request.path.starts_with('/')
            || request.path.starts_with("//")
            || request
                .path
                .bytes()
                .any(|b| b.is_ascii_control() || b == b'\\' || b == b'#')
        {
            return Err(Error::new(Kind::Protocol, "invalid Discord request"));
        }
        let endpoint = http::endpoint(&self.base, request.path)?;
        let authorization = format!("Bot {}", self.token);
        let mut headers = Vec::with_capacity(2);
        if !request.token_route {
            headers.push(("authorization", authorization.as_str()));
        }
        if let Some(content_type) = request.content_type {
            headers.push(("content-type", content_type));
        }

        let secrets = [self.token, token_in_path(request.path).unwrap_or_default()];
        let mut attempt = 0;
        loop {
            self.reserve(&route, !request.token_route)?;
            let mut response =
                match self
                    .http
                    .request(request.method, &endpoint, &headers, request.body, TIMEOUT)
                {
                    Ok(response) => response,
                    Err(Failure::Aborted) => return Err(aborted()),
                    Err(reason) if attempt >= self.retries || reason == Failure::Denied => {
                        return Err(rest_transport(reason))
                    }
                    Err(_) => {
                        self.backoff(attempt)?;
                        attempt += 1;
                        continue;
                    }
                };
            self.limiter
                .update(&route, response.headers(), self.clock.now_ms());
            let status = response.status().as_u16();
            if response.status().is_success() {
                if status == 204 {
                    return Ok(Value::Null);
                }
                let body = self
                    .http
                    .body(&mut response, API_LIMIT)
                    .map_err(rest_transport)?;
                return if body.is_empty() {
                    Ok(Value::Null)
                } else {
                    serde_json::from_slice(&body).map_err(|_| {
                        Error::new(Kind::Protocol, "discord returned invalid json").status(status)
                    })
                };
            }
            let body = match self.http.body(&mut response, ERROR_LIMIT) {
                Ok(body) => serde_json::from_slice::<Value>(&body).unwrap_or_default(),
                Err(Failure::Aborted) => return Err(aborted()),
                Err(_) => Value::Null,
            };
            if status == 429 {
                let raw = if body["retry_after"].is_null() {
                    http::header(response.headers(), "retry-after")
                        .and_then(|value| value.parse().ok())
                } else {
                    http::number(&body["retry_after"])
                };
                let wait = retry_ms(raw);
                let global = body["global"] == true
                    || http::header(response.headers(), "x-ratelimit-global") == Some("true");
                self.limiter
                    .penalize(&route, wait, global, self.clock.now_ms());
                if attempt >= self.retries {
                    let mut error =
                        Error::new(Kind::RateLimited, "discord rate limit").status(status);
                    error.retry_after_ms = Some(wait);
                    return Err(error);
                }
                self.wait(wait)?;
            } else if matches!(status, 502..=504) && attempt < self.retries {
                self.backoff(attempt)?;
            } else {
                return Err(rest_error(status, &body, &secrets));
            }
            attempt += 1;
        }
    }

    pub fn download(
        &self,
        raw: &str,
        extra_hosts: &[&str],
        limit: usize,
    ) -> Result<Attachment, Error> {
        let endpoint =
            Url::parse(raw).map_err(|_| Error::new(Kind::Protocol, "invalid attachment url"))?;
        if endpoint.scheme() != "https"
            || endpoint.port().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || !endpoint
                .host_str()
                .is_some_and(|host| CDN_HOSTS.contains(&host) || extra_hosts.contains(&host))
        {
            return Err(Error::new(Kind::Protocol, "attachment host is not allowed"));
        }
        let mut response = self
            .http
            .request("GET", &endpoint, &[], &[], TIMEOUT)
            .map_err(download_error)?;
        if !response.status().is_success() {
            return Err(Error::new(Kind::Http, "attachment download failed")
                .status(response.status().as_u16()));
        }
        if matches!(response.status().as_u16(), 204 | 205) {
            return Err(Error::new(Kind::Protocol, "attachment has no body"));
        }
        let data = self
            .http
            .body(&mut response, limit)
            .map_err(download_error)?;
        Ok(Attachment {
            data,
            mime_type: http::mime_type(response.headers()),
        })
    }

    fn reserve(&mut self, route: &str, global: bool) -> Result<(), Error> {
        loop {
            if self.http.cancelled() {
                return Err(aborted());
            }
            let wait = self.limiter.reserve(route, global, self.clock.now_ms());
            if wait == 0 {
                return Ok(());
            }
            self.wait(wait)?;
        }
    }

    fn backoff(&self, attempt: u8) -> Result<(), Error> {
        let jitter = 0.75 + self.clock.random().clamp(0., 1.) * 0.5;
        let delay = (1_000u64 << attempt.min(6)).min(60_000);
        self.wait((delay as f64 * jitter).round() as u64)
    }

    fn wait(&self, ms: u64) -> Result<(), Error> {
        if self.http.cancelled() || !self.clock.wait(Duration::from_millis(ms)) {
            return Err(aborted());
        }
        Ok(())
    }
}

fn aborted() -> Error {
    Error::new(Kind::Aborted, "discord request aborted")
}

fn rest_transport(error: Failure) -> Error {
    match error {
        Failure::Aborted => aborted(),
        Failure::TimedOut => Error::new(Kind::Timeout, "discord request timed out"),
        Failure::TooLarge => Error::new(Kind::Protocol, "discord response exceeds size limit"),
        _ => Error::new(Kind::Network, "discord network failure"),
    }
}

fn download_error(error: Failure) -> Error {
    match error {
        Failure::Aborted => Error::new(Kind::Aborted, "attachment download failed"),
        Failure::TooLarge => Error::new(Kind::Protocol, "attachment exceeds size limit"),
        _ => Error::new(Kind::Network, "attachment download failed"),
    }
}

fn rest_error(status: u16, body: &Value, secrets: &[&str]) -> Error {
    let (kind, label) = match status {
        401 => (Kind::Unauthorized, "unauthorized"),
        403 => (Kind::Forbidden, "forbidden"),
        404 => (Kind::NotFound, "not-found"),
        400 => (Kind::BadRequest, "bad-request"),
        _ => (Kind::Http, "http"),
    };
    let mut message = format!("discord {label} ({status})");
    if let Some(detail) = body["message"].as_str().filter(|s| !s.is_empty()) {
        message.push_str(": ");
        message.push_str(&redact(detail, secrets));
    }
    let mut error = Error::new(kind, message).status(status);
    error.code = body.get("code").filter(|code| code.is_number()).cloned();
    error
}

fn redact(raw: &str, secrets: &[&str]) -> String {
    static SHAPE: LazyLock<Option<Regex>> = LazyLock::new(|| {
        Regex::new(r#"(?:/interactions/[0-9]+/|/webhooks/[0-9]+/|\bBot\s+)([^/\s"']+)"#).ok()
    });
    static TOKEN: LazyLock<Option<Regex>> = LazyLock::new(|| {
        Regex::new(r"[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}").ok()
    });
    let mut value = raw.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        value = value.replace(secret, "[redacted]");
    }
    if let Some(regex) = &*SHAPE {
        value = regex
            .replace_all(&value, |captures: &regex::Captures<'_>| {
                let prefix = captures[0].len() - captures[1].len();
                format!("{}[redacted]", &captures[0][..prefix])
            })
            .into_owned();
    }
    if let Some(regex) = &*TOKEN {
        value = regex.replace_all(&value, "[redacted]").into_owned();
    }
    http::truncate_utf16(&mut value, 200);
    value
}

fn retry_ms(seconds: Option<f64>) -> u64 {
    (seconds.filter(|s| s.is_finite()).unwrap_or_default() * 1000.)
        .ceil()
        .clamp(1000., 300_000.) as u64
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

fn token_in_path(path: &str) -> Option<&str> {
    let mut segments = path
        .split('?')
        .next()?
        .split('/')
        .filter(|part| !part.is_empty());
    let root = segments.next()?;
    matches!(root, "interactions" | "webhooks")
        .then(|| segments.nth(1))
        .flatten()
}

pub fn route_key(method: &str, path: &str) -> String {
    let segments: Vec<_> = path
        .split('?')
        .next()
        .unwrap_or_default()
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let mut route = method.to_ascii_uppercase();
    route.push(' ');
    if segments.is_empty() {
        route.push('/');
    }
    let first = segments.first().copied().unwrap_or_default();
    for (index, part) in segments.iter().enumerate() {
        let previous = index
            .checked_sub(1)
            .and_then(|idx| segments.get(idx))
            .copied();
        let major = previous
            .is_some_and(|s| matches!(s, "channels" | "guilds") || (s == "webhooks" && index == 1));
        route.push('/');
        route.push_str(
            if index == 2 && matches!(first, "interactions" | "webhooks") {
                ":token"
            } else if (index == 1 && first == "interactions") || (digits(part) && !major) {
                ":id"
            } else {
                part
            },
        );
    }
    route
}

pub mod gateway;
