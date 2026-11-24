//! Provider list protocols and strict page admission. Only the host transport
//! connects to the pinned origin or the managed Unix service and supplies keys.

use std::{
    borrow::Cow,
    collections::{BTreeMap, HashSet},
    str::FromStr,
    time::{Duration, Instant},
};

use chrono::{DateTime, NaiveDate};
use serde::Serialize;
use serde_json::Value;

use crate::reconcile::{Api, Capability, Kind, RawEntry, Reasoning, ReasoningStyle};

const MAX_PAGES: usize = 10;
const MAX_ENTRIES: usize = 5_000;
const MAX_STRING: usize = 512;
const SCAN_BUDGET: Duration = Duration::from_secs(60);
const PAGE_BUDGET: Duration = Duration::from_secs(15);
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SCAN_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Error {
    pub result: &'static str,
    pub reason: Cow<'static, str>,
    #[serde(rename = "httpStatus", skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(rename = "retryAfterMs", skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl Error {
    pub(crate) const fn invalid(reason: &'static str) -> Self {
        Self {
            result: "failed:invalid",
            reason: Cow::Borrowed(reason),
            http_status: None,
            retry_after_ms: None,
        }
    }
    pub fn http_status(status: u16) -> Self {
        let (result, reason) = match status {
            401 | 403 => ("failed:auth", Cow::Borrowed("renew_sign_in")),
            429 => ("failed:server", Cow::Borrowed("rate_limited")),
            500.. => ("failed:server", Cow::Owned(format!("http_{status}"))),
            _ => ("failed:invalid", Cow::Owned(format!("http_{status}"))),
        };
        Self {
            result,
            reason,
            http_status: Some(status),
            retry_after_ms: None,
        }
    }
    pub const fn network(reason: &'static str) -> Self {
        Self {
            result: "failed:network",
            reason: Cow::Borrowed(reason),
            http_status: None,
            retry_after_ms: None,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scanner {
    OpenAi,
    Anthropic,
    Google,
    Ollama,
}

impl FromStr for Scanner {
    type Err = Error;

    fn from_str(kind: &str) -> Result<Self> {
        match kind {
            "openai-models" => Ok(Self::OpenAi),
            "anthropic-models" => Ok(Self::Anthropic),
            "google-models" => Ok(Self::Google),
            "ollama-tags" => Ok(Self::Ollama),
            _ => Err(Error::invalid("scanner")),
        }
    }
}

#[derive(Serialize)]
pub struct Page<'a> {
    pub path: &'static str,
    #[serde(
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "serialize_query"
    )]
    pub query: Vec<(&'static str, &'a str)>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<&'static str, &'static str>,
    #[serde(skip)]
    pub max_bytes: usize,
    #[serde(skip)]
    pub deadline: Instant,
}

fn serialize_query<S: serde::Serializer>(
    query: &[(&str, &str)],
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    serializer.collect_map(query.iter().copied())
}

/// Execute one GET using the trusted configuration's approved origin or Unix
/// endpoint. The host encodes query values, reruns pinning on redirect, caps
/// decoded bytes while reading and keeps the lease headers on the approved
/// origin. Both socket work and decoding share Page::deadline.
pub trait Port {
    fn get(&mut self, page: Page<'_>) -> Result<Vec<u8>>;

    /// A transport may observe the scan's cancellation between reads.
    fn get_with_cancel(&mut self, page: Page<'_>, cancelled: &dyn Fn() -> bool) -> Result<Vec<u8>> {
        if cancelled() {
            return Err(Error::network("aborted"));
        }
        self.get(page)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub entries: Vec<RawEntry>,
    pub duplicates: usize,
    pub pages: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filtered_by_policy: Option<usize>,
}

const ENVELOPE: Error = Error::invalid("bad_envelope");
const ENTRY: Error = Error::invalid("invalid_entry");

fn checked_string(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|text| text.len() <= MAX_STRING && !text.chars().any(char::is_control))
        .ok_or(ENTRY)
}

fn optional_string(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        checked_string(value).map(|value| Some(value.into()))
    }
}

fn positive(value: &Value) -> Result<Option<u64>> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(n) = value
        .as_f64()
        .filter(|n| *n > 0. && *n < 9_007_199_254_740_992. && n.fract() == 0.)
    else {
        return Err(ENTRY);
    };
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "exact positive JavaScript integer checked above"
    )]
    Ok(Some(n as u64))
}

