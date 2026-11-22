//! Slack Web API and file transfer endpoints.
use crate::http::{self, Attachment, Error, Failure, Http, Kind};
use indexmap::IndexMap;
use serde_json::{value::RawValue, Value};
use std::time::Duration;
use ureq::http::HeaderMap;
use url::Url;

const TIMEOUT: Duration = Duration::from_secs(30);
const API_LIMIT: usize = 8 * 1024 * 1024;
const FILE_HOST: &str = "files.slack.com";

#[derive(Clone, Copy)]
pub enum Token {
    Bot,
    App,
}

pub struct Slack<'a> {
    http: Http<'a>,
    base: Url,
    bot: &'a str,
    app: &'a str,
}

impl<'a> Slack<'a> {
    pub fn new(http: Http<'a>, base: Url, bot: &'a str, app: &'a str) -> Self {
        Self {
            http,
            base,
            bot,
            app,
        }
    }

    pub fn call(
        &self,
        method: &str,
        body: &RawValue,
        token: Token,
        form: bool,
    ) -> Result<Value, Error> {
        if !method
            .split('.')
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        {
            return Err(Error::new(Kind::Protocol, "invalid Slack method"));
        }
        let endpoint = http::endpoint(&self.base, &format!("/{method}"))?;
        let authorization = format!(
            "Bearer {}",
            match token {
                Token::Bot => self.bot,
                Token::App => self.app,
            }
        );
        let form_bytes;
        let (content_type, data) = if form {
            let fields: IndexMap<String, Box<RawValue>> = serde_json::from_str(body.get())
                .map_err(|_| Error::new(Kind::Protocol, "invalid Slack form parameters"))?;
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for (key, field) in &fields {
                let decoded = serde_json::from_str::<String>(field.get());
                serializer.append_pair(key, decoded.as_deref().unwrap_or(field.get()));
            }
            form_bytes = serializer.finish();
            ("application/x-www-form-urlencoded", form_bytes.as_bytes())
        } else {
            ("application/json; charset=utf-8", body.get().as_bytes())
        };
        let headers = [
            ("authorization", authorization.as_str()),
            ("content-type", content_type),
        ];
        let mut response = self
            .http
            .request("POST", &endpoint, &headers, data, TIMEOUT)
            .map_err(|e| api_transport(method, e))?;
        if http::follow_forbidden(response.status()) {
            return Err(api_transport(method, Failure::Network));
        }
        let status = response.status().as_u16();
        let body = self
            .http
            .body(&mut response, API_LIMIT)
            .map_err(|e| api_transport(method, e))?;
        let payload: Value = serde_json::from_slice(&body).unwrap_or_default();
        let code = payload["error"].as_str();
        if status == 429 || matches!(code, Some("ratelimited" | "rate_limited")) {
            return Err(rate_limited(
                format!("{method} rate limited"),
                status,
                response.headers(),
            ));
        }
        if response.status().is_success() && payload["ok"] == true {
            return Ok(payload);
        }
        Err(api_status(method, status, &payload))
    }

    pub fn open_socket_url(&self) -> Result<String, Error> {
        let empty = serde_json::from_str::<&RawValue>("{}")
            .map_err(|_| Error::new(Kind::Protocol, "invalid Slack form parameters"))?;
        let result = self.call("apps.connections.open", empty, Token::App, true)?;
        result["url"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::new(Kind::Protocol, "apps.connections.open returned no url"))
    }

    pub fn download(&self, raw: &str, limit: usize) -> Result<Attachment, Error> {
        let mut target = self.file_url(raw, "file")?;
        let authorization = format!("Bearer {}", self.bot);
        let fail = || Error::new(Kind::Network, "Slack file download failed");
        for _ in 0..4 {
            let mut response = self
                .http
                .request(
                    "GET",
                    &target,
                    &[("authorization", &authorization)],
                    &[],
                    TIMEOUT,
                )
                .map_err(|_| fail())?;
            let status = response.status().as_u16();
            if response.status().is_redirection() {
                let location = http::header(response.headers(), "location")
                    .ok_or_else(|| Error::new(Kind::Protocol, "Slack file download failed"))?;
                let next = target.join(location).map_err(|_| fail())?;
                target = self.file_url(next.as_str(), "file")?;
                continue;
            }
            if status == 429 {
                return Err(rate_limited(
                    "Slack file download rate limited",
                    429,
                    response.headers(),
                ));
            }
            if response.status().is_server_error() {
                return Err(Error::new(
                    Kind::Http,
                    format!("Slack file download failed with HTTP {status}"),
                )
                .status(status));
            }
            if !response.status().is_success() || matches!(status, 204 | 205) {
                return Err(Error::new(Kind::Protocol, "Slack file download failed"));
            }
            let mime_type = http::mime_type(response.headers());
            if mime_type == "text/html" {
                return Err(Error::new(
                    Kind::Protocol,
                    "Slack file download returned a web page",
                ));
            }
            let data = self.http.body(&mut response, limit).map_err(|e| {
                if e == Failure::TooLarge {
                    Error::new(Kind::Protocol, "Slack file exceeds size limit")
                } else {
                    fail()
                }
            })?;
            return Ok(Attachment { data, mime_type });
        }
        Err(Error::new(
            Kind::Protocol,
            "Slack file download redirected too often",
        ))
    }

