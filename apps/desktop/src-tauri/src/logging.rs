//! Desktop-local D111 logging foundation. No hooks, files, IPC or threads are installed on import.
//!
//! Integration: create an existing private app log directory, a shared secret registry/formatter,
//! then one `Writer` per owned directory. Register credentials before use; call `tick` at least once
//! per minute (also before shutdown) to flush dedup windows, expiry and daily retention while idle.
//! Use only typed native events. This module accepts no foreign bodies, panel URLs or transcripts.
mod redaction;
mod schema;
pub(crate) mod storage;
pub use redaction::*;
pub use schema::*;

use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use schema::{entry, Record};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fmt,
    fs::File,
    io::{self, Write},
    path::Path,
    sync::{Arc, Mutex},
};
use storage::OwnedDirectory;

#[derive(Debug)]
pub enum LogError {
    Invalid(&'static str),
    Unregistered,
    Busy,
    Io(io::Error),
    Serialization,
}
impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "invalid diagnostic metadata: {reason}"),
            Self::Unregistered => f.write_str("unregistered diagnostic event"),
            Self::Busy => f.write_str("diagnostic writer unavailable"),
            Self::Io(_) => f.write_str("diagnostic storage unavailable"),
            Self::Serialization => f.write_str("diagnostic serialization failed"),
        }
    }
}
impl std::error::Error for LogError {}
impl From<io::Error> for LogError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<serde_json::Error> for LogError {
    fn from(_: serde_json::Error) -> Self {
        Self::Serialization
    }
}
pub type Result<T, E = LogError> = std::result::Result<T, E>;

