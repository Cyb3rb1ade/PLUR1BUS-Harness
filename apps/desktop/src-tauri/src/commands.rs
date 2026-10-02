use crate::settings::{Settings, SettingsStore};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

pub use crate::shell_commands::SHELL_COMMANDS;

pub fn allowed_command(label: &str, command: &str) -> bool {
    label == "shell" && SHELL_COMMANDS.contains(&command)
}

pub fn authorized_shell(label: &str, current_url: &str) -> bool {
    if label != "shell" {
        return false;
    }
    let Ok(url) = tauri::Url::parse(current_url) else {
        return false;
    };
    let host = url.host_str();
    let exact_origin = match url.scheme() {
        "tauri" => host == Some("localhost") && url.port().is_none(),
        "http" => host == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    };
    exact_origin && url.username().is_empty() && url.password().is_none()
}

fn check(window: &WebviewWindow, command: &str) -> Result<(), String> {
    let current_url = window.url().map_err(|_| "shell URL unavailable")?;
    if !allowed_command(window.label(), command)
        || !authorized_shell(window.label(), current_url.as_str())
    {
        return Err("command unavailable for this window".into());
    }
    Ok(())
}

fn store(window: &WebviewWindow) -> Result<SettingsStore, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        return Ok(SettingsStore::new(dir.into()));
    }
    let dir = window
        .app_handle()
        .path()
        .app_config_dir()
        .map_err(|error| format!("settings location failed: {error}"))?;
    Ok(SettingsStore::new(dir))
}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub platform: &'static str,
    pub locale: String,
}

pub fn linux_desktop(value: &str) -> &'static str {
    let names = value.to_ascii_uppercase();
    if names
        .split([':', ';'])
        .any(|name| name.contains("KDE") || name.contains("PLASMA"))
    {
        "kde"
    } else {
        "gnome"
    }
}

#[tauri::command]
pub fn app_info(window: WebviewWindow) -> Result<AppInfo, String> {
    check(&window, "app_info")?;
    let platform = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "windows") {
        "win"
    } else {
        linux_desktop(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default())
    };
    Ok(AppInfo {
        platform,
        locale: sys_locale::get_locale().unwrap_or_else(|| "en".into()),
    })
}

