use plur1bus_desktop::{
    controller::watch::{Action, Observation, Watch},
    runtime::RuntimeKind,
};
#[test]
fn five_failures_in_ten_minutes_is_crashed_and_stops_restarting() {
    let mut w = Watch::new(RuntimeKind::Apple);
    let mut now = 0;
    for expected in [1, 2, 4, 8, 16] {
        assert_eq!(w.observe(now, Observation::Dead), Action::Wait);
        now += expected;
        assert_eq!(w.observe(now, Observation::Dead), Action::Restart);
        w.failed(now);
    }
    assert_eq!(w.observe(now + 60, Observation::Dead), Action::Crashed);
    assert_eq!(w.observe(now + 61, Observation::Dead), Action::Crashed);
    w.manual_start();
    assert_ne!(w.observe(now + 62, Observation::Dead), Action::Crashed);
}
#[test]
fn docker_restart_policy_is_given_20_seconds_first() {
    let mut w = Watch::new(RuntimeKind::Docker);
    assert_eq!(w.observe(0, Observation::Dead), Action::Wait);
    assert_eq!(w.observe(19, Observation::Dead), Action::Wait);
    assert_eq!(w.observe(20, Observation::Dead), Action::Restart);
}
#[test]
fn runtime_gone_is_reported_not_switched() {
    let mut w = Watch::new(RuntimeKind::Docker);
    assert_eq!(w.observe(0, Observation::RuntimeMissing), Action::Wait);
    assert_eq!(
        w.observe(60, Observation::RuntimeMissing),
        Action::RuntimeDown
    );
}
#[test]
fn wake_gap_triggers_meta_recheck_and_apple_system_restart_after_30s() {
    let mut w = Watch::new(RuntimeKind::Apple);
    assert_eq!(w.observe(0, Observation::Healthy), Action::Ready);
    assert_eq!(w.observe(40, Observation::Healthy), Action::RecheckMeta);
    assert_eq!(w.observe(45, Observation::MetaUnavailable), Action::Wait);
    assert_eq!(
        w.observe(70, Observation::MetaUnavailable),
        Action::RestartRuntime
    );
}
#[tokio::test(start_paused = true)]
async fn docker_socket_wait_is_bounded_to_120s() {
    let start = tokio::time::Instant::now();
    let result =
        plur1bus_desktop::controller::autostart::wait_socket(|| async { None::<()> }).await;
    assert_eq!(result, Err("runtime.timeout"));
    assert_eq!(start.elapsed(), std::time::Duration::from_secs(120));
}
#[tokio::test(start_paused = true)]
async fn saved_socket_becomes_available_without_selecting_a_different_runtime() {
    let count = std::sync::atomic::AtomicU32::new(0);
    let result = plur1bus_desktop::controller::autostart::wait_socket(|| async {
        (count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 3).then_some("saved-endpoint")
    })
    .await;
    assert_eq!(result, Ok("saved-endpoint"));
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 4);
}
#[test]
fn unhealthy_first_observation_after_sleep_also_recovers_apple() {
    let mut w = Watch::new(RuntimeKind::Apple);
    assert_eq!(w.observe(0, Observation::Healthy), Action::Ready);
    assert_eq!(w.observe(40, Observation::MetaUnavailable), Action::Wait);
    assert_eq!(w.observe(69, Observation::MetaUnavailable), Action::Wait);
    assert_eq!(
        w.observe(70, Observation::MetaUnavailable),
        Action::RestartRuntime
    );
}
