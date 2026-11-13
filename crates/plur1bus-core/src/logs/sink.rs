//! `sink.ts`: the diagnostic file sink. No persistent descriptors (rotation and pruning also work on Windows); all writers
//! of a role share the OS lock `<role>.log.writer-lock`, the same SQLite byte range the TypeScript sink holds
//! (`plur1bus_audit::lock::CoreLock`), so a Rust writer and a TypeScript writer on one home exclude each other. Within
//! one process a path is also guarded by a registry, because POSIX range locks belong to the process, not to the
//! descriptor.
//!
//! The OS calls the TypeScript tests replace (`securePath`, `acquireExclusiveLock`, `fsyncSync`) are [`SinkHooks`].
use super::error::LogError;
use super::levels::Clock;
use plur1bus_audit::lock::CoreLock;
use std::any::Any;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

const DAY_MS: i64 = 86_400_000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const LOCK_POLL: Duration = Duration::from_millis(5);

/// A held lock; dropping it releases the lock.
pub struct LockGuard(#[allow(dead_code)] Box<dyn Any + Send>);

impl LockGuard {
    /// Wraps whatever releases the lock when dropped.
    pub fn new(inner: impl Any + Send) -> LockGuard {
        LockGuard(Box::new(inner))
    }
}

/// `securePath(path, { mode })`: owner-only permissions; `true` when they were applied.
pub type SecurePath = Arc<dyn Fn(&Path, u32) -> bool + Send + Sync>;
/// `acquireExclusiveLock(path)`: `Ok(None)` when another holder has it.
pub type AcquireLock = Arc<dyn Fn(&Path) -> io::Result<Option<LockGuard>> + Send + Sync>;
/// `fsyncSync(fd)`.
pub type FsyncFn = Arc<dyn Fn(&File) -> io::Result<()> + Send + Sync>;

/// The seams a test replaces; the defaults are the real operating-system calls.
#[derive(Clone)]
pub struct SinkHooks {
    /// Applies owner-only permissions (`chmod` on Unix, a protected DACL on Windows).
    pub secure_path: SecurePath,
    /// Takes the cross-process lock of a path without waiting.
    pub acquire_lock: AcquireLock,
    /// Flushes a file to disk.
    pub fsync: FsyncFn,
}

impl Default for SinkHooks {
    fn default() -> Self {
        SinkHooks {
            secure_path: Arc::new(default_secure_path),
            acquire_lock: Arc::new(default_acquire_lock),
            fsync: Arc::new(|file: &File| file.sync_all()),
        }
    }
}

/// The default [`SecurePath`]: an absolute, existing path gets mode `mode` (Unix) or the user-and-SYSTEM DACL (Windows).
pub fn default_secure_path(path: &Path, mode: u32) -> bool {
    if !path.is_absolute() || fs::metadata(path).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).is_ok()
    }
    #[cfg(windows)]
    {
        let _ = mode;
        let Ok(sid) = plur1bus_rpc::win::user_sid() else {
            return false;
        };
        // A directory also protects what is created in it later (inheritable entries); a file gets the plain DACL.
        let sddl = if path.is_dir() {
            plur1bus_rpc::acl::run_dir_sddl(&sid)
        } else {
            plur1bus_rpc::acl::user_and_system_sddl(&sid)
        };
        plur1bus_rpc::win::set_path_dacl(path, &sddl).is_ok()
    }
}

fn held_paths() -> &'static Mutex<HashSet<PathBuf>> {
    static HELD: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

struct ProcessLock {
    // Declared first: the OS lock is released before the in-process claim is dropped.
    _os: CoreLock,
    path: PathBuf,
}

impl Drop for ProcessLock {
    fn drop(&mut self) {
        held_paths()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.path);
    }
}

/// The default [`AcquireLock`]: the in-process claim, then the SQLite byte-range lock on the file.
pub fn default_acquire_lock(path: &Path) -> io::Result<Option<LockGuard>> {
    let claimed = held_paths()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path.to_path_buf());
    if !claimed {
        return Ok(None);
    }
    match CoreLock::try_acquire(path) {
        Ok(Some(os)) => Ok(Some(LockGuard::new(ProcessLock {
            _os: os,
            path: path.to_path_buf(),
        }))),
        other => {
            held_paths()
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(path);
            other.map(|_| None)
        }
    }
}

/// What [`Sink::new`] needs.
#[derive(Clone)]
pub struct SinkOptions {
    /// The log directory (created `0700`).
    pub dir: PathBuf,
    /// The role: `^[a-z0-9][a-z0-9._-]{0,127}$`, not `audit` or `payload`.
    pub role: String,
    /// The clock (file times, day rotation, retention).
    pub now: Clock,
    /// Rotation size; default 20 MiB.
    pub max_bytes: Option<f64>,
    /// Rotated copies kept; default 5.
    pub keep: Option<i64>,
    /// Age in days after which rotated copies are pruned; default 14, 0 disables.
    pub retention_days: Option<i64>,
    /// The replaceable OS calls.
    pub hooks: SinkHooks,
    /// How long a lock is waited for; default 5 s for the role lock and 30 s for the directory lock.
    pub lock_timeout: Option<Duration>,
}

