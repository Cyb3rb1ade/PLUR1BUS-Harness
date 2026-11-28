//! D109 part 2, the file-system half of the path layer (TypeScript: `canonicalisePath` and `openVerified` of
//! `policy/paths.ts`). This is the boundary at which a path argument becomes an open file: every path is turned into a
//! [`CanonicalPath`] on its REAL target, or into a typed [`PathRefusal`], before any policy check sees it, and
//! [`open_verified`] re-checks at use time that the file it opened is the file that was checked.
//!
//! The order of the TypeScript code is kept step by step, because the order is part of the guarantee: the deny list is
//! applied to the spelled path before anything is resolved and again to the real target; the hard-link scans run only
//! for a regular file with more than one link; containment in a root is decided on the real target with an exact
//! comparison; and the open is made without following the leaf (`O_NOFOLLOW`), with `O_EXCL` for a create, and is then
//! verified on the open descriptor (identity, link count, parent, and on Linux the descriptor's path).
//!
//! **Ports (R-K-2).** The file system is [`PathFs`]: [`RealFs`] over `std` (with `libc` for the open flags on unix), and a
//! scripted double in the tests for the failures real files cannot produce on demand (a swap between the pre-check and
//! the open, a descriptor whose identity changes, a directory that cannot be read, the Linux and Windows branches on
//! macOS). NFC is [`super::paths::Nfc`] (production: [`super::paths::IcuNfc`]). Nothing here is wired.
//!
//! **Deliberate differences from TypeScript** (each in the K2 entry of the ledger of P4-K):
//! - K2-D5, closed by P4D-43: `O_TRUNC` is not passed to the open; the file is truncated only after every post-open
//!   check passed. The TypeScript open truncated first, so a leaf swapped for a hard link to another file lost that
//!   file's contents before the identity check refused it; since P4D-43 it truncates after the checks as well, and the
//!   vector `swap-write-for-hard-link` is plain parity.
//! - K2-D6: the open adds `O_NONBLOCK` on unix and refuses a descriptor that is neither a regular file nor a directory
//!   (`unsupported-open`). The TypeScript open of a FIFO blocks until a writer appears, which can be never.
//! - K2-D7: after a create, the leaf at the checked path must be the created file (same device and inode, not a link).
//!   TypeScript detects a parent swapped between its pre-check and the open only while the swap lasts (and on Linux
//!   through `/proc/self/fd`); a parent swapped back in time hides the created file outside the root on macOS. Rust
//!   prevents it (R-K-11, below) and keeps the detection as a second line.
//! - An abort signal is not ported: the calls are synchronous; the flip owns cancellation.
//! - A real path that is not valid UTF-8 is refused (`unresolvable`, code `EILSEQ`); Node would decode it lossily.
//!
//! **The open goes through the checked parent's descriptor (R-K-11).** [`open_verified`] opens the parent directory
//! first (`O_DIRECTORY | O_NOFOLLOW`), compares the identity of that descriptor with the identity that was checked, and
//! only then opens the leaf relative to it (`openat` with `O_NOFOLLOW`, and `O_CREAT | O_EXCL` for a create). A parent
//! swapped for a link between the check and the open therefore cannot redirect the open or the create: the leaf is
//! looked up in the directory that was checked, wherever its name now points. [`open_verified_in`] hands the directory
//! back, so a caller can publish a file (`rename_at`, `link_at`, `unlink_at`) in that same directory. The checks after
//! the open are unchanged and now are the second line. What this does not close: a checked directory that is *moved*
//! keeps its identity, so a leaf can be opened or created inside it at its new place before the parent check after the
//! open refuses the call (nothing is written or truncated by then); and where a file system reports no birth time, an
//! inode number recycled for another file compares equal.
//!
//! **Windows (R-K-12).** `std` exposes neither the volume serial number nor the file index on stable Rust; [`RealFs`]
//! reads them with `winapi-util` (`super::fs_windows`): identity, link count, and reparse points that are never
//! followed where unix sets `O_NOFOLLOW`. There is no `openat`: the parent is opened without delete sharing, which pins
//! it while the leaf is opened by path below it. None of it ran on Windows before the CI did; a file index of 0 is
//! still `no-identity` (fail closed). The Windows branches of the algorithm (the `\\?\` prefix, the planted-link check
//! before a create, the real-path check after it) also run on every system in the tests through the double.
use super::paths::{
    absolute_spelling, assemble, check_syntax, contains_exact, invalid_deny_entry,
    is_forbidden_root, is_system_tree_path, match_deny, refuse, DenyEntry, DenyMatch, Nfc,
    PathRefusal, SyntaxOptions, TreeOptions,
};
use crate::js;
use serde_json::{json, Value};

/// An error of the file system, named by its Node error code (`ENOENT`, `ELOOP`, `ENOTDIR`, ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsError {
    /// The code.
    pub code: String,
}

impl FsError {
    /// An error with this code.
    pub fn new(code: &str) -> Self {
        FsError {
            code: code.to_owned(),
        }
    }
    fn is(&self, code: &str) -> bool {
        self.code == code
    }
}

/// The type of a file as `stat`, `lstat` or a directory entry report it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    /// A regular file.
    File,
    /// A directory.
    Dir,
    /// A symbolic link (only `lstat` and directory entries report one).
    Symlink,
    /// Anything else: a FIFO, a socket, a device.
    Other,
}

/// What the path layer needs of a `stat`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStat {
    /// `st_dev`.
    pub dev: u64,
    /// `st_ino`; 0 where the file system has no stable file id.
    pub ino: u64,
    /// The birth time in nanoseconds since the epoch, where the file system reports one.
    pub birth_ns: Option<i128>,
    /// The type.
    pub kind: FileKind,
    /// `st_nlink`.
    pub nlink: u64,
    /// File size and times from the same observation.
    pub size: u64,
    /// The last modification time in nanoseconds.
    pub mtime_ns: i128,
    /// The last metadata change time, where available.
    pub ctime_ns: Option<i128>,
}

/// One entry of a directory listing (`readdir` with file types, links not followed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    /// The name.
    pub name: String,
    /// The type of the entry itself.
    pub kind: FileKind,
    /// The name is not valid Unicode on disk and was decoded with replacement characters: the entry cannot be reached
    /// by this name, so a scan that needs to look at it is incomplete.
    pub lossy: bool,
}

/// What a listing or a `stat` reports of one entry of an open directory, the entry itself (a link is not followed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntryMeta {
    /// The type.
    pub kind: FileKind,
    /// `st_dev`.
    pub dev: u64,
    /// `st_ino`.
    pub ino: u64,
    /// The size in bytes.
    pub size: u64,
    /// The modification time in whole milliseconds since the epoch (Node's `mtimeMs` of a `bigint` stat).
    pub mtime_ms: i64,
    /// The permission bits (`st_mode & 0o777`); 0 on Windows, which has none.
    pub mode: u32,
    /// Link count from the same observation.
    pub nlink: u64,
    /// The birth time, where available.
    pub birth_ns: Option<i128>,
    /// The modification time in nanoseconds.
    pub mtime_ns: i128,
    /// The metadata change time, where available.
    pub ctime_ns: Option<i128>,
}

#[cfg(unix)]
const fn nanos(seconds: i128, fraction: i128) -> i128 {
    seconds * 1_000_000_000 + fraction
}

fn entry_meta(stamp: FileStat, mode: u32) -> EntryMeta {
    EntryMeta {
        kind: stamp.kind,
        dev: stamp.dev,
        ino: stamp.ino,
        size: stamp.size,
        mtime_ms: i64::try_from(stamp.mtime_ns.div_euclid(1_000_000)).unwrap_or(
            if stamp.mtime_ns < 0 {
                i64::MIN
            } else {
                i64::MAX
            },
        ),
        mode,
        nlink: stamp.nlink,
        birth_ns: stamp.birth_ns,
        mtime_ns: stamp.mtime_ns,
        ctime_ns: stamp.ctime_ns,
    }
}

#[cfg(unix)]
fn raw_kind(mode: rustix::fs::RawMode) -> FileKind {
    use rustix::fs::FileType;
    match FileType::from_raw_mode(mode) {
        FileType::Symlink => FileKind::Symlink,
        FileType::Directory => FileKind::Dir,
        FileType::RegularFile => FileKind::File,
        _ => FileKind::Other,
    }
}

/// The access mode of an open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessMode {
    /// `O_RDONLY`.
    ReadOnly,
    /// `O_WRONLY`.
    WriteOnly,
    /// `O_RDWR`.
    ReadWrite,
}

/// The flags of an open, as the caller of `openVerified` passes them (`O_RDONLY | O_CREAT | ...`), plus the two the path
/// layer adds itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenFlags {
    /// The access mode.
    pub access: AccessMode,
    /// `O_APPEND`.
    pub append: bool,
    /// `O_TRUNC`.
    pub truncate: bool,
    /// `O_CREAT`.
    pub create: bool,
    /// `O_EXCL`.
    pub exclusive: bool,
    /// `O_NOFOLLOW` (set by [`open_verified`]).
    pub nofollow: bool,
    /// `O_NONBLOCK` (set by [`open_verified`] on unix, K2-D6).
    pub nonblock: bool,
    /// The permission bits of a file the open creates (before the umask). Node's default, `0o666`, unless the caller
    /// sets it: a file that must never be readable by others is created that way, not created wider and narrowed after.
    pub mode: u32,
}

impl OpenFlags {
    /// `O_RDONLY`.
    pub const READ: OpenFlags = OpenFlags {
        access: AccessMode::ReadOnly,
        append: false,
        truncate: false,
        create: false,
        exclusive: false,
        nofollow: false,
        nonblock: false,
        mode: 0o666,
    };

    /// Flags with this access mode and nothing else.
    pub fn with(access: AccessMode) -> Self {
        OpenFlags {
            access,
            ..OpenFlags::READ
        }
    }

    /// Whether the open may change the file (`O_WRONLY | O_RDWR | O_APPEND | O_TRUNC | O_CREAT`).
    pub fn writes(&self) -> bool {
        self.access != AccessMode::ReadOnly || self.append || self.truncate || self.create
    }
}

