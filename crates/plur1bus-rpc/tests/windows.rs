//! Windows transport and pipe checks (ruling S11): the server-pid check before the token is sent, overlapped reads
//! with a real deadline, and the DACL helpers. Each test serves its own uniquely named pipe from this process.
#![cfg(windows)]
use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::win::{pipe_dacl_report, user_sid, writable_by_others};
use plur1bus_rpc::{Client, ConnectOptions, RpcError};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn pipe_name(tag: &str) -> String {
    format!(
        r"\\.\pipe\plur1bus-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

/// One synchronous pipe instance with the default DACL (a null SECURITY_ATTRIBUTES).
fn instance(name: &str) -> OwnedHandle {
    let wide: Vec<u16> = std::ffi::OsStr::new(name)
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: `wide` is NUL-terminated; null security attributes mean the default DACL.
    let h = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            std::ptr::null(),
        )
    };
    assert_ne!(
        h,
        INVALID_HANDLE_VALUE,
        "{}",
        std::io::Error::last_os_error()
    );
    // SAFETY: a new handle we own.
    unsafe { OwnedHandle::from_raw_handle(h) }
}

/// Serves `name` from this process: answers `core.auth` with a hello naming this pid, `echo` with its params, and
/// never answers `never`. Returns how many lines it has received.
fn serve(name: &str) -> Arc<AtomicUsize> {
    let seen = Arc::new(AtomicUsize::new(0));
    let first = instance(name);
    let name = name.to_string();
    let counter = seen.clone();
    std::thread::spawn(move || {
        let mut next = Some(first);
        loop {
            let h = next.take().unwrap_or_else(|| instance(&name));
            // SAFETY: a valid synchronous instance; blocks until a client connects (or has connected).
            unsafe {
                ConnectNamedPipe(
                    std::os::windows::io::AsRawHandle::as_raw_handle(&h),
                    std::ptr::null_mut(),
                )
            };
            next = Some(instance(&name));
            let file = File::from(h);
            let mut w = file.try_clone().unwrap();
            let counter = counter.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(file).lines() {
                    let Ok(line) = line else { return };
                    counter.fetch_add(1, Ordering::SeqCst);
                    let msg: Value = serde_json::from_str(&line).unwrap();
                    let id = msg["id"].clone();
                    let reply = match msg["method"].as_str().unwrap() {
                        "core.auth" => json!({"jsonrpc":"2.0","id":id,"result":{
                            "contract":"1.7.0","rpc":"1.2.0","instanceId":"i","pid":std::process::id()}}),
                        "echo" => json!({"jsonrpc":"2.0","id":id,"result":msg["params"]}),
                        _ => continue, // `never`: no answer
                    };
                    if writeln!(w, "{reply}").and_then(|_| w.flush()).is_err() {
                        return;
                    }
                }
            });
        }
    });
    seen
}

#[test]
fn a_pipe_whose_server_pid_mismatches_is_refused() {
    let name = pipe_name("mismatch");
    let seen = serve(&name);
    let e = Client::connect(
        &name,
        TOKEN,
        ConnectOptions {
            expected_server_pid: Some(1),
            ..Default::default()
        },
    )
    .err()
    .expect("a pipe served by another pid must be refused");
    match e {
        RpcError::Call {
            error: ErrorCode::EUnauthorized,
            reason,
            ..
        } => assert_eq!(reason.as_deref(), Some("pipe-server-mismatch")),
        other => panic!("expected E_UNAUTHORIZED, got {other:?}"),
    }
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(seen.load(Ordering::SeqCst), 0, "the token was sent");
    // The right pid passes, and so does no expectation.
    let c = Client::connect(
        &name,
        TOKEN,
        ConnectOptions {
            expected_server_pid: Some(std::process::id()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(c.peer_pid(), Some(std::process::id()));
    Client::connect(&name, TOKEN, ConnectOptions::default()).unwrap();
}

#[test]
fn a_read_times_out_and_poisons_on_windows() {
    let name = pipe_name("timeout");
    serve(&name);
    let call_timeout = Duration::from_millis(300);
    let mut c = Client::connect(
        &name,
        TOKEN,
        ConnectOptions {
            call_timeout,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(c.call("echo", json!({"x": 1})).unwrap(), json!({"x": 1}));
    let t0 = Instant::now();
    match c.call("never", json!({})) {
        Err(RpcError::Unavailable { reason, .. }) => assert_eq!(reason, "call-timeout"),
        other => panic!("expected call-timeout, got {other:?}"),
    }
    let took = t0.elapsed();
    assert!(
        took < call_timeout + Duration::from_millis(500),
        "the read deadline took {took:?}"
    );
    assert!(took >= call_timeout - Duration::from_millis(50), "{took:?}");
    match c.call("echo", json!({})) {
        Err(RpcError::Unavailable { reason, .. }) => assert_eq!(reason, "poisoned"),
        other => panic!("expected poisoned, got {other:?}"),
    }
}

#[test]
fn a_handshake_with_a_silent_server_times_out() {
    // A server that accepts but never answers, not even core.auth: bounded by the connect timeout.
    let name = pipe_name("silent");
    let first = instance(&name);
    std::thread::spawn(move || {
        // SAFETY: a valid instance; blocks until the client connects, then holds the connection open.
        unsafe {
            ConnectNamedPipe(
                std::os::windows::io::AsRawHandle::as_raw_handle(&first),
                std::ptr::null_mut(),
            )
        };
        std::thread::sleep(Duration::from_secs(10));
        drop(first);
    });
    let t0 = Instant::now();
    let e = Client::connect(
        &name,
        TOKEN,
        ConnectOptions {
            connect_timeout: Duration::from_millis(300),
            ..Default::default()
        },
    )
    .err()
    .expect("a silent server must time out");
    assert!(
        matches!(&e, RpcError::Unavailable { reason, .. } if reason == "handshake-timeout"),
        "{e:?}"
    );
    assert!(
        t0.elapsed() < Duration::from_millis(1500),
        "{:?}",
        t0.elapsed()
    );
}

#[test]
fn user_sid_is_a_user_string_sid() {
    let sid = user_sid().unwrap();
    assert!(sid.starts_with("S-1-5-"), "{sid}");
}

#[test]
fn a_default_dacl_pipe_is_not_writable_by_others() {
    let name = pipe_name("dacl");
    let _serving = serve(&name);
    let entries = pipe_dacl_report(&name).unwrap();
    assert!(!entries.is_empty());
    let sid = user_sid().unwrap();
    assert_eq!(
        writable_by_others(&entries, &sid),
        Vec::<String>::new(),
        "{entries:?}"
    );
}
