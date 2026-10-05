use crate::settings::{Settings, SettingsStore};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

pub use crate::shell_commands::{APP_COMMANDS, SHELL_COMMANDS};

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
    if window
        .app_handle()
        .try_state::<crate::native::NativeState>()
        .is_some()
    {
        crate::native::refresh_language(window.app_handle(), request.settings.locale);
    }
    Ok(request.settings)
}

// One owner serializes all connection/token mutations; listing never initializes tokens.
#[derive(Default)]
pub struct ConnectionState(
    pub std::sync::Arc<tokio::sync::Mutex<Option<Box<dyn crate::secrets::TokenStore>>>>,
);
/// Keep the mutation lock across the complete action while running synchronous
/// credential APIs (including interactive prompts) outside async runtime workers.
pub(crate) async fn credential_action<T: Send + 'static>(
    state: &ConnectionState,
    action: impl FnOnce(
            &mut Option<Box<dyn crate::secrets::TokenStore>>,
            tokio::runtime::Handle,
        ) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    let mut guard = state.0.clone().lock_owned().await;
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || action(&mut guard, runtime))
        .await
        .map_err(|_| "keychain-error".to_owned())?
}
fn connection_store(window: &WebviewWindow) -> Result<crate::connections::Store, String> {
    app_connection_store(window.app_handle())
}
pub(crate) fn app_connection_store(
    app: &tauri::AppHandle,
) -> Result<crate::connections::Store, String> {
    Ok(crate::connections::Store::open(&app_config_dir(app)?))
}
pub(crate) fn app_config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        return Ok(dir.into());
    }
    app.path().app_config_dir().map_err(|_| "storage".into())
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
    row.name = request.name.trim().to_owned();
    store.upsert(row).map_err(|_| "invalid".into())
}
#[tauri::command]
pub async fn connections_remove(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: ConnectionIdRequest,
) -> Result<(), String> {
    check(&window, "connections_remove")?;
    let store = connection_store(&window)?;
    let app = window.app_handle().clone();
    credential_action(&state, move |tokens, _| {
        crate::native::retire_connection(&app, request.id);
        crate::pair::remove_connection(
            &store,
            request.id,
            tokens.as_deref(),
            crate::secrets::open_for_removal().as_ref(),
        )
        .map_err(|e| e.public_message())
    })
    .await
}
#[tauri::command]
pub async fn pair_code(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: PairCodeRequest,
) -> Result<Paired, String> {
    check(&window, "pair_code")?;
    let store = connection_store(&window)?;
    let code = crate::secrets::SecretString::new(request.code);
    let app = window.app_handle().clone();
    credential_action(&state, move |tokens, runtime| {
        if let Some(id) = request.repair_id {
            crate::native::retire_connection(&app, id);
        }
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let connection = runtime
            .block_on(crate::pair::pair_code(
                &request.origin,
                code.expose(),
                &request.name,
                tokens.as_ref(),
                &store,
                request.repair_id,
            ))
            .map_err(|e| e.public_message())?;
        Ok(Paired {
            connection,
            token_store: tokens.kind(),
        })
    })
    .await
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
        .map_err(|e| e.public_message())?;
    if offer
        .origin
        .as_ref()
        .is_some_and(|origin| *origin != record.url)
    {
        return Err("installation-mismatch".into());
    }
    let code = crate::secrets::SecretString::new(offer.code);
    let store = connection_store(&window)?;
    credential_action(&state, move |tokens, runtime| {
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let connection = runtime
            .block_on(crate::pair::pair(
                record.url,
                code.expose(),
                &request.name,
                crate::connections::Kind::Local,
                Some(&record.installation_id),
                None,
                tokens.as_ref(),
                &store,
            ))
            .map_err(|e| e.public_message())?;
        Ok(Paired {
            connection,
            token_store: tokens.kind(),
        })
    })
    .await
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
    let store = connection_store(&window)?;
    let app = window.app_handle().clone();
    credential_action(&state, move |tokens, runtime| {
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let mut row = store
            .load()
            .map_err(|_| "storage")?
            .into_iter()
            .find(|c| c.id == request.id)
            .ok_or("invalid")?;
        runtime
            .block_on(crate::pair::validate_connection(
                &mut row,
                tokens.as_ref(),
                &store,
            ))
            .map_err(|e| e.public_message())?;
        let monitor = if app.try_state::<crate::native::NativeState>().is_some() {
            let client = runtime
                .block_on(crate::client::HarnessClient::from_connection(&row))
                .map_err(|e| crate::pair::PairError::Client(e).public_message())?;
            let token = crate::secrets::load_token_or_pairing_needed(tokens.as_ref(), row.id)
                .map_err(|_| "pairing-needed")?;
            Some((client, token))
        } else {
            None
        };
        runtime.block_on(crate::spa::open_spa(
            &app,
            &mut row,
            tokens.as_ref(),
            &store,
        ))?;
        if let Some((client, token)) = monitor {
            // Spawn while entered into the async runtime; token remains native-only.
            runtime.block_on(async {
                crate::native::start_events(&app, row.clone(), client, token);
            });
        }
        Ok(Opened {
            selected: true,
            spa_available: true,
        })
    })
    .await
}
#[cfg(test)]
mod worker_tests {
    #[tokio::test(flavor = "current_thread")]
    async fn credential_work_leaves_async_worker_available_and_serializes_mutations() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let state = super::ConnectionState::default();
        let running = Arc::new(AtomicBool::new(false));
        let seen = running.clone();
        let first = super::credential_action(&state, move |_, _| {
            seen.store(true, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(100));
            seen.store(false, Ordering::SeqCst);
            Ok(())
        });
        let second = async {
            while !running.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            assert!(running.load(Ordering::SeqCst));
            super::credential_action(&state, move |_, _| {
                assert!(!running.load(Ordering::SeqCst));
                Ok(())
            })
            .await
            .unwrap();
        };
        let (result, ()) = tokio::join!(first, second);
        result.unwrap();
    }
}

