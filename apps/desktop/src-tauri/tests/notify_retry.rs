#![cfg(unix)]
use plur1bus_desktop::{
    gnome::next_notice,
    tray::{HarnessState, TrayState},
};
use std::time::Duration;
#[tokio::test]
async fn cancelled_native_retry_keeps_failed_state_before_later_events() {
    let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
    let failed = (
        7,
        TrayState {
            harness: HarnessState::Down,
            ..Default::default()
        },
    );
    let later = (
        7,
        TrayState {
            harness: HarnessState::Ready,
            ..Default::default()
        },
    );
    let mut pending = Some(failed.clone());
    sender.send(later.clone()).await.unwrap();
    assert!(tokio::time::timeout(
        Duration::from_millis(20),
        next_notice(&mut receiver, &pending)
    )
    .await
    .is_err());
    assert_eq!(pending, Some(failed.clone()));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), next_notice(&mut receiver, &pending))
            .await
            .unwrap(),
        Some(failed)
    );
    pending = None; // production acknowledges only after a successful native Notify.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), next_notice(&mut receiver, &pending))
            .await
            .unwrap(),
        Some(later)
    );
}
