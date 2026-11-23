//! Keyed search providers and SearXNG over the shared pinned transport.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use chrono::DateTime;
use serde::Serialize;
use serde_json::{json, Value};
use ureq::http::{header, HeaderMap, Method};
use url::{Origin, Url};

use super::{failure, wall_clock, Freshness, Provider, Query, RawResult, Result};
use plur1bus_log_schema::redact::{secret_forms_of, SecretMatcher};

use crate::{
    fetch::Error,
    http::{self, Admission, Coding, Failure, Options, Redirects, Response},
    pacer::Clock,
};

const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Vendor {
    Brave,
    Tavily,
    Exa,
    Searxng,
}

impl Vendor {
    pub fn id(self) -> &'static str {
        match self {
            Self::Brave => "brave",
            Self::Tavily => "tavily",
            Self::Exa => "exa",
            Self::Searxng => "searxng",
        }
    }

    pub fn default_endpoint(self) -> Option<&'static str> {
        match self {
            Self::Brave => Some("https://api.search.brave.com/res/v1/web/search"),
            Self::Tavily => Some("https://api.tavily.com/search"),
            Self::Exa => Some("https://api.exa.ai/search"),
            Self::Searxng => None,
        }
    }
}

pub struct Credential {
    pub origin: Origin,
    pub value: String,
}

pub trait Credentials {
    fn lease(&self, vendor: Vendor) -> Result<Option<Credential>>;
}

#[derive(Default)]
struct Slots {
    next: u64,
    blocked_until: u64,
}

pub struct RateLimit {
    spacing_ms: u64,
    slots: Mutex<Slots>,
}

impl RateLimit {
    pub fn new(spacing_ms: u64) -> Self {
        Self {
            spacing_ms,
            slots: Mutex::default(),
        }
    }

    fn reserve(&self, now: u64, maximum: u64) -> Result<u64> {
        let mut slots = self.slots.lock().map_err(|_| failure("internal-error"))?;
        let cooling = slots.blocked_until.saturating_sub(now);
        if cooling > 0 {
            return Err(rate_limited(None, cooling.div_ceil(1000)));
        }
        let delay = slots.next.saturating_sub(now);
        if delay > maximum {
            return Err(rate_limited(None, 1));
        }
        slots.next = now.saturating_add(delay).saturating_add(self.spacing_ms);
        Ok(delay)
    }

    fn cool(&self, now: u64, seconds: u64) -> Result<()> {
        let mut slots = self.slots.lock().map_err(|_| failure("internal-error"))?;
        slots.blocked_until = slots
            .blocked_until
            .max(now.saturating_add(seconds.saturating_mul(1000)));
        Ok(())
    }
}

pub struct Configured<'a> {
    pub vendor: Vendor,
    pub endpoint: &'a Url,
    pub admission: &'a dyn Admission,
    pub credentials: Option<&'a dyn Credentials>,
    pub clock: &'a dyn Clock,
    pub limiter: &'a RateLimit,
    pub user_agent: &'a str,
    pub max_inline_wait_ms: u64,
    pub default_cooldown_seconds: u64,
    pub outcome: Option<&'a dyn Fn(Option<Error>)>,
}

impl Provider for Configured<'_> {
    fn id(&self) -> &str {
        self.vendor.id()
    }

    fn search(
        &self,
        query: &Query,
        deadline: Instant,
        aborted: &dyn Fn() -> bool,
    ) -> Result<Vec<RawResult>> {
        let result = self.run(query, deadline, aborted);
        if let Some(outcome) = self.outcome {
            outcome(result.as_ref().err().copied());
        }
        result
    }
}

struct Call {
    url: Url,
    method: Method,
    headers: HeaderMap,
    body: Option<String>,
}

