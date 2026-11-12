//! One atomic replacement primitive for engine-owned state files.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Replace a file through a unique private sibling, file fsync, rename and directory fsync.
///
/// Callers validate their trusted path and secure the directory before writing. New parent
/// directories use mode `0700` on Unix and temporary files use `0600`. Windows retries the
/// transient access/sharing failures for ten seconds, matching the pinned Node atomic writer;
/// Windows has no directory fsync. An error before rename leaves the previous target intact.
/// A directory-fsync error occurs after the replacement has committed.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_before_rename(path, bytes, || Ok(()))
}

fn write_before_rename(
    path: &Path,
    bytes: &[u8],
    before_rename: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let directory = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    if !directory.exists() {
        super::schema_version::before_create(directory)
            .map_err(|_| io::Error::other("store base initialisation failed"))?;
    }
    builder.create(directory)?;
    let (temporary, mut file) = create_temporary(path, directory)?;
    let cleanup = Temporary(temporary);
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    before_rename()?;
    rename_with_retry(&cleanup.0, path)?;
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    Ok(())
}

/// How long a temporary sibling may stay before it counts as left behind (RE-D163). A
/// writer needs milliseconds between creating it and renaming it.
pub(crate) const TEMPORARY_TTL_MS: i64 = 60 * 60 * 1000;

/// Whether `name` is a temporary sibling as this module names it:
/// `.<target name>.<process id>.<nonce, twelve hex digits>.tmp`.
pub(crate) fn is_temporary(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return false;
    };
    let mut parts = rest.rsplitn(3, '.');
    let (Some(nonce), Some(process), Some(target)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    nonce.len() == 12
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !process.is_empty()
        && process.bytes().all(|b| b.is_ascii_digit())
        && !target.is_empty()
}

/// The temporary siblings in `directory` that a writer killed between writing and renaming
/// left behind: regular files of this module's own name pattern whose modification time is
/// more than [`TEMPORARY_TTL_MS`] before `now_ms`. Such a file holds the whole content of
/// its target. A file whose time cannot be read is not listed; a link is not followed.
pub(crate) fn stale_temporaries(directory: &Path, now_ms: i64) -> io::Result<Vec<String>> {
    let mut stale = Vec::new();
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !is_temporary(&name) {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .filter(fs::Metadata::is_file)
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|since| i64::try_from(since.as_millis()).ok());
        if modified.is_some_and(|at| now_ms.saturating_sub(at) > TEMPORARY_TTL_MS) {
            stale.push(name);
        }
    }
    Ok(stale)
}

fn create_temporary(path: &Path, directory: &Path) -> io::Result<(PathBuf, File)> {
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    let counter = NEXT.get_or_init(|| {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_nanos() as u64);
        AtomicU64::new(seed)
    });
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    for _ in 0..100 {
        let nonce = counter.fetch_add(1, Ordering::Relaxed) & 0xffff_ffff_ffff;
        let mut sibling = OsString::from(".");
        sibling.push(name);
        sibling.push(format!(".{}.{nonce:012x}.tmp", std::process::id()));
        let temporary = directory.join(sibling);
        #[allow(unused_mut)] // Unix alone sets the private file mode.
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
}

#[cfg(not(windows))]
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
pub(crate) fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    use std::time::{Duration, Instant};
    let started = Instant::now();
    let mut delay = Duration::from_millis(10);
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && started.elapsed() <= Duration::from_secs(10) =>
            {
                std::thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_millis(200));
            }
            Err(error) => return Err(error),
        }
    }
}

struct Temporary(PathBuf);

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    /// RE-D163: only this module's own temporary names are recognised, and only after an
    /// hour; the bound is exclusive at exactly one hour.
    #[test]
    fn only_own_temporary_names_older_than_an_hour_are_stale() {
        let root = tempfile::tempdir().unwrap();
        let own = ".state.json.4242.0123456789ab.tmp";
        for name in [
            own,
            "state.json.4242.0123456789ab.tmp",
            ".state.json.4242.tmp",
            ".state.json.pid.0123456789ab.tmp",
            ".state.json.4242.0123456789AB.tmp",
            "..4242.0123456789ab.tmp",
            "notes.tmp",
        ] {
            fs::write(root.path().join(name), b"content").unwrap();
            assert_eq!(is_temporary(name), name == own, "{name}");
        }
        fs::create_dir(root.path().join(".dir.json.4242.0123456789ab.tmp")).unwrap();
        // What a real interrupted write leaves is recognised.
        let (left, _file) = create_temporary(&root.path().join("real.json"), root.path()).unwrap();
        let left = left.file_name().unwrap().to_str().unwrap().to_owned();
        assert!(is_temporary(&left), "{left}");
        let written = fs::metadata(root.path().join(own))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(stale_temporaries(root.path(), written + TEMPORARY_TTL_MS)
            .unwrap()
            .is_empty());
        let mut stale =
            stale_temporaries(root.path(), written + TEMPORARY_TTL_MS + 60_000).unwrap();
        stale.sort();
        let mut expected = vec![own.to_owned(), left];
        expected.sort();
        assert_eq!(stale, expected);
    }

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "plur1bus-atomic-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn state_file_store_is_atomic() {
        let directory = Directory::new();
        let path = directory.0.join("state.json");
        fs::write(&path, b"old").unwrap();
        assert!(
            write_before_rename(&path, b"new", || Err(io::ErrorKind::Interrupted.into())).is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn concurrent_writers_have_unique_temporary_files_and_commit_complete_values() {
        let directory = Directory::new();
        let path = directory.0.join("state.json");
        std::thread::scope(|scope| {
            for value in b'a'..=b'h' {
                let path = &path;
                scope.spawn(move || atomic_write(path, &vec![value; 8192]).unwrap());
            }
        });
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 8192);
        assert!(bytes.iter().all(|value| *value == bytes[0]));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_replacement_removes_its_temporary_file() {
        let directory = Directory::new();
        let path = directory.0.join("state.json");
        fs::create_dir(&path).unwrap();
        assert!(atomic_write(&path, b"new").is_err());
        assert!(path.is_dir());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn state_files_and_new_directories_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = Directory::new();
        let path = directory.0.join("new/state.json");
        atomic_write(&path, b"new").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[cfg(windows)]
    #[test]
    fn replacement_retries_while_a_reader_temporarily_prevents_rename() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = Directory::new();
        let path = directory.0.join("state.json");
        fs::write(&path, b"old").unwrap();
        let reader = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                drop(reader);
            });
            atomic_write(&path, b"new").unwrap();
        });
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }
}
