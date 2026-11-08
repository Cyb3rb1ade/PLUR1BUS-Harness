//! The pinned Node post-turn file queue: ordered payload bytes, FIFO retries, caps and drain lock.
//!
//! Queue data never travels through serde_json::Value: payload order and lone UTF-16 surrogates
//! remain intact. Diagnostic events carry only fixed categories, never entry or error contents.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde::Serialize;
use uuid::Uuid;

use crate::contract::{EngineError, StoreError};
use crate::store::atomic_write::atomic_write;
use crate::store::directory::TrustedDirectory;
use crate::store::lock::{Lock, LockGuard, JOB_LOCK_HARD_CEILING_FACTOR};
use crate::store::paths::{assert_trusted_path, secure_dir};
use crate::text::js::JsString;
use crate::text::json::{parse_json, write_json, TolerantJsonValue};

use super::logging::{CaptureLogSink, CaptureLogStage, SafeCaptureLog, StandardCaptureLog};

/// The canonical private directory containing agent queues.
pub const POST_TURN_QUEUE_DIR: &str = ".post-turn-queue";
/// Maximum queued entries per agent; oldest lexicographic filenames are discarded first.
pub const POST_TURN_QUEUE_CAP: usize = 200;
/// A third failed processing attempt drops the entry and allows the following batch to run.
pub const POST_TURN_MAX_ATTEMPTS: u64 = 3;

/// Receipt from one atomic post-turn enqueue.
#[derive(Clone, Debug)]
pub struct EnqueuedPostTurn {
    /// Random UUID attached to the payload and filename.
    pub id: String,
    /// Agent-relative filename, without the directory.
    pub file: String,
    /// Oldest entries removed by the cap after enqueue.
    pub dropped: usize,
}

/// Drain limits. The budget starts after lock acquisition, matching Node.
#[derive(Clone, Copy, Debug)]
pub struct DrainOptions {
    /// Maximum successful entries; failed/malformed entries do not spend this count.
    pub max_entries: i64,
    /// Elapsed clock budget in milliseconds; equality is still inside the budget.
    pub budget_ms: i64,
}

impl Default for DrainOptions {
    fn default() -> Self {
        Self {
            max_entries: 10,
            budget_ms: 300_000,
        }
    }
}

/// Exact Node drain fields, including the different locked-return shape.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainResult {
    /// Entries completed and removed.
    pub processed: usize,
    /// Entries whose callback returned false or failed.
    pub failed: usize,
    /// Malformed or exhausted entries removed.
    pub dropped: usize,
    /// Valid queue filenames left after the run.
    pub remaining: usize,
    /// Present only on failed lock acquisition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    /// Present on acquired-lock runs, including false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_hit: Option<bool>,
}

impl DrainResult {
    fn new() -> Self {
        Self {
            processed: 0,
            failed: 0,
            dropped: 0,
            remaining: 0,
            locked: None,
            deadline_hit: Some(false),
        }
    }

    /// Compact Node field order, compared as bytes against the recorder.
    #[must_use]
    pub fn node_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "null".into())
    }
}

/// Persistent post-turn queue rooted in the configured engine database directory.
pub struct PostTurnQueue {
    base: PathBuf,
    log: Arc<dyn CaptureLogSink>,
}

impl PostTurnQueue {
    /// Validate the root without creating a queue or reading its content.
    pub fn open(base: &Path) -> Result<Self, StoreError> {
        assert_trusted_path(base)?;
        Ok(Self {
            base: base.to_owned(),
            log: Arc::new(StandardCaptureLog),
        })
    }

    /// Use the host's content-free capture event sink.
    #[must_use]
    pub fn with_log_sink(mut self, sink: Arc<dyn CaptureLogSink>) -> Self {
        self.log = sink;
        self
    }