    pub fn upload_bytes(&self, raw: &str, bytes: &[u8]) -> Result<(), Error> {
        let target = self.file_url(raw, "upload")?;
        let failure = |reason| {
            if reason == Failure::Aborted {
                Error::new(Kind::Aborted, "file upload aborted")
            } else {
                Error::new(Kind::Network, "file upload network error")
            }
        };
        let response = self
            .http
            .request(
                "POST",
                &target,
                &[("content-type", "application/octet-stream")],
                bytes,
                Duration::from_secs(60),
            )
            .map_err(failure)?;
        let status = response.status().as_u16();
        if http::follow_forbidden(response.status()) {
            return Err(failure(Failure::Network));
        }
        if status == 429 {
            return Err(rate_limited(
                "file upload rate limited",
                status,
                response.headers(),
            ));
        }
        if response.status().is_success() {
            Ok(())
        } else {
            let kind = if response.status().is_server_error() {
                Kind::Http
            } else {
                Kind::BadRequest
            };
            Err(Error::new(kind, format!("file upload failed with HTTP {status}")).status(status))
        }
    }

    fn file_url(&self, raw: &str, purpose: &str) -> Result<Url, Error> {
        let refuse = || Error::new(Kind::Protocol, format!("unsafe Slack {purpose} URL"));
        let url = Url::parse(raw).map_err(|_| refuse())?;
        let slack =
            url.scheme() == "https" && url.host_str() == Some(FILE_HOST) && url.port().is_none();
        let custom = url.scheme() == self.base.scheme()
            && url.host() == self.base.host()
            && url.port() == self.base.port();
        if !(slack || custom)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(refuse());
        }
        Ok(url)
    }
}

fn api_transport(method: &str, error: Failure) -> Error {
    let (kind, detail) = match error {
        Failure::Aborted => (Kind::Aborted, "aborted"),
        Failure::TimedOut => (Kind::Timeout, "timed out"),
        Failure::TooLarge => (Kind::Protocol, "response exceeds size limit"),
        _ => (Kind::Network, "network error"),
    };
    Error::new(kind, format!("{method} {detail}"))
}

fn rate_limited(message: impl Into<String>, status: u16, headers: &HeaderMap) -> Error {
    let seconds = http::header(headers, "retry-after").and_then(|value| value.trim().parse().ok());
    let mut error = Error::new(Kind::RateLimited, message).status(status);
    error.retry_after_ms = Some(http::rounded_retry_ms(seconds));
    error
}

fn api_status(method: &str, status: u16, payload: &Value) -> Error {
    let code = payload["error"].as_str().filter(|s| {
        (1..=64).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    });
    let code_value = code.unwrap_or_default();
    let suffix = code.map(|code| format!(": {code}")).unwrap_or_default();
    let unauthorized = matches!(
        code_value,
        "invalid_auth"
            | "not_authed"
            | "account_inactive"
            | "token_revoked"
            | "token_expired"
            | "invalid_token"
    );
    let forbidden = matches!(
        code_value,
        "missing_scope"
            | "not_in_channel"
            | "channel_not_found"
            | "is_archived"
            | "user_not_in_channel"
            | "no_permission"
            | "restricted_action"
            | "access_denied"
            | "cannot_dm_bot"
            | "user_disabled"
            | "not_allowed_token_type"
    );
    let transient = matches!(
        code_value,
        "internal_error"
            | "service_unavailable"
            | "fatal_error"
            | "request_timeout"
            | "team_added_to_org"
    );
    let (kind, message) = if status == 401 || unauthorized {
        (Kind::Unauthorized, format!("{method} unauthorized{suffix}"))
    } else if status == 403 || forbidden {
        (Kind::Forbidden, format!("{method} forbidden{suffix}"))
    } else if status >= 500 || transient {
        (
            Kind::Http,
            format!("{method} failed with HTTP {status}{suffix}"),
        )
    } else if (200..300).contains(&status)
        && (payload.is_null()
            || *payload == false
            || payload.as_f64() == Some(0.)
            || payload.as_str() == Some(""))
    {
        (
            Kind::Protocol,
            format!("{method} returned a non-JSON response"),
        )
    } else {
        (Kind::BadRequest, format!("{method} failed{suffix}"))
    };
    let mut error = Error::new(kind, message).status(status);
    error.code = code.map(|code| Value::String(code.to_owned()));
    error
}

pub mod socket;
