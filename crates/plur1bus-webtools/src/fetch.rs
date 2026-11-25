//! Fetch presentation, crawl admission and agent-scoped document cursors.

use std::{cell::RefCell, time::Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use plur1bus_log_schema::redact::matcher::{mask, SecretMatcher, SecretSpan};
use serde_json::{json, Value};
use ureq::http::{header, HeaderMap};
use url::Url;

use crate::{
    crawl::Crawl,
    html::{self, Metadata, PageSignals},
    http::{self, Admission, Failure, Options, Response},
    pacer::Clock,
    text::{decode_body, estimate_tokens, split_sections},
};

const ACCEPT: &str =
    "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1";
const MAX_TOKENS: usize = 100_000;
const META_LIMITS: [(&str, usize); 4] = [
    ("title", 300),
    ("lang", 35),
    ("canonicalUrl", 2048),
    ("publishedAt", 64),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Error {
    pub code: &'static str,
    pub status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}

impl Error {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            status: None,
            retry_after_seconds: None,
        }
    }

    fn with_status(code: &'static str, status: u16) -> Self {
        Self {
            status: Some(status),
            ..Self::new(code)
        }
    }
}

impl From<Failure> for Error {
    fn from(error: Failure) -> Self {
        Self::new(error.code())
    }
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Mode {
    Auto,
    Markdown,
    Raw,
}

pub struct Args<'a> {
    pub url: &'a str,
    pub mode: Mode,
    pub section: Option<&'a str>,
    pub cursor: Option<&'a str>,
    pub max_tokens: Option<usize>,
    pub crawl: bool,
}

pub struct Context<'a> {
    pub agent_id: &'a str,
    pub matcher: Option<&'a SecretMatcher>,
    pub aborted: &'a dyn Fn() -> bool,
}

pub struct Client<'a> {
    pub admission: &'a dyn Admission,
    pub crawl: Option<&'a Crawl<'a>>,
    pub store: &'a dyn Documents,
    pub clock: &'a dyn Clock,
    pub user_agent: &'a str,
    pub max_bytes: usize,
    pub max_redirects: usize,
    pub default_max_tokens: usize,
    pub max_extracted_tokens: usize,
}

#[derive(Clone)]
pub struct Document {
    agent: String,
    requested_url: String,
    text: String,
    meta: Value,
    metadata_windows: [Option<usize>; 4],
}

/// The host owns cursor identity allocation, retention and expiration.
pub trait Documents {
    fn put(&self, document: Document) -> Result<[u8; 6]>;
    fn get(&self, id: [u8; 6], now_ms: u64) -> Option<Document>;
}

