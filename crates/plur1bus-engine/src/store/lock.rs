//! Node-compatible nonce-owned registry locks and their job-lock wrapper (RE-02/T6).
//!
//! The mtime is the acquisition time. There is deliberately no heartbeat: updating mtime
//! would change the pinned Node reader's stale-lock decision. Release and stale takeover
//! rename a lock aside, verify ownership, and restore a different owner's file.

use std::{
    collections::HashSet,
    ffi::OsString,
    fmt,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use chrono::{SecondsFormat, Utc};
use plur1bus_rpc::process::{self, Incarnation, Liveness};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    contract::StoreError,
    text::json::{parse_json, TolerantJsonValue},
};

use super::paths::{assert_trusted_path, secure_dir};

const HARD_CEILING_FACTOR: u32 = 10;
const INCARNATION_TOLERANCE_MS: f64 = 1_000.0;
const RELEASE_SETTLE: Duration = Duration::from_millis(250);
const SETTLE_POLL: Duration = Duration::from_millis(5);
#[cfg(windows)]
const DEFERRED_RELEASE_DELAYS_MS: [u64; 6] = [50, 100, 200, 400, 800, 1_500];

/// The opt-in foreign-host ceiling multiplier exported by Node's job-lock wrapper.
/// Node's default acquisition still uses the registry's 10× ceiling.
pub const JOB_LOCK_HARD_CEILING_FACTOR: u32 = 4;

fn io_error(error: io::Error) -> StoreError {
    StoreError::from(error)
}

fn suffix(path: &Path, tail: &str) -> PathBuf {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(tail);
    PathBuf::from(name)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileId(u64, u64);

#[cfg(unix)]
fn file_id(_file: &File, metadata: &Metadata) -> io::Result<FileId> {
    use std::os::unix::fs::MetadataExt;
    Ok(FileId(metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_id(file: &File, _metadata: &Metadata) -> io::Result<FileId> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    // SAFETY: the zeroed POD is a writable output buffer for the valid owned file handle.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: File owns the live handle and info has the API's required layout.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(FileId(
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

struct Snapshot {
    id: FileId,
    modified: SystemTime,
    bytes: Option<Vec<u8>>,
    text: Option<String>,
}

fn snapshot(path: &Path) -> io::Result<Snapshot> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let id = file_id(&file, &metadata)?;
    let modified = metadata.modified()?;
    let mut bytes = Vec::new();
    let bytes = file.read_to_end(&mut bytes).ok().map(|_| bytes);
    // Node's readFileSync(..., "utf8") replaces malformed bytes. Invalid UTF-8 must
    // therefore be reaped as corrupt JSON; a genuine I/O read failure stays busy.
    let text = bytes
        .as_deref()
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned());
    Ok(Snapshot {
        id,
        modified,
        bytes,
        text,
    })
}

fn property<'a>(value: &'a TolerantJsonValue, name: &str) -> Option<&'a TolerantJsonValue> {
    let TolerantJsonValue::Object(properties) = value else {
        return None;
    };
    // JSON.parse keeps the last value of a duplicate property.
    properties
        .iter()
        .rev()
        .find(|(key, _)| key.to_utf8_lossy() == name)
        .map(|(_, value)| value)
}

fn string(value: &TolerantJsonValue) -> Option<String> {
    let TolerantJsonValue::String(value) = value else {
        return None;
    };
    Some(value.to_utf8_lossy())
}

fn number(value: &TolerantJsonValue) -> Option<f64> {
    let TolerantJsonValue::Number(value) = value else {
        return None;
    };
    value.parse().ok()
}

struct Context {
    host: String,
    incarnation: Incarnation,
}

impl Context {
    fn own() -> Result<Self, StoreError> {
        Ok(Self {
            host: process::hostname().map_err(io_error)?,
            incarnation: process::incarnation().map_err(io_error)?,
        })
    }