impl SinkOptions {
    /// Options with every default.
    pub fn new(dir: impl Into<PathBuf>, role: &str, now: Clock) -> SinkOptions {
        SinkOptions {
            dir: dir.into(),
            role: role.to_string(),
            now,
            max_bytes: None,
            keep: None,
            retention_days: None,
            hooks: SinkHooks::default(),
            lock_timeout: None,
        }
    }
}

/// What a prune removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PruneResult {
    /// Files removed.
    pub files: u64,
    /// Their total size.
    pub bytes: u64,
}

fn valid_role(role: &str) -> bool {
    let b = role.as_bytes();
    let first = b
        .first()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = b
        .iter()
        .skip(1)
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'));
    let reserved = ["audit", "payload"].iter().any(|r| {
        role.strip_prefix(r)
            .is_some_and(|tail| tail.is_empty() || tail.starts_with('.'))
    });
    first && rest && b.len() <= 128 && !reserved
}

/// The identity of a file: device, inode and creation time (so a replaced file is noticed), or the creation time on
/// Windows.
fn identity_of(file: &File) -> io::Result<String> {
    let meta = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let born = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Ok(format!("{}:{}:{born}", meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(format!("{}", meta.creation_time()))
    }
}

fn mtime_ms(meta: &fs::Metadata) -> i128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128 / 1_000_000)
        .unwrap_or(0)
}

fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// A path that exists must be a regular file (a symlink is not one: it is never followed).
fn regular(path: &Path) -> Result<(), LogError> {
    if exists(path) && !fs::symlink_metadata(path)?.is_file() {
        return Err(LogError::NotRegularFile);
    }
    Ok(())
}

fn open_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Runs `f` under the lock of `lock_path`, waiting up to `wait` for it.
fn locked<T>(
    acquire: &AcquireLock,
    lock_path: &Path,
    wait: Duration,
    f: impl FnOnce() -> Result<T, LogError>,
) -> Result<T, LogError> {
    let deadline = Instant::now() + wait;
    loop {
        if let Some(guard) = acquire(lock_path)? {
            let result = f();
            drop(guard);
            return result;
        }
        if Instant::now() >= deadline {
            return Err(LogError::Busy);
        }
        std::thread::sleep(LOCK_POLL);
    }
}

/// The sink of one role.
pub struct Sink {
    dir: PathBuf,
    file: PathBuf,
    now: Clock,
    hooks: SinkHooks,
    max_bytes: f64,
    keep: i64,
    retention_days: i64,
    lock_wait: Duration,
    secured_identity: Option<String>,
    dirty: bool,
    role: String,
}

impl Sink {
    /// Creates the directory, secures it, and validates the role. Fails with `RangeError("diagnostic role required")` for a
    /// reserved or malformed role and `"invalid retention days"` for a retention outside `0..=2^53-1`.
    pub fn new(options: SinkOptions) -> Result<Sink, LogError> {
        if !valid_role(&options.role) {
            return Err(LogError::Range("diagnostic role required".into()));
        }
        let retention_days = options.retention_days.unwrap_or(14);
        if !(0..=MAX_SAFE_INTEGER).contains(&retention_days) {
            return Err(LogError::Range("invalid retention days".into()));
        }
        create_private_dir(&options.dir)?;
        if !fs::symlink_metadata(&options.dir)?.is_dir() {
            return Err(LogError::NotDirectory);
        }
        let sink = Sink {
            file: options.dir.join(format!("{}.log", options.role)),
            dir: options.dir,
            now: options.now,
            hooks: options.hooks,
            max_bytes: options.max_bytes.unwrap_or(20.0 * 1024.0 * 1024.0),
            keep: options.keep.unwrap_or(5),
            retention_days,
            lock_wait: options.lock_timeout.unwrap_or(Duration::from_secs(5)),
            secured_identity: None,
            dirty: false,
            role: options.role,
        };
        let directory_lock = sink.dir.join(".directory-security-lock");
        let wait = options.lock_timeout.unwrap_or(Duration::from_secs(30));
        let (dir, hooks) = (sink.dir.clone(), sink.hooks.clone());
        locked(&hooks.acquire_lock, &directory_lock, wait, || {
            secure(&hooks, &dir, 0o700)?;
            secure(&hooks, &directory_lock, 0o600)
        })?;
        Ok(sink)
    }

    /// The live file, `<dir>/<role>.log`.
    pub fn file(&self) -> &Path {
        &self.file
    }

    fn writer_lock(&self) -> PathBuf {
        let mut name = self.file.clone().into_os_string();
        name.push(".writer-lock");
        PathBuf::from(name)
    }

    fn rotated(&self, n: i64) -> PathBuf {
        let mut name = self.file.clone().into_os_string();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }

    /// Changes the rotation limits; invalid limits change nothing.
    pub fn set_rotation(&mut self, max_bytes: f64, keep: i64) -> Result<(), LogError> {
        if !max_bytes.is_finite() || max_bytes <= 0.0 || keep < 1 {
            return Err(LogError::Range("invalid rotation".into()));
        }
        self.max_bytes = max_bytes;
        self.keep = keep;
        Ok(())
    }