#[tauri::command]
pub fn settings_get(window: WebviewWindow) -> Result<Settings, String> {
    check(&window, "settings_get")?;
    store(&window)?.get()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsSetRequest {
    pub settings: Settings,
}

#[tauri::command]
pub fn settings_set(
    window: WebviewWindow,
    request: SettingsSetRequest,
) -> Result<Settings, String> {
    check(&window, "settings_set")?;
    store(&window)?.set(&request.settings)?;
    Ok(request.settings)
}

// One owner serializes all connection/token mutations; listing never initializes tokens.
#[derive(Default)]
pub struct ConnectionState(pub tokio::sync::Mutex<Option<Box<dyn crate::secrets::TokenStore>>>);
fn connection_store(window: &WebviewWindow) -> Result<crate::connections::Store, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        return Ok(crate::connections::Store::open(std::path::Path::new(&dir)));
    }
    let dir = window
        .app_handle()
        .path()
        .app_config_dir()
        .map_err(|_| "storage")?;
    Ok(crate::connections::Store::open(&dir))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionList {
    pub connections: Vec<crate::connections::Connection>,
    pub active: Option<uuid::Uuid>,
    pub token_store: Option<crate::secrets::StoreKind>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionIdRequest {
    pub id: uuid::Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameRequest {
    pub id: uuid::Uuid,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PairCodeRequest {
    pub origin: String,
    pub name: String,
    pub code: String,
    pub repair_id: Option<uuid::Uuid>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairLocalRequest {
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub connection: crate::connections::Connection,
    pub token_store: crate::secrets::StoreKind,
}
#[tauri::command]
pub async fn connections_list(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
) -> Result<ConnectionList, String> {
    check(&window, "connections_list")?;
    let tokens = state.0.lock().await;
    let store = connection_store(&window)?;
    Ok(ConnectionList {
        connections: store.load().map_err(|_| "storage")?,
        active: store.active().map_err(|_| "storage")?,
        token_store: tokens.as_ref().map(|t| t.kind()),
    })
}
#[tauri::command]
pub async fn connections_rename(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: RenameRequest,
) -> Result<(), String> {
    check(&window, "connections_rename")?;
    let _lock = state.0.lock().await;
    let store = connection_store(&window)?;
    let mut row = store
        .load()
        .map_err(|_| "storage")?
        .into_iter()
        .find(|c| c.id == request.id)
        .ok_or("invalid")?;
    row.name = request.name;
    store.upsert(row).map_err(|_| "invalid".into())
}
#[tauri::command]
pub async fn connections_remove(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: ConnectionIdRequest,
) -> Result<(), String> {
    check(&window, "connections_remove")?;
    let tokens = state.0.lock().await;
    crate::pair::remove_connection(
        &connection_store(&window)?,
        request.id,
        tokens.as_deref(),
        crate::secrets::open_for_removal().as_ref(),
    )
    .map_err(|e| e.code().to_owned())
}
#[tauri::command]
pub async fn pair_code(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: PairCodeRequest,
) -> Result<Paired, String> {
    check(&window, "pair_code")?;
    let mut tokens = state.0.lock().await;
    let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
    let code = crate::secrets::SecretString::new(request.code);
    let connection = crate::pair::pair_code(
        &request.origin,
        code.expose(),
        &request.name,
        tokens.as_ref(),
        &connection_store(&window)?,
        request.repair_id,
    )
    .await
    .map_err(|e| e.code().to_owned())?;
    Ok(Paired {
        connection,
        token_store: tokens.kind(),
    })
}
#[tauri::command]
pub async fn pair_local(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: PairLocalRequest,
) -> Result<Paired, String> {
    check(&window, "pair_local")?;
    let root = crate::discovery::state_root().ok_or("cli-missing")?;
    let record = crate::discovery::discover(&root, crate::discovery::alive).ok_or("cli-missing")?;
    if !crate::discovery::reachable(&record).await {
        return Err("cli-missing".into());
    }
    let cli = crate::pair::resolve_cli().ok_or("cli-missing")?;
    let offer = crate::pair::pair_local(&cli, &request.name)
        .await
        .map_err(|e| e.code().to_owned())?;
    if offer
        .origin
        .as_ref()
        .is_some_and(|origin| *origin != record.url)
    {
        return Err("installation-mismatch".into());
    }
    let code = crate::secrets::SecretString::new(offer.code);
    let mut tokens = state.0.lock().await;
    let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
    let connection = crate::pair::pair(
        record.url,
        code.expose(),
        &request.name,
        crate::connections::Kind::Local,
        Some(&record.installation_id),
        None,
        tokens.as_ref(),
        &connection_store(&window)?,
    )
    .await
    .map_err(|e| e.code().to_owned())?;
    Ok(Paired {
        connection,
        token_store: tokens.kind(),
    })
}
#[derive(Serialize)]
pub struct Opened {
    pub selected: bool,
    pub spa_available: bool,
}
#[tauri::command]
pub async fn open_connection(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: ConnectionIdRequest,
) -> Result<Opened, String> {
    check(&window, "open_connection")?;
    let mut tokens = state.0.lock().await;
    let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
    let store = connection_store(&window)?;
    let mut row = store
        .load()
        .map_err(|_| "storage")?
        .into_iter()
        .find(|c| c.id == request.id)
        .ok_or("invalid")?;
    crate::pair::validate_connection(&mut row, tokens.as_ref(), &store)
        .await
        .map_err(|e| e.code().to_owned())?;
    Ok(Opened {
        selected: true,
        spa_available: false,
    })
}