    fn judged_stale(
        &self,
        text: &str,
        modified: SystemTime,
        stale: Duration,
        ceiling: Duration,
    ) -> bool {
        let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return false;
        };
        let Ok(mtime) = modified.duration_since(UNIX_EPOCH) else {
            return true;
        };
        let age_ms = now.as_millis() as f64 - mtime.as_secs_f64() * 1000.0;
        if age_ms <= stale.as_secs_f64() * 1000.0 {
            return false;
        }
        let Some(info) = parse_json(text).ok() else {
            return true;
        };
        let Some(pid) = property(&info, "pid")
            .and_then(number)
            .filter(|pid| pid.is_finite() && pid.fract() == 0.0 && *pid > 0.0)
        else {
            return true;
        };
        if age_ms > stale.as_secs_f64() * 1000.0 * f64::from(HARD_CEILING_FACTOR) {
            return true;
        }
        if property(&info, "host")
            .and_then(string)
            .is_some_and(|host| host != self.host)
        {
            return age_ms > ceiling.as_secs_f64() * 1000.0;
        }
        if pid == f64::from(std::process::id()) {
            let Some(start) = property(&info, "procStart") else {
                return false;
            };
            let Some(mono) = property(start, "mono")
                .and_then(number)
                .filter(|value| value.is_finite())
            else {
                return false;
            };
            let boot = property(start, "boot").and_then(string);
            if boot
                .as_ref()
                .zip(self.incarnation.boot.as_ref())
                .is_some_and(|(found, own)| found != own)
            {
                return true;
            }
            return (mono - self.incarnation.mono as f64).abs() > INCARNATION_TOLERANCE_MS;
        }
        // Node treats out-of-range process.kill arguments as alive (a non-ESRCH error).
        if pid > f64::from(i32::MAX) {
            return false;
        }
        // A private home cannot be held by a different user's process (f.4).
        process::alive(pid as u32) != Liveness::Alive
    }
}

fn holds(text: &str, nonce: &str) -> bool {
    parse_json(text)
        .ok()
        .and_then(|row| property(&row, "nonce").and_then(string))
        .as_deref()
        == Some(nonce)
}

fn unlink_moved(path: &Path) {
    let _ = fs::remove_file(path);
}

fn put_back(moved: &Path, lock: &Path) {
    if let Err(error) = fs::hard_link(moved, lock) {
        if error.kind() != io::ErrorKind::AlreadyExists
            && fs::metadata(lock).is_err()
            && fs::rename(moved, lock).is_ok()
        {
            return;
        }
    }
    unlink_moved(moved);
}

fn moved_files(path: &Path) -> Vec<PathBuf> {
    let Some(parent) = path.parent() else {
        return Vec::new();
    };
    let Some(base) = path.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_name().to_str().is_some_and(|name| {
                name.starts_with(&format!("{base}.rel-"))
                    || name.starts_with(&format!("{base}.break-"))
            })
        })
        .map(|entry| entry.path())
        .collect()
}

fn sweep_leftovers(path: &Path, stale: Duration, ceiling: Duration, context: &Context) {
    for moved in moved_files(path) {
        if snapshot(&moved).is_ok_and(|row| {
            context.judged_stale(
                row.text.as_deref().unwrap_or(""),
                row.modified,
                stale,
                ceiling,
            )
        }) {
            unlink_moved(&moved);
        }
    }
}

fn break_stale(path: &Path, judged: &Snapshot) -> bool {
    let moved = suffix(path, &format!(".break-{}", Uuid::new_v4()));
    if fs::rename(path, &moved).is_err() {
        return false;
    }
    let Ok(current) = snapshot(&moved) else {
        return false;
    };
    if current.id == judged.id && current.bytes == judged.bytes {
        unlink_moved(&moved);
        return true;
    }
    put_back(&moved, path);
    false
}

fn reap_if_stale(path: &Path, stale: Duration, ceiling: Duration, context: &Context) -> bool {
    let judged = match snapshot(path) {
        Ok(judged) => judged,
        Err(error) => return error.kind() == io::ErrorKind::NotFound,
    };
    let Some(text) = judged.text.as_deref() else {
        return fs::metadata(path).is_err();
    };
    let broken =
        context.judged_stale(text, judged.modified, stale, ceiling) && break_stale(path, &judged);
    sweep_leftovers(path, stale, ceiling, context);
    broken
}

#[derive(Clone)]
enum Ownership {
    Nonce(String),
    File(FileId),
}