    /// Atomically append one payload, preserving existing property positions when metadata overwrites them.
    /// New entries contain no final newline, exactly as Node's `JSON.stringify` writer.
    pub fn enqueue(
        &self,
        agent: &str,
        payload: TolerantJsonValue,
        now_ms: i64,
    ) -> Result<EnqueuedPostTurn, StoreError> {
        let directory = self.queue_dir(agent)?;
        let TolerantJsonValue::Object(mut fields) = payload else {
            return Err(StoreError::InvalidInput);
        };
        let id = Uuid::new_v4().to_string();
        let file = format!("{now_ms:013}-{id}.json");
        set(&mut fields, "id", string(&id));
        set(&mut fields, "agentId", string(agent));
        set(
            &mut fields,
            "enqueuedAt",
            TolerantJsonValue::Number(now_ms.to_string()),
        );
        set(
            &mut fields,
            "attempts",
            TolerantJsonValue::Number("0".into()),
        );
        self.write_entry(&directory.join(&file), &TolerantJsonValue::Object(fields))?;
        let files = list_entries(&directory)?;
        let mut dropped = 0;
        for name in files
            .iter()
            .take(files.len().saturating_sub(POST_TURN_QUEUE_CAP))
        {
            match fs::remove_file(directory.join(name)) {
                Ok(()) => dropped += 1,
                Err(error) => self.log_store(StoreError::from(error)),
            }
        }
        Ok(EnqueuedPostTurn { id, file, dropped })
    }

    /// Node's best-effort count: absence, invalid agent and unreadable paths all count as zero.
    #[must_use]
    pub fn count(&self, agent: &str) -> usize {
        if !safe_agent(agent) {
            return 0;
        }
        let directory = self.base.join(POST_TURN_QUEUE_DIR).join(agent);
        if assert_trusted_path(&directory).is_err()
            || exact_agent_directory(&directory, agent).is_err()
        {
            return 0;
        }
        list_entries(&directory).map_or(0, |entries| entries.len())
    }

    /// Drain FIFO under the native lock, stopping after a retryable failed batch.
    /// Only a successful callback removes an ordinary entry; failed payloads retain exact original fields.
    pub fn drain(
        &self,
        agent: &str,
        mut process: impl FnMut(&TolerantJsonValue) -> Result<bool, EngineError>,
        options: DrainOptions,
        mut now: impl FnMut() -> i64,
    ) -> Result<DrainResult, StoreError> {
        let directory = self.queue_dir(agent)?;
        let held = TrustedDirectory::open(&directory)?;
        let mut result = DrainResult::new();
        let Some(_guard) = DrainLock::acquire(&directory.join(".drain.lock")) else {
            result.remaining = list_entries(&directory)?.len();
            result.locked = Some(true);
            result.deadline_hit = None;
            return Ok(result);
        };
        let started = now();
        for name in list_entries(&directory)? {
            if result.processed as i64 >= options.max_entries {
                break;
            }
            if now().saturating_sub(started) > options.budget_ms {
                result.deadline_hit = Some(true);
                break;
            }
            let path = directory.join(name);
            // Refuse linked/special/unbounded input without invoking the callback or deleting
            // the suspect entry. Keep the directory capability alive throughout the drain.
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or(StoreError::UntrustedPath)?;
            let file = held.open_file(name)?;
            const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
            if file.metadata().map_err(StoreError::from)?.len() > MAX_ENTRY_BYTES {
                return Err(StoreError::Corrupt);
            }
            let mut bytes = Vec::new();
            file.take(MAX_ENTRY_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(StoreError::from)?;
            held.assert_unchanged()?;
            if bytes.len() as u64 > MAX_ENTRY_BYTES {
                return Err(StoreError::Corrupt);
            }
            let parsed =
                parse_json(&String::from_utf8_lossy(&bytes)).map_err(|_| StoreError::Corrupt);
            let mut entry = match parsed {
                Ok(entry) => entry,
                Err(error) => {
                    self.log_store(error);
                    fs::remove_file(&path).map_err(StoreError::from)?;
                    result.dropped += 1;
                    continue;
                }
            };
            assert_entry_agent(&entry, agent)?;
            let ok = match process(&entry) {
                Ok(ok) => ok,
                Err(error) => {
                    self.log.record(SafeCaptureLog::from_error(
                        CaptureLogStage::PostTurnQueue,
                        &error,
                        1,
                    ));
                    false
                }
            };
            if ok {
                fs::remove_file(&path).map_err(StoreError::from)?;
                result.processed += 1;
                continue;
            }
            result.failed += 1;
            let attempts = entry_attempts(&entry) + 1.0;
            if attempts >= POST_TURN_MAX_ATTEMPTS as f64 {
                fs::remove_file(&path).map_err(StoreError::from)?;
                result.dropped += 1;
                continue;
            }
            let TolerantJsonValue::Object(fields) = &mut entry else {
                // Node's object-spread retry converts arrays/primitives into enumerable properties.
                // The callback boundary still receives the original parsed value above.
                entry = spread_object(entry);
                let TolerantJsonValue::Object(fields) = &mut entry else {
                    return Err(StoreError::Corrupt);
                };
                set(fields, "attempts", number(attempts));
                self.write_entry(&path, &entry)?;
                break;
            };
            set(fields, "attempts", number(attempts));
            self.write_entry(&path, &entry)?;
            break;
        }
        result.remaining = list_entries(&directory)?.len();
        Ok(result)
    }

    fn queue_dir(&self, agent: &str) -> Result<PathBuf, StoreError> {
        if !safe_agent(agent) {
            return Err(StoreError::InvalidInput);
        }
        let root = self.base.join(POST_TURN_QUEUE_DIR);
        secure_dir(&root)?;
        let directory = root.join(agent);
        secure_dir(&directory)?;
        exact_agent_directory(&directory, agent)?;
        Ok(directory)
    }

    fn write_entry(&self, path: &Path, value: &TolerantJsonValue) -> Result<(), StoreError> {
        assert_trusted_path(path)?;
        atomic_write(path, write_json(&node_json_value(value.clone())).as_bytes())
            .map_err(StoreError::from)
    }

    fn log_store(&self, error: StoreError) {
        self.log.record(SafeCaptureLog::from_error(
            CaptureLogStage::PostTurnQueue,
            &EngineError::Store(error),
            1,
        ));
    }
}

// APFS/NTFS can resolve distinct contract IDs to the same pathname. Never normalize
// identity: require the exact on-disk spelling before counting, enqueueing or draining.
fn exact_agent_directory(directory: &Path, agent: &str) -> Result<(), StoreError> {
    let parent = directory.parent().ok_or(StoreError::UntrustedPath)?;
    for entry in fs::read_dir(parent).map_err(StoreError::from)? {
        let entry = entry.map_err(StoreError::from)?;
        if entry.file_name() == std::ffi::OsStr::new(agent) {
            let kind = entry.file_type().map_err(StoreError::from)?;
            return if kind.is_dir() && !kind.is_symlink() {
                Ok(())
            } else {
                Err(StoreError::UntrustedPath)
            };
        }
    }
    Err(StoreError::UntrustedPath)
}

fn assert_entry_agent(entry: &TolerantJsonValue, agent: &str) -> Result<(), StoreError> {
    let TolerantJsonValue::Object(fields) = entry else {
        return Err(StoreError::Corrupt);
    };
    let key = JsString::from("agentId");
    let expected = JsString::from(agent);
    let mut identities = fields.iter().filter(|(name, _)| *name == key);
    match (identities.next(), identities.next()) {
        (Some((_, TolerantJsonValue::String(actual))), None) if actual == &expected => Ok(()),
        _ => Err(StoreError::UntrustedPath),
    }
}

fn safe_agent(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.len() <= 128
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn entry_file(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 55
        && bytes[..13].iter().all(u8::is_ascii_digit)
        && bytes[13] == b'-'
        && bytes[14..50]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte) || *byte == b'-')
        && &bytes[50..] == b".json"
}

