//! Native maintenance state, not a grant, writer-generation switch or cross-process lock.
use crate::contract::{Cancel, EngineError, StoreError};
use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};

/// Informational state. Callers must independently enforce authorization and drain/switch rules.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    /// Whether local or durable maintenance is active.
    pub active: bool,
    /// Validated bounded machine reason when active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Finite host timestamp when active.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_since"
    )]
    pub since: Option<f64>,
}
impl Status {
    fn inactive() -> Self {
        Self {
            active: false,
            reason: None,
            since: None,
        }
    }
}
struct Lease {
    reason: String,
    migration: String,
    since: f64,
}
impl Lease {
    fn status(&self) -> Status {
        Status {
            active: true,
            reason: Some(self.reason.clone()),
            since: Some(self.since),
        }
    }
}
type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
type External = Arc<dyn Fn(&Cancel) -> Result<Status, EngineError> + Send + Sync>;
/// Paired local enter/exit plus an optional authoritative durable-status reader.
/// Presence of a matching migration label is not authentication or permission to switch storage.
pub struct Gate {
    clock: Clock,
    external: Option<External>,
    local: Mutex<Option<Lease>>,
}
impl Gate {
    /// Create inactive in-memory state using the host's millisecond clock; performs no I/O.
    pub fn new(clock: Clock) -> Self {
        Self {
            clock,
            external: None,
            local: Mutex::new(None),
        }
    }
    /// Install a host-owned reader. Errors propagate; an unreadable durable gate never means open.
    #[must_use]
    pub fn with_external(mut self, external: External) -> Self {
        self.external = Some(external);
        self
    }
    /// Enter once with validated bounded labels. Existing local ownership is never replaced.
    pub fn enter(&self, reason: &str, migration: &str, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        validate(reason, migration)?;
        let mut local = self.lock(cancel)?;
        cancel.check()?;
        if local.is_some() {
            return Err(error("PLUR1BUS maintenance gate is already active"));
        }
        let since = (self.clock)();
        if !since.is_finite() {
            return Err(error("invalid maintenance gate timestamp"));
        }
        cancel.check()?;
        *local = Some(Lease {
            reason: reason.into(),
            migration: migration.into(),
            since,
        });
        Ok(())
    }
    /// Exit only the exact local reason/migration pair; does not clear durable external state.
    pub fn exit(&self, reason: &str, migration: &str, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        validate(reason, migration)?;
        let mut local = self.lock(cancel)?;
        cancel.check()?;
        let lease = local
            .as_ref()
            .ok_or_else(|| error("PLUR1BUS maintenance gate is not active"))?;
        if lease.reason != reason || lease.migration != migration {
            return Err(error("PLUR1BUS maintenance gate lease mismatch"));
        }
        *local = None;
        Ok(())
    }
    /// Local state takes precedence; otherwise validate the durable reader's active response.
    /// A local enter while the reader is pending is observed before publishing its response.
    pub fn status(&self, cancel: &Cancel) -> Result<Status, EngineError> {
        cancel.check()?;
        if let Some(lease) = self.lock(cancel)?.as_ref() {
            return Ok(lease.status());
        }
        let external = self
            .external
            .as_ref()
            .map_or_else(|| Ok(Status::inactive()), |read| read(cancel));
        cancel.check()?;
        let local = self.lock(cancel)?;
        if let Some(lease) = local.as_ref() {
            return Ok(lease.status());
        }
        let status = external?;
        if !status.active {
            return Ok(Status::inactive());
        }
        if !status.reason.as_deref().is_some_and(valid_reason) {
            return Err(error("invalid durable maintenance gate reason"));
        }
        if !status.since.is_some_and(f64::is_finite) {
            return Err(error("invalid durable maintenance gate timestamp"));
        }
        Ok(status)
    }
    fn lock(&self, cancel: &Cancel) -> Result<MutexGuard<'_, Option<Lease>>, EngineError> {
        loop {
            cancel.check()?;
            match self.local.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => return Err(StoreError::Corrupt.into()),
                Err(TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(5))
                }
            }
        }
    }
}
fn valid_reason(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
fn validate(reason: &str, migration: &str) -> Result<(), EngineError> {
    if !valid_reason(reason) {
        return Err(error("invalid maintenance gate reason"));
    }
    if !(1..=64).contains(&migration.len())
        || !migration.as_bytes()[0].is_ascii_alphanumeric()
        || !migration
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(error("invalid maintenance gate migration id"));
    }
    Ok(())
}
fn error(reason: &str) -> EngineError {
    EngineError::NotAvailable {
        reason: reason.into(),
    }
}

fn serialize_since<S: serde::Serializer>(
    since: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match since {
        None => serializer.serialize_none(),
        Some(value) if value.is_finite() => {
            let mut buffer = ryu_js::Buffer::new();
            let number: serde_json::Number = buffer
                .format_finite(*value)
                .parse()
                .map_err(serde::ser::Error::custom)?;
            number.serialize(serializer)
        }
        Some(_) => Err(serde::ser::Error::custom(
            "non-finite maintenance timestamp",
        )),
    }
}
