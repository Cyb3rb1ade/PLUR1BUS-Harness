//! Native EOF handling must drain valid bytes without disabling a live peer's deadline.
#![cfg(unix)]

use plur1bus_rpc::transport;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn a_closed_peer_can_be_drained_after_updating_positive_timeouts() {
    let directory = tempfile::tempdir().unwrap();
    let address = directory.path().join("peer.sock");
    let listener = UnixListener::bind(&address).unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.write_all(b"complete reply\n").unwrap();
    });
    let mut stream = transport::connect(address.to_str().unwrap(), Duration::from_secs(1)).unwrap();
    server.join().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    assert!(stream.set_read_timeout(Some(Duration::ZERO)).is_err());
    assert!(stream.set_write_timeout(Some(Duration::ZERO)).is_err());
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"complete reply\n");
}

#[test]
fn an_open_peer_still_obeys_the_configured_read_timeout() {
    let directory = tempfile::tempdir().unwrap();
    let address = directory.path().join("peer.sock");
    let listener = UnixListener::bind(&address).unwrap();
    let (release, held) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        held.recv_timeout(Duration::from_secs(2)).unwrap();
    });
    let mut stream = transport::connect(address.to_str().unwrap(), Duration::from_secs(1)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let (finished, result) = mpsc::channel();
    let reader = std::thread::spawn(move || finished.send(stream.read(&mut [0])).unwrap());
    let read = result.recv_timeout(Duration::from_secs(1));
    release.send(()).unwrap();
    server.join().unwrap();
    reader.join().unwrap();
    assert!(matches!(read.unwrap(), Err(error) if matches!(error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)));
}
