use super::{prefix, present, Redactor};
use crate::{ErrorKind, Json, ProviderError, TimeoutPhase, Wire};
use regex::Regex;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use ureq::http::HeaderMap;

const DAY_MS: u64 = 86_400_000;
const CONTEXT_CODES: &[&str] = &["context_length_exceeded", "model_context_window_exceeded"];
const FILTER_CODES: &[&str] = &[
    "content_filter",
    "content_policy_violation",
    "responsibleaipolicyviolation",
];
static CONTEXT: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new("(?i)context (length|window)|maximum context|too many tokens|prompt is too long|reduce the length of the messages|exceeds the (model's )?(maximum )?(context|token)").ok()
});
static FILTER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new("(?i)content (management )?policy|content[ _-]filter").ok());
static ANTHROPIC_CONTEXT: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new("(?i)prompt is too long|input is too long|exceed(s|ed)? (the )?context (limit|window)|context (limit|window) exceeded|maximum context").ok()
});
static ANTHROPIC_BILLING: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new("(?i)credit balance is too low|purchase credits|billing").ok());
static RESPONSES_POLICY: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new("(?i)usage policy|content policy|flagged|violat").ok());
static GEMINI_KEY: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        "(?i)api key (not valid|expired|invalid)|invalid api key|api[_ ]key.*(expired|revoked)",
    )
    .ok()
});
static GEMINI_TOKENS: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new("(?i)input token count.*exceeds|token count.*exceeds the maximum|exceeds the maximum number of tokens|request payload size exceeds").ok()
});
static DURATION: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^(?:[0-9]+(?:\.[0-9]+)?(?:ms|h|m|s))+$").ok());
static DURATION_PART: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"([0-9]+(?:\.[0-9]+)?)(ms|h|m|s)").ok());
static GEMINI_DELAY: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[0-9]{1,9}(?:\.[0-9]{1,9})?s$").ok());

fn matches(re: &Option<Regex>, text: &str) -> bool {
    re.as_ref().is_some_and(|re| re.is_match(text))
}

fn data(value: &Json) -> &Json {
    value
        .get("error")
        .filter(|e| e.as_object().is_some() || e.string().is_some())
        .unwrap_or(value)
}

#[derive(Default)]
struct Fields {
    code: Option<String>,
    typ: Option<String>,
    message: Option<String>,
}

impl Fields {
    fn parse(value: &Json) -> Self {
        if let Some(message) = value.string() {
            return Self {
                message: Some(message.into()),
                ..Self::default()
            };
        }
        Self {
            code: value["code"]
                .string()
                .map(str::to_owned)
                .or_else(|| value["code"].number().map(plur1bus_canon::format_double)),
            typ: value["type"].string().map(str::to_owned),
            message: value["message"]
                .string()
                .or_else(|| value["detail"].string())
                .map(str::to_owned),
        }
    }

    fn sanitized(&self, redact: &Redactor<'_>) -> Self {
        let masked = |text: &Option<String>, limit| {
            text.as_deref().map(|s| prefix(&redact.redact(s), limit))
        };
        Self {
            code: masked(&self.code, 200),
            typ: masked(&self.typ, 200),
            message: masked(&self.message, 500),
        }
    }

    fn build(
        self,
        kind: ErrorKind,
        headline: &str,
        where_: &str,
        extra: Option<&str>,
    ) -> ProviderError {
        let trailing = self
            .message
            .as_deref()
            .filter(|s| !s.is_empty())
            .map_or_else(String::new, |s| format!(": {s}"));
        let location = extra
            .filter(|s| !s.is_empty())
            .map_or_else(|| where_.to_owned(), |s| format!("{where_} ({s})"));
        let mut error = ProviderError::new(kind, format!("{headline}{location}{trailing}"));
        error.code = self.code;
        error.provider_type = self.typ;
        error.provider_message = self.message;
        error
    }

    fn scoped(
        self,
        kind: ErrorKind,
        headline: &str,
        status: u16,
        expose_code: bool,
    ) -> ProviderError {
        let suffix = self
            .code
            .as_deref()
            .filter(|s| expose_code && !s.is_empty())
            .map_or_else(String::new, |s| format!(", {s}"));
        let mut error = self.build(kind, headline, &format!(" (HTTP {status}{suffix})"), None);
        error.status = Some(status);
        error
    }
}

fn millis(num: f64) -> u64 {
    num.round().clamp(0.0, DAY_MS as f64) as u64
}

fn after_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|h| h.to_str().ok())
        .map(str::trim)
}

