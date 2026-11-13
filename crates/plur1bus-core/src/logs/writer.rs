//! `writer.ts`: the diagnostic writer. It validates every record against the D111 schema before it is queued, redacts
//! attributes, source and free text, de-duplicates identical records inside a window, rate-limits per source, keeps a
//! bounded queue while the sink fails, and writes the queue in batches under one acquisition of the role lock.
//!
//! The TypeScript writer is synchronous; so is this one. A [`Writer`] is a handle over one mutex-guarded state, shared by
//! the callers and a timer thread (1 s by default, `std::thread` and a condition variable; no async runtime) that
//! de-duplicates summaries, reports rate-limit drops, prunes daily and flushes.
//!
//! Differences from the TypeScript lines, all pinned by tests: attribute keys are sorted (the JSON values here have no
//! insertion order) and a float attribute with no fraction prints with `.0`.
use super::error::LogError;
use super::levels::{system_clock, Clock, LevelPolicy, LevelSettings, Source};
use super::redact::TextRedactor;
use super::sink::{Sink, SinkHooks, SinkOptions};
use super::trace::{current_trace, new_trace};
use plur1bus_log_schema::redact::{RedactOptions, Redactor, SecretMatcher};
use plur1bus_log_schema::{attrs_schema_for, limits, lookup_event, validate_line, Level, Limits};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

/// Records held while the sink fails; the oldest are dropped (and reported once the sink works again).
const MAX_PENDING: usize = 256;
/// Most records written under one acquisition of the role lock (bounds how long other writers wait for it).
const MAX_BATCH: usize = 256;
const DAY_MS: i64 = 86_400_000;

fn lim() -> &'static Limits {
    static L: std::sync::OnceLock<Limits> = std::sync::OnceLock::new();
    L.get_or_init(limits)
}

/// The stream of a captured child-process line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OutStream {
    /// Standard output.
    Stdout,
    /// Standard error.
    Stderr,
}

impl OutStream {
    /// The schema spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            OutStream::Stdout => "stdout",
            OutStream::Stderr => "stderr",
        }
    }
}

/// `WriteFields`: what a call may override.
#[derive(Clone, Debug, Default)]
pub struct WriteFields {
    /// The writing component; default the writer's own source.
    pub source: Option<Source>,
    /// The level; default the catalogue's.
    pub level: Option<Level>,
    /// The captured stream (only `process.output.line` and friends).
    pub stream: Option<OutStream>,
    /// Skip the rate limit (output lines have their own).
    pub bypass_rate: bool,
}

/// One framed output line: original source coordinates, never an already-redacted payload.
pub struct OutputLineInput<'a> {
    /// The source text as UTF-16 code units, with the context before and after the line.
    pub context: &'a [u16],
    /// Start of the line in `context` (UTF-16 offset).
    pub source_begin: usize,
    /// End of the line in `context` (UTF-16 offset).
    pub source_end: usize,
    /// The line's size in bytes at the source.
    pub bytes: usize,
    /// The stream it came from.
    pub stream: OutStream,
    /// The line exceeded the frame; its text is replaced wholesale.
    pub oversized: bool,
}

/// What [`Writer::new`] takes.
#[derive(Clone)]
pub struct WriterOptions {
    /// The log directory.
    pub dir: PathBuf,
    /// The role (`core`, ...).
    pub role: String,
    /// The writer's own source.
    pub source: Source,
    /// The clock; default the system clock.
    pub now: Option<Clock>,
    /// Run the timer thread; default true. Without it a test drives [`Writer::timer_tick`].
    pub timers: bool,
    /// The timer interval; default 1 s.
    pub timer_interval: Duration,
    /// Throw on an unregistered event instead of reporting it.
    pub strict: bool,
    /// Rotation size.
    pub max_bytes: Option<f64>,
    /// Rotated copies kept.
    pub keep: Option<i64>,
    /// Retention in days.
    pub retention_days: Option<i64>,
    /// Rule 6 (PII).
    pub redact_pii: bool,
    /// Initial levels.
    pub levels: Option<LevelSettings>,
    /// A populated live policy, applied before constructor records; manual writer registrations remain additive.
    pub redactor: Option<Arc<dyn TextRedactor>>,
    /// The sink's OS seams.
    pub hooks: SinkHooks,
    /// How long the sink waits for a lock.
    pub lock_timeout: Option<Duration>,
}

impl WriterOptions {
    /// Options with every default.
    pub fn new(dir: impl Into<PathBuf>, role: &str, source: Source) -> WriterOptions {
        WriterOptions {
            dir: dir.into(),
            role: role.to_string(),
            source,
            now: None,
            timers: true,
            timer_interval: Duration::from_secs(1),
            strict: false,
            max_bytes: None,
            keep: None,
            retention_days: None,
            redact_pii: false,
            levels: None,
            redactor: None,
            hooks: SinkHooks::default(),
            lock_timeout: None,
        }
    }
}

/// UTF-8 byte cap, never cuts a code point; an over-long text ends in `…`.
pub fn cap(text: &str, bytes: usize) -> String {
    if text.len() <= bytes {
        return text.to_string();
    }
    let room = bytes.saturating_sub(3);
    let mut out = String::new();
    let mut size = 0;
    for c in text.chars() {
        let n = c.len_utf8();
        if size + n > room {
            break;
        }
        out.push(c);
        size += n;
    }
    out.push('…');
    out
}