impl Configured<'_> {
    fn credential(&self) -> Result<Option<Credential>> {
        if self.vendor != Vendor::Searxng {
            let lease = self
                .credentials
                .ok_or_else(|| failure("no-provider"))?
                .lease(self.vendor)?
                .filter(|lease| !lease.value.is_empty())
                .ok_or_else(|| failure("no-provider"))?;
            if lease.origin != self.endpoint.origin() {
                return Err(failure("egress-denied"));
            }
            Ok(Some(lease))
        } else {
            Ok(None)
        }
    }

    fn run(
        &self,
        query: &Query,
        deadline: Instant,
        aborted: &dyn Fn() -> bool,
    ) -> Result<Vec<RawResult>> {
        let keyed = self.vendor != Vendor::Searxng;
        let secret = self.credential()?;
        let key = secret.as_ref().map(|lease| lease.value.as_str());
        let mut reply = self.once(query, key, deadline, aborted)?;
        if keyed && reply.status == 429 {
            let first_hint = retry_after(&reply.headers, self.clock.now_ms());
            if let Some(seconds) =
                first_hint.filter(|seconds| seconds.saturating_mul(1000) <= self.max_inline_wait_ms)
            {
                self.wait(seconds * 1000, deadline, aborted)?;
                reply = self.once(query, key, deadline, aborted)?;
            }
            if reply.status == 429 {
                let seconds = retry_after(&reply.headers, self.clock.now_ms())
                    .or(first_hint)
                    .unwrap_or(self.default_cooldown_seconds);
                self.limiter.cool(self.clock.now_ms(), seconds)?;
                return Err(rate_limited(Some(429), seconds));
            }
        }
        if !(200..300).contains(&reply.status) {
            let code = if reply.status == 429 || (keyed && matches!(reply.status, 402 | 432 | 433))
            {
                if keyed {
                    self.limiter.cool(
                        self.clock.now_ms(),
                        retry_after(&reply.headers, self.clock.now_ms()).unwrap_or(300),
                    )?;
                }
                "rate-limited"
            } else {
                "http-error"
            };
            return Err(Error {
                status: Some(reply.status),
                ..failure(code)
            });
        }
        let parsed =
            serde_json::from_slice::<Value>(&reply.body).map_err(|_| failure("http-error"))?;
        let mut results = parse(self.vendor, &parsed).ok_or_else(|| failure("http-error"))?;
        if let Some(key) = key {
            let forms = secret_forms_of(key);
            let matcher = SecretMatcher::from_strs(forms.iter().map(String::as_str));
            results.retain(|result| matcher.find_text_spans(&result.url).is_empty());
            for result in &mut results {
                result.title = matcher.mask_text(&result.title);
                if let Some(snippet) = &mut result.snippet {
                    *snippet = matcher.mask_text(snippet);
                }
                if result
                    .published_at
                    .as_ref()
                    .is_some_and(|date| !matcher.find_text_spans(date).is_empty())
                {
                    result.published_at = None;
                }
            }
        }
        Ok(results)
    }

    fn once(
        &self,
        query: &Query,
        key: Option<&str>,
        deadline: Instant,
        aborted: &dyn Fn() -> bool,
    ) -> Result<Response> {
        if self.vendor != Vendor::Searxng {
            let delay = self
                .limiter
                .reserve(self.clock.now_ms(), self.max_inline_wait_ms)?;
            self.wait(delay, deadline, aborted)?;
        }
        let call = self.build(query, key)?;
        let options = self.request_options(&call, deadline);
        http::request(call.url.as_str(), &options, self.admission, aborted).map_err(|error| {
            match error {
                Failure::UnsupportedType => failure("http-error"),
                _ => error.into(),
            }
        })
    }

    fn request_options<'a>(&'a self, call: &'a Call, deadline: Instant) -> Options<'a> {
        let mut options =
            Options::get(&call.headers, self.user_agent, "application/json", deadline);
        options.method = call.method.clone();
        options.body = call.body.as_deref().map(str::as_bytes);
        options.redirects = Redirects::Manual;
        options.coding = Coding::Identity;
        options.max_bytes = MAX_RESPONSE;
        options.accept_type =
            Some(&|header| header.is_some_and(|mime| mime.to_ascii_lowercase().contains("json")));
        options
    }

    fn wait(&self, ms: u64, deadline: Instant, aborted: &dyn Fn() -> bool) -> Result<()> {
        let cancelled = || aborted() || Instant::now() >= deadline;
        if cancelled()
            || Duration::from_millis(ms) >= deadline.saturating_duration_since(Instant::now())
        {
            return Err(failure("timeout"));
        }
        if ms != 0 {
            self.clock
                .sleep_ms(ms, &cancelled)
                .map_err(|_| failure("timeout"))?;
        }
        if cancelled() {
            Err(failure("timeout"))
        } else {
            Ok(())
        }
    }

    fn build(&self, query: &Query, key: Option<&str>) -> Result<Call> {
        let mut url = self.endpoint.clone();
        let mut headers = HeaderMap::new();
        let mut method = Method::GET;
        let key = key.unwrap_or("");
        let scoped = query.site.as_ref().map_or_else(
            || query.query.to_owned(),
            |site| format!("{} site:{site}", query.query),
        );
        let freshness = query.freshness.map(Freshness::name);
        let body = match self.vendor {
            Vendor::Brave => {
                insert(&mut headers, "x-subscription-token", key)?;
                set(&mut url, "q", &scoped);
                set(&mut url, "count", &query.count.min(20).to_string());
                set(&mut url, "result_filter", "web");
                if let Some(period) = query.freshness {
                    let letter = match period {
                        Freshness::Day => "pd",
                        Freshness::Week => "pw",
                        Freshness::Month => "pm",
                        Freshness::Year => "py",
                    };
                    set(&mut url, "freshness", letter);
                }
                if let Some(lang) = &query.lang {
                    set(
                        &mut url,
                        "search_lang",
                        &lang.split('-').next().unwrap_or("").to_ascii_lowercase(),
                    );
                }
                None
            }
            Vendor::Tavily => {
                method = Method::POST;
                insert(&mut headers, "authorization", &format!("Bearer {key}"))?;
                Some(body(&Tavily {
                    query: &query.query,
                    max_results: query.count.min(20),
                    search_depth: "basic",
                    topic: "general",
                    include_answer: false,
                    include_raw_content: false,
                    include_images: false,
                    time_range: freshness,
                    include_domains: query.site.as_deref().map(|site| [site]),
                })?)
            }
            Vendor::Exa => {
                method = Method::POST;
                insert(&mut headers, "x-api-key", key)?;
                let date = query
                    .freshness
                    .map(|period| {
                        let days = match period {
                            Freshness::Day => 1,
                            Freshness::Week => 7,
                            Freshness::Month => 30,
                            Freshness::Year => 365,
                        };
                        wall_clock(self.clock.now_ms().saturating_sub(days * 86_400_000))
                    })
                    .transpose()?;
                Some(body(&Exa {
                    query: &query.query,
                    num_results: query.count.min(20),
                    kind: "auto",
                    contents: json!({"text":{"maxCharacters":600}}),
                    include_domains: query.site.as_deref().map(|site| [site]),
                    start_published_date: date,
                })?)
            }
            Vendor::Searxng => {
                url.set_path(&format!("{}/search", url.path().trim_end_matches('/')));
                url.set_query(None);
                let mut params = url.query_pairs_mut();
                params
                    .append_pair("q", &scoped)
                    .append_pair("format", "json")
                    .append_pair("pageno", "1");
                if let Some(lang) = &query.lang {
                    params.append_pair("language", lang);
                }
                if let Some(period) = freshness {
                    params.append_pair(
                        "time_range",
                        if period == "week" { "month" } else { period },
                    );
                }
                None
            }
        };
        if body.is_some() {
            headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/json"),
            );
        }
        Ok(Call {
            url,
            method,
            headers,
            body,
        })
    }
}

