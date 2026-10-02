//! Native desktop shell. Harness services are introduced by later work packages.
pub mod ids;
pub use plur1bus_desktop_contract as contract;

/// Start the shell with no application IPC commands or native plugins enabled.
pub fn run() {
    tauri::Builder::default()
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