fn model_id(id: &Value) -> Result<String> {
    admit_id(id.as_str().ok_or(ENTRY)?)
}

fn admit_id(id: &str) -> Result<String> {
    if id.len() > 256
        || !id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/@+-".contains(&byte))
    {
        return Err(ENTRY);
    }
    Ok(id.into())
}

fn advertises(values: &[Value], key: &str) -> bool {
    values.iter().any(|value| value == key)
}

fn time_ms(value: &Value) -> Result<Option<i64>> {
    let Some(time) = optional_string(value)? else {
        return Ok(None);
    };
    let parsed = DateTime::parse_from_rfc3339(&time)
        .or_else(|_| DateTime::parse_from_rfc2822(&time))
        .map(|value| value.timestamp_millis())
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(&time, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis())
        });
    Ok(parsed.filter(|&value| value > 0))
}

fn entry(scanner: Scanner, item: &Value, apple: bool) -> Result<RawEntry> {
    if !item.is_object() {
        return Err(ENVELOPE);
    }
    let mut api = Api::default();
    let (id, created) = match scanner {
        Scanner::OpenAi => {
            let id = model_id(&item["id"])?;
            let created = positive(&item["created"])?.and_then(|n| i64::try_from(n * 1000).ok());
            api.display_name = optional_string(&item["name"])?;
            api.context_window = positive(&item["context_length"])?;
            let mut caps = Vec::new();
            if let Some(params) = item["supported_parameters"].as_array() {
                let supported = advertises(params, "reasoning");
                api.reasoning = Some(Reasoning {
                    supported,
                    style: ReasoningStyle::Openrouter,
                });
                for (flag, capability) in [
                    ("tools", Capability::Tools),
                    ("structured_outputs", Capability::StructuredOutput),
                    ("reasoning", Capability::Reasoning),
                ] {
                    if advertises(params, flag) {
                        caps.push(capability);
                    }
                }
            }
            if item["architecture"]["modality"]
                .as_str()
                .and_then(|text| text.split("->").next())
                .is_some_and(|side| side.contains("image"))
            {
                caps.push(Capability::Vision);
            }
            if !caps.is_empty() {
                api.capabilities = Some(caps);
            }
            if apple {
                api = Api {
                    context_window: Some(4096),
                    capabilities: Some(vec![Capability::Tools, Capability::StructuredOutput]),
                    ..Api::default()
                };
            }
            (id, created)
        }
        Scanner::Anthropic => {
            api.display_name = optional_string(&item["display_name"])?;
            api.context_window = positive(&item["max_input_tokens"])?;
            (model_id(&item["id"])?, time_ms(&item["created_at"])?)
        }
        Scanner::Google => {
            let name = checked_string(&item["name"])?;
            let id = admit_id(name.strip_prefix("models/").unwrap_or(name))?;
            api.display_name = optional_string(&item["displayName"])?;
            api.context_window = positive(&item["inputTokenLimit"])?;
            if item["supportedGenerationMethods"]
                .as_array()
                .is_some_and(|values| {
                    advertises(values, "embedContent") && !advertises(values, "generateContent")
                })
            {
                api.kind = Some(Kind::Embedding);
            }
            api.reasoning = item["thinking"].as_bool().map(|supported| Reasoning {
                supported,
                style: ReasoningStyle::Gemini,
            });
            (id, None)
        }
        Scanner::Ollama => {
            let id = model_id(&item["name"])?;
            optional_string(&item["details"]["family"])?;
            optional_string(&item["details"]["parameter_size"])?;
            api.reasoning = item["capabilities"].as_array().map(|values| Reasoning {
                supported: advertises(values, "thinking"),
                style: ReasoningStyle::Ollama,
            });
            (id, time_ms(&item["modified_at"])?)
        }
    };
    Ok(RawEntry { id, created, api })
}

fn make_page(
    scanner: Scanner,
    cursor: Option<&str>,
    max_bytes: usize,
    deadline: Instant,
) -> Page<'_> {
    let (path, first, more) = match scanner {
        Scanner::OpenAi => ("/models", None, None),
        Scanner::Anthropic => ("/models", Some("limit"), Some("after_id")),
        Scanner::Google => ("/models", Some("pageSize"), Some("pageToken")),
        Scanner::Ollama => ("/api/tags", None, None),
    };
    Page {
        path,
        query: first
            .map(|key| (key, "1000"))
            .into_iter()
            .chain(more.zip(cursor))
            .collect(),
        headers: (scanner == Scanner::Anthropic)
            .then_some(("anthropic-version", "2023-06-01"))
            .into_iter()
            .collect(),
        max_bytes,
        deadline,
    }
}

