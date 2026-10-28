//! The pinned Node engine's in-memory last-checkpoint map (RE-02).

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{contract::StoreError, text::js::JsString};

/// The reasons accepted by Node's checkpoint store.
pub const CHECKPOINT_REASONS: [&str; 4] = ["compaction", "session-end", "shutdown", "manual"];

/// The exact public result returned by Node's checkpoint method.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResult {
    /// Agent whose transcript boundary was marked.
    pub agent_id: String,
    /// The accepted boundary reason.
    pub reason: String,
    /// First 32 hexadecimal characters of SHA-256 over the Node JSON material.
    pub digest: String,
    /// False when the same agent/reason digest already exists.
    pub written: bool,
}

struct LastCheckpoint {
    at: f64,
    digest: String,
}

/// A process-local checkpoint map with an injected Unix-millisecond clock.
/// There is no persisted checkpoint file and no consume/clear operation in the Node pin.
pub struct CheckpointStore {
    clock: Box<dyn Fn() -> f64 + Send + Sync>,
    last: Mutex<HashMap<(String, String), LastCheckpoint>>,
}

impl Default for CheckpointStore {
    fn default() -> Self {
        Self::new(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |time| time.as_millis() as f64)
        })
    }
}

impl CheckpointStore {
    /// Create an empty engine-lifetime store, using the supplied clock when `at` is absent/nonfinite.
    pub fn new(clock: impl Fn() -> f64 + Send + Sync + 'static) -> Self {
        Self {
            clock: Box::new(clock),
            last: Mutex::new(HashMap::new()),
        }
    }

    /// Mark one boundary, deduplicating the exact Node `[agent,reason,sessionKey,at]` digest.
    pub fn checkpoint(
        &self,
        agent_id: &str,
        reason: &str,
        at: Option<f64>,
        session_key: &str,
    ) -> Result<CheckpointResult, StoreError> {
        if !CHECKPOINT_REASONS.contains(&reason) {
            return Err(StoreError::InvalidInput);
        }
        let when = at
            .filter(|value| value.is_finite())
            .unwrap_or_else(|| (self.clock)());
        let material = format!(
            "[{},{},{},{}]",
            JsString::from_utf8_str(agent_id).to_json(),
            JsString::from_utf8_str(reason).to_json(),
            JsString::from_utf8_str(session_key).to_json(),
            js_number(when)
        );
        let digest = format!("{:x}", Sha256::digest(material.as_bytes()))[..32].to_owned();
        let key = (agent_id.to_owned(), reason.to_owned());
        let mut last = self.last.lock().map_err(|_| StoreError::Corrupt)?;
        let written = last
            .get(&key)
            .is_none_or(|previous| previous.digest != digest);
        if written {
            last.insert(
                key,
                LastCheckpoint {
                    at: when,
                    digest: digest.clone(),
                },
            );
        }
        Ok(CheckpointResult {
            agent_id: agent_id.to_owned(),
            reason: reason.to_owned(),
            digest,
            written,
        })
    }

    /// The latest timestamp for this exact agent/reason pair, without consuming it.
    pub fn last_at(&self, agent_id: &str, reason: &str) -> Result<Option<f64>, StoreError> {
        Ok(self
            .last
            .lock()
            .map_err(|_| StoreError::Corrupt)?
            .get(&(agent_id.to_owned(), reason.to_owned()))
            .map(|value| value.at))
    }
}

/// Resolve Node's truthy event override, then hook override, then the stored compaction boundary.
pub fn resolve_compacted_at(
    event: Option<f64>,
    hook_context: Option<f64>,
    store: Option<&CheckpointStore>,
    agent_id: &str,
) -> Result<Option<f64>, StoreError> {
    let explicit = event
        .filter(|value| *value != 0.0 && !value.is_nan())
        .or_else(|| hook_context.filter(|value| *value != 0.0 && !value.is_nan()));
    if explicit.is_some() {
        return Ok(explicit);
    }
    store.map_or(Ok(None), |store| store.last_at(agent_id, "compaction"))
}

// ECMAScript uses fixed notation for [1e-6, 1e21), exponential elsewhere, and
// serializes nonfinite values as null. Rust's shortest decimal digits are retained.
fn js_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let raw = value.abs().to_string();
    let decimal = raw.find('.').unwrap_or(raw.len());
    let digits = raw.replace('.', "");
    let first = digits.find(|character| character != '0').unwrap_or(0);
    let exponent = decimal as i32 - first as i32 - 1;
    let digits = digits[first..].trim_end_matches('0');
    let sign = if value < 0.0 { "-" } else { "" };
    if !(-6..21).contains(&exponent) {
        let fraction = if digits.len() > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        return format!(
            "{sign}{}{fraction}e{}{exponent}",
            &digits[..1],
            if exponent >= 0 { "+" } else { "" }
        );
    }
    let point = exponent + 1;
    if point <= 0 {
        return format!("{sign}0.{}{digits}", "0".repeat((-point) as usize));
    }
    let point = point as usize;
    if point >= digits.len() {
        return format!("{sign}{digits}{}", "0".repeat(point - digits.len()));
    }
    format!("{sign}{}.{}", &digits[..point], &digits[point..])
}
