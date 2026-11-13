//! `methods.ts`: `logs.query`, `logs.tail` and `logs.levels` (D4, D111 section 2.1) as plain functions over a deps
//! struct: read-only views over `<home>/logs/` and the live per-source levels.
//!
//! Not wired into `CoreMethods`, the route table or the server yet; the flip PR adapts these to the generated traits
//! ([`LogsParams`] and [`LevelsParams`] convert from the generated params, [`LogPage::into_result`] and
//! [`LevelsSnapshot::into_result`] to the generated results, [`LogsError::into_method_error`] to a `MethodError`).
//!
//! What the TypeScript handlers take from parts of the core that are not ported (the live writer, the audit trail, the
//! caller's identity, the core's stop signal, the clock and the sleep) comes in through [`LogsDeps`] as traits and
//! closures, the way `LogsDeps` of `methods.ts` injects them. RBAC is not here: `core.ts` authorizes the three methods
//! (Owner/Admin) before it dispatches, as it does in the TypeScript core.
//!
//! Differences from the TypeScript handlers, all deliberate:
//!  * `logs.levels` audits several changed keys in key order (sorted); TypeScript uses the order the caller listed them.
//!  * [`LogsParams::from_value`] refuses a member of the wrong type with `E_INVALID_PARAMS`; the schema has refused it
//!    before the TypeScript handler runs. `from` and `to` stay raw JSON so the handler's own verdict on a non-string
//!    (`bad-timestamp`) is the same.
//!  * The generated `LogsLevelsParams` cannot tell `levels: {}` from an absent `levels`; [`LevelsParams::from_value`] can.
use super::files::Stream;
use super::levels::{system_clock, Clock, LevelSettings};
use super::query::{
    date_parse, iso_string, mint_cursor, run_query, stream_name, CursorError, LogFilter,
    LogRecordOut, Order, QueryError, QueryOptions, QueryResult,
};
use super::redact::TextRedactor;
use super::writer::Writer;
use crate::frame::RpcErr;
use plur1bus_log_schema::redact::{RedactOptions, Redactor};
use plur1bus_log_schema::{is_source_key, Level};
use plur1bus_rpc::server::MethodError;
use plur1bus_rpc::types::ErrorCode;
use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Records per page when the caller gives no limit.
const DEFAULT_LIMIT: usize = 100;
/// Poll interval of a waiting `logs.tail`.
const DEFAULT_POLL_MS: u64 = 250;

// ---- the abort signal (`AbortSignal`) ----

type Listener = Box<dyn Fn() + Send + Sync>;

struct SignalState {
    aborted: bool,
    next_id: u64,
    listeners: Vec<(u64, Listener)>,
}

struct SignalInner {
    state: Mutex<SignalState>,
    changed: Condvar,
}

/// An `AbortSignal`: aborted once, with listeners and a wait that ends early when it is.
#[derive(Clone)]
pub struct AbortSignal(Arc<SignalInner>);

impl Default for AbortSignal {
    fn default() -> Self {
        AbortSignal::new()
    }
}

impl AbortSignal {
    /// A signal that is not aborted.
    pub fn new() -> AbortSignal {
        AbortSignal(Arc::new(SignalInner {
            state: Mutex::new(SignalState {
                aborted: false,
                next_id: 0,
                listeners: Vec::new(),
            }),
            changed: Condvar::new(),
        }))
    }

    fn state(&self) -> MutexGuard<'_, SignalState> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Aborts the signal, once: wakes every wait and runs the listeners.
    pub fn abort(&self) {
        let listeners = {
            let mut state = self.state();
            if state.aborted {
                return;
            }
            state.aborted = true;
            std::mem::take(&mut state.listeners)
        };
        self.0.changed.notify_all();
        for (_, listener) in listeners {
            listener();
        }
    }

    /// Whether the signal was aborted.
    pub fn is_aborted(&self) -> bool {
        self.state().aborted
    }

    /// Runs `listener` when the signal aborts. `None` when it already has (a listener never fires for a signal that is
    /// already aborted); otherwise the id [`AbortSignal::off`] takes.
    pub fn on_abort(&self, listener: Listener) -> Option<u64> {
        let mut state = self.state();
        if state.aborted {
            return None;
        }
        let id = state.next_id;
        state.next_id += 1;
        state.listeners.push((id, listener));
        Some(id)
    }

    /// Removes a listener.
    pub fn off(&self, id: u64) {
        self.state().listeners.retain(|(i, _)| *i != id);
    }

    /// Listeners waiting (a test seam: a finished call leaves none).
    pub fn listener_count(&self) -> usize {
        self.state().listeners.len()
    }

    /// Waits up to `ms` or until the signal aborts; true when it did.
    pub fn wait(&self, ms: u64) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_millis(ms);
        let mut state = self.state();
        while !state.aborted {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            state = self
                .0
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        state.aborted
    }
}

/// `CallContext`: what the server knows about the call.
#[derive(Clone)]
pub struct CallContext {
    /// The JSON-RPC request id, as text.
    pub request_id: String,
    /// The connection the call came in on.
    pub connection_id: String,
    /// Aborted when the connection goes away.
    pub signal: AbortSignal,
}

