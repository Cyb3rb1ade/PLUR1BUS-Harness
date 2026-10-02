//! Incognito SPA lifecycle, ticket retry and real runtime origin retirement.
use crate::{
    client::HarnessClient,
    connections::{Connection, Origin, Store},
    policy::{self, NavDecision},
    secrets::TokenStore,
    spa_proxy::SpaProxy,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Mutex,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;
/// Runtime session owner. Retired listeners keep ports reserved because Tauri ACL additions are permanent.
#[derive(Default)]
pub struct SpaState {
    current: Mutex<Option<Active>>,
    retired: Mutex<Vec<SpaProxy>>,
    #[cfg(debug_assertions)]
    probe: Mutex<Option<NativeProbe>>,
    #[cfg(debug_assertions)]
    secrets: Mutex<Option<NativeSecretObserver>>,
}
/// Test-only native title observer; adds no commands, transports, or release behavior.
#[cfg(debug_assertions)]
pub type NativeProbe = std::sync::Arc<dyn Fn(tauri::WebviewWindow, String) + Send + Sync>;
#[cfg(debug_assertions)]
pub type NativeSecretObserver = std::sync::Arc<dyn Fn(&str) + Send + Sync>;
impl SpaState {
    /// Trusted native fixture hook; no secret enters IPC or a report.
    #[cfg(debug_assertions)]
    pub fn set_native_secret_observer(&self, observer: NativeSecretObserver) {
        self.secrets.lock().unwrap().replace(observer);
    }
    /// Native fixture only: observe sanitized test-result titles from actual engines.
    #[cfg(debug_assertions)]
    pub fn set_native_probe(&self, probe: NativeProbe) {
        self.probe.lock().unwrap().replace(probe);
    }
    /// Native fixture only: use the active carrier in memory for negative transport checks.
    #[cfg(debug_assertions)]
    pub fn active_proxy(&self) -> Option<SpaProxy> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.proxy.clone())
    }
}

