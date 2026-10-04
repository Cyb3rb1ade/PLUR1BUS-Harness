//! Native desktop shell. Harness services are introduced by later work packages.
pub mod client;
pub mod commands;
pub mod connections;
pub mod crash;
pub mod discovery;
pub mod ids;
pub mod logging;
pub mod pair;
pub mod policy;
#[cfg(any(windows, test))]
mod profile_audit;
pub mod secrets;
pub mod settings;
mod shell_commands;
pub mod spa;
pub mod spa_proxy;
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
    use tauri::Manager;
    #[cfg(windows)]
    let exit_gate = Arc::new(ProfileExitGate::default());
    tauri::Builder::default()
        .manage(commands::ConnectionState::default())
        .manage(spa::SpaState::default())
        .setup(|app| {
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
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::connections_list,
            commands::connections_rename,
            commands::connections_remove,
            commands::pair_code,
            commands::pair_local,
            commands::open_connection,
            commands::shell_info
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "shell"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && webview.window().show().is_err()
            {
                eprintln!("SHELL_WINDOW_SHOW_FAILED");
            }
        })
        .build(tauri::generate_context!())
        .expect("could not build the desktop shell")
        .run(move |app, event| {
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
