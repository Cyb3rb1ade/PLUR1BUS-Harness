//! Private implementation of the pinned Neo directory-lock protocol.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{SecondsFormat, Utc};
use plur1bus_rpc::process::{self, Incarnation, Liveness};
use serde::Serialize;
use uuid::Uuid;

use crate::contract::StoreError;
use crate::text::json::{parse_json, TolerantJsonValue as Json};

use super::paths::{assert_trusted_path, secure_dir};

// Node executes these synchronous protocol mutations serially within one isolate.
// Serialize only the short acquisition/release steps across Rust callers as well.
fn protocol_mutex() -> &'static std::sync::Mutex<()> {
    static MUTATIONS: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    MUTATIONS.get_or_init(Default::default)
}

const ORPHAN_GRACE: Duration = Duration::from_secs(15);

fn io_error(error: io::Error) -> StoreError {
    StoreError::from(error)
}
fn suffix(path: &Path, tail: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(tail);
    PathBuf::from(name)
}
fn property<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    let Json::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|(key, _)| key.to_utf8_lossy() == name)
        .map(|(_, value)| value)
}
fn string(value: &Json) -> Option<String> {
    let Json::String(value) = value else {
        return None;
    };
    Some(value.to_utf8_lossy())
}
fn number(value: &Json) -> Option<f64> {
    let Json::Number(value) = value else {
        return None;
    };
    value.parse().ok()
}
fn number_coercion(value: &Json) -> Option<f64> {
    fn array_string(value: &Json) -> String {
        match value {
            Json::String(value) => value.to_utf8_lossy(),
            Json::Number(value) => value.clone(),
            Json::Bool(value) => value.to_string(),
            Json::Null => String::new(),
            Json::Array(values) => values
                .iter()
                .map(array_string)
                .collect::<Vec<_>>()
                .join(","),
            Json::Object(_) => "[object Object]".into(),
        }
    }
    match value {
        Json::Number(value) => value.parse().ok(),
        Json::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Json::Null => Some(0.0),
        Json::String(_) | Json::Array(_) => {
            let text = array_string(value);
            let text = crate::text::js::js_trim(&text);
            if text.is_empty() {
                return Some(0.0);
            }
            for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
                if let Some(digits) = text
                    .strip_prefix(prefix)
                    .or_else(|| text.strip_prefix(&prefix.to_uppercase()))
                {
                    if digits.is_empty() {
                        return None;
                    }
                    let mut number = 0.0;
                    for digit in digits.chars() {
                        number = number * f64::from(radix) + f64::from(digit.to_digit(radix)?);
                    }
                    return Some(number);
                }
            }
            text.parse().ok()
        }
        Json::Object(_) => None,
    }
}
fn owner(raw: Option<&[u8]>) -> Option<Json> {
    let mut value = parse_json(&String::from_utf8_lossy(raw?)).ok()?;
    let pid = property(&value, "pid").and_then(number_coercion)?;
    if !pid.is_finite() || pid.fract() != 0.0 || pid <= 0.0 {
        return None;
    }
    if let Json::Object(fields) = &mut value {
        let (_, value) = fields
            .iter_mut()
            .rev()
            .find(|(key, _)| key.to_utf8_lossy() == "pid")?;
        *value = Json::Number(pid.to_string());
    }
    Some(value)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct DirectoryId(u64, u64);

fn directory_file(path: &Path) -> io::Result<File> {
    #[allow(unused_mut)] // Windows needs an explicit directory-handle flag.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES,
        };
        options
            .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options.open(path)
}

