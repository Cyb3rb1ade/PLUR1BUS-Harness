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

const MAX_NONCE_BYTES: u64 = 4096;

fn unsafe_nonce() -> super::server::ServeError {
    io::Error::new(io::ErrorKind::PermissionDenied, "untrusted engine nonce").into()
}

// A nonce is bounded process metadata, not a credential. Keep its trusted raw
// bytes separate from decoding so incomplete content can follow JobLock's age rule.
fn read_nonce(path: &Path) -> Result<Option<Vec<u8>>, super::server::ServeError> {
    use std::io::Read;

    let parent = path.parent().ok_or_else(unsafe_nonce)?;
    assert_trusted_path(path).map_err(|_| unsafe_nonce())?;
    plur1bus_rpc::trust::verify_run_dir(parent).map_err(|_| unsafe_nonce())?;
    #[cfg(unix)]
    let _directory = {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)
            .map_err(|_| unsafe_nonce())?;
        let metadata = directory.metadata().map_err(|_| unsafe_nonce())?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o700
        {
            return Err(unsafe_nonce());
        }
        directory
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    verify_nonce_metadata(&metadata)?;
    #[cfg(windows)]
    verify_nonce_acl(parent, path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        // Hold the name stable while checking the handle and reading its bytes.
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ);
    }
    // Trust was checked independently of readability. A trusted unreadable stamp
    // is not positive live-owner evidence; let the existing lock age policy decide.
    let file = match options.open(path) {
        Ok(file) => file,
        Err(_) => {
            // An open failure must not hide replacement by an unsafe alias.
            assert_trusted_path(path).map_err(|_| unsafe_nonce())?;
            match fs::symlink_metadata(path) {
                Ok(metadata) => verify_nonce_metadata(&metadata)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            #[cfg(windows)]
            verify_nonce_acl(parent, path)?;
            return Ok(None);
        }
    };
    verify_nonce_metadata(&file.metadata().map_err(|_| unsafe_nonce())?)?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        // SAFETY: this POD is populated immediately from the live held file.
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the held handle and writable output remain valid for this query.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0
            || information.nNumberOfLinks != 1
        {
            return Err(unsafe_nonce());
        }
    }
    #[cfg(windows)]
    verify_nonce_acl(parent, path)?;
    let mut bytes = Vec::new();
    if file
        .take(MAX_NONCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Ok(None);
    }
    if bytes.len() > MAX_NONCE_BYTES as usize {
        return Err(unsafe_nonce());
    }
    Ok(Some(bytes))
}

#[cfg(windows)]
fn verify_nonce_acl(parent: &Path, path: &Path) -> Result<(), super::server::ServeError> {
    let user = plur1bus_rpc::win::user_sid().map_err(|_| unsafe_nonce())?;
    for protected in [parent, path] {
        let entries =
            plur1bus_rpc::win::file_dacl_report_strict(protected).map_err(|_| unsafe_nonce())?;
        if entries.iter().any(|entry| {
            entry.allow
                && entry.mask != 0
                && entry.sid != user
                && entry.sid != plur1bus_rpc::acl::SYSTEM_SID
        }) {
            return Err(unsafe_nonce());
        }
    }
    Ok(())
}

