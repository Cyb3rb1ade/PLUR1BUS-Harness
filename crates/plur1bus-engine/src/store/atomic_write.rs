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
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
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
