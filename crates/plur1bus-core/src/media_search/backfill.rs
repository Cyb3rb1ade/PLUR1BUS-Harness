//! Explicit backfill controls and fingerprint bookkeeping.

use super::{
    admission::{local_operation, Operation, Policy},
    index::Counts,
    Caller, Error, Scope,
};
use serde::{Deserialize, Serialize};

/// Stable path for the atomically updated registry record.
pub const STATE_PATH: &str = "state/media-search.json";
/// Status event emitted on a meaningful change.
pub const EVENT: &str = "media.index.status";

/// Backfill phases.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// No run started.
    Idle,
    /// Currently running.
    Running,
    /// Stopped with a pause reason.
    Paused,
    /// Explicitly cancelled.
    Cancelled,
    /// Completed.
    Done,
}
/// Why a run stopped temporarily.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Pause {
    /// Quota exhausted.
    Budget,
    /// Explicit user request.
    User,
    /// Retryable port error.
    Error,
}
/// Scoped progress counters.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Current phase.
    pub state: Phase,
    /// Completed records.
    pub done: u64,
    /// Known records to process.
    pub total: u64,
    /// Optional start instant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// Pause reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_reason: Option<Pause>,
}
/// Restricted status projection for the scoped index.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Status {
    /// Index is enabled.
    pub enabled: bool,
    /// Admitted provider identifier.
    pub provider: String,
    /// Model.
    pub model: String,
    /// Optional model variant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// Embedding dimension.
    pub dim: usize,
    /// Encoder build fingerprint.
    pub fingerprint: String,
    /// Counts scoped to the current index.
    pub counts: Counts,
    /// Backfill progress.
    pub backfill: Progress,
}
/// Backfill settings authorized by the caller's current configuration.
#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    /// Media index enabled.
    pub enabled: bool,
    /// Effective provider, if configured.
    pub provider: Option<String>,
    /// Auto start policy.
    #[serde(rename = "backfill")]
    pub mode: Mode,
}
/// Auto-start policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Automatic.
    Auto,
    /// Manual.
    Manual,
}
/// Reason for a start.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Start {
    /// First enable.
    Enable,
    /// Encoder fingerprint changed.
    ModelChange,
    /// Explicit reindex.
    Manual,
}
/// One host-owned control effect.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    /// Start.
    Start(Start),
    /// Pause.
    Pause,
    /// Resume.
    Resume,
    /// Cancel.
    Cancel,
}
/// Outcome of composition planning.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Init {
    /// No start needed.
    Idle,
    /// Resumed prior work.
    Resumed,
    /// Started a run.
    Started,
}

/// Trusted port for a particular assigned media index. Start/resume are local-only.
pub trait Driver {
    /// Read the scoped status.
    fn status(&self, scope: &Scope) -> Result<Status, Error>;
    /// Apply an authorized, idempotent control.
    fn control(&self, scope: &Scope, action: Action) -> Result<(), Error>;
    /// Emit one scoped status event.
    fn emit(&self, scope: &Scope, event: &'static str, status: &Status) -> Result<(), Error>;
}
/// Locked private state file, with a byte-precise conditional replacement.
pub trait StateFile {
    /// Whether the file is confined and this scope's exclusive transition lease is current.
    fn trusted(&self, scope: &Scope) -> bool;
    /// Read the fixed state file with the supplied maximum size.
    fn read(&self, max_bytes: usize) -> Result<Option<Vec<u8>>, Error>;
    /// Compare and atomically replace the fixed file.
    fn compare_replace(&self, expected: Option<&[u8]>, after: &[u8]) -> Result<bool, Error>;
}
/// Backfill host ports.
pub struct Ports<'a> {
    /// Live effective local-only policy.
    pub policy: &'a dyn Policy,
    /// Scoped progress and commands.
    pub driver: &'a dyn Driver,
    /// Private state.
    pub file: &'a dyn StateFile,
}
/// Controller bound to a single scope. Timer ownership remains external.
pub struct Controller {
    scope: Scope,
    last_seen: Option<Seen>,
}

