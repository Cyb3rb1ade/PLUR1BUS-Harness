//! Turn-level replay protection from the pinned `engine/capture/turn-replay-guard.js`.
//!
//! This is the capture WAL: planned row ids are durable before the first Lance write;
//! settlement replaces that pending entry. It is distinct from Neo's turn-event journal.
//! Read/write failures fail open, while the current process retains its in-memory guard.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::contract::{Cancel, CaptureResult, EngineError, StoreError, TurnRecord};
use crate::store::{atomic_write::atomic_write, paths::assert_trusted_path};
use crate::text::{
    js::JsString,
    json::{parse_json, write_json, TolerantJsonValue as Json},
};

use super::logging::{CaptureLogSink, CaptureLogStage, SafeCaptureLog, StandardCaptureLog};

/// Maximum completed or pending turns retained per agent, oldest first.
pub const REPLAY_GUARD_MAX_ENTRIES: usize = 512;
/// Inclusive lifetime of completed and pending keys: seven days.
pub const REPLAY_GUARD_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_ROW_IDS: usize = 10_000;

/// Node's exact key material and its SHA-256, preserving lone UTF-16 surrogates.
#[must_use]
pub fn turn_key_material(
    agent: &JsString,
    run: Option<&JsString>,
    session: Option<&JsString>,
    messages: &[(JsString, JsString)],
) -> (String, String) {
    let optional =
        |value: Option<&JsString>| value.map_or_else(|| "null".to_owned(), JsString::to_json);
    let messages = messages
        .iter()
        .map(|(role, content)| format!("[{},{}]", role.to_json(), content.to_json()))
        .collect::<Vec<_>>()
        .join(",");
    let material = format!(
        "[{},{},{},[{messages}]]",
        agent.to_json(),
        optional(run),
        optional(session)
    );
    let key = format!("{:x}", Sha256::digest(material.as_bytes()));
    (material, key)
}

/// Derive the Node replay key for a validated engine-contract turn.
///
/// # Errors
/// Returns an input error if a future contract turn cannot be serialized.
pub fn turn_key_of(turn: &TurnRecord) -> Result<String, EngineError> {
    let turn = serde_json::to_value(turn).map_err(|_| EngineError::Invalid {
        field: "turn".to_owned(),
        message: "capture turn cannot be serialized".to_owned(),
    })?;
    let agent = JsString::from(turn["agentId"].as_str().unwrap_or_default());
    let run = turn["runId"].as_str().map(JsString::from);
    let session = turn["sessionKey"].as_str().map(JsString::from);
    let messages = turn["messages"]
        .as_array()
        .map_or_else(Vec::new, |messages| {
            messages
                .iter()
                .map(|message| {
                    (
                        JsString::from(message["role"].as_str().unwrap_or_default()),
                        JsString::from(message["content"].as_str().unwrap_or_default()),
                    )
                })
                .collect()
        });
    Ok(turn_key_material(&agent, run.as_ref(), session.as_ref(), &messages).1)
}

#[derive(Clone)]
struct Entry {
    key: JsString,
    at: f64,
    pending: Option<Vec<String>>,
}

#[derive(Default)]
struct State {
    agents: HashMap<String, Vec<Entry>>,
    in_flight: HashSet<(String, String)>,
    warnings: usize,
}

struct Inner {
    root: PathBuf,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    logger: Arc<dyn CaptureLogSink>,
    state: Mutex<State>,
    changed: Condvar,
}

/// Shared replay state with one flight per agent/key, independent of waiter cancellation.
#[derive(Clone)]
pub struct ReplayGuard(Arc<Inner>);

impl ReplayGuard {
    /// Configure a guard without reading or writing any state file.
    #[must_use]
    pub fn new(root: PathBuf, clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self::with_logger(root, clock, Arc::new(StandardCaptureLog))
    }

    /// Configure the same guard with an engine-owned content-free diagnostic sink.
    #[must_use]
    pub fn with_logger(
        root: PathBuf,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        logger: Arc<dyn CaptureLogSink>,
    ) -> Self {
        Self(Arc::new(Inner {
            root,
            clock,
            logger,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
        }))
    }