fn set(url: &mut Url, name: &str, value: &str) {
    let mut inserted = false;
    let mut out = url
        .query_pairs()
        .filter_map(|(key, item)| {
            if key != name {
                Some((key.into_owned(), item.into_owned()))
            } else if std::mem::replace(&mut inserted, true) {
                None
            } else {
                Some((name.to_owned(), value.to_owned()))
            }
        })
        .collect::<Vec<_>>();
    if !inserted {
        out.push((name.to_owned(), value.to_owned()));
    }
    url.query_pairs_mut().clear().extend_pairs(out);
}

fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) -> Result<()> {
    let mut header = value
        .parse::<header::HeaderValue>()
        .map_err(|_| failure("invalid-url"))?;
    header.set_sensitive(true);
    headers.insert(name, header);
    Ok(())
}

fn body(input: &impl Serialize) -> Result<String> {
    serde_json::to_string(input).map_err(|_| failure("internal-error"))
}

#[derive(Serialize)]
struct Tavily<'a> {
    query: &'a str,
    max_results: usize,
    search_depth: &'static str,
    topic: &'static str,
    include_answer: bool,
    include_raw_content: bool,
    include_images: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_range: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_domains: Option<[&'a str; 1]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Exa<'a> {
    query: &'a str,
    num_results: usize,
    #[serde(rename = "type")]
    kind: &'static str,
    contents: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_domains: Option<[&'a str; 1]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_published_date: Option<String>,
}

fn rate_limited(status: Option<u16>, seconds: u64) -> Error {
    Error {
        code: "rate-limited",
        status,
        retry_after_seconds: Some(seconds),
    }
}

fn retry_after(headers: &HeaderMap, now_ms: u64) -> Option<u64> {
    let first = |name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
    };
    let seconds = |value: &str| {
        (value.len() <= 9 && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse::<u64>().ok())
            .flatten()
    };
    if let Some(value) = first("retry-after") {
        if let Some(seconds) = seconds(value) {
            return Some(seconds.min(3600));
        }
        if let Ok(date) = DateTime::parse_from_rfc2822(value) {
            let now = i64::try_from(now_ms).ok()?;
            return Some(
                (date.timestamp_millis().saturating_sub(now).max(0) as u64)
                    .div_ceil(1000)
                    .min(3600),
            );
        }
    }
    first("x-ratelimit-reset")?
        .split(',')
        .next()
        .and_then(|first| seconds(first.trim()))
        .map(|n| n.min(3600))
}

fn parse(vendor: Vendor, parsed: &Value) -> Option<Vec<RawResult>> {
    let results = if vendor == Vendor::Brave {
        if !parsed["web"].is_object() {
            return parsed.get("type").map(|_| Vec::new());
        }
        parsed["web"]["results"].as_array()?
    } else {
        parsed["results"].as_array()?
    };
    let items = results.iter().filter(|item| item.is_object()).map(|item| {
        let (snippet, published) = match vendor {
            Vendor::Brave => (
                item["description"].as_str().map(str::to_owned),
                item["page_age"].as_str(),
            ),
            Vendor::Tavily => (
                item["content"].as_str().map(str::to_owned),
                item["published_date"].as_str(),
            ),
            Vendor::Searxng => (
                item["content"].as_str().map(str::to_owned),
                item["publishedDate"].as_str(),
            ),
            Vendor::Exa => {
                let highlights = item["highlights"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" … ");
                let snippet = if highlights.is_empty() {
                    item["text"]
                        .as_str()
                        .filter(|text| !text.is_empty())
                        .or_else(|| item["summary"].as_str().filter(|text| !text.is_empty()))
                        .map(str::to_owned)
                } else {
                    Some(highlights)
                };
                (snippet, item["publishedDate"].as_str())
            }
        };
        RawResult {
            title: item["title"].as_str().unwrap_or_default().to_owned(),
            url: item["url"].as_str().unwrap_or_default().to_owned(),
            snippet,
            published_at: published
                .filter(|date| !date.is_empty() || vendor == Vendor::Searxng)
                .map(|date| {
                    if date.as_bytes().get(10) == Some(&b'T')
                        && date[11..]
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || b".:".contains(&byte))
                    {
                        format!("{date}Z")
                    } else {
                        date.to_owned()
                    }
                }),
        }
    });
    Some(items.collect())
}

