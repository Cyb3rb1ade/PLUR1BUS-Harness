//! The Rust mirror of `packages/log-schema` (D111): the log record schema, the event catalogue, the level map and
//! the redaction patterns as data, and the one validator the Rust writers and the reader share. There is no logger,
//! writer, redactor or sink here (D111 §9: those are later parts).
//!
//! The JSON files under `packages/log-schema/schema/` are the single source, embedded with `include_str!` the way
//! `plur1bus-config` embeds its schema. `tests/parity.rs` reads `packages/log-schema/fixtures/vectors.json`, which
//! the TypeScript package generates from the same files, and fails when the two implementations disagree on the
//! level table, the catalogue, the attrs schemas, the redaction data or the verdict on any vector line.

use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

pub const RECORD_SCHEMA_JSON: &str =
    include_str!("../../../packages/log-schema/schema/record.schema.json");
pub const CATALOGUE_JSON: &str = include_str!("../../../packages/log-schema/schema/catalogue.json");
pub const LEVELS_JSON: &str = include_str!("../../../packages/log-schema/schema/levels.json");
pub const REDACTION_JSON: &str = include_str!("../../../packages/log-schema/schema/redaction.json");

fn parse(name: &str, text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("embedded {name} is not JSON: {e}"))
}

// ---- levels (§2.6) ----

/// A log level. The mapping tables are `const` here and pinned to `levels.json` by the parity test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl Level {
    /// Every level, lowest rank first.
    pub const ALL: [Level; 6] = [
        Level::Trace,
        Level::Debug,
        Level::Info,
        Level::Warn,
        Level::Error,
        Level::Fatal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Trace => "trace",
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
            Level::Fatal => "fatal",
        }
    }

    /// Exact, lower-case names only: `"INFO"` and `"verbose"` are not levels.
    pub fn parse(name: &str) -> Option<Level> {
        Level::ALL.into_iter().find(|l| l.as_str() == name)
    }

    /// Position in the order trace < debug < info < warn < error < fatal.
    pub fn rank(self) -> u8 {
        self as u8
    }

    /// OpenTelemetry `SeverityNumber`: the first number of the range each level reserves.
    pub fn severity_number(self) -> u8 {
        match self {
            Level::Trace => 1,
            Level::Debug => 5,
            Level::Info => 9,
            Level::Warn => 13,
            Level::Error => 17,
            Level::Fatal => 21,
        }
    }

    pub fn severity_text(self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
            Level::Fatal => "FATAL",
        }
    }

    /// RFC 5424 severity (trace and debug share 7).
    pub fn syslog_severity(self) -> u8 {
        match self {
            Level::Trace | Level::Debug => 7,
            Level::Info => 6,
            Level::Warn => 4,
            Level::Error => 3,
            Level::Fatal => 2,
        }
    }

    pub fn syslog_name(self) -> &'static str {
        match self {
            Level::Trace | Level::Debug => "debug",
            Level::Info => "informational",
            Level::Warn => "warning",
            Level::Error => "error",
            Level::Fatal => "critical",
        }
    }

    /// True when a record at `self` passes a minimum of `min`.
    pub fn at_least(self, min: Level) -> bool {
        self >= min
    }
}

// ---- record schema ----

pub fn record_schema() -> &'static Value {
    static S: OnceLock<Value> = OnceLock::new();
    S.get_or_init(|| parse("record.schema.json", RECORD_SCHEMA_JSON))
}

/// The top-level keys of a written record, in order.
pub fn key_order() -> Vec<&'static str> {
    record_schema()["x-key-order"]
        .as_array()
        .expect("x-key-order")
        .iter()
        .map(|k| k.as_str().expect("key"))
        .collect()
}

pub fn source_kinds() -> Vec<&'static str> {
    record_schema()["$defs"]["SourceKind"]["enum"]
        .as_array()
        .expect("SourceKind enum")
        .iter()
        .map(|k| k.as_str().expect("kind"))
        .collect()
}

/// The numeric limits of `x-limits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub msg_bytes: usize,
    pub attrs_bytes: usize,
    pub line_bytes: usize,
    pub dedup_window_ms: u64,
    pub rate_sustained_per_second: u64,
    pub rate_burst: u64,
}

