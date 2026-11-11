//! RE-D170: the native create facade over the payload copier, as the pin's `createSnapshot`
//! (`9f34008c`, `lib/snapshot/store-snapshot.js:473-558`, `pruneInternal` 802-815) with the
//! sources of that pin. Sources and permitted roots come from the host, never from a caller.
//! No mutation gate, no writer exclusion, no compaction pause: consistency comes only from the
//! copier's manifest retry (three tries per table, then `source-busy`).
use super::{snapshot_copy::Copier, SnapshotError, SNAPSHOT_SCHEMA};
use crate::{
    contract::Cancel,
    store::{directory::TrustedDirectory, paths::assert_trusted_path},
};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

/// The pin's retention (`MAX_SNAPSHOTS`); the wire carries no `maxKeep`.
pub const MAX_SNAPSHOTS: usize = 5;
const DISK_FACTOR: f64 = 1.1;
const PREFIX: &str = "plur1bus-";
const MANIFEST: &str = "snapshot.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
/// The wire carries no label: the pin's slug fallback.
const SLUG: &str = "snapshot";

/// Called after each copied payload file with its snapshot-relative path.
pub type Progress<'a> = &'a dyn Fn(&str) -> Result<(), SnapshotError>;

/// The two permitted snapshot roots of one state directory: the Core's backup staging
/// (`<state>/backup-staging`) and the engine's own root (`<state>/memory/.snapshots`).
pub struct SnapshotRoots {
    roots: [PathBuf; 2],
}

fn lexical(path: &Path) -> Result<(), SnapshotError> {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return Err(SnapshotError::UnsafePath);
    }
    Ok(())
}
fn same(a: &Path, b: &Path) -> bool {
    a.components().eq(b.components())
}
fn within(child: &Path, parent: &Path) -> bool {
    let mut child = child.components();
    parent.components().all(|part| child.next() == Some(part))
}

/// The pin's staging pattern `^plur1bus-.+\.tmp-(\d+)$`, with its pid.
fn staging_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix(PREFIX)?;
    let (head, pid) = rest.rsplit_once(".tmp-")?;
    if head.is_empty() || pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A pid beyond u32 is never a live process: it is swept like a dead one.
    Some(pid.parse().unwrap_or(u32::MAX))
}

impl SnapshotRoots {
    /// Bind the two roots below the host's state directory; nothing is opened or created.
    pub fn new(state_dir: &Path) -> Self {
        Self {
            roots: [
                state_dir.join("backup-staging"),
                state_dir.join("memory").join(".snapshots"),
            ],
        }
    }
    /// The permitted roots.
    pub fn roots(&self) -> &[PathBuf; 2] {
        &self.roots
    }
    /// Accept `out` only when it is exactly one of the two roots, absolute, without `..`, and
    /// every existing component is a real directory (no symlink or junction). Fail closed.
    pub fn bind_root(&self, out: &Path) -> Result<PathBuf, SnapshotError> {
        lexical(out)?;
        let root = self
            .roots
            .iter()
            .find(|root| same(root, out))
            .ok_or(SnapshotError::UnsafePath)?;
        assert_trusted_path(root).map_err(|_| SnapshotError::UnsafePath)?;
        Ok(root.clone())
    }
    /// Accept `dir` only as a published snapshot: a direct `plur1bus-…` child of a root, not a
    /// `.tmp-<pid>` staging directory, with no symlink in any component.
    pub fn bind_snapshot(&self, dir: &Path) -> Result<PathBuf, SnapshotError> {
        lexical(dir)?;
        let name = dir
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(SnapshotError::UnsafePath)?;
        let parent = dir.parent().ok_or(SnapshotError::UnsafePath)?;
        let root = self
            .roots
            .iter()
            .find(|root| same(root, parent))
            .ok_or(SnapshotError::UnsafePath)?;
        if !name.starts_with(PREFIX)
            || staging_pid(name).is_some()
            || !super::safe_relative(name)
            || name.contains('/')
        {
            return Err(SnapshotError::UnsafePath);
        }
        let dir = root.join(name);
        assert_trusted_path(&dir).map_err(|_| SnapshotError::UnsafePath)?;
        Ok(dir)
    }
    /// The pin's `assertSafeBase` against both roots: the store base must not be the state
    /// directory or contain it, and must neither lie in a root nor contain one.
    fn assert_safe_base(&self, state: &Path, base: &Path) -> Result<(), SnapshotError> {
        lexical(state)?;
        lexical(base)?;
        assert_trusted_path(state).map_err(|_| SnapshotError::UnsafePath)?;
        assert_trusted_path(base).map_err(|_| SnapshotError::UnsafePath)?;
        // Lexically and, like the pin's second `realpath` pass, physically: on a case-insensitive
        // file system another spelling of the same directory must not slip through.
        let spelled = (state.to_owned(), base.to_owned(), self.roots.clone());
        let resolved = (
            physical(state)?,
            physical(base)?,
            [physical(&self.roots[0])?, physical(&self.roots[1])?],
        );
        for (state, base, roots) in [spelled, resolved] {
            if within(&state, &base) {
                return Err(SnapshotError::UnsafePath);
            }
            for root in &roots {
                if within(&base, root) || within(root, &base) {
                    return Err(SnapshotError::UnsafePath);
                }
            }
        }
        Ok(())
    }
}