fn verify_nonce_metadata(metadata: &fs::Metadata) -> Result<(), super::server::ServeError> {
    if !metadata.is_file() || metadata.len() > MAX_NONCE_BYTES {
        return Err(unsafe_nonce());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Read bits in legacy 0644 stamps are harmless inside private run/.
        // SAFETY: geteuid has no preconditions and cannot fail.
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o022 != 0
            || metadata.nlink() != 1
        {
            return Err(unsafe_nonce());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(unsafe_nonce());
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NonceDecision {
    Live,
    Orphan,
    AgeRule,
}

fn nonce_decision(
    bytes: &[u8],
    local_host: &str,
    current_boot: Option<&str>,
    alive: impl FnOnce(u32) -> Liveness,
    incarnation: impl FnOnce(u32) -> Option<Incarnation>,
) -> NonceDecision {
    let Ok(owner) = serde_json::from_slice::<NonceOwner>(bytes) else {
        return NonceDecision::AgeRule;
    };
    if owner.pid == 0
        || owner.proc_start.mono < 0
        || owner.proc_start.boot.as_ref().is_some_and(String::is_empty)
        || uuid::Uuid::parse_str(&owner.nonce).is_err()
        || owner.host != local_host
    {
        return NonceDecision::AgeRule;
    }
    // A previous boot proves an orphan even when this pid was reused by a
    // different user or cannot be inspected. Check it before any owner-pid probe.
    if current_boot
        .zip(owner.proc_start.boot.as_deref())
        .is_some_and(|(now, then)| now != then)
    {
        return NonceDecision::Orphan;
    }
    match alive(owner.pid) {
        Liveness::Gone | Liveness::OtherUser => NonceDecision::Orphan,
        Liveness::Alive => {
            let Some(current) = incarnation(owner.pid).filter(|start| start.mono >= 0) else {
                return NonceDecision::AgeRule;
            };
            // Node's registry tolerates 1000 ms across process-start clocks.
            if current.mono.abs_diff(owner.proc_start.mono) > 1_000
                || current
                    .boot
                    .as_ref()
                    .zip(owner.proc_start.boot.as_ref())
                    .is_some_and(|(now, then)| now != then)
            {
                NonceDecision::Orphan
            } else {
                NonceDecision::Live
            }
        }
    }
}

fn locked(reason: super::diagnostics::Reason) -> super::server::ServeError {
    super::diagnostics::lifecycle(super::diagnostics::Lifecycle::Stopped, reason);
    // Startup refusals have no serving scope to perform the final bounded flush.
    super::diagnostics::flush(Duration::from_millis(25));
    super::server::ServeError::Locked
}

// Only the holder of the permanent OS lock may recover a proved orphan. Unknown
// content is left intact for the existing JobLock age policy, never called live.
fn recover_nonce(run: &Path) -> Result<(), super::server::ServeError> {
    let path = run.join("engine.lock");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let Some(original) = read_nonce(&path)? else {
        return Ok(());
    };
    let Ok(host) = process::hostname() else {
        return Ok(());
    };
    let current = process::incarnation().ok();
    match nonce_decision(
        &original,
        &host,
        current.as_ref().and_then(|start| start.boot.as_deref()),
        process::alive,
        |pid| process::incarnation_of(pid).ok(),
    ) {
        NonceDecision::Live => return Err(locked(super::diagnostics::Reason::StampOwnerLive)),
        NonceDecision::AgeRule => return Ok(()),
        NonceDecision::Orphan => {}
    }
    // Compare exact bytes, including invalid UTF-8. A changed stamp is not live
    // evidence and must not be unlinked under the previous owner's proof.
    if read_nonce(&path)?.as_deref() != Some(original.as_slice()) {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, "engine nonce changed").into());
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

// The selected home may be an alias. Resolve only that user-selected path.
// Once bound, run/ and all store paths still have to pass the no-link checks.
fn physical_home(home: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(home) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let (Some(parent), Some(name)) = (home.parent(), home.file_name()) else {
                return Err(error);
            };
            Ok(physical_home(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

/// Files and per-start identity of one engine. The bearer token has no diagnostic formatter.
pub struct EngineLayout {
    /// Absolute normalized Harness home; trusted paths are checked before use.
    pub home: PathBuf,
    /// Private runtime directory.
    pub run: PathBuf,
    /// Local socket or named-pipe address.
    pub address: String,
    /// Reverse Core endpoint. Windows hashes the spelling supplied to Core.
    pub core_address: String,
    /// Engine instance identifier reported in the handshake and pid file.
    pub instance_id: String,
    /// Adoption grace after losing the active lifeline.
    pub grace: Duration,
    token: String,
}

impl EngineLayout {
    /// Validate and create a private home, and generate a fresh OS-random bearer token.
    pub fn new(home: &Path, instance_id: String) -> io::Result<Self> {
        let configured = super::platform::absolute_normalized(home);
        let home = if assert_trusted_path(&configured).is_ok() {
            configured.clone()
        } else {
            physical_home(&configured)?
        };
        let endpoint_home = if cfg!(windows) { &configured } else { &home };
        secure_dir(&home).map_err(io::Error::other)?;
        let run = home.join("run");
        secure_dir(&run).map_err(io::Error::other)?;
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(io::Error::other)?;
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self {
            address: unit_address(endpoint_home, "engine"),
            core_address: unit_address(endpoint_home, "core"),
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
            fs::TryLockError::WouldBlock => locked(super::diagnostics::Reason::ProcessLockHeld),
            fs::TryLockError::Error(error) => super::server::ServeError::Io(error),
        })?;
        secure_file(&path).map_err(io::Error::other)?;
        recover_nonce(&self.run)?;
        let guard = JobLock::acquire(&self.run, "engine", Duration::from_secs(60)).map_err(
            |e| match e {
                LockBusy::Held => locked(super::diagnostics::Reason::StampAgeRule),
                LockBusy::Store(e) => super::server::ServeError::Io(io::Error::other(e)),
            },
        )?;
        #[cfg(unix)]
        if fs::symlink_metadata(&self.address).is_ok() {
            assert_trusted_path(Path::new(&self.address)).map_err(io::Error::other)?;
            match std::os::unix::net::UnixStream::connect(&self.address) {
                Ok(_) => return Err(locked(super::diagnostics::Reason::EndpointLive)),
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
    fn trusted_unprovable_stamps_follow_the_existing_age_rule() {
        let mut foreign_host = own_nonce();
        foreign_host["host"] = json!(format!(
            "{}-foreign",
            foreign_host["host"].as_str().unwrap()
        ));
        let mut missing_start = own_nonce();
        missing_start.as_object_mut().unwrap().remove("procStart");
        let mut invalid_pid = own_nonce();
        invalid_pid["pid"] = json!(0);
        let mut cases: Vec<Vec<u8>> = [foreign_host, missing_start, invalid_pid]
            .iter()
            .map(|nonce| serde_json::to_vec(nonce).unwrap())
            .collect();
        cases.extend([Vec::new(), b"broken JSON".to_vec(), vec![0xff]]);
        for bytes in cases {
            for aged in [false, true] {
                let (_root, layout) = fixture();
                let path = layout.run.join("engine.lock");
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
                recover_nonce(&layout.run).expect("unknown content is delegated to age policy");
                assert_eq!(fs::read(&path).unwrap(), bytes);
                let acquired = layout.acquire();
                if aged {
                    let guard = acquired.expect("the hard ceiling expires unknown stamps");
                    assert_ne!(fs::read(&path).unwrap(), bytes);
                    drop(guard);
                } else {
                    assert!(matches!(
                        acquired,
                        Err(super::super::server::ServeError::Locked)
                    ));
                    assert_eq!(fs::read(&path).unwrap(), bytes);
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn readable_legacy_live_and_fresh_unknown_nonces_are_preserved_without_chmod() {
        use std::os::unix::fs::PermissionsExt;

        let mut foreign = own_nonce();
        foreign["host"] = json!(format!("{}-foreign", foreign["host"].as_str().unwrap()));
        let mut missing_start = own_nonce();
        missing_start.as_object_mut().unwrap().remove("procStart");
        for (nonce, aged) in [
            (own_nonce(), true),
            (foreign, false),
            (missing_start, false),
            (json!("corrupt stamp"), false),
        ] {
            let (_root, layout) = fixture();
            let original = write_nonce(&layout, &nonce, aged);
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

    #[test]
    fn nonce_classification_requires_positive_same_incarnation_evidence() {
        use std::cell::Cell;

        let host = "local-host";
        let recorded = Incarnation {
            mono: 5_000,
            boot: Some("current-boot".into()),
        };
        let base = json!({"nonce":uuid::Uuid::new_v4().to_string(),"pid":42,"host":host,"procStart":recorded});
        let mut foreign = base.clone();
        foreign["host"] = json!("another-host");
        let mut pid_zero = base.clone();
        pid_zero["pid"] = json!(0);
        let mut missing_start = base.clone();
        missing_start.as_object_mut().unwrap().remove("procStart");
        let mut invalid_start = base.clone();
        invalid_start["procStart"]["mono"] = json!(-1);
        let mut empty_boot = base.clone();
        empty_boot["procStart"]["boot"] = json!("");
        let mut invalid_nonce = base.clone();
        invalid_nonce["nonce"] = json!("invalid");
        let mut unknowns = [
            foreign,
            pid_zero,
            missing_start,
            invalid_start,
            empty_boot,
            invalid_nonce,
        ]
        .iter()
        .map(|value| serde_json::to_vec(value).unwrap())
        .collect::<Vec<_>>();
        unknowns.extend([Vec::new(), b"{broken".to_vec(), vec![0xff]]);
        for bytes in unknowns {
            let probes = Cell::new(0);
            assert_eq!(
                nonce_decision(
                    &bytes,
                    host,
                    Some("current-boot"),
                    |_| {
                        probes.set(probes.get() + 1);
                        Liveness::Alive
                    },
                    |_| {
                        probes.set(probes.get() + 1);
                        Some(recorded.clone())
                    }
                ),
                NonceDecision::AgeRule
            );
            assert_eq!(probes.get(), 0);
        }
        let bytes = serde_json::to_vec(&base).unwrap();
        for liveness in [Liveness::Gone, Liveness::OtherUser] {
            let starts = Cell::new(0);
            assert_eq!(
                nonce_decision(
                    &bytes,
                    host,
                    Some("current-boot"),
                    |_| liveness,
                    |_| {
                        starts.set(starts.get() + 1);
                        Some(recorded.clone())
                    }
                ),
                NonceDecision::Orphan
            );
            assert_eq!(starts.get(), 0);
        }
        for (start, expected) in [
            (Some(recorded.clone()), NonceDecision::Live),
            (
                Some(Incarnation {
                    mono: 6_000,
                    boot: recorded.boot.clone(),
                }),
                NonceDecision::Live,
            ),
            (
                Some(Incarnation {
                    mono: 6_001,
                    boot: recorded.boot.clone(),
                }),
                NonceDecision::Orphan,
            ),
            (
                Some(Incarnation {
                    mono: 5_000,
                    boot: Some("another-boot".into()),
                }),
                NonceDecision::Orphan,
            ),
            (None, NonceDecision::AgeRule),
        ] {
            assert_eq!(
                nonce_decision(
                    &bytes,
                    host,
                    Some("current-boot"),
                    |_| Liveness::Alive,
                    |_| start
                ),
                expected
            );
        }
        let probes = Cell::new(0);
        assert_eq!(
            nonce_decision(
                &bytes,
                host,
                Some("new-boot"),
                |_| {
                    probes.set(probes.get() + 1);
                    Liveness::OtherUser
                },
                |_| {
                    probes.set(probes.get() + 1);
                    None
                }
            ),
            NonceDecision::Orphan
        );
        assert_eq!(
            probes.get(),
            0,
            "boot mismatch precedes both owner-pid probes"
        );
    }

    #[test]
    fn trusted_invalid_utf8_is_read_without_lossy_decoding() {
        let (_root, layout) = fixture();
        let path = layout.run.join("engine.lock");
        for bytes in [vec![0xff], vec![0xfe]] {
            fs::write(&path, &bytes).unwrap();
            secure_file(&path).unwrap();
            assert_eq!(read_nonce(&path).unwrap(), Some(bytes));
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
                Err(super::super::server::ServeError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied
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
            Err(super::super::server::ServeError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied
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
                Err(super::super::server::ServeError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied
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
            Err(super::super::server::ServeError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied
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

    #[cfg(unix)]
    #[test]
    fn a_linked_home_resolves_but_a_linked_run_directory_is_refused() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let physical = root.path().join("physical");
        secure_dir(&physical).unwrap();
        let alias = root.path().join("alias");
        symlink(&physical, &alias).unwrap();

        let layout = EngineLayout::new(&alias.join("new-home"), "test-instance".into()).unwrap();
        assert_eq!(layout.home, physical.join("new-home"));
        assert_eq!(layout.core_address, unit_address(&layout.home, "core"));
        assert_eq!(layout.address, unit_address(&layout.home, "engine"));
        let layout = EngineLayout::new(&alias, "test-instance".into()).unwrap();
        assert_eq!(layout.home, physical);

        let elsewhere = root.path().join("elsewhere");
        secure_dir(&elsewhere).unwrap();
        fs::remove_dir(&layout.run).unwrap();
        symlink(&elsewhere, &layout.run).unwrap();
        assert!(EngineLayout::new(&alias, "test-instance".into()).is_err());
    }
}