/// The file system of the path layer (R-K-2). Every call the TypeScript code makes to `node:fs` is one method here, so a
/// double can answer or interfere at exactly the point where a race or a failure would.
pub trait PathFs {
    /// An open file.
    type Handle;
    /// An open directory: the parent a leaf is opened in.
    type Dir;
    /// `process.platform` of the system this file system belongs to (`darwin`, `linux`, `win32`, ...). `openVerified`
    /// branches on it, and it is the default platform of [`canonicalise_path`].
    fn platform(&self) -> &'static str;
    /// `os.homedir()`.
    fn home_dir(&self) -> String;
    /// `fs.realpath` (the native `realpath(3)`).
    fn realpath(&self, p: &str) -> Result<String, FsError>;
    /// `fs.stat` (follows links).
    fn stat(&self, p: &str) -> Result<FileStat, FsError>;
    /// `fs.lstat` (does not follow the leaf).
    fn lstat(&self, p: &str) -> Result<FileStat, FsError>;
    /// `fs.readdir(p, { withFileTypes: true })`.
    fn read_dir(&self, p: &str) -> Result<Vec<DirEntry>, FsError>;
    /// Open the directory at `p` itself, never through a link at its last component (`O_RDONLY | O_DIRECTORY |
    /// O_NOFOLLOW`). What is not a directory is an error.
    fn open_dir(&self, p: &str) -> Result<Self::Dir, FsError>;
    /// `fstat` of an open directory.
    fn dir_stat(&self, d: &Self::Dir) -> Result<FileStat, FsError>;
    /// `openat(d, leaf, flags)`: open one entry of an open directory. `leaf` is a single component (`.` is the directory
    /// itself); there is no open by path in this port.
    fn open_at(&self, d: &Self::Dir, leaf: &str, flags: OpenFlags)
        -> Result<Self::Handle, FsError>;
    /// `renameat(d, from, d, to)`: rename one entry of an open directory inside it, replacing `to`.
    fn rename_at(&self, d: &Self::Dir, from: &str, to: &str) -> Result<(), FsError>;
    /// `linkat(d, from, d, to)`: a second name for an entry of an open directory inside it; `EEXIST` when `to` exists.
    fn link_at(&self, d: &Self::Dir, from: &str, to: &str) -> Result<(), FsError>;
    /// `unlinkat(d, leaf)`: remove one entry (not a directory) of an open directory.
    fn unlink_at(&self, d: &Self::Dir, leaf: &str) -> Result<(), FsError>;
    /// Move an entry between held directories without replacing an existing target.
    fn rename_no_replace_at(
        &self,
        _source: &Self::Dir,
        _leaf: &str,
        _destination: &Self::Dir,
        _new_leaf: &str,
    ) -> Result<(), FsError> {
        Err(FsError::new("ENOTSUP"))
    }
    /// Create a private directory below a held parent. Unknown platforms refuse the operation.
    fn mkdir_at(&self, _dir: &Self::Dir, _leaf: &str) -> Result<(), FsError> {
        Err(FsError::new("ENOTSUP"))
    }
    /// The entries of an open directory, read from the descriptor (links not followed).
    fn read_dir_at(&self, d: &Self::Dir) -> Result<Vec<DirEntry>, FsError>;
    /// Read no more than this many entries. Native ports stop reading at the limit.
    fn read_dir_at_bounded(&self, d: &Self::Dir, limit: usize) -> Result<Vec<DirEntry>, FsError> {
        let mut entries = self.read_dir_at(d)?;
        entries.truncate(limit);
        Ok(entries)
    }
    /// `fstatat(d, leaf, AT_SYMLINK_NOFOLLOW)`: one entry of an open directory, itself.
    fn entry_at(&self, d: &Self::Dir, leaf: &str) -> Result<EntryMeta, FsError>;
    /// `fh.stat()`.
    fn fstat(&self, h: &Self::Handle) -> Result<FileStat, FsError>;
    /// The path the system holds for an open file now (Linux `readlink("/proc/self/fd/<fd>")`, Apple `fcntl(F_GETPATH)`),
    /// or `None` where it cannot be read.
    fn fd_path(&self, h: &Self::Handle) -> Option<String>;
    /// The path the system holds for an open directory now (Linux `/proc/self/fd`, Apple `fcntl(F_GETPATH)`), or `None`
    /// where it cannot be read.
    fn dir_path(&self, d: &Self::Dir) -> Option<String>;
    /// Truncate the open file to length 0 (the deferred `O_TRUNC`, K2-D5).
    fn truncate(&self, h: &Self::Handle) -> Result<(), FsError>;
}

/// [`PathFs`] over the real file system: `std::fs` for the reads by path, `rustix` for the opens and the publishing
/// calls relative to a directory descriptor on unix (`openat`, `renameat`, `linkat`, `unlinkat`), and `fs_windows` on
/// Windows. No `unsafe`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealFs;

/// An open directory of [`RealFs`]: the descriptor, and the path it was opened at. Unix works on the descriptor alone;
/// Windows, which has no `openat`, opens below the path while the handle pins the directory.
#[derive(Debug)]
pub struct RealDir {
    file: std::fs::File,
    path: String,
}

impl RealDir {
    /// The path the directory was opened at.
    pub fn path(&self) -> &str {
        &self.path
    }
}

/// A leaf is one component of a directory: no separator, not the parent, not empty. `.` is the directory itself.
fn leaf_ok(leaf: &str) -> Result<(), FsError> {
    let bad = leaf.is_empty()
        || leaf == ".."
        || leaf.contains(['/', '\0'])
        || (cfg!(windows) && leaf.contains(['\\', ':']));
    if bad {
        Err(FsError::new("EINVAL"))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn errno(e: rustix::io::Errno) -> FsError {
    FsError::new(errno_name(e.raw_os_error()))
}

/// The permission bits of a create as `rustix` takes them (named bits, so no cast depends on the platform's `mode_t`).
#[cfg(unix)]
fn mode_of(bits: u32) -> rustix::fs::Mode {
    use rustix::fs::Mode;
    let mut m = Mode::empty();
    for (bit, flag) in [
        (0o400, Mode::RUSR),
        (0o200, Mode::WUSR),
        (0o100, Mode::XUSR),
        (0o040, Mode::RGRP),
        (0o020, Mode::WGRP),
        (0o010, Mode::XGRP),
        (0o004, Mode::ROTH),
        (0o002, Mode::WOTH),
        (0o001, Mode::XOTH),
    ] {
        if bits & bit != 0 {
            m |= flag;
        }
    }
    m
}

/// `dir\leaf` for the calls Windows makes by path below a pinned directory.
#[cfg(not(unix))]
fn below(d: &RealDir, leaf: &str) -> String {
    if leaf == "." {
        d.path.clone()
    } else if d.path.ends_with(['\\', '/']) {
        format!("{}{leaf}", d.path)
    } else {
        format!("{}\\{leaf}", d.path)
    }
}

#[cfg(not(unix))]
fn win_error(e: &std::io::Error) -> FsError {
    if super::fs_windows::is_link_error(e) {
        FsError::new("ELOOP")
    } else {
        error_code(e)
    }
}

#[cfg(not(unix))]
fn win_stat(i: &super::fs_windows::Info) -> FileStat {
    let kind = if i.reparse {
        FileKind::Symlink
    } else if i.directory {
        FileKind::Dir
    } else if i.disk {
        FileKind::File
    } else {
        FileKind::Other
    };
    FileStat {
        dev: i.volume,
        ino: i.index,
        birth_ns: i.birth_ns,
        kind,
        nlink: i.links,
        size: i.size,
        mtime_ns: i.mtime_ns,
        ctime_ns: None,
    }
}

/// The Node error code of an I/O error.
pub fn error_code(e: &std::io::Error) -> FsError {
    #[cfg(unix)]
    if let Some(n) = e.raw_os_error() {
        return FsError::new(errno_name(n));
    }
    use std::io::ErrorKind as K;
    FsError::new(match e.kind() {
        K::NotFound => "ENOENT",
        K::PermissionDenied => "EPERM",
        K::AlreadyExists => "EEXIST",
        K::NotADirectory => "ENOTDIR",
        K::IsADirectory => "EISDIR",
        K::InvalidFilename => "ENAMETOOLONG",
        K::InvalidData => "EILSEQ",
        _ => "EIO",
    })
}

#[cfg(unix)]
fn errno_name(n: i32) -> &'static str {
    const NAMES: &[(i32, &str)] = &[
        (libc::ENOENT, "ENOENT"),
        (libc::ELOOP, "ELOOP"),
        (libc::ENOTDIR, "ENOTDIR"),
        (libc::EACCES, "EACCES"),
        (libc::EPERM, "EPERM"),
        (libc::EEXIST, "EEXIST"),
        (libc::EMLINK, "EMLINK"),
        (libc::EISDIR, "EISDIR"),
        (libc::ENAMETOOLONG, "ENAMETOOLONG"),
        (libc::ENXIO, "ENXIO"),
        (libc::EINVAL, "EINVAL"),
        (libc::EBADF, "EBADF"),
        (libc::EBUSY, "EBUSY"),
        (libc::ETXTBSY, "ETXTBSY"),
        (libc::EROFS, "EROFS"),
        (libc::ENOSPC, "ENOSPC"),
        (libc::EIO, "EIO"),
        (libc::EAGAIN, "EAGAIN"),
        (libc::EINTR, "EINTR"),
        (libc::EMFILE, "EMFILE"),
        (libc::ENFILE, "ENFILE"),
        (libc::ENODEV, "ENODEV"),
        (libc::EOPNOTSUPP, "EOPNOTSUPP"),
        (libc::EFBIG, "EFBIG"),
        (libc::EOVERFLOW, "EOVERFLOW"),
        (libc::EILSEQ, "EILSEQ"),
        (libc::ESTALE, "ESTALE"),
        (libc::ENOSYS, "ENOSYS"),
        (libc::EXDEV, "EXDEV"),
        (libc::ENOTSUP, "ENOTSUP"),
        (libc::ENOTEMPTY, "ENOTEMPTY"),
    ];
    NAMES
        .iter()
        .find(|(k, _)| *k == n)
        .map_or("UNKNOWN", |(_, v)| v)
}

fn utf8(p: std::path::PathBuf) -> Result<String, FsError> {
    p.into_os_string()
        .into_string()
        .map_err(|_| FsError::new("EILSEQ"))
}

/// The stat of the path layer from `std`'s metadata (unix; Windows reads its identities in `fs_windows`, because `std`
/// has no file id there).
#[cfg(unix)]
fn stat_of(m: &std::fs::Metadata) -> FileStat {
    use std::os::unix::fs::MetadataExt;
    let t = m.file_type();
    let kind = if t.is_symlink() {
        FileKind::Symlink
    } else if t.is_dir() {
        FileKind::Dir
    } else if t.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    // Node's `birthtimeNs`: a birth time before the epoch, or none, is not used (`birthtimeNs > 0n`).
    let birth_ns = m
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| i128::try_from(d.as_nanos()).unwrap_or(i128::MAX));
    FileStat {
        dev: m.dev(),
        ino: m.ino(),
        birth_ns,
        kind,
        nlink: m.nlink(),
        size: m.size(),
        mtime_ns: nanos(m.mtime().into(), m.mtime_nsec().into()),
        ctime_ns: Some(nanos(m.ctime().into(), m.ctime_nsec().into())),
    }
}