/// The physical spelling of `path`: its longest existing prefix as the file system resolves it
/// (`realpath`, which also yields the stored letter case), joined with the missing rest.
fn physical(path: &Path) -> Result<PathBuf, SnapshotError> {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        match fs::canonicalize(existing) {
            Ok(resolved) => {
                return Ok(rest
                    .iter()
                    .rev()
                    .fold(resolved, |path, part| path.join(part)));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                rest.push(existing.file_name().ok_or(SnapshotError::UnsafePath)?);
                existing = existing.parent().ok_or(SnapshotError::UnsafePath)?;
            }
            Err(_) => return Err(SnapshotError::UnsafePath),
        }
    }
}

/// One snapshot source of the pin: the store base and the memory side files, when present.
struct Source {
    /// The directory that holds `name` (files) or the source directory itself.
    path: PathBuf,
    /// A single file's name inside `path`.
    name: Option<&'static str>,
    dest: &'static str,
}

/// Present, of the wanted kind, never a link: the pin follows a link only inside its parent;
/// the engine refuses every link (`unsafe-path`), as all its trusted paths do.
fn resolve(path: &Path, want_dir: bool) -> Result<bool, SnapshotError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(SnapshotError::UnsafePath),
        Ok(meta) => Ok(if want_dir {
            meta.is_dir()
        } else {
            meta.is_file()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(SnapshotError::Storage),
    }
}

/// The inputs of one create; every path comes from the host composition.
pub struct CreateRequest<'a> {
    /// The host state directory (`<home>/state`).
    pub state_dir: &'a Path,
    /// The configured store base.
    pub base: &'a Path,
    /// The caller's `out`, bound by [`SnapshotRoots::bind_root`] in [`prepare`].
    pub out: &'a Path,
    /// The host clock.
    pub now_ms: i64,
    /// Test seam only: the free bytes the disk check sees.
    pub free_bytes: Option<u64>,
    /// Test seam only: called after each copied file.
    pub progress: Option<Progress<'a>>,
    /// Whether the engine has begun to close; checked with `cancel` before every step.
    pub stopped: Option<&'a dyn Fn() -> bool>,
}

/// A validated create whose snapshot name is known before anything is written, so the audit
/// line can name it. Nothing has been created yet.
pub struct CreatePlan<'a> {
    request: CreateRequest<'a>,
    root: PathBuf,
    sources: Vec<Source>,
    id: String,
}