    /// Number of failed state reads, invalid payloads and failed writes in this guard.
    #[must_use]
    pub fn warning_count(&self) -> usize {
        lock(&self.0.state).warnings
    }

    /// Run one capture, or wait for an identical running capture before retrying admission.
    ///
    /// Cancellation only bounds an identical flight's waiter, matching Node. The worker
    /// checks its own cancellation at capture boundaries. Owned callbacks remain usable
    /// after this method returns a scheduler timeout while the worker is still settling.
    ///
    /// # Errors
    /// Propagates the worker error without recording an incomplete capture.
    pub fn run(
        &self,
        agent: &str,
        key: &str,
        cancel: &Cancel,
        work: impl FnOnce(ReplayRows) -> Result<CaptureResult, EngineError>,
    ) -> Result<CaptureResult, EngineError> {
        self.run_with_wait_hook(agent, key, cancel, || {}, work)
    }

    /// Capture admission releases its per-agent ticket before an identical-flight wait.
    /// The hook runs under replay state and must only release admission state; it must not
    /// enter this guard again or perform host I/O. Ordinary guard callers use `run` unchanged.
    pub(super) fn run_with_wait_hook(
        &self,
        agent: &str,
        key: &str,
        cancel: &Cancel,
        mut on_wait: impl FnMut(),
        work: impl FnOnce(ReplayRows) -> Result<CaptureResult, EngineError>,
    ) -> Result<CaptureResult, EngineError> {
        let rows = match self.enter(agent, key, cancel, &mut on_wait) {
            Admission::Done(reason) => return Ok(skipped(reason)),
            Admission::Run(rows) => rows,
        };
        let _flight = Flight {
            guard: self.clone(),
            key: (agent.to_owned(), key.to_owned()),
        };
        let result = work(rows.clone());
        if result.as_ref().is_ok_and(|result| result.reason.is_none()) {
            rows.on_rows_settled();
        }
        result
    }