pub fn limits() -> Limits {
    let l = &record_schema()["x-limits"];
    let n = |k: &str| l[k].as_u64().unwrap_or_else(|| panic!("x-limits.{k}"));
    Limits {
        msg_bytes: n("msgBytes") as usize,
        attrs_bytes: n("attrsBytes") as usize,
        line_bytes: n("lineBytes") as usize,
        dedup_window_ms: n("dedupWindowMs"),
        rate_sustained_per_second: n("rateSustainedPerSecond"),
        rate_burst: n("rateBurst"),
    }
}

/// `<kind>` or `<kind>:<id>` (`logs.levels` and filter keys).
pub fn is_source_key(s: &str) -> bool {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| {
        regex::Regex::new(
            record_schema()["$defs"]["SourceKey"]["pattern"]
                .as_str()
                .expect("SourceKey pattern"),
        )
        .expect("SourceKey regex")
    })
    .is_match(s)
}

// ---- catalogue (§3) ----

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Entry {
    pub event: String,
    pub kinds: Vec<String>,
    pub stream: String,
    pub level: String,
    pub levels: Vec<String>,
    #[serde(default)]
    pub level_rule: Option<String>,
    pub msg: String,
    pub attrs: String,
    pub required_attrs: Vec<String>,
    #[serde(default)]
    pub streamed: bool,
    #[serde(default)]
    pub family: bool,
    pub activity: bool,
    pub since: String,
    pub stability: String,
    #[serde(default)]
    pub note: Option<String>,
    pub examples: Vec<Value>,
}

impl Entry {
    pub fn default_level(&self) -> Level {
        Level::parse(&self.level).expect("catalogue level")
    }
    pub fn allows_level(&self, level: Level) -> bool {
        self.levels.iter().any(|l| l == level.as_str())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Catalogue {
    #[serde(rename = "$comment")]
    pub comment: String,
    pub version: String,
    pub name_rule: String,
    pub streams: Vec<String>,
    pub common_attrs: serde_json::Map<String, Value>,
    pub attr_groups: HashMap<String, AttrGroup>,
    pub events: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttrGroup {
    pub description: String,
    pub properties: serde_json::Map<String, Value>,
}

pub fn catalogue() -> &'static Catalogue {
    static C: OnceLock<Catalogue> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CATALOGUE_JSON).expect("embedded catalogue.json"))
}

struct Index {
    exact: HashMap<&'static str, &'static Entry>,
    families: HashMap<&'static str, &'static Entry>,
    name_rule: regex::Regex,
}

fn index() -> &'static Index {
    static I: OnceLock<Index> = OnceLock::new();
    I.get_or_init(|| {
        let c = catalogue();
        let mut exact = HashMap::new();
        let mut families = HashMap::new();
        for e in &c.events {
            if e.family {
                families.insert(e.event.trim_end_matches(".*"), e);
            } else {
                exact.insert(e.event.as_str(), e);
            }
        }
        Index {
            exact,
            families,
            name_rule: regex::Regex::new(&c.name_rule).expect("nameRule"),
        }
    })
}

/// The entry that registers `name`: an exact entry, else the `<prefix>.*` family entry.
pub fn lookup_event(name: &str) -> Option<&'static Entry> {
    let i = index();
    if !i.name_rule.is_match(name) {
        return None;
    }
    if let Some(e) = i.exact.get(name) {
        return Some(e);
    }
    let prefix = &name[..name.find('.')?];
    i.families.get(prefix).copied()
}

/// The JSON Schema one event's `attrs` must satisfy: its group plus the common attrs, closed, with the entry's
/// required list. Identical to the TypeScript `attrsSchemaFor`.
pub fn attrs_schema_for(entry: &Entry) -> Value {
    let c = catalogue();
    let group = c
        .attr_groups
        .get(&entry.attrs)
        .unwrap_or_else(|| panic!("catalogue: unknown attrs group {}", entry.attrs));
    let mut props = c.common_attrs.clone();
    for (k, v) in &group.properties {
        props.insert(k.clone(), v.clone());
    }
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "properties": props,
        "required": entry.required_attrs,
    })
}

// ---- redaction data (§4) ----

/// One redaction pattern, as data. This crate never applies it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Pattern {
    pub id: String,
    pub pattern: String,
    #[serde(default)]
    pub flags: Option<String>,
    #[serde(default)]
    pub left_boundary: bool,
    #[serde(default)]
    pub value_group: Option<usize>,
    #[serde(default)]
    pub replacement: Option<String>,
    #[serde(default)]
    pub exempt_when_whole_match_is: Option<String>,
    pub description: String,
}