fn cursor(scanner: Scanner, body: &Value) -> Result<Option<&str>> {
    match scanner {
        Scanner::Anthropic if body["has_more"] == true => {
            if body["last_id"].as_str().is_none_or(str::is_empty) {
                return Err(ENVELOPE);
            }
            checked_string(&body["last_id"]).map(Some)
        }
        Scanner::Anthropic if !body["has_more"].is_boolean() => Err(ENVELOPE),
        Scanner::Google
            if body["nextPageToken"]
                .as_str()
                .is_some_and(|s| !s.is_empty()) =>
        {
            checked_string(&body["nextPageToken"]).map(Some)
        }
        _ => Ok(None),
    }
}

fn running(deadline: Instant, cancelled: &dyn Fn() -> bool) -> Result<()> {
    if cancelled() {
        Err(Error::network("aborted"))
    } else if Instant::now() >= deadline {
        Err(Error::network("scan_timeout"))
    } else {
        Ok(())
    }
}

fn scan_deadline(deadline: Instant, now: Instant) -> Instant {
    deadline.min(now + SCAN_BUDGET)
}

fn page_bytes(total_bytes: usize) -> usize {
    MAX_PAGE_BYTES.min(MAX_SCAN_BYTES - total_bytes)
}

pub fn scan(
    scanner: Scanner,
    apple: bool,
    port: &mut dyn Port,
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<Output> {
    let deadline = scan_deadline(deadline, Instant::now());
    let mut after = None::<String>;
    let mut pages = 0;
    let mut total_bytes = 0;
    let mut filtered = 0;
    let mut entries = Vec::new();
    loop {
        running(deadline, cancelled)?;
        if pages == MAX_PAGES {
            return Err(Error::invalid("too_many_pages"));
        }
        let max_bytes = page_bytes(total_bytes);
        let page = make_page(
            scanner,
            after.as_deref(),
            max_bytes,
            deadline.min(Instant::now() + PAGE_BUDGET),
        );
        let bytes = port.get_with_cancel(page, cancelled)?;
        running(deadline, cancelled)?;
        if bytes.len() > max_bytes {
            return Err(Error::invalid("body_too_large"));
        }
        total_bytes += bytes.len();
        pages += 1;
        let body: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes))
            .map_err(|_| Error::invalid("invalid_json"))?;
        let field = if matches!(scanner, Scanner::Google | Scanner::Ollama) {
            "models"
        } else {
            "data"
        };
        let notified = cursor(scanner, &body)?;
        for raw in body[field].as_array().ok_or(ENVELOPE)? {
            if scanner == Scanner::OpenAi && apple && raw["id"] != "system" {
                filtered += 1;
                continue;
            }
            if entries.len() == MAX_ENTRIES {
                return Err(Error::invalid("too_many_entries"));
            }
            entries.push(entry(scanner, raw, apple)?);
        }
        let Some(next) = notified else { break };
        if after.as_deref() == Some(next) {
            return Err(ENVELOPE);
        }
        after = Some(next.into());
    }
    let total = entries.len();
    let mut seen = HashSet::new();
    entries.retain(|entry| seen.insert(entry.id.clone()));
    Ok(Output {
        duplicates: total - entries.len(),
        entries,
        pages,
        filtered_by_policy: (filtered > 0).then_some(filtered),
    })
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn scan_deadline_is_capped_at_sixty_seconds() {
        let now = Instant::now();
        let own = now + Duration::from_secs(5);
        let longer = now + Duration::from_secs(100);
        assert_eq!(scan_deadline(own, now), own);
        assert_eq!(scan_deadline(longer, now), now + Duration::from_secs(60));
    }

    #[test]
    fn page_allocation_can_never_exceed_the_remaining_scan_budget() {
        assert_eq!(page_bytes(0), MAX_PAGE_BYTES);
        assert_eq!(page_bytes(MAX_SCAN_BYTES - 2), 2);
        assert_eq!(page_bytes(MAX_SCAN_BYTES), 0);
    }
}