struct Active {
    connection: Connection,
    proxy: SpaProxy,
    retries: AtomicU8,
}
/// Exact remote origin and exact SPA label; no shell capabilities are added.
pub fn bridge_capability(origin: &Origin, retired: bool) -> Value {
    json!({"identifier":if retired {format!("spa-retired-{}",Url::parse(origin.as_str()).unwrap().port().unwrap())} else {"spa-bridge".into()},
        "local":false,"webviews":["spa"],"remote":{"urls":[format!("{}/*",origin.as_str())]},"permissions":[if retired {"deny-shell-info"} else {"allow-shell-info"}]})
}
/// Verify against the active window generation as well as label and top-level origin.
pub fn check_caller(state: &SpaState, label: &str, current: &Url) -> Result<(), String> {
    let active = state.current.lock().unwrap();
    let row = active.as_ref().ok_or("SPA is closed")?;
    policy::check_spa_caller(label, current, row.proxy.origin())
        .map_err(|_| "command unavailable for this window".into())
}
/// Explicit denies retire Tauri's additive grants; old ports remain reserved in this process.
pub fn retire(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<SpaState>();
    let old = state.current.lock().unwrap().take();
    if let Some(old) = old {
        old.proxy.retire();
        let deny = app
            .add_capability(bridge_capability(old.proxy.origin(), true).to_string())
            .map_err(|_| "SPA capability retirement failed".to_owned());
        state.retired.lock().unwrap().push(old.proxy);
        deny?;
    }
    Ok(())
}
/// Open the actual SPA only after an authenticated fresh ticket and prepared trust policy.
pub async fn open_spa(
    app: &tauri::AppHandle,
    conn: &mut Connection,
    tokens: &dyn TokenStore,
    store: &Store,
) -> Result<(), String> {
    let ticket = crate::pair::session_ticket(conn, tokens, store)
        .await
        .map_err(|e| e.public_message())?;
    let client = HarnessClient::from_connection(conn)
        .await
        .map_err(|e| crate::pair::PairError::Client(e).public_message())?;
    let proxy = SpaProxy::new(conn, client).await.map_err(|_| "network")?;
    #[cfg(debug_assertions)]
    if let Some(observer) = app.state::<SpaState>().secrets.lock().unwrap().clone() {
        observer(ticket.ticket.expose());
        observer(proxy.user_agent());
        proxy.register_launch_secret(|value| observer(value));
    }
    let settings = crate::settings::SettingsStore::new(crate::commands::app_config_dir(app)?)
        .get()
        .unwrap_or_default();
    proxy.set_error_settings(settings);
    retire(app)?;
    if let Some(old) = app.get_webview_window("spa") {
        old.destroy().map_err(|_| "SPA close failed")?;
        // Native destruction is queued. Do not rebuild the same label before its removal event.
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while app.get_webview_window("spa").is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "SPA close failed")?;
    }
    app.add_capability(bridge_capability(proxy.origin(), false).to_string())
        .map_err(|_| "SPA capability failed")?;
    let mut url =
        Url::parse(&format!("{}/auth/ticket", proxy.origin().as_str())).map_err(|_| "invalid")?;
    url.set_fragment(Some(&format!("t={}", ticket.ticket.expose())));
    let origin = proxy.origin().clone();
    let upstream = conn.origin.clone();
    let handle = app.clone();
    let guard = origin.clone();
    app.state::<SpaState>()
        .current
        .lock()
        .unwrap()
        .replace(Active {
            connection: conn.clone(),
            proxy: proxy.clone(),
            retries: AtomicU8::new(0),
        });
    let title_app = app.clone();
    let navigation_proxy = proxy.clone();
    let popup_proxy = proxy.clone();
    let popup_upstream = upstream.clone();
    let popup_handle = app.clone();
    let created = WebviewWindowBuilder::new(app, "spa", WebviewUrl::External(url))
        .title("PLUR1BUS")
        .theme(match settings.theme {
            crate::settings::Theme::System => None,
            crate::settings::Theme::Light => Some(tauri::Theme::Light),
            crate::settings::Theme::Dark => Some(tauri::Theme::Dark),
        })
        .min_inner_size(800.0, 600.0)
        .inner_size(1100.0, 800.0)
        .incognito(true)
        .disable_drag_drop_handler()
        .user_agent(proxy.user_agent())
        .on_navigation(move |url| {
            if navigation_proxy.has_launch_secret_in_target(url.as_str()) {
                return false;
            }
            if policy::same_origin(url, &origin) && url.path() == "/auth/ticket-failed" {
                schedule_retry(&handle, &origin, url.query() == Some("retry=1"));
                return false;
            }
            match policy::navigation(&origin, &upstream, url) {
                NavDecision::Allow if policy::same_origin(url, &upstream) => {
                    let mut mapped = url.clone();
                    let local = Url::parse(origin.as_str()).unwrap();
                    let _ = mapped.set_scheme(local.scheme());
                    let _ = mapped.set_host(local.host_str());
                    let _ = mapped.set_port(local.port());
                    if let Some(window) = handle.get_webview_window("spa") {
                        let _ = window.navigate(mapped);
                    }
                    false
                }
                NavDecision::Allow => true,
                NavDecision::OpenExternal => {
                    if let Ok(link) = policy::ExternalUrl::classified(&origin, &upstream, url) {
                        let _ = link.open();
                    }
                    false
                }
                NavDecision::Block => false,
            }
        })
        .on_new_window(move |url, _| {
            if !popup_proxy.has_launch_secret_in_target(url.as_str()) {
                match policy::navigation(popup_proxy.origin(), &popup_upstream, &url) {
                    NavDecision::OpenExternal => {
                        if let Ok(link) = policy::ExternalUrl::classified(
                            popup_proxy.origin(),
                            &popup_upstream,
                            &url,
                        ) {
                            let _ = link.open();
                        }
                    }
                    NavDecision::Allow => {
                        if let Some(window) = popup_handle.get_webview_window("spa") {
                            let _ = window.navigate(url);
                        }
                    }
                    NavDecision::Block => {}
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_document_title_changed(move |window, title| {
            #[cfg(debug_assertions)]
            if let Some(probe) = title_app.state::<SpaState>().probe.lock().unwrap().clone() {
                probe(window, title.to_owned());
            }
            #[cfg(not(debug_assertions))]
            let _ = (&title_app, window, title);
        })
        .build();
    let window = match created {
        Ok(v) => v,
        Err(_) => {
            retire(app)?;
            return Err("SPA window creation failed".into());
        }
    };
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let current = app
                .state::<SpaState>()
                .current
                .lock()
                .unwrap()
                .as_ref()
                .map(|a| a.proxy.origin().clone());
            if current.as_ref() == Some(&guard) {
                let _ = retire(&app);
            }
        }
    });
    Ok(())
}
/// Exactly one automatic retry; an explicit person-initiated retry starts a new attempt.
pub fn retry_ticket(counter: &AtomicU8, manual: bool) -> bool {
    if manual {
        counter.store(0, Ordering::SeqCst);
    }
    counter
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}
fn schedule_retry(app: &tauri::AppHandle, origin: &Origin, manual: bool) {
    let (connection, retry) = {
        let state = app.state::<SpaState>();
        let active = state.current.lock().unwrap();
        let Some(active) = active.as_ref().filter(|a| a.proxy.origin() == origin) else {
            return;
        };
        (
            active.connection.clone(),
            retry_ticket(&active.retries, manual),
        )
    };
    let app = app.clone();
    let origin = origin.clone();
    tauri::async_runtime::spawn(async move {
        let ticket = if retry {
            let store = crate::commands::app_connection_store(&app);
            match store {
                Ok(store) => crate::commands::credential_action(
                    &app.state::<crate::commands::ConnectionState>(),
                    move |tokens, runtime| {
                        let tokens = tokens.as_ref().ok_or("pairing-needed")?;
                        let mut connection = connection;
                        runtime
                            .block_on(crate::pair::session_ticket(
                                &mut connection,
                                tokens.as_ref(),
                                &store,
                            ))
                            .map_err(|e| e.public_message())
                    },
                )
                .await
                .ok(),
                Err(_) => None,
            }
        } else {
            None
        };
        let state = app.state::<SpaState>();
        let active = state.current.lock().unwrap();
        if active.as_ref().is_none_or(|a| a.proxy.origin() != &origin) {
            return;
        }
        drop(active);
        let mut url = Url::parse(&format!(
            "{}{}",
            origin.as_str(),
            if ticket.is_some() {
                "/auth/ticket"
            } else {
                "/__shell/ticket-error"
            }
        ))
        .unwrap();
        if let Some(ticket) = ticket {
            // A fresh fragment alone is a same-document navigation and will not rerun redemption.
            url.set_query(Some("shell-retry=1"));
            #[cfg(debug_assertions)]
            if let Some(observer) = app.state::<SpaState>().secrets.lock().unwrap().clone() {
                observer(ticket.ticket.expose());
            }
            url.set_fragment(Some(&format!("t={}", ticket.ticket.expose())));
        }
        if let Some(window) = app.get_webview_window("spa") {
            let _ = window.navigate(url);
        }
    });
}