    /// Appends one line (a single-record batch).
    pub fn append(&mut self, line: &str, durable: bool) -> Result<(), LogError> {
        self.append_batch(&[line.to_string()], durable, &mut |_| {})
    }

    /// Appends `lines` in order under ONE acquisition of the role lock (the lock costs about a millisecond; taking it per
    /// record made bursts of output lines slow). A line that would push a non-empty file over `max_bytes` rotates first,
    /// and a file last written on an earlier day rotates before the batch. Lines of one batch are contiguous in the file;
    /// other processes interleave between batches, never inside a line. `written(n)` is called after each chunk of `n`
    /// lines reached the file (before any fsync), so a caller that keeps the rest queued after an error neither loses nor
    /// repeats a record.
    pub fn append_batch(
        &mut self,
        lines: &[String],
        durable: bool,
        written: &mut dyn FnMut(usize),
    ) -> Result<(), LogError> {
        if lines.is_empty() {
            return Ok(());
        }
        let acquire = self.hooks.acquire_lock.clone();
        let (lock, wait) = (self.writer_lock(), self.lock_wait);
        locked(&acquire, &lock, wait, || {
            self.append_locked(lines, durable, written)
        })
    }

    fn append_locked(
        &mut self,
        lines: &[String],
        durable: bool,
        written: &mut dyn FnMut(usize),
    ) -> Result<(), LogError> {
        regular(&self.file)?;
        let mut size: u64 = 0;
        if exists(&self.file) {
            let meta = fs::metadata(&self.file)?;
            size = meta.len();
            let today = i128::from((self.now)()).div_euclid(i128::from(DAY_MS));
            if size > 0 && mtime_ms(&meta).div_euclid(i128::from(DAY_MS)) < today {
                self.rotate()?;
                size = 0;
            }
        }
        let mut chunk: Vec<&str> = Vec::new();
        let mut chunk_bytes: u64 = 0;
        for line in lines {
            let bytes = line.len() as u64;
            if (size + chunk_bytes > 0) && (size + chunk_bytes + bytes) as f64 > self.max_bytes {
                self.write_chunk(&mut chunk, &mut chunk_bytes, &mut size, written)?;
                self.rotate()?;
                size = 0;
            }
            chunk.push(line);
            chunk_bytes += bytes;
        }
        self.write_chunk(&mut chunk, &mut chunk_bytes, &mut size, written)?;
        if durable && self.dirty {
            self.sync_dirty(false)?;
        }
        Ok(())
    }

    fn write_chunk(
        &mut self,
        chunk: &mut Vec<&str>,
        chunk_bytes: &mut u64,
        size: &mut u64,
        written: &mut dyn FnMut(usize),
    ) -> Result<(), LogError> {
        if chunk.is_empty() {
            return Ok(());
        }
        let mut file = open_append(&self.file)?;
        let identity = identity_of(&file)?;
        if self.secured_identity.as_deref() != Some(identity.as_str()) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&self.file, fs::Permissions::from_mode(0o600))?;
            }
            secure(&self.hooks, &self.file, 0o600)?;
            self.secured_identity = Some(identity);
        }
        let data: String = chunk.concat();
        file.write_all(data.as_bytes())?;
        self.dirty = true;
        let count = chunk.len();
        *size += *chunk_bytes;
        chunk.clear();
        *chunk_bytes = 0;
        written(count);
        let now = system_time((self.now)());
        file.set_times(fs::FileTimes::new().set_accessed(now).set_modified(now))?;
        // APFS may lower the birth time when earlier timestamps are set; cache the identity after our own update.
        self.secured_identity = Some(identity_of(&file)?);
        Ok(())
    }

    /// Caller holds the role lock. Info and debug appends are immediately visible; a timer, an explicit flush, a warning,
    /// a close or a rotation pays the disk-sync cost once per batch.
    fn sync_dirty(&mut self, force: bool) -> Result<(), LogError> {
        if !self.dirty && !force {
            return Ok(());
        }
        regular(&self.file)?;
        let file = open_append(&self.file)?;
        (self.hooks.fsync)(&file)?;
        self.dirty = false;
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), LogError> {
        // Another writer may have appended without syncing under the shared role lock; our own dirty flag cannot
        // describe that writer's pending batch. Never rename an unsynced diagnostic batch.
        self.sync_dirty(true)?;
        regular(&self.file)?;
        let oldest = self.rotated(self.keep);
        regular(&oldest)?;
        match fs::remove_file(&oldest) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        for i in (1..self.keep).rev() {
            let (from, to) = (self.rotated(i), self.rotated(i + 1));
            regular(&from)?;
            regular(&to)?;
            if exists(&from) {
                fs::rename(&from, &to)?;
            }
        }
        if exists(&self.file) {
            fs::rename(&self.file, self.rotated(1))?;
        }
        self.secured_identity = None;
        Ok(())
    }

    /// Syncs the file when something was written since the last sync.
    pub fn sync(&mut self) -> Result<(), LogError> {
        if !self.dirty {
            return Ok(());
        }
        let acquire = self.hooks.acquire_lock.clone();
        let (lock, wait) = (self.writer_lock(), self.lock_wait);
        locked(&acquire, &lock, wait, || self.sync_dirty(false))
    }

    /// Removes this role's rotated copies older than the retention. Never the live file, another role's or the audit and
    /// payload files.
    pub fn prune(&mut self) -> Result<PruneResult, LogError> {
        let acquire = self.hooks.acquire_lock.clone();
        let (lock, wait) = (self.writer_lock(), self.lock_wait);
        locked(&acquire, &lock, wait, || {
            let mut result = PruneResult::default();
            if self.retention_days == 0 {
                return Ok(result);
            }
            let prefix = format!("{}.log.", self.role);
            let limit =
                i128::from((self.now)()) - i128::from(self.retention_days) * i128::from(DAY_MS);
            for entry in fs::read_dir(&self.dir)? {
                let name = entry?.file_name();
                let Some(name) = name.to_str() else { continue };
                let numbered = name
                    .strip_prefix(&prefix)
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
                if !numbered {
                    continue;
                }
                let path = self.dir.join(name);
                let meta = fs::symlink_metadata(&path)?;
                if meta.is_file() && mtime_ms(&meta) < limit {
                    fs::remove_file(&path)?;
                    result.files += 1;
                    result.bytes += meta.len();
                }
            }
            Ok(result)
        })
    }
}

