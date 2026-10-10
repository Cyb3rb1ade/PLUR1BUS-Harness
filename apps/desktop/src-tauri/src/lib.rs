//! Native desktop shell.
pub mod bridge;
pub mod client;
pub mod commands;
pub mod connections;
pub mod controller;
pub mod crash;
pub mod diagnostics;
pub mod discovery;
pub mod events;
#[cfg(unix)]
pub mod gnome;
pub mod helper;
pub mod host_commands;
pub mod ids;
pub mod install;
pub mod lifecycle;
pub mod logging;
pub mod native;
pub mod notify;
pub mod pair;
pub mod policy;
#[cfg(any(windows, test))]
mod profile_audit;
pub mod runtime;
pub mod runtime_commands;
pub mod secrets;
pub mod settings;
mod shell_commands;
pub mod spa;
pub mod spa_proxy;
pub mod tray;
pub mod update_commands;
pub mod updates;
pub mod windows_spa_profile;
pub use plur1bus_desktop_contract as contract;

#[cfg(windows)]
#[derive(Default)]
struct ProfileExitGate {
    started: std::sync::atomic::AtomicBool,
    authorized: std::sync::atomic::AtomicBool,
}

#[cfg(windows)]
#[derive(PartialEq, Eq, Debug)]
enum ProfileExitAction {
    StartCleanup,
    Wait,
    Exit,
}

#[cfg(windows)]
impl ProfileExitGate {
    fn request(&self) -> ProfileExitAction {
        use std::sync::atomic::Ordering::SeqCst;
        if self.authorized.load(SeqCst) {
            ProfileExitAction::Exit
        } else if !self.started.swap(true, SeqCst) {
            ProfileExitAction::StartCleanup
        } else {
            ProfileExitAction::Wait
        }
    }

