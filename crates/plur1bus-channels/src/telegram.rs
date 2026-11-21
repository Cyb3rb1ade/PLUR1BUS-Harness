//! Telegram Bot API requests and bounded file downloads.
use crate::http::{self, Attachment, Error, Failure, Http, Kind};
use indexmap::IndexMap;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use serde::Serialize;
use serde_json::{value::RawValue, Value};
use std::sync::LazyLock;
use std::time::Duration;
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const API_LIMIT: usize = 8 * 1024 * 1024;
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// Endpoints whose request bodies are determined by the calling channel.
#[derive(Clone, Copy)]
pub enum Method {
    GetMe,
    GetFile,
    SetWebhook,
    DeleteWebhook,
    SetMyCommands,
    AnswerCallbackQuery,
    SendPhoto,
    SendDocument,
    SendVoice,
    SendAudio,
    SendVideo,
}

impl Method {
    fn path(self) -> &'static str {
        match self {
            Self::GetMe => "getMe",
            Self::GetFile => "getFile",
            Self::SetWebhook => "setWebhook",
            Self::DeleteWebhook => "deleteWebhook",
            Self::SetMyCommands => "setMyCommands",
            Self::AnswerCallbackQuery => "answerCallbackQuery",
            Self::SendPhoto => "sendPhoto",
            Self::SendDocument => "sendDocument",
            Self::SendVoice => "sendVoice",
            Self::SendAudio => "sendAudio",
            Self::SendVideo => "sendVideo",
        }
    }
}

pub struct Telegram<'a> {
    http: Http<'a>,
    base: Url,
    token: &'a str,
    secrets: Vec<String>,
}

impl<'a> Telegram<'a> {
    pub fn new(http: Http<'a>, base: Url, token: &'a str, extra: &[&str]) -> Result<Self, Error> {
        if token.is_empty()
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-:".contains(&b))
        {
            return Err(Error::new(Kind::Protocol, "invalid Telegram credential"));
        }
        let mut secrets = Vec::new();
        for secret in std::iter::once(token)
            .chain(extra.iter().copied())
            .filter(|s| !s.is_empty())
        {
            for value in std::iter::once(secret)
                .chain(secret.split_once(':').map(|(_, tail)| tail))
                .filter(|s| !s.is_empty())
            {
                let encoded = utf8_percent_encode(value, COMPONENT).to_string();
                secrets.extend([value.to_owned(), lowercase_hex(&encoded), encoded]);
            }
        }
        secrets.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        secrets.dedup();
        Ok(Self {
            http,
            base,
            token,
            secrets,
        })
    }