impl Client<'_> {
    pub fn fetch(&self, args: &Args<'_>, ctx: &Context<'_>, deadline: Instant) -> Result<Value> {
        let tokens = args.max_tokens.unwrap_or(self.default_max_tokens);
        if args.url.trim().is_empty()
            || units(args.url) > 4096
            || args
                .section
                .is_some_and(|section| section.is_empty() || units(section) > 200)
            || args.cursor.is_some_and(|cursor| units(cursor) > 100)
            || !(100..=MAX_TOKENS).contains(&tokens)
        {
            return Err(Error::new("invalid-arguments"));
        }
        if let Some(cursor) = args.cursor {
            let expired = || Error::new("cursor-expired");
            let (id, at) = parse_cursor(cursor).ok_or_else(expired)?;
            let entry = self
                .store
                .get(id, self.clock.now_ms())
                .ok_or_else(expired)?;
            if entry.agent != ctx.agent_id || entry.requested_url != args.url {
                return Err(expired());
            }
            return self.present(entry, Some(id), at, tokens, ctx);
        }
        let response = self.load(args, ctx, deadline)?;
        check_status(&response, self.clock.now_ms(), &|| {
            http::remaining(deadline, ctx.aborted).map(|_| ())
        })?;
        let document = self.document(args, ctx, &response, deadline)?;
        self.present(document, None, 0, tokens, ctx)
    }

    fn load(&self, args: &Args<'_>, ctx: &Context<'_>, deadline: Instant) -> Result<Response> {
        let headers = HeaderMap::new();
        let mut options = Options::get(&headers, self.user_agent, ACCEPT, deadline);
        options.max_bytes = self.max_bytes;
        options.max_redirects = self.max_redirects;
        options.error_body_bytes = 128 * 1024;
        options.accept_type = Some(&|content| {
            mime(content).is_none_or(|mime| kind(&mime).is_some() || unknown_type(&mime))
        });
        let crawl = self.crawl.map(|crawl| Crawl {
            aborted: ctx.aborted,
            ..*crawl
        });
        let admission: &dyn Admission = if args.crawl {
            let crawl = crawl
                .as_ref()
                .ok_or_else(|| Error::new("robots-disallowed"))?;
            let url = Url::parse(args.url).map_err(|_| Failure::InvalidUrl)?;
            if matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
            {
                crawl.station(&url, deadline)?;
            }
            crawl
        } else {
            self.admission
        };
        Ok(http::request(args.url, &options, admission, ctx.aborted)?)
    }

    fn document(
        &self,
        args: &Args<'_>,
        ctx: &Context<'_>,
        response: &Response,
        deadline: Instant,
    ) -> Result<Document> {
        let check = || http::remaining(deadline, ctx.aborted).map(|_| ());
        check()?;
        let content_type = content_type(response);
        let (mime, kind) = classify(content_type, &response.body)?;
        let input = masked(ctx.matcher, &decode_body(&response.body, content_type));
        let harvested = RefCell::new([None, None, None, None]);
        let mut metadata_windows = [None; 4];
        let mut markdown = match (args.mode, kind) {
            (Mode::Raw, _) | (_, Kind::Text) => input,
            (_, Kind::Json) => {
                crate::json::pretty(&input, self.max_extracted_tokens.saturating_mul(4), &check)?
                    .unwrap_or(input)
            }
            (_, Kind::Html) => {
                const HTML_LOOKAHEAD_UNITS: usize = 4096;
                let max_units = self
                    .max_extracted_tokens
                    .saturating_mul(4)
                    .saturating_add(HTML_LOOKAHEAD_UNITS);
                let mask_metadata = |value: &str, field| {
                    let key = match field {
                        Metadata::Title => 0,
                        Metadata::Lang => 1,
                        Metadata::CanonicalUrl => 2,
                        Metadata::PublishedAt => 3,
                    };
                    let value = masked(ctx.matcher, value);
                    harvested.borrow_mut()[key] = Some(value.clone());
                    value
                };
                let extracted = html::extract(
                    &input,
                    response.url.as_str(),
                    &mask_metadata,
                    max_units,
                    &check,
                )?;
                if let Some(code) = wall_code(&extracted.signals) {
                    return Err(Error::with_status(code, response.status));
                }
                if extracted.markdown.trim().is_empty() || extracted.looks_client_rendered {
                    return Err(Error::with_status("needs-render", response.status));
                }
                extracted.markdown
            }
        };
        check()?;
        if estimate_tokens(&markdown) > self.max_extracted_tokens {
            return Err(Failure::TooLarge.into());
        }
        markdown = masked(ctx.matcher, &markdown);
        let sections = split_sections(&markdown);
        let selected = if let Some(want) = args.section {
            let title = masked(ctx.matcher, want).to_lowercase();
            sections
                .iter()
                .find(|section| section.id == want)
                .or_else(|| {
                    sections
                        .iter()
                        .find(|section| section.title.to_lowercase() == title)
                })
                .ok_or_else(|| Error::new("invalid-arguments"))?
                .text
                .clone()
        } else {
            markdown
        };
        let fetched_at = i64::try_from(self.clock.now_ms())
            .ok()
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .ok_or_else(|| Error::new("internal-error"))?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut meta = json!({
            "finalUrl": response.url.as_str(),
            "status": response.status,
            "contentType": mime,
            "sections": sections.iter().take(200).map(|section| {
                json!({"id":section.id, "title":section.title, "tokens":section.tokens})
            }).collect::<Vec<_>>(),
            "fetchedAt": fetched_at,
            "provenance": {"source":"web","url":response.url.as_str(),"fetchedAt":fetched_at,"trust":"untrusted"},
        });
        if sections.len() > 200 {
            meta["sectionsTotal"] = json!(sections.len());
        }
        for (index, value) in harvested.into_inner().into_iter().enumerate() {
            if let Some(value) = value {
                let (name, limit) = META_LIMITS[index];
                let allowance = ctx.matcher.map_or(0, SecretMatcher::max_source_bytes);
                let keep = self
                    .max_extracted_tokens
                    .saturating_mul(4)
                    .max(limit.saturating_add(allowance).saturating_add(3));
                let value = if units(&value) > keep {
                    let shortened = prefix(&value, keep);
                    metadata_windows[index] = Some(units(shortened));
                    shortened.to_owned()
                } else {
                    value
                };
                meta[name] = json!(value);
            }
        }
        Ok(Document {
            agent: ctx.agent_id.to_owned(),
            requested_url: args.url.to_owned(),
            text: selected,
            meta,
            metadata_windows,
        })
    }

    fn present(
        &self,
        entry: Document,
        id: Option<[u8; 6]>,
        offset: usize,
        max_tokens: usize,
        ctx: &Context<'_>,
    ) -> Result<Value> {
        let source: Vec<_> = entry.text.encode_utf16().collect();
        if offset > source.len()
            || source
                .get(offset)
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            return Err(Error::new("cursor-expired"));
        }
        let projection = ctx
            .matcher
            .map(|matcher| matcher.project_text_units(&source));
        let (text, spans) = projection
            .as_ref()
            .map_or((entry.text.as_str(), &[][..]), |p| {
                (p.text.as_str(), p.spans.as_slice())
            });
        let marker: Vec<_> = mask().encode_utf16().collect();
        let start = map_offset(offset, spans, marker.len(), false);
        let display: Vec<_> = text.encode_utf16().collect();
        let (end, mut next) = chunk(&display, start, max_tokens * 4);
        let mut cut = end;
        if let Some(begin) = (start..cut)
            .rev()
            .find(|&begin| cut < begin + marker.len() && display[begin..].starts_with(&marker))
        {
            cut = begin;
            next = Some(begin);
        }
        let mut output = entry.meta.clone();
        if let Some(url) = output["finalUrl"].as_str() {
            let shown = masked(ctx.matcher, url);
            output["finalUrl"] = json!(shown);
            output["provenance"]["url"] = json!(shown);
        }
        if let Some(content_type) = output["contentType"].as_str() {
            output["contentType"] = json!(masked(ctx.matcher, content_type));
        }
        for (index, (field, limit)) in META_LIMITS.into_iter().enumerate() {
            if let Some(value) = output[field].as_str() {
                let need = limit
                    .saturating_add(ctx.matcher.map_or(0, SecretMatcher::max_source_bytes))
                    .saturating_add(3);
                let shown = if entry.metadata_windows[index].is_some_and(|retained| need > retained)
                {
                    "[metadata withheld: secret context changed]".to_owned()
                } else {
                    masked(ctx.matcher, value)
                };
                output[field] = json!(if field == "canonicalUrl" {
                    shown
                } else {
                    clipped(&shown, limit)
                });
            }
        }
        if let Some(sections) = output["sections"].as_array_mut() {
            for section in sections {
                let title = section["title"].as_str().unwrap_or_default();
                section["title"] = json!(clipped(&masked(ctx.matcher, title), 120));
            }
        }
        output["markdown"] = json!(String::from_utf16_lossy(&display[start..cut]));
        output["renderUsed"] = json!(false);
        output["fromCache"] = json!(id.is_some());
        if let Some(next) = next {
            let id = match id {
                Some(id) => id,
                None => self.store.put(entry)?,
            };
            let position = map_offset(next, spans, marker.len(), true);
            output["cursor"] = json!(format!("{}.{position}", hex_id(id)));
        }
        Ok(output)
    }
}

