//! Real SSH/SFTP acceptance: two source homes, host-key-before-auth, run budgets and no private-key output (E8).
mod support;
use plur1bus_remote_fs::protocol::{Connect, Limits};
use plur1bus_remote_fs::{Failure, ReadonlySession};
use russh::keys::{
    ssh_key::{Algorithm, LineEnding},
    PrivateKey,
};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn config(server: &support::Fixture) -> Connect {
    serde_json::from_value(serde_json::json!({"v":1,"mode":"connect","ip":server.ip,"port":server.port,"username":"fixture",
        "hostKeySha256":server.fingerprint,"deadlineMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64+10_000})).unwrap()
}

fn key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}
fn encoded(key: &PrivateKey) -> Vec<u8> {
    key.to_openssh(LineEnding::LF).unwrap().as_bytes().to_vec()
}
fn source(root: &std::path::Path) {
    std::fs::create_dir_all(root.join("first-home")).unwrap();
    std::fs::create_dir_all(root.join("second-home")).unwrap();
    std::fs::write(root.join("first-home/config.json"), br#"{"agents":{}}"#).unwrap();
    std::fs::write(root.join("second-home/config.yaml"), b"model: example\n").unwrap();
}

#[tokio::test]
async fn all_six_operations_read_real_two_source_homes_files_over_sftp() {
    let root = tempfile::tempdir().unwrap();
    source(root.path());
    let key = key();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config(&server), &mut secret)
        .await
        .unwrap();
    assert!(secret.iter().all(|byte| *byte == 0));
    assert_eq!(
        session.stat("/first-home/config.json").await.unwrap().kind,
        "file"
    );
    assert_eq!(session.lstat(support::LINK).await.unwrap().kind, "symlink");
    assert_eq!(
        session.readdir("/").await.unwrap(),
        ["first-home", "second-home"]
    );
    assert_eq!(
        session
            .read("/second-home/config.yaml", 0, 64)
            .await
            .unwrap(),
        b"model: example\n"
    );
    assert_eq!(
        session.realpath(support::LINK).await.unwrap(),
        support::LINK_TARGET
    );
    assert_eq!(
        session.readlink(support::LINK).await.unwrap(),
        support::LINK_TARGET
    );
    session.close().await.unwrap();
    assert!(server.counts.reads.load(Ordering::SeqCst) > 0);
}

#[tokio::test]
async fn a_changed_host_key_aborts_before_authentication_or_any_filesystem_operation() {
    let root = tempfile::tempdir().unwrap();
    source(root.path());
    let key = key();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut config = config(&server);
    config.host_key_sha256 = Some(format!("SHA256:{}", "A".repeat(43)));
    let mut secret = encoded(&key);
    let result = ReadonlySession::connect(&config, &mut secret).await;
    assert!(matches!(result, Err(Failure::HostKeyMismatch)));
    assert!(secret.iter().all(|byte| *byte == 0));
    assert_eq!(server.counts.auth.load(Ordering::SeqCst), 0);
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn probing_the_host_key_uses_no_private_key_authentication_or_filesystem_request() {
    let root = tempfile::tempdir().unwrap();
    let key = key();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut config = config(&server);
    config.mode = plur1bus_remote_fs::protocol::Mode::ProbeHostKey;
    config.host_key_sha256 = None;
    assert_eq!(
        ReadonlySession::probe(&config)
            .await
            .unwrap()
            .host_key_sha256,
        server.fingerprint
    );
    assert_eq!(server.counts.auth.load(Ordering::SeqCst), 0);
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn file_and_total_read_budgets_count_before_returning_excess_data() {
    let root = tempfile::tempdir().unwrap();
    source(root.path());
    let key = key();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut config = config(&server);
    let cap = b"model: example\n".len() as u64;
    config.limits = Limits {
        file_bytes: cap,
        read_bytes: cap,
        ..Default::default()
    };
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    assert_eq!(
        session
            .read("/second-home/config.yaml", 0, cap as u32)
            .await
            .unwrap(),
        b"model: example\n"
    );
    assert_eq!(
        session
            .read("/second-home/config.yaml", 0, 1)
            .await
            .unwrap_err(),
        Failure::Limit
    );
    assert_eq!(
        session
            .read("/second-home/config.yaml", cap, 1)
            .await
            .unwrap_err(),
        Failure::Limit
    );
}

#[tokio::test]
async fn the_absolute_deadline_bounds_a_server_that_stalls_a_read() {
    let root = tempfile::tempdir().unwrap();
    source(root.path());
    let key = key();
    let server = support::start(
        root.path().into(),
        key.public_key().clone(),
        Duration::from_secs(3),
    )
    .await;
    let mut config = config(&server);
    config.deadline_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 600;
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    assert_eq!(
        session
            .read("/second-home/config.yaml", 0, 1)
            .await
            .unwrap_err(),
        Failure::Timeout
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn an_oversized_file_is_refused_before_the_first_data_packet() {
    let root = tempfile::tempdir().unwrap();
    source(root.path());
    let key = key();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut config = config(&server);
    config.limits.file_bytes = 1;
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    assert_eq!(
        session
            .read("/second-home/config.yaml", 0, 1)
            .await
            .unwrap_err(),
        Failure::Limit
    );
    assert_eq!(server.counts.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn entries_depth_and_operation_counters_cannot_be_reset_by_another_request() {
    let root = tempfile::tempdir().unwrap();
    source(root.path());
    let key = key();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut config = config(&server);
    config.limits.entries = 1;
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    assert_eq!(session.readdir("/").await.unwrap_err(), Failure::Limit);
    assert_eq!(session.readdir("/").await.unwrap_err(), Failure::Limit);
    session.close().await.unwrap();
    config.limits = Limits {
        depth: 0,
        ..Default::default()
    };
    let baseline = server.counts.filesystem.load(Ordering::SeqCst);
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    assert_eq!(
        session.stat("/first-home/config.json").await.unwrap_err(),
        Failure::PathDenied
    );
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), baseline);
    session.close().await.unwrap();
    config.limits = Limits {
        requests: 1,
        ..Default::default()
    };
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    session.stat("/first-home/config.json").await.unwrap();
    assert_eq!(
        session.stat("/first-home/config.json").await.unwrap_err(),
        Failure::Limit
    );
}

#[tokio::test]
async fn directory_metadata_and_packet_budgets_reject_excess_responses_within_the_deadline() {
    let root = tempfile::tempdir().unwrap();
    let key = key();
    for index in 0..40 {
        std::fs::write(
            root.path().join(format!("{index:02}-{}", "x".repeat(180))),
            b"fixture",
        )
        .unwrap();
    }
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut config = config(&server);
    config.limits.metadata_bytes = 1024;
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    assert_eq!(session.readdir("/").await.unwrap_err(), Failure::Limit);
    session.close().await.unwrap();
    config.limits = Limits {
        packet_bytes: 4096,
        ..Default::default()
    };
    config.deadline_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 600;
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let error = session.readdir("/").await.unwrap_err();
    assert!(matches!(
        error,
        Failure::Protocol | Failure::Timeout | Failure::Limit
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn a_wrong_private_key_is_wiped_and_cannot_read_any_source_data() {
    let root = tempfile::tempdir().unwrap();
    source(root.path());
    let allowed = key();
    let wrong = key();
    let server = support::start(
        root.path().into(),
        allowed.public_key().clone(),
        Duration::ZERO,
    )
    .await;
    let mut secret = encoded(&wrong);
    let result = ReadonlySession::connect(&config(&server), &mut secret).await;
    assert!(matches!(result, Err(Failure::Authentication)));
    assert!(secret.iter().all(|byte| *byte == 0));
    assert!(server.counts.auth.load(Ordering::SeqCst) > 0);
    assert_eq!(server.counts.filesystem.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_read_cannot_request_more_data_than_fits_the_incoming_packet_budget() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("source.bin"), vec![b'x'; 8192]).unwrap();
    let key = key();
    let server = support::start(root.path().into(), key.public_key().clone(), Duration::ZERO).await;
    let mut config = config(&server);
    config.limits.packet_bytes = 4096;
    config.deadline_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 600;
    let mut secret = encoded(&key);
    let mut session = ReadonlySession::connect(&config, &mut secret)
        .await
        .unwrap();
    assert_eq!(
        session.read("/source.bin", 0, 8192).await.unwrap_err(),
        Failure::Limit
    );
    assert_eq!(server.counts.reads.load(Ordering::SeqCst), 0);
}