pub trait LogClock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}
pub struct SystemClock;
impl LogClock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}
/// Production: 5 MiB per file, seven files, 14 days, 200 recent lines, 60-second dedup.
/// Smaller file/count limits are injectable for deterministic tests. They cannot exceed production caps.
#[derive(Clone, Debug)]
pub struct Limits {
    pub max_file_bytes: u64,
    pub keep_files: usize,
    pub retention_days: u32,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 5 * 1024 * 1024,
            keep_files: 7,
            retention_days: 14,
        }
    }
}
#[derive(Clone, Debug)]
pub struct WriterOptions {
    pub source: SourceId,
    pub version: Option<String>,
    pub levels: LevelPolicy,
    pub limits: Limits,
}
impl Default for WriterOptions {
    fn default() -> Self {
        Self {
            source: SourceId::Shell,
            version: Some(env!("CARGO_PKG_VERSION").into()),
            levels: LevelPolicy::default(),
            limits: Limits::default(),
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum EmitStatus {
    Written,
    Filtered,
    Deduplicated,
    RedactionFailed,
}
struct Dedup {
    started: DateTime<Utc>,
    count: u64,
    record: Record,
}
struct State {
    levels: LevelPolicy,
    expired: bool,
    current: Option<String>,
    day: NaiveDate,
    recent: VecDeque<String>,
    dedup: HashMap<(SourceId, String, Option<ErrorCode>), Dedup>,
    registry_failures_reported: u64,
}
struct Inner {
    directory: Arc<OwnedDirectory>,
    options: WriterOptions,
    formatter: Formatter,
    clock: Arc<dyn LogClock>,
    state: Mutex<State>,
}
/// One native writer owns one directory; clones share state and redaction. No raw-line sink is public.
#[derive(Clone)]
pub struct Writer(Arc<Inner>, SourceId);
impl Writer {
    /// Bind a native source to the same directory, formatter, rotation and recent-log buffer.
    pub fn for_source(&self, source: SourceId) -> Self {
        Self(self.0.clone(), source)
    }
    pub fn open(
        directory: &Path,
        options: WriterOptions,
        formatter: Formatter,
        clock: Arc<dyn LogClock>,
    ) -> Result<Self> {
        let now = clock.now();
        options.levels.validate_loaded(now)?;
        if options.limits.max_file_bytes < 1024
            || options.limits.max_file_bytes > 5 * 1024 * 1024
            || options.limits.keep_files == 0
            || options.limits.keep_files > 7
            || options.limits.retention_days == 0
            || options.limits.retention_days > 14
            || options.version.as_ref().is_some_and(|v| v.len() > 1024)
        {
            return Err(LogError::Invalid("writer limits"));
        }
        let directory = Arc::new(OwnedDirectory::open(directory)?);
        let state = State {
            levels: options.levels.clone(),
            expired: false,
            current: None,
            day: now.date_naive(),
            recent: VecDeque::with_capacity(200),
            dedup: HashMap::new(),
            registry_failures_reported: 0,
        };
        let source = options.source;
        let writer = Self(
            Arc::new(Inner {
                directory,
                options,
                formatter,
                clock,
                state: Mutex::new(state),
            }),
            source,
        );
        {
            let mut state = writer.0.state.lock().map_err(|_| LogError::Busy)?;
            writer.prune(&mut state, now)?;
            writer.maintenance(&mut state, now)?;
        }
        Ok(writer)
    }
    /// Emit a closed native event. Validation happens before any file mutation; every sink sees redacted bytes.
    pub fn emit(&self, input: RecordInput) -> Result<EmitStatus> {
        input.validate()?;
        let now = self.0.clock.now();
        let mut state = self.0.state.lock().map_err(|_| LogError::Busy)?;
        self.maintenance(&mut state, now)?;
        let mut record = Record::new(input, self.1, self.0.options.version.clone(), now);
        if record.level < state.levels.resolve(self.1, now) {
            return Ok(EmitStatus::Filtered);
        }
        let failures = self.0.formatter.registration_failures();
        if failures > state.registry_failures_reported {
            let warning = Record::new(
                RecordInput::new(Event::RegistrySaturated { failures }),
                self.1,
                None,
                now,
            );
            self.write(&mut state, &warning, now)?;
            state.registry_failures_reported = failures;
        }
        if self.format(&mut record).is_err() {
            self.redaction_failed(&mut state, now, &record.event)?;
            return Ok(EmitStatus::RedactionFailed);
        }
        let key = (
            self.1,
            record.event.clone(),
            record.err.as_ref().map(|e| e.code),
        );
        if record.level != Level::Fatal {
            if let Some(previous) = state.dedup.get_mut(&key) {
                previous.count = previous.count.saturating_add(1);
                return Ok(EmitStatus::Deduplicated);
            }
        }
        self.write(&mut state, &record, now)?;
        if record.level != Level::Fatal {
            state.dedup.insert(
                key,
                Dedup {
                    started: now,
                    count: 1,
                    record,
                },
            );
        }
        Ok(EmitStatus::Written)
    }
    /// Compatibility boundary for native event-name dispatch. Known names still use closed attrs.
    /// Unknown names reject in debug/test builds; release emits only a redacted `log.unregistered` record.
    pub fn emit_named(&self, name: &str, attrs: Value) -> Result<EmitStatus> {
        if entry(name).is_some() {
            return self.emit(RecordInput::new(Event::from_registered(name, attrs)?));
        }
        if cfg!(debug_assertions) {
            return Err(LogError::Unregistered);
        }
        // Drop oversized input in its entirety; never cut a possible secret before redaction.
        let attempted = if name.len() > 8192 {
            "[REDACTED:limit]".into()
        } else {
            name.into()
        };
        self.emit(RecordInput::new(Event::Unregistered { attempted }))
    }
    pub fn effective_level(&self) -> Result<Level> {
        let state = self.0.state.lock().map_err(|_| LogError::Busy)?;
        Ok(state.levels.resolve(self.1, self.0.clock.now()))
    }
    /// Apply live preferences; trace requires a fresh future expiry. Does not persist or mutate caller config.
    pub fn set_levels(&self, levels: LevelPolicy) -> Result<()> {
        let now = self.0.clock.now();
        levels.validate(now)?;
        let mut state = self.0.state.lock().map_err(|_| LogError::Busy)?;
        let from = state.levels.resolve(self.1, now);
        let to = levels.resolve(self.1, now);
        state.levels = levels;
        state.expired = false;
        self.internal(&mut state, now, Event::LevelChanged { from, to })
    }
    /// Drive from a native timer at most one minute apart, and before shutdown. Flushes expired dedup windows.
    pub fn tick(&self) -> Result<()> {
        let mut state = self.0.state.lock().map_err(|_| LogError::Busy)?;
        self.maintenance(&mut state, self.0.clock.now())
    }
    /// Nonblocking, sanitized snapshot: safe to request while handling a panic in the writer itself.
    pub fn recent_lines(&self) -> Result<Vec<String>> {
        let state = self.0.state.try_lock().map_err(|_| LogError::Busy)?;
        Ok(state.recent.iter().cloned().collect())
    }
    pub(crate) fn directory(&self) -> Arc<OwnedDirectory> {
        self.0.directory.clone()
    }
    pub(crate) fn directory_path(&self) -> &Path {
        self.0.directory.path()
    }
    pub(crate) fn formatter(&self) -> &Formatter {
        &self.0.formatter
    }
    pub(crate) fn version(&self) -> Option<&str> {
        self.0.options.version.as_deref()
    }
    pub(crate) fn crash_redaction_failed(&self) -> Result<()> {
        let mut state = self.0.state.lock().map_err(|_| LogError::Busy)?;
        self.redaction_failed(&mut state, self.0.clock.now(), "desktop.app.crashed")
    }
    pub(crate) fn sanitize_record_line(
        &self,
        line: &str,
    ) -> std::result::Result<String, RedactionError> {
        let value: Value = serde_json::from_str(line).map_err(|_| RedactionError::InputLimit)?;
        validate_record(&value).map_err(|_| RedactionError::InputLimit)?;
        let mut record: Record =
            serde_json::from_value(value).map_err(|_| RedactionError::InputLimit)?;
        self.format(&mut record)?;
        serde_json::to_string(&record).map_err(|_| RedactionError::InputLimit)
    }
    fn format(&self, record: &mut Record) -> std::result::Result<(), RedactionError> {
        if self.0.formatter.registration_failures() > 0 {
            // Retain fixed catalogue metadata; remove all caller-controlled strings.
            // Credentials are never evicted merely to keep the log alive.
            record.source.version = None;
            record.trace_id = None;
            record.span_id = None;
            if let Some(error) = &mut record.err {
                error.reason = "[REDACTED:registry]".into();
            }
            if let Some(attrs) = record.attrs.as_mut().and_then(Value::as_object_mut) {
                for key in ["crash_id", "sha256", "attempted"] {
                    if let Some(value) = attrs.get_mut(key) {
                        *value = json!("[REDACTED:registry]");
                    }
                }
                if let Some(id) = attrs.get_mut("connection_id") {
                    *id = json!(uuid::Uuid::nil());
                }
            }
            return validate_record(
                &serde_json::to_value(record).map_err(|_| RedactionError::InputLimit)?,
            )
            .map_err(|_| RedactionError::InputLimit);
        }
        // Typed envelope is retained; free text is formatted without applying the generic `code` key rule to err.code.
        if let Some(version) = &mut record.source.version {
            *version = self.0.formatter.redact_text(version)?;
        }
        let msg = self.0.formatter.redact_text(&record.msg)?;
        // A registered secret colliding with a fixed message must drop the event, never change its template.
        if msg != record.msg || msg.len() > 2048 {
            return Err(RedactionError::InputLimit);
        }
        if let Some(error) = &mut record.err {
            error.reason = self.0.formatter.redact_text(&error.reason)?;
        }
        if let Some(attrs) = &mut record.attrs {
            *attrs = self.0.formatter.redact_json(attrs)?;
            if serde_json::to_vec(attrs)
                .map_err(|_| RedactionError::InputLimit)?
                .len()
                > 8192
            {
                // Only the unregistered name is free-form. Its original has already been redacted.
                if record.event == "log.unregistered" {
                    *attrs = json!({"attempted":"[REDACTED:limit]"});
                } else {
                    return Err(RedactionError::InputLimit);
                }
            }
        }
        validate_record(&serde_json::to_value(record).map_err(|_| RedactionError::InputLimit)?)
            .map_err(|_| RedactionError::InputLimit)
    }
    fn internal(&self, state: &mut State, now: DateTime<Utc>, event: Event) -> Result<()> {
        let mut record = Record::new(
            RecordInput::new(event),
            self.1,
            self.0.options.version.clone(),
            now,
        );
        if self.format(&mut record).is_err() {
            return self.redaction_failed(state, now, &record.event);
        }
        self.write(state, &record, now)
    }
    fn redaction_failed(&self, state: &mut State, now: DateTime<Utc>, event: &str) -> Result<()> {
        // The fail-closed formatter result: fixed constants + registered enum metadata only, no original fields.
        let code = entry(event)
            .map(|e| e.event.clone())
            .unwrap_or_else(|| "log.unregistered".into());
        let safe = Record::new(
            RecordInput::new(Event::RedactionFailed { event: code }),
            self.1,
            None,
            now,
        );
        self.write(state, &safe, now)
    }
    fn maintenance(&self, state: &mut State, now: DateTime<Utc>) -> Result<()> {
        if state.levels.has_trace()
            && !state.expired
            && state.levels.trace_until.is_some_and(|until| until <= now)
        {
            self.internal(state, now, Event::LevelExpired)?;
            state.expired = true;
        }
        let expired: Vec<_> = state
            .dedup
            .iter()
            .filter(|(_, d)| now.signed_duration_since(d.started) >= TimeDelta::seconds(60))
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            if let Some(dedup) = state.dedup.remove(&key) {
                if dedup.count > 1 {
                    let mut record = dedup.record;
                    record.ts = schema::timestamp(now);
                    let attrs = record.attrs.get_or_insert_with(|| json!({}));
                    attrs["repeat"] = json!(dedup.count);
                    attrs["window_ms"] = json!(60000);
                    // New registrations are also honored for buffered records.
                    if self.format(&mut record).is_err() {
                        self.redaction_failed(state, now, &record.event)?;
                    } else {
                        self.write(state, &record, now)?;
                    }
                }
            }
        }
        if now.date_naive() != state.day {
            state.day = now.date_naive();
            state.current = None;
            self.prune(state, now)?;
        }
        Ok(())
    }
    fn files(&self) -> Result<Vec<(NaiveDate, u32, String)>> {
        let mut files: Vec<_> = self
            .0
            .directory
            .names()?
            .into_iter()
            .filter_map(|name| parse_log_name(&name).map(|(day, index)| (day, index, name)))
            .filter(|(_, _, name)| self.0.directory.len(name).is_ok())
            .collect();
        files.sort();
        Ok(files)
    }
    fn prune(&self, state: &mut State, now: DateTime<Utc>) -> Result<()> {
        let mut files = self.files()?;
        let cutoff =
            now.date_naive() - TimeDelta::days(self.0.options.limits.retention_days as i64);
        let mut pruned = 0;
        files.retain(|(day, _, _)| *day <= cutoff);
        for (_, _, name) in files {
            self.0.directory.remove(&name)?;
            if state.current.as_ref() == Some(&name) {
                state.current = None;
            }
            pruned += 1;
        }
        let files = self.files()?;
        let excess = files.len().saturating_sub(self.0.options.limits.keep_files);
        for (_, _, name) in files.into_iter().take(excess) {
            self.0.directory.remove(&name)?;
            if state.current.as_ref() == Some(&name) {
                state.current = None;
            }
            pruned += 1;
        }
        if pruned > 0 {
            self.internal(state, now, Event::RetentionPruned { files: pruned })?;
        }
        Ok(())
    }
    fn write(&self, state: &mut State, record: &Record, now: DateTime<Utc>) -> Result<()> {
        validate_record(&serde_json::to_value(record)?)?;
        let mut line = serde_json::to_string(record)?;
        line.push('\n');
        if line.len() as u64 > self.0.options.limits.max_file_bytes {
            return Err(LogError::Invalid("record exceeds file budget"));
        }
        let day = now.date_naive();
        if state
            .current
            .as_ref()
            .is_some_and(|name| parse_log_name(name).is_none_or(|(d, _)| d != day))
        {
            state.current = None;
        }
        if state.current.is_none() {
            state.current = self
                .files()?
                .into_iter()
                .rfind(|(d, _, _)| *d == day)
                .map(|(_, _, n)| n);
        }
        if let Some(name) = &state.current {
            if self.0.directory.len(name)? + line.len() as u64
                > self.0.options.limits.max_file_bytes
            {
                state.current = None;
            }
        }
        if state.current.is_none() {
            let index = self
                .files()?
                .into_iter()
                .filter(|(d, _, _)| *d == day)
                .map(|(_, i, _)| i)
                .max()
                .map_or(Some(0), |i| i.checked_add(1))
                .ok_or(LogError::Invalid("rotation index"))?;
            if index > 999999 {
                return Err(LogError::Invalid("rotation index"));
            }
            let name = format!("desktop-{day}-{index:06}.jsonl");
            let file = self.0.directory.create(&name)?;
            file.sync_all()?;
            drop(file);
            state.current = Some(name);
        }
        self.0.directory.append(
            state
                .current
                .as_deref()
                .ok_or(LogError::Invalid("active file"))?,
            line.as_bytes(),
        )?;
        let files = self.files()?;
        let excess = files.len().saturating_sub(self.0.options.limits.keep_files);
        // A wall-clock correction can make the active file older than retained files. Keep
        // the just-written evidence and remove the oldest other files without exceeding the cap.
        for (_, _, name) in files
            .into_iter()
            .filter(|(_, _, name)| state.current.as_ref() != Some(name))
            .take(excess)
        {
            self.0.directory.remove(&name)?;
        }
        if state.recent.len() == 200 {
            state.recent.pop_front();
        }
        state.recent.push_back(line.trim_end_matches('\n').into());
        Ok(())
    }
}
pub(crate) fn parse_log_name(name: &str) -> Option<(NaiveDate, u32)> {
    if name.len() != 31 || !name.starts_with("desktop-") || !name.ends_with(".jsonl") {
        return None;
    }
    let day = name.get(8..18)?.parse().ok()?;
    if name.get(18..19)? != "-" || !name.get(19..25)?.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((day, name[19..25].parse().ok()?))
}
/// Write only formatter-owned text to an already private crash handle; used by the bounded hook worker.
pub(crate) fn write_crash(file: &mut File, text: &str) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    file.write_all(text.as_bytes())?;
    file.set_len(text.len() as u64)?;
    file.sync_all()?;
    Ok(())
}
