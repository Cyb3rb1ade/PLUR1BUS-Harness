//! Closed, shell-only installation operations. Renderer inputs never select executable paths or URLs.
use crate::{
    commands,
    controller::{bundle::embedded, UninstallLevel},
    install::{self, verified},
    runtime_commands::{self, RuntimeState},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager, WebviewWindow};
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LicenceRequest {
    pub licence_accepted: bool,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Vendor {
    Docker,
    Podman,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VendorRequest {
    pub vendor: Vendor,
    pub licence_accepted: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShimRequest {
    pub add_to_path: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UninstallRequest {
    #[serde(default)]
    pub level: UninstallLevel,
    pub confirmation: Option<String>,
}
pub fn validate_uninstall(r: &UninstallRequest) -> verified::Result<()> {
    if r.level == UninstallLevel::Everything && r.confirmation.as_deref() != Some("plur1bus-state")
    {
        Err("uninstall-confirmation")
    } else {
        Ok(())
    }
}
fn resources(window: &WebviewWindow) -> Result<PathBuf, String> {
    window
        .app_handle()
        .path()
        .resource_dir()
        .map_err(|_| "installer-resource".into())
}
fn home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) {
        "LOCALAPPDATA"
    } else {
        "HOME"
    })
    .map(PathBuf::from)
    .filter(|p| p.is_absolute())
    .ok_or("shim-storage".into())
}
#[cfg(not(windows))]
fn profile(home: &std::path::Path) -> PathBuf {
    if cfg!(target_os = "macos") || std::env::var("SHELL").is_ok_and(|s| s.ends_with("/zsh")) {
        home.join(".zprofile")
    } else {
        home.join(".profile")
    }
}
async fn path_change(home: &std::path::Path, add: bool) -> Result<(), String> {
    let dir = install::cli_shim::bin_dir(home);
    #[cfg(windows)]
    {
        install::cli_shim::update_windows_path(&dir, add)
            .await
            .map_err(str::to_owned)
    }
    #[cfg(not(windows))]
    {
        install::cli_shim::update_profile(&profile(home), &dir, add).map_err(str::to_owned)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub apple_available: bool,
    pub docker_licence: Option<String>,
    pub podman_licence: Option<String>,
    pub platform: &'static str,
}
fn vendor_key(v: Vendor) -> String {
    format!(
        "{}-windows-{}",
        match v {
            Vendor::Docker => "docker",
            Vendor::Podman => "podman",
        },
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        }
    )
}
#[tauri::command]
pub fn install_options(window: WebviewWindow) -> Result<InstallOptions, String> {
    commands::check(&window, "install_options")?;
    let b = embedded();
    Ok(InstallOptions {
        apple_available: cfg!(target_os = "macos")
            && crate::runtime_commands::macos_major().is_some_and(|v| v >= 26),
        docker_licence: b
            .vendor
            .get(&vendor_key(Vendor::Docker))
            .map(|v| v.licence.clone()),
        podman_licence: b
            .vendor
            .get(&vendor_key(Vendor::Podman))
            .map(|v| v.licence.clone()),
        platform: if cfg!(windows) {
            "win"
        } else if cfg!(target_os = "macos") {
            "mac"
        } else {
            "linux"
        },
    })
}
#[tauri::command]
pub async fn runtime_install_apple(
    window: WebviewWindow,
    request: LicenceRequest,
) -> Result<(), String> {
    commands::check(&window, "runtime_install_apple")?;
    if !cfg!(target_os = "macos") || crate::runtime_commands::macos_major().is_none_or(|v| v < 26) {
        return Err("installer-platform".into());
    }
    install::apple_pkg::install(
        &resources(&window)?,
        &embedded().apple,
        request.licence_accepted,
        &install::apple_pkg::NativeApple,
    )
    .await
    .map_err(str::to_owned)
}
#[tauri::command]
pub async fn runtime_install_vendor(
    window: WebviewWindow,
    request: VendorRequest,
) -> Result<(), String> {
    commands::check(&window, "runtime_install_vendor")?;
    if !cfg!(windows) {
        return Err("installer-platform".into());
    }
    let manifest = embedded()
        .vendor
        .get(&vendor_key(request.vendor))
        .ok_or("installer-unconfigured")?;
    install::vendor_installer::install_with_progress(
        manifest,
        request.licence_accepted,
        &install::vendor_installer::NativeVendor,
        |step| {
            let _ = window
                .app_handle()
                .emit_to("shell", "desktop-runtime-install-progress", step);
        },
    )
    .await
    .map_err(str::to_owned)
}
#[tauri::command]
pub async fn runtime_enable_podman_socket(window: WebviewWindow) -> Result<(), String> {
    commands::check(&window, "runtime_enable_podman_socket")?;
    install::podman_socket::enable()
        .await
        .map_err(str::to_owned)
}
#[tauri::command]
pub async fn cli_shim_install(window: WebviewWindow, request: ShimRequest) -> Result<(), String> {
    commands::check(&window, "cli_shim_install")?;
    if std::env::var_os("FLATPAK_ID").is_some() {
        return Err("shim-host-managed".into());
    }
    let home = home()?;
    let mut cli = embedded().cli.clone();
    if cfg!(windows) && cli.path == "cli/plur1bus" {
        cli.path.push_str(".exe");
    }
    install::cli_shim::install(&resources(&window)?, &cli, &home).map_err(str::to_owned)?;
    if request.add_to_path {
        path_change(&home, true).await?;
    }
    Ok(())
}
#[tauri::command]
pub async fn cli_shim_remove(window: WebviewWindow) -> Result<(), String> {
    commands::check(&window, "cli_shim_remove")?;
    if std::env::var_os("FLATPAK_ID").is_some() {
        return Err("shim-host-managed".into());
    }
    let home = home()?;
    install::cli_shim::remove(&home).map_err(str::to_owned)?;
    path_change(&home, false).await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallSummary {
    pub level: UninstallLevel,
    pub containers: Vec<String>,
    pub images: Vec<String>,
    pub volumes: Vec<UninstallVolume>,
    pub removes_keychain: bool,
    pub preserves_data: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallVolume {
    pub name: String,
    pub bytes: Option<u64>,
}
#[tauri::command]
pub async fn uninstall_summary(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
    request: UninstallRequest,
) -> Result<UninstallSummary, String> {
    commands::check(&window, "uninstall_summary")?;
    let mut result = UninstallSummary {
        level: request.level,
        containers: vec![],
        images: vec![],
        volumes: vec![],
        removes_keychain: request.level == UninstallLevel::Everything,
        preserves_data: request.level != UninstallLevel::Everything,
    };
    if !has_uninstall_inventory(&window)? {
        return Ok(result);
    }
    let c = runtime_commands::resolve_uninstall(&window, &mut *state.0.lock().await).await?;
    let i = c
        .uninstall_inventory()
        .map_err(|e| e.code())?
        .ok_or("not-installed")?;
    result.containers.push(i.container.clone());
    if request.level != UninstallLevel::AppOnly {
        result.images.push(i.image_digest.clone());
    }
    if request.level == UninstallLevel::Everything {
        for name in [&c.names.state, &c.names.models] {
            result.volumes.push(UninstallVolume {
                name: name.clone(),
                bytes: None,
            });
        }
    }
    if let Some(j) = c.upgrade_journal().map_err(|e| e.code())? {
        result.containers.push(format!("{}-previous", i.container));
        if request.level != UninstallLevel::AppOnly && !result.images.contains(&j.from_digest) {
            result.images.push(j.from_digest);
        }
        if request.level == UninstallLevel::Everything {
            for s in j
                .snapshot
                .iter()
                .chain(j.failed_snapshot.iter())
                .chain(j.cleanup.iter())
            {
                result.volumes.push(UninstallVolume {
                    name: s.volume.clone(),
                    bytes: Some(s.bytes),
                });
            }
            if let Some(name) = j.cleanup_failed {
                result.volumes.push(UninstallVolume { name, bytes: None });
            }
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn uninstall_run(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
    credentials: tauri::State<'_, commands::ConnectionState>,
    request: UninstallRequest,
) -> Result<(), String> {
    commands::check(&window, "uninstall_run")?;
    validate_uninstall(&request).map_err(str::to_owned)?;
    if has_uninstall_inventory(&window)? {
        let c = runtime_commands::resolve_uninstall(&window, &mut *state.0.lock().await).await?;
        let store = commands::app_connection_store(window.app_handle())?;
        let app = window.app_handle().clone();
        commands::credential_action(&credentials, move |tokens, runtime| {
            let transient = crate::secrets::MemoryStore::default();
            if request.level == UninstallLevel::Everything && tokens.is_none() {
                *tokens = Some(crate::secrets::open_default());
            }
            let tokens: &dyn crate::secrets::TokenStore = tokens.as_deref().unwrap_or(&transient);
            runtime
                .block_on(c.uninstall(
                    request.level,
                    request.confirmation.as_deref(),
                    tokens,
                    &store,
                    |step| {
                        let _ = app.emit_to("shell", "desktop-uninstall-progress", step);
                    },
                ))
                .map_err(|e| e.code().into())
        })
        .await?;
    }
    if std::env::var_os("FLATPAK_ID").is_none() {
        let home = home()?;
        install::cli_shim::remove(&home).map_err(str::to_owned)?;
        path_change(&home, false).await?;
    }
    #[cfg(debug_assertions)]
    let native_cleanup = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_none();
    #[cfg(not(debug_assertions))]
    let native_cleanup = true;
    if native_cleanup {
        crate::desktop_integration::remove_owned_entries().map_err(str::to_owned)?;
    }
    let _ = window
        .app_handle()
        .emit_to("shell", "desktop-uninstall-progress", "shim");
    let _ = window
        .app_handle()
        .emit_to("shell", "desktop-uninstall-progress", "complete");
    Ok(())
}

fn has_uninstall_inventory(window: &WebviewWindow) -> Result<bool, String> {
    let dir = commands::app_config_dir(window.app_handle())?.join("bundled");
    for name in ["installed.json", "uninstall-retained.json"] {
        match std::fs::symlink_metadata(dir.join(name)) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("storage".into()),
        }
    }
    Ok(false)
}