    fn authorize(&self) {
        self.authorized
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(any(windows, test))]
fn setup_after_profile_sweep<T>(
    sweep: impl FnOnce() -> std::io::Result<T>,
    observe: impl FnOnce(std::io::Result<T>),
) -> Result<(), Box<dyn std::error::Error>> {
    // Startup must continue even when the bounded owned-only sweep fails.
    observe(sweep());
    Ok(())
}

/// Start the shell with the three settings and app-information commands.
pub fn run() {
    #[cfg(windows)]
    use std::sync::Arc;
    #[cfg(windows)]
    let exit_gate = Arc::new(ProfileExitGate::default());
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        context.config_mut().identifier =
            lifecycle::fixture_identifier(ids::BUNDLE_ID, &root.to_string_lossy());
    }
    let builder = tauri::Builder::default();
    #[cfg(all(feature = "direct-updater", not(feature = "store")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        // The singleton plugin must run before other plugin/setup side effects.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| native::focus(app)))
        .plugin(controller::autostart::plugin())
        .plugin(tauri_plugin_notification::init())
        .manage(native::NativeState::default())
        .manage(commands::ConnectionState::default())
        .manage(runtime_commands::RuntimeState::default())
        .manage(spa::SpaState::default())
        .manage(host_commands::HostState::default())
        .manage(update_commands::UpdateState::default())
        .on_window_event(native::close)
        .setup(|app| {
            // Until Linux tray/background capability is confirmed, keep its dash entry reachable.
            use tauri::Manager;
            app.state::<native::NativeState>().background.store(!cfg!(target_os = "linux"), std::sync::atomic::Ordering::SeqCst);
            #[cfg(debug_assertions)]
            let fixture = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some();
            #[cfg(not(debug_assertions))]
            let fixture = false;
            if let Err(reason) = diagnostics::start(app.handle()) { eprintln!("{reason}"); }
            if !fixture && native::build_tray(app.handle()).is_err() {
                app.state::<native::NativeState>().tray_failed();
                eprintln!("TRAY_SETUP_FAILED");
            }
            #[cfg(target_os = "linux")]
            if !fixture { gnome::start(app.handle()); }
            #[cfg(windows)]
            {
                setup_after_profile_sweep(|| windows_spa_profile::sweep(app.handle()), |result| match result {
                    Ok(sweep) => {
                        eprintln!(
                            "SPA_PROFILE_STARTUP_SWEEP reason_code={} positive_profiles={} positive_rows={} audit_failed={} skipped_unknown={} skipped_active={} timed_out={}",
                            sweep.reason_code(),
                            sweep.positive_profiles,
                            sweep.positive_rows,
                            sweep.audit_failed,
                            sweep.skipped_unknown,
                            sweep.skipped_active,
                            sweep.timed_out
                        );
                    }
                    Err(error) => {
                        // A stale, sharing-locked or otherwise damaged leaf must never
                        // prevent the shell from starting. The next startup gets another
                        // bounded, owned-only chance to clean it up.
                        eprintln!(
                            "SPA_PROFILE_STARTUP_SWEEP reason_code=SPA_PROFILE_SWEEP_ERROR error_kind={:?}",
                            error.kind()
                        );
                    }
                })
            }
            #[cfg(not(windows))]
            { let _ = app; Ok(()) }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_commands::runtime_detect,
            runtime_commands::runtime_start,
            runtime_commands::bundle_install,
            runtime_commands::harness_start,
            runtime_commands::harness_stop,
            runtime_commands::harness_status,
            runtime_commands::harness_logs_tail,
            update_commands::update_store_open,
            update_commands::update_check,
            update_commands::update_settings,
            update_commands::update_install,
            update_commands::update_skip,
            update_commands::update_later,
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::connections_list,
            commands::connections_rename,
            commands::connections_remove,
            commands::pair_code,
            commands::pair_local,
            commands::open_connection,
            commands::autostart_get,
            commands::autostart_set,
            commands::quit_request,
            commands::quit_offer,
            commands::background_hint,
            commands::crash_offers,
            commands::crash_handled,
            host_commands::bridge_settings,
            host_commands::helper_status,
            host_commands::permissions_open_pane,
            host_commands::approvals_list,
            host_commands::approval_open,
            host_commands::approval_decide,
            commands::quit_response,
            commands::shell_info
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "shell"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                use tauri::Manager;
                let app = webview.app_handle();
                let autostart = std::env::args_os().any(|arg| arg == "--autostart");
                if autostart && app.state::<native::NativeState>().consume_autostart() {
                    let background = app.state::<native::NativeState>().background.load(std::sync::atomic::Ordering::SeqCst);
                    if let Err(reason) = controller::autostart::on_login(&native::Windows(app), background) { eprintln!("{}", reason.code()); }
                    if let Some(window)=app.get_webview_window("shell"){tauri::async_runtime::spawn(async move {if let Err(code)=runtime_commands::on_login(window).await{eprintln!("{code}");}});}
                } else if !autostart {
                    if webview.window().show().is_err(){eprintln!("SHELL_WINDOW_SHOW_FAILED");}
                    if let Some(window)=app.get_webview_window("shell"){tauri::async_runtime::spawn(async move {let _=host_commands::resume_bundled(window.app_handle()).await; if let Err(code)=runtime_commands::monitor_existing(window).await{eprintln!("{code}");}});}
                }
            }
        })
        .build(context)
        .expect("could not build the desktop shell")
        .run(move |app, event| {
            #[cfg(windows)]
            use tauri::Manager;
            if native::guard_exit(app, &event) { return; }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event { native::focus(app); }
            #[cfg(windows)]
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                match exit_gate.request() {
                    ProfileExitAction::Exit => {}
                    ProfileExitAction::Wait => api.prevent_exit(),
                    ProfileExitAction::StartCleanup => {
                        api.prevent_exit();
                        let gate = exit_gate.clone();
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let old = handle.get_webview_window("spa");
                            let _ = spa::retire(&handle);
                            if let Some(window) = old {
                                let _ = window.destroy();
                            }
                            let result = handle
                                .state::<spa::SpaState>()
                                .wait_profile_cleanups(
                                    std::time::Instant::now() + std::time::Duration::from_secs(15),
                                )
                                .await;
                            #[cfg(debug_assertions)]
                            let exit_code = if result.accepted() { 0 } else { 2 };
                            #[cfg(not(debug_assertions))]
                            let exit_code = {
                                eprintln!(
                                    "SPA_PROFILE_SHUTDOWN reason_code={}",
                                    result.reason_code()
                                );
                                windows_spa_profile::cleanup_exit_code(&result)
                            };
                            gate.authorize();
                            handle.exit(exit_code);
                        });
                    }
                }
            }
            #[cfg(not(windows))]
            let _ = (app, event);
        });
}

#[cfg(all(test, windows))]
mod profile_exit_tests {
    use super::{ProfileExitAction, ProfileExitGate};

    #[test]
    fn repeated_exit_and_last_window_request_wait_until_authorized() {
        let gate = ProfileExitGate::default();
        assert_eq!(gate.request(), ProfileExitAction::StartCleanup);
        assert_eq!(gate.request(), ProfileExitAction::Wait);
        // Last-window destruction produces another exit request while cleanup is pending.
        assert_eq!(gate.request(), ProfileExitAction::Wait);
        gate.authorize();
        assert_eq!(gate.request(), ProfileExitAction::Exit);
    }
}

#[cfg(test)]
mod startup_tests {
    #[test]
    fn setup_finishes_after_sweep_error() {
        let observed = std::cell::Cell::new(false);
        let result = super::setup_after_profile_sweep(
            || {
                Err::<(), _>(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected deleter",
                ))
            },
            |result| {
                assert_eq!(
                    result.unwrap_err().kind(),
                    std::io::ErrorKind::PermissionDenied
                );
                observed.set(true);
            },
        );
        assert!(result.is_ok());
        assert!(observed.get());
    }
}
