use plur1bus_desktop::lifecycle::*;
use std::{cell::RefCell, sync::Arc};

#[derive(Default)]
struct Windows {
    spa: bool,
    calls: RefCell<Vec<String>>,
}
impl WindowHost for Windows {
    fn exists(&self, label: &str) -> bool {
        label == "shell" || (label == "spa" && self.spa)
    }
    fn present(&self, label: &str) -> Result<(), WindowFailure> {
        self.calls.borrow_mut().push(format!("present:{label}"));
        Ok(())
    }
    fn hide(&self, label: &str) -> Result<(), WindowFailure> {
        self.calls.borrow_mut().push(format!("hide:{label}"));
        Ok(())
    }
    fn minimize(&self, label: &str) -> Result<(), WindowFailure> {
        self.calls.borrow_mut().push(format!("minimize:{label}"));
        Ok(())
    }
}
#[test]
fn second_instance_focuses_the_first() {
    for spa in [false, true] {
        let windows = Windows {
            spa,
            ..Default::default()
        };
        focus_first(&windows).unwrap();
        assert_eq!(
            *windows.calls.borrow(),
            vec![if spa { "present:spa" } else { "present:shell" }]
        );
    }
}
#[test]
fn close_hides_but_gnome_without_background_support_keeps_a_dash_entry() {
    let windows = Windows::default();
    close_resident(&windows, "shell", true).unwrap();
    close_resident(&windows, "shell", false).unwrap();
    assert_eq!(
        *windows.calls.borrow(),
        vec!["hide:shell", "minimize:shell"]
    );
}
#[test]
fn quit_asks_and_defaults_to_keep_running() {
    let state = QuitSession::default();
    assert!(!state.is_approved());
    assert_eq!(state.request(false).choice, QuitChoice::KeepRunning);
    assert!(state.is_pending());
    assert!(!state.request(false).can_stop_harness);
    state.cancel();
    assert!(!state.is_pending());
    assert!(state.approve(QuitChoice::StopBundled, false).is_err());
    assert!(!state.is_approved());
    state.request(true);
    assert!(state.request(true).can_stop_harness);
    state.approve(QuitChoice::KeepRunning, true).unwrap();
    assert!(state.is_approved());
}
#[tokio::test]
async fn new_connection_aborts_previous_task_and_stale_callbacks_cannot_change_state() {
    let owner = Arc::new(EventOwner::default());
    let first = owner.begin();
    let (started, startup) = tokio::sync::oneshot::channel();
    let (dropped, done) = tokio::sync::oneshot::channel();
    struct Guard(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = self.0.take().unwrap().send(());
        }
    }
    let task = tokio::spawn(async move {
        let _guard = Guard(Some(dropped));
        started.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    owner.install(first, task);
    tokio::time::timeout(std::time::Duration::from_secs(1), startup)
        .await
        .unwrap()
        .unwrap();
    let second = owner.begin();
    tokio::time::timeout(std::time::Duration::from_secs(1), done)
        .await
        .unwrap()
        .unwrap();
    assert!(owner
        .with_current(first, || panic!("stale update applied"))
        .is_none());
    assert_eq!(owner.with_current(second, || 7), Some(7));
    let task = tokio::spawn(std::future::pending());
    let aborted = task.abort_handle();
    assert!(!owner.install(first, task));
    tokio::task::yield_now().await;
    assert!(aborted.is_finished());
    owner.stop();
    assert!(owner
        .with_current(second, || panic!("shutdown update applied"))
        .is_none());
}

#[test]
fn native_fixture_identifier_is_stable_and_never_the_production_singleton() {
    let production = "app.plur1bus.desktop";
    let one = fixture_identifier(production, "synthetic-fixture-a");
    assert_ne!(one, production);
    assert_eq!(one, fixture_identifier(production, "synthetic-fixture-a"));
    assert_ne!(one, fixture_identifier(production, "synthetic-fixture-b"));
    assert!(!one.contains("synthetic"));
    assert!(one.len() < 80);
}

#[test]
fn revoked_stream_persists_repair_state_and_removes_only_its_token() {
    use plur1bus_desktop::{
        connections::{Connection, Kind, Origin, Store},
        events::SessionFailure,
        secrets::{token_account, MemoryStore, SecretString, TokenStore},
    };
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let mut connection = Connection::new(
        "Synthetic".into(),
        Kind::Local,
        Origin::parse("http://127.0.0.1:18700").unwrap(),
        "installation".into(),
        "device".into(),
        "hint".into(),
    );
    store.upsert(connection.clone()).unwrap();
    let tokens = MemoryStore::default();
    tokens
        .set(
            &token_account(connection.id),
            &SecretString::new("synthetic-token-123456".into()),
        )
        .unwrap();
    tokens
        .set(
            "other",
            &SecretString::new("synthetic-unrelated-token".into()),
        )
        .unwrap();
    assert!(tokens.get(&token_account(connection.id)).unwrap().is_some());
    plur1bus_desktop::native::mark_event_failure(
        &mut connection,
        SessionFailure::Revoked,
        &tokens,
        &store,
    )
    .unwrap();
    assert!(connection.pairing_needed);
    assert!(store.load().unwrap()[0].pairing_needed);
    assert!(tokens.get(&token_account(connection.id)).unwrap().is_none());
    assert!(tokens.get("other").unwrap().is_some());
}
