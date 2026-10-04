//! Tauri adapters for the tested resident-window and event ownership decisions.
use crate::{
    client::HarnessClient,
    connections::Connection,
    events::{EventStream, EventUpdate, SessionFailure},
    lifecycle::{EventOwner, QuitSession, WindowFailure, WindowHost},
    secrets::SecretString,
    tray::TrayState,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct NativeState {
    pub events: EventOwner,
    pub quit: QuitSession,
    pub view: Mutex<TrayState>,
    pub connection: Mutex<Option<Connection>>,
    pub background: AtomicBool,
}
pub struct Windows<'a>(pub &'a tauri::AppHandle);
impl WindowHost for Windows<'_> {
    fn exists(&self, label: &str) -> bool {
        self.0.get_webview_window(label).is_some()
    }
    fn present(&self, label: &str) -> Result<(), WindowFailure> {
        let window = self
            .0
            .get_webview_window(label)
            .ok_or(WindowFailure::Unavailable)?;
        window.show().map_err(|_| WindowFailure::Show)?;
        window.unminimize().map_err(|_| WindowFailure::Unminimize)?;
        window.set_focus().map_err(|_| WindowFailure::Focus)
    }
    fn hide(&self, label: &str) -> Result<(), WindowFailure> {
        self.0
            .get_webview_window(label)
            .ok_or(WindowFailure::Unavailable)?
            .hide()
            .map_err(|_| WindowFailure::Hide)
    }
    fn minimize(&self, label: &str) -> Result<(), WindowFailure> {
        self.0
            .get_webview_window(label)
            .ok_or(WindowFailure::Unavailable)?
            .minimize()
            .map_err(|_| WindowFailure::Minimize)
    }
}
pub fn focus(app: &tauri::AppHandle) {
    if let Err(code) = crate::lifecycle::focus_first(&Windows(app)) {
        eprintln!("{}", code.code());
    }
}
pub fn close(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    let Some(state) = app.try_state::<NativeState>() else {
        return;
    };
    if state.quit.is_approved() {
        return;
    }
    api.prevent_close();
    if let Err(code) = crate::lifecycle::close_resident(
        &Windows(app),
        window.label(),
        state.background.load(Ordering::SeqCst),
    ) {
        eprintln!("{}", code.code());
    }
}
/// Called after successful SPA selection, while the credential mutation owner is still held.
pub fn start_events(
    app: &tauri::AppHandle,
    connection: Connection,
    client: HarnessClient,
    token: SecretString,
) {
    let Some(state) = app.try_state::<NativeState>() else {
        return;
    };
    let generation = state.events.begin();
    *state.connection.lock().unwrap() = Some(connection.clone());
    let handle = app.clone();
    let task = tokio::spawn(async move {
        let (_cancel, stop) = tokio::sync::watch::channel(false);
        EventStream::default()
            .run(
                &client,
                &connection.installation_id,
                &token,
                stop,
                |update| {
                    enqueue_update(&handle, generation, update);
                },
            )
            .await;
    });
    state.events.install(generation, task);
}
fn enqueue_update(app: &tauri::AppHandle, generation: u64, update: EventUpdate) {
    let handle = app.clone();
    // Run the generation check and GUI mutation together on the main thread. Holding
    // EventOwner across a worker→GUI synchronous call could deadlock a concurrent switch.
    if app
        .run_on_main_thread(move || {
            let state = handle.state::<NativeState>();
            let applied = state.events.with_current(generation, || {
                let mut view = state.view.lock().unwrap();
                view.harness = update.state;
                view.secrets_locked = update.secrets_locked;
                let value = view.clone();
                drop(view);
                let _ = handle.emit_to(
                    tauri::EventTarget::webview_window("shell"),
                    "desktop-tray-state",
                    value,
                );
            });
            if applied.is_some() {
                if let Some(reason) = update.failure {
                    retire_terminal_session(&handle, generation, reason);
                }
            }
        })
        .is_err()
    {
        eprintln!("EVENT_UI_DISPATCH_FAILED");
    }
}

/// Uses WP4's persistence-before-delete policy; a foreign status string cannot reach this path.
pub fn mark_event_failure(
    connection: &mut Connection,
    failure: SessionFailure,
    tokens: &dyn crate::secrets::TokenStore,
    store: &crate::connections::Store,
) -> Result<(), crate::pair::PairError> {
    crate::pair::mark_failure(connection, &failure.client_error(), tokens, store)
}

fn retire_terminal_session(app: &tauri::AppHandle, generation: u64, failure: SessionFailure) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let action_handle = handle.clone();
        let result = crate::commands::credential_action(
            &handle.state::<crate::commands::ConnectionState>(),
            move |tokens, _| {
                let state = action_handle.state::<NativeState>();
                let row = state
                    .events
                    .with_current(generation, || state.connection.lock().unwrap().clone())
                    .flatten();
                let Some(mut row) = row else { return Ok(false) };
                let store = crate::commands::app_connection_store(&action_handle)?;
                let tokens = tokens.as_deref().ok_or("EVENT_TOKEN_UNAVAILABLE")?;
                mark_event_failure(&mut row, failure, tokens, &store)
                    .map_err(|_| "EVENT_REPAIR_PERSIST_FAILED")?;
                Ok(true)
            },
        )
        .await;
        // A persistence/keychain failure must not keep an unauthenticated SPA alive.
        // The GUI generation check still prevents retiring a newly selected connection.
        match result {
            Ok(false) => return,
            Err(_) => eprintln!("EVENT_REPAIR_PERSIST_FAILED"),
            Ok(true) => {}
        }
        {
            let gui = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let state = gui.state::<NativeState>();
                state.events.with_current(generation, || {
                    let _ = crate::spa::retire(&gui);
                    if let Some(window) = gui.get_webview_window("spa") {
                        let _ = window.destroy();
                    }
                    if let Some(window) = gui.get_webview_window("shell") {
                        let _ = window.eval("window.location.hash = '#/connections';");
                    }
                    if Windows(&gui).present("shell").is_err() {
                        eprintln!("PAIRING_WINDOW_PRESENT_FAILED");
                    }
                });
            });
        }
    });
}