#[cfg(test)]
mod policy_tests {
    use super::{Call, Configured, Credential, Credentials, RateLimit, Result, Vendor};
    use crate::{
        http::{Admission, Failure},
        pacer::{self, Clock},
    };
    use std::{net::SocketAddr, time::Instant};
    use ureq::http::{HeaderMap, Method};
    use url::{Origin, Url};

    struct Fixture(Origin);

    impl Credentials for Fixture {
        fn lease(&self, _: Vendor) -> Result<Option<Credential>> {
            Ok(Some(Credential {
                origin: self.0.clone(),
                value: "fixture-marker".into(),
            }))
        }
    }

    impl Clock for Fixture {
        fn now_ms(&self) -> u64 {
            0
        }
        fn sleep_ms(&self, _: u64, _: &dyn Fn() -> bool) -> std::result::Result<(), pacer::Error> {
            Ok(())
        }
    }

    impl Admission for Fixture {
        fn pin(&self, _: &Url, _: Instant) -> std::result::Result<SocketAddr, Failure> {
            Err(Failure::EgressDenied)
        }
    }

    #[test]
    fn search_credentials_bind_to_the_endpoint_without_contacting_it(
    ) -> std::result::Result<(), url::ParseError> {
        let endpoint = Url::parse("https://search.example.invalid/query")?;
        let limit = RateLimit::new(0);
        let matching = Fixture(endpoint.origin());
        let other = Fixture(Url::parse("https://other.example.invalid/query")?.origin());
        let provider = Configured {
            vendor: Vendor::Brave,
            endpoint: &endpoint,
            admission: &matching,
            credentials: Some(&matching),
            clock: &matching,
            limiter: &limit,
            user_agent: "fixture",
            max_inline_wait_ms: 0,
            default_cooldown_seconds: 1,
            outcome: None,
        };
        assert!(provider
            .credential()
            .is_ok_and(|credential| credential.is_some()));
        let provider = Configured {
            credentials: Some(&other),
            ..provider
        };
        assert_eq!(
            provider.credential().err().map(|error| error.code),
            Some("egress-denied")
        );
        let call = Call {
            url: endpoint.clone(),
            method: Method::GET,
            headers: HeaderMap::new(),
            body: None,
        };
        assert_eq!(
            provider.request_options(&call, Instant::now()).max_bytes,
            2 * 1024 * 1024
        );
        Ok(())
    }
}