impl Pattern {
    /// The pattern compiled with the `regex` crate (flag `i` becomes `(?i)`).
    pub fn regex(&self) -> regex::Regex {
        let src = match self.flags.as_deref() {
            Some("i") => format!("(?i){}", self.pattern),
            None | Some("") => self.pattern.clone(),
            Some(other) => panic!("unsupported flags {other:?} on pattern {}", self.id),
        };
        regex::Regex::new(&src).unwrap_or_else(|e| panic!("pattern {}: {e}", self.id))
    }
}

pub fn redaction() -> &'static Value {
    static R: OnceLock<Value> = OnceLock::new();
    R.get_or_init(|| parse("redaction.json", REDACTION_JSON))
}

/// Rule ids in application order.
pub fn redaction_order() -> Vec<&'static str> {
    redaction()["order"]
        .as_array()
        .expect("order")
        .iter()
        .map(|v| v.as_str().expect("id"))
        .collect()
}

/// The patterns of a `patterns` rule (`pattern`, `pii`) or the steps of the `url` rule.
pub fn rule_patterns(rule_id: &str) -> Vec<Pattern> {
    let rule = redaction()["rules"]
        .as_array()
        .expect("rules")
        .iter()
        .find(|r| r["id"] == rule_id)
        .unwrap_or_else(|| panic!("no redaction rule {rule_id}"));
    let list = rule
        .get("patterns")
        .or_else(|| rule.get("steps"))
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::from_value(list).unwrap_or_default()
}

// ---- validation ----

/// Why a record was refused. The checks run in the order of this list; the first failure names the code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    NotObject,
    InvalidLevel,
    UnknownEvent,
    MsgTooLong,
    AttrsTooLarge,
    Schema,
    KeyOrder,
    LevelNotAllowed,
    SourceKindNotAllowed,
    StreamMismatch,
    AttrsInvalid,
}

impl Code {
    /// The TypeScript `ValidationCode` spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::NotObject => "not_object",
            Code::InvalidLevel => "invalid_level",
            Code::UnknownEvent => "unknown_event",
            Code::MsgTooLong => "msg_too_long",
            Code::AttrsTooLarge => "attrs_too_large",
            Code::Schema => "schema",
            Code::KeyOrder => "key_order",
            Code::LevelNotAllowed => "level_not_allowed",
            Code::SourceKindNotAllowed => "source_kind_not_allowed",
            Code::StreamMismatch => "stream_mismatch",
            Code::AttrsInvalid => "attrs_invalid",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub code: Code,
    pub detail: String,
}

fn fail<T>(code: Code, detail: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid {
        code,
        detail: detail.into(),
    })
}

fn record_validator() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| {
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(record_schema())
            .expect("record schema compiles")
    })
}

fn attrs_validator(entry: &Entry) -> Arc<jsonschema::Validator> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<jsonschema::Validator>>>> = OnceLock::new();
    let key = format!("{}|{}", entry.attrs, entry.required_attrs.join(","));
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .expect("attrs validator cache");
    cache
        .entry(key)
        .or_insert_with(|| {
            Arc::new(
                jsonschema::options()
                    .with_draft(jsonschema::Draft::Draft202012)
                    .build(&attrs_schema_for(entry))
                    .expect("attrs schema compiles"),
            )
        })
        .clone()
}

/// RFC 3339 `YYYY-MM-DDTHH:MM:SS.mmmZ` with a real calendar date and time (no leap seconds).
fn real_timestamp(ts: &str) -> bool {
    let b = ts.as_bytes();
    if b.len() != 24
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[23] != b'Z'
    {
        return false;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let s = &ts[r];
        (s.bytes().all(|c| c.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second), Some(_)) = (
        num(0..4),
        num(5..7),
        num(8..10),
        num(11..13),
        num(14..16),
        num(17..19),
        num(20..23),
    ) else {
        return false;
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=12).contains(&month)
        && day >= 1
        && day <= days[(month - 1) as usize]
        && hour < 24
        && minute < 60
        && second < 60
}

/// The top-level keys of a JSON object text, in order, duplicates included.
fn top_level_keys(line: &str) -> Vec<String> {
    use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
    struct Keys(Vec<String>);
    impl<'de> Visitor<'de> for &mut Keys {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
            while let Some(k) = map.next_key::<String>()? {
                self.0.push(k);
                map.next_value::<IgnoredAny>()?;
            }
            Ok(())
        }
    }
    let mut keys = Keys(Vec::new());
    let mut de = serde_json::Deserializer::from_str(line);
    let _ = de.deserialize_map(&mut keys);
    keys.0
}