#[derive(Eq, PartialEq)]
struct Seen {
    phase: Phase,
    done: u64,
    total: u64,
    pause: Option<Pause>,
    counts: Counts,
    fingerprint: String,
    enabled: bool,
}
impl From<&Status> for Seen {
    fn from(status: &Status) -> Self {
        Self {
            phase: status.backfill.state,
            done: status.backfill.done,
            total: status.backfill.total,
            pause: status.backfill.paused_reason,
            counts: status.counts.clone(),
            fingerprint: status.fingerprint.clone(),
            enabled: status.enabled,
        }
    }
}

const STATE_LIMIT: usize = 4096;
const OPERATE: &str = "media.index.operate";
const READ: &str = "media.index.read";

impl Controller {
    /// Bind a controller to a fixed media scope.
    pub fn new(scope: Scope) -> Self {
        Self {
            scope,
            last_seen: None,
        }
    }

    /// Resume or start according to the current config and last durable fingerprint.
    pub fn init(
        &mut self,
        caller: &Caller<'_>,
        cfg: &Config,
        ports: &Ports<'_>,
    ) -> Result<Init, Error> {
        self.check(caller, OPERATE)?;
        if !cfg.enabled || cfg.provider.as_deref() == Some("off") {
            return Ok(Init::Idle);
        }
        let status = self.status(caller, ports)?;
        if !status.enabled {
            return Ok(Init::Idle);
        }
        let progress = &status.backfill;
        if progress.state == Phase::Running
            || progress.state == Phase::Paused
                && matches!(progress.paused_reason, Some(Pause::Budget | Pause::Error))
        {
            self.control(caller, Action::Resume, ports)?;
            return Ok(Init::Resumed);
        }
        if progress.state == Phase::Paused || cfg.mode != Mode::Auto {
            return Ok(Init::Idle);
        }
        let old = self.read_state(caller, ports)?;
        let stored = old
            .as_deref()
            .and_then(|bytes| serde_json::from_slice::<Recorded>(bytes).ok());
        let known = stored
            .as_ref()
            .and_then(|record| record.fingerprint.as_deref())
            .filter(|fp| valid_fingerprint(fp));
        if known == Some(status.fingerprint.as_str()) {
            return Ok(Init::Idle);
        }
        if known.is_none() && progress.state == Phase::Done {
            self.record(caller, ports, old.as_deref(), &status.fingerprint)?;
            return Ok(Init::Idle);
        }
        let reason = if known.is_some() {
            Start::ModelChange
        } else {
            Start::Enable
        };
        self.start(caller, ports, reason, old.as_deref(), &status.fingerprint)?;
        self.poll(caller, ports)?;
        Ok(Init::Started)
    }

    /// Read one status and emit if its relevant fields changed.
    pub fn poll(&mut self, caller: &Caller<'_>, ports: &Ports<'_>) -> Result<Status, Error> {
        let status = self.status(caller, ports)?;
        let seen = Seen::from(&status);
        if self.last_seen.as_ref() != Some(&seen) {
            self.check(caller, READ)?;
            ports.driver.emit(&self.scope, EVENT, &status)?;
            self.last_seen = Some(seen);
        }
        Ok(status)
    }

    /// Apply a pause/resume/cancel and report scoped status.
    pub fn control(
        &mut self,
        caller: &Caller<'_>,
        action: Action,
        ports: &Ports<'_>,
    ) -> Result<Status, Error> {
        self.check(caller, OPERATE)?;
        match action {
            Action::Resume => self.admitted(caller, ports, action)?,
            Action::Pause | Action::Cancel => ports.driver.control(&self.scope, action)?,
            Action::Start(_) => {
                return Err(Error::new("E_INVALID_PARAMS", "start-requires-fingerprint"))
            }
        }
        self.poll(caller, ports)
    }

