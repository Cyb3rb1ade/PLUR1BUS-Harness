use plur1bus_desktop::{
    notify::*,
    tray::{HarnessState, TrayState},
};
#[derive(Default)]
struct Sink {
    seen: Vec<Banner>,
    fail: bool,
}
impl Notifier for Sink {
    fn show(&mut self, banner: &Banner) -> Result<(), NotifyFailure> {
        if self.fail {
            return Err(NotifyFailure);
        }
        self.seen.push(banner.clone());
        Ok(())
    }
}
#[test]
fn gnome_without_appindicator_notifies_every_state_change() {
    let mut observer = StateObserver::default();
    let mut sink = Sink::default();
    for harness in [
        HarnessState::Starting,
        HarnessState::Ready,
        HarnessState::Degraded,
        HarnessState::Down,
        HarnessState::Unpaired,
        HarnessState::Updating,
        HarnessState::Rollback,
        HarnessState::Crashed,
    ] {
        let state = TrayState {
            harness,
            ..Default::default()
        };
        assert!(observer.changed(false, &state, &mut sink).unwrap());
        assert!(!observer.changed(false, &state, &mut sink).unwrap());
    }
    assert_eq!(sink.seen.len(), 8);
    assert_eq!(sink.seen[1].actions, [Action::Open, Action::Dismiss]);
    assert_eq!(sink.seen[7].actions, [Action::ShowLog, Action::StartAgain]);
    let mut state = TrayState {
        harness: HarnessState::Ready,
        update_available: true,
        ..Default::default()
    };
    observer.changed(false, &state, &mut sink).unwrap();
    assert_eq!(
        sink.seen.last().unwrap().actions,
        [Action::Later, Action::Update]
    );
    state.secrets_locked = true;
    observer.changed(false, &state, &mut sink).unwrap();
    assert_eq!(sink.seen.len(), 10);
}
#[test]
fn failed_notification_retries_and_a_tray_host_suppresses_banners() {
    let mut observer = StateObserver::default();
    let mut sink = Sink {
        fail: true,
        ..Default::default()
    };
    let state = TrayState::default();
    assert!(observer.changed(false, &state, &mut sink).is_err());
    sink.fail = false;
    assert!(observer.changed(false, &state, &mut sink).unwrap());
    assert!(!observer
        .changed(
            true,
            &TrayState {
                harness: HarnessState::Ready,
                ..state
            },
            &mut sink
        )
        .unwrap());
    assert_eq!(sink.seen.len(), 1);
    assert!(observer.changed(false, &state, &mut sink).unwrap());
    assert_eq!(sink.seen.len(), 2);
}
#[test]
fn portal_denial_or_partial_grant_keeps_the_dash_entry_and_reports_actual_autostart() {
    assert!(!BackgroundGrant::default().may_hide(false));
    assert!(!BackgroundGrant {
        background: false,
        autostart: true
    }
    .may_hide(false));
    assert!(BackgroundGrant {
        background: true,
        autostart: false
    }
    .may_hide(false));
    assert!(BackgroundGrant::default().may_hide(true));
    assert_eq!(Action::parse("quit"), None);
    assert_eq!(Action::parse("open"), Some(Action::Open));
    assert_eq!(Action::parse("https://remote.test"), None);
}