/// Validates one log line against the schema and the catalogue. The checks run in a fixed order and the first failure
/// names the code (the TypeScript `validateLine` runs the same order; `fixtures/vectors.json` pins it):
/// object (a repeated top-level key is `key_order`) → level in the table → event registered → msg bytes → attrs bytes
/// → JSON Schema → key order → level allowed for the event → source kind allowed → stream present iff the event is
/// wrapped output → attrs group.
pub fn validate_line(line: &str) -> Result<&'static Entry, Invalid> {
    let Ok(Value::Object(r)) = serde_json::from_str::<Value>(line) else {
        return fail(Code::NotObject, "not a JSON object");
    };
    let keys = top_level_keys(line);
    let mut seen = std::collections::HashSet::new();
    if !keys.iter().all(|k| seen.insert(k.as_str())) {
        return fail(Code::KeyOrder, "a key appears more than once");
    }
    if let Some(level) = r.get("level") {
        if level.as_str().and_then(Level::parse).is_none() {
            return fail(
                Code::InvalidLevel,
                format!("level {level} is not one of trace, debug, info, warn, error, fatal"),
            );
        }
    }
    let entry = r.get("event").and_then(Value::as_str).map(lookup_event);
    if let Some(None) = entry {
        return fail(
            Code::UnknownEvent,
            format!("event {} is not in the catalogue", r["event"]),
        );
    }
    let lim = limits();
    if let Some(msg) = r.get("msg").and_then(Value::as_str) {
        if msg.len() > lim.msg_bytes {
            return fail(
                Code::MsgTooLong,
                format!("msg exceeds {} bytes", lim.msg_bytes),
            );
        }
    }
    if let Some(attrs @ (Value::Object(_) | Value::Array(_))) = r.get("attrs") {
        if serde_json::to_string(attrs)
            .map(|s| s.len())
            .unwrap_or(usize::MAX)
            > lim.attrs_bytes
        {
            return fail(
                Code::AttrsTooLarge,
                format!("attrs exceed {} bytes", lim.attrs_bytes),
            );
        }
    }
    let whole = Value::Object(r.clone());
    if let Some(e) = record_validator().iter_errors(&whole).next() {
        return fail(Code::Schema, format!("{} {e}", e.instance_path));
    }
    if !real_timestamp(r["ts"].as_str().unwrap_or_default()) {
        return fail(Code::Schema, "/ts is not a real RFC 3339 date and time");
    }
    let order = key_order();
    let mut last: isize = -1;
    for key in &keys {
        let at = order
            .iter()
            .position(|k| k == key)
            .map(|p| p as isize)
            .unwrap_or(-1);
        if at <= last {
            return fail(
                Code::KeyOrder,
                format!(
                    "key {key} is out of order; the order is {}",
                    order.join(", ")
                ),
            );
        }
        last = at;
    }
    // Past the schema the event key exists, is a string and is registered.
    let hit = entry.flatten().expect("a registered event");
    let level = Level::parse(r["level"].as_str().expect("level")).expect("level");
    if !hit.allows_level(level) {
        return fail(
            Code::LevelNotAllowed,
            format!(
                "{} may be written at {}, not {}",
                hit.event,
                hit.levels.join(", "),
                level.as_str()
            ),
        );
    }
    let kind = r["source"]["kind"].as_str().expect("source.kind");
    if !hit.kinds.iter().any(|k| k == kind) {
        return fail(
            Code::SourceKindNotAllowed,
            format!(
                "{} may only be emitted by {}, not {kind}",
                hit.event,
                hit.kinds.join(", ")
            ),
        );
    }
    if hit.streamed != r.contains_key("stream") {
        return fail(
            Code::StreamMismatch,
            if hit.streamed {
                format!("{} is wrapped output and needs a stream", hit.event)
            } else {
                format!(
                    "{} is not wrapped output and must not carry a stream",
                    hit.event
                )
            },
        );
    }
    let empty = Value::Object(Default::default());
    let attrs = r.get("attrs").unwrap_or(&empty);
    if let Some(e) = attrs_validator(hit).iter_errors(attrs).next() {
        return fail(Code::AttrsInvalid, format!("attrs{} {e}", e.instance_path));
    }
    Ok(hit)
}