impl Ownership {
    fn matches(&self, row: &Snapshot) -> bool {
        match self {
            Self::Nonce(nonce) => row.text.as_deref().is_some_and(|text| holds(text, nonce)),
            Self::File(id) => row.id == *id,
        }
    }
}

fn moved_aside_ours(path: &Path, ownership: &Ownership) -> bool {
    moved_files(path)
        .iter()
        .any(|path| snapshot(path).is_ok_and(|row| ownership.matches(&row)))
}

#[cfg(windows)]
fn transient(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(32 | 33 | 170 | 303))
}

#[cfg(not(windows))]
fn transient(_error: &io::Error) -> bool {
    false
}

/// False means Windows sharing stayed busy through the bounded settle interval.
fn release_lock(path: &Path, tag: &str, ownership: &Ownership, settle: Duration) -> bool {
    let moved = suffix(path, &format!(".rel-{tag}"));
    let deadline = Instant::now() + settle;
    loop {
        match fs::rename(path, &moved) {
            Ok(()) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !moved_aside_ours(path, ownership) || Instant::now() >= deadline {
                    return true;
                }
            }
            Err(error) if transient(&error) => {
                if Instant::now() >= deadline {
                    return false;
                }
            }
            Err(_) => return true,
        }
        if !settle.is_zero() {
            std::thread::sleep(SETTLE_POLL);
        }
    }
    match snapshot(&moved) {
        Ok(row) if ownership.matches(&row) => unlink_moved(&moved),
        Ok(row) if row.text.is_some() => put_back(&moved, path),
        _ => unlink_moved(&moved),
    }
    true
}

fn release_with_retry(path: &Path, nonce: &str, ownership: &Ownership) {
    let released = release_lock(path, nonce, ownership, RELEASE_SETTLE);
    #[cfg(not(windows))]
    let _ = released;
    #[cfg(windows)]
    if !released {
        let path = path.to_owned();
        let nonce = nonce.to_owned();
        let ownership = ownership.clone();
        // Detached threads, like Node's unref'd retries, do not keep the process alive.
        let _ = std::thread::Builder::new()
            .name("store-lock-release".into())
            .spawn(move || {
                for (attempt, delay) in DEFERRED_RELEASE_DELAYS_MS.iter().enumerate() {
                    std::thread::sleep(Duration::from_millis(*delay));
                    if release_lock(
                        &path,
                        &format!("{nonce}-d{attempt}"),
                        &ownership,
                        Duration::ZERO,
                    ) {
                        break;
                    }
                }
            });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stamp<'a> {
    nonce: &'a str,
    pid: u32,
    host: &'a str,
    proc_start: &'a Incarnation,
    acquired_at: String,
}

fn stamp(mut file: File, path: &Path, context: &Context) -> Result<String, StoreError> {
    let nonce = Uuid::new_v4().to_string();
    let row = Stamp {
        nonce: &nonce,
        pid: std::process::id(),
        host: &context.host,
        proc_start: &context.incarnation,
        acquired_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let bytes = serde_json::to_vec(&row).map_err(|_| StoreError::Corrupt)?;
    if let Err(error) = file.write_all(&bytes) {
        let id = file
            .metadata()
            .ok()
            .and_then(|metadata| file_id(&file, &metadata).ok());
        drop(file);
        if let Some(id) = id {
            release_with_retry(path, &format!("{nonce}-w"), &Ownership::File(id));
        }
        return Err(io_error(error));
    }
    drop(file); // Node closes after stamping too: an open Windows handle can block rename.
    Ok(nonce)
}

/// The one registry lock protocol behind job, import, neo and ledger writers.
pub struct Lock;

impl Lock {
    /// Try once; reap and retry once when stale. A foreign-host ceiling is clamped to 1×–10×.
    /// The directory must already exist, as for Node's `tryAcquireOwnedLock`.
    pub fn try_acquire(
        path: &Path,
        stale_after: Duration,
        hard_ceiling: Option<Duration>,
    ) -> Result<Option<LockGuard>, StoreError> {
        assert_trusted_path(path)?;
        let context = Context::own()?;
        let max = stale_after.saturating_mul(HARD_CEILING_FACTOR);
        let ceiling = hard_ceiling
            .filter(|ceiling| !ceiling.is_zero())
            .unwrap_or(max)
            .clamp(stale_after, max);
        let mut reaped = false;
        let mut transients = 0;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(file) => {
                    let nonce = stamp(file, path, &context)?;
                    return Ok(Some(LockGuard {
                        path: path.to_owned(),
                        nonce,
                        released: false,
                        job_path: None,
                        neo: None,
                    }));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if !reaped && reap_if_stale(path, stale_after, ceiling, &context) {
                        reaped = true;
                        continue;
                    }
                    return Ok(None);
                }
                Err(error) if transient(&error) => {
                    if transients < 2 {
                        transients += 1;
                        std::thread::sleep(Duration::from_millis(25));
                        continue;
                    }
                    return Ok(None);
                }
                Err(error) => return Err(io_error(error)),
            }
        }
    }

    /// Acquire the Node neo directory-lock protocol through the same public lock type.
    pub fn try_acquire_neo(
        path: &Path,
        stale_after: Duration,
    ) -> Result<Option<LockGuard>, StoreError> {
        Ok(
            super::neo_lock::try_acquire(path, stale_after)?.map(|neo| LockGuard {
                path: path.to_owned(),
                nonce: String::new(),
                released: false,
                job_path: None,
                neo: Some(neo),
            }),
        )
    }
}

