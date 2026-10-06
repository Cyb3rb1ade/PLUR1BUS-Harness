use plur1bus_desktop::events::*;
use plur1bus_desktop::tray::HarnessState;
use std::time::Duration;

#[test]
fn reconnect_policy_caps_and_bounds_jitter() {
    let mut stream = EventStream::default();
    for expected in [1, 2, 4, 8, 16, 30, 30] {
        assert_eq!(stream.next_delay(0.5), Duration::from_secs(expected));
    }
    stream.reset_backoff();
    assert_eq!(stream.next_delay(0.0), Duration::from_millis(800));
    stream.reset_backoff();
    assert_eq!(stream.next_delay(1.0), Duration::from_millis(1200));
}
#[test]
fn bounded_parser_keeps_last_id_and_words_without_exposing_foreign_fields() {
    let mut stream = EventStream::default();
    let update = stream.frame(b"id: 17\nevent: harness.status\ndata: {\"state\":\"ready\",\"secrets\":\"locked\",\"foreign\":\"synthetic\"}\n").unwrap().unwrap();
    assert_eq!(update.state, HarnessState::Ready);
    assert!(update.secrets_locked);
    assert_eq!(update.failure, None);
    assert_eq!(stream.last_event_id(), Some("17"));
    assert!(stream
        .frame(b"id: 18\nevent: harness.status\ndata: broken")
        .is_err());
    assert_eq!(stream.last_event_id(), Some("17"));
    assert!(stream
        .frame(b"id: invalid\0id\nevent: harness.status\ndata: {}\n")
        .is_err());
}

async fn paired() -> (
    plur1bus_mock_harness::MockHandle,
    plur1bus_desktop::connections::Connection,
    plur1bus_desktop::client::HarnessClient,
    plur1bus_desktop::secrets::SecretString,
    tempfile::TempDir,
) {
    use plur1bus_desktop::{
        connections::Store,
        secrets::{token_account, MemoryStore, TokenStore},
    };
    let mock = plur1bus_mock_harness::MockHarness::start(Default::default())
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let tokens = MemoryStore::default();
    let connection = plur1bus_desktop::pair::pair_code(
        &mock.origin,
        &mock.control.create_pair_code(),
        "Synthetic desk",
        &tokens,
        &Store::open(dir.path()),
        None,
    )
    .await
    .unwrap();
    let token = tokens.get(&token_account(connection.id)).unwrap().unwrap();
    let client = plur1bus_desktop::client::HarnessClient::from_connection(&connection)
        .await
        .unwrap();
    (mock, connection, client, token, dir)
}

#[tokio::test]
async fn stream_reconnects_with_backoff_and_last_event_id() {
    let (mock, connection, client, token, _dir) = paired().await;
    let baseline = mock.control.event_cursor();
    let (cancel, stop) = tokio::sync::watch::channel(false);
    let mut stream = EventStream::default();
    let waits = std::sync::Mutex::new(Vec::new());
    let mut dropped = false;
    let mut saw_degraded = false;
    tokio::time::timeout(
        Duration::from_secs(3),
        stream.run_with_timing(
            &client,
            &connection.installation_id,
            &token,
            stop,
            |update| {
                if update.state == HarnessState::Ready && !dropped {
                    dropped = true;
                    mock.control.drop_sse();
                }
                if update.state == HarnessState::Degraded {
                    saw_degraded = true;
                    cancel.send(true).unwrap();
                }
            },
            || 0.5,
            |delay| {
                waits.lock().unwrap().push(delay);
                mock.control.set_status("degraded", "unlocked");
                std::future::ready(())
            },
        ),
    )
    .await
    .unwrap();
    assert!(saw_degraded);
    assert_eq!(*waits.lock().unwrap(), vec![Duration::from_secs(1)]);
    assert_eq!(
        mock.control.recorded_event_replay_ids(),
        vec![None, Some(baseline.to_string())]
    );
    assert_eq!(
        stream.last_event_id(),
        Some((baseline + 1).to_string().as_str())
    );
    let event_requests: Vec<_> = mock
        .control
        .recorded_requests()
        .into_iter()
        .filter(|(path, _)| path.ends_with("/events"))
        .collect();
    assert_eq!(event_requests.len(), 2);
    assert!(event_requests.iter().all(|(_, bearer)| *bearer));
}

#[tokio::test]
async fn revoked_stream_goes_unpaired_and_stops() {
    let (mock, connection, client, token, _dir) = paired().await;
    let (_cancel, stop) = tokio::sync::watch::channel(false);
    let mut stream = EventStream::default();
    let mut revoked = false;
    let mut states = Vec::new();
    let mut failures = Vec::new();
    let mut waits = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(3),
        stream.run_with_timing(
            &client,
            &connection.installation_id,
            &token,
            stop,
            |update| {
                states.push(update.state);
                failures.push(update.failure);
                if update.state == HarnessState::Ready && !revoked {
                    revoked = true;
                    mock.control.revoke_device(&connection.device_id);
                }
            },
            || 0.5,
            |delay| {
                waits.push(delay);
                std::future::ready(())
            },
        ),
    )
    .await
    .unwrap();
    assert_eq!(states.last(), Some(&HarnessState::Unpaired));
    assert_eq!(failures.last(), Some(&Some(SessionFailure::Revoked)));
    assert_eq!(waits, vec![Duration::from_secs(1)]);
    assert_eq!(mock.control.recorded_event_replay_ids().len(), 2);
}