    /// Explicit reindex with the status fingerprint.
    pub fn reindex(&mut self, caller: &Caller<'_>, ports: &Ports<'_>) -> Result<Status, Error> {
        self.check(caller, OPERATE)?;
        let old = self.read_state(caller, ports)?;
        let status = self.status(caller, ports)?;
        if !status.enabled {
            return Err(Error::new("E_MEDIA_UNAVAILABLE", "media-index-disabled"));
        }
        local_operation(caller, ports.policy, Operation::Backfill, |_| {
            self.check(caller, OPERATE)?;
            ports.driver.control(&self.scope, Action::Cancel)
        })?;
        self.start(
            caller,
            ports,
            Start::Manual,
            old.as_deref(),
            &status.fingerprint,
        )?;
        self.poll(caller, ports)
    }

    fn check(&self, caller: &Caller<'_>, action: &'static str) -> Result<(), Error> {
        if self.scope != *caller.scope {
            return Err(Error::new("E_DENIED", "backfill-scope-changed"));
        }
        caller.authorize(action)
    }
    fn status(&self, caller: &Caller<'_>, ports: &Ports<'_>) -> Result<Status, Error> {
        self.check(caller, READ)?;
        let status = ports.driver.status(&self.scope)?;
        self.check(caller, READ)?;
        if (status.enabled || !status.fingerprint.is_empty())
            && !valid_fingerprint(&status.fingerprint)
            || status.backfill.done > status.backfill.total
            || [
                Some(status.provider.as_str()),
                Some(status.model.as_str()),
                status.variant.as_deref(),
                status.backfill.started_at.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|s| s.len() > 256 || s.chars().any(char::is_control))
        {
            return Err(Error::new("E_MEDIA_UNAVAILABLE", "invalid-backfill-status"));
        }
        Ok(status)
    }
    fn check_file(&self, caller: &Caller<'_>, ports: &Ports<'_>) -> Result<(), Error> {
        self.check(caller, OPERATE)?;
        if !ports.file.trusted(&self.scope) {
            return Err(Error::new("E_DENIED", "backfill-state-outside-root"));
        }
        Ok(())
    }
    fn read_state(&self, caller: &Caller<'_>, ports: &Ports<'_>) -> Result<Option<Vec<u8>>, Error> {
        self.check_file(caller, ports)?;
        let bytes = ports.file.read(STATE_LIMIT)?;
        if bytes
            .as_ref()
            .is_some_and(|bytes| bytes.len() > STATE_LIMIT)
        {
            return Err(Error::new("E_MEDIA_UNAVAILABLE", "backfill-state-limit"));
        }
        Ok(bytes)
    }
    fn admitted(
        &self,
        caller: &Caller<'_>,
        ports: &Ports<'_>,
        action: Action,
    ) -> Result<(), Error> {
        local_operation(caller, ports.policy, Operation::Backfill, |_| {
            ports.driver.control(&self.scope, action)
        })
    }
    fn start(
        &self,
        caller: &Caller<'_>,
        ports: &Ports<'_>,
        reason: Start,
        previous: Option<&[u8]>,
        fingerprint: &str,
    ) -> Result<(), Error> {
        self.check_file(caller, ports)?;
        self.admitted(caller, ports, Action::Start(reason))?;
        self.record(caller, ports, previous, fingerprint)
    }
    fn record(
        &self,
        caller: &Caller<'_>,
        ports: &Ports<'_>,
        previous: Option<&[u8]>,
        fingerprint: &str,
    ) -> Result<(), Error> {
        self.check_file(caller, ports)?;
        let bytes = serde_json::to_vec(&Recorded {
            fingerprint: Some(fingerprint.into()),
        })
        .map_err(|_| Error::new("E_MEDIA_UNAVAILABLE", "backfill-state-format"))?;
        if !ports.file.compare_replace(previous, &bytes)? {
            return Err(Error::new("E_CONFLICT", "backfill-state-changed"));
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
struct Recorded {
    fingerprint: Option<String>,
}
fn valid_fingerprint(fp: &str) -> bool {
    !fp.is_empty() && fp.len() <= 256 && !fp.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "backfill_vectors.rs"]
mod vectors;
