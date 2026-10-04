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
    pub diagnostics: Mutex<Option<crate::diagnostics::Diagnostics>>,
    pub quit: QuitSession,
    pub view: Mutex<TrayState>,
    pub connection: Mutex<Option<Connection>>,
    pub background: AtomicBool,
    #[cfg(unix)]
    pub gnome: crate::gnome::GnomeState,
    #[cfg(debug_assertions)]
    pub fixture_autostart: AtomicBool,
    pub header: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}
impl NativeState {
    pub fn cancel_connection(&self, id: uuid::Uuid) -> bool {
        self.events.stop_if(|| {
            let mut active = self.connection.lock().unwrap();
            if active.as_ref().is_some_and(|row| row.id == id) {
                active.take();
                true
            } else {
                false
            }
        })
    }
}
/// Invoked inside the credential mutation owner, before removing or replacing a credential.
pub fn retire_connection(app: &tauri::AppHandle, id: uuid::Uuid) {
    let state = app.state::<NativeState>();
    if !state.cancel_connection(id) {
        return;
    }
    let generation = state.events.generation();
    let gui = app.clone();
    if app
        .run_on_main_thread(move || {
            let state = gui.state::<NativeState>();
            state.events.with_current(generation, || {
                if crate::spa::retire(&gui).is_err() {
                    eprintln!("CONNECTION_SESSION_RETIRE_FAILED");
                }
                if let Some(window) = gui.get_webview_window("spa") {
                    if window.destroy().is_err() {
                        eprintln!("CONNECTION_WINDOW_RETIRE_FAILED");
                    }
                }
                let mut view = state.view.lock().unwrap();
                view.harness = crate::tray::HarnessState::Unpaired;
                update_tray(&gui, &view);
                drop(view);
                navigate_shell(&gui, "#/connections");
            });
        })
        .is_err()
    {
        eprintln!("CONNECTION_RETIRE_DISPATCH_FAILED");
    }
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
    fn show(&self, label: &str) -> Result<(), WindowFailure> {
        self.0
            .get_webview_window(label)
            .ok_or(WindowFailure::Unavailable)?
            .show()
            .map_err(|_| WindowFailure::Show)
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
    if matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
        let app = window.app_handle();
        if let Some(state) = app.try_state::<NativeState>() {
            let view = state.view.lock().unwrap().clone();
            update_tray(app, &view);
        }
        return;
    }
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
            .run_async(
                &client,
                &connection.installation_id,
                &token,
                stop,
                |update| {
                    let handle = handle.clone();
                    async move {
                        enqueue_update(&handle, generation, update).await;
                    }
                },
            )
            .await;
    });
    state.events.install(generation, task);
}
async fn enqueue_update(app: &tauri::AppHandle, generation: u64, update: EventUpdate) {
    let handle = app.clone();
    let (ack, delivered) = tokio::sync::oneshot::channel();
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
                update_tray(&handle, &value);
                let _ = handle.emit_to(
                    tauri::EventTarget::webview_window("shell"),
                    "desktop-tray-state",
                    value,
                );
            });
            let _ = ack.send(
                applied
                    .is_some()
                    .then(|| state.view.lock().unwrap().clone()),
            );
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
    if let Ok(Some(view)) = delivered.await {
        #[cfg(unix)]
        if app
            .state::<NativeState>()
            .gnome
            .send(generation, view)
            .await
            .is_err()
        {
            eprintln!("GNOME_NOTIFY_QUEUE_CLOSED");
        }
        #[cfg(not(unix))]
        let _ = view;
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

pub fn request_quit(app: &tauri::AppHandle) -> crate::lifecycle::QuitOffer {
    let state = app.state::<NativeState>();
    let offer = state.quit.request(false);
    if Windows(app).present("shell").is_err() {
        eprintln!("QUIT_WINDOW_PRESENT_FAILED");
    }
    if app
        .emit_to(
            tauri::EventTarget::webview_window("shell"),
            "desktop-quit-offer",
            &offer,
        )
        .is_err()
    {
        eprintln!("QUIT_OFFER_EMIT_FAILED");
    }
    offer
}

pub(crate) fn navigate_shell(app: &tauri::AppHandle, route: &'static str) {
    if let Some(window) = app.get_webview_window("shell") {
        if window
            .eval(format!("window.location.hash = '{route}';"))
            .is_err()
        {
            eprintln!("SHELL_NAVIGATION_FAILED");
        }
    }
    if Windows(app).present("shell").is_err() {
        eprintln!("SHELL_WINDOW_PRESENT_FAILED");
    }
}
fn tray_menu(
    app: &tauri::AppHandle,
) -> tauri::Result<(
    tauri::menu::Menu<tauri::Wry>,
    tauri::menu::MenuItem<tauri::Wry>,
)> {
    use tauri::menu::{Menu, MenuItem};
    let header = MenuItem::with_id(app, "status", "PLUR1BUS — Not paired", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open PLUR1BUS", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start-harness", "Start harness", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop-harness", "Stop harness", false, None::<&str>)?;
    let runtime = MenuItem::with_id(app, "start-runtime", "Start runtime", false, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Update available…", false, None::<&str>)?;
    let connections = MenuItem::with_id(app, "connections", "Connections…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit PLUR1BUS", true, None::<&str>)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&header, &open];
    if app
        .state::<NativeState>()
        .connection
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|row| row.kind == crate::connections::Kind::Bundled)
    {
        items.extend([&start as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &stop]);
    }
    if cfg!(target_os = "macos") {
        items.push(&runtime);
    }
    items.extend([
        &update as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &connections,
        &settings,
        &quit,
    ]);
    let menu = Menu::with_items(app, &items)?;
    Ok((menu, header))
}
pub fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let (menu, header) = tray_menu(app)?;
    let state = app.state::<NativeState>();
    let image = tray_image(app, state.view.lock().unwrap().badge())?;
    tauri::tray::TrayIconBuilder::with_id("resident")
        .icon(image)
        .icon_as_template(false)
        .menu(&menu)
        .tooltip("PLUR1BUS — Not paired")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => focus(app),
            "connections" => navigate_shell(app, "#/connections"),
            "settings" => navigate_shell(app, "#/settings/runtime"),
            "quit" => {
                request_quit(app);
            }
            _ => {}
        })
        .build(app)?;
    *state.header.lock().unwrap() = Some(header);
    Ok(())
}
fn tray_image(
    app: &tauri::AppHandle,
    badge: crate::tray::Badge,
) -> tauri::Result<tauri::image::Image<'static>> {
    use crate::tray::Badge;
    let dark = app
        .get_webview_window("shell")
        .and_then(|window| window.theme().ok())
        == Some(tauri::Theme::Dark);
    let bytes: &[u8] = match (badge, dark) {
        (Badge::Running, false) => include_bytes!("../icons/tray/running-light.png"),
        (Badge::Running, true) => include_bytes!("../icons/tray/running-dark.png"),
        (Badge::Busy, false) => include_bytes!("../icons/tray/busy-light.png"),
        (Badge::Busy, true) => include_bytes!("../icons/tray/busy-dark.png"),
        (Badge::Attention, false) => include_bytes!("../icons/tray/attention-light.png"),
        (Badge::Attention, true) => include_bytes!("../icons/tray/attention-dark.png"),
        (Badge::Update, false) => include_bytes!("../icons/tray/update-light.png"),
        (Badge::Update, true) => include_bytes!("../icons/tray/update-dark.png"),
    };
    tauri::image::Image::from_bytes(bytes)
}
fn update_tray(app: &tauri::AppHandle, view: &TrayState) {
    let state = app.state::<NativeState>();
    let connection = state
        .connection
        .lock()
        .unwrap()
        .as_ref()
        .map(|row| row.name.clone())
        .unwrap_or_else(|| "No connection".into());
    let runtime = match view.runtime {
        Some(crate::tray::RuntimeState::Ready) => " — Runtime running",
        Some(crate::tray::RuntimeState::Stopped) => " — Runtime stopped",
        Some(crate::tray::RuntimeState::Missing) => " — Runtime missing",
        None => "",
    };
    let text = format!(
        "PLUR1BUS — {connection} — {}{runtime}",
        view.harness.words()
    );
    if let Some(header) = state.header.lock().unwrap().as_ref() {
        if header.set_text(&text).is_err() {
            eprintln!("TRAY_TEXT_FAILED");
        }
    }
    if let Some(tray) = app.tray_by_id("resident") {
        match tray_menu(app) {
            Ok((menu, header)) => {
                if header.set_text(&text).is_err() {
                    eprintln!("TRAY_TEXT_FAILED");
                }
                if tray.set_menu(Some(menu)).is_err() {
                    eprintln!("TRAY_MENU_FAILED");
                }
                *state.header.lock().unwrap() = Some(header);
            }
            Err(_) => eprintln!("TRAY_MENU_FAILED"),
        }
        if tray.set_tooltip(Some(&text)).is_err() {
            eprintln!("TRAY_TOOLTIP_FAILED");
        }
        match tray_image(app, view.badge()) {
            Ok(image) => {
                if tray.set_icon(Some(image)).is_err() {
                    eprintln!("TRAY_ICON_FAILED");
                }
            }
            Err(_) => eprintln!("TRAY_IMAGE_FAILED"),
        }
    }
}
