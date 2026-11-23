//! Provider fallback, bounded result projection and content-free traces.

pub mod providers;

use std::{
    collections::HashSet,
    sync::LazyLock,
    time::{Duration, Instant},
};

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

use crate::{fetch::Error, pacer::Clock, text::decode_entities};

type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy)]
pub enum Freshness {
    Day,
    Week,
    Month,
    Year,
}

impl Freshness {
    pub fn name(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
        }
    }
}

pub struct Query {
    pub query: String,
    pub count: usize,
    pub freshness: Option<Freshness>,
    pub site: Option<String>,
    pub lang: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawResult {
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

pub trait Provider {
    fn id(&self) -> &str;
    fn search(
        &self,
        query: &Query,
        deadline: Instant,
        aborted: &dyn Fn() -> bool,
    ) -> Result<Vec<RawResult>>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped<'a> {
    pub provider: &'a str,
    pub reason: &'static str,
}

pub struct Trace<'a> {
    pub provider: Option<&'a str>,
    pub results: Option<usize>,
    pub query_chars: usize,
    pub skipped: &'a [Skipped<'a>],
    pub ms: u64,
    pub error: Option<&'static str>,
}

pub struct Client<'a> {
    pub providers: &'a [&'a dyn Provider],
    pub clock: &'a dyn Clock,
    pub provider_timeout: Duration,
    pub trace: Option<&'a dyn Fn(Trace<'_>)>,
}

static LANG: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$").ok());
static SITE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$").ok());
static TAG: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"<[^>]*>").ok());

fn failure(code: &'static str) -> Error {
    Error {
        code,
        status: None,
        retry_after_seconds: None,
    }
}

impl Client<'_> {
    pub fn search(&self, query: &Query, aborted: &dyn Fn() -> bool) -> Result<Value> {
        let started = self.clock.now_ms();
        let mut skipped = Vec::new();
        let mut provider = None;
        let mut count = None;
        let query_chars = query.query.trim_matches(space).encode_utf16().count();
        let result = (|| {
            let query = validated(query)?;
            if self.providers.is_empty() {
                return Err(failure("no-provider"));
            }
            for candidate in self.providers {
                if aborted() {
                    return Err(failure("timeout"));
                }
                let deadline = Instant::now()
                    .checked_add(self.provider_timeout)
                    .ok_or_else(|| failure("internal-error"))?;
                let raw = candidate.search(&query, deadline, aborted);
                if aborted() {
                    return Err(failure("timeout"));
                }
                if Instant::now() >= deadline {
                    skipped.push(Skipped {
                        provider: candidate.id(),
                        reason: "timeout",
                    });
                    continue;
                }
                let raw = match raw {
                    Ok(items) => items,
                    Err(error) => {
                        let reason = match error.code {
                            "timeout" => "timeout",
                            "invalid-response" => "invalid-response",
                            _ => "error",
                        };
                        skipped.push(Skipped {
                            provider: candidate.id(),
                            reason,
                        });
                        continue;
                    }
                };
                let results = normalize(raw, &query);
                provider = Some(candidate.id());
                count = Some(results.len());
                let retrieved = wall_clock(self.clock.now_ms())?;
                return Ok(json!({
                    "results": results,
                    "provider": provider,
                    "skipped": skipped,
                    "provenance": {"source":"web.search","provider":provider,"retrievedAt":retrieved,"trust":"untrusted"},
                }));
            }
            Err(failure("provider-failed"))
        })();
        if let Some(trace) = self.trace {
            trace(Trace {
                provider,
                results: count,
                query_chars,
                skipped: &skipped,
                ms: self.clock.now_ms().saturating_sub(started),
                error: result.as_ref().err().map(|error| error.code),
            });
        }
        result
    }
}

fn space(c: char) -> bool {
    (c != '\u{85}' && c.is_whitespace()) || c == '\u{feff}'
}

