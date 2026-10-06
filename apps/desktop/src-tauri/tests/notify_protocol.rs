#![cfg(unix)]
use plur1bus_desktop::{
    notify::{dbus, Banner},
    tray::{HarnessState, TrayState},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use zbus::{connection::Builder, zvariant::OwnedValue};
type NotificationMessage = (String, Vec<String>);
type Received = Arc<Mutex<Vec<NotificationMessage>>>;

#[derive(Clone)]
struct Service {
    actions: bool,
    received: Received,
}
#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Service {
    fn get_capabilities(&self) -> Vec<String> {
        if self.actions {
            vec!["actions".into()]
        } else {
            vec![]
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        _app: &str,
        _replaces: u32,
        _icon: &str,
        _summary: &str,
        body: &str,
        actions: Vec<String>,
        _hints: HashMap<String, OwnedValue>,
        _timeout: i32,
    ) -> u32 {
        self.received.lock().unwrap().push((body.into(), actions));
        42
    }
}
async fn connections(service: Service) -> (zbus::Connection, zbus::Connection) {
    let (server, client) = tokio::net::UnixStream::pair().unwrap();
    let server = Builder::unix_stream(server)
        .server(zbus::Guid::generate())
        .unwrap()
        .p2p()
        .serve_at("/org/freedesktop/Notifications", service)
        .unwrap()
        .build();
    let client = Builder::unix_stream(client).p2p().build();
    let (server, client) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(server, client)
    })
    .await
    .unwrap();
    (server.unwrap(), client.unwrap())
}
#[tokio::test]
async fn native_notify_sends_closed_action_pairs_over_an_isolated_socket() {
    let received = Arc::new(Mutex::new(vec![]));
    let (_server, client) = connections(Service {
        actions: true,
        received: received.clone(),
    })
    .await;
    let banner = Banner::from_state(&TrayState {
        harness: HarnessState::Down,
        ..Default::default()
    });
    assert_eq!(dbus::show(&client, &banner).await.unwrap(), 42);
    assert_eq!(
        *received.lock().unwrap(),
        [(
            "Stopped".into(),
            vec![
                "show-log".into(),
                "Show log".into(),
                "start-again".into(),
                "Start again".into()
            ]
        )]
    );
}
#[tokio::test]
async fn missing_native_action_capability_never_claims_a_banner_with_actions() {
    let received = Arc::new(Mutex::new(vec![]));
    let (_server, client) = connections(Service {
        actions: false,
        received: received.clone(),
    })
    .await;
    assert!(
        dbus::show(&client, &Banner::from_state(&TrayState::default()))
            .await
            .is_err()
    );
    assert!(received.lock().unwrap().is_empty());
}

struct Portal {
    requested: Arc<Mutex<Vec<bool>>>,
}
#[zbus::interface(name = "org.freedesktop.portal.Background")]
impl Portal {
    async fn request_background(
        &self,
        _parent: &str,
        mut options: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::zvariant::OwnedObjectPath {
        let token = String::try_from(options.remove("handle_token").unwrap()).unwrap();
        let requested = bool::try_from(options.remove("autostart").unwrap()).unwrap();
        self.requested.lock().unwrap().push(requested);
        let path = format!("/org/freedesktop/portal/desktop/request/1_42/{token}");
        // Intentionally emit before returning the handle; a late subscriber loses this response.
        let response = HashMap::from([
            ("background", zbus::zvariant::Value::from(true)),
            ("autostart", zbus::zvariant::Value::from(false)),
        ]);
        connection
            .emit_signal(
                None::<&str>,
                path.as_str(),
                "org.freedesktop.portal.Request",
                "Response",
                &(0u32, response),
            )
            .await
            .unwrap();
        zbus::zvariant::OwnedObjectPath::try_from(path).unwrap()
    }
}
#[tokio::test]
async fn native_portal_receives_early_response_and_preserves_partial_grant() {
    let requested = Arc::new(Mutex::new(vec![]));
    let (server, client) = tokio::net::UnixStream::pair().unwrap();
    let server = Builder::unix_stream(server)
        .server(zbus::Guid::generate())
        .unwrap()
        .p2p()
        .serve_at(
            "/org/freedesktop/portal/desktop",
            Portal {
                requested: requested.clone(),
            },
        )
        .unwrap()
        .build();
    let client = Builder::unix_stream(client)
        .p2p()
        .unique_name(":1.42")
        .unwrap()
        .build();
    let (server, client) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(server, client)
    })
    .await
    .unwrap();
    let _server = server.unwrap();
    let client = client.unwrap();
    client.set_unique_name(":1.42").unwrap();
    let grant = tokio::time::timeout(
        Duration::from_secs(3),
        plur1bus_desktop::notify::portal::request_background(&client, true, "fixture-desktop"),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(grant.background);
    assert!(!grant.autostart);
    assert_eq!(*requested.lock().unwrap(), [true]);
}