/// An owned nonce lock. Drop releases only a file that still belongs to this guard.
pub struct LockGuard {
    path: PathBuf,
    nonce: String,
    released: bool,
    job_path: Option<PathBuf>,
    neo: Option<super::neo_lock::NeoGuard>,
}

impl LockGuard {
    /// The lock path, for its owner to inspect or pass to a cooperating process.
    pub fn path(&self) -> &Path {
        self.neo.as_ref().map_or(&self.path, |neo| neo.path())
    }

    /// Release idempotently; failures never replace an error from the protected operation.
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        if let Some(neo) = self.neo.as_mut() {
            neo.release();
            return;
        }
        if let Some(path) = self.job_path.take() {
            if let Ok(mut held) = held_jobs().lock() {
                held.remove(&path);
            }
        }
        release_with_retry(
            &self.path,
            &self.nonce,
            &Ownership::Nonce(self.nonce.clone()),
        );
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// Failure to enter a job's try-once critical section.
#[derive(Debug)]
pub enum LockBusy {
    /// A live, fresh or same-process job holder owns the lock.
    Held,
    /// A filesystem or validation failure prevented acquisition.
    Store(StoreError),
}

impl fmt::Display for LockBusy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Held => formatter.write_str("job lock is held"),
            Self::Store(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for LockBusy {}

fn held_jobs() -> &'static Mutex<HashSet<PathBuf>> {
    static HELD: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Node's job wrapper, including the same-process guard beyond the hard ceiling.
pub struct JobLock;

impl JobLock {
    /// Acquire `<dir>/<name>.lock`, creating a trusted private directory when necessary.
    pub fn acquire(dir: &Path, name: &str, stale_after: Duration) -> Result<LockGuard, LockBusy> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
            return Err(LockBusy::Store(StoreError::InvalidInput));
        }
        secure_dir(dir).map_err(LockBusy::Store)?;
        let path = fs::canonicalize(dir)
            .map_err(|error| LockBusy::Store(io_error(error)))?
            .join(format!("{name}.lock"));
        let mut held = held_jobs()
            .lock()
            .map_err(|_| LockBusy::Store(StoreError::Corrupt))?;
        if held.contains(&path) {
            return Err(LockBusy::Held);
        }
        let mut guard = Lock::try_acquire(&path, stale_after, None)
            .map_err(LockBusy::Store)?
            .ok_or(LockBusy::Held)?;
        held.insert(path.clone());
        guard.job_path = Some(path);
        Ok(guard)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn stale_takeover_restores_different_invalid_bytes_with_the_same_lossy_text() {
        let root = fs::canonicalize(std::env::temp_dir()).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let path = directory.path().join("changed.lock");
        fs::write(&path, [0xff]).unwrap();
        let judged = snapshot(&path).unwrap();
        fs::write(&path, [0xfe]).unwrap();
        assert!(!break_stale(&path, &judged));
        assert_eq!(fs::read(&path).unwrap(), [0xfe]);
    }
}
