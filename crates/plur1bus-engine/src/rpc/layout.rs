//! Private engine endpoint and identity files, with the shared Harness address rule.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use plur1bus_rpc::process::{self, Incarnation, Liveness};
use serde::Deserialize;

use crate::store::lock::{JobLock, LockBusy, LockGuard};
use crate::store::paths::{assert_trusted_path, secure_dir, secure_file};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NonceOwner {
    nonce: String,
    pid: u32,
    host: String,
    proc_start: Incarnation,
}

#[cfg(unix)]
fn read_nonce(path: &Path) -> Result<String, super::server::ServeError> {
    use super::server::ServeError;
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    const MAX_BYTES: u64 = 4096;
    let parent = path.parent().ok_or(ServeError::Locked)?;
    assert_trusted_path(path).map_err(|_| ServeError::Locked)?;
    plur1bus_rpc::trust::verify_run_dir(parent).map_err(|_| ServeError::Locked)?;
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent)
        .map_err(|_| ServeError::Locked)?;
    let directory_metadata = directory.metadata().map_err(|_| ServeError::Locked)?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let euid = unsafe { libc::geteuid() };
    if !directory_metadata.is_dir()
        || directory_metadata.uid() != euid
        || directory_metadata.mode() & 0o777 != 0o700
    {
        return Err(ServeError::Locked);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| ServeError::Locked)?;
    let metadata = file.metadata().map_err(|_| ServeError::Locked)?;
    // A nonce is process metadata, rather than a bearer credential. Older
    // releases wrote 0644 under umask022; read bits are safe inside private run/.
    // Foreign writers, aliases and unbounded inputs remain untrusted.
    if !metadata.is_file()
        || metadata.uid() != euid
        || metadata.mode() & 0o022 != 0
        || metadata.nlink() != 1
        || metadata.len() > MAX_BYTES
    {
        return Err(ServeError::Locked);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ServeError::Locked)?;
    if bytes.len() > MAX_BYTES as usize {
        return Err(ServeError::Locked);
    }
    String::from_utf8(bytes).map_err(|_| ServeError::Locked)
}

#[cfg(not(unix))]
fn read_nonce(path: &Path) -> Result<String, super::server::ServeError> {
    super::host_client::read_identity_file(path).map_err(|_| super::server::ServeError::Locked)
}