fn integer(text: &str) -> Option<f64> {
    if text.is_empty() || !text.bytes().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn retry_after(headers: &HeaderMap, now: SystemTime) -> Option<u64> {
    if let Some(n) = after_header(headers, "retry-after-ms").and_then(integer) {
        return Some(millis(n));
    }
    let value = after_header(headers, "retry-after")?;
    if let Some(n) = integer(value) {
        return Some(millis(n * 1000.0));
    }
    let date = if value.ends_with(" GMT") && value.contains(", ") {
        if value.contains('-') {
            jiff::Timestamp::strptime(
                "%A, %d-%b-%y %H:%M:%S %z",
                value.strip_suffix(" GMT")?.to_owned() + " +0000",
            )
            .ok()
        } else {
            jiff::Timestamp::strptime(
                "%a, %d %b %Y %H:%M:%S %z",
                value.strip_suffix(" GMT")?.to_owned() + " +0000",
            )
            .ok()
        }
    } else {
        jiff::Timestamp::strptime("%a %b %e %H:%M:%S %Y %z", value.to_owned() + " +0000").ok()
    }?;
    let observed = now.duration_since(UNIX_EPOCH).map_or_else(
        |e| -(e.duration().as_millis() as i128),
        |d| d.as_millis() as i128,
    );
    Some((i128::from(date.as_millisecond()) - observed).clamp(0, i128::from(DAY_MS)) as u64)
}

fn reset_duration(value: &str) -> Option<u64> {
    if !matches(&DURATION, value) {
        return None;
    }
    let result = DURATION_PART
        .as_ref()?
        .captures_iter(value)
        .map(|part| {
            let n = part[1].parse::<f64>().unwrap_or_default();
            n * match &part[2] {
                "h" => 3_600_000.0,
                "m" => 60_000.0,
                "s" => 1000.0,
                _ => 1.0,
            }
        })
        .sum::<f64>();
    Some(millis(result))
}

fn responses_reset(headers: &HeaderMap) -> Option<u64> {
    let requests = after_header(headers, "x-ratelimit-reset-requests").and_then(reset_duration);
    let tokens = after_header(headers, "x-ratelimit-reset-tokens").and_then(reset_duration);
    if after_header(headers, "x-ratelimit-remaining-requests") == Some("0") && requests.is_some() {
        return requests;
    }
    if after_header(headers, "x-ratelimit-remaining-tokens") == Some("0") && tokens.is_some() {
        return tokens;
    }
    requests.into_iter().chain(tokens).min()
}

fn gemini_delay(details: &Json) -> Option<u64> {
    details.items().iter().find_map(|d| {
        let delay = d["retryDelay"].text();
        if !d["@type"].text().ends_with("google.rpc.RetryInfo") || !matches(&GEMINI_DELAY, delay) {
            return None;
        }
        let secs: f64 = delay.strip_suffix('s')?.parse().ok()?;
        Some(millis(secs * 1000.0))
    })
}

pub(crate) fn http_error(
    wire: Wire,
    status: u16,
    headers: &HeaderMap,
    bytes: &[u8],
    redact: &Redactor<'_>,
    now: SystemTime,
) -> ProviderError {
    let text = String::from_utf8_lossy(bytes);
    let parsed = Json::parse(&text).ok();
    let object = parsed.as_ref().map(data).unwrap_or(&Json::Null);
    let raw = if parsed.is_some() {
        Fields::parse(object)
    } else {
        Fields {
            message: (!text.trim().is_empty()).then(|| text.trim().to_owned()),
            ..Fields::default()
        }
    };
    let (code, typ) = (
        raw.code.as_deref().unwrap_or("").to_ascii_lowercase(),
        raw.typ.as_deref().unwrap_or("").to_ascii_lowercase(),
    );
    let text = raw.message.as_deref().unwrap_or("");
    let filtered =
        FILTER_CODES.contains(&code.as_str()) || typ == "content_filter" || matches(&FILTER, text);
    let (mut kind, mut title) = match status {
        401 | 403 => (ErrorKind::Auth, "authentication or permission failure"),
        402 => (ErrorKind::Auth, "payment or credit problem"),
        408 => (ErrorKind::Timeout, "the server timed out the request"),
        _ if status == 429 || code == "rate_limit_exceeded" => (
            ErrorKind::RateLimit,
            if code == "insufficient_quota" || typ == "insufficient_quota" {
                "quota exhausted"
            } else {
                "rate limited"
            },
        ),
        500..=599 => (
            ErrorKind::Overloaded,
            "provider could not serve the request",
        ),
        400..=499 if CONTEXT_CODES.contains(&code.as_str()) || matches(&CONTEXT, text) => {
            (ErrorKind::ContextLength, "context length exceeded")
        }
        400..=499 if filtered => (ErrorKind::InvalidRequest, "blocked by a content filter"),
        400..=499 => (ErrorKind::InvalidRequest, "request rejected"),
        _ => (ErrorKind::Unknown, "unexpected HTTP status"),
    };
    let mut fields = raw.sanitized(redact);
    let mut expose_code = true;
    let mut retry = retry_after(headers, now);
    let mut force_code = None;
    if wire == Wire::AnthropicMessages && kind == ErrorKind::InvalidRequest && !filtered {
        let safe = fields.message.as_deref().unwrap_or_default();
        if matches(&ANTHROPIC_BILLING, safe) {
            (kind, title, expose_code) = (ErrorKind::Auth, "payment or credit problem", false);
        } else if matches(&ANTHROPIC_CONTEXT, safe) {
            (kind, title, expose_code) =
                (ErrorKind::ContextLength, "context length exceeded", false);
        }
    }
    if wire == Wire::Gemini {
        let status_name = object["status"]
            .string()
            .map(|s| prefix(&redact.redact(s), 100));
        if fields.typ.is_none() {
            fields.typ = status_name.clone();
        }
        let reason_expired = object["details"]
            .items()
            .iter()
            .any(|v| v["reason"].text() == "API_KEY_INVALID");
        if matches!(status, 400 | 404) && (reason_expired || matches(&GEMINI_KEY, text)) {
            fields.typ = status_name;
            fields.code = Some("API_KEY_INVALID".into());
            (kind, title) = (ErrorKind::Auth, "API key rejected");
            force_code = Some("API_KEY_INVALID");
            retry = None;
        } else if status == 400 && matches(&GEMINI_TOKENS, text) {
            fields.typ = status_name;
            fields.code = None;
            (kind, title, expose_code) =
                (ErrorKind::ContextLength, "context length exceeded", false);
            retry = None;
        } else if after_header(headers, "retry-after").is_none()
            && after_header(headers, "retry-after-ms").is_none()
        {
            retry = retry.or_else(|| gemini_delay(&object["details"]));
        }
    }
    let usage_limit = wire == Wire::CodexResponses
        && (matches!(
            code.as_str(),
            "subscription_sharing_usage_limit_exceeded" | "usage_limit_reached"
        ) || typ == "usage_limit_reached");
    if wire == Wire::CodexResponses && kind == ErrorKind::RateLimit {
        retry = retry.or_else(|| responses_reset(headers)).or_else(|| {
            usage_limit
                .then(|| {
                    object["resets_in_seconds"]
                        .number()
                        .filter(|v| v.is_finite() && *v >= 0.0)
                        .map(|s| millis(s * 1000.0))
                })
                .flatten()
        });
    }
    let mut error = fields.scoped(kind, title, status, expose_code);
    if let Some(code) = force_code {
        error.code = Some(code.into());
    }
    if kind == ErrorKind::Unknown {
        error.code = Some("protocol".into());
    }
    error.retry_after_ms = retry;
    error.content_filtered = kind == ErrorKind::InvalidRequest
        && (filtered
            || (wire == Wire::CodexResponses
                && code == "invalid_prompt"
                && matches(&RESPONSES_POLICY, text)));
    if kind == ErrorKind::Timeout {
        error.timeout_phase = Some(TimeoutPhase::Headers);
    }
    if title == "quota exhausted" || usage_limit {
        error.retryable = false;
    }
    error
}

fn grpc_kind(status: &str, code: Option<u16>) -> ErrorKind {
    match status {
        "RESOURCE_EXHAUSTED" => ErrorKind::RateLimit,
        "UNAUTHENTICATED" | "PERMISSION_DENIED" => ErrorKind::Auth,
        "INVALID_ARGUMENT" | "FAILED_PRECONDITION" | "NOT_FOUND" => ErrorKind::InvalidRequest,
        "UNAVAILABLE" | "INTERNAL" | "DEADLINE_EXCEEDED" => ErrorKind::Overloaded,
        _ => match code {
            Some(429) => ErrorKind::RateLimit,
            Some(401 | 403) => ErrorKind::Auth,
            Some(500..) => ErrorKind::Overloaded,
            Some(400..) => ErrorKind::InvalidRequest,
            _ => ErrorKind::Unknown,
        },
    }
}

pub(super) fn vendor_error(
    wire: Wire,
    value: &Json,
    redact: &Redactor<'_>,
) -> Option<ProviderError> {
    if !(matches!(wire, Wire::AnthropicMessages | Wire::CodexResponses)
        && value["type"].text() == "error"
        || value.get("error").is_some_and(present))
    {
        return None;
    }
    let object = data(value);
    let mut raw = Fields::parse(object);
    if wire == Wire::Gemini {
        let code = object["code"]
            .number()
            .filter(|n| (0.0..=65535.0).contains(n))
            .map(|n| n as u16);
        let status = object["status"]
            .string()
            .map(|s| prefix(&redact.redact(s), 100));
        let kind = grpc_kind(status.as_deref().unwrap_or_default(), code);
        let label = match kind {
            ErrorKind::RateLimit => "rate limited",
            ErrorKind::Auth => "authentication failure",
            ErrorKind::InvalidRequest => "request rejected",
            ErrorKind::Overloaded => "provider could not serve the request",
            _ => "provider error",
        };
        raw.typ = None;
        raw.code = code.map(|v| v.to_string());
        let info = status
            .clone()
            .or_else(|| code.map(|v| v.to_string()))
            .unwrap_or_else(|| "error".into());
        let mut error = raw
            .sanitized(redact)
            .build(kind, label, " in stream", Some(&info));
        error.provider_type = status;
        error.status = code;
        error.retry_after_ms = gemini_delay(&object["details"]);
        return Some(error);
    }
    if wire == Wire::CodexResponses
        && std::ptr::eq(object, value)
        && raw.typ.as_deref() == Some("error")
    {
        raw.typ = None;
    }
    let (code, typ) = (
        raw.code.as_deref().unwrap_or("").to_ascii_lowercase(),
        raw.typ.as_deref().unwrap_or("").to_ascii_lowercase(),
    );
    let text = raw.message.as_deref().unwrap_or("");
    let fields = raw.sanitized(redact);
    if wire == Wire::AnthropicMessages {
        let kind = match typ.as_str() {
            "overloaded_error" | "api_error" => Some(ErrorKind::Overloaded),
            "rate_limit_error" => Some(ErrorKind::RateLimit),
            "authentication_error" | "permission_error" | "billing_error" => Some(ErrorKind::Auth),
            "invalid_request_error" | "not_found_error" | "request_too_large" => {
                Some(if matches(&ANTHROPIC_BILLING, text) {
                    ErrorKind::Auth
                } else if matches(&ANTHROPIC_CONTEXT, text) {
                    ErrorKind::ContextLength
                } else {
                    ErrorKind::InvalidRequest
                })
            }
            _ => None,
        };
        if let Some(kind) = kind {
            let label = fields.typ.clone();
            return Some(fields.build(kind, "provider error", " in stream", label.as_deref()));
        }
    }
    let mut filtered = false;
    let (kind, title) = if wire == Wire::CodexResponses
        && (code == "insufficient_quota" || typ == "insufficient_quota")
    {
        (ErrorKind::RateLimit, "quota exhausted")
    } else if wire == Wire::CodexResponses
        && (code == "usage_limit_reached" || typ == "usage_limit_reached")
    {
        (ErrorKind::RateLimit, "plan usage limit reached")
    } else if code.contains("rate_limit") || typ.contains("rate_limit") {
        (ErrorKind::RateLimit, "rate limited")
    } else if CONTEXT_CODES.contains(&code.as_str()) || matches(&CONTEXT, text) {
        (ErrorKind::ContextLength, "context length exceeded")
    } else if FILTER_CODES.contains(&code.as_str()) || typ == "content_filter" {
        filtered = true;
        (ErrorKind::InvalidRequest, "blocked by a content filter")
    } else if code.contains("auth") || typ.contains("auth") || code == "invalid_api_key" {
        (ErrorKind::Auth, "authentication failure")
    } else if matches!(typ.as_str(), "server_error" | "overloaded_error")
        || code == "server_error"
        || code.contains("overload")
    {
        (
            ErrorKind::Overloaded,
            "provider could not serve the request",
        )
    } else if wire == Wire::CodexResponses && code == "invalid_prompt" {
        filtered = matches(&RESPONSES_POLICY, text);
        (ErrorKind::InvalidRequest, "prompt refused")
    } else if wire == Wire::CodexResponses
        && (code.starts_with("invalid_")
            || code.starts_with("unsupported_")
            || code == "model_not_found"
            || typ == "invalid_request_error")
    {
        (ErrorKind::InvalidRequest, "request rejected")
    } else {
        (ErrorKind::Unknown, "provider error")
    };
    let label = fields.code.clone();
    let mut error = fields.build(kind, title, " in stream", label.as_deref());
    error.content_filtered = filtered;
    if matches!(title, "quota exhausted" | "plan usage limit reached") {
        error.retryable = false;
    }
    Some(error)
}
