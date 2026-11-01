//! Shared listener framing, shutdown, deadline and endpoint-permission contracts.
use plur1bus_rpc::server_transport::Listener;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

fn address(dir: &tempfile::TempDir) -> String {
    #[cfg(unix)]
    {
        dir.path().join("engine.sock").to_str().unwrap().into()
    }
    #[cfg(windows)]
    {
        let _ = dir;
        format!(
            r"\\.\pipe\plur1bus-rpc-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }
}

#[test]
fn bounded_accept_can_be_retried_then_exchange_bytes_with_the_kernel_peer() {
    let dir = tempfile::tempdir().unwrap();
    let address = address(&dir);
    let listener = Listener::bind(&address).unwrap();
    let start = Instant::now();
    for _ in 0..2 {
        assert!(listener
            .accept_timeout(Duration::from_millis(20))
            .unwrap()
            .is_none());
    }
    assert!(start.elapsed() < Duration::from_secs(1));
    let child = std::thread::spawn(move || {
        let mut client =
            plur1bus_rpc::transport::connect(&address, Duration::from_secs(1)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        client.write_all(b"ping").unwrap();
        let mut pong = [0; 4];
        client.read_exact(&mut pong).unwrap();
        assert_eq!(&pong, b"pong");
    });
    let mut accepted = listener
        .accept_timeout(Duration::from_secs(1))
        .unwrap()
        .expect("client connects after earlier accept deadlines");
    assert_eq!(accepted.peer_pid(), Some(std::process::id()));
    accepted
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut ping = [0; 4];
    accepted.read_exact(&mut ping).unwrap();
    assert_eq!(&ping, b"ping");
    accepted.write_all(b"pong").unwrap();
    accepted.flush().unwrap();
    (accepted.drain)();
    child.join().unwrap();
}

#[test]
fn accepted_read_has_a_deadline_and_can_be_closed_from_another_thread() {
    let dir = tempfile::tempdir().unwrap();
    let address = address(&dir);
    let listener = Listener::bind(&address).unwrap();
    let client = plur1bus_rpc::transport::connect(&address, Duration::from_secs(1)).unwrap();
    let mut accepted = listener.accept().unwrap();
    accepted
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    let error = accepted.read(&mut [0]).unwrap_err();
    assert!(matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ));
    let read_timeout = accepted.read_timeout;
    let closer = accepted.closer;
    let mut reader = accepted.reader;
    read_timeout(None).unwrap();
    let blocked = std::thread::spawn(move || reader.read(&mut [0]));
    std::thread::sleep(Duration::from_millis(20));
    closer();
    closer();
    let result = blocked.join().unwrap();
    assert!(matches!(result, Ok(0) | Err(_)));
    drop(client);
}

#[cfg(unix)]
#[test]
fn unix_socket_is_owner_only_and_a_live_name_cannot_be_rebound() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let address = address(&dir);
    let _listener = Listener::bind(&address).unwrap();
    assert_eq!(
        std::fs::metadata(&address).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        Listener::bind(&address).err().unwrap().kind(),
        std::io::ErrorKind::AddrInUse
    );
}

#[cfg(windows)]
#[test]
fn windows_pipe_grants_access_only_to_the_user_and_system() {
    let dir = tempfile::tempdir().unwrap();
    let address = address(&dir);
    let _listener = Listener::bind(&address).unwrap();
    let entries = plur1bus_rpc::win::pipe_dacl_report(&address).unwrap();
    let user = plur1bus_rpc::win::user_sid().unwrap();
    let allowed: Vec<_> = entries.iter().filter(|entry| entry.allow).collect();
    assert_eq!(allowed.len(), 2, "only user and SYSTEM ACEs: {entries:?}");
    assert!(allowed.iter().any(|entry| entry.sid == user));
    assert!(allowed
        .iter()
        .any(|entry| entry.sid == plur1bus_rpc::acl::SYSTEM_SID));
}