/// `new Date(ms).toISOString()` for years 0 to 9999.
pub fn iso_time(ms: i64) -> Result<String, LogError> {
    let days = ms.div_euclid(DAY_MS);
    let in_day = ms.rem_euclid(DAY_MS);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    if !(0..=9999).contains(&year) {
        return Err(LogError::Range("Invalid time value".into()));
    }
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// One record in the order of the schema's `x-key-order`.
#[derive(Clone, Debug)]
struct Record {
    ts: String,
    level: Level,
    source: Source,
    event: String,
    msg: String,
    trace_id: String,
    span_id: String,
    stream: Option<OutStream>,
    attrs: Map<String, Value>,
}

impl Record {
    fn attrs_json(&self) -> String {
        serde_json::to_string(&self.attrs).unwrap_or_else(|_| "{}".into())
    }

    /// `JSON.stringify(record)`: top-level keys in schema order, the source as kind, id, version.
    fn json(&self) -> String {
        let mut source = format!(
            "{{\"kind\":{},\"id\":{}",
            json_str(&self.source.kind),
            json_str(&self.source.id)
        );
        // The schema requires `version`; an unknown one is `null`, as the TypeScript writer serialises it.
        let version = self
            .source
            .version
            .as_deref()
            .map_or_else(|| "null".to_string(), json_str);
        source.push_str(&format!(",\"version\":{version}}}"));
        let mut out = format!(
            "{{\"ts\":{},\"level\":{},\"source\":{source},\"event\":{},\"msg\":{},\"trace_id\":{},\"span_id\":{}",
            json_str(&self.ts),
            json_str(self.level.as_str()),
            json_str(&self.event),
            json_str(&self.msg),
            json_str(&self.trace_id),
            json_str(&self.span_id)
        );
        if let Some(s) = self.stream {
            out.push_str(&format!(",\"stream\":\"{}\"", s.as_str()));
        }
        out.push_str(",\"attrs\":");
        out.push_str(&self.attrs_json());
        out.push('}');
        out
    }
}

fn check(line: &str) -> Result<(), LogError> {
    validate_line(line)
        .map(|_| ())
        .map_err(|e| LogError::Invalid {
            code: e.code.as_str(),
            detail: e.detail,
        })
}

fn set_if_absent(attrs: &mut Map<String, Value>, key: &str, value: usize) {
    if attrs.get(key).is_none_or(Value::is_null) {
        attrs.insert(key.to_string(), json!(value));
    }
}

/// Caps strings and arrays to the attribute schema, then shrinks the longest string or array until the attributes and the
/// line fit their byte limits. Required names and types stay.
fn fit(record: &mut Record) -> Result<(), LogError> {
    let limit = lim();
    let original = record.attrs_json().len();
    let entry =
        lookup_event(&record.event).ok_or_else(|| LogError::Unregistered(record.event.clone()))?;
    let schema = attrs_schema_for(entry);
    let props = schema["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let max_length = |key: &str| {
        props
            .get(key)
            .and_then(|p| p["maxLength"].as_u64())
            .map(|n| n as usize)
    };
    let keys: Vec<String> = record.attrs.keys().cloned().collect();
    for key in &keys {
        if let Some(Value::String(s)) = record.attrs.get(key) {
            let max = max_length(key).unwrap_or(limit.attrs_bytes);
            let max = max.min(if key == "foreign_message" {
                2048
            } else {
                limit.attrs_bytes
            });
            let capped = cap(s, max);
            record.attrs.insert(key.clone(), Value::String(capped));
        }
    }
    for key in &keys {
        if let Some(Value::Array(items)) = record.attrs.get(key) {
            let max_items = props
                .get(key)
                .and_then(|p| p["maxItems"].as_u64())
                .map_or(items.len(), |n| n as usize);
            let item_max = props
                .get(key)
                .and_then(|p| p["items"]["maxLength"].as_u64())
                .map_or(limit.attrs_bytes, |n| n as usize);
            let next: Vec<Value> = items
                .iter()
                .take(max_items)
                .map(|v| match v {
                    Value::String(s) => Value::String(cap(s, item_max)),
                    other => other.clone(),
                })
                .collect();
            record.attrs.insert(key.clone(), Value::Array(next));
        }
    }
    if record.attrs_json().len() != original {
        record.attrs.insert("truncated".into(), Value::Bool(true));
        set_if_absent(&mut record.attrs, "bytes", original);
    }
    while record.json().len() > limit.line_bytes || record.attrs_json().len() > limit.attrs_bytes {
        let mut strings: Vec<(String, usize)> = record
            .attrs
            .iter()
            .filter_map(|(k, v)| {
                v.as_str()
                    .filter(|s| s.len() > 8)
                    .map(|s| (k.clone(), s.len()))
            })
            .collect();
        strings.sort_by_key(|s| std::cmp::Reverse(s.1));
        let mut arrays: Vec<(String, usize)> = record
            .attrs
            .iter()
            .filter_map(|(k, v)| match v {
                Value::Array(a) if !a.is_empty() => Some((k.clone(), v.to_string().len())),
                _ => None,
            })
            .collect();
        arrays.sort_by_key(|a| std::cmp::Reverse(a.1));
        if let Some((key, size)) = arrays
            .first()
            .filter(|(_, size)| strings.first().is_none_or(|s| *size > s.1))
        {
            let _ = size;
            if let Some(Value::Array(items)) = record.attrs.get_mut(key) {
                let keep = items.len() / 2;
                items.truncate(keep);
            }
        } else if let Some((key, size)) = strings.first() {
            let text = record
                .attrs
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            record
                .attrs
                .insert(key.clone(), Value::String(cap(&text, size / 2)));
        } else {
            return Err(LogError::TooLarge);
        }
        record.attrs.insert("truncated".into(), Value::Bool(true));
        set_if_absent(&mut record.attrs, "bytes", original);
    }
    Ok(())
}

struct Repeat {
    record: Record,
    start: i64,
    count: u64,
}

struct Bucket {
    key: String,
    tokens: f64,
    at: i64,
    start: i64,
    dropped: u64,
    source: Source,
}

struct OutputPolicy {
    redactor: Redactor,
    matcher: Arc<SecretMatcher>,
    inputs: [Option<Arc<SecretMatcher>>; 3],
}

struct State {
    source: Source,
    role: String,
    strict: bool,
    redact_pii: bool,
    retention_days: i64,
    now: Clock,
    sink: Sink,
    user: Option<Arc<dyn TextRedactor>>,
    secrets: Vec<String>,
    pinned: Vec<String>,
    registered: Arc<Redactor>,
    output: Option<OutputPolicy>,
    closed: bool,
    flushing: bool,
    last_prune: i64,
    pending: Vec<String>,
    lost: u64,
    retry_at: i64,
    seq: u64,
    repeats: BTreeMap<u64, (String, Repeat)>,
    repeat_index: HashMap<String, u64>,
    buckets: Vec<Bucket>,
    policy: LevelPolicy,
    levels: LevelSettings,
}

fn build_redactor(pii: bool, secrets: Vec<String>) -> Result<Redactor, LogError> {
    Redactor::new(RedactOptions {
        pii,
        secrets,
        ..RedactOptions::default()
    })
    .map_err(|e| LogError::Io(std::io::Error::other(e.to_string())))
}

impl State {
    fn masked(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        self.pinned
            .iter()
            .chain(self.secrets.iter())
            .filter(|v| seen.insert((*v).clone()))
            .cloned()
            .collect()
    }

    fn red_text(&self, text: &str) -> String {
        match &self.user {
            Some(user) => self.registered.text(&user.text(text)),
            None => self.registered.text(text),
        }
    }

    fn red_value(&self, value: &Value) -> Value {
        match &self.user {
            Some(user) => self.registered.value(&user.value(value)),
            None => self.registered.value(value),
        }
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    /// The level for `source`, emitting `log.level.expired` for a trace level that lapsed.
    fn resolve_level(&mut self, source: &Source) -> Result<Level, LogError> {
        let mut expired = Vec::new();
        let level = self.policy.resolve_reporting(source, &mut expired);
        for key in expired {
            self.emit(
                "log.level.expired",
                obj(json!({"source_key": key, "from": "trace", "to": "debug"})),
                &WriteFields::default(),
                true,
                None,
            )?;
        }
        Ok(level)
    }

    fn enqueue_line(&mut self, json: &str) {
        self.queue(format!("{json}\n"));
        if self.pending.len() >= 64 {
            self.auto_flush(true);
        }
    }

    fn enqueue(&mut self, record: &Record) -> Result<(), LogError> {
        let json = record.json();
        check(&json)?;
        self.enqueue_line(&json);
        Ok(())
    }

    /// Flush on the hot path: a failing sink must not reach the caller; it is retried by the timer, `flush` and `close`
    /// (and here after a second) rather than on every record.
    fn auto_flush(&mut self, durable: bool) {
        if self.now() < self.retry_at {
            return;
        }
        if self.flush(durable).is_err() {
            self.retry_at = self.now() + 1000;
        }
    }

    fn queue(&mut self, line: String) {
        self.pending.push(line);
        if self.pending.len() > MAX_PENDING {
            let n = self.pending.len() - MAX_PENDING;
            self.pending.drain(..n);
            self.lost += n as u64;
        }
    }

    fn flush(&mut self, durable: bool) -> Result<(), LogError> {
        if self.flushing {
            return Ok(());
        }
        self.flushing = true;
        let result = self.flush_inner(durable);
        self.flushing = false;
        if result.is_ok() {
            self.retry_at = 0;
        }
        result
    }

    fn flush_inner(&mut self, durable: bool) -> Result<(), LogError> {
        self.drain(durable)?;
        if self.lost > 0 && !self.closed {
            let dropped = self.lost;
            self.lost = 0;
            self.emit(
                "log.suppressed",
                obj(json!({"dropped": dropped, "window_ms": 0, "reason": "sink-failed"})),
                &WriteFields::default(),
                true,
                None,
            )?;
            self.drain(durable)?;
        }
        if durable {
            self.sink.sync()?;
        }
        Ok(())
    }

    /// Writes the queue in order, one role-lock acquisition per batch; the final batch also syncs when `durable`. A
    /// failing batch keeps exactly the records that did not reach the file queued.
    fn drain(&mut self, durable: bool) -> Result<(), LogError> {
        while !self.pending.is_empty() {
            let batch: Vec<String> = self.pending.iter().take(MAX_BATCH).cloned().collect();
            let last = durable && self.pending.len() <= MAX_BATCH;
            let pending = &mut self.pending;
            self.sink.append_batch(&batch, last, &mut |count| {
                pending.drain(..count.min(pending.len()));
            })?;
        }
        Ok(())
    }

    #[allow(
        clippy::needless_pass_by_value,
        reason = "the attributes and the prepared text belong to this one record; every caller builds them for the call"
    )]
    fn emit(
        &mut self,
        event: &str,
        attrs: Map<String, Value>,
        fields: &WriteFields,
        internal: bool,
        prepared: Option<String>,
    ) -> Result<(), LogError> {
        if self.closed {
            return Err(LogError::Closed);
        }
        let source = fields.source.clone().unwrap_or_else(|| self.source.clone());
        let Some(entry) = lookup_event(event) else {
            if self.strict {
                return Err(LogError::Unregistered(event.to_string()));
            }
            let attempted = cap(&self.red_text(event), 128);
            return self.emit(
                "log.unregistered",
                obj(json!({ "attempted": attempted })),
                &WriteFields {
                    source: Some(source),
                    ..WriteFields::default()
                },
                true,
                None,
            );
        };
        if entry.stream != "diagnostic" {
            return Err(LogError::WrongStream);
        }
        let level = fields
            .level
            .or_else(|| entry.default_level())
            .ok_or(LogError::WrongStream)?;
        if !internal {
            let min = self.resolve_level(&source)?;
            if !level.at_least(min) {
                return Ok(());
            }
        }
        // The fixed failure event must survive the same broken policy that made the original record unavailable.
        let failed_policy = internal && event == "log.redaction.failed";
        let redacted = catch_unwind(AssertUnwindSafe(
            || -> Option<(Map<String, Value>, Source)> {
                let safe = if failed_policy {
                    let attempted = attrs
                        .get("attempted_event")
                        .and_then(Value::as_str)
                        .and_then(lookup_event)
                        .map_or("process.output.line", |e| e.event.as_str());
                    obj(json!({ "attempted_event": attempted }))
                } else if let Some(text) = &prepared {
                    let mut other = attrs.clone();
                    other.remove("text");
                    let mut safe = self.red_value(&Value::Object(other)).as_object().cloned()?;
                    safe.insert("text".into(), Value::String(text.clone()));
                    safe
                } else {
                    self.red_value(&Value::Object(attrs.clone()))
                        .as_object()
                        .cloned()?
                };
                let shown = if failed_policy {
                    Source::new("harness", "redaction", Some("0.1.0"))
                } else {
                    let mut parts = json!({"kind": source.kind, "id": source.id});
                    if let Some(v) = &source.version {
                        parts["version"] = json!(v);
                    }
                    let red = self.red_value(&parts);
                    Source {
                        kind: red["kind"].as_str()?.to_string(),
                        id: red["id"].as_str()?.to_string(),
                        version: red["version"].as_str().map(str::to_string),
                    }
                };
                Some((safe, shown))
            },
        ))
        .ok()
        .flatten();
        let Some((mut safe, shown)) = redacted else {
            return self.emit(
                "log.redaction.failed",
                obj(json!({ "attempted_event": entry.event })),
                &WriteFields {
                    source: Some(source),
                    ..WriteFields::default()
                },
                true,
                None,
            );
        };
        let trace = current_trace();
        let used = trace.clone().unwrap_or_else(new_trace);
        if let Some(link) = &used.link_trace_id {
            safe.insert("link_trace_id".into(), Value::String(link.clone()));
        }
        let mut record = Record {
            ts: iso_time(self.now())?,
            level,
            source: shown,
            event: event.to_string(),
            msg: entry.msg.clone().unwrap_or_default(),
            trace_id: used.trace_id.clone(),
            span_id: used.span_id.clone(),
            stream: fields.stream,
            attrs: safe,
        };
        fit(&mut record)?;
        let line = record.json();
        check(&line)?;
        if internal || level == Level::Fatal {
            self.enqueue_line(&line);
            return Ok(());
        }
        let key = {
            let mut src = json!({"kind": source.kind, "id": source.id});
            if let Some(v) = &source.version {
                src["version"] = json!(v);
            }
            let basis = json!([
                src,
                level.as_str(),
                event,
                fields.stream.map(OutStream::as_str),
                record.attrs,
                trace.map(|t| t.trace_id)
            ]);
            format!("{:x}", Sha256::digest(basis.to_string().as_bytes()))
        };
        let now = self.now();
        if let Some(&seq) = self.repeat_index.get(&key) {
            let within = self
                .repeats
                .get(&seq)
                .is_some_and(|(_, r)| now - r.start < lim().dedup_window_ms as i64);
            if within {
                if let Some((_, r)) = self.repeats.get_mut(&seq) {
                    r.count += 1;
                }
                return Ok(());
            }
            if let Some((_, prior)) = self.repeats.remove(&seq) {
                self.repeat_index.remove(&key);
                self.summarize(&prior)?;
            }
        }
        let bucket_key = format!("{}:{}", source.kind, source.id);
        let at = match self.buckets.iter().position(|b| b.key == bucket_key) {
            Some(at) => at,
            None => {
                self.buckets.push(Bucket {
                    key: bucket_key,
                    tokens: lim().rate_burst as f64,
                    at: now,
                    start: now,
                    dropped: 0,
                    source: source.clone(),
                });
                self.buckets.len() - 1
            }
        };
        let bucket = &mut self.buckets[at];
        let burst = lim().rate_burst as f64;
        bucket.tokens = burst.min(
            bucket.tokens
                + (now - bucket.at).max(0) as f64 * lim().rate_sustained_per_second as f64 / 1000.0,
        );
        bucket.at = now;
        if !fields.bypass_rate && bucket.tokens < 1.0 {
            bucket.dropped += 1;
            return Ok(());
        }
        if !fields.bypass_rate {
            bucket.tokens -= 1.0;
        }
        // Bounded dedup state; evicting emits the summary instead of losing its count.
        if self.repeats.len() >= 1000 {
            if let Some((&first, _)) = self.repeats.iter().next() {
                if let Some((old_key, old)) = self.repeats.remove(&first) {
                    self.repeat_index.remove(&old_key);
                    self.summarize(&old)?;
                }
            }
        }
        self.enqueue_line(&line);
        self.seq += 1;
        self.repeat_index.insert(key.clone(), self.seq);
        self.repeats.insert(
            self.seq,
            (
                key,
                Repeat {
                    record,
                    start: now,
                    count: 1,
                },
            ),
        );
        Ok(())
    }

    fn summarize(&mut self, repeat: &Repeat) -> Result<(), LogError> {
        if repeat.count > 1 {
            let mut record = repeat.record.clone();
            record.ts = iso_time(self.now())?;
            record.attrs.insert("repeat".into(), json!(repeat.count));
            record
                .attrs
                .insert("window_ms".into(), json!(lim().dedup_window_ms));
            fit(&mut record)?;
            self.enqueue(&record)?;
        }
        Ok(())
    }

    fn tick(&mut self, force: bool) -> Result<(), LogError> {
        let now = self.now();
        let window = lim().dedup_window_ms as i64;
        let due: Vec<u64> = self
            .repeats
            .iter()
            .filter(|(_, (_, r))| force || now - r.start >= window)
            .map(|(seq, _)| *seq)
            .collect();
        for seq in due {
            if let Some((key, repeat)) = self.repeats.remove(&seq) {
                self.repeat_index.remove(&key);
                self.summarize(&repeat)?;
            }
        }
        let mut drops = Vec::new();
        for bucket in &mut self.buckets {
            if bucket.dropped > 0 && (force || now - bucket.start >= 1000) {
                drops.push((
                    bucket.source.clone(),
                    bucket.dropped,
                    (now - bucket.start).max(0),
                ));
                bucket.dropped = 0;
                bucket.start = now;
            }
        }
        for (source, dropped, window_ms) in drops {
            self.emit(
                "log.suppressed",
                obj(json!({"dropped": dropped, "window_ms": window_ms, "reason": "rate-limit"})),
                &WriteFields {
                    source: Some(source),
                    ..WriteFields::default()
                },
                true,
                None,
            )?;
        }
        let own = self.source.clone();
        self.resolve_level(&own)?;
        if self.now() - self.last_prune >= DAY_MS {
            self.prune()?;
            self.last_prune = self.now();
        }
        Ok(())
    }

    fn prune(&mut self) -> Result<(), LogError> {
        let result = self.sink.prune()?;
        if result.files > 0 {
            self.emit(
                "log.retention.pruned",
                obj(json!({"stream": "diagnostic", "files": result.files, "bytes": result.bytes, "older_than_days": self.retention_days})),
                &WriteFields::default(),
                true,
                None,
            )?;
        }
        Ok(())
    }

    /// The exact-value policy for output lines: the injected policy's matcher, the registered values and the framer's own,
    /// rebuilt only when one of those changed.
    fn output_policy(&mut self, local: Option<&Arc<SecretMatcher>>) -> (Arc<SecretMatcher>, bool) {
        let registered = Some(Redactor::secret_matcher(&self.registered).clone());
        let next = [
            self.user.as_ref().and_then(|u| u.secret_matcher()),
            registered,
            local.cloned(),
        ];
        let same = |a: &Option<Arc<SecretMatcher>>, b: &Option<Arc<SecretMatcher>>| match (a, b) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        let pii = self.redact_pii || self.user.as_ref().is_some_and(|u| u.pii());
        let stale = match &self.output {
            Some(out) => out.inputs.iter().zip(next.iter()).any(|(a, b)| !same(a, b)),
            None => true,
        };
        if stale {
            let active: Vec<&Arc<SecretMatcher>> = next
                .iter()
                .flatten()
                .filter(|m| !m.forms().is_empty())
                .collect();
            let first = active
                .first()
                .map(|m| (*m).clone())
                .or_else(|| next[1].clone());
            let first = first.unwrap_or_else(|| Arc::new(SecretMatcher::new(Vec::new())));
            let membership: HashSet<&Vec<u16>> = first.forms().iter().collect();
            let mut seen: HashSet<Vec<u16>> = HashSet::new();
            let mut forms: Vec<Vec<u16>> = Vec::new();
            for matcher in &active {
                for form in matcher.forms() {
                    if seen.insert(form.clone()) {
                        forms.push(form.clone());
                    }
                }
            }
            let previous = self.output.as_ref().map(|o| o.matcher.clone());
            let unchanged = previous.as_ref().filter(|p| {
                let prev: HashSet<&Vec<u16>> = p.forms().iter().collect();
                forms.len() == prev.len() && forms.iter().all(|f| prev.contains(f))
            });
            let matcher = if let Some(p) = unchanged {
                p.clone()
            } else if active
                .iter()
                .all(|m| m.forms().iter().all(|f| membership.contains(f)))
            {
                first.clone()
            } else {
                Arc::new(SecretMatcher::new(forms))
            };
            let built = Redactor::new(RedactOptions {
                pii,
                secret_matcher: Some(matcher.clone()),
                ..RedactOptions::default()
            });
            // A policy that cannot be built leaves none: the next output line is then reported as
            // `log.redaction.failed` instead of being masked with a policy that lacks the newest values.
            self.output = built.ok().map(|redactor| OutputPolicy {
                redactor,
                matcher,
                inputs: next,
            });
        }
        match &self.output {
            Some(out) => (out.matcher.clone(), true),
            None => (Redactor::secret_matcher(&self.registered).clone(), false),
        }
    }

    fn write_output_line(
        &mut self,
        input: &OutputLineInput<'_>,
        local: Option<&Arc<SecretMatcher>>,
        transform: &mut dyn FnMut(&str) -> String,
    ) -> Result<(), LogError> {
        let (matcher, _) = self.output_policy(local);
        let user = self.user.clone();
        let produced = catch_unwind(AssertUnwindSafe(|| -> Option<String> {
            let out = self.output.as_ref()?;
            let mut text = if input.oversized {
                "[TRUNCATED:oversized-line]".to_string()
            } else {
                matcher
                    .mask_text_window_units(input.context, input.source_begin, input.source_end)
                    .ok()?
            };
            text = out.redactor.text(&transform(&text));
            // Arbitrary injected policies keep their transformations; native registry policies were combined above.
            if let Some(user) = &user {
                if user.secret_matcher().is_none() {
                    text = user.text(&text);
                }
            }
            let limit = lim().line_bytes;
            if text.len() > limit {
                let mut size = 0;
                let mut cut = String::new();
                for c in text.chars() {
                    if size + c.len_utf8() > limit {
                        break;
                    }
                    cut.push(c);
                    size += c.len_utf8();
                }
                text = cut;
            }
            Some(text)
        }))
        .ok()
        .flatten();
        let Some(text) = produced else {
            return self.emit(
                "log.redaction.failed",
                obj(json!({"attempted_event": "process.output.line"})),
                &WriteFields::default(),
                true,
                None,
            );
        };
        let mut attrs = obj(json!({"text": text, "untrusted": true}));
        if input.oversized || input.bytes > lim().line_bytes {
            attrs.insert("truncated".into(), Value::Bool(true));
            attrs.insert("bytes".into(), json!(input.bytes));
        }
        self.emit(
            "process.output.line",
            attrs,
            &WriteFields {
                stream: Some(input.stream),
                bypass_rate: true,
                ..WriteFields::default()
            },
            false,
            Some(text),
        )
    }

    fn write_legacy(
        &mut self,
        level: Level,
        msg: &str,
        fields: &Map<String, Value>,
    ) -> Result<(), LogError> {
        if self.closed {
            return Err(LogError::Closed);
        }
        let own = self.source.clone();
        let min = self.resolve_level(&own)?;
        if !level.at_least(min) {
            return Ok(());
        }
        let line = catch_unwind(AssertUnwindSafe(|| -> Option<String> {
            // Caller fields never replace the record's own keys (a `level` or `at` field would forge or hide the line).
            let renamed: Map<String, Value> = fields
                .iter()
                .map(|(k, v)| {
                    let key = if ["at", "level", "role", "msg"].contains(&k.as_str()) { format!("field_{k}") } else { k.clone() };
                    (key, v.clone())
                })
                .collect();
            let safe = self.red_value(&Value::Object(renamed)).as_object().cloned()?;
            let at = iso_time(self.now()).ok()?;
            let msg = cap(&self.red_text(msg), lim().msg_bytes);
            let mut line = format!(
                "{{\"at\":{},\"level\":{},\"role\":{}",
                json_str(&at),
                json_str(level.as_str()),
                json_str(&self.role)
            );
            for (k, v) in &safe {
                line.push_str(&format!(",{}:{}", json_str(k), v));
            }
            line.push_str(&format!(",\"msg\":{}}}", json_str(&msg)));
            if line.len() > lim().line_bytes {
                line = format!(
                    "{{\"at\":{},\"level\":{},\"role\":{},\"msg\":{},\"truncated\":true,\"bytes\":{}}}",
                    json_str(&at),
                    json_str(level.as_str()),
                    json_str(&self.role),
                    json_str(&msg),
                    line.len()
                );
            }
            Some(line)
        }))
        .ok()
        .flatten();
        let Some(line) = line else {
            return self.emit(
                "log.redaction.failed",
                obj(json!({"attempted_event": "log.unregistered"})),
                &WriteFields::default(),
                true,
                None,
            );
        };
        // Preserve synchronous diagnostic visibility without blocking every capture/recall on fsync. The timer and an
        // explicit flush/close sync the batch; warn/error still sync before returning.
        self.queue(format!("{line}\n"));
        self.auto_flush(level != Level::Info && level != Level::Debug);
        Ok(())
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

struct Shared {
    state: Mutex<State>,
    stop: Mutex<bool>,
    wake: Condvar,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stop(&self) {
        *self.stop.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.wake.notify_all();
    }
}

/// The diagnostic writer of one role.
pub struct Writer {
    shared: Arc<Shared>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

impl Writer {
    /// Opens the sink, applies the initial levels and prunes once; starts the timer thread unless `timers` is false.
    #[allow(
        clippy::needless_pass_by_value,
        reason = "the options are the writer's own configuration, built for this call; the fields are cloned into the state"
    )]
    pub fn new(o: WriterOptions) -> Result<Writer, LogError> {
        let now = o.now.clone().unwrap_or_else(system_clock);
        let mut sink_options = SinkOptions::new(o.dir.clone(), &o.role, now.clone());
        sink_options.max_bytes = o.max_bytes;
        sink_options.keep = o.keep;
        sink_options.retention_days = o.retention_days;
        sink_options.hooks = o.hooks.clone();
        sink_options.lock_timeout = o.lock_timeout;
        let sink = Sink::new(sink_options)?;
        let mut policy = LevelPolicy::new(now.clone(), None);
        let levels = o.levels.clone().unwrap_or_default();
        policy.update(&levels)?;
        let mut state = State {
            source: o.source.clone(),
            role: o.role.clone(),
            strict: o.strict,
            redact_pii: o.redact_pii,
            retention_days: o.retention_days.unwrap_or(14),
            last_prune: now(),
            now,
            sink,
            user: o.redactor.clone(),
            secrets: Vec::new(),
            pinned: Vec::new(),
            registered: Arc::new(build_redactor(o.redact_pii, Vec::new())?),
            output: None,
            closed: false,
            flushing: false,
            pending: Vec::new(),
            lost: 0,
            retry_at: 0,
            seq: 0,
            repeats: BTreeMap::new(),
            repeat_index: HashMap::new(),
            buckets: Vec::new(),
            policy,
            levels,
        };
        state.prune()?;
        let shared = Arc::new(Shared {
            state: Mutex::new(state),
            stop: Mutex::new(false),
            wake: Condvar::new(),
        });
        let timer = if o.timers {
            let weak = Arc::downgrade(&shared);
            let interval = o.timer_interval;
            std::thread::Builder::new()
                .name("plur1bus-log-timer".into())
                .spawn(move || loop {
                    let Some(shared) = weak.upgrade() else { break };
                    {
                        let stopped = shared.stop.lock().unwrap_or_else(PoisonError::into_inner);
                        let (stopped, _) = shared
                            .wake
                            .wait_timeout_while(stopped, interval, |s| !*s)
                            .unwrap_or_else(PoisonError::into_inner);
                        if *stopped {
                            break;
                        }
                    }
                    let mut state = shared.state();
                    if !state.closed {
                        // Records stay queued for the next flush when the sink fails.
                        let _ = state.tick(false);
                        let _ = state.flush(true);
                    }
                })
                .ok()
        } else {
            None
        };
        Ok(Writer {
            shared,
            timer: Mutex::new(timer),
        })
    }

    /// Writes one catalogued event.
    #[allow(
        clippy::needless_pass_by_value,
        reason = "attributes and fields are built for the call, as the TypeScript object literals are"
    )]
    pub fn write(&self, event: &str, attrs: Value, fields: WriteFields) -> Result<(), LogError> {
        self.shared
            .state()
            .emit(event, obj(attrs), &fields, false, None)
    }

    /// Writes the queue; `durable` also syncs the file.
    pub fn flush(&self, durable: bool) -> Result<(), LogError> {
        self.shared.state().flush(durable)
    }

    /// De-duplication summaries, rate-limit reports, level expiry and the daily prune; `force` closes every window.
    pub fn tick(&self, force: bool) -> Result<(), LogError> {
        self.shared.state().tick(force)
    }

    /// One timer step (`tick` then a durable `flush`), errors kept queued; what the timer thread does every interval.
    pub fn timer_tick(&self) {
        let mut state = self.shared.state();
        let _ = state.tick(false);
        let _ = state.flush(true);
    }

    /// The exact-value policy output lines are masked with (the framer's `local` matcher included).
    pub fn output_matcher(&self, local: Option<&Arc<SecretMatcher>>) -> Arc<SecretMatcher> {
        self.shared.state().output_policy(local).0
    }

    /// Trusted framing port: callers supply original source coordinates, never an already-redacted payload flag.
    /// `transform` runs between the exact-value masking and the pattern rules.
    pub fn write_output_line(
        &self,
        input: &OutputLineInput<'_>,
        local: Option<&Arc<SecretMatcher>>,
        transform: &mut dyn FnMut(&str) -> String,
    ) -> Result<(), LogError> {
        self.shared
            .state()
            .write_output_line(input, local, transform)
    }

    /// Applies this writer's live and manual policy to a text before any caller cuts it.
    pub fn redact_text(&self, text: &str) -> String {
        let state = self.shared.state();
        catch_unwind(AssertUnwindSafe(|| state.red_text(text)))
            .unwrap_or_else(|_| "[REDACTED:failed]".to_string())
    }

    /// Transitional callers retain `{at, role}`; one sink owns both formats until their catalogue migration.
    pub fn write_legacy(
        &self,
        level: Level,
        msg: &str,
        fields: &Map<String, Value>,
    ) -> Result<(), LogError> {
        self.shared.state().write_legacy(level, msg, fields)
    }

    /// Registers a secret value; `pinned` values are never displaced by the bound of 256 transient ones. An error
    /// means the policy could not be rebuilt: the policy in force is unchanged and does not mask the value, as in
    /// TypeScript (where the rebuild throws), so the caller must not discard the result. Not reachable while the
    /// embedded redaction data compiles, which `Writer::new` has already proved for this process.
    pub fn register_secret(&self, value: &str, pinned: bool) -> Result<(), LogError> {
        let mut state = self.shared.state();
        if pinned {
            state.secrets.retain(|v| v != value);
            if !state.pinned.iter().any(|v| v == value) {
                state.pinned.push(value.to_string());
            }
        } else {
            state.pinned.retain(|v| v != value);
            state.secrets.retain(|v| v != value);
            state.secrets.push(value.to_string());
        }
        if state.secrets.len() > 256 {
            state.secrets.remove(0);
        }
        let masked = state.masked();
        state.registered = Arc::new(build_redactor(state.redact_pii, masked)?);
        Ok(())
    }

    /// The levels in force (`currentLevels`).
    pub fn current_levels(&self) -> LevelSettings {
        let state = self.shared.state();
        LevelSettings {
            default_level: Some(state.levels.default_level.unwrap_or(Level::Info)),
            levels: state.levels.levels.clone(),
            trace_until: state.levels.trace_until,
        }
    }

    /// Replaces the levels and records each change as `log.level.changed`.
    pub fn update_levels(&self, settings: LevelSettings) -> Result<(), LogError> {
        let mut state = self.shared.state();
        state.policy.update(&settings)?;
        let kind = state.source.kind.clone();
        let table = |s: &LevelSettings| -> Vec<(String, Level)> {
            let mut map: BTreeMap<String, Level> = BTreeMap::new();
            map.insert(kind.clone(), s.default_level.unwrap_or(Level::Info));
            map.extend(s.levels.iter().map(|(k, v)| (k.clone(), *v)));
            map.into_iter().collect()
        };
        let (previous, next) = (table(&state.levels), table(&settings));
        let mut keys: Vec<String> = Vec::new();
        for (k, _) in previous.iter().chain(next.iter()) {
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
        let find = |t: &[(String, Level)], k: &str| t.iter().find(|(n, _)| n == k).map(|(_, l)| *l);
        for key in keys {
            let (before, after) = (find(&previous, &key), find(&next, &key));
            let to = after.or(settings.default_level).unwrap_or(Level::Info);
            if before != after {
                let mut attrs = obj(json!({"source_key": key, "to": to.as_str()}));
                if let Some(from) = before {
                    attrs.insert("from".into(), json!(from.as_str()));
                }
                state.emit(
                    "log.level.changed",
                    attrs,
                    &WriteFields::default(),
                    true,
                    None,
                )?;
            }
        }
        state.levels = settings;
        Ok(())
    }

    /// Changes the rotation size and the number of rotated copies kept.
    pub fn set_rotation(&self, max_bytes: f64, keep: i64) -> Result<(), LogError> {
        self.shared.state().sink.set_rotation(max_bytes, keep)
    }

    /// The live file, `<dir>/<role>.log`.
    pub fn file(&self) -> PathBuf {
        self.shared.state().sink.file().to_path_buf()
    }

    /// The log directory.
    pub fn dir(&self) -> PathBuf {
        let state = self.shared.state();
        state
            .sink
            .file()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
    }

    /// True once [`close`](Self::close) succeeded.
    pub fn is_closed(&self) -> bool {
        self.shared.state().closed
    }

    /// Stops the timer, closes every window, flushes durably and refuses further writes. Idempotent.
    pub fn close(&self) -> Result<(), LogError> {
        if self.shared.state().closed {
            return Ok(());
        }
        self.shared.stop();
        let handle = self
            .timer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(handle) = handle {
            if handle.thread().id() != std::thread::current().id() {
                let _ = handle.join();
            }
        }
        let mut state = self.shared.state();
        state.tick(true)?;
        state.flush(true)?;
        state.closed = true;
        state.secrets.clear();
        state.pinned.clear();
        Ok(())
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.shared.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::levels::LevelSettings;
    use crate::logs::sink::default_acquire_lock;
    use crate::logs::trace::{new_trace_from, with_trace};
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    const T0: i64 = 1_791_374_400_000;

    struct Fx {
        _root: tempfile::TempDir,
        dir: PathBuf,
        clock: Arc<AtomicI64>,
    }

    fn fx() -> Fx {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        Fx {
            _root: root,
            dir,
            clock: Arc::new(AtomicI64::new(T0)),
        }
    }

    fn source() -> Source {
        Source::new("harness", "core", Some("0.1.0"))
    }

    fn opts(f: &Fx) -> WriterOptions {
        let c = f.clock.clone();
        let mut o = WriterOptions::new(&f.dir, "core", source());
        o.now = Some(Arc::new(move || c.load(Ordering::SeqCst)));
        o.timers = false;
        o.hooks = SinkHooks {
            secure_path: Arc::new(|_, _| true),
            ..SinkHooks::default()
        };
        o.lock_timeout = Some(Duration::from_millis(60));
        o
    }

    fn lines(f: &Fx) -> Vec<Value> {
        std::fs::read_to_string(f.dir.join("core.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn raw(f: &Fx) -> Vec<String> {
        std::fs::read_to_string(f.dir.join("core.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn pid() -> Value {
        json!({"pid": 1})
    }

    #[test]
    fn a_written_record_validates_and_follows_the_key_order_of_the_schema() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        w.write("core.process.started", pid(), WriteFields::default())
            .unwrap();
        w.flush(true).unwrap();
        let lines = raw(&f);
        assert_eq!(lines.len(), 1);
        assert!(validate_line(&lines[0]).is_ok());
        let value: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(value["ts"], "2026-10-07T12:00:00.000Z");
        assert_eq!(
            value["source"],
            json!({"kind": "harness", "id": "core", "version": "0.1.0"})
        );
        // Present top-level keys appear in the order of `key_order()`.
        let order = plur1bus_log_schema::key_order();
        let at = |k: &str| lines[0].find(&format!("\"{k}\":")).unwrap();
        let present: Vec<&str> = order
            .iter()
            .copied()
            .filter(|k| value.get(*k).is_some())
            .collect();
        assert!(
            present.windows(2).all(|p| at(p[0]) < at(p[1])),
            "{present:?}"
        );
        assert!(lines[0].starts_with("{\"ts\":"));
        assert!(lines[0]
            .contains("\"source\":{\"kind\":\"harness\",\"id\":\"core\",\"version\":\"0.1.0\"}"));
    }

    #[test]
    fn a_source_without_a_version_is_written_with_a_null_version() {
        let f = fx();
        let mut o = opts(&f);
        o.source = Source::new("harness", "core", None);
        let w = Writer::new(o).unwrap();
        w.write("core.process.started", pid(), WriteFields::default())
            .unwrap();
        w.flush(true).unwrap();
        let lines = raw(&f);
        assert!(validate_line(&lines[0]).is_ok(), "{}", lines[0]);
        assert!(
            lines[0].contains("\"source\":{\"kind\":\"harness\",\"id\":\"core\",\"version\":null}")
        );
    }

    #[test]
    fn unregistered_events_are_reported_or_refused_and_audit_events_are_refused() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        w.write("nope.not.there", json!({}), WriteFields::default())
            .unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l[0]["event"], "log.unregistered");
        assert_eq!(l[0]["attrs"]["attempted"], "nope.not.there");
        assert_eq!(
            w.write("agent.create", json!({}), WriteFields::default())
                .unwrap_err()
                .to_string(),
            "diagnostic writer cannot write audit or payload"
        );
        let g = fx();
        let mut o = opts(&g);
        o.strict = true;
        let w = Writer::new(o).unwrap();
        assert_eq!(
            w.write("nope.not.there", json!({}), WriteFields::default())
                .unwrap_err()
                .to_string(),
            "unregistered log event: nope.not.there"
        );
    }

    #[test]
    fn invalid_attributes_throw_with_the_validators_code() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let err = w
            .write("core.process.started", json!({}), WriteFields::default())
            .unwrap_err();
        assert!(
            err.to_string()
                .starts_with("invalid log record: attrs_invalid"),
            "{err}"
        );
    }

    #[test]
    fn identical_records_inside_the_window_are_counted_and_summarised_once() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        for _ in 0..5 {
            w.write("core.process.started", pid(), WriteFields::default())
                .unwrap();
        }
        w.flush(true).unwrap();
        assert_eq!(lines(&f).len(), 1);
        f.clock.fetch_add(61_000, Ordering::SeqCst);
        w.tick(false).unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l.len(), 2);
        assert_eq!(l[1]["attrs"]["repeat"], 5);
        assert_eq!(l[1]["attrs"]["window_ms"], 60_000);
        // a different attribute is a different record
        w.write(
            "core.process.started",
            json!({"pid": 2}),
            WriteFields::default(),
        )
        .unwrap();
        w.flush(true).unwrap();
        assert_eq!(lines(&f).len(), 3);
    }

    #[test]
    fn the_rate_limit_drops_beyond_the_burst_and_reports_it() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        for n in 0..510 {
            w.write(
                "core.process.started",
                json!({ "pid": n }),
                WriteFields::default(),
            )
            .unwrap();
        }
        w.flush(true).unwrap();
        assert_eq!(lines(&f).len(), 500);
        f.clock.fetch_add(1000, Ordering::SeqCst);
        w.tick(false).unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        let report = l.last().unwrap();
        assert_eq!(report["event"], "log.suppressed");
        assert_eq!(report["attrs"]["dropped"], 10);
        assert_eq!(report["attrs"]["reason"], "rate-limit");
    }

    #[test]
    fn levels_filter_and_changes_and_trace_expiry_are_recorded() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let job = json!({"job": "j"});
        w.write("scheduler.run.started", job.clone(), WriteFields::default())
            .unwrap();
        w.flush(true).unwrap();
        assert!(lines(&f).is_empty(), "debug is below the default info");
        let mut settings = w.current_levels();
        settings.default_level = Some(Level::Debug);
        w.update_levels(settings).unwrap();
        w.write("scheduler.run.started", job, WriteFields::default())
            .unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l[0]["event"], "log.level.changed");
        assert_eq!(
            l[0]["attrs"],
            json!({"source_key": "harness", "from": "info", "to": "debug"})
        );
        assert_eq!(l.len(), 2);
        // trace needs a future expiry, lapses once
        let mut trace = w.current_levels();
        trace.default_level = Some(Level::Trace);
        assert!(w.update_levels(trace.clone()).is_err());
        trace.trace_until = Some(T0 + 1000);
        w.update_levels(trace).unwrap();
        f.clock.fetch_add(2000, Ordering::SeqCst);
        w.tick(false).unwrap();
        w.tick(false).unwrap();
        w.flush(true).unwrap();
        let expired = lines(&f)
            .into_iter()
            .filter(|r| r["event"] == "log.level.expired")
            .count();
        assert_eq!(expired, 1);
    }

    #[test]
    fn a_registered_secret_never_reaches_the_file_in_attrs_source_or_text() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let secret = "fixture-secret-0123456789-abcdef";
        w.register_secret(secret, false).unwrap();
        w.write("nope.not.there", json!({}), WriteFields::default())
            .unwrap();
        w.write(
            "core.process.started",
            json!({"pid": 3, "note": secret}),
            WriteFields::default(),
        )
        .ok();
        w.write(
            "process.output.line",
            json!({"text": format!("x {secret} y"), "untrusted": true}),
            WriteFields {
                stream: Some(OutStream::Stdout),
                ..WriteFields::default()
            },
        )
        .unwrap();
        w.flush(true).unwrap();
        let text = std::fs::read_to_string(f.dir.join("core.log")).unwrap();
        assert!(!text.contains(secret), "{text}");
        assert!(text.contains("[REDACTED:secret]"));
    }

    #[test]
    fn a_panicking_redactor_yields_the_fixed_redaction_failed_record() {
        struct Boom;
        impl TextRedactor for Boom {
            fn text(&self, _: &str) -> String {
                panic!("boom")
            }
            fn value(&self, _: &Value) -> Value {
                panic!("boom")
            }
        }
        let f = fx();
        let mut o = opts(&f);
        o.redactor = Some(Arc::new(Boom));
        let w = Writer::new(o).unwrap();
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let r = w.write("core.process.started", pid(), WriteFields::default());
        std::panic::set_hook(hook);
        r.unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["event"], "log.redaction.failed");
        assert_eq!(
            l[0]["source"],
            json!({"kind": "harness", "id": "redaction", "version": "0.1.0"})
        );
        assert_eq!(l[0]["attrs"]["attempted_event"], "core.process.started");
    }

    #[test]
    fn oversized_attributes_are_cut_and_marked() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let big = "é".repeat(5000);
        w.write(
            "process.output.line",
            json!({"text": big, "untrusted": true}),
            WriteFields {
                stream: Some(OutStream::Stderr),
                bypass_rate: true,
                ..WriteFields::default()
            },
        )
        .unwrap();
        w.flush(true).unwrap();
        let line = &raw(&f)[0];
        assert!(line.len() <= 4096, "{}", line.len());
        let v: Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["attrs"]["truncated"], true);
        assert!(v["attrs"]["bytes"].as_u64().unwrap() > 8000);
        assert!(validate_line(line).is_ok());
    }

    #[test]
    fn cap_never_cuts_a_code_point_and_marks_the_cut() {
        assert_eq!(cap("abc", 3), "abc");
        assert_eq!(cap("abcdef", 6), "abcdef");
        assert_eq!(cap("abcdefg", 6), "abc…");
        assert_eq!(cap("a😀😀b", 6), "a…");
        assert_eq!(cap("é", 1), "…");
    }

    #[test]
    fn iso_time_matches_to_iso_string() {
        assert_eq!(iso_time(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(T0 + 123).unwrap(), "2026-10-07T12:00:00.123Z");
        assert_eq!(
            iso_time(951_782_400_000).unwrap(),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(iso_time(-1).unwrap(), "1969-12-31T23:59:59.999Z");
        assert!(iso_time(253_402_300_800_000).is_err());
    }

    #[test]
    fn the_trace_context_of_the_caller_is_used_and_linked() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let mut ctx = new_trace_from([7; 16], [9; 8]);
        ctx.link_trace_id = Some("a".repeat(32));
        let (t, s) = (ctx.trace_id.clone(), ctx.span_id.clone());
        with_trace(ctx, || {
            w.write("core.process.started", pid(), WriteFields::default())
        })
        .unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l[0]["trace_id"], t);
        assert_eq!(l[0]["span_id"], s);
        assert_eq!(l[0]["attrs"]["link_trace_id"], "a".repeat(32));
    }

    #[test]
    fn writes_are_batched_under_one_lock_and_a_failing_sink_keeps_the_queue() {
        let f = fx();
        let locks = Arc::new(AtomicUsize::new(0));
        let l2 = locks.clone();
        let mut o = opts(&f);
        o.hooks.acquire_lock = Arc::new(move |p: &Path| {
            if p.to_string_lossy().ends_with("core.log.writer-lock") {
                l2.fetch_add(1, Ordering::SeqCst);
            }
            default_acquire_lock(p)
        });
        let w = Writer::new(o).unwrap();
        locks.store(0, Ordering::SeqCst);
        for n in 0..10 {
            w.write(
                "core.process.started",
                json!({ "pid": n }),
                WriteFields::default(),
            )
            .unwrap();
        }
        assert_eq!(
            locks.load(Ordering::SeqCst),
            0,
            "info records wait for the flush"
        );
        w.flush(true).unwrap();
        assert_eq!(locks.load(Ordering::SeqCst), 1);
        assert_eq!(lines(&f).len(), 10);
        // a held lock: the records stay queued and are written by the next flush
        let held = default_acquire_lock(&f.dir.join("core.log.writer-lock"))
            .unwrap()
            .unwrap();
        w.write(
            "core.process.started",
            json!({"pid": 99}),
            WriteFields::default(),
        )
        .unwrap();
        assert_eq!(w.flush(true).unwrap_err().to_string(), "log writer busy");
        drop(held);
        w.flush(true).unwrap();
        assert_eq!(lines(&f).len(), 11);
    }

    #[test]
    fn the_queue_is_bounded_and_the_loss_is_reported_when_the_sink_returns() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let held = default_acquire_lock(&f.dir.join("core.log.writer-lock"))
            .unwrap()
            .unwrap();
        for n in 0..300 {
            w.write(
                "core.process.started",
                json!({ "pid": n }),
                WriteFields::default(),
            )
            .unwrap();
        }
        drop(held);
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l.len(), 257);
        assert_eq!(l[0]["attrs"]["pid"], 44);
        let report = l.last().unwrap();
        assert_eq!(report["event"], "log.suppressed");
        assert_eq!(
            report["attrs"],
            json!({"dropped": 44, "window_ms": 0, "reason": "sink-failed"})
        );
    }

    #[test]
    fn legacy_lines_keep_their_shape_redact_and_never_forge_their_own_keys() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let secret = "fixture-legacy-0123456789-abcdef";
        w.register_secret(secret, true).unwrap();
        let mut fields = Map::new();
        fields.insert("level".into(), json!("fatal"));
        fields.insert("at".into(), json!("never"));
        fields.insert("note".into(), json!(secret));
        w.write_legacy(Level::Warn, &format!("hello {secret}"), &fields)
            .unwrap();
        let line = &raw(&f)[0];
        assert!(!line.contains(secret));
        let v: Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["level"], "warn");
        assert_eq!(v["role"], "core");
        assert_eq!(v["field_level"], "fatal");
        assert_eq!(v["field_at"], "never");
        assert_eq!(v["msg"], "hello [REDACTED:secret]");
        assert!(line.starts_with(
            "{\"at\":\"2026-10-07T12:00:00.000Z\",\"level\":\"warn\",\"role\":\"core\""
        ));
        assert!(line.ends_with("\"msg\":\"hello [REDACTED:secret]\"}"));
        let mut huge = Map::new();
        huge.insert("blob".into(), json!("lorem ipsum dolor ".repeat(350)));
        w.write_legacy(Level::Warn, "big", &huge).unwrap();
        let big: Value = serde_json::from_str(raw(&f).last().unwrap()).unwrap();
        assert_eq!(big["truncated"], true);
        assert!(big["bytes"].as_u64().unwrap() > 6000);
    }

    #[test]
    fn warnings_sync_at_once_and_info_waits_for_the_flush() {
        let f = fx();
        let syncs = Arc::new(AtomicUsize::new(0));
        let s2 = syncs.clone();
        let mut o = opts(&f);
        o.hooks.fsync = Arc::new(move |file| {
            s2.fetch_add(1, Ordering::SeqCst);
            file.sync_all()
        });
        let w = Writer::new(o).unwrap();
        let none = Map::new();
        w.write_legacy(Level::Info, "i", &none).unwrap();
        assert_eq!(syncs.load(Ordering::SeqCst), 0);
        assert_eq!(raw(&f).len(), 1, "info is visible at once");
        w.write_legacy(Level::Warn, "w", &none).unwrap();
        assert_eq!(syncs.load(Ordering::SeqCst), 1);
        w.write_legacy(Level::Info, "i2", &none).unwrap();
        w.flush(true).unwrap();
        assert_eq!(syncs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_timer_thread_flushes_and_close_is_final_and_idempotent() {
        let f = fx();
        let mut o = opts(&f);
        o.timers = true;
        o.timer_interval = Duration::from_millis(20);
        let w = Writer::new(o).unwrap();
        w.write("core.process.started", pid(), WriteFields::default())
            .unwrap();
        let mut waited = 0;
        while raw(&f).is_empty() && waited < 100 {
            std::thread::sleep(Duration::from_millis(10));
            waited += 1;
        }
        assert_eq!(raw(&f).len(), 1);
        w.close().unwrap();
        w.close().unwrap();
        assert!(w.is_closed());
        assert_eq!(
            w.write("core.process.started", pid(), WriteFields::default())
                .unwrap_err()
                .to_string(),
            "log writer closed"
        );
        assert_eq!(
            w.write_legacy(Level::Warn, "x", &Map::new())
                .unwrap_err()
                .to_string(),
            "log writer closed"
        );
    }

    #[test]
    fn close_summarises_open_windows() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        for _ in 0..3 {
            w.write("core.process.started", pid(), WriteFields::default())
                .unwrap();
        }
        w.close().unwrap();
        let l = lines(&f);
        assert_eq!(l.len(), 2);
        assert_eq!(l[1]["attrs"]["repeat"], 3);
    }

    #[test]
    fn pruning_reports_removed_rotations() {
        let f = fx();
        std::fs::create_dir_all(&f.dir).unwrap();
        let old = f.dir.join("core.log.1");
        std::fs::write(&old, "12345").unwrap();
        let t = std::time::UNIX_EPOCH + Duration::from_millis((T0 - 40 * DAY_MS) as u64);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(t))
            .unwrap();
        let w = Writer::new(opts(&f)).unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l[0]["event"], "log.retention.pruned");
        assert_eq!(
            l[0]["attrs"],
            json!({"stream": "diagnostic", "files": 1, "bytes": 5, "older_than_days": 14})
        );
    }

    #[test]
    fn output_lines_use_the_combined_policy_and_cut_after_masking() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let secret = "fixture-output-0123456789-abcdef";
        w.register_secret(secret, false).unwrap();
        let text: Vec<u16> = format!("go {secret} end").encode_utf16().collect();
        let input = OutputLineInput {
            context: &text,
            source_begin: 0,
            source_end: text.len(),
            bytes: text.len(),
            stream: OutStream::Stdout,
            oversized: false,
        };
        w.write_output_line(&input, None, &mut |t| t.to_string())
            .unwrap();
        let framed = OutputLineInput {
            oversized: true,
            ..input
        };
        w.write_output_line(&framed, None, &mut |t| t.to_string())
            .unwrap();
        w.flush(true).unwrap();
        let l = lines(&f);
        assert_eq!(l[0]["attrs"]["text"], "go [REDACTED:secret] end");
        assert_eq!(l[0]["stream"], "stdout");
        assert_eq!(l[1]["attrs"]["text"], "[TRUNCATED:oversized-line]");
        assert_eq!(l[1]["attrs"]["truncated"], true);
        // the policy is rebuilt only when a matcher changed
        let a = w.output_matcher(None);
        let b = w.output_matcher(None);
        assert!(Arc::ptr_eq(&a, &b));
        w.register_secret("fixture-output-second-0123456789", false)
            .unwrap();
        assert!(!Arc::ptr_eq(&a, &w.output_matcher(None)));
    }

    /// `startup-redaction.test.ts`: a populated live policy applies from the first record, a value registered in the set
    /// later is masked at once, and a manual registration on the writer is additive.
    #[test]
    fn a_live_policy_masks_from_the_first_record_and_manual_registrations_add() {
        use crate::logs::redact::SecretSet;
        let set = Arc::new(SecretSet::new());
        let (first, second, third) = (
            "fixture-live-first-0123456789",
            "fixture-live-second-0123456789",
            "fixture-manual-third-0123456789",
        );
        set.register(first);
        let f = fx();
        let mut o = opts(&f);
        o.redactor = Some(Arc::new(set.redactor(false, false)));
        let w = Writer::new(o).unwrap();
        let line = |text: String| {
            w.write(
                "process.output.line",
                json!({"text": text, "untrusted": true}),
                WriteFields {
                    stream: Some(OutStream::Stdout),
                    bypass_rate: true,
                    ..WriteFields::default()
                },
            )
            .unwrap();
        };
        line(format!("a {first}"));
        set.register(second);
        line(format!("b {second}"));
        w.register_secret(third, false).unwrap();
        line(format!("c {third} {first}"));
        w.flush(true).unwrap();
        let texts: Vec<String> = lines(&f)
            .iter()
            .map(|r| r["attrs"]["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            texts,
            [
                "a [REDACTED:secret]",
                "b [REDACTED:secret]",
                "c [REDACTED:secret] [REDACTED:secret]"
            ]
        );
    }

    #[test]
    fn level_settings_default_is_info_and_a_copy_is_returned() {
        let f = fx();
        let w = Writer::new(opts(&f)).unwrap();
        let cur = w.current_levels();
        assert_eq!(
            cur,
            LevelSettings {
                default_level: Some(Level::Info),
                ..LevelSettings::default()
            }
        );
    }
}