fn list_entries(directory: &Path) -> Result<Vec<String>, StoreError> {
    let mut names = Vec::new();
    for item in fs::read_dir(directory).map_err(StoreError::from)? {
        let item = item.map_err(StoreError::from)?;
        if let Some(name) = item.file_name().to_str().filter(|name| entry_file(name)) {
            let kind = item.file_type().map_err(StoreError::from)?;
            if !kind.is_file() || kind.is_symlink() {
                return Err(StoreError::UntrustedPath);
            }
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

fn string(value: &str) -> TolerantJsonValue {
    TolerantJsonValue::String(JsString::from(value))
}
fn number(value: f64) -> TolerantJsonValue {
    if value.is_finite() {
        TolerantJsonValue::Number(node_number(value))
    } else {
        TolerantJsonValue::Null
    }
}

fn node_json_value(value: TolerantJsonValue) -> TolerantJsonValue {
    match value {
        TolerantJsonValue::Number(value) => {
            value.parse::<f64>().map_or(TolerantJsonValue::Null, number)
        }
        TolerantJsonValue::Array(values) => {
            TolerantJsonValue::Array(values.into_iter().map(node_json_value).collect())
        }
        TolerantJsonValue::Object(values) => {
            let mut fields = Vec::new();
            for (name, value) in values {
                if let Some((_, previous)) = fields.iter_mut().find(|(key, _)| *key == name) {
                    *previous = node_json_value(value);
                } else {
                    fields.push((name, node_json_value(value)));
                }
            }
            // ECMAScript enumerates array-index keys before other keys, even if inserted later.
            fields.sort_by_key(|(name, _)| array_index(name).map_or((1, 0), |index| (0, index)));
            TolerantJsonValue::Object(fields)
        }
        other => other,
    }
}

fn array_index(name: &JsString) -> Option<u32> {
    let text = name.to_utf8_lossy();
    let index = text
        .parse::<u32>()
        .ok()
        .filter(|value| *value != u32::MAX)?;
    (index.to_string() == text).then_some(index)
}

fn node_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let raw = value.abs().to_string();
    let (mantissa, power) = raw
        .split_once(['e', 'E'])
        .map_or((raw.as_str(), 0), |(mantissa, exponent)| {
            (mantissa, exponent.parse::<i32>().unwrap_or(0))
        });
    let decimal = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let leading = digits.bytes().take_while(|byte| *byte == b'0').count();
    let digits = digits[leading..].trim_end_matches('0');
    let position = decimal - leading as i32 + power;
    if position > 0 && position <= 21 {
        if digits.len() as i32 <= position {
            format!(
                "{sign}{digits}{}",
                "0".repeat(position as usize - digits.len())
            )
        } else {
            format!(
                "{sign}{}.{}",
                &digits[..position as usize],
                &digits[position as usize..]
            )
        }
    } else if position > -6 && position <= 0 {
        format!("{sign}0.{}{digits}", "0".repeat((-position) as usize))
    } else {
        let exponent = position - 1;
        let fraction = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        format!(
            "{sign}{}{fraction}e{}{exponent}",
            &digits[..1],
            if exponent >= 0 { "+" } else { "" }
        )
    }
}
fn set(fields: &mut Vec<(JsString, TolerantJsonValue)>, name: &str, value: TolerantJsonValue) {
    let key = JsString::from(name);
    if let Some((_, old)) = fields.iter_mut().rev().find(|(name, _)| *name == key) {
        *old = value;
    } else {
        fields.push((key, value));
    }
}

fn entry_attempts(entry: &TolerantJsonValue) -> f64 {
    let value = if let TolerantJsonValue::Object(fields) = entry {
        fields
            .iter()
            .rev()
            .find(|(name, _)| *name == JsString::from("attempts"))
            .map(|(_, value)| value)
    } else {
        None
    };
    let parsed = match value {
        Some(TolerantJsonValue::Number(value)) => value.parse().ok(),
        Some(TolerantJsonValue::String(value)) => value.to_utf8_lossy().trim().parse().ok(),
        Some(TolerantJsonValue::Bool(value)) => Some(if *value { 1.0 } else { 0.0 }),
        _ => None,
    };
    parsed
        .filter(|value: &f64| !value.is_nan() && *value != 0.0)
        .unwrap_or(0.0)
}

fn spread_object(value: TolerantJsonValue) -> TolerantJsonValue {
    match value {
        TolerantJsonValue::Object(_) => value,
        TolerantJsonValue::Array(values) => TolerantJsonValue::Object(
            values
                .into_iter()
                .enumerate()
                .map(|(index, value)| (JsString::from(index.to_string().as_str()), value))
                .collect(),
        ),
        TolerantJsonValue::String(value) => TolerantJsonValue::Object(
            value
                .as_utf16_units()
                .iter()
                .enumerate()
                .map(|(index, unit)| {
                    (
                        JsString::from(index.to_string().as_str()),
                        TolerantJsonValue::String(JsString::from_utf16_units(vec![*unit])),
                    )
                })
                .collect(),
        ),
        _ => TolerantJsonValue::Object(Vec::new()),
    }
}

fn held_locks() -> &'static Mutex<HashSet<PathBuf>> {
    static HELD: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(HashSet::new()))
}

struct DrainLock {
    path: PathBuf,
    _guard: LockGuard,
}
impl DrainLock {
    fn acquire(path: &Path) -> Option<Self> {
        let mut held = held_locks().lock().unwrap_or_else(PoisonError::into_inner);
        if held.contains(path) {
            return None;
        }
        let stale = Duration::from_secs(15 * 60);
        let guard =
            Lock::try_acquire(path, stale, Some(stale * JOB_LOCK_HARD_CEILING_FACTOR)).ok()??;
        held.insert(path.to_owned());
        Some(Self {
            path: path.to_owned(),
            _guard: guard,
        })
    }
}
impl Drop for DrainLock {
    fn drop(&mut self) {
        held_locks()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.path);
    }
}
