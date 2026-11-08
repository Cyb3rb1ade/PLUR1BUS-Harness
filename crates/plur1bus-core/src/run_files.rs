//! The core's run files under a home, with the names the TypeScript core uses (`packages/core/src/paths.ts`, module-api's
//! `unitAddress`): `run/core.sock` or the per-home pipe, `run/core.token`, `run/core.pid`, and the lock `state/core.lock`;
//! since P4-10 also the front door's `run/api-delegation.token`, `run/core-legacy.token` and
//! `run/core-legacy.credentials`, and the legacy core's address and `run/core-legacy.pid`.
//!
//! [`prepare`] creates `state/` and `run/` (`0700`, or the user-and-SYSTEM DACL on Windows) and checks `run/` is trusted;
//! [`write_private`] writes a file `0600` through a temporary file and a rename, so a reader never sees half a token.
use crate::auth::Secret;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// The run files of one home.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunFiles {
    /// The home they belong to.
    pub home: PathBuf,
    /// `run/`.
    pub run: PathBuf,
    /// The RPC address: `run/core.sock`, or `\\.\pipe\plur1bus-<hash>-core` on Windows.
    pub address: String,
    /// `run/core.token`.
    pub token: PathBuf,
    /// `run/core.pid`.
    pub pid: PathBuf,
    /// `state/core.lock`, the single-instance lock.
    pub lock: PathBuf,
    /// `run/api-delegation.token`: the Harness API's delegation credential (P4-10: the front door's).
    pub api_token: PathBuf,
    /// `run/core-legacy.token`: the front door's link credential to the legacy core (P4-10).
    pub legacy_token: PathBuf,
    /// `run/core-legacy.credentials`: `{ "core", "api" }`, the owner and API tokens for the legacy core alone while it
    /// starts; the public `run/core.token` and `run/api-delegation.token` are written once it is ready (P4-10).
    pub legacy_credentials: PathBuf,
    /// The legacy core's address: `run/core-legacy.sock`, or the per-home `-core-legacy` pipe (P4-10).
    pub legacy_address: String,
    /// `run/core-legacy.pid`, written by the legacy core (P4-10).
    pub legacy_pid: PathBuf,
    /// `run/engine.token`: the memory engine's delegation credential, written by the engine.
    pub engine_token: PathBuf,
    /// `run/supervisor.token`: the supervisor's token, the nonce of `core.adopt`.
    pub supervisor_token: PathBuf,
    /// `state/`.
    pub state: PathBuf,
    /// `config.json`.
    pub config: PathBuf,
}

impl RunFiles {
    /// The run files of `home`, on this platform.
    pub fn new(home: &Path) -> Self {
        let run = home.join("run");
        Self {
            home: home.to_path_buf(),
            address: address(home, cfg!(windows)),
            token: run.join("core.token"),
            pid: run.join("core.pid"),
            lock: home.join("state").join("core.lock"),
            api_token: run.join("api-delegation.token"),
            legacy_token: run.join("core-legacy.token"),
            legacy_credentials: run.join("core-legacy.credentials"),
            legacy_address: unit_address(home, "core-legacy", cfg!(windows)),
            legacy_pid: run.join("core-legacy.pid"),
            engine_token: run.join("engine.token"),
            supervisor_token: run.join("supervisor.token"),
            state: home.join("state"),
            config: home.join("config.json"),
            run,
        }
    }

    /// The files the front door owns and removes on a clean stop (never the legacy core's or the engine's).
    pub fn owned(&self) -> [&Path; 5] {
        [
            &self.token,
            &self.api_token,
            &self.legacy_token,
            &self.legacy_credentials,
            &self.pid,
        ]
    }
}

/// The core's address on `windows` or a POSIX host: `\\.\pipe\plur1bus-<first 16 hex of sha256(lower-cased home)>-core`,
/// else `<home without trailing slashes>/run/core.sock`, built with `/` as module-api builds it.
pub fn address(home: &Path, windows: bool) -> String {
    unit_address(home, "core", windows)
}

