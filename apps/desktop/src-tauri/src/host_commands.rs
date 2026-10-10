//! WP9 IPC contains public status, toggles and approval projections only.
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, WebviewWindow};
#[derive(Default)]
pub struct HostState {
    pub helper: crate::helper::Owner,
    pub bridge: crate::lifecycle::EventOwner,
    pub bridge_connection: Mutex<Option<crate::connections::Connection>>,
    pub cards: Arc<Mutex<std::collections::BTreeMap<String, Card>>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Card {
    pub id: String,
    pub capability: String,
    pub effect: String,
    pub targets: Vec<String>,
    pub risk: String,
    pub reversible: Option<bool>,
    pub grant_options: Vec<String>,
    pub action_hash: String,
    pub reason: String,
}
fn text(v: &serde_json::Value, key: &str, max: usize) -> String {
    v[key]
        .as_str()
        .filter(|s| s.len() <= max)
        .unwrap_or_default()
        .into()
}
pub fn project(value: &serde_json::Value) -> Option<Card> {
    let v = value.get("approval").unwrap_or(value);
    let id = text(v, "id", 128);
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return None;
    }
    let targets = v["targets"]
        .as_array()
        .map(|a| {
            a.iter()
                .take(200)
                .filter_map(|s| s.as_str().filter(|s| s.len() <= 2048).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let grant_options = v["grantOptions"]
        .as_array()
        .map(|a| {
            a.iter()
                .take(8)
                .filter_map(|s| s.as_str().or_else(|| s["scope"].as_str()))
                .filter(|s| matches!(*s, "once" | "task" | "session" | "always"))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Some(Card {
        id,
        capability: text(v, "capability", 256),
        effect: text(v, "effect", 2048),
        targets,
        risk: text(v, "risk", 32),
        reversible: v["reversible"]
            .as_bool()
            .or_else(|| v["reversibility"].as_str().map(|v| v == "reversible")),
        grant_options,
        action_hash: text(v, "actionHash", 256).chars().take(12).collect(),
        reason: text(v, "agentReason", 8192),
    })
}
pub fn event(app: &tauri::AppHandle, generation: u64, name: &str, value: serde_json::Value) {
    let Some(card) = project(&value) else {
        return;
    };
    let app = app.clone();
    let name = name.to_owned();
    let gui = app.clone();
    let _ = app.run_on_main_thread(move || {
        gui.state::<crate::native::NativeState>()
            .events
            .with_current(generation, || {
                let Some(state) = gui.try_state::<HostState>() else {
                    return;
                };
                let mut cards = state.cards.lock().unwrap();
                if name == "approval.requested" {
                    if cards.len() < 200 {
                        cards.insert(card.id.clone(), card);
                    }
                } else {
                    cards.remove(&card.id);
                }
                drop(cards);
                if gui.get_webview_window("approvals").is_none() && name == "approval.requested" {
                    let title = match crate::native::language(&gui) {
                        crate::tray::Language::De => "PLUR1BUS · Freigaben",
                        _ => "PLUR1BUS · Approvals",
                    };
                    let _ = tauri::WebviewWindowBuilder::new(
                        &gui,
                        "approvals",
                        tauri::WebviewUrl::App("index.html#/approvals".into()),
                    )
                    .title(title)
                    .inner_size(780., 680.)
                    .min_inner_size(600., 480.)
                    .build();
                }
                let _ = gui.emit_to("approvals", "desktop-approvals-changed", ());
            });
    });
}
pub fn start_bridge(
    app: &tauri::AppHandle,
    row: crate::connections::Connection,
    token: crate::secrets::SecretString,
) {
    let Some(url) = crate::bridge::endpoint(row.kind.clone(), &row.origin) else {
        return;
    };
    let Some(state) = app.try_state::<HostState>() else {
        return;
    };
    state.bridge.stop();
    *state.bridge_connection.lock().unwrap() = Some(row.clone());
    let generation = state.bridge.generation();
    let handle = app.clone();
    let task = tokio::spawn(async move {
        let mut retry = crate::bridge::Backoff::default();
        loop {
            let root = match crate::commands::app_config_dir(&handle) {
                Ok(v) => v,
                Err(_) => return,
            };
            let client = match crate::client::HarnessClient::from_connection(&row).await {
                Ok(client) => client,
                Err(_) => {
                    tokio::time::sleep(retry.next_delay(rand::random())).await;
                    continue;
                }
            };
            match client.meta().await {
                Ok(meta)
                    if meta.installation_id == row.installation_id
                        && meta.capabilities.iter().any(|c| c == "host.bridge") => {}
                Ok(_) => return,
                Err(_) => {
                    tokio::time::sleep(retry.next_delay(rand::random())).await;
                    continue;
                }
            }
            let enabled = crate::settings::SettingsStore::new(root)
                .key_unlock()
                .unwrap_or(false);
            let app = handle.clone();
            let installation = row.installation_id.clone();
            let exit = crate::bridge::session(&url, &token, enabled, &mut retry, move |op| {
                let app = app.clone();
                let installation = installation.clone();
                async move {
                    let state = app.state::<crate::commands::ConnectionState>();
                    let gui = app.clone();
                    crate::commands::credential_action(&state, move |tokens, _| {
                        if gui.state::<HostState>().bridge.generation() != generation {
                            return Err("E_DENIED".into());
                        }
                        let root = crate::commands::app_config_dir(&gui)?;
                        let enabled = crate::settings::SettingsStore::new(root)
                            .key_unlock()
                            .map_err(|_| "E_STORAGE")?;
                        let store = tokens.get_or_insert_with(crate::secrets::open_default);
                        crate::bridge::key_call(store.as_ref(), &installation, &op, enabled)
                            .map_err(str::to_owned)
                    })
                    .await
                }
            })
            .await;
            if exit == crate::bridge::Exit::Pairing {
                let state = handle.state::<crate::commands::ConnectionState>();
                let app = handle.clone();
                let id = row.id;
                let _ = crate::commands::credential_action(&state, move |tokens, _| {
                    if let Some(store) = tokens.as_ref() {
                        store
                            .delete(&crate::secrets::token_account(id))
                            .map_err(|_| "E_STORAGE")?;
                    }
                    let store = crate::commands::app_connection_store(&app)?;
                    let mut row = store
                        .load()
                        .map_err(|_| "E_STORAGE")?
                        .into_iter()
                        .find(|r| r.id == id)
                        .ok_or("E_INVALID")?;
                    row.pairing_needed = true;
                    store.upsert(row).map_err(|_| "E_STORAGE")?;
                    crate::native::retire_connection(&app, id);
                    Ok(())
                })
                .await;
                return;
            }
            tokio::time::sleep(retry.next_delay(rand::random())).await;
        }
    });
    state.bridge.install(generation, task);
}
/// Restore the bundled bridge independently of which connection the SPA shows.
/// Metadata is read before opening credential storage, and the existing owner
/// fences this with pairing/removal and port reconciliation.
pub async fn resume_bundled(app: &tauri::AppHandle) -> Result<(), String> {
    let owner = app.clone();
    let state = owner.state::<crate::commands::ConnectionState>();
    let app = app.clone();
    crate::commands::credential_action(&state, move |tokens, runtime| {
        let store = crate::commands::app_connection_store(&app)?;
        let Some(mut row) = store
            .load()
            .map_err(|_| "E_STORAGE")?
            .into_iter()
            .find(|r| r.kind == crate::connections::Kind::Bundled && !r.pairing_needed)
        else {
            return Ok(());
        };
        if app
            .state::<HostState>()
            .bridge_connection
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|current| current.id == row.id && current.origin == row.origin)
        {
            return Ok(());
        }
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        runtime
            .block_on(crate::pair::validate_connection(
                &mut row,
                tokens.as_ref(),
                &store,
            ))
            .map_err(|e| e.public_message())?;
        let token = crate::secrets::load_token_or_pairing_needed(tokens.as_ref(), row.id)
            .map_err(|_| "E_AUTH")?;
        runtime.block_on(async {
            start_bridge(&app, row, token);
        });
        Ok(())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSettings {
    pub enabled: bool,
    pub memory_only: bool,
    pub secrets_locked: bool,
    pub secrets_state: &'static str,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeRequest {
    pub enabled: Option<bool>,
}
#[tauri::command]
pub async fn bridge_settings(
    window: WebviewWindow,
    request: BridgeRequest,
) -> Result<BridgeSettings, String> {
    crate::commands::check(&window, "bridge_settings")?;
    let app = window.app_handle().clone();
    let owner = app.clone();
    let state = owner.state::<crate::commands::ConnectionState>();
    crate::commands::credential_action(&state, move |tokens, runtime| {
        let root = crate::commands::app_config_dir(&app)?;
        let store = crate::settings::SettingsStore::new(root);
        if let Some(enabled) = request.enabled {
            store.set_key_unlock(enabled)?;
            let row = crate::commands::app_connection_store(&app)?
                .load()
                .map_err(|_| "E_STORAGE")?
                .into_iter()
                .find(|r| r.kind == crate::connections::Kind::Bundled && !r.pairing_needed);
            if let Some(row) = row {
                if row.kind == crate::connections::Kind::Bundled {
                    let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
                    let token =
                        crate::secrets::load_token_or_pairing_needed(tokens.as_ref(), row.id)
                            .map_err(|_| "E_AUTH")?;
                    runtime.block_on(async {
                        start_bridge(&app, row, token);
                    });
                }
            }
        }
        let view = app
            .state::<crate::native::NativeState>()
            .view
            .lock()
            .unwrap()
            .clone();
        let secrets_state = if matches!(
            view.harness,
            crate::tray::HarnessState::Ready | crate::tray::HarnessState::Degraded
        ) {
            if view.secrets_locked {
                "locked"
            } else {
                "unlocked"
            }
        } else {
            "unknown"
        };
        Ok(BridgeSettings {
            enabled: store.key_unlock()?,
            memory_only: tokens
                .as_ref()
                .is_some_and(|s| s.kind() == crate::secrets::StoreKind::MemoryOnly),
            secrets_state,
            secrets_locked: app
                .state::<crate::native::NativeState>()
                .view
                .lock()
                .unwrap()
                .secrets_locked,
        })
    })
    .await
}
#[tauri::command]
pub fn helper_status(window: WebviewWindow) -> Result<crate::helper::Status, String> {
    crate::commands::check(&window, "helper_status")?;
    let state = window.state::<HostState>();
    tauri::async_runtime::block_on(async {
        state.helper.start();
    });
    let status = state.helper.status.lock().unwrap().clone();
    Ok(status)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaneRequest {
    pub pane: crate::helper::Pane,
}
#[tauri::command]
pub async fn permissions_open_pane(
    window: WebviewWindow,
    request: PaneRequest,
) -> Result<(), String> {
    crate::commands::check(&window, "permissions_open_pane")?;
    tauri::async_runtime::spawn_blocking(move || request.pane.open())
        .await
        .map_err(|_| "E_NOT_AVAILABLE".to_owned())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approvals {
    cards: Vec<Card>,
    decide_enabled: bool,
}
#[tauri::command]
pub fn approvals_list(window: WebviewWindow) -> Result<Approvals, String> {
    crate::commands::check(&window, "approvals_list")?;
    Ok(Approvals {
        cards: window
            .state::<HostState>()
            .cards
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect(),
        decide_enabled: decide_enabled(),
    })
}
pub fn decide_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("PLUR1BUS_DESKTOP_APPROVALS_DECIDE").as_deref() == Ok("1")
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRequest {
    pub id: String,
}
#[tauri::command]
pub fn approval_open(window: WebviewWindow, request: ApprovalRequest) -> Result<(), String> {
    crate::commands::check(&window, "approval_open")?;
    if !window
        .state::<HostState>()
        .cards
        .lock()
        .unwrap()
        .contains_key(&request.id)
    {
        return Err("E_NOT_FOUND".into());
    }
    let spa = window
        .app_handle()
        .get_webview_window("spa")
        .ok_or("E_NOT_AVAILABLE")?;
    let mut url = spa.url().map_err(|_| "E_NOT_AVAILABLE")?;
    let proxy = window
        .state::<crate::spa::SpaState>()
        .active_proxy()
        .ok_or("E_NOT_AVAILABLE")?;
    if !crate::policy::same_origin(&url, proxy.origin()) {
        return Err("E_DENIED".into());
    }
    url.set_fragment(Some(&format!("/approvals/{}", request.id)));
    spa.navigate(url).map_err(|_| "E_NOT_AVAILABLE")?;
    spa.show().map_err(|_| "E_NOT_AVAILABLE")?;
    spa.set_focus().map_err(|_| "E_NOT_AVAILABLE".into())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionRequest {
    pub id: String,
    pub decision: Decision,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Approve,
    Deny,
}
#[tauri::command]
pub async fn approval_decide(
    window: WebviewWindow,
    request: DecisionRequest,
) -> Result<(), String> {
    crate::commands::check(&window, "approval_decide")?;
    if !decide_enabled()
        || !window
            .state::<HostState>()
            .cards
            .lock()
            .unwrap()
            .contains_key(&request.id)
    {
        return Err("E_DENIED".into());
    }
    let app = window.app_handle().clone();
    let owner = app.clone();
    let state = owner.state::<crate::commands::ConnectionState>();
    crate::commands::credential_action(&state, move |tokens, runtime| {
        let row = app
            .state::<crate::native::NativeState>()
            .connection
            .lock()
            .unwrap()
            .clone()
            .ok_or("E_NOT_AVAILABLE")?;
        // Only the explicitly identified desktop mock supports this provisional API.
        let client = runtime
            .block_on(crate::client::HarnessClient::from_connection(&row))
            .map_err(|_| "E_NOT_AVAILABLE")?;
        let meta = runtime
            .block_on(client.meta())
            .map_err(|_| "E_NOT_AVAILABLE")?;
        if row.kind != crate::connections::Kind::Bundled
            || crate::bridge::endpoint(row.kind.clone(), &row.origin).is_none()
            || !meta.capabilities.iter().any(|c| c == "test.mock")
        {
            return Err("E_DENIED".into());
        }
        let token = crate::secrets::load_token_or_pairing_needed(
            tokens.as_deref().ok_or("E_AUTH")?,
            row.id,
        )
        .map_err(|_| "E_AUTH")?;
        runtime
            .block_on(client.mock_approval_decide(
                &row.installation_id,
                &token,
                &request.id,
                &request.decision,
            ))
            .map_err(|_| "E_DENIED".into())
    })
    .await
}
