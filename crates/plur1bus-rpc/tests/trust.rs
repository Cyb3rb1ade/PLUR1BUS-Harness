//! Audit M2: a client refuses an untrusted `run/` and sends nothing. Unix only: the checks are about owners and modes.
#![cfg(unix)]

use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use std::io::Read;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::time::{Duration, Instant};

const TOKEN: &str = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";

fn mode(p: &Path, m: u32) {
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
}

/// A listener that records whether anyone connected or sent a byte, in a `run/` of the given mode.
fn fake_core(run: &Path) -> (String, UnixListener) {
    std::fs::create_dir_all(run).unwrap();
    let path = run.join("core.sock");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    (path.to_string_lossy().into_owned(), listener)
}

/// True when nothing connected to the listener within a short window, or what connected sent no byte.
fn nothing_received(listener: &UnixListener) -> bool {
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        if let Ok((mut s, _)) = listener.accept() {
            s.set_read_timeout(Some(Duration::from_millis(200)))
                .unwrap();
            let mut b = [0u8; 1];
            return !matches!(s.read(&mut b), Ok(n) if n > 0);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

fn refusal_reason(r: Result<Client, RpcError>) -> String {
    match r {
        Err(RpcError::Call {
            error: ErrorCode::EUnauthorized,
            reason: Some(r),
            ..
        }) => r,
        Err(other) => panic!("expected E_UNAUTHORIZED, got {other:?}"),
        Ok(_) => panic!("the client connected"),
    }
}

#[test]
fn a_group_writable_run_dir_is_refused_and_nothing_is_sent() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    let (addr, listener) = fake_core(&run);
    mode(&run, 0o770);
    let r = Client::connect(&addr, TOKEN, ConnectOptions::default());
    assert_eq!(refusal_reason(r), "run-dir-untrusted");
    assert!(
        nothing_received(&listener),
        "the token must not reach the socket"
    );
}

#[test]
fn a_symlinked_run_dir_is_refused_and_nothing_is_sent() {
    let home = tempfile::tempdir().unwrap();
    let real = home.path().join("planted");
    let (_addr, listener) = fake_core(&real);
    mode(&real, 0o700);
    let run = home.path().join("run");
    symlink(&real, &run).unwrap();
    let addr = run.join("core.sock").to_string_lossy().into_owned();
    let r = Client::connect(&addr, TOKEN, ConnectOptions::default());
    assert_eq!(refusal_reason(r), "run-dir-untrusted");
    assert!(nothing_received(&listener));
}

#[test]
fn a_private_run_dir_still_connects_to_the_handshake() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    let (addr, _listener) = fake_core(&run);
    mode(&run, 0o700);
    // The listener never answers, so the handshake times out: reaching it proves the trust checks passed.
    let r = Client::connect(
        &addr,
        TOKEN,
        ConnectOptions {
            connect_timeout: Duration::from_millis(100),
            ..ConnectOptions::default()
        },
    );
    assert!(
        matches!(&r, Err(RpcError::Unavailable { reason, .. }) if reason == "handshake-timeout" || reason == "closed"),
        "{:?}",
        r.err()
    );
}

#[test]
fn a_missing_socket_is_still_core_unavailable() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    mode(&run, 0o700);
    let addr = run.join("core.sock").to_string_lossy().into_owned();
    let r = Client::connect(&addr, TOKEN, ConnectOptions::default());
    assert!(
        matches!(&r, Err(RpcError::Unavailable { reason, .. }) if reason == "core-unavailable"),
        "{:?}",
        r.err()
    );
}