/// The pin's `createSnapshot` result.
#[derive(Debug, Serialize)]
pub struct CreateReport {
    /// Snapshot directory name.
    pub id: String,
    /// Published directory.
    pub dir: PathBuf,
    /// Payload bytes.
    pub bytes: u64,
    /// Payload file count.
    pub files: usize,
    /// Snapshots removed by retention.
    pub pruned: Vec<String>,
    /// Fixed, content-free texts for a failed root fsync or prune.
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a> {
    schema: &'static str,
    id: &'a str,
    created_at: String,
    label: Option<String>,
    plugin_version: Option<String>,
    base_db_path: &'a Path,
    contents: Vec<&'static str>,
    bytes: u64,
    file_count: usize,
    files: Vec<super::snapshot_copy::PayloadFile>,
}

fn utc(now_ms: i64) -> Result<chrono::DateTime<chrono::Utc>, SnapshotError> {
    chrono::DateTime::from_timestamp_millis(now_ms).ok_or(SnapshotError::Storage)
}

fn exists(path: &Path) -> Result<bool, SnapshotError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(SnapshotError::Storage),
    }
}

/// Validate the root and the sources and choose the name; read-only.
pub fn prepare<'a>(
    roots: &SnapshotRoots,
    request: CreateRequest<'a>,
) -> Result<CreatePlan<'a>, SnapshotError> {
    let root = roots.bind_root(request.out)?;
    roots.assert_safe_base(request.state_dir, request.base)?;
    if !resolve(request.base, true)? {
        return Err(SnapshotError::NotFound);
    }
    let mut sources = vec![Source {
        path: request.base.to_owned(),
        name: None,
        dest: "store",
    }];
    let memory = request.state_dir.join("memory");
    if resolve(&memory.join("_archive"), true)? {
        sources.push(Source {
            path: memory.join("_archive"),
            name: None,
            dest: "memory/_archive",
        });
    }
    for (name, dest) in [
        ("run-state.json", "memory/run-state.json"),
        ("merge-proposals.jsonl", "memory/merge-proposals.jsonl"),
    ] {
        if resolve(&memory.join(name), false)? {
            sources.push(Source {
                path: memory.clone(),
                name: Some(name),
                dest,
            });
        }
    }
    let stamp = utc(request.now_ms)?.format("%Y%m%dT%H%M%SZ");
    let base_id = format!("{PREFIX}{stamp}-{SLUG}");
    let pid = std::process::id();
    let mut id = base_id.clone();
    let mut k = 2_u32;
    while exists(&root.join(&id))? || exists(&root.join(format!("{id}.tmp-{pid}")))? {
        if k > 10_000 {
            return Err(SnapshotError::Storage);
        }
        id = format!("{base_id}-{k}");
        k += 1;
    }
    Ok(CreatePlan {
        request,
        root,
        sources,
        id,
    })
}

fn tree_size(path: &Path, skip_cache: bool, cancel: &Cancel) -> Result<u64, SnapshotError> {
    cancel.check().map_err(|_| SnapshotError::Cancelled)?;
    let mut total = 0_u64;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err(SnapshotError::Storage),
    };
    for entry in entries {
        let entry = entry.map_err(|_| SnapshotError::Storage)?;
        if skip_cache
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("llm-result-cache-v1"))
        {
            continue;
        }
        let kind = entry.file_type().map_err(|_| SnapshotError::Storage)?;
        if kind.is_dir() {
            total = total.saturating_add(tree_size(&entry.path(), false, cancel)?);
        } else if kind.is_file() {
            match entry.metadata() {
                Ok(meta) => total = total.saturating_add(meta.len()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(SnapshotError::Storage),
            }
        }
    }
    Ok(total)
}

#[cfg(unix)]
fn free_bytes(path: &Path) -> Result<u64, SnapshotError> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| SnapshotError::UnsafePath)?;
    // SAFETY: an all-zero statvfs is a valid out-parameter; statvfs only writes into it.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: the NUL-terminated path and the out-parameter both live across the call.
    if unsafe { libc::statvfs(name.as_ptr(), &mut stat) } != 0 {
        return Err(SnapshotError::Storage);
    }
    #[allow(
        clippy::useless_conversion,
        reason = "the field widths differ per platform"
    )]
    let free = u64::from(stat.f_bavail).saturating_mul(u64::from(stat.f_frsize));
    Ok(free)
}