    pub fn get_updates(&self, offset: Option<u64>, timeout: u64) -> Result<Value, Error> {
        #[derive(Serialize)]
        struct Poll {
            timeout: u64,
            allowed_updates: [&'static str; 2],
            #[serde(skip_serializing_if = "Option::is_none")]
            offset: Option<u64>,
        }
        let bytes = serde_json::to_vec(&Poll {
            timeout,
            allowed_updates: ["message", "callback_query"],
            offset,
        })
        .map_err(|_| Error::new(Kind::Protocol, "invalid Telegram poll parameters"))?;
        self.call_bytes(
            "getUpdates",
            "application/json",
            &bytes,
            Duration::from_secs(timeout.saturating_add(15)),
        )
    }

    /// Extra Telegram fields in the order supplied by the caller.
    pub fn send_message(&self, chat_id: &str, text: &str, extra: &RawValue) -> Result<i64, Error> {
        let mut fields: IndexMap<String, Box<RawValue>> = serde_json::from_str(extra.get())
            .map_err(|_| Error::new(Kind::Protocol, "invalid Telegram message fields"))?;
        for (key, value) in [("chat_id", chat_id), ("text", text)] {
            let value = serde_json::value::to_raw_value(value)
                .map_err(|_| Error::new(Kind::Protocol, "invalid Telegram message fields"))?;
            fields.insert(key.to_owned(), value);
        }
        let bytes = serde_json::to_vec(&fields)
            .map_err(|_| Error::new(Kind::Protocol, "invalid Telegram message fields"))?;
        let result = self.call_bytes("sendMessage", "application/json", &bytes, REQUEST_TIMEOUT)?;
        result["message_id"]
            .as_i64()
            .ok_or_else(|| Error::new(Kind::Protocol, "sendMessage result lacks message_id"))
    }

    pub fn call(&self, method: Method, json: &RawValue) -> Result<Value, Error> {
        self.call_bytes(
            method.path(),
            "application/json",
            json.get().as_bytes(),
            REQUEST_TIMEOUT,
        )
    }

    /// Send a prepared multipart body, including the caller's generated boundary.
    pub fn upload(&self, method: Method, content_type: &str, form: &[u8]) -> Result<Value, Error> {
        if !matches!(
            method,
            Method::SendPhoto
                | Method::SendDocument
                | Method::SendVoice
                | Method::SendAudio
                | Method::SendVideo
        ) || !content_type.starts_with("multipart/form-data; boundary=")
        {
            return Err(Error::new(Kind::Protocol, "invalid Telegram upload"));
        }
        self.call_bytes(method.path(), content_type, form, REQUEST_TIMEOUT)
    }

    pub fn download(&self, path: &str, limit: usize) -> Result<Attachment, Error> {
        let fail = || Error::new(Kind::Network, "Telegram file download failed");
        if !safe_file_path(path) {
            return Err(Error::new(Kind::Protocol, "unsafe Telegram file path"));
        }
        let url = http::endpoint(&self.base, &format!("/file/bot{}/{path}", self.token))?;
        let mut response = self
            .http
            .request("GET", &url, &[], &[], REQUEST_TIMEOUT)
            .map_err(|_| fail())?;
        if http::follow_forbidden(response.status()) {
            return Err(fail());
        }
        if !response.status().is_success() || matches!(response.status().as_u16(), 204 | 205) {
            return Err(Error::new(Kind::Protocol, "Telegram file download failed"));
        }
        let data = self.http.body(&mut response, limit).map_err(|e| {
            if e == Failure::TooLarge {
                Error::new(Kind::Protocol, "Telegram file exceeds size limit")
            } else {
                fail()
            }
        })?;
        Ok(Attachment {
            data,
            mime_type: http::mime_type(response.headers()),
        })
    }

    fn call_bytes(
        &self,
        method: &str,
        content_type: &str,
        body: &[u8],
        timeout: Duration,
    ) -> Result<Value, Error> {
        let url = http::endpoint(&self.base, &format!("/bot{}/{method}", self.token))?;
        let transport_error = |reason| match reason {
            Failure::Aborted => Error::new(Kind::Aborted, format!("{method} aborted")),
            Failure::TimedOut => Error::new(Kind::Timeout, format!("{method} timed out")),
            Failure::TooLarge => Error::new(
                Kind::Protocol,
                format!("{method} response exceeds size limit"),
            ),
            _ => Error::new(Kind::Network, format!("{method} network error")),
        };
        let mut response = self
            .http
            .request(
                "POST",
                &url,
                &[("content-type", content_type)],
                body,
                timeout,
            )
            .map_err(transport_error)?;
        if http::follow_forbidden(response.status()) {
            return Err(transport_error(Failure::Network));
        }
        let status = response.status().as_u16();
        let body = self
            .http
            .body(&mut response, API_LIMIT)
            .map_err(transport_error)?;
        let payload: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if response.status().is_success() && payload["ok"] == true {
            return Ok(payload.get("result").cloned().unwrap_or(Value::Null));
        }
        if status == 429 {
            let seconds = http::number(&payload["parameters"]["retry_after"]).or_else(|| {
                http::header(response.headers(), "retry-after").and_then(|s| s.trim().parse().ok())
            });
            let mut error =
                Error::new(Kind::RateLimited, format!("{method} rate limited")).status(status);
            error.retry_after_ms = Some(http::rounded_retry_ms(seconds));
            return Err(error);
        }
        let kind = match status {
            400 => Kind::BadRequest,
            403 => Kind::Forbidden,
            401 | 404 => Kind::Unauthorized,
            409 => Kind::Conflict,
            _ => Kind::Http,
        };
        let mut message = format!("{method} failed with HTTP {status}");
        if let Some(description) = payload["description"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            let detail = self.redact(description);
            message.push_str(": ");
            message.push_str(&detail);
        }
        Err(Error::new(kind, message).status(status))
    }

    fn redact(&self, value: &str) -> String {
        static BOT_URL: LazyLock<Option<Regex>> =
            LazyLock::new(|| Regex::new(r#"/bot[^/\s"']+/"#).ok());
        static TOKEN_SHAPE: LazyLock<Option<Regex>> =
            LazyLock::new(|| Regex::new(r"\b[0-9]{5,}:[A-Za-z0-9_-]{20,}").ok());
        let mut value = value.to_owned();
        for secret in &self.secrets {
            value = value.replace(secret, "[redacted]");
        }
        if let Some(regex) = &*BOT_URL {
            value = regex.replace_all(&value, "/bot[redacted]/").into_owned();
        }
        if let Some(regex) = &*TOKEN_SHAPE {
            value = regex.replace_all(&value, "[redacted]").into_owned();
        }
        http::truncate_utf16(&mut value, 200);
        value
    }
}

fn safe_file_path(path: &str) -> bool {
    let Some((root, rest)) = path.split_once('/') else {
        return false;
    };
    let simple = |b: u8| b.is_ascii_alphanumeric() || b"_-".contains(&b);
    !root.is_empty()
        && root.bytes().all(simple)
        && rest.split('/').all(|part| {
            !matches!(part, "" | "." | "..") && part.bytes().all(|b| simple(b) || b == b'.')
        })
}

fn lowercase_hex(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut escaped = 0;
    for ch in value.chars() {
        match ch {
            '%' => {
                escaped = 2;
                output.push('%');
            }
            _ if escaped > 0 => {
                escaped -= 1;
                output.push(ch.to_ascii_lowercase());
            }
            _ => output.push(ch),
        }
    }
    output
}