    fn enter(
        &self,
        agent: &str,
        key: &str,
        cancel: &Cancel,
        on_wait: &mut impl FnMut(),
    ) -> Admission {
        let flight = (agent.to_owned(), key.to_owned());
        let lookup = JsString::from(key);
        let mut state = lock(&self.0.state);
        loop {
            self.load(&mut state, agent);
            let now = self.now();
            let entries = state.agents.get(agent).map_or(&[][..], Vec::as_slice);
            if entries
                .iter()
                .any(|entry| entry.key == lookup && entry.pending.is_none() && fresh(entry, now))
            {
                return Admission::Done("duplicate-turn");
            }
            if !state.in_flight.contains(&flight) {
                let stale = entries
                    .iter()
                    .find(|entry| {
                        entry.key == lookup && entry.pending.is_some() && fresh(entry, now)
                    })
                    .and_then(|entry| entry.pending.clone())
                    .unwrap_or_default();
                state.in_flight.insert(flight);
                return Admission::Run(ReplayRows(Arc::new(RowsInner {
                    guard: self.clone(),
                    agent: agent.to_owned(),
                    key: key.to_owned(),
                    stale,
                    recorded: Mutex::new(false),
                })));
            }
            // Existing waiters await the flight promise even if its rows settle early.
            // A newly arriving caller observes the recorded key in the outer loop.
            on_wait();
            while state.in_flight.contains(&flight) {
                if cancel.is_cancelled() {
                    return Admission::Done("aborted");
                }
                let duration = cancel
                    .remaining()
                    .unwrap_or(Duration::from_millis(5))
                    .min(Duration::from_millis(5));
                state = self
                    .0
                    .changed
                    .wait_timeout(state, duration)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
        }
    }

    #[allow(clippy::cast_precision_loss)] // Node clock arithmetic uses IEEE-754 numbers.
    fn now(&self) -> f64 {
        (self.0.clock)() as f64
    }

    fn path(&self, agent: &str) -> PathBuf {
        self.0
            .root
            .join(format!("{}.json", encode_component(agent)))
    }

    fn load(&self, state: &mut State, agent: &str) {
        if state.agents.contains_key(agent) {
            return;
        }
        let path = self.path(agent);
        let loaded = assert_trusted_path(&path)
            .and_then(|()| fs::read_to_string(path).map_err(StoreError::from));
        let entries = match loaded {
            Ok(raw) => match parse_entries(&raw) {
                Some(entries) => entries,
                None => {
                    self.warn(state, StoreError::Corrupt);
                    Vec::new()
                }
            },
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => Vec::new(),
            Err(error) => {
                self.warn(state, error);
                Vec::new()
            }
        };
        state.agents.insert(agent.to_owned(), entries);
    }

    fn record(&self, agent: &str, key: &str, change: Change) {
        let mut state = lock(&self.0.state);
        self.load(&mut state, agent);
        let now = self.now();
        let lookup = JsString::from(key);
        let entries = state.agents.entry(agent.to_owned()).or_default();
        entries.retain(|entry| entry.key != lookup && fresh(entry, now));
        match change {
            Change::Settled => entries.push(Entry {
                key: lookup,
                at: now,
                pending: None,
            }),
            Change::Pending(ids) => entries.push(Entry {
                key: lookup,
                at: now,
                pending: Some(ids),
            }),
            Change::Kept => {}
        }
        let discard = entries.len().saturating_sub(REPLAY_GUARD_MAX_ENTRIES);
        entries.drain(..discard);
        let raw = encode_entries(entries);
        let path = self.path(agent);
        let saved = assert_trusted_path(&path)
            .and_then(|()| atomic_write(&path, raw.as_bytes()).map_err(StoreError::from));
        if let Err(error) = saved {
            self.warn(&mut state, error);
        }
    }

    fn warn(&self, state: &mut State, error: StoreError) {
        state.warnings = state.warnings.saturating_add(1);
        self.0.logger.record(SafeCaptureLog::from_error(
            CaptureLogStage::ReplayState,
            &EngineError::Store(error),
            1,
        ));
    }
}

enum Admission {
    Done(&'static str),
    Run(ReplayRows),
}
enum Change {
    Settled,
    Pending(Vec<String>),
    Kept,
}

struct RowsInner {
    guard: ReplayGuard,
    agent: String,
    key: String,
    stale: Vec<String>,
    recorded: Mutex<bool>,
}

/// Owned callbacks and stale row ids for a single capture, safe to retain after timeout.
#[derive(Clone)]
pub struct ReplayRows(Arc<RowsInner>);

impl ReplayRows {
    /// Ids of rows planned by an earlier, uncompleted attempt, in Node order.
    #[must_use]
    pub fn stale_row_ids(&self) -> &[String] {
        &self.0.stale
    }

    /// Persist planned ids, unioned with stale ids, before writing any row.
    pub fn on_rows_planned(&self, ids: &[String]) {
        let recorded = lock(&self.0.recorded);
        if *recorded {
            return;
        }
        let mut combined = self.0.stale.clone();
        combined.extend(
            ids.iter()
                .filter(|id| valid_uuid(id))
                .take(MAX_PENDING_ROW_IDS)
                .cloned(),
        );
        let mut seen = HashSet::new();
        combined.retain(|id| seen.insert(id.clone()));
        self.0
            .guard
            .record(&self.0.agent, &self.0.key, Change::Pending(combined));
    }

    /// Record successful row settlement exactly once, before post-store work.
    pub fn on_rows_settled(&self) {
        let mut recorded = lock(&self.0.recorded);
        if *recorded {
            return;
        }
        *recorded = true;
        self.0
            .guard
            .record(&self.0.agent, &self.0.key, Change::Settled);
    }