#[cfg(windows)]
fn free_bytes(path: &Path) -> Result<u64, SnapshotError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0_u64;
    // SAFETY: the NUL-terminated wide path and the out-parameter live across the call; the
    // two optional totals are null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(SnapshotError::Storage);
    }
    Ok(available)
}

/// Remove `plur1bus-*.tmp-<pid>` directories whose creating process is gone (pin
/// `sweepStaleStaging`). Links and files are never followed or removed.
fn sweep_stale_staging(root: &TrustedDirectory, cancel: &Cancel) -> Result<(), SnapshotError> {
    let own = std::process::id();
    for entry in fs::read_dir(root.path()).map_err(|_| SnapshotError::Storage)? {
        cancel.check().map_err(|_| SnapshotError::Cancelled)?;
        let entry = entry.map_err(|_| SnapshotError::Storage)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(pid) = staging_pid(&name) else {
            continue;
        };
        if pid == own
            || plur1bus_rpc::process::alive(pid) != plur1bus_rpc::process::Liveness::Gone
            || !entry
                .file_type()
                .map_err(|_| SnapshotError::Storage)?
                .is_dir()
        {
            continue;
        }
        root.assert_unchanged()?;
        match fs::remove_dir_all(root.path().join(&name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(SnapshotError::Storage),
        }
    }
    Ok(())
}

/// Owns the staging directory handle and removes the directory unless the snapshot was
/// published under its final name. The handle is closed before the removal (Windows sharing).
struct Staging<'a> {
    root: &'a TrustedDirectory,
    name: String,
    dir: Option<TrustedDirectory>,
    published: bool,
}
impl Staging<'_> {
    fn dir(&self) -> Result<&TrustedDirectory, SnapshotError> {
        self.dir.as_ref().ok_or(SnapshotError::Storage)
    }
}
impl Drop for Staging<'_> {
    fn drop(&mut self) {
        drop(self.dir.take());
        if !self.published && self.root.assert_unchanged().is_ok() {
            let _ = fs::remove_dir_all(self.root.path().join(&self.name));
        }
    }
}

fn check(cancel: &Cancel) -> Result<(), SnapshotError> {
    cancel.check().map_err(|_| SnapshotError::Cancelled)
}

/// Rename the finished staging directory to its final name. Windows: an indexer or virus
/// scanner may hold the tree briefly; retry sharing/access refusals for at most 10 s (the
/// pin's `withWinRetry`), checking the cancellation and the engine's close between attempts.
#[cfg(windows)]
fn publish(
    from: &Path,
    to: &Path,
    step: &dyn Fn() -> Result<(), SnapshotError>,
) -> Result<(), SnapshotError> {
    const LIMIT: std::time::Duration = std::time::Duration::from_secs(10);
    const SHARING_VIOLATION: i32 = 32;
    const LOCK_VIOLATION: i32 = 33;
    let started = std::time::Instant::now();
    let mut delay = std::time::Duration::from_millis(50);
    loop {
        let error = match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        let transient = error.kind() == std::io::ErrorKind::PermissionDenied
            || matches!(
                error.raw_os_error(),
                Some(SHARING_VIOLATION | LOCK_VIOLATION)
            );
        let left = LIMIT.saturating_sub(started.elapsed());
        if !transient || left.is_zero() {
            return Err(SnapshotError::Storage);
        }
        std::thread::sleep(delay.min(left));
        delay = (delay * 2).min(std::time::Duration::from_secs(1));
        step()?;
        if exists(to)? {
            return Err(SnapshotError::Storage);
        }
    }
}