impl CallContext {
    /// A context with a fresh signal.
    pub fn new(request_id: impl Into<String>, connection_id: impl Into<String>) -> CallContext {
        CallContext {
            request_id: request_id.into(),
            connection_id: connection_id.into(),
            signal: AbortSignal::new(),
        }
    }
}

// ---- the seams ----

/// `Pick<LogWriter, "updateLevels" | "currentLevels">`: the live diagnostic writer's levels.
pub trait LevelControl: Send + Sync {
    /// The levels in force.
    fn current_levels(&self) -> LevelSettings;
    /// Replaces them; the error is the writer's message.
    fn update_levels(&self, settings: LevelSettings) -> Result<(), String>;
}

impl LevelControl for Writer {
    fn current_levels(&self) -> LevelSettings {
        Writer::current_levels(self)
    }

    fn update_levels(&self, settings: LevelSettings) -> Result<(), String> {
        Writer::update_levels(self, settings).map_err(|e| e.to_string())
    }
}

/// Who made a change (`actor`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    /// The user.
    pub user: String,
    /// The host or transport.
    pub host: String,
}

/// An event for the audit trail (`AuditEvent` of `rbac/audit.ts`, the part `logs.levels` writes).
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEvent {
    /// Milliseconds since the epoch.
    pub at: i64,
    /// Who.
    pub actor: Actor,
    /// What (`logs.levels`).
    pub action: String,
    /// On what (a source key, `traceUntil`).
    pub target: String,
    /// The change.
    pub detail: Value,
}

/// `AuditSink`: where changes are recorded. A failing append never undoes the live change.
pub trait AuditSink: Send + Sync {
    /// Records one event.
    fn append(&self, event: &AuditEvent) -> Result<(), String>;
}

/// Resolves after `ms`, or early when the signal aborts.
pub type SleepFn = Arc<dyn Fn(u64, &AbortSignal) + Send + Sync>;
/// `actor(ctx)`.
pub type ActorFn = Arc<dyn Fn(&CallContext) -> Actor + Send + Sync>;
/// `onListed`.
pub type ListedHook = Arc<dyn Fn() + Send + Sync>;

/// `LogsDeps`.
#[derive(Default)]
pub struct LogsDeps {
    /// `<home>/logs`.
    pub dir: PathBuf,
    /// Default: a redactor with no options.
    pub redactor: Option<Arc<dyn TextRedactor>>,
    /// Core stop: ends a waiting `logs.tail`.
    pub signal: Option<AbortSignal>,
    /// Default: the system clock.
    pub now: Option<Clock>,
    /// Default: wait on the signal.
    pub sleep: Option<SleepFn>,
    /// Poll interval of a waiting `logs.tail`; default 250 ms.
    pub poll_ms: Option<u64>,
    /// The scan budget of one call.
    pub max_scan_bytes: Option<u64>,
    /// Test seam, see `QueryOptions::on_listed`.
    pub on_listed: Option<ListedHook>,
    /// Live diagnostic writer; absent when the core is using an injected logger.
    pub writer: Option<Arc<dyn LevelControl>>,
    /// Where level changes are recorded.
    pub audit: Option<Arc<dyn AuditSink>>,
    /// The caller's identity; default `unknown` on `rpc`.
    pub actor: Option<ActorFn>,
}

impl LogsDeps {
    /// Deps for `dir` with everything else at its default.
    pub fn new(dir: impl Into<PathBuf>) -> LogsDeps {
        LogsDeps {
            dir: dir.into(),
            ..LogsDeps::default()
        }
    }
}

// ---- errors ----

/// What a handler fails with.
#[derive(Debug)]
pub enum LogsError {
    /// A refusal for the caller, with the code, message and reason of the TypeScript `RpcError`.
    Rpc(RpcErr),
    /// Anything else (a file could not be read): `E_INTERNAL`.
    Internal(String),
}

impl From<RpcErr> for LogsError {
    fn from(e: RpcErr) -> Self {
        LogsError::Rpc(e)
    }
}

impl LogsError {
    /// The refusal, when it is one.
    pub fn rpc(&self) -> Option<&RpcErr> {
        match self {
            LogsError::Rpc(e) => Some(e),
            LogsError::Internal(_) => None,
        }
    }

    /// The error the generated dispatcher takes. `None` when the code is not one of the schema's.
    pub fn into_method_error(self) -> Option<MethodError> {
        match self {
            LogsError::Rpc(e) => {
                let code: ErrorCode = e.code.parse().ok()?;
                let mut out = MethodError::rpc(code, e.message);
                if let Some(reason) = e.reason {
                    out = out.with_reason(reason);
                }
                Some(out)
            }
            LogsError::Internal(message) => Some(MethodError::rpc(ErrorCode::EInternal, message)),
        }
    }
}

fn invalid(message: &str, reason: &str) -> RpcErr {
    RpcErr::new("E_INVALID_PARAMS", message, Some(reason))
}

fn bad_params(name: &str) -> RpcErr {
    invalid(&format!("{name} has the wrong type"), "schema")
}

// ---- params ----

