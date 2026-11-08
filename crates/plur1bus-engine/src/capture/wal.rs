//! Durable counterpart to the preserved Node-compatible replay adapter (RE-D49).
//! A ticket authorizes only its exact agent/turn; every row plan must be acknowledged
//! before row writes. Pending plans survive TTL and capacity pruning until settled.
use super::replay_guard::{
    encode_component, encode_entries, Entry, REPLAY_GUARD_MAX_ENTRIES, REPLAY_GUARD_TTL_MS,
};
use crate::{
    contract::{Cancel, EngineError, StoreError},
    store::{
        atomic_write::atomic_write,
        directory::TrustedDirectory,
        paths::{assert_trusted_path, secure_dir},
    },
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[path = "wal_lock.rs"]
mod kernel_lock;
use kernel_lock::{acquire as lease, KernelLease};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ROWS: usize = 10_000;

/// Durable capture state rooted at the host-owned `_capture-turns` directory.
#[derive(Clone)]
pub struct CaptureWal {
    root: PathBuf,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
/// An already completed turn or a live exclusive turn ticket.
pub enum Admission {
    /// No row work may run again for this fresh completed key.
    Completed,
    /// Incomplete/new work; retain the ticket through actual worker settlement.
    Pending(Box<CaptureTicket>),
}
struct Progress {
    rows: Vec<String>,
    settled: bool,
    failed: bool,
}
/// A live lease and durable row-plan boundary; deliberately not Clone or serializable.
pub struct CaptureTicket {
    wal: CaptureWal,
    locks: TrustedDirectory,
    directory: Mutex<Option<TrustedDirectory>>,
    agent: String,
    key: String,
    stale: Vec<String>,
    flight: KernelLease,
    progress: Mutex<Progress>,
}

impl CaptureWal {
    /// Validate the configured root without creating state (incognito remains write-free).
    pub fn new(
        root: PathBuf,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, StoreError> {
        assert_trusted_path(&root)?;
        Ok(Self { root, clock })
    }

    /// Serialize identical turns across runtimes/processes. Different keys can prepare
    /// concurrently; only each short agent-state replacement takes an agent-wide lease.
    pub fn begin(&self, agent: &str, key: &str, cancel: &Cancel) -> Result<Admission, EngineError> {
        self.begin_with_wait(agent, key, cancel, || {})
    }

    pub(super) fn begin_with_wait(
        &self,
        agent: &str,
        key: &str,
        cancel: &Cancel,
        mut wait: impl FnMut(),
    ) -> Result<Admission, EngineError> {
        if agent.is_empty()
            || agent.len() > 128
            || key.is_empty()
            || key.len() > 1024
            || encode_component(agent).len() > 240
        {
            return Err(StoreError::InvalidInput.into());
        }
        cancel.check()?;
        let parent = self
            .root
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or(StoreError::InvalidInput)?;
        let name = self
            .root
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(StoreError::InvalidInput)?;
        secure_dir(parent)?;
        let parent = TrustedDirectory::open(parent)?;
        let lock_dir = format!(
            ".capture-leases-{:x}",
            Sha256::digest(name.to_ascii_lowercase().as_bytes())
        );
        let locks = parent.create_child(&lock_dir)?;
        let flight = lease(
            &locks,
            &lock_name("turn", agent, Some(key)),
            cancel,
            &mut wait,
        )?;
        let _writer = lease(&locks, &lock_name("agent", agent, None), cancel, &mut || {})?;
        let directory = match fs::symlink_metadata(&self.root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(StoreError::from(e).into()),
            Ok(_) => Some(TrustedDirectory::open(&self.root)?),
        };
        let entries = directory
            .as_ref()
            .map_or(Ok(Vec::new()), |d| read(d, agent))?;
        let now = now(&self.clock)?;
        let existing = entries
            .iter()
            .find(|entry| entry.key == JsString::from(key));
        if existing.is_some_and(|entry| entry.pending.is_none() && fresh(entry.at, now)) {
            return Ok(Admission::Completed);
        }
        let stale = existing
            .and_then(|entry| entry.pending.clone())
            .unwrap_or_default();
        Ok(Admission::Pending(Box::new(CaptureTicket {
            wal: self.clone(),
            locks,
            directory: Mutex::new(directory),
            agent: agent.to_owned(),
            key: key.to_owned(),
            progress: Mutex::new(Progress {
                rows: stale.clone(),
                settled: false,
                failed: false,
            }),
            stale,
            flight,
        })))
    }
}

impl CaptureTicket {
    /// Row IDs from a prior incomplete attempt; never expose another turn's IDs.
    #[must_use]
    pub fn pending_rows(&self) -> &[String] {
        &self.stale
    }

    /// Persist the complete union of old/new row IDs and fsync before granting row writes.
    /// Invalid IDs/capacity/I/O failures poison this ticket; callers must stop work.
    pub fn plan(&self, ids: &[String], cancel: &Cancel) -> Result<(), EngineError> {
        let mut progress = self.progress.lock().map_err(|_| StoreError::Corrupt)?;
        if progress.failed || progress.settled {
            return Err(StoreError::InvalidInput.into());
        }
        let result = (|| {
            let mut rows = progress.rows.clone();
            let mut known: HashSet<String> = rows.iter().cloned().collect();
            for id in ids {
                if !valid_row(id) {
                    return Err(StoreError::InvalidInput.into());
                }
                if known.insert(id.clone()) {
                    rows.push(id.clone());
                }
                if rows.len() > MAX_ROWS {
                    return Err(StoreError::InvalidInput.into());
                }
            }
            self.update(Some(Some(rows.clone())), cancel)?;
            Ok(rows)
        })();
        match result {
            Ok(rows) => {
                progress.rows = rows;
                Ok(())
            }
            Err(e) => {
                progress.failed = true;
                Err(e)
            }
        }
    }

    /// Acknowledge completed Lance writes durably before any post-store side effects.
    pub fn settle(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.finish(Some(None), cancel)
    }

    /// Retain partially written rows by removing their rollback plan. This is explicit;
    /// failure keeps the old plan and must abort all subsequent post-store side effects.
    pub fn keep_partial(&self, cancel: &Cancel) -> Result<(), EngineError> {
        self.finish(None, cancel)
    }

    fn finish(
        &self,
        change: Option<Option<Vec<String>>>,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let mut progress = self.progress.lock().map_err(|_| StoreError::Corrupt)?;
        if progress.failed {
            return Err(StoreError::Corrupt.into());
        }
        if progress.settled {
            return Ok(());
        }
        let settled = change.is_some();
        match self.update(change, cancel) {
            Ok(()) => {
                progress.settled = settled;
                if !settled {
                    progress.rows.clear();
                }
                Ok(())
            }
            Err(e) => {
                progress.failed = true;
                Err(e)
            }
        }
    }

    fn update(
        &self,
        change: Option<Option<Vec<String>>>,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        self.locks.assert_unchanged()?;
        self.flight.check(&self.locks)?;
        let writer = lease(
            &self.locks,
            &lock_name("agent", &self.agent, None),
            cancel,
            &mut || {},
        )?;
        let mut held = self.directory.lock().map_err(|_| StoreError::Corrupt)?;
        if held.is_none() {
            secure_dir(&self.wal.root)?;
            *held = Some(TrustedDirectory::open(&self.wal.root)?);
        }
        let directory = held.as_ref().ok_or(StoreError::Corrupt)?;
        let mut entries = read(directory, &self.agent)?;
        let now = now(&self.wal.clock)?;
        let key = JsString::from(self.key.as_str());
        entries
            .retain(|entry| entry.key != key && (entry.pending.is_some() || fresh(entry.at, now)));
        if let Some(pending) = change {
            while entries.len() >= REPLAY_GUARD_MAX_ENTRIES {
                let index = entries
                    .iter()
                    .position(|e| e.pending.is_none())
                    .ok_or(StoreError::InvalidInput)?;
                entries.remove(index);
            }
            entries.push(Entry {
                key,
                at: now,
                pending,
            });
        }
        let raw = encode_entries(&entries);
        if raw.len() as u64 > MAX_BYTES {
            return Err(StoreError::InvalidInput.into());
        }
        cancel.check()?;
        directory.assert_unchanged()?;
        writer.check(&self.locks)?;
        self.flight.check(&self.locks)?;
        let path = directory
            .path()
            .join(format!("{}.json", encode_component(&self.agent)));
        assert_trusted_path(&path)?;
        atomic_write(&path, raw.as_bytes()).map_err(StoreError::from)?;
        directory.assert_unchanged()?;
        Ok(())
    }
}

fn lock_name(kind: &str, agent: &str, key: Option<&str>) -> String {
    // URI filenames are ASCII. Case aliases share the writer lease even on a case-sensitive
    // host; the stored spelling, never this lock digest, determines the actual identity.
    let mut hash = Sha256::new();
    hash.update(encode_component(agent).to_ascii_lowercase());
    hash.update([0]);
    if let Some(key) = key {
        hash.update(key.as_bytes());
    }
    format!("{kind}-{:x}", hash.finalize())
}
#[allow(clippy::cast_precision_loss)] // Node timestamps are safe integral IEEE-754 values.
fn now(clock: &Arc<dyn Fn() -> i64 + Send + Sync>) -> Result<f64, StoreError> {
    let time = clock();
    if time.unsigned_abs() > 9_007_199_254_740_991 {
        return Err(StoreError::InvalidInput);
    }
    Ok(time as f64)
}
#[allow(clippy::cast_precision_loss)]
fn fresh(at: f64, now: f64) -> bool {
    now - at <= REPLAY_GUARD_TTL_MS as f64
}
fn valid_row(id: &str) -> bool {
    id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()
}

fn read(directory: &TrustedDirectory, agent: &str) -> Result<Vec<Entry>, StoreError> {
    directory.assert_unchanged()?;
    let name = format!("{}.json", encode_component(agent));
    let path = directory.path().join(&name);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= MAX_BYTES => {
        }
        Ok(_) => return Err(StoreError::Corrupt),
        Err(e) => return Err(e.into()),
    }
    let exact = fs::read_dir(directory.path())
        .map_err(StoreError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::from)?
        .iter()
        .any(|e| e.file_name() == std::ffi::OsStr::new(&name));
    if !exact {
        return Err(StoreError::UntrustedPath);
    }
    let mut raw = Vec::new();
    directory
        .open_file(&name)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(StoreError::from)?;
    directory.assert_unchanged()?;
    if raw.len() as u64 > MAX_BYTES {
        return Err(StoreError::Corrupt);
    }
    let value = parse_json(std::str::from_utf8(&raw).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    decode(&value)
}
fn unique_field<'a>(value: &'a Json, name: &str) -> Result<Option<&'a Json>, StoreError> {
    let Json::Object(fields) = value else {
        return Err(StoreError::Corrupt);
    };
    let key = JsString::from(name);
    let mut found = fields.iter().filter(|(n, _)| n == &key);
    let first = found.next().map(|(_, v)| v);
    if found.next().is_some() {
        return Err(StoreError::Corrupt);
    }
    Ok(first)
}
fn decode(value: &Json) -> Result<Vec<Entry>, StoreError> {
    if !matches!(unique_field(value, "v")?, Some(Json::Number(n)) if n.parse::<f64>().ok() == Some(1.0))
    {
        return Err(StoreError::Corrupt);
    }
    let Some(Json::Array(rows)) = unique_field(value, "entries")? else {
        return Err(StoreError::Corrupt);
    };
    if rows.len() > REPLAY_GUARD_MAX_ENTRIES {
        return Err(StoreError::Corrupt);
    }
    let mut keys = HashSet::new();
    let mut entries = Vec::new();
    for row in rows {
        let Some(Json::String(key)) = unique_field(row, "key")? else {
            return Err(StoreError::Corrupt);
        };
        if !keys.insert(key.clone()) {
            return Err(StoreError::Corrupt);
        }
        let Some(Json::Number(at)) = unique_field(row, "at")? else {
            return Err(StoreError::Corrupt);
        };
        let at = at
            .parse::<f64>()
            .ok()
            .filter(|t| t.is_finite() && t.abs() <= 9_007_199_254_740_991.0)
            .ok_or(StoreError::Corrupt)?;
        let pending = match unique_field(row, "pending")? {
            None => None,
            Some(Json::Array(ids)) if ids.len() <= MAX_ROWS => {
                let mut out = Vec::new();
                let mut seen = HashSet::new();
                for id in ids {
                    let Json::String(id) = id else {
                        return Err(StoreError::Corrupt);
                    };
                    let id = id.to_utf8_lossy();
                    if !valid_row(&id) || !seen.insert(id.clone()) {
                        return Err(StoreError::Corrupt);
                    }
                    out.push(id);
                }
                Some(out)
            }
            _ => return Err(StoreError::Corrupt),
        };
        entries.push(Entry {
            key: key.clone(),
            at,
            pending,
        });
    }
    Ok(entries)
}