impl RealFs {
    fn read_dir_bounded(p: &str, limit: usize) -> Result<Vec<DirEntry>, FsError> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(p)
            .map_err(|e| error_code(&e))?
            .take(limit)
        {
            let e = e.map_err(|e| error_code(&e))?;
            let t = e.file_type().map_err(|e| error_code(&e))?;
            let kind = if t.is_symlink() {
                FileKind::Symlink
            } else if t.is_dir() {
                FileKind::Dir
            } else if t.is_file() {
                FileKind::File
            } else {
                FileKind::Other
            };
            // Node decodes a name that is not UTF-8 with replacement characters; so does this, and says so.
            let raw = e.file_name();
            out.push(DirEntry {
                name: raw.to_string_lossy().into_owned(),
                kind,
                lossy: raw.to_str().is_none(),
            });
        }
        Ok(out)
    }
}

impl PathFs for RealFs {
    type Handle = std::fs::File;
    type Dir = RealDir;

    fn platform(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "freebsd") {
            "freebsd"
        } else {
            "unknown"
        }
    }

    fn home_dir(&self) -> String {
        // `os.homedir()`: `HOME` (`USERPROFILE` on Windows), else the password database, which `std` consults.
        std::env::home_dir()
            .and_then(|p| p.into_os_string().into_string().ok())
            .unwrap_or_default()
    }

    fn realpath(&self, p: &str) -> Result<String, FsError> {
        std::fs::canonicalize(p)
            .map_err(|e| error_code(&e))
            .and_then(utf8)
    }

    fn stat(&self, p: &str) -> Result<FileStat, FsError> {
        #[cfg(unix)]
        {
            std::fs::metadata(p)
                .map(|m| stat_of(&m))
                .map_err(|e| error_code(&e))
        }
        #[cfg(not(unix))]
        {
            super::fs_windows::stat(p)
                .map(|i| win_stat(&i))
                .map_err(|e| win_error(&e))
        }
    }

    fn lstat(&self, p: &str) -> Result<FileStat, FsError> {
        #[cfg(unix)]
        {
            std::fs::symlink_metadata(p)
                .map(|m| stat_of(&m))
                .map_err(|e| error_code(&e))
        }
        #[cfg(not(unix))]
        {
            super::fs_windows::lstat(p)
                .map(|i| win_stat(&i))
                .map_err(|e| win_error(&e))
        }
    }

    fn read_dir(&self, p: &str) -> Result<Vec<DirEntry>, FsError> {
        RealFs::read_dir_bounded(p, usize::MAX)
    }

    fn open_dir(&self, p: &str) -> Result<RealDir, FsError> {
        #[cfg(unix)]
        let file = {
            use rustix::fs::{Mode, OFlags};
            // The directory itself: a link at the last component is an error, not a directory to open through.
            let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            std::fs::File::from(rustix::fs::open(p, flags, Mode::empty()).map_err(errno)?)
        };
        #[cfg(not(unix))]
        let file = super::fs_windows::open_dir(p).map_err(|e| win_error(&e))?;
        Ok(RealDir {
            file,
            path: p.to_owned(),
        })
    }

    fn dir_stat(&self, d: &RealDir) -> Result<FileStat, FsError> {
        self.fstat(&d.file)
    }

    fn open_at(&self, d: &RealDir, leaf: &str, flags: OpenFlags) -> Result<std::fs::File, FsError> {
        leaf_ok(leaf)?;
        #[cfg(unix)]
        {
            use rustix::fs::OFlags;
            let mut bits = match flags.access {
                AccessMode::ReadOnly => OFlags::RDONLY,
                AccessMode::WriteOnly => OFlags::WRONLY,
                AccessMode::ReadWrite => OFlags::RDWR,
            } | OFlags::CLOEXEC;
            for (on, bit) in [
                (flags.append, OFlags::APPEND),
                (flags.truncate, OFlags::TRUNC),
                (flags.create, OFlags::CREATE),
                (flags.exclusive, OFlags::EXCL),
                (flags.nofollow, OFlags::NOFOLLOW),
                (flags.nonblock, OFlags::NONBLOCK),
            ] {
                if on {
                    bits |= bit;
                }
            }
            rustix::fs::openat(&d.file, leaf, bits, mode_of(flags.mode))
                .map(std::fs::File::from)
                .map_err(errno)
        }
        #[cfg(not(unix))]
        {
            // Never following the leaf and never creating over something are not options on Windows: an open that asks
            // for anything else (a follow, a create that is not exclusive, a truncate at the open) is refused.
            if !flags.nofollow || flags.truncate || (flags.create && !flags.exclusive) {
                return Err(FsError::new("EINVAL"));
            }
            let how = super::fs_windows::LeafOpen {
                read: flags.access != AccessMode::WriteOnly,
                write: flags.access != AccessMode::ReadOnly,
                append: flags.append,
                create_new: flags.create,
            };
            super::fs_windows::open_leaf(below(d, leaf), how).map_err(|e| win_error(&e))
        }
    }

    fn rename_at(&self, d: &RealDir, from: &str, to: &str) -> Result<(), FsError> {
        leaf_ok(from)?;
        leaf_ok(to)?;
        #[cfg(unix)]
        {
            rustix::fs::renameat(&d.file, from, &d.file, to).map_err(errno)
        }
        #[cfg(not(unix))]
        {
            std::fs::rename(below(d, from), below(d, to)).map_err(|e| error_code(&e))
        }
    }

    fn link_at(&self, d: &RealDir, from: &str, to: &str) -> Result<(), FsError> {
        leaf_ok(from)?;
        leaf_ok(to)?;
        #[cfg(unix)]
        {
            rustix::fs::linkat(&d.file, from, &d.file, to, rustix::fs::AtFlags::empty())
                .map_err(errno)
        }
        #[cfg(not(unix))]
        {
            std::fs::hard_link(below(d, from), below(d, to)).map_err(|e| error_code(&e))
        }
    }

    fn unlink_at(&self, d: &RealDir, leaf: &str) -> Result<(), FsError> {
        leaf_ok(leaf)?;
        #[cfg(unix)]
        {
            rustix::fs::unlinkat(&d.file, leaf, rustix::fs::AtFlags::empty()).map_err(errno)
        }
        #[cfg(not(unix))]
        {
            std::fs::remove_file(below(d, leaf)).map_err(|e| error_code(&e))
        }
    }

    #[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
    fn rename_no_replace_at(
        &self,
        source: &RealDir,
        leaf: &str,
        destination: &RealDir,
        new_leaf: &str,
    ) -> Result<(), FsError> {
        leaf_ok(leaf)?;
        leaf_ok(new_leaf)?;
        rustix::fs::renameat_with(
            &source.file,
            leaf,
            &destination.file,
            new_leaf,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(errno)
    }

    #[cfg(unix)]
    fn mkdir_at(&self, dir: &RealDir, leaf: &str) -> Result<(), FsError> {
        leaf_ok(leaf)?;
        rustix::fs::mkdirat(&dir.file, leaf, mode_of(0o700)).map_err(errno)
    }

    fn read_dir_at(&self, d: &RealDir) -> Result<Vec<DirEntry>, FsError> {
        self.read_dir_at_bounded(d, usize::MAX)
    }

    fn read_dir_at_bounded(&self, d: &RealDir, limit: usize) -> Result<Vec<DirEntry>, FsError> {
        #[cfg(unix)]
        {
            use rustix::fs::FileType;
            let mut out = Vec::new();
            for e in rustix::fs::Dir::read_from(&d.file).map_err(errno)? {
                if out.len() == limit {
                    break;
                }
                let e = e.map_err(errno)?;
                let raw = e.file_name().to_bytes();
                if raw == b"." || raw == b".." {
                    continue;
                }
                let kind = match e.file_type() {
                    FileType::Symlink => FileKind::Symlink,
                    FileType::Directory => FileKind::Dir,
                    FileType::RegularFile => FileKind::File,
                    // A file system that does not report the type in the listing: ask the entry.
                    FileType::Unknown => match std::str::from_utf8(raw) {
                        Ok(name) => self.entry_at(d, name)?.kind,
                        Err(_) => FileKind::Other,
                    },
                    _ => FileKind::Other,
                };
                out.push(DirEntry {
                    name: String::from_utf8_lossy(raw).into_owned(),
                    kind,
                    lossy: std::str::from_utf8(raw).is_err(),
                });
            }
            Ok(out)
        }
        #[cfg(not(unix))]
        {
            // The handle pins the directory; the listing is read by its path.
            RealFs::read_dir_bounded(&d.path, limit)
        }
    }

    fn entry_at(&self, d: &RealDir, leaf: &str) -> Result<EntryMeta, FsError> {
        leaf_ok(leaf)?;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            use rustix::fs::{AtFlags, StatxFlags};
            let flags = StatxFlags::BASIC_STATS | StatxFlags::BTIME;
            match rustix::fs::statx(&d.file, leaf, AtFlags::SYMLINK_NOFOLLOW, flags) {
                Ok(st) => {
                    let supplied = StatxFlags::from_bits_truncate(st.stx_mask);
                    let required = StatxFlags::MODE
                        | StatxFlags::TYPE
                        | StatxFlags::INO
                        | StatxFlags::NLINK
                        | StatxFlags::SIZE
                        | StatxFlags::MTIME
                        | StatxFlags::CTIME;
                    if !supplied.contains(required) {
                        return Err(FsError::new("EIO"));
                    }
                    let stamp = FileStat {
                        dev: rustix::fs::makedev(st.stx_dev_major, st.stx_dev_minor),
                        ino: st.stx_ino,
                        kind: raw_kind(st.stx_mode.into()),
                        nlink: st.stx_nlink.into(),
                        size: st.stx_size,
                        birth_ns: supplied.contains(StatxFlags::BTIME).then(|| {
                            nanos(st.stx_btime.tv_sec.into(), st.stx_btime.tv_nsec.into())
                        }),
                        mtime_ns: nanos(st.stx_mtime.tv_sec.into(), st.stx_mtime.tv_nsec.into()),
                        ctime_ns: Some(nanos(
                            st.stx_ctime.tv_sec.into(),
                            st.stx_ctime.tv_nsec.into(),
                        )),
                    };
                    return Ok(entry_meta(stamp, u32::from(st.stx_mode) & 0o777));
                }
                Err(
                    rustix::io::Errno::NOSYS
                    | rustix::io::Errno::OPNOTSUPP
                    | rustix::io::Errno::PERM,
                ) => {}
                Err(e) => return Err(errno(e)),
            }
        }
        #[cfg(unix)]
        {
            use rustix::fs::AtFlags;
            let st = rustix::fs::statat(&d.file, leaf, AtFlags::SYMLINK_NOFOLLOW).map_err(errno)?;
            // The platforms use different integer types for the fields in stat.
            #[cfg(target_vendor = "apple")]
            let birth_ns = Some(nanos(st.st_birthtime.into(), st.st_birthtime_nsec.into()));
            #[cfg(not(target_vendor = "apple"))]
            let birth_ns = None;
            #[allow(clippy::unnecessary_cast, clippy::cast_lossless)]
            let stamp = FileStat {
                dev: st.st_dev as u64,
                ino: st.st_ino as u64,
                kind: raw_kind(st.st_mode as rustix::fs::RawMode),
                nlink: st.st_nlink as u64,
                size: st.st_size as u64,
                birth_ns,
                mtime_ns: nanos(st.st_mtime.into(), st.st_mtime_nsec.into()),
                ctime_ns: Some(nanos(st.st_ctime.into(), st.st_ctime_nsec.into())),
            };
            #[allow(clippy::unnecessary_cast, clippy::cast_lossless)]
            Ok(entry_meta(stamp, (st.st_mode as u32) & 0o777))
        }
        #[cfg(not(unix))]
        {
            let i = super::fs_windows::lstat(below(d, leaf)).map_err(|e| win_error(&e))?;
            Ok(entry_meta(win_stat(&i), 0))
        }
    }

    fn fstat(&self, h: &std::fs::File) -> Result<FileStat, FsError> {
        #[cfg(unix)]
        {
            h.metadata()
                .map(|m| stat_of(&m))
                .map_err(|e| error_code(&e))
        }
        #[cfg(not(unix))]
        {
            super::fs_windows::info(h)
                .map(|i| win_stat(&i))
                .map_err(|e| win_error(&e))
        }
    }

    fn fd_path(&self, h: &std::fs::File) -> Option<String> {
        #[cfg(target_vendor = "apple")]
        {
            rustix::fs::getpath(h)
                .ok()
                .and_then(|p| p.into_string().ok())
        }
        #[cfg(all(unix, not(target_vendor = "apple")))]
        {
            use std::os::fd::AsRawFd;
            let link = format!("/proc/self/fd/{}", h.as_raw_fd());
            std::fs::read_link(link).ok().and_then(|p| utf8(p).ok())
        }
        #[cfg(not(unix))]
        {
            let _ = h;
            None
        }
    }

    fn dir_path(&self, d: &RealDir) -> Option<String> {
        #[cfg(target_vendor = "apple")]
        {
            rustix::fs::getpath(&d.file)
                .ok()
                .and_then(|p| p.into_string().ok())
        }
        #[cfg(all(unix, not(target_vendor = "apple")))]
        {
            self.fd_path(&d.file)
        }
        #[cfg(not(unix))]
        {
            // Windows: the handle pins the directory against renames (see `fs_windows`); its path is not read here.
            let _ = d;
            None
        }
    }

    fn truncate(&self, h: &std::fs::File) -> Result<(), FsError> {
        h.set_len(0).map_err(|e| error_code(&e))
    }
}