/// Rename the finished staging directory to its final name (one attempt off Windows).
#[cfg(not(windows))]
fn publish(
    from: &Path,
    to: &Path,
    _step: &dyn Fn() -> Result<(), SnapshotError>,
) -> Result<(), SnapshotError> {
    fs::rename(from, to).map_err(|_| SnapshotError::Storage)
}

impl CreatePlan<'_> {
    /// The snapshot directory name this create will publish.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Create, publish and prune as the pin. `cancel` (connection, request, process stop) is
    /// checked before every step and inside the copier; after it no further step starts, not
    /// even the rename or the prune. A failure or cancellation before the rename removes the
    /// staging directory: there is never a partial snapshot under the final name.
    pub fn execute(self, cancel: &Cancel) -> Result<CreateReport, SnapshotError> {
        // Every step boundary: the caller's cancellation and the engine's own close, so a
        // direct engine close (without a connection cancel) also starts no further step.
        let stopped = self.request.stopped;
        let step = || -> Result<(), SnapshotError> {
            check(cancel)?;
            if stopped.is_some_and(|stopped| stopped()) {
                return Err(SnapshotError::Cancelled);
            }
            Ok(())
        };
        step()?;
        crate::store::paths::secure_dir(&self.root).map_err(SnapshotError::from)?;
        let root = TrustedDirectory::open(&self.root)?;
        sweep_stale_staging(&root, cancel)?;
        let mut size = 0_u64;
        for source in &self.sources {
            step()?;
            size = size.saturating_add(match source.name {
                Some(name) => match fs::symlink_metadata(source.path.join(name)) {
                    Ok(meta) if meta.is_file() => meta.len(),
                    _ => 0,
                },
                None => tree_size(&source.path, source.dest == "store", cancel)?,
            });
        }
        let free = match self.request.free_bytes {
            Some(free) => free,
            None => free_bytes(root.path())?,
        };
        if (free as f64) < DISK_FACTOR * size as f64 {
            return Err(SnapshotError::InsufficientDisk);
        }
        step()?;
        let staging_name = format!("{}.tmp-{}", self.id, std::process::id());
        let mut staging = Staging {
            root: &root,
            name: staging_name.clone(),
            dir: None,
            published: false,
        };
        staging.dir = Some(root.create_child(&staging_name)?);
        let files = {
            let mut copier = Copier::new(staging.dir()?, cancel)?;
            if let Some(progress) = self.request.progress {
                copier.set_progress(progress);
            }
            for source in &self.sources {
                step()?;
                let from = TrustedDirectory::open(&source.path)?;
                match source.name {
                    Some(name) => match copier.copy_file(&from, name, source.dest) {
                        // A plain file that vanished is not part of the snapshot (pin).
                        Err(SnapshotError::NotFound) => {}
                        result => result?,
                    },
                    None => copier.copy_directory(&from, source.dest)?,
                }
            }
            copier.files()
        };
        let bytes = files
            .iter()
            .fold(0_u64, |sum, file| sum.saturating_add(file.bytes));
        let file_count = files.len();
        let manifest = Manifest {
            schema: SNAPSHOT_SCHEMA,
            id: &self.id,
            created_at: utc(self.request.now_ms)?
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            label: None,
            plugin_version: None,
            base_db_path: self.request.base,
            contents: self.sources.iter().map(|source| source.dest).collect(),
            bytes,
            file_count,
            files,
        };
        let text = serde_json::to_string_pretty(&manifest).map_err(|_| SnapshotError::Storage)?;
        step()?;
        let staging_dir = staging.dir()?;
        let temporary = format!("{MANIFEST}.tmp-{}", std::process::id());
        let mut output = staging_dir.create_file(&temporary)?;
        output
            .write_all(format!("{text}\n").as_bytes())
            .and_then(|()| output.sync_all())
            .map_err(|_| SnapshotError::Storage)?;
        drop(output);
        staging_dir.assert_unchanged()?;
        fs::rename(
            staging_dir.path().join(&temporary),
            staging_dir.path().join(MANIFEST),
        )
        .map_err(|_| SnapshotError::Storage)?;
        staging_dir.sync_entries()?;
        // No handle of the staging tree stays open across its rename (Windows sharing).
        let staging_path = staging_dir.path().to_owned();
        drop(staging.dir.take());
        step()?;
        root.assert_unchanged()?;
        let final_dir = root.path().join(&self.id);
        if exists(&final_dir)? {
            return Err(SnapshotError::Storage);
        }
        publish(&staging_path, &final_dir, &step)?;
        staging.published = true;
        drop(staging);
        // Published: nothing below may fail the create; a cancellation or close only skips
        // the rest (no root fsync, no prune).
        let mut warnings = Vec::new();
        let mut pruned = Vec::new();
        if step().is_err() {
            warnings.push("fsync and pruning skipped after cancellation".to_owned());
        } else {
            if root.sync_entries().is_err() {
                warnings.push("fsync of the snapshot root failed".to_owned());
            }
            match prune(&root, MAX_SNAPSHOTS, Some(&self.id), cancel) {
                Ok(removed) => pruned = removed,
                Err(_) => warnings.push("pruning old snapshots failed".to_owned()),
            }
        }
        Ok(CreateReport {
            id: self.id,
            dir: final_dir,
            bytes,
            files: file_count,
            pruned,
            warnings,
        })
    }
}

