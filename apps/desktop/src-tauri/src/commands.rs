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