// --- path.posix / path.win32 ------------------------------------------------------------------------------------------------
// Node's `dirname`, `basename` and `join` as the TypeScript code calls them. Every separator is ASCII, so byte offsets
// are character boundaries.

fn is_sep(b: u8, windows: bool) -> bool {
    b == b'/' || (windows && b == b'\\')
}

/// `path.posix.dirname` / `path.win32.dirname`.
pub(crate) fn dirname(p: &str, windows: bool) -> String {
    let b = p.as_bytes();
    let len = b.len();
    if len == 0 {
        return ".".to_owned();
    }
    if !windows {
        let has_root = b[0] == b'/';
        let mut end = None;
        let mut matched_slash = true;
        for i in (1..len).rev() {
            if b[i] == b'/' {
                if !matched_slash {
                    end = Some(i);
                    break;
                }
            } else {
                matched_slash = false;
            }
        }
        return match end {
            None => (if has_root { "/" } else { "." }).to_owned(),
            Some(1) if has_root => "//".to_owned(),
            Some(e) => p[..e].to_owned(),
        };
    }
    let mut root_end: Option<usize> = None;
    let mut offset = 0;
    if len == 1 {
        return if is_sep(b[0], true) { p } else { "." }.to_owned();
    }
    if is_sep(b[0], true) {
        root_end = Some(1);
        offset = 1;
        if is_sep(b[1], true) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(b[j], true) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && is_sep(b[j], true) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(b[j], true) {
                        j += 1;
                    }
                    if j == len {
                        return p.to_owned();
                    }
                    if j != last {
                        root_end = Some(j + 1);
                        offset = j + 1;
                    }
                }
            }
        }
    } else if b[0].is_ascii_alphabetic() && b[1] == b':' {
        let r = if len > 2 && is_sep(b[2], true) { 3 } else { 2 };
        root_end = Some(r);
        offset = r;
    }
    let mut end = None;
    let mut matched_slash = true;
    for i in (offset..len).rev() {
        if is_sep(b[i], true) {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match (end, root_end) {
        (Some(e), _) | (None, Some(e)) => p[..e].to_owned(),
        (None, None) => ".".to_owned(),
    }
}

/// `path.posix.basename` / `path.win32.basename` (no extension argument).
pub(crate) fn basename(p: &str, windows: bool) -> String {
    let b = p.as_bytes();
    let mut start = 0;
    if windows && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        start = 2;
    }
    let floor = start;
    let mut end = None;
    let mut matched_slash = true;
    for i in (floor..b.len()).rev() {
        if is_sep(b[i], windows) {
            if !matched_slash {
                start = i + 1;
                break;
            }
        } else if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
    }
    match end {
        None => String::new(),
        Some(e) => p[start..e].to_owned(),
    }
}

/// `path.join(dir, name)` for a directory the layer resolved (absolute, normalised) and a directory entry's name.
fn join_entry(dir: &str, name: &str, windows: bool) -> String {
    let sep = if windows { '\\' } else { '/' };
    if dir.ends_with(sep) || (windows && dir.ends_with('/')) {
        format!("{dir}{name}")
    } else {
        format!("{dir}{sep}{name}")
    }
}

/// Windows `realpath.native` may return `\\?\C:\…` or `\\?\UNC\…`; strip it and upper-case the drive.
pub(crate) fn normalise_native(p: String, windows: bool) -> String {
    if !windows {
        return p;
    }
    let mut r = if let Some(rest) = p.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = p.strip_prefix("\\\\?\\") {
        rest.to_owned()
    } else {
        p
    };
    let b = r.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_lowercase() && b[1] == b':' {
        r.replace_range(..1, &r[..1].to_ascii_uppercase());
    }
    r
}

/// `specialTree`: the trees reachable only through `sys.*`, by platform.
fn special_tree(p: &str, platform: &str) -> Option<&'static str> {
    let under = |t: &str| {
        p.strip_prefix(t)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    match platform {
        "linux" => {
            for (t, name) in [("/proc", "proc"), ("/sys", "sys"), ("/dev", "dev")] {
                if under(t) {
                    return Some(name);
                }
            }
            p.starts_with("/run/user/").then_some("run/user")
        }
        "darwin" => under("/dev").then_some("dev"),
        _ => None,
    }
}

// --- identities ---------------------------------------------------------------------------------------------------------------

/// POSIX `{dev, ino}` (Windows: volume serial number and file id) as decimal text. `birth` (nanoseconds) is present when
/// the file system reports one: an inode number is recycled the moment a file is deleted, so a swap-in could otherwise
/// reuse the checked file's identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    /// The device.
    pub dev: String,
    /// The inode.
    pub ino: String,
    /// The birth time in nanoseconds.
    pub birth: Option<String>,
}

impl Identity {
    /// `identityOf`.
    pub fn of(st: &FileStat) -> Self {
        Identity {
            dev: st.dev.to_string(),
            ino: st.ino.to_string(),
            birth: st.birth_ns.filter(|b| *b > 0).map(|b| b.to_string()),
        }
    }

    /// The TypeScript object.
    pub fn json(&self) -> Value {
        match &self.birth {
            Some(b) => json!({ "dev": self.dev, "ino": self.ino, "birth": b }),
            None => json!({ "dev": self.dev, "ino": self.ino }),
        }
    }
}

/// `sameIdentity`: device and inode equal, and the birth times too where both sides have one.
pub fn same_identity(a: &Identity, b: &Identity) -> bool {
    a.dev == b.dev
        && a.ino == b.ino
        && match (&a.birth, &b.birth) {
            (Some(x), Some(y)) => x == y,
            _ => true,
        }
}