fn masked(matcher: Option<&SecretMatcher>, value: &str) -> String {
    matcher.map_or_else(|| value.to_owned(), |matcher| matcher.mask_text(value))
}

fn hex_id(id: [u8; 6]) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(12);
    for byte in id {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

fn parse_cursor(raw: &str) -> Option<([u8; 6], usize)> {
    let (id, position) = raw.split_once('.')?;
    if id.len() != 12
        || position.is_empty()
        || position.len() > 9
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !position.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let mut bytes = [0; 6];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&id[2 * index..2 * index + 2], 16).ok()?;
    }
    Some((bytes, position.parse().ok()?))
}

fn map_offset(offset: usize, spans: &[SecretSpan], replacement: usize, to_source: bool) -> usize {
    let mut source = 0;
    let mut display = 0;
    for span in spans {
        let start = display + span.start - source;
        let end = start + replacement;
        let (from, to, before, after) = if to_source {
            (start, end, display, source)
        } else {
            (span.start, span.end, source, display)
        };
        if offset <= from {
            return after + offset - before;
        }
        if offset < to {
            return if to_source { span.start } else { start };
        }
        source = span.end;
        display = end;
    }
    if to_source {
        source + offset - display
    } else {
        display + offset - source
    }
}

fn chunk(text: &[u16], offset: usize, max: usize) -> (usize, Option<usize>) {
    if text.len() - offset <= max {
        return (text.len(), None);
    }
    let limit = offset + max;
    if let Some(paragraph) = (offset + max / 4 + 1..=limit)
        .rev()
        .find(|&at| text.get(at..at + 2) == Some(&[10, 10]))
    {
        return (paragraph, Some(paragraph + 2));
    }
    if let Some(blank) = (offset + max / 2 + 1..=limit)
        .rev()
        .find(|&at| matches!(text[at], 10 | 32))
    {
        return (blank, Some(blank + 1));
    }
    let end = limit - usize::from((0xd800..=0xdbff).contains(&text[limit - 1]));
    (end, Some(end))
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

fn prefix(text: &str, len: usize) -> &str {
    let mut seen = 0;
    for (index, c) in text.char_indices() {
        seen += c.len_utf16();
        if seen > len {
            return &text[..index];
        }
    }
    text
}

fn clipped(text: &str, len: usize) -> String {
    if units(text) > len {
        format!("{}…", prefix(text, len - 1))
    } else {
        text.to_owned()
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Html,
    Json,
    Text,
}

fn content_type(response: &Response) -> Option<&str> {
    response
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
}

fn mime(header: Option<&str>) -> Option<String> {
    header?
        .split(';')
        .next()
        .map(str::trim)
        .filter(|type_name| !type_name.is_empty())
        .map(str::to_ascii_lowercase)
}

fn kind(mime: &str) -> Option<Kind> {
    match mime {
        "text/html" | "application/xhtml+xml" => Some(Kind::Html),
        "application/json" | "text/json" => Some(Kind::Json),
        "text/xml"
        | "application/xml"
        | "text/plain"
        | "text/markdown"
        | "text/x-markdown"
        | "text/csv"
        | "text/tab-separated-values" => Some(Kind::Text),
        mime if mime.ends_with("+json") => Some(Kind::Json),
        mime if mime.starts_with("application/") && mime.ends_with("+xml") => Some(Kind::Text),
        _ => None,
    }
}

fn unknown_type(mime: &str) -> bool {
    matches!(
        mime,
        "application/octet-stream"
            | "binary/octet-stream"
            | "application/x-unknown"
            | "application/unknown"
            | "application/download"
    )
}

fn looks_html(body: &[u8]) -> bool {
    let bytes = &body[..body.len().min(256)];
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let start = bytes
        .iter()
        .position(|byte| !matches!(byte, b'\t'..=b'\r' | b' ' | 0xa0))
        .unwrap_or(bytes.len());
    let opening = bytes[start..].to_ascii_lowercase();
    opening.starts_with(b"<!doctype html") || opening.starts_with(b"<html")
}

fn classify(header: Option<&str>, bytes: &[u8]) -> Result<(String, Kind)> {
    let binary = (bytes.starts_with(b"%PDF-")
        && bytes
            .get(5)
            .is_some_and(|digit| (b'1'..=b'9').contains(digit)))
        || [
            b"PK\x03\x04".as_slice(),
            b"\x89PNG",
            b"GIF87a",
            b"GIF89a",
            b"\xff\xd8\xff",
            b"\x1f\x8b",
            b"\x7fELF",
        ]
        .iter()
        .any(|signature| bytes.starts_with(signature));
    if binary {
        return Err(Failure::UnsupportedType.into());
    }
    let html = looks_html(bytes);
    match mime(header) {
        None if bytes[..bytes.len().min(512)].contains(&0) => Err(Failure::UnsupportedType.into()),
        None if html => Ok(("text/html".to_owned(), Kind::Html)),
        None => Ok(("text/plain".to_owned(), Kind::Text)),
        Some(mime) if unknown_type(&mime) && html => Ok(("text/html".to_owned(), Kind::Html)),
        Some(mime) if mime == "text/plain" && html => Ok((mime, Kind::Html)),
        Some(mime) => kind(&mime)
            .map(|kind| (mime, kind))
            .ok_or_else(|| Failure::UnsupportedType.into()),
    }
}

fn wall_code(signals: &PageSignals) -> Option<&'static str> {
    if signals.captcha {
        Some("captcha")
    } else if signals.password_form {
        Some("auth-required")
    } else if signals.paywall {
        Some("paywall")
    } else {
        None
    }
}

fn check_status(
    response: &Response,
    now_ms: u64,
    check: &dyn Fn() -> std::result::Result<(), Failure>,
) -> Result<()> {
    if (200..300).contains(&response.status) {
        return Ok(());
    }
    check()?;
    const DIAGNOSTIC_HTML_UNITS: usize = 4096;
    let mime = mime(content_type(response));
    let mut captcha = false;
    if !response.body.is_empty()
        && mime
            .as_deref()
            .is_none_or(|mime| matches!(mime, "text/html" | "application/xhtml+xml" | "text/plain"))
    {
        match html::extract(
            &decode_body(&response.body, content_type(response)),
            response.url.as_str(),
            &|text, _| text.to_owned(),
            DIAGNOSTIC_HTML_UNITS,
            check,
        ) {
            Ok(page) => captcha = page.signals.captcha,
            Err(Failure::Timeout) => return Err(Failure::Timeout.into()),
            Err(_) => {}
        }
    }
    check()?;
    let code = if captcha {
        "captcha"
    } else {
        match response.status {
            404 => "not-found",
            410 => "gone",
            401 | 403 | 407 => "auth-required",
            402 => "paywall",
            429 => "rate-limited",
            408 | 504 => "timeout",
            _ => "http-error",
        }
    };
    let mut error = Error::with_status(code, response.status);
    if response.status == 429 {
        error.retry_after_seconds = response
            .headers
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                let value = value.trim();
                if value.len() <= 9 && value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return value.parse().ok();
                }
                let when = DateTime::parse_from_rfc2822(value).ok()?.timestamp_millis();
                let now = i64::try_from(now_ms).ok()?;
                Some((when.saturating_sub(now).max(0) as u64).saturating_add(500) / 1000)
            });
    }
    Err(error)
}
