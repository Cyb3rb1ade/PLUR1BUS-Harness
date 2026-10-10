//! Login registration only; starting the bundled runtime/harness belongs to WP8.
use tauri_plugin_autostart::ManagerExt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchFailure {
    Read,
    Enable,
    Disable,
    NotApplied,
}
impl LaunchFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Read => "AUTOSTART_READ_FAILED",
            Self::Enable => "AUTOSTART_ENABLE_FAILED",
            Self::Disable => "AUTOSTART_DISABLE_FAILED",
            Self::NotApplied => "AUTOSTART_NOT_APPLIED",
        }
    }
}
pub trait AppLauncher {
    fn is_enabled(&self) -> Result<bool, LaunchFailure>;
    fn enable(&self) -> Result<(), LaunchFailure>;
    fn disable(&self) -> Result<(), LaunchFailure>;
}
pub fn set_enabled(launcher: &impl AppLauncher, enabled: bool) -> Result<bool, LaunchFailure> {
    if enabled {
        launcher.enable()?;
    } else {
        launcher.disable()?;
    }
    let observed = launcher.is_enabled()?;
    if observed != enabled {
        return Err(LaunchFailure::NotApplied);
    }
    Ok(observed)
}
pub struct NativeLauncher<'a>(pub &'a tauri::AppHandle);
#[cfg(debug_assertions)]
fn fixture() -> bool {
    std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some()
}
impl AppLauncher for NativeLauncher<'_> {
    fn is_enabled(&self) -> Result<bool, LaunchFailure> {
        #[cfg(debug_assertions)]
        if fixture() {
            use tauri::Manager;
            return Ok(self
                .0
                .state::<crate::native::NativeState>()
                .fixture_autostart
                .load(std::sync::atomic::Ordering::SeqCst));
        }
        self.0
            .autolaunch()
            .is_enabled()
            .map_err(|_| LaunchFailure::Read)
    }
    fn enable(&self) -> Result<(), LaunchFailure> {
        #[cfg(debug_assertions)]
        if fixture() {
            use tauri::Manager;
            self.0
                .state::<crate::native::NativeState>()
                .fixture_autostart
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        }
        self.0
            .autolaunch()
            .enable()
            .map_err(|_| LaunchFailure::Enable)
    }
    fn disable(&self) -> Result<(), LaunchFailure> {
        #[cfg(debug_assertions)]
        if fixture() {
            use tauri::Manager;
            self.0
                .state::<crate::native::NativeState>()
                .fixture_autostart
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        }
        self.0
            .autolaunch()
            .disable()
            .map_err(|_| LaunchFailure::Disable)
    }
}
pub fn on_login(
    windows: &impl crate::lifecycle::WindowHost,
    background: bool,
) -> Result<(), crate::lifecycle::WindowFailure> {
    if !background {
        windows.show("shell")?;
    }
    crate::lifecycle::close_resident(windows, "shell", background)
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    #[cfg(debug_assertions)]
    if fixture() {
        return tauri::plugin::Builder::new("autostart-fixture").build();
    }
    #[cfg(target_os = "linux")]
    if crate::gnome::is_flatpak() {
        return tauri::plugin::Builder::new("autostart-portal").build();
    }
    let builder = tauri_plugin_autostart::Builder::new().arg("--autostart");
    #[cfg(target_os = "macos")]
    let builder = builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    builder.build()
}

/// A saved Docker socket may arrive late at login; never wait past two minutes.
pub async fn wait_socket<T, F, Fut>(mut probe: F) -> Result<T, &'static str>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            if let Some(value) = probe().await {
                return value;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    })
    .await
    .map_err(|_| "runtime.timeout")
}