// --- canonicalisePath ---------------------------------------------------------------------------------------------------------

/// A root (`PathRoot`): a directory the caller may reach, with the identity stamped when it was confirmed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathRoot {
    /// The id reported as `rootId`.
    pub id: String,
    /// The path as configured.
    pub path: String,
    /// The identity stamped when the root was confirmed; a mismatch suspends the root (`root-identity-changed`).
    pub identity: Option<Identity>,
}

/// `Access`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// `read`.
    Read,
    /// `write`.
    Write,
}

impl Access {
    /// The TypeScript value.
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Write => "write",
        }
    }
}

/// `CanonicalPath`: the real target of a path argument. [`open_verified`] and [`stat_verified`] trust what it says, so
/// only [`canonicalise_path`] makes one: the fields are private, the accessors read them.
///
/// ```compile_fail,E0616
/// use plur1bus_core::policy::fs_paths::CanonicalPath;
/// fn widen(c: &mut CanonicalPath) {
///     c.canonical = String::from("/");
/// }
/// ```
/// ```
/// use plur1bus_core::policy::fs_paths::CanonicalPath;
/// fn read(c: &CanonicalPath) -> &str {
///     c.canonical()
/// }
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalPath {
    canonical: String,
    root_id: Option<String>,
    exists: bool,
    identity: Identity,
    target_stamp: FileStat,
    parent_identity: Identity,
    hard_linked: bool,
    deny_guarded: bool,
    system_tree: bool,
    access: Access,
}

impl CanonicalPath {
    /// Real path of the target (or of its deepest existing ancestor plus the not-yet-existing tail).
    pub fn canonical(&self) -> &str {
        &self.canonical
    }
    /// The most specific root containing the target, or `None` (only when `require_root` is false, or a hard-linked
    /// write).
    pub fn root_id(&self) -> Option<&str> {
        self.root_id.as_deref()
    }
    /// The target exists.
    pub fn exists(&self) -> bool {
        self.exists
    }
    /// Identity of the target when it exists, else of its nearest existing ancestor.
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    /// Identity of the directory that holds (or would hold) the leaf.
    pub fn parent_identity(&self) -> &Identity {
        &self.parent_identity
    }
    /// A regular file with a link count above 1.
    pub fn hard_linked(&self) -> bool {
        self.hard_linked
    }
    /// A deny list was in force: [`open_verified`] then also refuses a read of a file that gained a hard link.
    pub fn deny_guarded(&self) -> bool {
        self.deny_guarded
    }
    /// The real target is a home, a drive root, `/`, `/Users`, `C:\Users` or lies in a system tree.
    pub fn system_tree(&self) -> bool {
        self.system_tree
    }
    /// The access it was canonicalised for.
    pub fn access(&self) -> Access {
        self.access
    }
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        json!({ "ok": true, "canonical": self.canonical, "rootId": self.root_id, "exists": self.exists,
            "identity": self.identity.json(), "parentIdentity": self.parent_identity.json(), "hardLinked": self.hard_linked,
            "denyGuarded": self.deny_guarded, "systemTree": self.system_tree, "access": self.access.as_str() })
    }
}

/// `CanonicaliseOptions`.
#[derive(Clone, Copy, Debug)]
pub struct CanonicaliseOptions<'a> {
    /// Defaults to the file system's platform. Only the syntactic rules and the special trees honour another value.
    pub platform: Option<&'a str>,
    /// Apply the Windows name rules even on POSIX. Defaults to `platform == "win32"`.
    pub windows_rules: Option<bool>,
    /// Base for relative input; it must itself be inside a root.
    pub cwd: Option<&'a str>,
    /// The roots.
    pub roots: &'a [PathRoot],
    /// The deny list as the caller holds it (validated by `invalidDenyEntry` first, so it stays a JSON value).
    pub deny: Option<&'a Value>,
    /// Defaults to read.
    pub access: Access,
    /// Default true: a path outside every root is refused (`outside-root`).
    pub require_root: bool,
    /// UNC paths are refused unless true.
    pub allow_unc: bool,
    /// Overrides `os.homedir()` for the "home is never a root" rule.
    pub home: Option<&'a str>,
    /// Entries visited per deny-list scan (default 20 000 for the `path` entries, 100 000 for the `name` scan).
    pub scan_cap: Option<i64>,
}

impl<'a> CanonicaliseOptions<'a> {
    /// The defaults of the TypeScript function for these roots.
    pub fn new(roots: &'a [PathRoot]) -> Self {
        CanonicaliseOptions {
            platform: None,
            windows_rules: None,
            cwd: None,
            roots,
            deny: None,
            access: Access::Read,
            require_root: true,
            allow_unc: false,
            home: None,
            scan_cap: None,
        }
    }
}

const DENY_SCAN_CAP: i64 = 20_000;
const NAME_SCAN_CAP: i64 = 100_000;

struct Resolved {
    real: String,
    exists: bool,
    identity: Identity,
    target_stamp: FileStat,
    parent_identity: Identity,
    hard_linked: bool,
}

/// One attempt of `resolveReal` at `cur`: the body of the TypeScript `try`. `Err` is what that block throws.
fn resolve_at<F: PathFs>(
    fs: &F,
    cur: &str,
    tail: &[String],
    windows: bool,
) -> Result<Result<Resolved, PathRefusal>, FsError> {
    let sep = if windows { "\\" } else { "/" };
    let real = normalise_native(fs.realpath(cur)?, windows);
    // The identity is taken from the entry at the real path itself, never through a link: a real path has no link in
    // it, so a link there now was planted between the two calls, and following it would bind the identity of a file
    // somewhere else to this path (review of K2, V-1).
    let st = fs.lstat(&real)?;
    if st.kind == FileKind::Symlink {
        return Ok(Err(refuse(
            "link-swap",
            "the path changed while it was resolved",
        )));
    }
    if !tail.is_empty() && st.kind != FileKind::Dir {
        return Ok(Err(refuse(
            "not-directory",
            format!("{} is not a directory", js::json_stringify(cur)),
        )));
    }
    let id = Identity::of(&st);
    if id.ino == "0" {
        return Ok(Err(refuse(
            "no-identity",
            "the file system reports no stable file id (fail closed)",
        )));
    }
    let mut parent_identity = id.clone(); // a missing leaf: the nearest existing ancestor; a filesystem root: itself
    if tail.is_empty() {
        let parent_real = dirname(&real, windows);
        if parent_real != real {
            let pst = fs.lstat(&parent_real)?;
            if pst.kind == FileKind::Symlink {
                return Ok(Err(refuse(
                    "link-swap",
                    "the path changed while it was resolved",
                )));
            }
            parent_identity = Identity::of(&pst);
        }
    }
    let full = if tail.is_empty() {
        real
    } else {
        let glue = if real.ends_with(sep) { "" } else { sep };
        format!("{real}{glue}{}", tail.join(sep))
    };
    Ok(Ok(Resolved {
        real: full,
        exists: tail.is_empty(),
        identity: id,
        target_stamp: st,
        parent_identity,
        hard_linked: tail.is_empty() && st.kind == FileKind::File && st.nlink > 1,
    }))
}

/// `resolveReal`: real-target resolution. Walks up to the deepest existing ancestor; refuses dangling links and
/// non-directories.
fn resolve_real<F: PathFs>(fs: &F, abs: &str, windows: bool) -> Result<Resolved, PathRefusal> {
    let mut tail: Vec<String> = Vec::new();
    let mut cur = abs.to_owned();
    loop {
        match resolve_at(fs, &cur, &tail, windows) {
            Ok(answer) => return answer,
            Err(e) if e.is("ELOOP") => return Err(refuse("link-loop", "symbolic link loop")),
            Err(e) if e.is("ENOTDIR") => {
                return Err(refuse(
                    "not-directory",
                    "a path component is not a directory",
                ))
            }
            Err(e) if !e.is("ENOENT") => {
                return Err(refuse(
                    "unresolvable",
                    format!("cannot resolve the path ({})", e.code),
                ))
            }
            Err(_) => {}
        }
        // ENOENT: either genuinely missing, or a dangling link (realpath fails on both). A dangling link would let a later
        // create follow it to wherever it points, so it is refused rather than treated as "missing".
        if fs.lstat(&cur).is_ok_and(|l| l.kind == FileKind::Symlink) {
            return Err(refuse(
                "dangling-link",
                format!(
                    "{} is a link whose target does not exist",
                    js::json_stringify(&cur)
                ),
            ));
        }
        let parent = dirname(&cur, windows);
        if parent == cur {
            return Err(refuse("unresolvable", "no existing ancestor"));
        }
        tail.insert(0, basename(&cur, windows));
        cur = parent;
    }
}

struct ResolvedRoot {
    id: String,
    real: String,
}

struct Ctx<'a> {
    windows: bool,
    platform: &'a str,
    allow_unc: bool,
    home: &'a str,
}

/// `resolveRoots`: every root resolved to its real path; a bad root refuses the whole call.
fn resolve_roots<F: PathFs>(
    fs: &F,
    roots: &[PathRoot],
    o: &Ctx<'_>,
) -> Result<(Vec<ResolvedRoot>, Option<String>), PathRefusal> {
    // `os.homedir()` may be a link; roots are compared by real path, so the home is compared by its real path as well.
    let mut home_real = None;
    if !o.home.is_empty() && absolute_spelling(o.home) {
        if let Ok(h) = resolve_real(fs, o.home, o.windows) {
            if h.exists {
                home_real = Some(h.real);
            }
        }
    }
    let mut out = Vec::new();
    for r in roots {
        let q = js::json_stringify(&r.id);
        let syn = check_syntax(
            &Value::String(r.path.clone()),
            SyntaxOptions {
                platform: o.platform,
                windows_rules: Some(o.windows),
                allow_unc: o.allow_unc,
            },
        )
        .map_err(|s| refuse("bad-root", format!("root {q}: {}", s.reason)))?;
        if !syn.absolute {
            return Err(refuse("bad-root", format!("root {q} is not absolute")));
        }
        let res = resolve_real(fs, &assemble(&syn), o.windows)
            .map_err(|s| refuse("bad-root", format!("root {q}: {}", s.reason)))?;
        if !res.exists {
            return Err(refuse("bad-root", format!("root {q} does not exist")));
        }
        if r.identity
            .as_ref()
            .is_some_and(|want| !same_identity(want, &res.identity))
        {
            return Err(refuse(
                "root-identity-changed",
                format!("root {q} was moved or replaced"),
            ));
        }
        if is_forbidden_root(&res.real, o.windows, o.home)
            || home_real
                .as_deref()
                .is_some_and(|h| is_forbidden_root(&res.real, o.windows, h))
        {
            return Err(refuse(
                "bad-root",
                format!("root {q} is a home, drive or system tree"),
            ));
        }
        out.push(ResolvedRoot {
            id: r.id.clone(),
            real: res.real,
        });
    }
    Ok((out, home_real))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scan {
    Alias,
    Incomplete,
    Clear,
}

fn denied(m: DenyMatch) -> bool {
    // A match the fold could not decide counts as a match (fail closed).
    !matches!(m, DenyMatch::Miss)
}

struct NameScan<'a, F: PathFs> {
    fs: &'a F,
    key: (u64, u64),
    names: &'a [DenyEntry],
    nfc: &'a dyn Nfc,
    budget: i64,
    overflow: bool,
    windows: bool,
}