    /// Keep a partly stored capture's rows and remove its pending replay cleanup ids.
    pub fn on_rows_kept(&self) {
        let recorded = lock(&self.0.recorded);
        if !*recorded {
            self.0
                .guard
                .record(&self.0.agent, &self.0.key, Change::Kept);
        }
    }
}

struct Flight {
    guard: ReplayGuard,
    key: (String, String),
}
impl Drop for Flight {
    fn drop(&mut self) {
        lock(&self.guard.0.state).in_flight.remove(&self.key);
        self.guard.0.changed.notify_all();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[allow(clippy::cast_precision_loss)]
fn fresh(entry: &Entry, now: f64) -> bool {
    now - entry.at <= REPLAY_GUARD_TTL_MS as f64
}

fn skipped(reason: &str) -> CaptureResult {
    CaptureResult {
        stored: 0.into(),
        skipped: 1.into(),
        reason: Some(reason.to_owned()),
        diagnostics: None,
    }
}

fn valid_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn encode_component(value: &str) -> String {
    use std::fmt::Write;
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn field<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    match value {
        Json::Object(fields) => fields
            .iter()
            .rev()
            .find(|(key, _)| key == &JsString::from(name))
            .map(|(_, value)| value),
        _ => None,
    }
}

fn number(value: &Json) -> Option<f64> {
    match value {
        Json::Number(value) => value.parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

fn parse_entries(raw: &str) -> Option<Vec<Entry>> {
    let parsed = parse_json(raw).ok()?;
    if field(&parsed, "v").and_then(number) != Some(1.0) {
        return None;
    }
    let Json::Array(entries) = field(&parsed, "entries")? else {
        return None;
    };
    Some(
        entries
            .iter()
            .filter_map(|entry| {
                let Json::String(key) = field(entry, "key")? else {
                    return None;
                };
                let at = field(entry, "at").and_then(number)?;
                let pending = match field(entry, "pending") {
                    Some(Json::Array(ids)) => Some(
                        ids.iter()
                            .filter_map(|id| match id {
                                Json::String(id) => Some(id.to_utf8_lossy()),
                                _ => None,
                            })
                            .filter(|id| valid_uuid(id))
                            .take(MAX_PENDING_ROW_IDS)
                            .collect(),
                    ),
                    _ => None,
                };
                Some(Entry {
                    key: key.clone(),
                    at,
                    pending,
                })
            })
            .collect(),
    )
}

fn encode_entries(entries: &[Entry]) -> String {
    let entries = entries
        .iter()
        .map(|entry| {
            let mut fields = vec![
                (JsString::from("key"), Json::String(entry.key.clone())),
                (JsString::from("at"), Json::Number(node_number(entry.at))),
            ];
            if let Some(ids) = &entry.pending {
                fields.push((
                    JsString::from("pending"),
                    Json::Array(
                        ids.iter()
                            .map(|id| Json::String(JsString::from(id.as_str())))
                            .collect(),
                    ),
                ));
            }
            Json::Object(fields)
        })
        .collect();
    write_json(&Json::Object(vec![
        (JsString::from("v"), Json::Number("1".to_owned())),
        (JsString::from("entries"), Json::Array(entries)),
    ]))
}

// Clock values are integral; loaded Node timestamps may also use exponent notation.
fn node_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let raw = value.to_string();
    if (1e-6..1e21).contains(&value.abs()) {
        return raw;
    }
    let sign = if value.is_sign_negative() { "-" } else { "" };
    let unsigned = raw.trim_start_matches('-');
    let point = unsigned.find('.').unwrap_or(unsigned.len());
    let digits: String = unsigned.chars().filter(|ch| *ch != '.').collect();
    let leading = digits.bytes().position(|byte| byte != b'0').unwrap_or(0);
    let significant = digits.get(leading..).unwrap_or("").trim_end_matches('0');
    let exponent =
        i64::try_from(point).unwrap_or(i64::MAX) - i64::try_from(leading).unwrap_or(i64::MAX) - 1;
    let (first, rest) = significant.split_at(significant.len().min(1));
    let fraction = if rest.is_empty() {
        String::new()
    } else {
        format!(".{rest}")
    };
    format!(
        "{sign}{first}{fraction}e{}{exponent}",
        if exponent >= 0 { "+" } else { "" }
    )
}
