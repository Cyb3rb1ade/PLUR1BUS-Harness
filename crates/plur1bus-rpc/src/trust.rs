//! Who may a client talk to? (audit M2)
//!
//! The POSIX trust model is "the `run/` directory is ours": a `0700` directory owned by the current user holds the
//! sockets, tokens and pid files. That only holds if nobody else can swap `run/` for their own directory, so a client
//! checks it before it reads a token or connects, and refuses (sending nothing) when it is not what it expects. The
//! Python client (`clients/python/.../client.py`, `_check_run_dir`) is the reference: a real directory, owned by the
//! effective uid, no group/other write bit.
//!
//! The check functions take plain values so a test can simulate a foreign owner, which it cannot create without
//! `chown` privileges.
use crate::error::RpcError;
use crate::types::ErrorCode;
use std::path::Path;

fn refuse(reason: &str, detail: String) -> RpcError {
    RpcError::Call {
        error: ErrorCode::EUnauthorized,
        jsonrpc: -32000,
        message: "the local RPC endpoint is not trusted; nothing was sent".into(),
        reason: Some(reason.into()),
        detail: Some(detail),
        ids: None,
        ext: None,
    }
}

/// What `lstat` says about a path: the inputs of [`check_run_dir_meta`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirMeta {
    pub is_dir: bool,
    pub is_symlink: bool,
    pub uid: u32,
    pub mode: u32,
}

/// The decision for a `run/` directory (reason `run-dir-untrusted`).
pub fn check_run_dir_meta(path: &Path, meta: DirMeta, euid: u32) -> Result<(), RpcError> {
    let shown = path.display();
    if meta.is_symlink {
        return Err(refuse("run-dir-untrusted", format!("{shown} is a symlink")));
    }
    if !meta.is_dir {
        return Err(refuse(
            "run-dir-untrusted",
            format!("{shown} is not a directory"),
        ));
    }
    if meta.uid != euid {
        return Err(refuse(
            "run-dir-untrusted",
            format!(
                "{shown} belongs to uid {}, not to this user (uid {euid})",
                meta.uid
            ),
        ));
    }
    if meta.mode & 0o022 != 0 {
        return Err(refuse(
            "run-dir-untrusted",
            format!(
                "{shown} is writable by group or others (mode {:o})",
                meta.mode & 0o7777
            ),
        ));
    }
    Ok(())
}

/// The decision for a socket file (reason `socket-untrusted`): a socket owned by the current user.
pub fn check_socket_meta(
    path: &Path,
    is_socket: bool,
    uid: u32,
    euid: u32,
) -> Result<(), RpcError> {
    let shown = path.display();
    if !is_socket {
        return Err(refuse(
            "socket-untrusted",
            format!("{shown} is not a socket"),
        ));
    }
    if uid != euid {
        return Err(refuse(
            "socket-untrusted",
            format!("{shown} belongs to uid {uid}, not to this user (uid {euid})"),
        ));
    }
    Ok(())
}

/// The decision for the peer of a connected socket (reason `peer-uid-mismatch`). `None`: the OS cannot tell.
pub fn check_peer_uid(peer: Option<u32>, euid: u32) -> Result<(), RpcError> {
    match peer {
        Some(uid) if uid != euid => Err(refuse(
            "peer-uid-mismatch",
            format!("the socket is served by uid {uid}, not by this user (uid {euid})"),
        )),
        _ => Ok(()),
    }
}

/// `run/` must be a real directory of the current user that others cannot write to. Always `Ok` off unix (Windows
/// protects `run/` with a DACL instead, and clients check the pipe server's pid).
pub fn verify_run_dir(dir: &Path) -> Result<(), RpcError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        let md = std::fs::symlink_metadata(dir).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                // No `run/` at all is the "core absent" case, not an untrusted one.
                return RpcError::from(e);
            }
            refuse(
                "run-dir-untrusted",
                format!("{} cannot be inspected: {e}", dir.display()),
            )
        })?;
        check_run_dir_meta(
            dir,
            DirMeta {
                is_dir: md.is_dir(),
                is_symlink: md.file_type().is_symlink(),
                uid: md.uid(),
                mode: md.permissions().mode(),
            },
            euid,
        )
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// The socket at `path` must be a socket of the current user.
pub fn verify_socket_file(path: &Path) -> Result<(), RpcError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        let md = std::fs::symlink_metadata(path).map_err(|e| {
            // A missing socket is the "core absent" case; keep the I/O error so callers still see NotFound.
            RpcError::from(e)
        })?;
        check_socket_meta(path, md.file_type().is_socket(), md.uid(), euid)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Before a client connects to `address`: on unix, a filesystem address must live in a trusted `run/` directory and
