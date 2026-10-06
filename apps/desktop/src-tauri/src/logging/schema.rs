//! Desktop-local D111 types; the data artifacts can migrate to the future shared log-schema.
use super::{LogError, Result};
use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::OnceLock};

pub const CATALOGUE_JSON: &str = include_str!("catalogue.json");
pub const RECORD_SCHEMA_JSON: &str = include_str!("record.schema.json");
pub const LEVELS_JSON: &str = include_str!("levels.json");

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
    Fatal,
}
impl Level {
    pub fn otel_number(self) -> u8 {
        match self {
            Self::Trace => 1,
            Self::Debug => 5,
            Self::Info => 9,
            Self::Warn => 13,
            Self::Error => 17,
            Self::Fatal => 21,
        }
    }
    pub fn syslog_number(self) -> u8 {
        match self {
            Self::Trace | Self::Debug => 7,
            Self::Info => 6,
            Self::Warn => 4,
            Self::Error => 3,
            Self::Fatal => 2,
        }
    }
}
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    #[default]
    Shell,
    Controller,
    Updater,
}

/// Live desktop overrides: exact source > desktop kind > default. No preferences are rewritten.
#[derive(Clone, Debug, Default)]
pub struct LevelPolicy {
    pub default: Level,
    pub desktop: Option<Level>,
    pub sources: BTreeMap<SourceId, Level>,
    pub trace_until: Option<DateTime<Utc>>,
}
impl LevelPolicy {
    pub fn validate(&self, now: DateTime<Utc>) -> Result<()> {
        if self.has_trace()
            && self
                .trace_until
                .is_none_or(|until| until <= now || until > now + TimeDelta::hours(24))
        {
            return Err(LogError::Invalid(
                "trace requires a future expiry within 24 hours",
            ));
        }
        Ok(())
    }
    pub(crate) fn validate_loaded(&self, now: DateTime<Utc>) -> Result<()> {
        if self.has_trace() && self.trace_until.is_some_and(|until| until <= now) {
            return Ok(());
        }
        self.validate(now)
    }
    pub(crate) fn has_trace(&self) -> bool {
        self.default == Level::Trace
            || self.desktop == Some(Level::Trace)
            || self.sources.values().any(|v| *v == Level::Trace)
    }
    pub(crate) fn resolve(&self, source: SourceId, now: DateTime<Utc>) -> Level {
        let level = self
            .sources
            .get(&source)
            .copied()
            .or(self.desktop)
            .unwrap_or(self.default);
        if level == Level::Trace && self.trace_until.is_none_or(|until| until <= now) {
            Level::Debug
        } else {
            level
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Check,
    Download,
    Verify,
    Install,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Webview {
    Shell,
    Spa,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WebviewFailure {
    Terminated,
    Unresponsive,
    LaunchFailed,
    NavigationFailed,
}
/// Closed native diagnostic classes. These are metadata, exempt from the generic `code` key rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    RateLimited,
    Overloaded,
    Auth,
    InvalidRequest,
    Server,
    Timeout,
    Network,
    Io,
    Internal,
    Unavailable,
    Webview,
    Panic,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorHint {
    Retry,
    PairAgain,
    RestartApp,
    CheckConnection,
    OpenLogs,
}
/// `reason` is a native machine token, never error bodies, page data, or arbitrary foreign text.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticError {
    pub code: ErrorCode,
    pub reason: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<ErrorHint>,
}

/// Closed attribute-bearing events: no body, URL, panel, transcript, or free-form text slot.
#[derive(Clone, Debug)]
pub enum Event {
    AppStarted,
    RegistrySaturated {
        failures: u64,
    },
    AppCrashed {
        crash_id: String,
    },
    ConnectionLost {
        connection_id: uuid::Uuid,
        retrying: bool,
    },
    WebviewFailed {
        webview: Webview,
        failure: WebviewFailure,
    },
    UpdateFailed {
        phase: UpdatePhase,
        sha256: Option<String>,
    },
    DeeplinkIgnored,
    #[doc(hidden)]
    LevelChanged {
        from: Level,
        to: Level,
    },
    #[doc(hidden)]
    LevelExpired,
    #[doc(hidden)]
    RetentionPruned {
        files: u64,
    },
    #[doc(hidden)]
    RedactionFailed {
        event: String,
    },
    #[doc(hidden)]
    Unregistered {
        attempted: String,
    },
}
impl Event {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AppStarted => "desktop.app.started",
            Self::RegistrySaturated { .. } => "log.registry.saturated",
            Self::AppCrashed { .. } => "desktop.app.crashed",
            Self::ConnectionLost { .. } => "desktop.connection.lost",
            Self::WebviewFailed { .. } => "desktop.webview.failed",
            Self::UpdateFailed { .. } => "desktop.update.failed",
            Self::DeeplinkIgnored => "desktop.deeplink.ignored",
            Self::LevelChanged { .. } => "log.level.changed",
            Self::LevelExpired => "log.level.expired",
            Self::RetentionPruned { .. } => "log.retention.pruned",
            Self::RedactionFailed { .. } => "log.redaction.failed",
            Self::Unregistered { .. } => "log.unregistered",
        }
    }
    pub(crate) fn attrs(&self) -> Option<Value> {
        Some(match self {
            Self::AppStarted | Self::DeeplinkIgnored | Self::LevelExpired => return None,
            Self::AppCrashed { crash_id } => json!({"crash_id":crash_id}),
            Self::ConnectionLost {
                connection_id,
                retrying,
            } => json!({"connection_id":connection_id,"retrying":retrying}),
            Self::WebviewFailed { webview, failure } => {
                json!({"webview":webview,"failure":failure})
            }
            Self::UpdateFailed { phase, sha256 } => {
                let mut value = json!({"phase":phase});
                if let Some(hash) = sha256 {
                    value["sha256"] = json!(hash);
                }
                value
            }
            Self::LevelChanged { from, to } => json!({"from":from,"to":to}),
            Self::RetentionPruned { files } => json!({"files":files}),
            Self::RegistrySaturated { failures } => json!({"failures":failures}),
            Self::RedactionFailed { event } => json!({"event":event}),
            Self::Unregistered { attempted } => json!({"attempted":attempted}),
        })
    }
    /// Parse a registered event with a closed, event-specific attribute schema. Unknown names are errors.
    pub fn from_registered(code: &str, attrs: Value) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Empty {}
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Crash {
            crash_id: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Connection {
            connection_id: uuid::Uuid,
            retrying: bool,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct View {
            webview: Webview,
            failure: WebviewFailure,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Update {
            phase: UpdatePhase,
            sha256: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Change {
            from: Level,
            to: Level,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Retention {
            files: u64,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Saturated {
            failures: u64,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Failed {
            event: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Unknown {
            attempted: String,
        }
        fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
            serde_json::from_value(v).map_err(|_| LogError::Invalid("event attributes"))
        }
        let event = match code {
            "desktop.app.started" => {
                let _: Empty = parse(attrs)?;
                Self::AppStarted
            }
            "desktop.deeplink.ignored" => {
                let _: Empty = parse(attrs)?;
                Self::DeeplinkIgnored
            }
            "desktop.app.crashed" => {
                let a: Crash = parse(attrs)?;
                Self::AppCrashed {
                    crash_id: a.crash_id,
                }
            }
            "desktop.connection.lost" => {
                let a: Connection = parse(attrs)?;
                Self::ConnectionLost {
                    connection_id: a.connection_id,
                    retrying: a.retrying,
                }
            }
            "desktop.webview.failed" => {
                let a: View = parse(attrs)?;
                Self::WebviewFailed {
                    webview: a.webview,
                    failure: a.failure,
                }
            }
            "desktop.update.failed" => {
                let a: Update = parse(attrs)?;
                Self::UpdateFailed {
                    phase: a.phase,
                    sha256: a.sha256,
                }
            }
            "log.level.changed" => {
                let a: Change = parse(attrs)?;
                Self::LevelChanged {
                    from: a.from,
                    to: a.to,
                }
            }
            "log.level.expired" => {
                let _: Empty = parse(attrs)?;
                Self::LevelExpired
            }
            "log.retention.pruned" => {
                let a: Retention = parse(attrs)?;
                Self::RetentionPruned { files: a.files }
            }
            "log.registry.saturated" => {
                let a: Saturated = parse(attrs)?;
                Self::RegistrySaturated {
                    failures: a.failures,
                }
            }
            "log.redaction.failed" => {
                let a: Failed = parse(attrs)?;
                Self::RedactionFailed { event: a.event }
            }
            "log.unregistered" => {
                let a: Unknown = parse(attrs)?;
                Self::Unregistered {
                    attempted: a.attempted,
                }
            }
            _ => return Err(LogError::Unregistered),
        };
        event.validate()?;
        Ok(event)
    }
    pub(crate) fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::AppCrashed { crash_id } => machine_token(crash_id, 128) || marker(crash_id),
            Self::UpdateFailed {
                sha256: Some(hash), ..
            } => {
                (hash.len() == 64
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
                    || marker(hash)
            }
            Self::RedactionFailed { event } => entry(event).is_some(),
            Self::Unregistered { attempted } => attempted.len() <= 8192,
            _ => true,
        };
        if valid {
            Ok(())
        } else {
            Err(LogError::Invalid("event attributes"))
        }
    }
}
#[derive(Clone, Debug)]
pub struct RecordInput {
    pub event: Event,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub duration_ms: Option<u64>,
    pub err: Option<DiagnosticError>,
}
impl RecordInput {
    pub fn new(event: Event) -> Self {
        Self {
            event,
            trace_id: None,
            span_id: None,
            duration_ms: None,
            err: None,
        }
    }
    pub(crate) fn validate(&self) -> Result<()> {
        self.event.validate()?;
        if self.trace_id.as_ref().is_some_and(|id| !hex_id(id, 32))
            || self.span_id.as_ref().is_some_and(|id| !hex_id(id, 16))
            || (self.span_id.is_some() && self.trace_id.is_none())
        {
            return Err(LogError::Invalid("trace identifiers"));
        }
        if self
            .err
            .as_ref()
            .is_some_and(|e| !machine_token(&e.reason, 128))
        {
            return Err(LogError::Invalid(
                "error reason must be a native machine token",
            ));
        }
        Ok(())
    }
}
pub(crate) fn hex_id(id: &str, len: usize) -> bool {
    id.len() == len
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && id.bytes().any(|b| b != b'0')
}
fn machine_token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn marker(s: &str) -> bool {
    s.starts_with("[REDACTED:") && s.ends_with(']')
}

#[derive(Deserialize)]
pub(crate) struct Entry {
    pub event: String,
    pub level: Level,
    pub msg: String,
}
pub(crate) fn entry(code: &str) -> Option<&'static Entry> {
    static ENTRIES: OnceLock<Vec<Entry>> = OnceLock::new();
    ENTRIES
        .get_or_init(|| serde_json::from_str(CATALOGUE_JSON).expect("embedded catalogue"))
        .iter()
        .find(|e| e.event == code)
}

// Struct declaration order is the wire order; never round-trip through serde_json::Value for output.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    pub kind: String,
    pub id: SourceId,
    pub version: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub ts: String,
    pub level: Level,
    pub source: Source,
    pub event: String,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<DiagnosticError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Value>,
}
impl Record {
    pub(crate) fn new(
        input: RecordInput,
        source: SourceId,
        version: Option<String>,
        now: DateTime<Utc>,
    ) -> Self {
        let event = entry(input.event.code()).expect("typed event in catalogue");
        Self {
            ts: timestamp(now),
            level: event.level,
            source: Source {
                kind: "desktop".into(),
                id: source,
                version,
            },
            event: event.event.clone(),
            msg: event.msg.clone(),
            trace_id: input.trace_id,
            span_id: input.span_id,
            duration_ms: input.duration_ms,
            err: input.err,
            attrs: input.event.attrs(),
        }
    }
}
pub(crate) fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}
/// Validate a deserialized record against the closed desktop schema/catalogue (including byte budgets).
pub fn validate_record(value: &Value) -> Result<()> {
    if value.get("source").and_then(|s| s.get("version")).is_none()
        || ["trace_id", "span_id", "duration_ms", "err", "attrs"]
            .iter()
            .any(|key| value.get(key).is_some_and(Value::is_null))
        || value
            .get("err")
            .and_then(|e| e.get("hint"))
            .is_some_and(Value::is_null)
    {
        return Err(LogError::Invalid("required and optional fields"));
    }
    let r: Record =
        serde_json::from_value(value.clone()).map_err(|_| LogError::Invalid("record shape"))?;
    let e = entry(&r.event).ok_or(LogError::Unregistered)?;
    let ts: DateTime<Utc> = r.ts.parse().map_err(|_| LogError::Invalid("timestamp"))?;
    if timestamp(ts) != r.ts
        || r.source.kind != "desktop"
        || r.source.version.as_ref().is_some_and(|s| s.len() > 1024)
        || r.level != e.level
        || r.msg != e.msg
        || r.msg.len() > 2048
    {
        return Err(LogError::Invalid("record metadata"));
    }
    if r.trace_id.as_ref().is_some_and(|id| !hex_id(id, 32))
        || r.span_id.as_ref().is_some_and(|id| !hex_id(id, 16))
        || (r.span_id.is_some() && r.trace_id.is_none())
    {
        return Err(LogError::Invalid("trace identifiers"));
    }
    if r.err
        .as_ref()
        .is_some_and(|e| !machine_token(&e.reason, 128) && !marker(&e.reason))
    {
        return Err(LogError::Invalid("error reason"));
    }
    let mut attrs = r.attrs.unwrap_or_else(|| json!({}));
    if serde_json::to_vec(&attrs)?.len() > 8192 {
        return Err(LogError::Invalid("attrs budget"));
    }
    if let Some(object) = attrs.as_object_mut() {
        let repeat = object.remove("repeat");
        let window = object.remove("window_ms");
        if (repeat.is_some() || window.is_some())
            && (r.level == Level::Fatal
                || repeat.and_then(|v| v.as_u64()).is_none_or(|v| v < 2)
                || window.and_then(|v| v.as_u64()) != Some(60000))
        {
            return Err(LogError::Invalid("dedup summary"));
        }
    }
    Event::from_registered(&r.event, attrs)?;
    Ok(())
}
