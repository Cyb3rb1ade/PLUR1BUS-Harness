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
    /// The bridge's address: `run/core-bridge.sock`, or the per-home `-core-bridge` pipe (P4-20 flip B1). Bound only
    /// while the front door owns the secret store.
    pub bridge_address: String,
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
            bridge_address: unit_address(home, crate::bridge::BRIDGE_ROLE, cfg!(windows)),
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

/// The longest Unix socket path the OS takes (`sizeof(sun_path)` less its NUL): 107 bytes on Linux, 103 on macOS and the
/// BSDs.
#[cfg(unix)]
const SOCKET_PATH_MAX: usize = if cfg!(target_os = "linux") { 107 } else { 103 };

/// Refuses a home whose sockets do not fit the OS's socket path length (P4D-10, security review I3), naming the socket,
/// before anything is written: the legacy core's `run/core-legacy.sock` is 7 bytes longer than `run/core.sock`, so a
/// home that fits a TypeScript core alone can be too long for the front door, and the legacy core's bind error would not
/// say why. Windows pipe names have no such limit.
pub fn check_socket_paths(files: &RunFiles) -> Result<(), String> {
    #[cfg(unix)]
    for (name, address) in [
        ("run/core.sock", &files.address),
        ("run/core-legacy.sock", &files.legacy_address),
        ("run/core-bridge.sock", &files.bridge_address),
    ] {
        if address.len() > SOCKET_PATH_MAX {
            return Err(format!(
                "the home is too long for the core's sockets: {name} would be {} bytes, the OS takes at most {SOCKET_PATH_MAX} \
                 (with core.impl \"rust\" the legacy core's socket is 7 bytes longer than run/core.sock); choose a shorter \
                 home (--home, PLUR1BUS_HOME)",
                address.len()
            ));
        }
    }
    let _ = files;
    Ok(())
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
/// under the core lock, before anything is written and before the legacy core starts.
///
/// Also a `run/core-legacy.pid` whose process is gone or is no child of this process (final review FR-M2): nothing else
/// removes a dead front door's legacy record on a home that goes back to `ts`, and a reused pid in it would refuse the
/// import as `target-running`. A record whose process still lives is returned: an older legacy core, still stopping,
/// that the next legacy start may find holding `run/core-legacy.lock` (the holder that start then names).
pub fn clear_leftovers(files: &RunFiles) -> Option<String> {
    for path in files.owned() {
        let _ = fs::remove_file(temporary(path));
    }
    let _ = fs::remove_file(&files.legacy_credentials);
    let Some(record) = read_record(&files.legacy_pid) else {
        // Not a record this could read (a link, a FIFO, too large) or none at all: removing never follows a link.
        let _ = fs::remove_file(&files.legacy_pid);
        return None;
    };
    let pid = record
        .split_whitespace()
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .filter(|&p| p != 0);
    let alive = pid
        .is_some_and(|p| plur1bus_rpc::process::alive(p) != plur1bus_rpc::process::Liveness::Gone);
    let ours =
        pid.is_some_and(|p| plur1bus_rpc::process::parent_pid(p) == Some(std::process::id()));
    if alive && ours {
        return None;
    }
    let _ = fs::remove_file(&files.legacy_pid);
    alive.then_some(record)
}

/// Reads the legacy record (final review FR-M2, read hardening; the pattern of the tools service's `read_private`): a regular
/// file, not a link, at most 256 bytes. Anything else (a FIFO, whose open would block the start for good; a link; a device;
/// a large file) is not read and gives `None` ([`clear_leftovers`] then removes it). The opened handle is checked again, so a file
/// swapped for another kind between the check and the open is not read either.
fn read_record(path: &Path) -> Option<String> {
    const LIMIT: u64 = 256;
    let meta = path.symlink_metadata().ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > LIMIT {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(LIMIT).read_to_string(&mut text).ok()?;
    Some(text)
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

/// The most a credential file holds, in bytes (a token is 64 characters).
const TOKEN_FILE_MAX: u64 = 4096;

/// Reads a credential file another process wrote into `run/` (`run/engine.token`, `run/supervisor.token`): a regular
/// file, not a link, at most 4 KiB, trimmed. `Ok(None)` when it does not exist.
///
/// On Unix the name is used once (review U2; the engine's connection has this file read before every native answer,
/// in the thread of that connection). The file is opened without following a link at its name and without waiting,
/// so a FIFO put there opens at once instead of holding the thread for a writer that never comes; what was opened
/// is then asked of the descriptor (a regular file, at most 4 KiB), and no more than that is read, whatever the file
/// becomes meanwhile. Nothing is decided on the name before the open, so there is no moment in which another file
/// can take the name between a check and the read. On Windows the name is looked at and then opened, as before.
///
/// The trim is Rust's, which is not JavaScript's in two characters: U+FEFF is trimmed by module-api's `readRunToken`
/// and not here, U+0085 here and not there, so a file that begins with a byte order mark is a token there and none
/// here (review U10; the engine writes none, and what is no token is refused).
#[cfg(unix)]
pub fn read_token(path: &Path) -> io::Result<Option<Secret>> {
    use std::os::unix::fs::OpenOptionsExt;
    let opened = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path);
    let file = match opened {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > TOKEN_FILE_MAX {
        return Err(io::Error::other("credential file is not a regular file"));
    }
    read_bounded(file).map(Some)
}

/// What `file` holds, trimmed; a failure when that is more than a credential file holds (it grew after it was
/// measured) or no text. At most one byte beyond the bound is read.
#[cfg(unix)]
fn read_bounded(file: impl Read) -> io::Result<Secret> {
    let mut text = zeroize::Zeroizing::new(String::new());
    file.take(TOKEN_FILE_MAX + 1).read_to_string(&mut text)?;
    if text.len() as u64 > TOKEN_FILE_MAX {
        return Err(io::Error::other("credential file grew while it was read"));
    }
    Ok(Secret::new(text.trim().to_owned()))
}

/// See the Unix form: here the name is looked at, then opened.
#[cfg(not(unix))]
pub fn read_token(path: &Path) -> io::Result<Option<Secret>> {
    let meta = match path.symlink_metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > TOKEN_FILE_MAX {
        return Err(io::Error::other("credential file is not a regular file"));
    }
    let mut text = zeroize::Zeroizing::new(String::new());
    fs::File::open(path)?.read_to_string(&mut text)?;
    Ok(Some(Secret::new(text.trim().to_owned())))
}

/// `run/engine.token` as it is at this moment, read the way module-api's `readRunToken` reads it for every request
/// of an engine connection (review U1): `run/` is looked at first (`checkRunDir`: a real directory of this user
/// that group and others cannot write to; always trusted off Unix, where its DACL protects it), and a directory that
/// fails holds no token, whatever the file says. Then the file ([`read_token`]). `None` for a token that is not
/// there and for everything that went wrong on the way: the caller refuses.
pub fn engine_token_now(files: &RunFiles) -> Option<Secret> {
    plur1bus_rpc::trust::verify_run_dir(&files.run).ok()?;
    read_token(&files.engine_token).ok().flatten()
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

    /// Review U2: a credential file is opened once, never through a link and never waiting, and judged by what the
    /// descriptor is; no more is read than such a file holds.
    #[cfg(unix)]
    #[test]
    fn a_credential_file_is_a_regular_file_of_a_bounded_size_read_through_one_descriptor() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let files = RunFiles::new(dir.path());
        prepare(&files).unwrap();
        let at = &files.engine_token;
        let token = Secret::fresh().unwrap();
        let refused = |what: &str| {
            let read = read_token(at);
            assert!(read.is_err(), "{what}: {:?}", read.map(|t| t.is_some()));
            read.unwrap_err().to_string()
        };
        let reads = |what: &str| {
            let read = read_token(at).unwrap().unwrap();
            assert_eq!(read.expose(), token.expose(), "{what}");
        };
        assert!(read_token(at).unwrap().is_none(), "no file is no token");
        // Trimmed, and as long as a credential file may be.
        fs::write(at, format!("\n {}\r\n", token.expose())).unwrap();
        reads("trimmed");
        let most = format!("{}{}", token.expose(), " ".repeat(4096 - 64));
        fs::write(at, &most).unwrap();
        reads("4096 bytes");
        // One byte more is no credential file, whatever it would be once trimmed: the descriptor says so.
        fs::write(at, format!("{most} ")).unwrap();
        assert_eq!(
            refused("4097 bytes"),
            "credential file is not a regular file"
        );
        fs::write(at, "").unwrap();
        assert_eq!(read_token(at).unwrap().unwrap().expose(), "");
        // No text.
        let mut bytes = token.expose().as_bytes().to_vec();
        bytes.push(0xff);
        fs::write(at, bytes).unwrap();
        refused("not UTF-8");
        fs::remove_file(at).unwrap();
        // A link is not followed, to a file that holds the token or to nothing.
        let elsewhere = files.run.join("elsewhere");
        fs::write(&elsewhere, token.expose()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, at).unwrap();
        refused("a link to a token");
        fs::remove_file(&elsewhere).unwrap();
        refused("a link to nothing");
        fs::remove_file(at).unwrap();
        // A directory.
        fs::create_dir(at).unwrap();
        refused("a directory");
        fs::remove_dir(at).unwrap();
        // A FIFO nobody writes to: refused at once. The read runs on a thread of its own, so an open that waits
        // fails this test instead of holding it; that thread is let go by a writer at the end.
        let made = std::process::Command::new("mkfifo")
            .arg(at)
            .status()
            .unwrap();
        assert!(made.success(), "mkfifo");
        let (tx, rx) = std::sync::mpsc::channel();
        let path = at.clone();
        let reader = std::thread::spawn(move || {
            let _ = tx.send(read_token(&path).map(|t| t.is_some()));
        });
        let read = rx.recv_timeout(std::time::Duration::from_secs(5));
        if read.is_err() {
            let _ = fs::OpenOptions::new().write(true).open(at);
        }
        reader.join().unwrap();
        assert!(
            matches!(read, Ok(Err(_))),
            "a FIFO is refused without waiting: {read:?}"
        );
        fs::remove_file(at).unwrap();
        // A file that cannot be read (root reads it all the same; then there is nothing to see here).
        fs::write(at, token.expose()).unwrap();
        fs::set_permissions(at, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(at).is_err() {
            refused("unreadable");
        }
    }

    /// Review U2: what is read is bounded by itself, not by what the file measured before: a file that grew after it
    /// was measured is refused, and no more than one byte beyond the bound is taken from it.
    #[cfg(unix)]
    #[test]
    fn no_more_than_a_credential_file_holds_is_read() {
        struct Endless(usize);
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                buf.fill(b' ');
                self.0 += buf.len();
                Ok(buf.len())
            }
        }
        let mut endless = Endless(0);
        let grown = read_bounded(&mut endless).unwrap_err();
        assert_eq!(grown.to_string(), "credential file grew while it was read");
        assert_eq!(endless.0, 4097);
        let token = Secret::fresh().unwrap();
        let most = format!("{}{}", token.expose(), " ".repeat(4096 - 64));
        assert_eq!(
            read_bounded(most.as_bytes()).unwrap().expose(),
            token.expose()
        );
        assert!(read_bounded(format!("{most} ").as_bytes()).is_err());
        assert!(read_bounded(&[0xff_u8][..]).is_err());
    }

    /// Review U1: the engine's token is read as module-api's `readRunToken` reads it, the directory first. A `run/`
    /// that group or others can write to, that is a link, or that is gone holds no token, whatever the file says.
    #[cfg(unix)]
    #[test]
    fn the_engines_token_is_none_in_a_run_directory_that_is_not_trusted() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let files = RunFiles::new(dir.path());
        prepare(&files).unwrap();
        assert!(engine_token_now(&files).is_none(), "no file");
        let token = Secret::fresh().unwrap();
        fs::write(&files.engine_token, token.expose()).unwrap();
        let now = || engine_token_now(&files).map(|t| t.expose().to_owned());
        assert_eq!(now().as_deref(), Some(token.expose()));
        let mode = |mode: u32| fs::set_permissions(&files.run, fs::Permissions::from_mode(mode));
        for open_to_others in [0o770, 0o720, 0o702, 0o707, 0o777] {
            mode(open_to_others).unwrap();
            assert_eq!(now(), None, "{open_to_others:o}");
            assert!(
                read_token(&files.engine_token).unwrap().is_some(),
                "the file alone would pass: {open_to_others:o}"
            );
        }
        // Readable by others is module-api's `checkRunDir` too: it asks about writing only.
        mode(0o755).unwrap();
        assert_eq!(now().as_deref(), Some(token.expose()));
        mode(0o700).unwrap();
        assert_eq!(now().as_deref(), Some(token.expose()));
        // A link where `run/` was, to the very directory.
        let moved = dir.path().join("run-moved");
        fs::rename(&files.run, &moved).unwrap();
        assert_eq!(now(), None, "no run/");
        std::os::unix::fs::symlink(&moved, &files.run).unwrap();
        assert!(read_token(&files.engine_token).unwrap().is_some());
        assert_eq!(now(), None, "a link");
        // A file that is no token file is none in a directory that is trusted.
        fs::remove_file(&files.run).unwrap();
        fs::rename(&moved, &files.run).unwrap();
        fs::remove_file(&files.engine_token).unwrap();
        std::os::unix::fs::symlink(files.run.join("elsewhere"), &files.engine_token).unwrap();
        assert_eq!(now(), None, "a link at the file");
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

    /// Final review FR-M2: a `run/core-legacy.pid` whose process is gone, or is no child of this process, is removed at
    /// start (a home that goes back to `ts` would keep it until the pid is reused and the import refuses as
    /// `target-running`). A live one is handed back: it names the older legacy core the next legacy start may find holding
    /// `run/core-legacy.lock`. Only a record of this process's own child stays.
    #[test]
    fn a_legacy_record_that_is_not_this_processs_childs_is_cleared_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let files = RunFiles::new(dir.path());
        prepare(&files).unwrap();
        let record = |pid: u32| format!("{pid} 5d0f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f\n");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let dead = child.id();
        child.wait().unwrap();
        fs::write(&files.legacy_pid, record(dead)).unwrap();
        assert_eq!(
            clear_leftovers(&files),
            None,
            "a dead holder is nobody to name"
        );
        assert!(
            !files.legacy_pid.exists(),
            "the record of a gone process is removed"
        );
        // A live process that is not this one's child (this process itself: its parent is the test runner).
        fs::write(&files.legacy_pid, record(std::process::id())).unwrap();
        assert_eq!(clear_leftovers(&files), Some(record(std::process::id())));
        assert!(
            !files.legacy_pid.exists(),
            "the record of another process's child is removed"
        );
        #[cfg(unix)]
        {
            let mut child = std::process::Command::new("sleep")
                .arg("5")
                .spawn()
                .unwrap();
            fs::write(&files.legacy_pid, record(child.id())).unwrap();
            let kept = clear_leftovers(&files);
            let _ = child.kill();
            let _ = child.wait();
            assert_eq!(kept, None);
            assert!(
                files.legacy_pid.exists(),
                "the record of this process's own child stays"
            );
        }
    }

    /// Final review FR-M2 (read hardening): a link at `run/core-legacy.pid` is not followed. Its target names a live process
    /// that is nobody's child; read through the link that would be returned as an older legacy core.
    #[cfg(unix)]
    #[test]
    fn a_link_at_the_legacy_record_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let files = RunFiles::new(dir.path());
        prepare(&files).unwrap();
        let target = dir.path().join("elsewhere");
        let text = format!(
            "{} 5d0f6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f\n",
            std::process::id()
        );
        fs::write(&target, &text).unwrap();
        std::os::unix::fs::symlink(&target, &files.legacy_pid).unwrap();
        assert_eq!(clear_leftovers(&files), None);
        assert!(
            files.legacy_pid.symlink_metadata().is_err(),
            "the link is removed"
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            text,
            "its target is not"
        );
    }

    /// P4-10 P4D-10 (security review I3): a home whose `run/core-legacy.sock` would not fit `sun_path` is refused with a
    /// message that says so, before anything is written; `run/core.sock` is 7 bytes shorter, so a home that fits a
    /// TypeScript core alone can be too long for the front door.
    #[cfg(unix)]
    #[test]
    fn a_home_too_long_for_the_legacy_socket_is_refused_by_name() {
        let limit = if cfg!(target_os = "linux") { 108 } else { 104 };
        let fits = |len: usize| RunFiles::new(Path::new(&format!("/{}", "h".repeat(len - 1))));
        // The longest home whose legacy socket still fits, and one byte more.
        let longest = limit - 1 - "/run/core-legacy.sock".len();
        assert!(check_socket_paths(&fits(longest)).is_ok());
        let refused = check_socket_paths(&fits(longest + 1)).unwrap_err();
        assert!(refused.contains("core-legacy.sock"), "{refused}");
        assert!(refused.contains("too long"), "{refused}");
        assert!(
            fits(longest + 1).address.len() < limit,
            "the TypeScript core's own socket would still fit"
        );
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
