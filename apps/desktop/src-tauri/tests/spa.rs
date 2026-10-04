use plur1bus_desktop::{
    client::HarnessClient,
    commands::{allowed_command, APP_COMMANDS, SHELL_COMMANDS},
    connections::Origin,
    connections::{Connection, Store},
    pair,
    secrets::MemoryStore,
    spa::{bridge_capability, check_caller, retry_ticket, SpaState},
    spa_proxy::SpaProxy,
};
use plur1bus_mock_harness::{MockHandle, MockHarness, MockOptions};
use std::{sync::atomic::AtomicU8, time::Duration};
use url::Url;
#[test]
fn shell_info_is_the_only_spa_command() {
    assert!(APP_COMMANDS.contains(&"shell_info"));
    assert!(!SHELL_COMMANDS.contains(&"shell_info"));
    assert!(!allowed_command("shell", "shell_info"));
    assert_eq!(
        bridge_capability(&Origin::parse("http://127.0.0.1:30001").unwrap(), false)["permissions"],
        serde_json::json!(["allow-shell-info"])
    );
}
#[test]
fn spa_bridge_capability_is_scoped_to_the_spa_origin() {
    let cap = bridge_capability(&Origin::parse("http://127.0.0.1:30001").unwrap(), false);
    assert_eq!(cap["local"], false);
    assert_eq!(cap["webviews"], serde_json::json!(["spa"]));
    assert_eq!(
        cap["remote"]["urls"],
        serde_json::json!(["http://127.0.0.1:30001/*"])
    );
    assert!(cap.get("windows").is_none());
}
// These integration tests drive the production state transitions and retry policy.
// Native capability installation and webview navigation remain native-fixture checks.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
async fn bounded(future: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("SPA acceptance test exceeded 60s");
}
struct Fixture {
    mock: MockHandle,
    connection: Connection,
    proxy: SpaProxy,
    tokens: MemoryStore,
    store: Store,
    dir: tempfile::TempDir,
}
impl Fixture {
    async fn new() -> Self {
        let mock = MockHarness::start(MockOptions::default()).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path());
        let tokens = MemoryStore::default();
        let connection = pair::pair_code(
            &mock.origin,
            &mock.control.create_pair_code(),
            "Scratch",
            &tokens,
            &store,
            None,
        )
        .await
        .unwrap();
        let proxy = SpaProxy::new(
            &connection,
            HarnessClient::from_connection(&connection).await.unwrap(),
        )
        .await
        .unwrap();
        Self {
            mock,
            connection,
            proxy,
            tokens,
            store,
            dir,
        }
    }
    fn install(&self, state: &SpaState) {
        state
            .install_fixture_session(self.connection.clone(), self.proxy.clone(), self.dir.path())
            .unwrap();
    }
    async fn retry(&self, state: &SpaState, manual: bool) -> Url {
        state
            .retry_navigation(self.proxy.origin(), manual, |mut connection| async move {
                pair::session_ticket(&mut connection, &self.tokens, &self.store)
                    .await
                    .ok()
            })
            .await
            .expect("active generation")
    }
    async fn redeem(&self, ticket: &str) -> reqwest::StatusCode {
        client()
            .post(format!(
                "{}/api/v1/auth/ticket/redeem",
                self.proxy.origin().as_str()
            ))
            .header("user-agent", self.proxy.user_agent())
            .header("origin", self.proxy.origin().as_str())
            .json(&serde_json::json!({"ticket":ticket}))
            .send()
            .await
            .unwrap()
            .status()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.proxy.retire();
    }
}
#[tokio::test]
async fn switching_connection_replaces_the_capability() {
    bounded(async {
        let old = Fixture::new().await;
        let new = Fixture::new().await;
        let state = SpaState::default();
        old.install(&state);
        let old_url = Url::parse(old.proxy.origin().as_str()).unwrap();
        let new_url = Url::parse(new.proxy.origin().as_str()).unwrap();
        assert!(check_caller(&state, "spa", &old_url).is_ok());
        assert!(check_caller(&state, "spa", &new_url).is_err());
        assert_eq!(
            client()
                .get(old_url.clone())
                .header("user-agent", old.proxy.user_agent())
                .send()
                .await
                .unwrap()
                .status(),
            200
        );

        state.retire_fixture_session();
        assert!(check_caller(&state, "spa", &old_url).is_err());
        new.install(&state);
        assert!(check_caller(&state, "spa", &old_url).is_err());
        assert!(check_caller(&state, "spa", &new_url).is_ok());
        assert!(check_caller(&state, "shell", &new_url).is_err());
        assert_eq!(
            client()
                .get(old_url.clone())
                .header("user-agent", old.proxy.user_agent())
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let old_agent = old.proxy.user_agent().to_owned();
        // Drop every external proxy owner: production retirement must retain its port.
        drop(old);
        assert_eq!(
            client()
                .get(old_url.clone())
                .header("user-agent", old_agent)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert!(
            tokio::net::TcpListener::bind(old_url.socket_addrs(|| None).unwrap()[0])
                .await
                .is_err()
        );
        let response = client()
            .get(new_url)
            .header("user-agent", new.proxy.user_agent())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.text().await.unwrap().contains("spa.js"));
        let retired = bridge_capability(&Origin::parse(old_url.as_str()).unwrap(), true);
        assert_eq!(
            retired["permissions"],
            serde_json::json!(["deny-shell-info"])
        );
        assert_ne!(
            retired["remote"],
            bridge_capability(new.proxy.origin(), false)["remote"]
        );
        state.retire_fixture_session();
    })
    .await;
}
#[tokio::test]
async fn a_replayed_ticket_page_is_retried_once_then_shows_the_error() {
    bounded(async {
        let mut f = Fixture::new().await;
        f.proxy
            .set_error_settings(plur1bus_desktop::settings::Settings {
                theme: plur1bus_desktop::settings::Theme::Dark,
                locale: plur1bus_desktop::settings::Locale::De,
            });
        let state = SpaState::default();
        f.install(&state);
        let ticket = pair::session_ticket(&mut f.connection, &f.tokens, &f.store)
            .await
            .unwrap();
        assert_eq!(f.redeem(ticket.ticket.expose()).await, 200);
        assert_eq!(f.redeem(ticket.ticket.expose()).await, 401);
        f.mock.control.clear_requests();
        let first = f.retry(&state, false).await;
        assert_eq!(first.path(), "/auth/ticket");
        assert_eq!(first.query(), Some("shell-retry=1"));
        let fresh = first.fragment().unwrap().strip_prefix("t=").unwrap();
        assert!(
            fresh != ticket.ticket.expose(),
            "retry must issue a fresh ticket"
        );
        let page = client()
            .get(first.clone())
            .header("user-agent", f.proxy.user_agent())
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.text().await.unwrap().contains("spa.js"));
        // Consume then replay the actual retry ticket through the real proxy.
        assert_eq!(f.redeem(fresh).await, 200);
        assert_eq!(f.redeem(fresh).await, 401);
        let second = f.retry(&state, false).await;
        assert_eq!(second.path(), "/__shell/ticket-error");
        assert!(second.fragment().is_none() && second.query().is_none());
        let error = client()
            .get(second)
            .header("user-agent", f.proxy.user_agent())
            .send()
            .await
            .unwrap();
        assert_eq!(error.status(), 200);
        let html = error.text().await.unwrap();
        assert!(html.contains("retry=1"));
        let css = client()
            .get(format!("{}/__shell/error.css", f.proxy.origin().as_str()))
            .header("user-agent", f.proxy.user_agent())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(css.contains("44px"));
        assert!(html.contains("dark") && html.contains("data-locale=\"de\""));
        assert!(!html.contains(ticket.ticket.expose()) && !html.contains(fresh));
        assert_eq!(
            f.mock
                .control
                .recorded_requests()
                .iter()
                .filter(|(path, _)| path == "/api/v1/auth/session-ticket")
                .count(),
            1
        );
        let manual = f.retry(&state, true).await;
        assert_eq!(manual.path(), "/auth/ticket");
        assert!(manual.fragment().is_some());
        assert_eq!(f.retry(&state, false).await.path(), "/__shell/ticket-error");
        state.retire_fixture_session();
    })
    .await;
}
#[tokio::test]
async fn retry_revalidates_session_meta_after_ticket_reconnect() {
    bounded(async {
        let f = Fixture::new().await;
        let state = SpaState::default();
        f.install(&state);
        f.mock.control.clear_requests();
        let url = f.retry(&state, true).await;
        assert_eq!(url.path(), "/auth/ticket");
        let meta_count = f
            .mock
            .control
            .recorded_requests()
            .iter()
            .filter(|(path, _)| path.ends_with("/meta"))
            .count();
        assert_eq!(
            meta_count, 2,
            "ticket issuance and reconnect revalidation each call /meta exactly once"
        );
        state.retire_fixture_session();
    })
    .await;
}