fn created_at(root: &TrustedDirectory, name: &str) -> Result<Option<String>, SnapshotError> {
    let file = match root
        .open_child(name)
        .and_then(|dir| dir.open_file(MANIFEST))
    {
        Ok(file) => file,
        Err(error) => {
            return match SnapshotError::from(error) {
                SnapshotError::NotFound => Ok(None),
                error => Err(error),
            }
        }
    };
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(file, MAX_MANIFEST_BYTES + 1),
        &mut bytes,
    )
    .map_err(|_| SnapshotError::Storage)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Ok(None);
    }
    // Not a finished snapshot: unreadable JSON or another schema (pin `listInternal`).
    let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(None);
    };
    if manifest["schema"] != SNAPSHOT_SCHEMA {
        return Ok(None);
    }
    Ok(Some(match &manifest["createdAt"] {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }))
}

/// The pin's `pruneInternal`: keep the newest `max_keep` finished snapshots (and `protect`),
/// never a staging directory, a link, a legacy tarball or an unrelated entry.
pub fn prune(
    root: &TrustedDirectory,
    max_keep: usize,
    protect: Option<&str>,
    cancel: &Cancel,
) -> Result<Vec<String>, SnapshotError> {
    if max_keep == 0 {
        return Err(SnapshotError::Storage);
    }
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(root.path()).map_err(|_| SnapshotError::Storage)? {
        check(cancel)?;
        let entry = entry.map_err(|_| SnapshotError::Storage)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with(PREFIX)
            || staging_pid(&name).is_some()
            || !entry
                .file_type()
                .map_err(|_| SnapshotError::Storage)?
                .is_dir()
        {
            continue;
        }
        if let Some(created) = created_at(root, &name)? {
            snapshots.push((created, name));
        }
    }
    // Newest first; equal times by descending id, as the pin's `listInternal`.
    snapshots.sort_by(|a, b| {
        b.0.encode_utf16()
            .cmp(a.0.encode_utf16())
            .then_with(|| b.1.encode_utf16().cmp(a.1.encode_utf16()))
    });
    let excess = snapshots.len().saturating_sub(max_keep);
    let mut removed = Vec::new();
    for (index, (_, name)) in snapshots.iter().enumerate() {
        if index < max_keep || Some(name.as_str()) == protect || removed.len() >= excess {
            continue;
        }
        check(cancel)?;
        root.assert_unchanged()?;
        match fs::remove_dir_all(root.path().join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(SnapshotError::Storage),
        }
        removed.push(name.clone());
    }
    Ok(removed)
}

#[cfg(test)]
#[path = "snapshot_create_tests.rs"]
mod tests;
