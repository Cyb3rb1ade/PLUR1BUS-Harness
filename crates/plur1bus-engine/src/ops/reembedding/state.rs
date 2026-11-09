//! Durable migration records with revision CAS and exclusive writer ownership.
//! This storage primitive confers no authority; the F7 coordinator owns admission and audit.
use super::state_json::*;
use crate::{
    contract::Cancel,
    ops::import_primitives::field,
    store::{
        atomic_write::atomic_write,
        directory::TrustedDirectory,
        lock::{JobLock, LockBusy},
        paths::assert_trusted_path,
    },
    text::{
        js::locale_compare,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use std::{
    fmt, fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
const FILE: &str = "reembedding-state.json";
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Bounded failures; formatting never includes a migration record, path or secret.
pub enum StateError {
    /// Invalid input, identified only by a static category.
    Invalid(&'static str),
    /// Persisted state is malformed or exceeds the bounded reader.
    InvalidState,
    /// A revision increment would exceed JavaScript's exact integer range.
    RevisionOverflow,
    /// The optimistic revision differs; callers may explicitly inspect this authorized record.
    Conflict {
        /// Current record; deliberately omitted from Debug and Display.
        current: Box<Json>,
    },
    /// A different migration still owns the coordinator.
    Active,
    /// Another writer owns the lease.
    Busy,
    /// A trusted path or storage operation failed.
    Storage,
    /// Caller cancellation won before the commit.
    Cancelled,
}
impl StateError {
    /// Stable machine category, without invalid input text.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::InvalidState => "reembedding_state_invalid",
            Self::RevisionOverflow => "reembedding_revision_overflow",
            Self::Conflict { .. } => "reembedding_revision_conflict",
            Self::Active => "reembedding_active_conflict",
            Self::Busy => "busy",
            Self::Storage => "storage",
            Self::Cancelled => "cancelled",
        }
    }
}
impl fmt::Debug for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for StateError {}
/// Host-owned migration store. Reads do not create directories or files.
pub struct MigrationStateStore {
    path: PathBuf,
    writer: Mutex<()>,
}
impl MigrationStateStore {
    /// Bind a trusted host state root without opening or creating a database.
    pub fn new(state_root: &Path) -> Result<Self, StateError> {
        let path = state_root.join("control").join(FILE);
        assert_trusted_path(&path).map_err(|_| StateError::Storage)?;
        Ok(Self {
            path,
            writer: Mutex::new(()),
        })
    }
    fn read(&self) -> Result<Json, StateError> {
        assert_trusted_path(&self.path).map_err(|_| StateError::Storage)?;
        match fs::symlink_metadata(&self.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(envelope(0, Json::Object(vec![])))
            }
            Ok(m) if m.is_file() && m.len() <= MAX_BYTES => {}
            _ => return Err(StateError::InvalidState),
        }
        let directory = TrustedDirectory::open(self.path.parent().ok_or(StateError::Storage)?)
            .map_err(|_| StateError::Storage)?;
        let file = directory.open_file(FILE).map_err(|_| StateError::Storage)?;
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| StateError::Storage)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(StateError::InvalidState);
        }
        directory
            .assert_unchanged()
            .map_err(|_| StateError::Storage)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| StateError::InvalidState)?;
        state(&parse_json(text).map_err(|_| StateError::InvalidState)?)
    }
    /// Return one validated record, or None. Historical IDs may contain up to 128 bytes.
    pub fn get(&self, id: &str) -> Result<Option<Json>, StateError> {
        if !id_valid(id) {
            return Err(StateError::Invalid("invalid migration id"));
        }
        let state = self.read()?;
        Ok(field(migrations(&state)?, id).cloned())
    }
    /// Check the persistent switch barrier without opening a store or claiming a lease.
    pub(crate) fn switching(&self) -> Result<bool, StateError> {
        let state = self.read()?;
        Ok(object(migrations(&state)?)?
            .iter()
            .any(|(_, record)| get_text(record, "state").as_deref() == Some("switching")))
    }
    /// Return records ordered by Node's pinned locale, first creation timestamp then ID.
    pub fn list(&self) -> Result<Vec<Json>, StateError> {
        let state = self.read()?;
        let mut rows = object(migrations(&state)?)?
            .iter()
            .map(|(_, v)| v.clone())
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| {
            locale_compare(
                &get_text(a, "createdAt").unwrap_or_default(),
                &get_text(b, "createdAt").unwrap_or_default(),
            )
            .then_with(|| {
                locale_compare(
                    &get_text(a, "id").unwrap_or_default(),
                    &get_text(b, "id").unwrap_or_default(),
                )
            })
        });
        Ok(rows)
    }
    fn mutate(
        &self,
        cancel: &Cancel,
        operation: impl FnOnce(Json) -> Result<(Json, Json), StateError>,
    ) -> Result<Json, StateError> {
        cancel.check().map_err(|_| StateError::Cancelled)?;
        let _writer = self.writer.lock().map_err(|_| StateError::Storage)?;
        cancel.check().map_err(|_| StateError::Cancelled)?;
        let parent = self.path.parent().ok_or(StateError::Storage)?;
        let lease = JobLock::acquire(parent, "reembedding-state", Duration::from_secs(30))
            .map_err(|e| match e {
                LockBusy::Held => StateError::Busy,
                LockBusy::Store(_) => StateError::Storage,
            })?;
        let directory = TrustedDirectory::open(parent).map_err(|_| StateError::Storage)?;
        let (next, result) = operation(self.read()?)?;
        let bytes = write_json(&normalize(&next, 0)?);
        if bytes.len() as u64 > MAX_BYTES {
            return Err(StateError::InvalidState);
        }
        cancel.check().map_err(|_| StateError::Cancelled)?;
        directory
            .assert_unchanged()
            .map_err(|_| StateError::Storage)?;
        assert_trusted_path(&self.path).map_err(|_| StateError::Storage)?;
        if !lease.is_owned() {
            return Err(StateError::Busy);
        }
        atomic_write(&self.path, bytes.as_bytes()).map_err(|_| StateError::Storage)?;
        Ok(result)
    }
    /// Create a planned migration. Expired pre-switch records retire in the same atomic commit.
    pub fn create(&self, input: &Json, now: f64, cancel: &Cancel) -> Result<Json, StateError> {
        let mut candidate = normalize(input, 0)?;
        object(&candidate)?;
        if get_text(&candidate, "state").as_deref() != Some("planned") {
            return Err(StateError::Invalid("new migration must start planned"));
        }
        let id = get_text(&candidate, "id")
            .filter(|s| id_valid(s))
            .ok_or(StateError::Invalid("invalid migration id"))?;
        let time = timestamp(now)?;
        put(&mut candidate, "revision", number(1))?;
        put(&mut candidate, "createdAt", string(&time))?;
        put(&mut candidate, "updatedAt", string(&time))?;
        record(&candidate, &id)?;
        self.mutate(cancel, |state| {
            let mut migrations = migrations(&state)?.clone();
            if field(&migrations, &id).is_some() {
                return Err(StateError::Invalid("migration id already exists"));
            }
            let mut retired = Vec::new();
            for (key, current) in object(&migrations)? {
                let status = get_text(current, "state").ok_or(StateError::InvalidState)?;
                if matches!(status.as_str(), "completed" | "failed" | "rolled_back") {
                    continue;
                }
                let expires = field(current, "confirmation")
                    .and_then(|c| field(c, "expiresAt"))
                    .and_then(integer);
                if !matches!(
                    status.as_str(),
                    "planned" | "confirmed" | "running" | "validating" | "ready_to_switch"
                ) || expires.is_none_or(|e| now < (e as f64))
                {
                    return Err(StateError::Active);
                }
                let mut next = current.clone();
                put(&mut next, "state", string("failed"))?;
                put(
                    &mut next,
                    "revision",
                    number(increment(revision(current)?)?),
                )?;
                put(&mut next, "updatedAt", string(&time))?;
                put(
                    &mut next,
                    "error",
                    Json::Object(vec![(
                        "code".into(),
                        string("expired_migration_superseded"),
                    )]),
                )?;
                retired.push((key.to_utf8_lossy(), next));
            }
            for (key, next) in retired {
                put(&mut migrations, &key, next)?;
            }
            put(&mut migrations, &id, candidate.clone())?;
            Ok((
                envelope(increment(revision(&state)?)?, migrations),
                candidate,
            ))
        })
    }
    /// Compare-and-set opaque progress without changing identity, digest or state.
    pub fn update(
        &self,
        id: &str,
        options: &Json,
        now: f64,
        cancel: &Cancel,
    ) -> Result<Json, StateError> {
        if !id_valid(id) {
            return Err(StateError::Invalid("invalid migration id"));
        }
        let expected = field(options, "expectedRevision")
            .and_then(integer)
            .filter(|r| *r > 0)
            .ok_or(StateError::Invalid("invalid expected migration revision"))?;
        let patch = patch(field(options, "patch").unwrap_or(&Json::Object(vec![])))?;
        self.mutate(cancel, |state| {
            let current = current(&state, id, Some(expected))?;
            if field(options, "expectedState").is_some_and(|v| Some(v) != field(current, "state")) {
                return Err(StateError::Invalid("unexpected migration state"));
            }
            replace(&state, current, id, &patch, None, now)
        })
    }
    /// Make exactly one legal graph transition with revision and source-state checks.
    pub fn transition(
        &self,
        id: &str,
        from: &str,
        to: &str,
        options: &Json,
        now: f64,
        cancel: &Cancel,
    ) -> Result<Json, StateError> {
        if !transition_valid(from, to) {
            return Err(StateError::Invalid("invalid migration transition"));
        }
        self.mutate(cancel, |state| {
            let current = current(
                &state,
                id,
                field(options, "expectedRevision").and_then(integer),
            )?;
            if get_text(current, "state").as_deref() != Some(from) {
                return Err(StateError::Invalid("unexpected migration state"));
            }
            let patch = patch(field(options, "patch").unwrap_or(&Json::Object(vec![])))?;
            replace(&state, current, id, &patch, Some(to), now)
        })
    }
}
fn timestamp(now: f64) -> Result<String, StateError> {
    crate::recall::render_date::iso_timestamp(now)
        .map_err(|_| StateError::Invalid("invalid migration clock"))
}
fn migrations(state: &Json) -> Result<&Json, StateError> {
    field(state, "migrations").ok_or(StateError::InvalidState)
}
fn current<'a>(state: &'a Json, id: &str, expected: Option<u64>) -> Result<&'a Json, StateError> {
    let current =
        field(migrations(state)?, id).ok_or(StateError::Invalid("migration not found"))?;
    if Some(revision(current)?) != expected {
        return Err(StateError::Conflict {
            current: Box::new(current.clone()),
        });
    }
    Ok(current)
}
fn replace(
    state: &Json,
    current: &Json,
    id: &str,
    patch: &Json,
    to: Option<&str>,
    now: f64,
) -> Result<(Json, Json), StateError> {
    let mut next = current.clone();
    for (key, value) in object(patch)? {
        put(&mut next, &key.to_utf8_lossy(), value.clone())?;
    }
    if let Some(to) = to {
        put(&mut next, "state", string(to))?;
    }
    put(
        &mut next,
        "revision",
        number(increment(revision(current)?)?),
    )?;
    put(&mut next, "updatedAt", string(&timestamp(now)?))?;
    record(&next, id)?;
    let mut migrations = migrations(state)?.clone();
    put(&mut migrations, id, next.clone())?;
    Ok((envelope(increment(revision(state)?)?, migrations), next))
}
#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