#[tokio::test]
async fn retry_completion_cannot_navigate_a_replaced_generation() {
    bounded(async {
        let old = Fixture::new().await;
        let new = Fixture::new().await;
        let state = SpaState::default();
        old.install(&state);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let old_ref = &old;
        let retry =
            state.retry_navigation(old.proxy.origin(), false, |mut connection| async move {
                let ticket = pair::session_ticket(&mut connection, &old_ref.tokens, &old_ref.store)
                    .await
                    .ok();
                started_tx.send(()).unwrap();
                resume_rx.await.unwrap();
                ticket
            });
        let switch = async {
            started_rx.await.unwrap();
            state.retire_fixture_session();
            new.install(&state);
            resume_tx.send(()).unwrap();
        };
        let (navigation, ()) = tokio::join!(retry, switch);
        assert!(navigation.is_none());
        assert!(state
            .retry_navigation(old.proxy.origin(), true, |_| async {
                panic!("a retired origin must not request a ticket")
            })
            .await
            .is_none());
        state.retire_fixture_session();
    })
    .await;
}
#[test]
fn automatic_retry_budget_cannot_wrap_and_manual_retry_resets_it() {
    let counter = AtomicU8::new(0);
    assert!(retry_ticket(&counter, false));
    for _ in 0..300 {
        assert!(!retry_ticket(&counter, false));
    }
    assert!(retry_ticket(&counter, true));
    assert!(!retry_ticket(&counter, false));
}
