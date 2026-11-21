//! The Windows half of [`super::fs_paths::RealFs`] (P4-K K10a, ruling R-K-12): file identities, link counts, reparse
//! points and the opens of the path layer, over `std` and `winapi-util` (no `unsafe`).
//!
//! **Nobody built or ran this on Windows before the CI did.** It was written on macOS against the documented behaviour
//! of `CreateFileW` and `GetFileInformationByHandle` and type-checked for `x86_64-pc-windows-msvc`; what it does on a real
//! NTFS volume is proven only by the `cfg(windows)` tests of `fs_tests.rs` in the CI. The file is therefore small, has no
//! dependency on the rest of the crate, and every function in it refuses when it is unsure: an adapter that declines is
//! right, one that opens in doubt is a defect.
//!
//! What each handle is asked, and why:
//! - **Identity.** `dwVolumeSerialNumber` and `nFileIndexHigh/Low` are what Node reports as `dev` and `ino` of a `bigint`
//!   stat on Windows, so an identity stamped by the TypeScript core compares equal here. A file index of 0 stays "no
//!   stable file id" for the path layer (refused). ReFS has 128-bit file ids of which this is the low half; the layer
//!   compares the creation time as well where there is one.
//! - **Reparse points** (symbolic links, junctions, mount points, cloud placeholders) are never followed where unix sets
//!   `O_NOFOLLOW`: the open passes `FILE_FLAG_OPEN_REPARSE_POINT`, which yields the reparse point itself, and the handle
//!   is then refused when its attributes carry `FILE_ATTRIBUTE_REPARSE_POINT`. A name surrogate that is not a link (a
//!   deduplicated or cloud file) is refused with them: fail closed.
//! - **The parent directory** is opened without `FILE_SHARE_DELETE` and held while the leaf is opened by path below it.
//!   Windows has no `openat` in `std`; a directory that is open without delete sharing cannot be renamed or removed, which
//!   is the property the unix `openat` gives (the leaf is opened in the directory that was checked). Whether an ancestor
//!   of a pinned directory can still be renamed depends on the file system; the checks after the open stay in place.
//! - **`\\?\` paths.** `std` turns an absolute path that is too long into its verbatim form by itself; a verbatim path the
//!   resolver returns is normalised by the caller (`normalise_native`).
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;

const FILE_SHARE_READ: u32 = 0x1;
const FILE_SHARE_WRITE: u32 = 0x2;
const FILE_SHARE_DELETE: u32 = 0x4;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_ATTRIBUTE_DIRECTORY: u64 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u64 = 0x400;
/// `ERROR_CANT_RESOLVE_FILENAME`, which Node reports as `ELOOP`; used here for "this is a link and is not followed".
const ERROR_CANT_RESOLVE: i32 = 1921;

/// What one open handle says about its file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Info {
    /// The volume serial number (Node's `dev`).
    pub volume: u64,
    /// The file index (Node's `ino`); 0 where the file system has none.
    pub index: u64,
    /// The number of links.
    pub links: u64,
    /// A directory.
    pub directory: bool,
    /// A reparse point: a symbolic link, a junction or any other name surrogate.
    pub reparse: bool,
    /// A disk file or directory (not a pipe, a console or a device).
    pub disk: bool,
    /// The creation time in nanoseconds since the epoch.
    pub birth_ns: Option<i128>,
    /// The size in bytes.
    pub size: u64,
    /// The last write time in nanoseconds since the epoch.
    pub mtime_ns: i128,
}

/// The identity, link count and type of an open handle (`GetFileInformationByHandle`, `GetFileType`).
pub fn info(f: &File) -> io::Result<Info> {
    let i = winapi_util::file::information(f)?;
    let t = winapi_util::file::typ(f)?;
    let attributes = i.file_attributes();
    let since_epoch = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    };
    let meta = f.metadata().ok();
    let birth_ns = since_epoch(meta.as_ref().map_or_else(
        || Err(io::Error::from(io::ErrorKind::Unsupported)),
        std::fs::Metadata::created,
    ))
    .map(|d| i128::try_from(d.as_nanos()).unwrap_or(i128::MAX));
    let mtime_ns = since_epoch(meta.as_ref().map_or_else(
        || Err(io::Error::from(io::ErrorKind::Unsupported)),
        std::fs::Metadata::modified,
    ))
    .map_or(0, |d| i128::try_from(d.as_nanos()).unwrap_or(i128::MAX));
    Ok(Info {
        volume: i.volume_serial_number(),
        index: i.file_index(),
        links: i.number_of_links(),
        directory: attributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        reparse: attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        disk: t.is_disk(),
        birth_ns,
        size: i.file_size(),
        mtime_ns,
    })
}

/// A handle for attributes only (no read, write or delete access; every sharing mode, so it never blocks anyone).
fn probe(p: &str, follow: bool) -> io::Result<File> {
    let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
    if !follow {
        flags |= FILE_FLAG_OPEN_REPARSE_POINT;
    }
    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(flags)
        .open(p)
}

/// `stat`: the file a path leads to, links followed.
pub fn stat(p: &str) -> io::Result<Info> {
    info(&probe(p, true)?)
}

/// `lstat`: the entry at a path itself; a reparse point is reported as one and not followed.
pub fn lstat(p: &str) -> io::Result<Info> {
    info(&probe(p, false)?)
}

fn link_error() -> io::Error {
    io::Error::from_raw_os_error(ERROR_CANT_RESOLVE)
}

/// Whether `e` is the refusal of [`open_dir`] and [`open_leaf`] for a reparse point.
pub fn is_link_error(e: &io::Error) -> bool {
    e.raw_os_error() == Some(ERROR_CANT_RESOLVE)
}

/// Open the directory at `p` itself and pin it: the handle shares read and write but not delete, so the directory cannot
/// be renamed or removed while the handle lives. A reparse point at `p` (a junction, a directory link) is refused, and so
/// is anything that is not a directory.
pub fn open_dir(p: &str) -> io::Result<File> {
    // Read access (FILE_LIST_DIRECTORY), not attribute access alone: Windows checks sharing modes only between handles
    // that hold read, write or delete access, so a handle for attributes would pin nothing.
    let f = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(p)?;
    let i = info(&f)?;
    if i.reparse {
        return Err(link_error());
    }
    if !i.directory {
        return Err(io::Error::from(io::ErrorKind::NotADirectory));
    }
    Ok(f)
}

/// How [`open_leaf`] opens.
#[derive(Clone, Copy, Debug)]
pub struct LeafOpen {
    /// Read access.
    pub read: bool,
    /// Write access.
    pub write: bool,
    /// Append.
    pub append: bool,
    /// Create the file; fails when anything exists at the path (`CREATE_NEW`).
    pub create_new: bool,
}

/// Open the leaf at `p` without following it: a reparse point at the leaf is opened as itself
/// (`FILE_FLAG_OPEN_REPARSE_POINT`) and then refused. With `create_new` nothing may exist at the leaf, a link included.
/// A create that is not exclusive is not offered: the path layer never asks for one.
pub fn open_leaf(p: &str, how: LeafOpen) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.read(how.read).write(how.write && !how.append);
    if how.append {
        o.append(true);
    }
    if how.create_new {
        // `create_new` needs write or append access in `std`.
        if !how.write && !how.append {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        o.create_new(true);
    }
    // FILE_FLAG_BACKUP_SEMANTICS lets a read-only open of a directory succeed, as `open(2)` does on unix.
    o.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    let f = o.open(p)?;
    if info(&f)?.reparse {
        return Err(link_error());
    }
    Ok(f)
}
