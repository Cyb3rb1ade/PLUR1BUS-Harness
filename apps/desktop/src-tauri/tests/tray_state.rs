use plur1bus_desktop::tray::*;
use serde_json::json;

#[test]
fn map_status_table() {
    for (state, expected) in [
        ("starting", HarnessState::Starting),
        ("ready", HarnessState::Ready),
        ("degraded", HarnessState::Degraded),
        ("down", HarnessState::Down),
        ("unpaired", HarnessState::Unpaired),
        ("updating", HarnessState::Updating),
        ("rollback", HarnessState::Rollback),
        ("crashed", HarnessState::Crashed),
        ("unknown", HarnessState::Degraded),
    ] {
        assert_eq!(map_status(&json!({"state":state})), expected);
    }
    assert_eq!(map_status(&json!({})), HarnessState::Degraded);
}

#[test]
fn combine_table() {
    let ctl = HarnessStatus::default();
    let upd = UpdateModelState::default();
    assert_eq!(
        combine(&ctl, HarnessState::Ready, &upd).harness,
        HarnessState::Ready
    );
    let crashed = HarnessStatus {
        crashed: true,
        ..Default::default()
    };
    assert_eq!(
        combine(&crashed, HarnessState::Ready, &upd).harness,
        HarnessState::Crashed
    );
    for runtime in [RuntimeState::Missing, RuntimeState::Stopped] {
        let ctl = HarnessStatus {
            runtime: Some(runtime),
            ..Default::default()
        };
        let got = combine(&ctl, HarnessState::Ready, &upd);
        assert_eq!(got.harness, HarnessState::Down);
        assert_eq!(got.runtime, Some(runtime));
    }
    for (updating, rollback, expected) in [
        (true, false, HarnessState::Updating),
        (false, true, HarnessState::Rollback),
    ] {
        let upd = UpdateModelState {
            updating,
            rollback,
            available: true,
            held: true,
        };
        let got = combine(&crashed, HarnessState::Ready, &upd);
        assert_eq!(got.harness, expected);
        assert!(got.update_available && got.held);
    }
    assert!(
        combine(
            &HarnessStatus {
                secrets_locked: true,
                ..Default::default()
            },
            HarnessState::Ready,
            &upd
        )
        .secrets_locked
    );
}

#[test]
fn every_state_keeps_words_and_maps_to_the_four_badge_shapes() {
    for state in [
        HarnessState::Starting,
        HarnessState::Ready,
        HarnessState::Degraded,
        HarnessState::Down,
        HarnessState::Unpaired,
        HarnessState::Updating,
        HarnessState::Rollback,
        HarnessState::Crashed,
    ] {
        let value = combine(
            &HarnessStatus::default(),
            state,
            &UpdateModelState {
                available: true,
                ..Default::default()
            },
        );
        assert!(!state.words().is_empty());
        assert_eq!(
            value.badge(),
            match state {
                HarnessState::Starting | HarnessState::Updating => Badge::Busy,
                HarnessState::Ready => Badge::Update,
                _ => Badge::Attention,
            }
        );
    }
    assert_eq!(
        combine(
            &HarnessStatus::default(),
            HarnessState::Ready,
            &UpdateModelState::default()
        )
        .badge(),
        Badge::Running
    );
}
