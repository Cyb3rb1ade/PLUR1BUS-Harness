//! Native desktop shell. Harness services are introduced by later work packages.
pub mod client;
pub mod commands;
pub mod connections;
pub mod discovery;
pub mod ids;
pub mod pair;
pub mod secrets;
pub mod settings;
mod shell_commands;
pub use plur1bus_desktop_contract as contract;

/// Start the shell with the three settings and app-information commands.
pub fn run() {
    tauri::Builder::default()
        .manage(commands::ConnectionState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::connections_list,
            commands::connections_rename,
            commands::connections_remove,
            commands::pair_code,
            commands::pair_local,
            commands::open_connection
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
        .run(tauri::generate_context!())
        .expect("could not start the desktop shell");
}
