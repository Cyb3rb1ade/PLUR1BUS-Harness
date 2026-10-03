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

/// Start the shell with the three settings and app-information commands.
pub fn run() {
    #[cfg(windows)]
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[cfg(windows)]
    use tauri::Manager;
    #[cfg(windows)]
    let exit_started = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .manage(commands::ConnectionState::default())
        .manage(spa::SpaState::default())
        .setup(|app| {
            #[cfg(windows)]
            {
                let sweep = windows_spa_profile::sweep(app.handle())?;
                if !sweep.complete() {
                    eprintln!("SPA profile startup sweep incomplete");
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
                if !exit_started.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
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
                        handle.exit(if result.accepted() { 0 } else { 2 });
                    });
                }
            }
            #[cfg(not(windows))]
            let _ = (app, event);
        });
}
