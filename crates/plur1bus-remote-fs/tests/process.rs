//! Actual helper process acceptance: private keys use raw stdin frames, and only bounded metadata/data leave stdout.
mod support;
use serde_json::{json, Value};
use std::io::{Cursor, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroize;

fn frame(body: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
}
fn packet(value: Value, out: &mut Vec<u8>) {
    frame(&serde_json::to_vec(&value).unwrap(), out);
}
fn config(server: &support::Fixture, mode: &str) -> Value {
    json!({"v":1,"mode":mode,"ip":server.ip,"port":server.port,"username":"fixture","hostKeySha256":server.fingerprint,
        "deadlineMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64+10_000})
}
async fn run(mut input: Vec<u8>) -> std::process::Output {
    tokio::task::spawn_blocking(move || {
        let mut child = Command::new(env!("CARGO_BIN_EXE_plur1bus-remote-fs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        input.zeroize();
        child.wait_with_output().unwrap()
    })
    .await
    .unwrap()
}
fn response(input: &mut Cursor<Vec<u8>>) -> Vec<u8> {
    let mut header = [0; 4];
    input.read_exact(&mut header).unwrap();
    let n = u32::from_be_bytes(header) as usize;
    assert!(n <= 1024 * 1024);
    let mut bytes = vec![0; n];
    input.read_exact(&mut bytes).unwrap();
    bytes
}
fn json_response(input: &mut Cursor<Vec<u8>>) -> Value {
    serde_json::from_slice(&response(input)).unwrap()
}

#[tokio::test]
async fn a_pinned_host_is_acknowledged_before_the_worker_accepts_any_private_key() {
    let root = tempfile::tempdir().unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut input = Vec::new();
    packet(config(&server, "connect"), &mut input);
    // EOF follows metadata: no raw private-key frame was produced or sent.
    let output = run(input).await;
    let mut stdout = Cursor::new(output.stdout);
    let host = json_response(&mut stdout);
    assert_eq!(host["phase"], "host-key-verified");
    assert_eq!(host["hostKeySha256"], server.fingerprint);
    assert_eq!(server.counts.auth.load(Ordering::SeqCst), 0);
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn probe_discloses_the_actual_negotiated_host_key_algorithm_without_authentication() {
    let root = tempfile::tempdir().unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut input = Vec::new();
    packet(config(&server, "probeHostKey"), &mut input);
    let output = run(input).await;
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let mut stdout = Cursor::new(output.stdout);
    let value = json_response(&mut stdout);
    assert_eq!(value["hostKeySha256"], server.fingerprint);
    assert_eq!(value["hostKeyAlgorithm"], "ssh-ed25519");
    assert_eq!(server.counts.auth.load(Ordering::SeqCst), 0);
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn private_key_pipe_and_six_read_operations_emit_only_metadata_and_file_data() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("first-home")).unwrap();
    std::fs::write(
        root.path().join("first-home/config.json"),
        b"fixture source",
    )
    .unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let private = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut input = Vec::new();
    packet(config(&server, "connect"), &mut input);
    frame(private.as_bytes(), &mut input);
    for value in [
        json!({"id":1,"op":"stat","path":"/first-home/config.json"}),
        json!({"id":2,"op":"lstat","path":support::LINK}),
        json!({"id":3,"op":"readdir","path":"/"}),
        json!({"id":4,"op":"read","path":"/first-home/config.json","offset":0,"length":64}),
        json!({"id":5,"op":"realpath","path":support::LINK}),
        json!({"id":6,"op":"readlink","path":support::LINK}),
        json!({"id":7,"op":"close"}),
    ] {
        packet(value, &mut input);
    }
    let output = run(input).await;
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(!String::from_utf8_lossy(&output.stdout).contains(private.as_str()));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE KEY"));
    let mut stdout = Cursor::new(output.stdout);
    assert_eq!(
        json_response(&mut stdout)["hostKeySha256"],
        server.fingerprint
    );
    assert_eq!(
        json_response(&mut stdout)["hostKeySha256"],
        server.fingerprint
    );
    assert_eq!(json_response(&mut stdout)["metadata"]["kind"], "file");
    assert_eq!(json_response(&mut stdout)["metadata"]["kind"], "symlink");
    assert_eq!(json_response(&mut stdout)["entries"], json!(["first-home"]));
    assert_eq!(json_response(&mut stdout)["bytes"], 14);
    assert_eq!(response(&mut stdout), b"fixture source");
    assert_eq!(json_response(&mut stdout)["path"], support::LINK_TARGET);
    assert_eq!(json_response(&mut stdout)["path"], support::LINK_TARGET);
    assert_eq!(json_response(&mut stdout)["id"], 7);
    assert_eq!(stdout.position(), stdout.get_ref().len() as u64);
}

#[tokio::test]
async fn unknown_operations_after_authentication_never_execute_or_echo_source_values() {
    let root = tempfile::tempdir().unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let private = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut input = Vec::new();
    packet(config(&server, "connect"), &mut input);
    frame(private.as_bytes(), &mut input);
    packet(
        json!({"id":1,"op":"exec","command":"PRIVATE-CANARY"}),
        &mut input,
    );
    let output = run(input).await;
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE-CANARY"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(private.as_str()));
    let mut stdout = Cursor::new(output.stdout);
    assert_eq!(json_response(&mut stdout)["phase"], "host-key-verified");
    assert_eq!(json_response(&mut stdout)["ok"], true);
    assert_eq!(json_response(&mut stdout)["reason"], "invalid-request");
    assert!(server.counts.auth.load(Ordering::SeqCst) > 0);
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_worker_deadline_also_ends_a_connected_client_that_keeps_stdin_open() {
    let root = tempfile::tempdir().unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let private = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut connect = config(&server, "connect");
    connect["deadlineMs"] = json!(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 600
    );
    let mut input = Vec::new();
    packet(connect, &mut input);
    frame(private.as_bytes(), &mut input);
    let started = std::time::Instant::now();
    let output = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(env!("CARGO_BIN_EXE_plur1bus-remote-fs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut keep_open = child.stdin.take().unwrap();
        keep_open.write_all(&input).unwrap();
        input.zeroize();
        let output = child.wait_with_output().unwrap();
        drop(keep_open);
        output
    })
    .await
    .unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    assert!(started.elapsed() < Duration::from_secs(2));
    let mut stdout = Cursor::new(output.stdout);
    assert_eq!(json_response(&mut stdout)["phase"], "host-key-verified");
    assert_eq!(json_response(&mut stdout)["ok"], true);
    assert_eq!(json_response(&mut stdout)["reason"], "timeout");
}

#[tokio::test]
async fn the_requested_metadata_cap_applies_before_deserializing_a_filesystem_request() {
    let root = tempfile::tempdir().unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let private = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut connect = config(&server, "connect");
    connect["limits"] = json!({"metadataBytes":1024});
    let mut input = Vec::new();
    packet(connect, &mut input);
    frame(private.as_bytes(), &mut input);
    packet(
        json!({"id":1,"op":"stat","path":format!("/{}","x".repeat(2000))}),
        &mut input,
    );
    let output = run(input).await;
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let mut stdout = Cursor::new(output.stdout);
    assert_eq!(json_response(&mut stdout)["phase"], "host-key-verified");
    assert_eq!(json_response(&mut stdout)["ok"], true);
    assert_eq!(json_response(&mut stdout)["reason"], "limit-exceeded");
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_private_key_frame_keeps_its_own_64kib_allocation_cap_after_host_pinning() {
    let root = tempfile::tempdir().unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::ssh_key::Algorithm::Ed25519)
            .unwrap();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut input = Vec::new();
    packet(config(&server, "connect"), &mut input);
    // Claimed size only: no body exists and none may be allocated or decoded.
    input.extend_from_slice(&(64 * 1024 + 1_u32).to_be_bytes());
    let output = run(input).await;
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let mut stdout = Cursor::new(output.stdout);
    assert_eq!(json_response(&mut stdout)["phase"], "host-key-verified");
    assert_eq!(
        json_response(&mut stdout),
        json!({"v":1,"ok":false,"code":"E_INVALID_PARAMS","reason":"invalid-request"})
    );
    assert_eq!(stdout.position(), stdout.get_ref().len() as u64);
    assert_eq!(server.counts.auth.load(Ordering::SeqCst), 0);
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}