impl<F: PathFs> NameScan<'_, F> {
    fn visit(&mut self, dir: &str, protected_below: bool) -> bool {
        // Only a directory that is really gone may be skipped; one that cannot be read could hold the alias (fail closed).
        let ents = match self.fs.read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                if !e.is("ENOENT") {
                    self.overflow = true;
                }
                return false;
            }
        };
        for d in ents {
            // `budget-- <= 0`; the cap comes from the caller, so the count saturates instead of wrapping (RA-12).
            let left = self.budget;
            self.budget = left.saturating_sub(1);
            if left <= 0 {
                self.overflow = true;
                return false;
            }
            let full = join_entry(dir, &d.name, self.windows);
            let hit = protected_below || denied(match_deny(&d.name, self.names, self.nfc));
            // A name that is not Unicode cannot be looked at through this port: a directory could hold the alias, a
            // protected file could be it. Not looking is an incomplete scan, not a clean one (review of K2, V-2).
            if d.lossy && (d.kind == FileKind::Dir || (hit && d.kind == FileKind::File)) {
                self.overflow = true;
                return false;
            }
            if d.kind == FileKind::Dir {
                if self.visit(&full, hit) {
                    return true;
                }
                if self.overflow {
                    return false;
                }
            } else if hit && d.kind == FileKind::File {
                match self.fs.stat(&full) {
                    Ok(st) if (st.dev, st.ino) == self.key => return true,
                    Ok(_) => {}
                    Err(e) if e.is("ENOENT") => {}
                    Err(_) => {
                        self.overflow = true;
                        return false;
                    }
                }
            }
        }
        false
    }
}

/// `nameEntryAlias`: hard links versus deny-list `name` entries. A `name` entry protects by spelling, which a second
/// directory entry for the same inode escapes, so every root is walked once (links not followed) and the identity of every
/// regular file called like an entry, or below a directory called like one, is compared with the target's. A walk past
/// the cap, or one that meets a directory it cannot read, is incomplete and refuses (fail closed).
fn name_entry_alias<F: PathFs>(
    fs: &F,
    key: (u64, u64),
    roots: &[ResolvedRoot],
    names: &[DenyEntry],
    cap: i64,
    nfc: &dyn Nfc,
) -> Scan {
    let mut scan = NameScan {
        fs,
        key,
        names,
        nfc,
        budget: cap,
        overflow: false,
        windows: fs.platform() == "win32",
    };
    let mut seen: Vec<&str> = Vec::new();
    for r in roots {
        if seen.contains(&r.real.as_str()) {
            continue;
        }
        seen.push(&r.real);
        // The spelling check matches a name against EVERY segment of the real path, so a root below `.ssh/` has all its
        // files protected.
        let below = denied(match_deny(&r.real, names, nfc));
        if scan.visit(&r.real, below) {
            return Scan::Alias;
        }
        if scan.overflow {
            return Scan::Incomplete;
        }
    }
    Scan::Clear
}

/// `resolveDenyPaths`: keep both spellings of a protected path, including a link's real target.
fn resolve_deny_paths<F: PathFs>(
    fs: &F,
    deny: &[DenyEntry],
    windows: bool,
    platform: &str,
) -> (Vec<DenyEntry>, Vec<String>) {
    let mut entries = deny.to_vec();
    let mut existing = Vec::new();
    for e in deny {
        let DenyEntry::Path(p) = e else { continue };
        let Ok(syn) = check_syntax(
            &Value::String(p.clone()),
            SyntaxOptions {
                platform,
                windows_rules: Some(windows),
                allow_unc: true,
            },
        ) else {
            continue; // matched by spelling only
        };
        if !syn.absolute {
            continue;
        }
        let Ok(res) = resolve_real(fs, &assemble(&syn), windows) else {
            continue;
        };
        if &res.real != p {
            entries.push(DenyEntry::Path(res.real.clone()));
        }
        if res.exists {
            existing.push(res.real);
        }
    }
    (entries, existing)
}

/// `pathEntryAlias`: only a multiply linked target can alias a different protected directory entry. Any error is an
/// incomplete walk (fail closed).
fn path_entry_alias<F: PathFs>(fs: &F, key: (u64, u64), paths: &[String], cap: i64) -> Scan {
    fn visit<F: PathFs>(
        fs: &F,
        dir: &str,
        key: (u64, u64),
        remaining: &mut i64,
        windows: bool,
    ) -> Result<Scan, FsError> {
        for child in fs.read_dir(dir)? {
            // `remaining-- <= 0`; the cap comes from the caller, so the count saturates instead of wrapping (RA-12).
            let left = *remaining;
            *remaining = left.saturating_sub(1);
            if left <= 0 {
                return Ok(Scan::Incomplete);
            }
            let full = join_entry(dir, &child.name, windows);
            if child.lossy && matches!(child.kind, FileKind::Dir | FileKind::File) {
                return Ok(Scan::Incomplete);
            }
            if child.kind == FileKind::Dir {
                let r = visit(fs, &full, key, remaining, windows)?;
                if r != Scan::Clear {
                    return Ok(r);
                }
            } else if child.kind == FileKind::File {
                let st = fs.stat(&full)?;
                if (st.dev, st.ino) == key {
                    return Ok(Scan::Alias);
                }
            }
        }
        Ok(Scan::Clear)
    }
    let windows = fs.platform() == "win32";
    let mut remaining = cap;
    let mut walk = || -> Result<Scan, FsError> {
        for entry in paths {
            let st = fs.stat(entry)?;
            if st.kind == FileKind::File && (st.dev, st.ino) == key {
                return Ok(Scan::Alias);
            }
            if st.kind == FileKind::Dir {
                let r = visit(fs, entry, key, &mut remaining, windows)?;
                if r != Scan::Clear {
                    return Ok(r);
                }
            }
        }
        Ok(Scan::Clear)
    };
    // A partial directory walk cannot rule out a protected alias.
    walk().unwrap_or(Scan::Incomplete)
}

