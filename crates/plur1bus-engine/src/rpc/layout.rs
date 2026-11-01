//! Private engine endpoint and identity files, with the shared Harness address rule.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::store::lock::{JobLock, LockBusy, LockGuard};
use crate::store::paths::{assert_trusted_path, secure_dir, secure_file};

/// Address of a role in a canonical Harness home, identical to module-api/paths.ts.
pub fn unit_address(home: &Path, role: &str) -> String {
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let digest = format!(
            "{:x}",
            Sha256::digest(home.to_string_lossy().to_lowercase().as_bytes())
        );
        format!(r"\\.\pipe\plur1bus-{}-{role}", &digest[..16])
    }
    #[cfg(not(windows))]
    home.join("run")
        .join(format!("{role}.sock"))
        .to_string_lossy()
        .into_owned()
}

/// Files and per-start identity of one engine. The bearer token has no diagnostic formatter.
pub struct EngineLayout {
    /// Absolute normalized Harness home; trusted paths are checked before use.
    pub home: PathBuf,
    /// Private runtime directory.
    pub run: PathBuf,
    /// Local socket or named-pipe address.
    pub address: String,
    /// Engine instance identifier reported in the handshake and pid file.
    pub instance_id: String,
    /// Adoption grace after losing the active lifeline.
    pub grace: Duration,
    token: String,
}

impl EngineLayout {
    /// Validate and create a private home, and generate a fresh OS-random bearer token.
    pub fn new(home: &Path, instance_id: String) -> io::Result<Self> {
        // Match Core path.resolve without canonicalize's Windows verbatim prefix or
        // resolving away a forbidden link. Check the normalized physical path afterward.
        let home = super::platform::absolute_normalized(home);
        secure_dir(&home).map_err(io::Error::other)?;
        let run = home.join("run");
        secure_dir(&run).map_err(io::Error::other)?;
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(io::Error::other)?;
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self {
            address: unit_address(&home, "engine"),
            home,
            run,
            instance_id,
            grace: Duration::from_secs(60),
            token,
        })
    }

    /// Explicit access for the reverse host handshake; never log this value.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Acquire the pid/incarnation-pinned process nonce before probing or changing run files.
    pub(crate) fn acquire(&self) -> Result<RunFiles<'_>, super::server::ServeError> {
        // JobLock deliberately has a hard stale ceiling for bounded jobs. A process can live
        // indefinitely: pin an OS-held lock first so nobody can reap its nonce by aging it.
        // This file is never unlinked, matching the supervisor's permanent lock-inode rule.
        let path = self.run.join("engine.process.lock");
        assert_trusted_path(&path).map_err(io::Error::other)?;
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let process = options.open(&path)?;
        if !process.metadata()?.is_file() {
            return Err(io::Error::other("invalid engine process lock").into());
        }
        process.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => super::server::ServeError::Locked,
            fs::TryLockError::Error(error) => super::server::ServeError::Io(error),
        })?;
        secure_file(&path).map_err(io::Error::other)?;
        let guard = JobLock::acquire(&self.run, "engine", Duration::from_secs(60)).map_err(
            |e| match e {
                LockBusy::Held => super::server::ServeError::Locked,
                LockBusy::Store(e) => super::server::ServeError::Io(io::Error::other(e)),
            },
        )?;
        #[cfg(unix)]
        if fs::symlink_metadata(&self.address).is_ok() {
            assert_trusted_path(Path::new(&self.address)).map_err(io::Error::other)?;
            match std::os::unix::net::UnixStream::connect(&self.address) {
                Ok(_) => return Err(super::server::ServeError::Locked),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                    ) =>
                {
                    fs::remove_file(&self.address)?;
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(RunFiles {
            layout: self,
            _guard: guard,
            _process: process,
            written: false,
        })
    }
}

/// Removes only this start's identity files; the ownership lock outlives cleanup.
pub(crate) struct RunFiles<'a> {
    layout: &'a EngineLayout,
    _guard: LockGuard,
    _process: fs::File,
    written: bool,
}

impl RunFiles<'_> {
    pub(crate) fn publish(&mut self) -> io::Result<()> {
        let token = self.layout.run.join("engine.token");
        let pid = self.layout.run.join("engine.pid");
        for path in [&token, &pid] {
            assert_trusted_path(path).map_err(io::Error::other)?;
        }
        crate::store::atomic_write::atomic_write(&token, self.layout.token.as_bytes())?;
        self.written = true;
        secure_file(&token).map_err(io::Error::other)?;
        crate::store::atomic_write::atomic_write(
            &pid,
            format!("{} {}\n", std::process::id(), self.layout.instance_id).as_bytes(),
        )?;
        secure_file(&pid).map_err(io::Error::other)?;
        Ok(())
    }
}

impl Drop for RunFiles<'_> {
    fn drop(&mut self) {
        if !self.written {
            return;
        }
        let token = self.layout.run.join("engine.token");
        if fs::read_to_string(&token).ok().as_deref() != Some(self.layout.token()) {
            return;
        }
        for path in [token, self.layout.run.join("engine.pid")] {
            let _ = fs::remove_file(path);
        }
        #[cfg(unix)]
        let _ = fs::remove_file(&self.layout.address);
    }
}

#[cfg(test)]
mod tests {
    // These synthetic fixtures have no external input; failures must stop before starting a server.
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    #[test]
    fn home_is_lexically_normalized_before_trust_checks_and_address_derivation() {
        let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = tempfile::tempdir_in(temporary).unwrap();
        let supplied = root.path().join("unused").join("..").join("engine");
        let layout = EngineLayout::new(&supplied, "test-instance".into()).unwrap();
        assert_eq!(layout.home, root.path().join("engine"));
        assert_eq!(
            layout.address,
            unit_address(&root.path().join("engine"), "engine")
        );
        assert!(!root.path().join("unused").exists());
    }
}