/// Native app information exposed to the paired SPA, with no D2 features.
#[derive(Serialize)]
pub struct ShellInfo {
    pub product: &'static str,
    pub version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
    pub features: Vec<&'static str>,
}
/// The SPA's only IPC command. Exact current URL and label are checked in Rust.
#[tauri::command]
pub fn shell_info(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::spa::SpaState>,
) -> Result<ShellInfo, String> {
    let current = webview.url().map_err(|_| "SPA URL unavailable")?;
    crate::spa::check_caller(&state, webview.label(), &current)?;
    Ok(ShellInfo {
        product: crate::ids::PRODUCT,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        features: vec![],
    })
}

#[tauri::command]
pub fn quit_request(window: WebviewWindow) -> Result<crate::lifecycle::QuitOffer, String> {
    check(&window, "quit_request")?;
    Ok(crate::native::request_quit(window.app_handle()))
}
#[tauri::command]
pub fn quit_offer(window: WebviewWindow) -> Result<Option<crate::lifecycle::QuitOffer>, String> {
    check(&window, "quit_offer")?;
    let state = window.state::<crate::native::NativeState>();
    Ok(state.quit.is_pending().then(|| state.quit.request(false)))
}
#[tauri::command]
pub async fn quit_response(
    window: WebviewWindow,
    choice: Option<crate::lifecycle::QuitChoice>,
) -> Result<(), String> {
    check(&window, "quit_response")?;
    let state = window.state::<crate::native::NativeState>();
    match choice {
        None => state.quit.cancel(),
        Some(choice) => {
            // Bundled harness stopping is not available until WP8's controller adapter.
            state.quit.approve(choice, false).map_err(str::to_owned)?;
            state.events.stop();
            #[cfg(unix)]
            state.gnome.stop();
            let diagnostics = { state.diagnostics.lock().unwrap().take() };
            if let Some(diagnostics) = diagnostics {
                if let Err(reason) = crate::diagnostics::shutdown_owned(diagnostics).await {
                    eprintln!("{reason}");
                }
            }
            window.app_handle().exit(0);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn autostart_get(window: WebviewWindow) -> Result<Option<bool>, String> {
    check(&window, "autostart_get")?;
    #[cfg(target_os = "linux")]
    if crate::gnome::is_flatpak() {
        return Ok(*window
            .app_handle()
            .state::<crate::native::NativeState>()
            .gnome
            .autostart_grant
            .lock()
            .unwrap());
    }
    use crate::controller::autostart::AppLauncher;
    crate::controller::autostart::NativeLauncher(window.app_handle())
        .is_enabled()
        .map(Some)
        .map_err(|reason| reason.code().to_owned())
}
#[tauri::command]
pub async fn autostart_set(window: WebviewWindow, enabled: bool) -> Result<bool, String> {
    check(&window, "autostart_set")?;
    #[cfg(target_os = "linux")]
    if crate::gnome::is_flatpak() {
        return crate::gnome::request_autostart(window.app_handle(), enabled)
            .await
            .map_err(str::to_owned);
    }
    crate::controller::autostart::set_enabled(
        &crate::controller::autostart::NativeLauncher(window.app_handle()),
        enabled,
    )
    .map_err(|reason| reason.code().to_owned())
}

#[tauri::command]
pub fn background_hint(window: WebviewWindow) -> Result<bool, String> {
    check(&window, "background_hint")?;
    #[cfg(unix)]
    {
        Ok(window
            .app_handle()
            .state::<crate::native::NativeState>()
            .gnome
            .hint_pending
            .swap(false, std::sync::atomic::Ordering::SeqCst))
    }
    #[cfg(not(unix))]
    {
        Ok(false)
    }
}

#[derive(serde::Serialize)]
pub struct CrashOffer {
    id: String,
    details: String,
}

#[tauri::command]
pub async fn crash_offers(window: WebviewWindow) -> Result<Vec<CrashOffer>, String> {
    check(&window, "crash_offers")?;
    let reporter = window
        .app_handle()
        .state::<crate::native::NativeState>()
        .diagnostics
        .lock()
        .unwrap()
        .as_ref()
        .map(|d| d.crash.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let Some(reporter) = reporter else {
            return Ok(Vec::new());
        };
        reporter
            .pending()
            .map(|offers| {
                offers
                    .into_iter()
                    .map(|offer| CrashOffer {
                        id: offer.id().to_owned(),
                        details: offer.details().to_owned(),
                    })
                    .collect()
            })
            .map_err(|_| "CRASH_READ_FAILED".to_owned())
    })
    .await
    .map_err(|_| "CRASH_READ_FAILED".to_owned())?
}

#[tauri::command]
pub async fn crash_handled(window: WebviewWindow, id: String) -> Result<(), String> {
    check(&window, "crash_handled")?;
    let reporter = window
        .app_handle()
        .state::<crate::native::NativeState>()
        .diagnostics
        .lock()
        .unwrap()
        .as_ref()
        .map(|d| d.crash.clone())
        .ok_or_else(|| "CRASH_UNAVAILABLE".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let offers = reporter
            .pending()
            .map_err(|_| "CRASH_READ_FAILED".to_owned())?;
        let offer = offers
            .iter()
            .find(|offer| offer.id() == id)
            .ok_or_else(|| "CRASH_OFFER_UNKNOWN".to_owned())?;
        reporter
            .mark_handled(offer)
            .map_err(|_| "CRASH_HANDLING_FAILED".to_owned())
    })
    .await
    .map_err(|_| "CRASH_HANDLING_FAILED".to_owned())?
}
