//! Native desktop shell. Harness services are introduced by later work packages.
pub mod client;
pub mod commands;
pub mod connections;
pub mod discovery;
pub mod ids;
pub mod pair;
pub mod policy;
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
                match windows_spa_profile::sweep(app.handle()) {
                    Ok(sweep) if !sweep.complete() => {
                        eprintln!(
                            "SPA profile startup sweep incomplete: positive_profiles={} positive_rows={} skipped_unknown={} skipped_active={}",
                            sweep.positive_profiles,
                            sweep.positive_rows,
                            sweep.skipped_unknown,
                            sweep.skipped_active
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        // A stale, sharing-locked or otherwise damaged leaf must never
                        // prevent the shell from starting. The next startup gets another
                        // bounded, owned-only chance to clean it up.
                        eprintln!("SPA profile startup sweep skipped: {error}");
                    }
                }
            }
            #[cfg(not(windows))]
            let _ = app;
            Ok(())
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
            {
                if let Err(error) = webview.window().show() {
                    eprintln!("Could not show the shell window: {error}");
                }
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
                            gate.authorize();
                            handle.exit(if result.accepted() { 0 } else { 2 });
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