#[cfg(unix)]
fn directory_id(_path: &Path, metadata: &Metadata) -> io::Result<DirectoryId> {
    use std::os::unix::fs::MetadataExt;
    Ok(DirectoryId(metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
fn directory_id(path: &Path, _metadata: &Metadata) -> io::Result<DirectoryId> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let file = directory_file(path)?;
    // SAFETY: POD output buffer populated through the live directory handle.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the owned handle and correctly sized writable buffer remain live for the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(DirectoryId(
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

struct Snapshot {
    id: DirectoryId,
    modified: SystemTime,
    accessed: Option<SystemTime>,
    raw: Option<Vec<u8>>,
}
fn snapshot(path: &Path) -> io::Result<Snapshot> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(Snapshot {
        id: directory_id(path, &metadata)?,
        modified: metadata.modified()?,
        accessed: metadata.accessed().ok(),
        raw: fs::read(path.join("owner.json")).ok(),
    })
}

struct Context {
    host: String,
    incarnation: Incarnation,
}
impl Context {
    fn new() -> Result<Self, StoreError> {
        Ok(Self {
            host: process::hostname().map_err(io_error)?,
            incarnation: process::incarnation().map_err(io_error)?,
        })
    }
    fn stale(&self, snapshot: &Snapshot, stale_after: Duration) -> bool {
        let age = SystemTime::now()
            .duration_since(snapshot.modified)
            .unwrap_or_default();
        let Some(owner) = owner(snapshot.raw.as_deref()) else {
            return age > ORPHAN_GRACE;
        };
        if age > stale_after.saturating_mul(10) {
            return true;
        }
        if property(&owner, "host")
            .and_then(string)
            .is_some_and(|host| !host.is_empty() && host != self.host)
        {
            return false;
        }
        let Some(pid) = property(&owner, "pid").and_then(number) else {
            return false;
        };
        if pid == f64::from(std::process::id()) {
            let Some(start) = property(&owner, "procStart") else {
                return false;
            };
            let Some(mono) = property(start, "mono")
                .and_then(number)
                .filter(|value| value.is_finite())
            else {
                return false;
            };
            let boot = property(start, "boot").and_then(string);
            return boot
                .as_ref()
                .zip(self.incarnation.boot.as_ref())
                .is_some_and(|(found, own)| found != own)
                || (mono - self.incarnation.mono as f64).abs() > 1000.0;
        }
        if pid > f64::from(i32::MAX) {
            return true;
        }
        // A private home cannot be held by another user (the documented f.4 tightening).
        process::alive(pid as u32) != Liveness::Alive
    }
}

fn remove_moved(path: &Path) {
    let _ = fs::remove_dir_all(path);
}
fn put_back(moved: &Path, path: &Path) {
    if fs::create_dir(path).is_err() {
        remove_moved(moved);
        return;
    }
    let source = moved.join("owner.json");
    let destination = path.join("owner.json");
    if source.exists() && fs::hard_link(&source, &destination).is_err() {
        let _ = fs::copy(&source, &destination);
    }
    if let Ok(before) = snapshot(moved) {
        if let Ok(file) = directory_file(path) {
            let mut times = fs::FileTimes::new().set_modified(before.modified);
            if let Some(accessed) = before.accessed {
                times = times.set_accessed(accessed);
            }
            let _ = file.set_times(times);
        }
    }
    remove_moved(moved);
}
fn sweep(path: &Path, context: &Context, stale_after: Duration) {
    let Some(parent) = path.parent() else { return };
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let prefix = format!("{name}.");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(tail) = name.strip_prefix(&prefix) else {
            continue;
        };
        if !(tail.starts_with("rel-") || tail.starts_with("break-")) {
            continue;
        }
        if snapshot(&entry.path()).is_ok_and(|snapshot| context.stale(&snapshot, stale_after)) {
            remove_moved(&entry.path());
        }
    }
}
fn take_over(path: &Path, context: &Context, stale_after: Duration) -> Result<bool, StoreError> {
    let before = match snapshot(path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(io_error(error)),
    };
    let stale = context.stale(&before, stale_after);
    sweep(path, context, stale_after);
    if !stale {
        return Ok(false);
    }
    let moved = suffix(path, &format!(".break-{}", Uuid::new_v4()));
    if let Err(error) = fs::rename(path, &moved) {
        return Ok(error.kind() == io::ErrorKind::NotFound);
    }
    if snapshot(&moved).is_ok_and(|now| now.id == before.id && now.raw == before.raw) {
        remove_moved(&moved);
        return Ok(true);
    }
    put_back(&moved, path);
    Ok(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Owner<'a> {
    nonce: &'a str,
    pid: u32,
    host: &'a str,
    proc_start: &'a Incarnation,
    acquired_at: String,
}
fn create(path: &Path, context: &Context) -> Result<NeoGuard, io::Error> {
    fs::create_dir(path)?;
    let nonce = Uuid::new_v4().to_string();
    let record = Owner {
        nonce: &nonce,
        pid: std::process::id(),
        host: &context.host,
        proc_start: &context.incarnation,
        acquired_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let result = serde_json::to_vec(&record)
        .map_err(io::Error::other)
        .and_then(|bytes| fs::write(path.join("owner.json"), bytes));
    if let Err(error) = result {
        remove_moved(path);
        return Err(error);
    }
    Ok(NeoGuard {
        path: path.to_owned(),
        nonce,
        released: false,
    })
}

pub(crate) fn try_acquire(
    path: &Path,
    stale_after: Duration,
) -> Result<Option<NeoGuard>, StoreError> {
    let _mutation = protocol_mutex()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_trusted_path(path)?;
    if let Some(parent) = path.parent() {
        secure_dir(parent)?;
    }
    let context = Context::new()?;
    match create(path, &context) {
        Ok(guard) => Ok(Some(guard)),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !take_over(path, &context, stale_after)? {
                return Ok(None);
            }
            match create(path, &context) {
                Ok(guard) => Ok(Some(guard)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(None),
                Err(error) => Err(io_error(error)),
            }
        }
        Err(error) => Err(io_error(error)),
    }
}

pub(crate) struct NeoGuard {
    path: PathBuf,
    nonce: String,
    released: bool,
}

fn release_attempt(path: &Path, moved: &Path, nonce: &str) -> io::Result<()> {
    let _mutation = protocol_mutex()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    fs::rename(path, moved)?;
    let owns = snapshot(moved)
        .ok()
        .and_then(|snapshot| owner(snapshot.raw.as_deref()))
        .and_then(|value| property(&value, "nonce").and_then(string))
        .as_deref()
        == Some(nonce);
    if owns {
        remove_moved(moved)
    } else {
        put_back(moved, path)
    }
    Ok(())
}

impl NeoGuard {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let moved = suffix(&self.path, &format!(".rel-{}", self.nonce));
        #[cfg(not(windows))]
        {
            let _ = release_attempt(&self.path, &moved, &self.nonce);
        }
        #[cfg(windows)]
        {
            let until = std::time::Instant::now() + Duration::from_millis(250);
            loop {
                match release_attempt(&self.path, &moved, &self.nonce) {
                    Ok(()) => break,
                    Err(error)
                        if matches!(error.raw_os_error(), Some(5 | 32 | 33))
                            && std::time::Instant::now() < until =>
                    {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        }
    }
}
impl Drop for NeoGuard {
    fn drop(&mut self) {
        self.release();
    }
}