/// module-api's `unitAddress(home, role)`.
pub fn unit_address(home: &Path, role: &str, windows: bool) -> String {
    let home = home.to_string_lossy();
    if windows {
        let digest = Sha256::digest(home.to_lowercase().as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        format!(r"\\.\pipe\plur1bus-{}-{role}", &hex[..16])
    } else {
        format!("{}/run/{role}.sock", home.trim_end_matches('/'))
    }
}

/// Creates `state/` and `run/` for the core and makes sure `run/` holds credentials safely: `0700` and owned by this user
/// on POSIX (re-`chmod`ed like the TypeScript core does at listen); on Windows the protected user-and-SYSTEM DACL, unless
/// the supervisor already set it (`PLUR1BUS_RUN_ACL=inherited`, HB5). A `run/` that cannot be secured refuses the start
/// (audit M3: fail closed).
pub fn prepare(files: &RunFiles) -> io::Result<()> {
    private_dir(&files.state)?;
    private_dir(&files.run)?;
    #[cfg(windows)]
    if std::env::var_os("PLUR1BUS_RUN_ACL").as_deref() != Some(std::ffi::OsStr::new("inherited")) {
        let sid = plur1bus_rpc::win::user_sid()?;
        plur1bus_rpc::win::set_path_dacl(&files.run, &plur1bus_rpc::acl::run_dir_sddl(&sid))?;
        let entries = plur1bus_rpc::win::file_dacl_report(&files.run)?;
        if !plur1bus_rpc::acl::run_writable_by_others(&entries, &sid).is_empty() {
            return Err(io::Error::other(
                "refusing to start: run/ stays writable by other accounts",
            ));
        }
    }
    plur1bus_rpc::trust::verify_run_dir(&files.run)
        .map_err(|e| io::Error::other(format!("refusing to start: run/ is not trusted ({e})")))
}

fn private_dir(dir: &Path) -> io::Result<()> {
    if dir
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir())
    {
        return Err(io::Error::other(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        match fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
        {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// Removes what a front door that was killed may have left in `run/` (security review L6): the temporary file of every
/// file it writes (a link there is removed, never followed) and the legacy core's credentials file. Called at start,
/// under the core lock, before anything is written.
pub fn clear_leftovers(files: &RunFiles) {
    for path in files.owned() {
        let _ = fs::remove_file(temporary(path));
    }
    let _ = fs::remove_file(&files.legacy_credentials);
}

fn temporary(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

/// Writes `text` to `path` as a private file (`0600`; the user-and-SYSTEM DACL on Windows), through `<path>.tmp` and a
/// rename, so a reader sees the old content or the new one, never a part. The temporary file is created new and never
/// through a link (security review L6): anything already at its name fails the write ([`clear_leftovers`] runs at
/// start); a failed write removes the temporary file it created.
pub fn write_private(path: &Path, text: &str) -> io::Result<()> {
    let tmp = temporary(path);
    let mut file = plur1bus_audit::create_new_private(&tmp)?;
    let written = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written.and_then(|()| fs::rename(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Reads a credential file another process wrote into `run/` (`run/engine.token`, `run/supervisor.token`): a regular
/// file, not a link, at most 4 KiB, trimmed. `Ok(None)` when it does not exist.
pub fn read_token(path: &Path) -> io::Result<Option<Secret>> {
    let meta = match path.symlink_metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 4096 {
        return Err(io::Error::other("credential file is not a regular file"));
    }
    let mut text = zeroize::Zeroizing::new(String::new());
    fs::File::open(path)?.read_to_string(&mut text)?;
    Ok(Some(Secret::new(text.trim().to_owned())))
}

/// Removes the files the front door wrote (and the POSIX socket); every failure is ignored, a missing file included.
pub fn remove_owned(files: &RunFiles) {
    for path in files.owned() {
        let _ = fs::remove_file(path);
    }
    if !cfg!(windows) {
        let _ = fs::remove_file(&files.address);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_follows_module_apis_rule_on_both_platforms() {
        assert_eq!(
            address(Path::new("/h/.plur1bus/"), false),
            "/h/.plur1bus/run/core.sock"
        );
        // The same home as the CLI's `engine_endpoints` vector in crates/plur1bus/src/paths.rs; only the role differs.
        assert_eq!(
            address(Path::new(r"C:\Users\c\AppData\Local\PLUR1BUS"), true),
            r"\\.\pipe\plur1bus-741b3e0a44818d49-core"
        );
        assert_eq!(
            unit_address(
                Path::new(r"C:\Users\c\AppData\Local\PLUR1BUS"),
                "core-legacy",
                true
            ),
            r"\\.\pipe\plur1bus-741b3e0a44818d49-core-legacy"
        );
        assert_eq!(
            unit_address(Path::new("/h"), "core-legacy", false),
            "/h/run/core-legacy.sock"
        );
    }

    #[test]
    fn the_run_files_are_the_typescript_cores_names() {
        let files = RunFiles::new(Path::new("/h"));
        assert_eq!(files.run, Path::new("/h/run"));
        assert_eq!(files.token, Path::new("/h/run/core.token"));
        assert_eq!(files.pid, Path::new("/h/run/core.pid"));
        assert_eq!(files.lock, Path::new("/h/state/core.lock"));
        assert_eq!(files.api_token, Path::new("/h/run/api-delegation.token"));
        assert_eq!(files.legacy_token, Path::new("/h/run/core-legacy.token"));
        assert_eq!(
            files.legacy_credentials,
            Path::new("/h/run/core-legacy.credentials")
        );
        assert_eq!(files.legacy_pid, Path::new("/h/run/core-legacy.pid"));
        assert_eq!(files.engine_token, Path::new("/h/run/engine.token"));
        assert_eq!(files.supervisor_token, Path::new("/h/run/supervisor.token"));
    }

    #[cfg(unix)]
    #[test]
    fn prepared_directories_are_0700_and_written_files_0600_and_whole() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let files = RunFiles::new(dir.path());
        fs::create_dir_all(&files.run).unwrap();
        fs::set_permissions(&files.run, fs::Permissions::from_mode(0o755)).unwrap();
        prepare(&files).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode(&files.run),
            0o700,
            "re-chmod'ed like the TypeScript core"
        );
        assert_eq!(mode(&files.state), 0o700);
        let token = Secret::fresh().unwrap();
        write_private(&files.token, token.expose()).unwrap();
        assert_eq!(mode(&files.token), 0o600);
        assert_eq!(fs::read_to_string(&files.token).unwrap(), token.expose());
        assert!(!files.run.join("core.token.tmp").exists());
        assert_eq!(
            read_token(&files.token).unwrap().unwrap().expose(),
            token.expose()
        );
        assert!(read_token(&files.engine_token).unwrap().is_none());
    }

    /// Security review L6: the temporary file is created new, never opened through what is already at its name (a link
    /// planted there, or a leftover); the start clears leftovers first ([`clear_leftovers`]).
    #[test]
    fn whatever_is_at_the_temporary_name_makes_the_write_fail_until_the_start_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let files = RunFiles::new(dir.path());
        prepare(&files).unwrap();
        let tmp = files.run.join("core.token.tmp");
        fs::write(&tmp, "left by a crash").unwrap();
        assert!(write_private(&files.token, "fresh").is_err());
        assert!(!files.token.exists());
        #[cfg(unix)]
        {
            let elsewhere = dir.path().join("elsewhere");
            fs::write(&elsewhere, "untouched").unwrap();
            fs::remove_file(&tmp).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &tmp).unwrap();
            assert!(
                write_private(&files.token, "secret").is_err(),
                "a link is never followed"
            );
            assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "untouched");
        }
        fs::write(&files.legacy_credentials, "{}").unwrap();
        clear_leftovers(&files);
        assert!(tmp.symlink_metadata().is_err());
        assert!(
            !files.legacy_credentials.exists(),
            "a killed front door's credentials file is gone"
        );
        write_private(&files.token, "fresh").unwrap();
        assert_eq!(fs::read_to_string(&files.token).unwrap(), "fresh");
    }

    #[cfg(unix)]
    #[test]
    fn a_run_directory_that_is_a_link_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("elsewhere");
        fs::create_dir(&other).unwrap();
        let home = dir.path().join("home");
        fs::create_dir(&home).unwrap();
        std::os::unix::fs::symlink(&other, home.join("run")).unwrap();
        assert!(prepare(&RunFiles::new(&home)).is_err());
    }
}