/// `canonicalisePath`: the policy's single entry point for a path argument. Fails closed: anything not positively inside a
/// root (unless `require_root` is false), on a deny-list entry, or not resolvable to a real target is a typed refusal.
pub fn canonicalise_path<F: PathFs>(
    fs: &F,
    input: &str,
    o: &CanonicaliseOptions<'_>,
    nfc: &dyn Nfc,
) -> Result<CanonicalPath, PathRefusal> {
    let platform = o.platform.unwrap_or_else(|| fs.platform());
    let windows = o.windows_rules.unwrap_or(platform == "win32");
    let home_owned;
    let home = match o.home {
        Some(h) => h,
        None => {
            home_owned = fs.home_dir();
            home_owned.as_str()
        }
    };
    let sep = if windows { "\\" } else { "/" };
    if let Some(bad) = invalid_deny_entry(o.deny) {
        return Err(refuse(
            "deny-listed",
            format!("invalid deny-list entry (fail closed): {bad}"),
        ));
    }
    let given: Vec<DenyEntry> = o
        .deny
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(DenyEntry::of).collect())
        .unwrap_or_default();
    let (deny, existing_paths) = resolve_deny_paths(fs, &given, windows, platform);
    let name_entries: Vec<DenyEntry> = given
        .iter()
        .filter(|e| matches!(e, DenyEntry::Name(_)))
        .cloned()
        .collect();

    let syn = check_syntax(
        &Value::String(input.to_owned()),
        SyntaxOptions {
            platform,
            windows_rules: Some(windows),
            allow_unc: o.allow_unc,
        },
    )?;

    let ctx = Ctx {
        windows,
        platform,
        allow_unc: o.allow_unc,
        home,
    };
    let (roots, home_real) = resolve_roots(fs, o.roots, &ctx)?;

    let abs = if syn.absolute {
        assemble(&syn)
    } else {
        let Some(cwd) = o.cwd else {
            return Err(refuse("relative-no-cwd", "relative path without a cwd"));
        };
        let inner = CanonicaliseOptions {
            cwd: None,
            access: Access::Read,
            require_root: true,
            ..*o
        };
        let base = canonicalise_path(fs, cwd, &inner, nfc)
            .map_err(|b| refuse(b.reason, format!("cwd: {}", b.detail)))?;
        format!("{}{sep}{}", base.canonical, syn.segments.join(sep))
    };

    // Deny list on the spelled path first (a link's own name may be the giveaway), then again on the real target.
    if denied(match_deny(&abs, &deny, nfc)) {
        return Err(refuse("deny-listed", "matches the credential deny-list"));
    }
    if let Some(t) = special_tree(&abs, platform) {
        return Err(refuse(
            "special-tree",
            format!("/{t} is reachable only through sys.*"),
        ));
    }

    let res = resolve_real(fs, &abs, windows)?;

    if denied(match_deny(&res.real, &deny, nfc)) {
        return Err(refuse(
            "deny-listed",
            "the real target matches the credential deny-list",
        ));
    }
    if res.exists && res.hard_linked {
        // A hard link carries no trace of the file it aliases except its identity. The identity strings are decimal
        // renderings of the same numbers, so the numbers are compared.
        let key = (
            res.identity.dev.parse().unwrap_or(u64::MAX),
            res.identity.ino.parse().unwrap_or(u64::MAX),
        );
        match path_entry_alias(
            fs,
            key,
            &existing_paths,
            o.scan_cap.unwrap_or(DENY_SCAN_CAP),
        ) {
            Scan::Alias => {
                return Err(refuse(
                    "deny-listed",
                    "the target is a hard link to a deny-listed file",
                ))
            }
            Scan::Incomplete => {
                return Err(refuse(
                    "deny-listed",
                    "hard-linked target while the deny-list scan was incomplete (fail closed)",
                ))
            }
            Scan::Clear => {}
        }
        if !name_entries.is_empty() {
            let cap = o.scan_cap.unwrap_or(NAME_SCAN_CAP);
            match name_entry_alias(fs, key, &roots, &name_entries, cap, nfc) {
                Scan::Alias => {
                    return Err(refuse(
                        "deny-listed",
                        "the target is a hard link to a file protected by a deny-list name entry",
                    ))
                }
                Scan::Incomplete => {
                    return Err(refuse(
                        "deny-listed",
                        "hard-linked target while the name-entry scan was incomplete (fail closed)",
                    ))
                }
                Scan::Clear => {}
            }
        }
    }
    if let Some(t) = special_tree(&res.real, platform) {
        return Err(refuse(
            "special-tree",
            format!("the real target is under /{t}"),
        ));
    }
    if res.real.starts_with("\\\\") && !o.allow_unc {
        return Err(refuse("unc-not-allowed", "the real target is a UNC path"));
    }
    // Windows names are re-checked on the real target: a junction may lead into a path whose names the rules refuse.
    check_syntax(
        &Value::String(res.real.clone()),
        SyntaxOptions {
            platform,
            windows_rules: Some(windows),
            allow_unc: true,
        },
    )
    .map_err(|r| refuse(r.reason, format!("real target: {}", r.detail)))?;

    let mut root_id: Option<String> = None;
    let mut best = 0;
    for r in &roots {
        if contains_exact(&r.real, &res.real, sep) && (root_id.is_none() || r.real.len() > best) {
            root_id = Some(r.id.clone());
            best = r.real.len();
        }
    }
    // A write to a regular file with link count > 1 may alias a file elsewhere: treated as outside the roots.
    if o.access == Access::Write && res.hard_linked {
        if o.require_root {
            return Err(refuse(
                "hard-link",
                "write to a hard-linked file (link count > 1)",
            ));
        }
        root_id = None;
    }
    if root_id.is_none() && o.require_root {
        return Err(refuse(
            "outside-root",
            "the real target is outside every root",
        ));
    }
    let homes: Vec<String> = match home_real {
        None => vec![home.to_owned()],
        Some(h) => vec![home.to_owned(), h],
    };
    let system_tree = is_system_tree_path(
        &res.real,
        TreeOptions {
            windows,
            homes: &homes,
        },
        nfc,
    );
    Ok(CanonicalPath {
        canonical: res.real,
        root_id,
        exists: res.exists,
        identity: res.identity,
        target_stamp: res.target_stamp,
        parent_identity: res.parent_identity,
        hard_linked: res.hard_linked,
        deny_guarded: !deny.is_empty(),
        system_tree,
        access: o.access,
    })
}

// --- openVerified -------------------------------------------------------------------------------------------------------------

/// The parent check of `openVerified`, before and after the open: the parent still resolves to itself and is still the
/// directory that was checked. Any file-system error in it is the `catch` of the TypeScript code.
fn check_parent<F: PathFs>(
    fs: &F,
    c: &CanonicalPath,
    parent: &str,
    windows: bool,
) -> Option<PathRefusal> {
    let body = || -> Result<Option<PathRefusal>, FsError> {
        let real = normalise_native(fs.realpath(parent)?, windows);
        if real != parent {
            return Ok(Some(refuse(
                "identity-changed",
                "the parent directory path now resolves elsewhere",
            )));
        }
        let pst = Identity::of(&fs.stat(parent)?);
        // A missing leaf: `identity` is the nearest existing ancestor.
        let want = if c.exists {
            &c.parent_identity
        } else {
            &c.identity
        };
        if !c.exists && dirname(&c.canonical, windows) != c.canonical && !same_identity(&pst, want)
        {
            return Ok(Some(refuse(
                "identity-changed",
                "the parent directory was replaced",
            )));
        }
        if c.exists && !same_identity(&pst, want) {
            return Ok(Some(refuse(
                "identity-changed",
                "the parent directory was replaced",
            )));
        }
        Ok(None)
    };
    match body() {
        Ok(r) => r,
        Err(_) if c.exists => Some(refuse("identity-changed", "the parent directory is gone")),
        Err(_) => Some(refuse("not-found", "the target's parent does not exist")),
    }
}

/// The checks after the open, on the open descriptor. `Err` is what the TypeScript `try` block throws.
fn verify_open<F: PathFs>(
    fs: &F,
    c: &CanonicalPath,
    h: &F::Handle,
    write: bool,
    created: bool,
    parent: &str,
    windows: bool,
) -> Result<Option<PathRefusal>, FsError> {
    let st = fs.fstat(h)?;
    let id = Identity::of(&st);
    if c.exists && !same_identity(&id, &c.identity) {
        return Ok(Some(refuse(
            "identity-changed",
            "the opened file is not the one that was checked",
        )));
    }
    let checked = c.target_stamp;
    if c.exists
        && matches!(st.kind, FileKind::File | FileKind::Dir)
        && (st.kind != checked.kind
            || (st.kind == FileKind::File
                && (id.birth.is_none() || c.identity.birth.is_none())
                && (st.size != checked.size
                    || st.mtime_ns != checked.mtime_ns
                    || st.ctime_ns != checked.ctime_ns)))
    {
        return Ok(Some(refuse(
            "identity-changed",
            "the opened file metadata differs from the entry that was checked",
        )));
    }
    if (write || c.deny_guarded) && st.kind == FileKind::File && st.nlink > 1 && !c.hard_linked {
        return Ok(Some(refuse(
            "hard-link",
            "the file gained a hard link since it was checked",
        )));
    }
    // K2-D6: a FIFO, socket or device is not a file the path layer hands out (the open did not block: O_NONBLOCK).
    if !matches!(st.kind, FileKind::File | FileKind::Dir) {
        return Ok(Some(refuse(
            "unsupported-open",
            "the target is neither a regular file nor a directory",
        )));
    }
    if let Some(r) = check_parent(fs, c, parent, windows) {
        return Ok(Some(r));
    }
    if windows && !c.exists {
        // A link planted after the lstat before the open is caught here at the latest: the path must still resolve to itself.
        let real = normalise_native(fs.realpath(&c.canonical)?, true);
        if real != c.canonical {
            return Ok(Some(refuse(
                "link-swap",
                "the created leaf resolves to a different path",
            )));
        }
    }
    // Linux checks the path of every opened descriptor. Elsewhere a file that existed is held to its identity above, and
    // a file this open created is held to its path wherever the system can name it (Apple: `F_GETPATH`): it must be
    // the leaf at the checked path, before the caller writes a byte to it.
    if fs.platform() == "linux" {
        if let Some(now) = fs.fd_path(h) {
            if now.strip_suffix(" (deleted)").unwrap_or(&now) != c.canonical {
                return Ok(Some(refuse(
                    "identity-changed",
                    "the opened file lives at a different path than the one checked",
                )));
            }
        }
    } else if created {
        if let Some(now) = fs.fd_path(h) {
            if !same_dir_path(&normalise_native(now, windows), &c.canonical, fs.platform()) {
                return Ok(Some(refuse(
                    "identity-changed",
                    "the opened file lives at a different path than the one checked",
                )));
            }
        }
    }
    // K2-D7: the created file must be the leaf at the checked path, not a file made through a parent that was swapped for
    // a link and back between the pre-check and the open.
    if created {
        let at = fs.lstat(&c.canonical)?;
        if at.kind != FileKind::File || (at.dev, at.ino) != (st.dev, st.ino) {
            return Ok(Some(refuse(
                "identity-changed",
                "the created file is not the file at the checked path",
            )));
        }
    }
    Ok(None)
}

/// Whether `now`, the path the system holds for an open directory (or for a file the open just created), is `parent` (a
/// real path). macOS answers with the firmlinked form (`/Users/x`) where `realpath(3)` keeps the data volume's
/// (`/System/Volumes/Data/Users/x`); both name the same entry. A directory Linux reports as `(deleted)` is not at its
/// path any more.
fn same_dir_path(now: &str, parent: &str, platform: &str) -> bool {
    now == parent
        || (platform == "darwin"
            && now.starts_with('/')
            && parent.strip_prefix("/System/Volumes/Data") == Some(now))
}

/// The checked parent directory, open (R-K-11): the directory at `parent` itself, never through a link at its last
/// component, and only when the descriptor is the directory that was checked (device, inode, birth time). Everything the
/// open of the leaf does afterwards happens in this directory, whatever its name points to by then.
fn open_parent<F: PathFs>(
    fs: &F,
    c: &CanonicalPath,
    parent: &str,
    windows: bool,
) -> Result<F::Dir, PathRefusal> {
    let gone = || {
        if c.exists {
            refuse("identity-changed", "the parent directory is gone")
        } else {
            refuse("not-found", "the target's parent does not exist")
        }
    };
    let dir = match fs.open_dir(parent) {
        Ok(d) => d,
        // The last component became a link, or stopped being a directory, since the check a moment ago.
        Err(e) if e.is("ELOOP") || e.is("EMLINK") || e.is("ENOTDIR") => {
            return Err(refuse(
                "identity-changed",
                "the parent directory path now resolves elsewhere",
            ))
        }
        Err(_) => return Err(gone()),
    };
    let st = fs.dir_stat(&dir).map_err(|_| gone())?;
    // A missing leaf: `identity` is the nearest existing ancestor (the same rule as `check_parent`).
    let want = if c.exists {
        &c.parent_identity
    } else {
        &c.identity
    };
    let compared = c.exists || dirname(&c.canonical, windows) != c.canonical;
    if st.kind != FileKind::Dir || (compared && !same_identity(&Identity::of(&st), want)) {
        return Err(refuse(
            "identity-changed",
            "the parent directory was replaced",
        ));
    }
    // The identity compared above was read by path when the target was resolved; a component above the parent swapped
    // for a link between that `realpath` and that `lstat` binds it to a directory elsewhere, and this descriptor, opened
    // through the same link, would then match it (review of K2, V-1). Where the system can say where the open directory
    // is, it must be at the checked path itself; where it cannot (Windows, Linux without /proc), the checks by path stay
    // the guard.
    if let Some(now) = fs.dir_path(&dir) {
        if !same_dir_path(&normalise_native(now, windows), parent, fs.platform()) {
            return Err(refuse(
                "identity-changed",
                "the parent directory path now resolves elsewhere",
            ));
        }
    }
    Ok(dir)
}