/// The params of `logs.query` and `logs.tail`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LogsParams {
    /// Default `diagnostic`.
    pub stream: Option<Stream>,
    /// Raw JSON: the handler judges its type and form.
    pub from: Option<Value>,
    /// Raw JSON, as `from`.
    pub to: Option<Value>,
    /// Not valid with the audit stream.
    pub min_level: Option<Level>,
    /// See `LogFilter::component`; empty is ignored.
    pub component: Option<String>,
    /// Case-insensitive substring of the redacted record; empty is ignored.
    pub text: Option<String>,
    /// Exact `trace_id`; empty is ignored.
    pub trace_id: Option<String>,
    /// Records per page; default 100.
    pub limit: Option<usize>,
    /// From a previous result of the same call with the same filters.
    pub cursor: Option<String>,
    /// `logs.query`: default `desc`. (`logs.tail` ignores it.)
    pub order: Option<Order>,
    /// `logs.tail`: how long to wait for a first record.
    pub wait_ms: Option<i64>,
}

fn string_member(o: &Map<String, Value>, key: &str) -> Result<Option<String>, RpcErr> {
    match o.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(bad_params(key)),
    }
}

impl LogsParams {
    /// Reads params the way the schema describes them.
    pub fn from_value(v: &Value) -> Result<LogsParams, RpcErr> {
        let Value::Object(o) = v else {
            return Err(invalid("params must be an object", "schema"));
        };
        let stream = match o.get("stream") {
            None => None,
            Some(Value::String(s)) if s == "diagnostic" => Some(Stream::Diagnostic),
            Some(Value::String(s)) if s == "audit" => Some(Stream::Audit),
            Some(_) => return Err(bad_params("stream")),
        };
        let min_level = match o.get("minLevel") {
            None => None,
            Some(Value::String(s)) => Some(Level::parse(s).ok_or_else(|| bad_params("minLevel"))?),
            Some(_) => return Err(bad_params("minLevel")),
        };
        let order = match o.get("order") {
            None => None,
            Some(Value::String(s)) => Some(Order::parse(s).ok_or_else(|| bad_params("order"))?),
            Some(_) => return Err(bad_params("order")),
        };
        let limit = match o.get("limit") {
            None => None,
            Some(n) => Some(
                n.as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| bad_params("limit"))?,
            ),
        };
        let wait_ms = match o.get("waitMs") {
            None => None,
            Some(n) => Some(n.as_i64().ok_or_else(|| bad_params("waitMs"))?),
        };
        Ok(LogsParams {
            stream,
            from: o.get("from").cloned(),
            to: o.get("to").cloned(),
            min_level,
            component: string_member(o, "component")?,
            text: string_member(o, "text")?,
            trace_id: string_member(o, "traceId")?,
            limit,
            cursor: string_member(o, "cursor")?,
            order,
            wait_ms,
        })
    }
}

impl TryFrom<&plur1bus_rpc::types::LogsQueryParams> for LogsParams {
    type Error = RpcErr;

    fn try_from(p: &plur1bus_rpc::types::LogsQueryParams) -> Result<Self, RpcErr> {
        let v = serde_json::to_value(p).map_err(|_| invalid("params cannot be read", "schema"))?;
        LogsParams::from_value(&v)
    }
}

impl TryFrom<&plur1bus_rpc::types::LogsTailParams> for LogsParams {
    type Error = RpcErr;

    fn try_from(p: &plur1bus_rpc::types::LogsTailParams) -> Result<Self, RpcErr> {
        let v = serde_json::to_value(p).map_err(|_| invalid("params cannot be read", "schema"))?;
        LogsParams::from_value(&v)
    }
}

/// `traceUntil` of `logs.levels`: a timestamp, or `null` to clear the expiry.
#[derive(Clone, Debug, PartialEq)]
pub enum TraceUntil {
    /// `null`.
    Clear,
    /// Raw JSON: the handler judges its type and form.
    Set(Value),
}

/// The params of `logs.levels`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LevelsParams {
    /// The live global default; the writer's judgement when it is not a level.
    pub default_level: Option<String>,
    /// Per-source overrides to merge, by source key; raw JSON for the level.
    pub levels: Option<BTreeMap<String, Value>>,
    /// Source keys whose override is removed.
    pub unset: Option<Vec<String>>,
    /// Expiry of any trace level.
    pub trace_until: Option<TraceUntil>,
}

