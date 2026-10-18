//! Shell-only controls for the fixed OS shortcut location; no renderer paths.
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRequest {
    pub enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationState {
    kind: &'static str,
    enabled: bool,
}
fn get() -> Result<Option<IntegrationState>, String> {
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        return Ok(None);
    }
    #[cfg(all(target_os = "windows", feature = "store"))]
    return Ok(Some(IntegrationState {
        kind: "store",
        enabled: false,
    }));
    #[cfg(all(target_os = "windows", not(feature = "store")))]
    return crate::desktop_integration::desktop_icon_get()
        .map(|enabled| {
            Some(IntegrationState {
                kind: "desktop",
                enabled,
            })
        })
        .map_err(str::to_owned);
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() && !crate::gnome::is_flatpak() {
        return crate::desktop_integration::appimage_menu_get()
            .map(|enabled| {
                Some(IntegrationState {
                    kind: "menu",
                    enabled,
                })
            })
            .map_err(str::to_owned);
    }
    #[cfg(not(target_os = "windows"))]
    Ok(None)
}
#[tauri::command]
pub async fn desktop_integration_get(
    window: WebviewWindow,
) -> Result<Option<IntegrationState>, String> {
    crate::commands::check(&window, "desktop_integration_get")?;
    tauri::async_runtime::spawn_blocking(get)
        .await
        .map_err(|_| "DESKTOP_INTEGRATION_STORAGE".to_owned())?
}
#[tauri::command]
pub async fn desktop_integration_set(
    window: WebviewWindow,
    request: IntegrationRequest,
) -> Result<Option<IntegrationState>, String> {
    crate::commands::check(&window, "desktop_integration_set")?;
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        return Err("DESKTOP_INTEGRATION_UNAVAILABLE".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _ = request.enabled;
        #[cfg(target_os = "windows")]
        crate::desktop_integration::desktop_icon_set(request.enabled).map_err(str::to_owned)?;
        #[cfg(target_os = "linux")]
        if std::env::var_os("APPIMAGE").is_some() && !crate::gnome::is_flatpak() {
            crate::desktop_integration::appimage_menu_set(request.enabled)
                .map_err(str::to_owned)?;
        }
        get()
    })
    .await
    .map_err(|_| "DESKTOP_INTEGRATION_STORAGE".to_owned())?
}
