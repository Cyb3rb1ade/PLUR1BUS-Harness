//! The core's run files under a home, with the names the TypeScript core uses (`packages/core/src/paths.ts`, module-api's
//! `unitAddress`): `run/core.sock` or the per-home pipe, `run/core.token`, `run/core.pid`, and the lock `state/core.lock`.
//! P4-10 creates them (directory 0700, socket 0600, a 32-byte token compared in constant time); this module only names
//! them.
use sha2::{Digest, Sha256};
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
            run,
        }
    }
}

/// The core's address on `windows` or a POSIX host: `\\.\pipe\plur1bus-<first 16 hex of sha256(lower-cased home)>-core`,
/// else `<home without trailing slashes>/run/core.sock`, built with `/` as module-api builds it.
pub fn address(home: &Path, windows: bool) -> String {
    let home = home.to_string_lossy();
    if windows {
        let digest = Sha256::digest(home.to_lowercase().as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        format!(r"\\.\pipe\plur1bus-{}-core", &hex[..16])
    } else {
        format!("{}/run/core.sock", home.trim_end_matches('/'))
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
    }

    #[test]
    fn the_run_files_are_the_typescript_cores_names() {
        let files = RunFiles::new(Path::new("/h"));
        assert_eq!(files.run, Path::new("/h/run"));
        assert_eq!(files.token, Path::new("/h/run/core.token"));
        assert_eq!(files.pid, Path::new("/h/run/core.pid"));
        assert_eq!(files.lock, Path::new("/h/state/core.lock"));
    }
}