impl LevelsParams {
    /// Reads params the way the schema describes them.
    pub fn from_value(v: &Value) -> Result<LevelsParams, RpcErr> {
        let Value::Object(o) = v else {
            return Err(invalid("params must be an object", "schema"));
        };
        let levels = match o.get("levels") {
            None => None,
            Some(Value::Object(m)) => Some(m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            Some(_) => return Err(bad_params("levels")),
        };
        let unset = match o.get("unset") {
            None => None,
            Some(Value::Array(a)) => Some(
                a.iter()
                    .map(|x| {
                        x.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| bad_params("unset"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(bad_params("unset")),
        };
        Ok(LevelsParams {
            default_level: string_member(o, "defaultLevel")?,
            levels,
            unset,
            trace_until: match o.get("traceUntil") {
                None => None,
                Some(Value::Null) => Some(TraceUntil::Clear),
                Some(other) => Some(TraceUntil::Set(other.clone())),
            },
        })
    }
}

impl TryFrom<&plur1bus_rpc::types::LogsLevelsParams> for LevelsParams {
    type Error = RpcErr;

    fn try_from(p: &plur1bus_rpc::types::LogsLevelsParams) -> Result<Self, RpcErr> {
        let mut v =
            serde_json::to_value(p).map_err(|_| invalid("params cannot be read", "schema"))?;
        // the generated type cannot tell `levels: {}` from no `levels`: an empty map is read as absent
        if let Value::Object(o) = &mut v {
            if o.get("levels")
                .and_then(Value::as_object)
                .is_some_and(Map::is_empty)
            {
                o.remove("levels");
            }
        }
        LevelsParams::from_value(&v)
    }
}

// ---- results ----

/// `LogPage`: the public part of a [`QueryResult`].
#[derive(Clone, Debug, PartialEq)]
pub struct LogPage {
    /// The page.
    pub records: Vec<LogRecordOut>,
    /// Resume token.
    pub next_cursor: Option<String>,
    /// Lines that were not records.
    pub corrupt: u64,
    /// Files read.
    pub scanned_files: usize,
    /// Bytes read.
    pub scanned_bytes: u64,
    /// The scan budget ran out.
    pub truncated: bool,
}

impl LogPage {
    fn of(r: &QueryResult) -> LogPage {
        LogPage {
            records: r.records.clone(),
            next_cursor: r.next_cursor.clone(),
            corrupt: r.corrupt,
            scanned_files: r.scanned_files,
            scanned_bytes: r.scanned_bytes,
            truncated: r.truncated,
        }
    }

    /// The result as the RPC schema shows it.
    pub fn to_value(&self) -> Value {
        let records: Vec<Value> = self
            .records
            .iter()
            .map(|r| {
                json!({
                    "ts": r.ts,
                    "level": r.level.map(Level::as_str),
                    "component": r.component,
                    "stream": stream_name(r.stream),
                    "record": r.record,
                })
            })
            .collect();
        json!({
            "records": records,
            "nextCursor": self.next_cursor,
            "corrupt": self.corrupt,
            "scanned": { "files": self.scanned_files, "bytes": self.scanned_bytes },
            "truncated": self.truncated,
        })
    }

    /// The generated result type (`LogsQueryResult` or `LogsTailResult`).
    pub fn into_result<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_value(self.to_value())
    }
}

/// The result of `logs.levels` (`publicLevels`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LevelsSnapshot {
    /// The global default.
    pub default_level: Level,
    /// The per-source overrides.
    pub levels: BTreeMap<String, Level>,
    /// RFC 3339 UTC; `None` when no trace expiry is armed.
    pub trace_until: Option<String>,
}

impl LevelsSnapshot {
    fn of(s: &LevelSettings) -> LevelsSnapshot {
        LevelsSnapshot {
            default_level: s.default_level.unwrap_or(Level::Info),
            levels: s.levels.clone(),
            trace_until: s.trace_until.and_then(iso_string),
        }
    }

    /// The result as the RPC schema shows it.
    pub fn to_value(&self) -> Value {
        let levels: Map<String, Value> = self
            .levels
            .iter()
            .map(|(k, l)| (k.clone(), Value::from(l.as_str())))
            .collect();
        json!({
            "defaultLevel": self.default_level.as_str(),
            "levels": levels,
            "traceUntil": self.trace_until,
        })
    }

    /// The generated result type (`LogsLevelsResult`).
    pub fn into_result<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_value(self.to_value())
    }
}

// ---- validation ----

/// `TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/`.
fn is_bound_shape(s: &str) -> bool {
    let b = s.as_bytes();
    let fixed = |i: usize, c: u8| match i {
        4 | 7 => c == b'-',
        10 => c == b'T',
        13 | 16 => c == b':',
        _ => c.is_ascii_digit(),
    };
    if b.len() < 20 || !b[..19].iter().enumerate().all(|(i, c)| fixed(i, *c)) {
        return false;
    }
    match b.len() {
        20 => b[19] == b'Z',
        22..=24 => {
            b[19] == b'.'
                && b[20..b.len() - 1].iter().all(u8::is_ascii_digit)
                && b[b.len() - 1] == b'Z'
        }
        _ => false,
    }
}

/// `bound(name, v)`: normalises to millisecond precision so it compares as text with the normalised record timestamps.
pub fn bound(name: &str, v: Option<&Value>) -> Result<Option<String>, RpcErr> {
    let Some(v) = v else { return Ok(None) };
    let not_a_timestamp = || {
        invalid(
            &format!("{name} must be an RFC 3339 UTC timestamp"),
            "bad-timestamp",
        )
    };
    let Value::String(s) = v else {
        return Err(not_a_timestamp());
    };
    if !is_bound_shape(s) {
        return Err(not_a_timestamp());
    }
    let ms = date_parse(s).ok_or_else(not_a_timestamp)?;
    let iso = iso_string(ms).ok_or_else(not_a_timestamp)?;
    // Date.parse rolls impossible dates over (02-30 becomes 03-02, 24:00 the next day): that would filter another range
    // than asked for.
    if iso[..19] != s[..19] {
        return Err(invalid(
            &format!("{name} is not a valid calendar time"),
            "bad-timestamp",
        ));
    }
    Ok(Some(iso))
}

/// `filterOf(p)`.
pub fn filter_of(p: &LogsParams) -> Result<LogFilter, RpcErr> {
    let stream = p.stream.unwrap_or(Stream::Diagnostic);
    let from = bound("from", p.from.as_ref())?;
    let to = bound("to", p.to.as_ref())?;
    if let (Some(from), Some(to)) = (&from, &to) {
        if from > to {
            return Err(invalid("from is after to", "empty-range"));
        }
    }
    // RULING: the audit stream has no level; a level filter on it is refused rather than silently ignored.
    if stream == Stream::Audit && p.min_level.is_some() {
        return Err(invalid(
            "the audit stream has no level",
            "level-not-applicable",
        ));
    }
    let non_empty = |s: &Option<String>| s.clone().filter(|s| !s.is_empty());
    Ok(LogFilter {
        stream,
        from,
        to,
        min_level: p.min_level,
        component: non_empty(&p.component),
        text: non_empty(&p.text),
        trace_id: non_empty(&p.trace_id),
    })
}

// ---- the handlers ----

/// `createLogsMethods(deps)`.
pub struct LogsMethods {
    dir: PathBuf,
    redactor: Arc<dyn TextRedactor>,
    signal: Option<AbortSignal>,
    now: Clock,
    sleep: SleepFn,
    poll_ms: u64,
    max_scan_bytes: Option<u64>,
    on_listed: Option<ListedHook>,
    writer: Option<Arc<dyn LevelControl>>,
    audit: Option<Arc<dyn AuditSink>>,
    actor: Option<ActorFn>,
}

impl LogsMethods {
    /// The handlers over `deps`. Fails when the default redactor cannot be built.
    pub fn new(deps: LogsDeps) -> Result<LogsMethods, LogsError> {
        let redactor: Arc<dyn TextRedactor> = match deps.redactor {
            Some(r) => r,
            None => Arc::new(
                Redactor::new(RedactOptions::default())
                    .map_err(|e| LogsError::Internal(e.to_string()))?,
            ),
        };
        Ok(LogsMethods {
            dir: deps.dir,
            redactor,
            signal: deps.signal,
            now: deps.now.unwrap_or_else(system_clock),
            sleep: deps.sleep.unwrap_or_else(|| {
                Arc::new(|ms: u64, signal: &AbortSignal| {
                    signal.wait(ms);
                })
            }),
            poll_ms: deps.poll_ms.unwrap_or(DEFAULT_POLL_MS),
            max_scan_bytes: deps.max_scan_bytes,
            on_listed: deps.on_listed,
            writer: deps.writer,
            audit: deps.audit,
            actor: deps.actor,
        })
    }

    /// The names the handlers are registered under.
    pub const METHODS: [&'static str; 3] = ["logs.levels", "logs.query", "logs.tail"];

    fn run(
        &self,
        filter: &LogFilter,
        order: Order,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<QueryResult, LogsError> {
        let hook = self.on_listed.as_ref().map(|h| move || h());
        let hook_ref: Option<&dyn Fn()> = hook.as_ref().map(|h| h as &dyn Fn());
        let mut options = QueryOptions::new(&self.dir, filter.clone(), order, limit);
        options.cursor = cursor.map(str::to_owned);
        options.redactor = Some(Arc::clone(&self.redactor));
        options.max_scan_bytes = self.max_scan_bytes;
        options.on_listed = hook_ref;
        run_query(&options).map_err(|e| match e {
            QueryError::Cursor(c) => LogsError::Rpc(invalid(
                match c {
                    CursorError::BadCursor => "malformed cursor",
                    CursorError::CursorMismatch => "cursor belongs to a different query",
                },
                c.reason(),
            )),
            other => LogsError::Internal(other.to_string()),
        })
    }

    /// `logs.query`.
    pub fn query(&self, params: &LogsParams) -> Result<LogPage, LogsError> {
        let filter = filter_of(params)?;
        let r = self.run(
            &filter,
            params.order.unwrap_or(Order::Desc),
            params.limit.unwrap_or(DEFAULT_LIMIT),
            params.cursor.as_deref(),
        )?;
        Ok(LogPage::of(&r))
    }

    /// `logs.tail`.
    pub fn tail(&self, params: &LogsParams, ctx: &CallContext) -> Result<LogPage, LogsError> {
        let filter = filter_of(params)?;
        let limit = params.limit.unwrap_or(DEFAULT_LIMIT);
        let deadline = (self.now)().saturating_add(params.wait_ms.unwrap_or(0));
        let stop = AbortSignal::new();
        let mut registered: Vec<(AbortSignal, u64)> = Vec::new();
        for source in std::iter::once(&ctx.signal).chain(self.signal.iter()) {
            let to_stop = stop.clone();
            match source.on_abort(Box::new(move || to_stop.abort())) {
                Some(id) => registered.push((source.clone(), id)),
                // a listener never fires for a signal that is already aborted
                None => stop.abort(),
            }
        }
        let result = self.tail_loop(&filter, limit, params, deadline, &stop);
        for (signal, id) in registered {
            signal.off(id);
        }
        result
    }

    fn tail_loop(
        &self,
        filter: &LogFilter,
        limit: usize,
        params: &LogsParams,
        deadline: i64,
        stop: &AbortSignal,
    ) -> Result<LogPage, LogsError> {
        let mut cursor = params.cursor.clone();
        loop {
            let out = match &cursor {
                None => {
                    // First call: the newest `limit` matches, oldest first. The cursor anchors at the newest line looked
                    // at (a match or not), so lines that arrive later are all "after" it even when nothing matched yet.
                    let back = self.run(filter, Order::Desc, limit, None)?;
                    let mut page = LogPage::of(&back);
                    page.records.reverse();
                    page.next_cursor = back
                        .first_key
                        .as_ref()
                        .map(|k| mint_cursor(filter, Order::Asc, k));
                    page
                }
                Some(c) => {
                    let r = self.run(filter, Order::Asc, limit, Some(c))?;
                    let mut page = LogPage::of(&r);
                    // A page cut by `limit` (or by the scan budget) carries the cursor to continue; otherwise move past
                    // what was looked at.
                    page.next_cursor = r
                        .next_cursor
                        .clone()
                        .or_else(|| {
                            r.last_key
                                .as_ref()
                                .map(|k| mint_cursor(filter, Order::Asc, k))
                        })
                        .or_else(|| Some(c.clone()));
                    page
                }
            };
            let now = (self.now)();
            if !out.records.is_empty() || now >= deadline || stop.is_aborted() {
                return Ok(out);
            }
            let wait = deadline.saturating_sub(now).max(1);
            let ms = u64::try_from(wait).unwrap_or(1).min(self.poll_ms);
            (self.sleep)(ms, stop);
            if stop.is_aborted() {
                return Ok(out);
            }
            cursor = out.next_cursor.or(cursor);
        }
    }

    /// `logs.levels`.
    pub fn levels(
        &self,
        params: &LevelsParams,
        ctx: &CallContext,
    ) -> Result<LevelsSnapshot, LogsError> {
        let Some(writer) = &self.writer else {
            return Err(
                RpcErr::new("E_NOT_AVAILABLE", "live log levels are not available", None).into(),
            );
        };
        let current = writer.current_levels();
        let changing = params.default_level.is_some()
            || params.levels.is_some()
            || params.unset.is_some()
            || params.trace_until.is_some();
        if !changing {
            return Ok(LevelsSnapshot::of(&current));
        }

        let invalid_level = |message: &str| invalid(message, "invalid-level");
        let mut next_levels = current.levels.clone();
        for (key, value) in params.levels.iter().flatten() {
            let level = value.as_str().and_then(Level::parse);
            let Some(level) = level.filter(|_| is_source_key(key)) else {
                return Err(invalid_level("invalid source level").into());
            };
            next_levels.insert(key.clone(), level);
        }
        for key in params.unset.iter().flatten() {
            if !is_source_key(key) {
                return Err(invalid_level("invalid source key").into());
            }
            next_levels.remove(key);
        }
        let mut trace_until = current.trace_until;
        match &params.trace_until {
            Some(TraceUntil::Clear) => trace_until = None,
            Some(TraceUntil::Set(v)) => {
                let iso = bound("traceUntil", Some(v))?;
                trace_until = iso.as_deref().and_then(date_parse);
            }
            None => {}
        }
        let default_level = match &params.default_level {
            Some(name) => {
                Level::parse(name).ok_or_else(|| invalid_level("invalid default level"))?
            }
            None => current.default_level.unwrap_or(Level::Info),
        };
        let next = LevelSettings {
            default_level: Some(default_level),
            levels: next_levels,
            trace_until,
        };
        writer
            .update_levels(next)
            .map_err(|message| invalid_level(&message))?;

        let after = writer.current_levels();
        let table = |s: &LevelSettings| -> BTreeMap<String, Level> {
            let mut m = BTreeMap::new();
            m.insert(
                "default".to_string(),
                s.default_level.unwrap_or(Level::Info),
            );
            m.extend(s.levels.iter().map(|(k, v)| (k.clone(), *v)));
            m
        };
        let (before_map, after_map) = (table(&current), table(&after));
        let actor = self.actor.as_ref().map_or_else(
            || Actor {
                user: "unknown".into(),
                host: "rpc".into(),
            },
            |f| f(ctx),
        );
        let now = (self.now)();
        let keys: BTreeSet<&String> = before_map.keys().chain(after_map.keys()).collect();
        for key in keys {
            let (was, is) = (before_map.get(key), after_map.get(key));
            if was == is {
                continue;
            }
            let mut detail = Map::new();
            if let Some(was) = was {
                detail.insert("from".into(), Value::from(was.as_str()));
            }
            let to = is
                .copied()
                .unwrap_or_else(|| after.default_level.unwrap_or(Level::Info));
            detail.insert("to".into(), Value::from(to.as_str()));
            self.append(&AuditEvent {
                at: now,
                actor: actor.clone(),
                action: "logs.levels".into(),
                target: key.clone(),
                detail: Value::Object(detail),
            });
        }
        if current.trace_until != after.trace_until {
            self.append(&AuditEvent {
                at: now,
                actor,
                action: "logs.levels".into(),
                target: "traceUntil".into(),
                detail: json!({ "from": current.trace_until, "to": after.trace_until }),
            });
        }
        Ok(LevelsSnapshot::of(&after))
    }

    /// The live change stands even when the trail cannot be written.
    fn append(&self, event: &AuditEvent) {
        if let Some(audit) = &self.audit {
            let _ = audit.append(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    const T0: i64 = 1_791_363_600_000;

    fn line(ms: i64, msg: &str) -> String {
        let ts = iso_string(T0 + ms).unwrap();
        format!("{{\"ts\":\"{ts}\",\"level\":\"info\",\"msg\":\"{msg}\"}}\n")
    }

    fn dir_with(text: &str) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("core.log"), text).unwrap();
        (root, dir)
    }

    fn fixed_clock(ms: i64) -> Clock {
        Arc::new(move || ms)
    }

    #[test]
    fn the_signal_fires_its_listeners_once_and_wakes_a_waiter() {
        let s = AbortSignal::new();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let id = s.on_abort(Box::new(move || {
            h.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(id.is_some());
        let other = s.clone();
        let t = std::thread::spawn(move || other.wait(900));
        std::thread::sleep(Duration::from_millis(30));
        let started = Instant::now();
        s.abort();
        s.abort();
        assert!(t.join().unwrap());
        assert!(started.elapsed() < Duration::from_millis(800));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(s.is_aborted());
        assert!(s.on_abort(Box::new(|| {})).is_none());
        let fresh = AbortSignal::new();
        let id = fresh.on_abort(Box::new(|| {})).unwrap();
        assert_eq!(fresh.listener_count(), 1);
        fresh.off(id);
        assert_eq!(fresh.listener_count(), 0);
        assert!(!fresh.wait(5));
    }

    #[test]
    fn a_tail_leaves_no_listener_behind_on_success_and_on_error() {
        let (_r, dir) = dir_with(&line(0, "a"));
        let core = AbortSignal::new();
        let mut deps = LogsDeps::new(&dir);
        deps.signal = Some(core.clone());
        deps.now = Some(fixed_clock(T0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (s, c, seen2) = (core.clone(), core.clone(), seen.clone());
        deps.sleep = Some(Arc::new(move |_ms, _stop| {
            seen2.lock().unwrap().push(s.listener_count());
        }));
        let m = LogsMethods::new(deps).unwrap();
        let ctx = CallContext::new("r1", "c1");
        let ctx_signal = ctx.signal.clone();

        let params = LogsParams {
            wait_ms: Some(2),
            text: Some("no-such-text".into()),
            ..LogsParams::default()
        };
        // the clock never moves, so the loop would spin: stop it on the first sleep
        let ctx2 = CallContext::new("r2", "c2");
        let stopper = ctx2.signal.clone();
        let m_deps_sleep: SleepFn = Arc::new(move |_ms, _stop| stopper.abort());
        let mut d2 = LogsDeps::new(&dir);
        d2.signal = Some(c.clone());
        d2.now = Some(fixed_clock(T0));
        d2.sleep = Some(m_deps_sleep);
        let m2 = LogsMethods::new(d2).unwrap();
        let page = m2.tail(&params, &ctx2).unwrap();
        assert!(page.records.is_empty());
        assert_eq!(c.listener_count(), 0);
        assert_eq!(ctx2.signal.listener_count(), 0);

        let bad = LogsParams {
            from: Some(Value::from("yesterday")),
            ..LogsParams::default()
        };
        assert!(m.tail(&bad, &ctx).is_err());
        assert_eq!(core.listener_count(), 0);
        assert_eq!(ctx_signal.listener_count(), 0);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn the_default_sleep_wakes_early_when_the_call_is_aborted() {
        let (_r, dir) = dir_with(&line(0, "a"));
        let mut deps = LogsDeps::new(&dir);
        deps.poll_ms = Some(900);
        let m = LogsMethods::new(deps).unwrap();
        let ctx = CallContext::new("r", "c");
        let signal = ctx.signal.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            signal.abort();
        });
        let started = Instant::now();
        let params = LogsParams {
            text: Some("never-present".into()),
            wait_ms: Some(30_000),
            ..LogsParams::default()
        };
        let page = m.tail(&params, &ctx).unwrap();
        t.join().unwrap();
        assert!(page.records.is_empty());
        assert!(page.next_cursor.is_some());
        assert!(started.elapsed() < Duration::from_millis(800));
        assert_eq!(ctx.signal.listener_count(), 0);
    }

    #[test]
    fn an_injected_redactor_and_the_listed_hook_are_used() {
        struct Upper;
        impl TextRedactor for Upper {
            fn text(&self, input: &str) -> String {
                input.to_uppercase()
            }
            fn value(&self, input: &Value) -> Value {
                let mut v = input.clone();
                v["msg"] = Value::from("SWAPPED");
                v
            }
        }
        let (_r, dir) = dir_with(&line(0, "plain"));
        let hook_hits = Arc::new(AtomicUsize::new(0));
        let h = hook_hits.clone();
        let mut deps = LogsDeps::new(&dir);
        deps.redactor = Some(Arc::new(Upper));
        deps.on_listed = Some(Arc::new(move || {
            h.fetch_add(1, Ordering::SeqCst);
        }));
        let m = LogsMethods::new(deps).unwrap();
        let page = m.query(&LogsParams::default()).unwrap();
        assert_eq!(page.records[0].record["msg"], "SWAPPED");
        assert!(hook_hits.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn a_page_has_exactly_the_five_schema_members_and_converts_to_the_generated_type() {
        let (_r, dir) = dir_with(&(line(0, "a") + &line(1000, "b")));
        let m = LogsMethods::new(LogsDeps::new(&dir)).unwrap();
        let page = m.query(&LogsParams::default()).unwrap();
        let v = page.to_value();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["corrupt", "nextCursor", "records", "scanned", "truncated"]
        );
        let typed: plur1bus_rpc::types::LogsQueryResult = page.into_result().unwrap();
        let back = serde_json::to_value(&typed).unwrap();
        assert_eq!(back["records"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn params_reject_the_wrong_types_and_convert_from_the_generated_ones() {
        for bad in [
            serde_json::json!([]),
            serde_json::json!({"stream": "other"}),
            serde_json::json!({"minLevel": 3}),
            serde_json::json!({"order": "up"}),
            serde_json::json!({"limit": -1}),
            serde_json::json!({"limit": "5"}),
            serde_json::json!({"waitMs": 1.5}),
            serde_json::json!({"text": 1}),
        ] {
            let e = LogsParams::from_value(&bad).unwrap_err();
            assert_eq!(e.code, "E_INVALID_PARAMS", "{bad}");
        }
        let ok = LogsParams::from_value(
            &serde_json::json!({"limit": 3, "order": "asc", "minLevel": "warn"}),
        )
        .unwrap();
        assert_eq!(ok.limit, Some(3));
        assert_eq!(ok.order, Some(Order::Asc));
        let generated: plur1bus_rpc::types::LogsQueryParams =
            serde_json::from_value(serde_json::json!({"limit": 3, "stream": "audit", "text": "x"}))
                .unwrap();
        let converted = LogsParams::try_from(&generated).unwrap();
        assert_eq!(converted.stream, Some(Stream::Audit));
        assert_eq!(converted.text.as_deref(), Some("x"));
        let l = LevelsParams::from_value(
            &serde_json::json!({"defaultLevel": "warn", "traceUntil": null}),
        )
        .unwrap();
        assert!(matches!(l.trace_until, Some(TraceUntil::Clear)));
        assert!(LevelsParams::from_value(&serde_json::json!({"unset": "x"})).is_err());
    }

    #[test]
    fn errors_map_to_the_dispatcher_error() {
        let e = LogsError::Rpc(RpcErr::new(
            "E_INVALID_PARAMS",
            "bad",
            Some("cursor-mismatch"),
        ));
        assert!(e.rpc().is_some());
        assert!(e.into_method_error().is_some());
        assert!(LogsError::Internal("disk".into())
            .into_method_error()
            .is_some());
        assert!(LogsError::Rpc(RpcErr::new("E_NOT_A_CODE", "x", None))
            .into_method_error()
            .is_none());
    }

    #[test]
    fn levels_need_a_writer_and_a_live_writer_applies_and_audits_changes() {
        struct Fake(Mutex<LevelSettings>);
        impl LevelControl for Fake {
            fn current_levels(&self) -> LevelSettings {
                self.0.lock().unwrap().clone()
            }
            fn update_levels(&self, s: LevelSettings) -> Result<(), String> {
                *self.0.lock().unwrap() = s;
                Ok(())
            }
        }
        struct Trail(Mutex<Vec<AuditEvent>>);
        impl AuditSink for Trail {
            fn append(&self, e: &AuditEvent) -> Result<(), String> {
                self.0.lock().unwrap().push(e.clone());
                Ok(())
            }
        }
        let (_r, dir) = dir_with("");
        let ctx = CallContext::new("r", "c");
        let none = LogsMethods::new(LogsDeps::new(&dir)).unwrap();
        let e = none.levels(&LevelsParams::default(), &ctx).unwrap_err();
        assert_eq!(e.rpc().unwrap().code, "E_NOT_AVAILABLE");

        let fake = Arc::new(Fake(Mutex::new(LevelSettings::default())));
        let trail = Arc::new(Trail(Mutex::new(Vec::new())));
        let mut deps = LogsDeps::new(&dir);
        deps.writer = Some(fake.clone());
        deps.audit = Some(trail.clone());
        deps.now = Some(fixed_clock(T0));
        let m = LogsMethods::new(deps).unwrap();
        m.levels(&LevelsParams::default(), &ctx).unwrap();
        assert!(trail.0.lock().unwrap().is_empty(), "a read does not audit");
        let change = LevelsParams {
            default_level: Some("warn".into()),
            ..LevelsParams::default()
        };
        m.levels(&change, &ctx).unwrap();
        assert_eq!(fake.current_levels().default_level, Some(Level::Warn));
        let events = trail.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].target, "default");
        assert_eq!(events[0].actor.host, "rpc");
        drop(events);
        let bad = LevelsParams {
            default_level: Some("loud".into()),
            ..LevelsParams::default()
        };
        assert_eq!(
            m.levels(&bad, &ctx)
                .unwrap_err()
                .rpc()
                .unwrap()
                .reason
                .as_deref(),
            Some("invalid-level")
        );
    }
}