/// be a socket of ours. Other addresses (a Windows pipe name, a Linux abstract socket) are not files and pass here;
/// their identity is checked by pid or peer uid after connecting.
pub fn verify_address(address: &str) -> Result<(), RpcError> {
    #[cfg(unix)]
    {
        let path = Path::new(address);
        if !path.is_absolute() {
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            verify_run_dir(dir)?;
        }
        verify_socket_file(path)
    }
    #[cfg(not(unix))]
    {
        let _ = address;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(r: Result<(), RpcError>) -> String {
        match r {
            Err(RpcError::Call {
                error: ErrorCode::EUnauthorized,
                reason: Some(r),
                ..
            }) => r,
            other => panic!("expected E_UNAUTHORIZED, got {other:?}"),
        }
    }
    const DIR: DirMeta = DirMeta {
        is_dir: true,
        is_symlink: false,
        uid: 1000,
        mode: 0o40700,
    };

    #[test]
    fn a_private_directory_of_ours_is_trusted() {
        assert!(check_run_dir_meta(Path::new("run"), DIR, 1000).is_ok());
        assert!(check_run_dir_meta(
            Path::new("run"),
            DirMeta {
                mode: 0o40755,
                ..DIR
            },
            1000
        )
        .is_ok());
    }

    #[test]
    fn a_symlink_a_file_a_foreign_owner_or_a_writable_mode_is_refused() {
        let p = Path::new("run");
        for bad in [
            DirMeta {
                is_symlink: true,
                ..DIR
            },
            DirMeta {
                is_dir: false,
                ..DIR
            },
            DirMeta { uid: 1001, ..DIR },
            DirMeta {
                mode: 0o40770,
                ..DIR
            },
            DirMeta {
                mode: 0o40707,
                ..DIR
            },
            DirMeta {
                mode: 0o40777,
                ..DIR
            },
        ] {
            assert_eq!(
                reason(check_run_dir_meta(p, bad, 1000)),
                "run-dir-untrusted",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_socket_must_be_ours() {
        let p = Path::new("core.sock");
        assert!(check_socket_meta(p, true, 1000, 1000).is_ok());
        assert_eq!(
            reason(check_socket_meta(p, true, 1001, 1000)),
            "socket-untrusted"
        );
        assert_eq!(
            reason(check_socket_meta(p, false, 1000, 1000)),
            "socket-untrusted"
        );
    }

    #[test]
    fn a_peer_of_another_uid_is_refused_and_an_unknown_peer_passes() {
        assert!(check_peer_uid(Some(1000), 1000).is_ok());
        assert!(check_peer_uid(None, 1000).is_ok());
        assert_eq!(reason(check_peer_uid(Some(0), 1000)), "peer-uid-mismatch");
    }

    #[cfg(unix)]
    mod real_fs {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        fn mode(p: &Path, m: u32) {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        }

        #[test]
        fn a_real_private_run_dir_passes_and_a_group_writable_one_does_not() {
            let home = tempfile::tempdir().unwrap();
            let run = home.path().join("run");
            std::fs::create_dir(&run).unwrap();
            mode(&run, 0o700);
            assert!(verify_run_dir(&run).is_ok());
            mode(&run, 0o770);
            assert_eq!(reason(verify_run_dir(&run)), "run-dir-untrusted");
            mode(&run, 0o707);
            assert_eq!(reason(verify_run_dir(&run)), "run-dir-untrusted");
        }

        #[test]
        fn a_symlinked_run_dir_is_refused_even_when_its_target_is_private() {
            let home = tempfile::tempdir().unwrap();
            let real = home.path().join("elsewhere");
            std::fs::create_dir(&real).unwrap();
            mode(&real, 0o700);
            let run = home.path().join("run");
            symlink(&real, &run).unwrap();
            assert_eq!(reason(verify_run_dir(&run)), "run-dir-untrusted");
            assert_eq!(
                reason(verify_address(&run.join("core.sock").to_string_lossy())),
                "run-dir-untrusted"
            );
        }

        #[test]
        fn an_address_must_be_a_socket_in_a_trusted_dir() {
            let home = tempfile::tempdir().unwrap();
            let run = home.path().join("run");
            std::fs::create_dir(&run).unwrap();
            mode(&run, 0o700);
            let sock = run.join("core.sock");
            let _l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
            assert!(verify_address(&sock.to_string_lossy()).is_ok());
            let plain = run.join("plain.sock");
            std::fs::write(&plain, b"x").unwrap();
            assert_eq!(
                reason(verify_address(&plain.to_string_lossy())),
                "socket-untrusted"
            );
        }

        #[test]
        fn a_missing_socket_keeps_its_not_found_error() {
            let home = tempfile::tempdir().unwrap();
            let run = home.path().join("run");
            std::fs::create_dir(&run).unwrap();
            mode(&run, 0o700);
            let e = verify_address(&run.join("absent.sock").to_string_lossy()).unwrap_err();
            assert!(matches!(e, RpcError::Unavailable { .. }), "{e:?}");
        }

        #[test]
        fn a_missing_run_dir_is_core_absent_not_untrusted() {
            let home = tempfile::tempdir().unwrap();
            let e = verify_run_dir(&home.path().join("run")).unwrap_err();
            assert!(matches!(e, RpcError::Unavailable { .. }), "{e:?}");
        }

        #[test]
        fn non_filesystem_addresses_pass() {
            assert!(verify_address("\\\\.\\pipe\\plur1bus-x-core").is_ok());
            assert!(verify_address("relative.sock").is_ok());
        }
    }
}