#[tokio::test]
async fn native_action_subscription_rejects_foreign_stale_and_repeated_actions() {
    use futures_util::StreamExt;
    use plur1bus_desktop::notify::{Action, ActionLedger};
    let (server, client) = connections(Service {
        actions: true,
        received: Arc::new(Mutex::new(vec![])),
    })
    .await;
    let mut actions = dbus::subscribe_actions(&client).await.unwrap();
    let mut ledger = ActionLedger::default();
    ledger.record(42, 7, [Action::Open, Action::Dismiss]);
    for (id, action, generation, expected) in [
        (43, "open", 7, None),
        (42, "update", 7, None),
        (42, "open", 7, Some(Action::Open)),
        (42, "open", 7, None),
    ] {
        server
            .emit_signal(
                None::<&str>,
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
                "ActionInvoked",
                &(id as u32, action),
            )
            .await
            .unwrap();
        let signal = tokio::time::timeout(Duration::from_secs(3), actions.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            dbus::owned_action(&signal, &mut ledger, generation),
            expected
        );
    }
    ledger.record(42, 7, [Action::Open, Action::Dismiss]);
    server
        .emit_signal(
            None::<&str>,
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
            "ActionInvoked",
            &(42u32, "open"),
        )
        .await
        .unwrap();
    let signal = tokio::time::timeout(Duration::from_secs(3), actions.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(dbus::owned_action(&signal, &mut ledger, 8), None);
}

struct StatusPortal {
    version: u32,
    messages: Arc<Mutex<Vec<String>>>,
}
#[zbus::interface(name = "org.freedesktop.portal.Background")]
impl StatusPortal {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        self.version
    }
    fn set_status(&self, mut options: HashMap<String, OwnedValue>) {
        assert_eq!(options.len(), 1);
        self.messages
            .lock()
            .unwrap()
            .push(String::try_from(options.remove("message").unwrap()).unwrap());
    }
}
#[tokio::test]
async fn background_status_sends_only_closed_state_and_requires_portal_v2() {
    for version in [1, 2] {
        let messages = Arc::new(Mutex::new(vec![]));
        let (server, client) = tokio::net::UnixStream::pair().unwrap();
        let server = Builder::unix_stream(server)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at(
                "/org/freedesktop/portal/desktop",
                StatusPortal {
                    version,
                    messages: messages.clone(),
                },
            )
            .unwrap()
            .build();
        let client = Builder::unix_stream(client).p2p().build();
        let (server, client) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(server, client)
        })
        .await
        .unwrap();
        let _server = server.unwrap();
        let state = TrayState {
            harness: HarnessState::Crashed,
            ..Default::default()
        };
        let result = plur1bus_desktop::notify::portal::set_status(&client.unwrap(), &state).await;
        assert_eq!(result.is_ok(), version == 2);
        assert_eq!(
            *messages.lock().unwrap(),
            if version == 2 {
                vec!["Crashed".to_owned()]
            } else {
                vec![]
            }
        );
    }
}

#[tokio::test]
async fn native_application_endpoint_dispatches_only_quit_and_preserves_modal_default() {
    use plur1bus_desktop::{
        gnome::Application,
        lifecycle::{QuitChoice, QuitSession},
    };
    let quit = Arc::new(QuitSession::default());
    let dispatched = quit.clone();
    let (server, client) = tokio::net::UnixStream::pair().unwrap();
    let server = Builder::unix_stream(server)
        .server(zbus::Guid::generate())
        .unwrap()
        .p2p()
        .serve_at(
            "/app/plur1bus/desktop",
            Application::new(move || {
                dispatched.request(false);
                Ok(())
            }),
        )
        .unwrap()
        .build();
    let client = Builder::unix_stream(client).p2p().build();
    let (server, client) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(server, client)
    })
    .await
    .unwrap();
    let _server = server.unwrap();
    let client = client.unwrap();
    let endpoint = zbus::Proxy::new(
        &client,
        "app.plur1bus.desktop",
        "/app/plur1bus/desktop",
        "org.freedesktop.Application",
    )
    .await
    .unwrap();
    for action in ["foreign", "quit"] {
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            endpoint.call::<_, _, ()>(
                "ActivateAction",
                &(
                    action,
                    Vec::<OwnedValue>::new(),
                    HashMap::<String, OwnedValue>::new(),
                ),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.is_ok(), action == "quit");
        assert_eq!(quit.is_pending(), action == "quit");
        assert!(!quit.is_approved());
    }
    assert_eq!(quit.request(false).choice, QuitChoice::KeepRunning);
}

#[tokio::test]
async fn native_notify_localizes_words_but_keeps_closed_action_ids() {
    let received = Arc::new(Mutex::new(vec![]));
    let (_server, client) = connections(Service {
        actions: true,
        received: received.clone(),
    })
    .await;
    let banner = Banner::from_state(&TrayState {
        harness: HarnessState::Down,
        ..Default::default()
    });
    assert_eq!(
        dbus::show_localized(&client, &banner, plur1bus_desktop::tray::Language::De)
            .await
            .unwrap(),
        42
    );
    assert_eq!(
        *received.lock().unwrap(),
        [(
            "Gestoppt".into(),
            vec![
                "show-log".into(),
                "Log anzeigen".into(),
                "start-again".into(),
                "Erneut starten".into()
            ]
        )]
    );
}