fn validated(query: &Query) -> Result<Query> {
    let text = query.query.trim_matches(space);
    if text.is_empty()
        || query.query.encode_utf16().count() > 500
        || !(1..=20).contains(&query.count)
        || query.site.as_ref().is_some_and(|site| {
            site.len() > 253 || !SITE.as_ref().is_some_and(|rule| rule.is_match(site))
        })
        || query
            .lang
            .as_ref()
            .is_some_and(|lang| !LANG.as_ref().is_some_and(|rule| rule.is_match(lang)))
    {
        return Err(failure("invalid-arguments"));
    }
    Ok(Query {
        query: text.to_owned(),
        count: query.count,
        freshness: query.freshness,
        site: query.site.as_ref().map(|site| site.to_ascii_lowercase()),
        lang: query.lang.clone(),
    })
}

fn control(c: char) -> bool {
    matches!(c, '\0'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}'..='\u{9f}' |
        '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' |
        '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206f}' | '\u{feff}')
}

fn clean(input: &str, cap: usize) -> String {
    let tagless = TAG.as_ref().map_or_else(
        || std::borrow::Cow::Borrowed(input),
        |pattern| pattern.replace_all(input, " "),
    );
    let decoded = decode_entities(&tagless);
    let clean = TAG.as_ref().map_or_else(
        || std::borrow::Cow::Borrowed(decoded.as_ref()),
        |pattern| pattern.replace_all(&decoded, " "),
    );
    let mut text = String::new();
    let mut space_pending = false;
    for c in clean.chars().filter(|&c| !control(c)) {
        if space(c) {
            space_pending = !text.is_empty();
        } else {
            if space_pending {
                text.push(' ');
            }
            text.push(c);
            space_pending = false;
        }
    }
    if text.encode_utf16().count() > cap {
        let mut units = 0;
        let end = text
            .char_indices()
            .find_map(|(at, c)| {
                units += c.len_utf16();
                (units >= cap).then_some(at)
            })
            .unwrap_or(text.len());
        text.truncate(end);
        text.push('…');
    }
    text
}

pub(super) fn wall_clock(time_ms: u64) -> Result<String> {
    i64::try_from(time_ms)
        .ok()
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| failure("internal-error"))
}

fn parsed_date(date: &str) -> Option<String> {
    let time = DateTime::parse_from_rfc3339(date)
        .or_else(|_| DateTime::parse_from_rfc2822(date))
        .map(|date| date.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(date, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|date| date.and_utc())
        })
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|date| date.and_utc())
        })?;
    Some(time.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn normalize(items: Vec<RawResult>, query: &Query) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for item in items {
        let Ok(url) = Url::parse(&item.url) else {
            continue;
        };
        let Some(host) = url.host_str() else { continue };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || query.site.as_ref().is_some_and(|site| {
                host != site
                    && !host
                        .strip_suffix(site)
                        .is_some_and(|tail| tail.ends_with('.'))
            })
        {
            continue;
        }
        let title = clean(&item.title, 200);
        if title.is_empty() || !seen.insert(url[..url::Position::AfterQuery].to_owned()) {
            continue;
        }
        let mut result = json!({
            "title": title,
            "url": url.as_str(),
            "snippet": clean(item.snippet.as_deref().unwrap_or_default(), 500),
            "source": host.to_ascii_lowercase(),
        });
        if let Some(date) = item.published_at.as_deref().and_then(parsed_date) {
            result["publishedAt"] = json!(date);
        }
        results.push(result);
        if results.len() >= query.count {
            break;
        }
    }
    results
}

#[cfg(test)]
mod normalization_tests {
    use super::{normalize, Query, RawResult};

    #[test]
    fn normalized_search_results_have_web_urls_and_bounded_snippets() {
        let query = Query {
            query: "edition".into(),
            count: 3,
            lang: None,
            site: None,
            freshness: None,
        };
        let raw = |url: &str| RawResult {
            title: "Edition".into(),
            url: url.into(),
            snippet: Some("x".repeat(501)),
            published_at: None,
        };
        let items = normalize(
            vec![
                raw("ftp://archive.example.invalid/edition"),
                raw("https://edition.example.invalid/page"),
            ],
            &query,
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["url"], "https://edition.example.invalid/page");
        assert!(items[0]["snippet"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 500));
    }
}