// The job nonce's age is not a process-liveness signal. Only the holder of the
// permanent OS lock may inspect and recover the previous engine's nonce.
fn recover_nonce(run: &Path) -> Result<(), super::server::ServeError> {
    use super::server::ServeError;

    let path = run.join("engine.lock");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let original = read_nonce(&path)?;
    let owner: NonceOwner = serde_json::from_str(&original).map_err(|_| ServeError::Locked)?;
    if owner.pid == 0
        || owner.proc_start.mono < 0
        || owner.proc_start.boot.as_ref().is_some_and(String::is_empty)
        || uuid::Uuid::parse_str(&owner.nonce).is_err()
        || owner.host != process::hostname()?
    {
        return Err(ServeError::Locked);
    }
    let stale = match process::alive(owner.pid) {
        Liveness::Gone => true,
        Liveness::OtherUser => false,
        Liveness::Alive => {
            let current = process::incarnation_of(owner.pid).map_err(|_| ServeError::Locked)?;
            // Node's registry uses a 1000 ms tolerance across its process-start clocks.
            current.mono.abs_diff(owner.proc_start.mono) > 1_000
                || current
                    .boot
                    .as_ref()
                    .zip(owner.proc_start.boot.as_ref())
                    .is_some_and(|(current, recorded)| current != recorded)
        }
    };
    if !stale {
        return Err(ServeError::Locked);
    }
    // Recheck the private bounded file before unlinking; a changed owner stays untouched.
    // The OS lock excludes every other engine start, including recovery attempts.
    if read_nonce(&path).ok().as_deref() != Some(original.as_str()) {
        return Err(ServeError::Locked);
    }
    fs::remove_file(path)?;
    Ok(())
}

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
        recover_nonce(&self.run)?;
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
    use serde_json::{json, Value};

    fn fixture() -> (tempfile::TempDir, EngineLayout) {
        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let layout = EngineLayout::new(root.path(), "test-instance".into()).unwrap();
        (root, layout)
    }

    fn own_nonce() -> Value {
        json!({
            "nonce":uuid::Uuid::new_v4().to_string(),
            "pid":std::process::id(),
            "host":process::hostname().unwrap(),
            "procStart":process::incarnation().unwrap(),
            "acquiredAt":"2026-11-01T00:00:00Z"
        })
    }

    fn write_nonce(layout: &EngineLayout, nonce: &Value, aged: bool) -> Vec<u8> {
        let path = layout.run.join("engine.lock");
        let bytes = serde_json::to_vec(nonce).unwrap();
        fs::write(&path, &bytes).unwrap();
        secure_file(&path).unwrap();
        if aged {
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
                .unwrap();
        }
        bytes
    }

    #[test]
    fn a_live_nonce_identity_is_preserved_even_after_the_hard_ceiling() {
        let (_root, layout) = fixture();
        let bytes = write_nonce(&layout, &own_nonce(), true);
        assert!(matches!(
            layout.acquire(),
            Err(super::super::server::ServeError::Locked)
        ));
        assert_eq!(fs::read(layout.run.join("engine.lock")).unwrap(), bytes);
    }

    #[test]
    fn a_fresh_nonce_with_a_reused_pid_is_recovered_by_its_start_identity() {
        let (_root, layout) = fixture();
        let mut nonce = own_nonce();
        nonce["procStart"]["mono"] = json!(nonce["procStart"]["mono"].as_i64().unwrap() + 100_000);
        let original = write_nonce(&layout, &nonce, false);
        let guard = layout
            .acquire()
            .expect("the prior start identity no longer exists");
        assert_ne!(fs::read(layout.run.join("engine.lock")).unwrap(), original);
        drop(guard);
    }

    #[test]
    fn an_unprovable_nonce_is_preserved_instead_of_reaped_by_age() {
        let (_root, layout) = fixture();
        let mut foreign_host = own_nonce();
        foreign_host["host"] = json!(format!(
            "{}-foreign",
            foreign_host["host"].as_str().unwrap()
        ));
        let mut missing_start = own_nonce();
        missing_start.as_object_mut().unwrap().remove("procStart");
        let mut invalid_pid = own_nonce();
        invalid_pid["pid"] = json!(0);
        for nonce in [
            foreign_host,
            missing_start,
            invalid_pid,
            json!("corrupt stamp"),
        ] {
            let original = write_nonce(&layout, &nonce, true);
            assert!(matches!(
                layout.acquire(),
                Err(super::super::server::ServeError::Locked)
            ));
            assert_eq!(fs::read(layout.run.join("engine.lock")).unwrap(), original);
        }
    }

    #[cfg(unix)]
    #[test]
    fn readable_legacy_live_and_unprovable_nonces_are_preserved_without_chmod() {
        use std::os::unix::fs::PermissionsExt;

        let (_root, layout) = fixture();
        let mut foreign = own_nonce();
        foreign["host"] = json!(format!("{}-foreign", foreign["host"].as_str().unwrap()));
        let mut missing_start = own_nonce();
        missing_start.as_object_mut().unwrap().remove("procStart");
        for nonce in [own_nonce(), foreign, missing_start, json!("corrupt stamp")] {
            let original = write_nonce(&layout, &nonce, true);
            let path = layout.run.join("engine.lock");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(matches!(
                layout.acquire(),
                Err(super::super::server::ServeError::Locked)
            ));
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o644
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_writable_nonce_is_not_recovered_or_chmodded_even_when_its_owner_is_stale() {
        use std::os::unix::fs::PermissionsExt;

        let (_root, layout) = fixture();
        let mut nonce = own_nonce();
        nonce["procStart"]["mono"] = json!(nonce["procStart"]["mono"].as_i64().unwrap() + 100_000);
        for mode in [0o620, 0o602, 0o666] {
            let original = write_nonce(&layout, &nonce, true);
            let path = layout.run.join("engine.lock");
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            assert!(matches!(
                layout.acquire(),
                Err(super::super::server::ServeError::Locked)
            ));
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_readable_legacy_nonce_requires_a_private_run_directory() {
        use std::os::unix::fs::PermissionsExt;

        let (_root, layout) = fixture();
        let mut nonce = own_nonce();
        nonce["procStart"]["mono"] = json!(nonce["procStart"]["mono"].as_i64().unwrap() + 100_000);
        let original = write_nonce(&layout, &nonce, true);
        let path = layout.run.join("engine.lock");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&layout.run, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            layout.acquire(),
            Err(super::super::server::ServeError::Locked)
        ));
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn oversized_and_hardlinked_legacy_nonces_are_never_removed() {
        use std::os::unix::fs::PermissionsExt;

        for oversized in [true, false] {
            let (_root, layout) = fixture();
            let mut nonce = own_nonce();
            nonce["procStart"]["mono"] =
                json!(nonce["procStart"]["mono"].as_i64().unwrap() + 100_000);
            let mut original = write_nonce(&layout, &nonce, true);
            let path = layout.run.join("engine.lock");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            if oversized {
                original.resize(4097, b' ');
                fs::write(&path, &original).unwrap();
            } else {
                fs::hard_link(&path, layout.home.join("other-alias")).unwrap();
            }
            assert!(matches!(
                layout.acquire(),
                Err(super::super::server::ServeError::Locked)
            ));
            assert_eq!(fs::read(path).unwrap(), original);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_nonce_is_never_followed_or_removed() {
        let (_root, layout) = fixture();
        let other = layout.home.join("other-owner");
        let original = serde_json::to_vec(&own_nonce()).unwrap();
        fs::write(&other, &original).unwrap();
        let path = layout.run.join("engine.lock");
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert!(matches!(
            layout.acquire(),
            Err(super::super::server::ServeError::Locked)
        ));
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(other).unwrap(), original);
    }

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