fn secure(hooks: &SinkHooks, path: &Path, mode: u32) -> Result<(), LogError> {
    if (hooks.secure_path)(path, mode) {
        Ok(())
    } else {
        Err(LogError::CannotSecure)
    }
}

fn system_time(ms: i64) -> std::time::SystemTime {
    if ms >= 0 {
        std::time::UNIX_EPOCH + Duration::from_millis(ms.unsigned_abs())
    } else {
        std::time::UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs())
    }
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
        {
            Err(e)
                if e.kind() == io::ErrorKind::AlreadyExists
                    && fs::symlink_metadata(dir).is_ok() =>
            {
                Ok(())
            }
            other => other,
        }
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    const DAY: i64 = DAY_MS;
    const NOW: i64 = 1_791_374_400_000; // 2026-10-07T12:00:00Z

    fn ok_hooks() -> SinkHooks {
        SinkHooks {
            secure_path: Arc::new(|_, _| true),
            ..SinkHooks::default()
        }
    }

    fn fixed(ms: i64) -> Clock {
        Arc::new(move || ms)
    }

    struct Fixture {
        _root: tempfile::TempDir,
        dir: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        Fixture { _root: root, dir }
    }

    fn options(f: &Fixture) -> SinkOptions {
        let mut o = SinkOptions::new(&f.dir, "core", fixed(NOW));
        o.hooks = ok_hooks();
        o.lock_timeout = Some(Duration::from_millis(60));
        o
    }

    fn mk(f: &Fixture) -> Sink {
        Sink::new(options(f)).unwrap()
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    fn set_age(p: &Path, ms: i64) {
        let t = system_time(ms);
        File::options()
            .write(true)
            .open(p)
            .unwrap()
            .set_times(fs::FileTimes::new().set_accessed(t).set_modified(t))
            .unwrap();
    }

    fn gens(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("core.log") && !n.ends_with("-lock"))
            .collect();
        names.sort();
        names
    }

    /// Counts lock acquisitions per lock file name and delegates to the real OS lock.
    fn counting_hooks() -> (SinkHooks, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let real = default_acquire_lock;
        let hooks = SinkHooks {
            secure_path: Arc::new(|_, _| true),
            acquire_lock: Arc::new(move |p: &Path| {
                log.lock()
                    .unwrap()
                    .push(p.file_name().unwrap().to_string_lossy().into_owned());
                real(p)
            }),
            ..SinkHooks::default()
        };
        (hooks, seen)
    }

    fn count(seen: &Arc<Mutex<Vec<String>>>, name: &str) -> usize {
        seen.lock().unwrap().iter().filter(|n| *n == name).count()
    }

    #[test]
    fn role_validation() {
        let f = fixture();
        for role in [
            "",
            "Core",
            "-x",
            ".x",
            "a b",
            "a/b",
            "audit",
            "audit.x",
            "payload",
            "payload.1",
            &"x".repeat(129),
        ] {
            let mut o = options(&f);
            o.role = role.to_string();
            assert_eq!(
                Sink::new(o).err().unwrap().to_string(),
                "diagnostic role required",
                "{role}"
            );
        }
        for role in [
            "core",
            "a",
            &"x".repeat(128),
            "audit2",
            "payloadx",
            "my.role_1-b",
            "0abc",
        ] {
            let mut o = options(&f);
            o.role = role.to_string();
            assert_eq!(
                Sink::new(o).unwrap().file(),
                f.dir.join(format!("{role}.log"))
            );
        }
    }

    #[test]
    fn retention_days_and_the_log_directory_are_validated() {
        let f = fixture();
        for days in [-1, MAX_SAFE_INTEGER + 1] {
            let mut o = options(&f);
            o.retention_days = Some(days);
            assert_eq!(
                Sink::new(o).err().unwrap().to_string(),
                "invalid retention days"
            );
        }
        #[cfg(unix)]
        {
            let root = tempfile::tempdir().unwrap();
            let real = root.path().join("real");
            fs::create_dir(&real).unwrap();
            let link = root.path().join("logs");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let mut o = SinkOptions::new(&link, "core", fixed(NOW));
            o.hooks = ok_hooks();
            assert_eq!(
                Sink::new(o).err().unwrap().to_string(),
                "log directory is not a directory"
            );
        }
        let nested = f.dir.join("a/b/c");
        let mut o = options(&f);
        o.dir = nested.clone();
        let mut s = Sink::new(o).unwrap();
        s.append("x\n", true).unwrap();
        assert_eq!(read(s.file()), "x\n");
    }

    #[test]
    fn securing_must_apply_and_each_new_file_identity_is_secured_once() {
        let f = fixture();
        let mut o = options(&f);
        o.hooks.secure_path = Arc::new(|_, _| false);
        assert_eq!(
            Sink::new(o).err().unwrap().to_string(),
            "cannot secure log path"
        );
        let calls = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
        let c = calls.clone();
        let mut o = options(&f);
        o.hooks.secure_path = Arc::new(move |p, _| {
            c.lock().unwrap().push(p.to_path_buf());
            true
        });
        let mut s = Sink::new(o).unwrap();
        let file = s.file().to_path_buf();
        let n = |calls: &Arc<Mutex<Vec<PathBuf>>>| {
            calls.lock().unwrap().iter().filter(|p| **p == file).count()
        };
        s.append("x\n", true).unwrap();
        s.append("y\n", true).unwrap();
        assert_eq!(n(&calls), 1);
        s.set_rotation(3.0, 2).unwrap();
        s.append("z\n", true).unwrap();
        assert_eq!(n(&calls), 2, "a new file identity after the rotation");
    }

    #[test]
    fn the_file_is_not_secured_when_securing_fails_on_first_append() {
        let f = fixture();
        let budget = Arc::new(AtomicI64::new(2));
        let b = budget.clone();
        let mut o = options(&f);
        o.hooks.secure_path = Arc::new(move |_, _| b.fetch_sub(1, Ordering::SeqCst) > 0);
        let mut s = Sink::new(o).unwrap();
        assert_eq!(
            s.append("x\n", true).unwrap_err().to_string(),
            "cannot secure log path"
        );
    }

    #[test]
    #[cfg(unix)]
    fn the_default_secure_path_makes_the_file_private() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let mut o = SinkOptions::new(&f.dir, "core", fixed(NOW));
        o.lock_timeout = Some(Duration::from_millis(60));
        let mut s = Sink::new(o).unwrap();
        s.append("hello\n", true).unwrap();
        assert_eq!(read(s.file()), "hello\n");
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(s.file()), 0o600);
        assert_eq!(mode(&f.dir), 0o700);
        assert_eq!(
            fs::metadata(s.file()).unwrap().modified().unwrap(),
            system_time(NOW)
        );
    }

    #[test]
    fn a_held_lock_is_busy_and_a_released_one_is_retried() {
        let f = fixture();
        let mut s = mk(&f);
        let lock_path = f.dir.join("core.log.writer-lock");
        let held = default_acquire_lock(&lock_path).unwrap().unwrap();
        assert_eq!(
            s.append("x\n", true).unwrap_err().to_string(),
            "log writer busy"
        );
        assert_eq!(s.prune().unwrap_err().to_string(), "log writer busy");
        // the directory lock at construction
        let dir_lock = f.dir.join(".directory-security-lock");
        let held_dir = default_acquire_lock(&dir_lock).unwrap().unwrap();
        assert_eq!(
            Sink::new(options(&f)).err().unwrap().to_string(),
            "log writer busy"
        );
        drop(held_dir);
        drop(held);
        // released after a few polls
        let polls = Arc::new(AtomicUsize::new(0));
        let p = polls.clone();
        let mut o = options(&f);
        o.lock_timeout = Some(Duration::from_secs(1));
        o.hooks.acquire_lock = Arc::new(move |path| {
            if p.fetch_add(1, Ordering::SeqCst) < 3 {
                Ok(None)
            } else {
                default_acquire_lock(path)
            }
        });
        let mut s = Sink::new(o).unwrap();
        polls.store(0, Ordering::SeqCst);
        s.append("later\n", true).unwrap();
        assert_eq!(read(s.file()), "later\n");
        assert!(polls.load(Ordering::SeqCst) >= 4);
    }

    #[test]
    fn the_in_process_claim_excludes_a_second_holder_of_the_same_path() {
        let f = fixture();
        fs::create_dir_all(&f.dir).unwrap();
        let path = f.dir.join("x.lock");
        let first = default_acquire_lock(&path).unwrap().unwrap();
        assert!(default_acquire_lock(&path).unwrap().is_none());
        drop(first);
        assert!(default_acquire_lock(&path).unwrap().is_some());
    }

    #[test]
    fn rotation_validation_and_fractional_limits() {
        let f = fixture();
        let mut s = mk(&f);
        for (max, keep) in [
            (0.0, 1),
            (-1.0, 1),
            (f64::NAN, 1),
            (f64::INFINITY, 1),
            (1.0, 0),
            (1.0, -2),
        ] {
            assert_eq!(
                s.set_rotation(max, keep).unwrap_err().to_string(),
                "invalid rotation",
                "{max} {keep}"
            );
        }
        let mut o = options(&f);
        o.max_bytes = Some(1000.0);
        o.keep = Some(2);
        let mut s = Sink::new(o).unwrap();
        assert!(s.set_rotation(0.0, 9).is_err());
        s.append("aaaa\n", true).unwrap();
        s.append("bbbb\n", true).unwrap();
        assert_eq!(
            gens(&f.dir),
            ["core.log"],
            "a failed set_rotation keeps the previous limits"
        );
        s.set_rotation(2.5, 1).unwrap();
        s.append("ab\n", true).unwrap();
        s.append("cd\n", true).unwrap();
        assert_eq!(read(&f.dir.join("core.log.1")), "ab\n");
        assert_eq!(read(s.file()), "cd\n");
    }

    #[test]
    fn append_and_rotation_rules() {
        let f = fixture();
        let mut o = options(&f);
        o.max_bytes = Some(2.0);
        o.keep = Some(2);
        let mut s = Sink::new(o).unwrap();
        fs::write(s.file(), "").unwrap();
        s.append("a long line exceeding the limit\n", true).unwrap();
        assert_eq!(read(s.file()), "a long line exceeding the limit\n");
        assert!(!f.dir.join("core.log.1").exists());

        let f = fixture();
        let mut o = options(&f);
        o.max_bytes = Some(6.0);
        o.keep = Some(3);
        let mut s = Sink::new(o).unwrap();
        s.append("abc\n", true).unwrap();
        s.append("d\n", true).unwrap();
        assert_eq!(read(s.file()), "abc\nd\n");
        s.append("e\n", true).unwrap();
        assert_eq!(read(&f.dir.join("core.log.1")), "abc\nd\n");
        assert_eq!(read(s.file()), "e\n");

        let f = fixture();
        let mut o = options(&f);
        o.max_bytes = Some(10.0);
        o.keep = Some(2);
        let mut s = Sink::new(o).unwrap();
        s.append("ä€😀\n", true).unwrap(); // 2+3+4+1 = 10 bytes: bytes, not characters
        assert!(!f.dir.join("core.log.1").exists());
        s.append("x\n", true).unwrap();
        assert_eq!(read(&f.dir.join("core.log.1")), "ä€😀\n");
    }

    #[test]
    fn generations_shift_and_the_oldest_beyond_keep_is_dropped() {
        let f = fixture();
        let mut o = options(&f);
        o.max_bytes = Some(3.0);
        o.keep = Some(3);
        let mut s = Sink::new(o).unwrap();
        fs::write(f.dir.join("core.log.3"), "g3\n").unwrap();
        fs::write(f.dir.join("core.log.1"), "g1\n").unwrap();
        s.append("aa\n", true).unwrap();
        s.append("bb\n", true).unwrap();
        assert_eq!(read(&f.dir.join("core.log.1")), "aa\n");
        assert_eq!(read(&f.dir.join("core.log.2")), "g1\n");
        assert!(!f.dir.join("core.log.3").exists());
        assert_eq!(read(s.file()), "bb\n");

        let f = fixture();
        let mut o = options(&f);
        o.max_bytes = Some(3.0);
        o.keep = Some(1);
        let mut s = Sink::new(o).unwrap();
        fs::write(f.dir.join("core.log.1"), "old\n").unwrap();
        s.append("aa\n", true).unwrap();
        s.append("bb\n", true).unwrap();
        assert_eq!(read(&f.dir.join("core.log.1")), "aa\n");
        assert_eq!(gens(&f.dir), ["core.log", "core.log.1"]);
    }

    #[test]
    fn a_file_from_an_earlier_day_rotates_a_file_of_today_does_not() {
        let f = fixture();
        let mut s = mk(&f);
        fs::write(s.file(), "yesterday\n").unwrap();
        set_age(s.file(), NOW - DAY);
        s.append("today\n", true).unwrap();
        assert_eq!(read(&f.dir.join("core.log.1")), "yesterday\n");
        assert_eq!(read(s.file()), "today\n");

        let f = fixture();
        let mut s = mk(&f);
        fs::write(s.file(), "same\n").unwrap();
        set_age(s.file(), 1_791_331_201_000); // 00:00:01 the same UTC day
        s.append("again\n", true).unwrap();
        assert_eq!(read(s.file()), "same\nagain\n");
    }

    #[test]
    fn empty_lines_and_non_regular_paths() {
        let f = fixture();
        let mut s = mk(&f);
        s.append("", true).unwrap();
        s.append("", true).unwrap();
        assert!(!s.file().exists() || read(s.file()).is_empty());
        let _ = fs::remove_file(s.file());
        fs::create_dir(s.file()).unwrap();
        assert_eq!(
            s.append("x\n", true).unwrap_err().to_string(),
            "log path is not a regular file"
        );

        let f = fixture();
        let mut o = options(&f);
        o.max_bytes = Some(3.0);
        o.keep = Some(2);
        let mut s = Sink::new(o).unwrap();
        s.append("aa\n", true).unwrap();
        fs::create_dir(f.dir.join("core.log.2")).unwrap();
        assert!(s
            .append("bb\n", true)
            .unwrap_err()
            .to_string()
            .contains("not a regular file"));

        let f = fixture();
        let mut o = options(&f);
        o.max_bytes = Some(3.0);
        o.keep = Some(3);
        let mut s = Sink::new(o).unwrap();
        s.append("aa\n", true).unwrap();
        fs::create_dir(f.dir.join("core.log.2")).unwrap();
        assert!(s
            .append("bb\n", true)
            .unwrap_err()
            .to_string()
            .contains("not a regular file"));
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_in_place_of_the_log_is_never_written_through() {
        let f = fixture();
        let mut s = mk(&f);
        let target = f.dir.join("target");
        fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, s.file()).unwrap();
        assert!(s.append("x\n", true).is_err());
        assert_eq!(read(&target), "keep");
    }

    #[test]
    fn the_file_is_secured_again_after_it_was_replaced() {
        let f = fixture();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let mut o = options(&f);
        let file = f.dir.join("core.log");
        o.hooks.secure_path = Arc::new(move |p, _| {
            if p == file {
                c.fetch_add(1, Ordering::SeqCst);
            }
            true
        });
        let mut s = Sink::new(o).unwrap();
        s.append("a\n", true).unwrap();
        let before = calls.load(Ordering::SeqCst);
        fs::remove_file(s.file()).unwrap();
        fs::write(s.file(), "").unwrap();
        s.append("b\n", true).unwrap();
        assert!(calls.load(Ordering::SeqCst) >= before);
        assert_eq!(read(s.file()), "b\n");
    }

    #[test]
    fn prune_removes_only_old_rotated_copies_of_its_own_role() {
        let f = fixture();
        let mut o = options(&f);
        o.retention_days = Some(7);
        let mut s = Sink::new(o).unwrap();
        let seed = |name: &str, age_days: i64, text: &str| {
            let p = f.dir.join(name);
            fs::write(&p, text).unwrap();
            set_age(&p, NOW - age_days * DAY);
        };
        seed("core.log.1", 8, "12345");
        seed("core.log.2", 30, "123");
        seed("core.log.3", 6, "keep");
        seed("core.log", 90, "live");
        seed("other.log.1", 90, "other");
        seed("audit.log.1", 90, "audit");
        seed("payload.log.1", 90, "payload");
        seed("core.log.x", 90, "nan");
        seed("core.log.", 90, "empty");
        seed("core.log.1a", 90, "mixed");
        seed("core.log.1.bak", 90, "bak");
        assert_eq!(s.prune().unwrap(), PruneResult { files: 2, bytes: 8 });
        let mut left: Vec<String> = fs::read_dir(&f.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.') && !n.ends_with("-lock"))
            .collect();
        left.sort();
        let mut expect = vec![
            "audit.log.1",
            "core.log",
            "core.log.",
            "core.log.1a",
            "core.log.1.bak",
            "core.log.3",
            "core.log.x",
            "other.log.1",
            "payload.log.1",
        ];
        expect.sort_unstable();
        assert_eq!(left, expect);
    }

    #[test]
    fn prune_retention_zero_the_default_boundary_and_directories() {
        let f = fixture();
        let mut o = options(&f);
        o.retention_days = Some(0);
        let mut s = Sink::new(o).unwrap();
        fs::write(f.dir.join("core.log.1"), "x").unwrap();
        set_age(&f.dir.join("core.log.1"), NOW - 400 * DAY);
        assert_eq!(s.prune().unwrap(), PruneResult::default());
        assert!(f.dir.join("core.log.1").exists());

        let f = fixture();
        let mut s = mk(&f);
        fs::write(f.dir.join("core.log.1"), "a").unwrap();
        set_age(&f.dir.join("core.log.1"), NOW - 14 * DAY);
        fs::write(f.dir.join("core.log.2"), "b").unwrap();
        set_age(&f.dir.join("core.log.2"), NOW - 14 * DAY - 1000);
        assert_eq!(s.prune().unwrap(), PruneResult { files: 1, bytes: 1 });
        assert_eq!(gens(&f.dir), ["core.log.1"]);

        let f = fixture();
        let mut o = options(&f);
        o.retention_days = Some(1);
        let mut s = Sink::new(o).unwrap();
        fs::create_dir(f.dir.join("core.log.4")).unwrap();
        #[cfg(unix)]
        File::open(f.dir.join("core.log.4"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(system_time(NOW - 50 * DAY)))
            .unwrap();
        assert_eq!(s.prune().unwrap(), PruneResult::default());
        assert!(f.dir.join("core.log.4").exists());
        let f = fixture();
        assert_eq!(mk(&f).prune().unwrap(), PruneResult::default());
    }

    /// `writer-batching.test.ts`, "sink.appendBatch".
    #[test]
    fn a_batch_takes_one_lock_and_one_fsync_in_order() {
        let f = fixture();
        let (hooks, seen) = counting_hooks();
        let syncs = Arc::new(AtomicUsize::new(0));
        let s2 = syncs.clone();
        let mut o = options(&f);
        o.hooks = SinkHooks {
            fsync: Arc::new(move |file: &File| {
                s2.fetch_add(1, Ordering::SeqCst);
                file.sync_all()
            }),
            ..hooks
        };
        let mut s = Sink::new(o).unwrap();
        seen.lock().unwrap().clear();
        let mut done = Vec::new();
        s.append_batch(
            &["a\n".into(), "b\n".into(), "c\n".into()],
            true,
            &mut |n| done.push(n),
        )
        .unwrap();
        assert_eq!(count(&seen, "core.log.writer-lock"), 1);
        assert_eq!(syncs.load(Ordering::SeqCst), 1);
        assert_eq!(read(s.file()), "a\nb\nc\n");
        assert_eq!(done.iter().sum::<usize>(), 3);
        seen.lock().unwrap().clear();
        s.append_batch(&[], true, &mut |_| {}).unwrap();
        assert_eq!(
            count(&seen, "core.log.writer-lock"),
            0,
            "an empty batch takes no lock"
        );
        s.append("x\n", true).unwrap();
        assert_eq!(count(&seen, "core.log.writer-lock"), 1);
    }

    #[test]
    fn a_batch_is_split_at_the_rotation_limit_and_each_identity_secured_once() {
        let f = fixture();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let file = f.dir.join("core.log");
        let mut o = options(&f);
        o.max_bytes = Some(6.0);
        o.keep = Some(3);
        o.hooks.secure_path = Arc::new(move |p, _| {
            if p == file {
                c.fetch_add(1, Ordering::SeqCst);
            }
            true
        });
        let mut s = Sink::new(o).unwrap();
        s.append_batch(
            &["aaaa\n".into(), "bbbb\n".into(), "cccc\n".into()],
            false,
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(read(s.file()), "cccc\n");
        assert_eq!(read(&f.dir.join("core.log.1")), "bbbb\n");
        assert_eq!(read(&f.dir.join("core.log.2")), "aaaa\n");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "three file identities, each secured once"
        );
        s.sync().unwrap();
    }

    #[test]
    fn each_written_chunk_is_reported_before_a_later_one_fails() {
        let f = fixture();
        let budget = Arc::new(AtomicI64::new(i64::MAX));
        let b = budget.clone();
        let mut o = options(&f);
        o.max_bytes = Some(6.0);
        o.keep = Some(2);
        o.hooks.secure_path = Arc::new(move |_, _| b.fetch_sub(1, Ordering::SeqCst) > 0);
        let mut s = Sink::new(o).unwrap();
        budget.store(1, Ordering::SeqCst); // the first file identity is secured; the second (after a rotation) is refused
        let mut done = Vec::new();
        let err = s
            .append_batch(
                &["aaaa\n".into(), "bbbb\n".into(), "cccc\n".into()],
                false,
                &mut |n| done.push(n),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "cannot secure log path");
        assert_eq!(
            done.iter().sum::<usize>(),
            1,
            "only the line that reached the file is reported"
        );
        assert_eq!(read(&f.dir.join("core.log.1")), "aaaa\n");
        budget.store(i64::MAX, Ordering::SeqCst);
        done.clear();
        s.append_batch(&["bbbb\n".into(), "cccc\n".into()], false, &mut |n| {
            done.push(n)
        })
        .unwrap();
        assert_eq!(done.iter().sum::<usize>(), 2);
        s.sync().unwrap();
    }

    #[test]
    fn a_second_writer_syncs_the_first_writers_unsynced_file_before_rotating_it() {
        let f = fixture();
        let syncs = Arc::new(AtomicUsize::new(0));
        let s2 = syncs.clone();
        let hooks = SinkHooks {
            secure_path: Arc::new(|_, _| true),
            fsync: Arc::new(move |file: &File| {
                s2.fetch_add(1, Ordering::SeqCst);
                file.sync_all()
            }),
            ..SinkHooks::default()
        };
        let mut first_options = options(&f);
        first_options.hooks = hooks.clone();
        let mut first = Sink::new(first_options).unwrap();
        let mut second_options = options(&f);
        second_options.hooks = hooks;
        second_options.max_bytes = Some(1.0);
        let mut second = Sink::new(second_options).unwrap();
        first.append("first\n", false).unwrap();
        second.append("second\n", false).unwrap();
        assert_eq!(
            syncs.load(Ordering::SeqCst),
            1,
            "rotation must sync even when this writer is clean"
        );
        assert_eq!(read(&f.dir.join("core.log.1")), "first\n");
        second.sync().unwrap();
        first.sync().unwrap();
    }
}