/// The entry a canonicalised path names, read without following it and without opening it: the checked parent
/// directory is opened (as in [`open_verified`]) and the leaf is looked at relative to that descriptor; it must be the
/// entry that was checked, including its type and metadata from the same observation. For a caller that reports
/// type, size and time of a path it may not be
/// able to read.
pub fn stat_verified<F: PathFs>(fs: &F, c: &CanonicalPath) -> Result<EntryMeta, PathRefusal> {
    if !c.exists {
        return Err(refuse("not-found", "the target does not exist"));
    }
    let windows = fs.platform() == "win32";
    let parent = dirname(&c.canonical, windows);
    if let Some(r) = check_parent(fs, c, &parent, windows) {
        return Err(r);
    }
    let dir = open_parent(fs, c, &parent, windows)?;
    let name = basename(&c.canonical, windows);
    let leaf = if name.is_empty() { "." } else { name.as_str() };
    let m = fs
        .entry_at(&dir, leaf)
        .map_err(|_| refuse("identity-changed", "the target or its parent vanished"))?;
    let expected = c.target_stamp;
    let birth = m.birth_ns.filter(|birth| *birth > 0);
    let expected_birth = expected.birth_ns.filter(|birth| *birth > 0);
    if m.kind != expected.kind
        || m.dev != expected.dev
        || m.ino != expected.ino
        || birth != expected_birth
        || (m.kind == FileKind::File && birth.is_none())
        || m.nlink != expected.nlink
        || m.size != expected.size
        || m.mtime_ns != expected.mtime_ns
        || m.ctime_ns != expected.ctime_ns
    {
        return Err(refuse(
            "identity-changed",
            "the entry is not the one that was checked",
        ));
    }
    Ok(m)
}

/// Move one verified regular file on the same filesystem, with atomic no-replace semantics.
pub fn move_verified<F: PathFs>(
    fs: &F,
    source: &CanonicalPath,
    target: &CanonicalPath,
) -> Result<(), PathRefusal> {
    if target.exists() {
        return Err(refuse("exists", "the target already exists"));
    }
    if source.access() != Access::Write || target.access() != Access::Write {
        return Err(refuse("unsupported-open", "canonicalised for read"));
    }
    let changed = || {
        refuse(
            "identity-changed",
            "the source changed while it was checked",
        )
    };
    // Keep the source alive and the source directory bound through publication.
    let (from, handle) = open_verified_in(fs, source, OpenFlags::READ)?;
    let handle_stat = fs.fstat(&handle).map_err(|_| changed())?;
    if handle_stat.kind != FileKind::File || handle_stat.nlink != 1 {
        return Err(refuse(
            "unsupported-open",
            "the source is not a singly linked regular file",
        ));
    }
    let windows = fs.platform() == "win32";
    let parent = dirname(target.canonical(), windows);
    if let Some(refusal) = check_parent(fs, target, &parent, windows) {
        return Err(refusal);
    }
    let to = open_parent(fs, target, &parent, windows)?;
    let leaf = basename(source.canonical(), windows);
    let new_leaf = basename(target.canonical(), windows);
    let entry = fs.entry_at(&from, &leaf).map_err(|_| changed())?;
    if entry.kind != FileKind::File
        || entry.nlink != 1
        || (entry.dev, entry.ino) != (handle_stat.dev, handle_stat.ino)
    {
        return Err(changed());
    }
    fs.rename_no_replace_at(&from, &leaf, &to, &new_leaf)
        .map_err(|e| match e.code.as_str() {
            "EEXIST" => refuse("exists", "the target already exists"),
            "EXDEV" => refuse("cross-filesystem", "the filesystems differ"),
            "ENOSYS" | "ENOTSUP" | "EOPNOTSUPP" | "EINVAL" => refuse(
                "unsupported-open",
                "atomic no-replace rename is unavailable",
            ),
            _ => refuse("io-error", "the file could not be moved"),
        })
}

/// Create one private directory within its verified parent. No existing leaf is replaced.
pub fn mkdir_verified<F: PathFs>(fs: &F, target: &CanonicalPath) -> Result<(), PathRefusal> {
    if target.exists() {
        return Err(refuse("exists", "the target already exists"));
    }
    if target.access() != Access::Write {
        return Err(refuse("unsupported-open", "canonicalised for read"));
    }
    let windows = fs.platform() == "win32";
    let parent = dirname(target.canonical(), windows);
    if let Some(refused) = check_parent(fs, target, &parent, windows) {
        return Err(refused);
    }
    let directory = open_parent(fs, target, &parent, windows)?;
    let leaf = basename(target.canonical(), windows);
    fs.mkdir_at(&directory, &leaf)
        .map_err(|e| match e.code.as_str() {
            "EEXIST" => refuse("exists", "the target already exists"),
            "ENOTSUP" => refuse(
                "unsupported-open",
                "descriptor-relative directory creation is unavailable",
            ),
            _ => refuse("io-error", "the directory could not be created"),
        })
}

/// `openVerified`: open a canonicalised path and verify, after the open, that it is still the file that was checked. The
/// leaf is opened without following links (`O_NOFOLLOW`); a target that did not exist is opened only to create it, when
/// the caller passed `O_CREAT`, and then with `O_EXCL`, so a link or file planted since the check is an error rather
/// than a redirect (without `O_CREAT` it is `not-found`, before anything is opened).
/// `O_TRUNC` takes effect only after the checks (K2-D5). The leaf is opened relative to the descriptor of the checked
/// parent directory (R-K-11), so a parent swapped between the pre-check and the open cannot redirect it.
pub fn open_verified<F: PathFs>(
    fs: &F,
    c: &CanonicalPath,
    flags: OpenFlags,
) -> Result<F::Handle, PathRefusal> {
    open_verified_in(fs, c, flags).map(|(_, h)| h)
}

/// [`open_verified`], handing back the open parent directory as well: the directory that was checked and in which the
/// leaf was opened. A caller that goes on to publish the file (rename it over a sibling, link it, remove it) does that
/// through this descriptor ([`PathFs::rename_at`], [`PathFs::link_at`], [`PathFs::unlink_at`]) and not by path.
pub fn open_verified_in<F: PathFs>(
    fs: &F,
    c: &CanonicalPath,
    flags: OpenFlags,
) -> Result<(F::Dir, F::Handle), PathRefusal> {
    let write = flags.writes();
    if write && c.access != Access::Write {
        return Err(refuse(
            "unsupported-open",
            "canonicalised for read, opened for write",
        ));
    }
    // A target that did not exist when it was checked has no identity an opened file could be compared with: whatever
    // is at the path now was not checked. Only an open that creates it (exclusively, below) may go on; any other open
    // of it is `not-found` before anything is opened. TypeScript refuses it the same way since P4D-43 (vectors
    // `late-hard-link-without-create`, `late-file-read-without-create`).
    if !c.exists && !flags.create {
        return Err(refuse("not-found", "the target does not exist"));
    }
    let windows = fs.platform() == "win32";
    let mut f = flags;
    f.nofollow = true;
    // Only an explicit O_CREAT creates, and then exclusively.
    if !c.exists && flags.create {
        f.exclusive = true;
    }
    if c.exists && f.create {
        f.create = false;
    }
    let truncate = f.truncate;
    f.truncate = false;
    f.nonblock = !windows;

    let parent = dirname(&c.canonical, windows);
    if let Some(r) = check_parent(fs, c, &parent, windows) {
        return Err(r);
    }
    // Windows has no O_NOFOLLOW, and CREATE_NEW opened through a planted (dangling) symlink creates the file at the link's
    // target, outside the root. So a create there first requires that nothing at all exists at the leaf (a link included).
    if windows && !c.exists && flags.create {
        let planted = match fs.lstat(&c.canonical) {
            Ok(_) => true,
            Err(e) => !e.is("ENOENT"),
        };
        if planted {
            return Err(refuse(
                "identity-changed",
                "the target appeared since it was checked",
            ));
        }
    }

    let dir = open_parent(fs, c, &parent, windows)?;
    // A file-system root has no name in its parent (which is itself): it is opened as the directory.
    let name = basename(&c.canonical, windows);
    let leaf = if name.is_empty() { "." } else { name.as_str() };
    let h = match fs.open_at(&dir, leaf, f) {
        Ok(h) => h,
        Err(e) if e.is("ELOOP") || e.is("EMLINK") => {
            return Err(refuse("link-swap", "the leaf is now a symbolic link"))
        }
        Err(e) if e.is("EEXIST") => {
            return Err(refuse(
                "identity-changed",
                "the target appeared since it was checked",
            ))
        }
        Err(e) if e.is("ENOENT") => {
            return Err(if c.exists {
                refuse("identity-changed", "the target or its parent vanished")
            } else {
                refuse("not-found", "the target does not exist")
            })
        }
        Err(e) => return Err(refuse("unresolvable", format!("open failed ({})", e.code))),
    };
    let created = !c.exists && f.create;
    match verify_open(fs, c, &h, write, created, &parent, windows) {
        Ok(None) => {}
        Ok(Some(r)) => return Err(r),
        Err(_) => return Err(refuse("identity-changed", "post-open verification failed")),
    }
    if truncate {
        fs.truncate(&h)
            .map_err(|e| refuse("unresolvable", format!("open failed ({})", e.code)))?;
    }
    Ok((dir, h))
}

#[cfg(test)]
#[path = "fs_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "fs_vectors.rs"]
mod vectors;
