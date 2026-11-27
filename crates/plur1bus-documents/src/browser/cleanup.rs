//! Retire only profiles created under the trusted private renderer root.
use super::{profile_in_use, BrowserProcess, POLL, PROFILE_CLOSE_GRACE};
use crate::chromium::{Control, Error, Result};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    thread,
    time::Instant,
};

pub(super) type Reporter = Arc<dyn Fn(io::ErrorKind) + Send + Sync>;
const PREFIX: &str = "plur1bus-doc-";
const RANDOM_BYTES: usize = 12;
const RETIRED: &str = ".plur1bus-retired-";

pub(super) struct Profile {
    path: PathBuf,
    child: mpsc::Sender<Option<BrowserProcess>>,
    done: mpsc::Receiver<io::Result<()>>,
}

impl Profile {
    pub(super) fn create(root: &Path, report: Reporter) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix(PREFIX)
            .rand_bytes(RANDOM_BYTES)
            .tempdir_in(root)
            .map_err(|_| Error::BrowserUnavailable)?;
        let path = directory.path().to_owned();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(Error::BrowserUnavailable)?;
        let marker = root.join(format!("{RETIRED}{name}"));
        // Publish an already locked receipt. A different process can claim it
        // only after cleanup exits or this process dies.
        let receipt =
            tempfile::NamedTempFile::new_in(root).map_err(|_| Error::BrowserUnavailable)?;
        receipt
            .as_file()
            .lock()
            .map_err(|_| Error::BrowserUnavailable)?;
        let lease = receipt
            .persist_noclobber(&marker)
            .map_err(|_| Error::BrowserUnavailable)?;
        let root = root.to_owned();
        let (child, finished) = mpsc::channel::<Option<BrowserProcess>>();
        let (reply, done) = mpsc::channel();
        thread::Builder::new()
            .name("chromium-profile".into())
            .spawn(move || {
                retry_retired(&root, &report);
                if let Ok(Some(browser)) = finished.recv() {
                    #[cfg(windows)]
                    let mut browser = browser;
                    #[cfg(windows)]
                    browser.wait_for_relay();
                    drop(browser);
                }
                let path = directory.keep();
                let result = remove_with_retry(&path).and_then(|()| fs::remove_file(marker));
                drop(lease);
                if let Err(error) = &result {
                    report(error.kind());
                }
                let _ = reply.send(result);
            })
            .map_err(|_| Error::BrowserUnavailable)?;
        Ok(Self { path, child, done })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn finish<T>(
        self,
        browser: Option<BrowserProcess>,
        result: Result<T>,
        control: Control<'_>,
    ) -> Result<T> {
        self.child
            .send(browser)
            .map_err(|_| Error::BrowserUnavailable)?;
        loop {
            if matches!(result, Err(Error::Cancelled | Error::Timeout)) {
                return result;
            }
            if let Err(reason) = control.check() {
                return result.and(Err(reason));
            }
            match self.done.recv_timeout(POLL) {
                Ok(Ok(())) => return result,
                Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return result.and(Err(Error::BrowserUnavailable))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
}

pub(super) fn remove_with_retry(path: &Path) -> io::Result<()> {
    let deadline = Instant::now() + PROFILE_CLOSE_GRACE;
    loop {
        match fs::remove_dir_all(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if profile_in_use(&error) && Instant::now() < deadline => {
                thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
            }
            result => return result,
        }
    }
}

fn retry_retired(root: &Path, report: &Reporter) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            report(error.kind());
            return;
        }
    };
    let deadline = Instant::now() + PROFILE_CLOSE_GRACE;
    for entry in entries.flatten() {
        if Instant::now() >= deadline {
            break;
        }
        let name = entry.file_name();
        let Some(profile) = name.to_str().and_then(|s| s.strip_prefix(RETIRED)) else {
            continue;
        };
        let Some(suffix) = profile.strip_prefix(PREFIX) else {
            continue;
        };
        if suffix.len() != RANDOM_BYTES
            || !suffix.bytes().all(|b| b.is_ascii_alphanumeric())
            || !entry.file_type().is_ok_and(|t| t.is_file())
        {
            continue;
        }
        let marker = entry.path();
        let Ok(file) = File::open(&marker) else {
            continue;
        };
        if file.try_lock().is_err() {
            continue;
        }
        let path = root.join(profile);
        let result = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
            Ok(_) => Err(io::ErrorKind::InvalidData.into()),
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                report(error.kind());
                continue;
            }
        }
        if let Err(error) = fs::remove_file(marker) {
            if error.kind() != io::ErrorKind::NotFound {
                report(error.kind());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_start_retires_only_an_unlocked_owned_profile() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let abandoned = "plur1bus-doc-123456abcdef";
        let active = "plur1bus-doc-abcdef123456";
        let other = "plur1bus-doc-111111111111";
        for name in [abandoned, active, other] {
            fs::create_dir(root.path().join(name))?;
        }
        File::create_new(root.path().join(format!("{RETIRED}{abandoned}")))?;
        let lease = File::create_new(root.path().join(format!("{RETIRED}{active}")))?;
        lease.lock()?;
        let (sender, reported) = mpsc::channel();
        let report: Reporter = Arc::new(move |kind| {
            let _ = sender.send(kind);
        });
        let profile = Profile::create(root.path(), report).map_err(|_| io::ErrorKind::Other)?;
        profile
            .finish(
                None,
                Ok(()),
                Control {
                    deadline: Instant::now() + PROFILE_CLOSE_GRACE,
                    cancelled: &|| false,
                },
            )
            .map_err(|_| io::ErrorKind::Other)?;
        assert!(!root.path().join(abandoned).exists());
        assert!(root.path().join(active).is_dir());
        assert!(root.path().join(other).is_dir());
        assert!(reported.try_recv().is_err());
        Ok(())
    }
}
