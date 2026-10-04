//! Unix-compiled GNOME adapters; started only by the Linux production app.
use crate::{
    native::NativeState,
    notify::{self, Action, ActionLedger, Banner},
    tray::TrayState,
};
use futures_util::StreamExt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::async_runtime::JoinHandle;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

#[derive(Default)]
pub struct GnomeState {
    sender: Mutex<Option<mpsc::Sender<(u64, TrayState)>>>,
    task: Mutex<Option<JoinHandle<()>>>,
    pub granted_background: AtomicBool,
    tray_host: AtomicBool,
    pub hinted: AtomicBool,
    pub hint_pending: AtomicBool,
    pub autostart_grant: Mutex<Option<bool>>,
    portal_busy: tokio::sync::Mutex<()>,
}
impl GnomeState {
    pub async fn send(&self, generation: u64, state: TrayState) -> Result<(), ()> {
        let sender = self.sender.lock().unwrap().clone();
        if let Some(sender) = sender {
            sender.send((generation, state)).await.map_err(|_| ())?;
        }
        Ok(())
    }

    pub fn notice(&self, generation: u64, state: TrayState) {
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            if sender.try_send((generation, state)).is_err() {
                eprintln!("GNOME_NOTIFY_QUEUE_FULL");
            }
        }
    }
    pub fn stop(&self) {
        self.sender.lock().unwrap().take();
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
    }
}
impl Drop for GnomeState {
    fn drop(&mut self) {
        if let Ok(slot) = self.task.get_mut() {
            if let Some(task) = slot.take() {
                task.abort();
            }
        }
    }
}
/// D-Bus application endpoint; injected dispatcher permits private transport tests without OS windows.
pub struct Application(std::sync::Arc<dyn Fn() -> Result<(), notify::NotifyFailure> + Send + Sync>);
impl Application {
    pub fn new(
        dispatch: impl Fn() -> Result<(), notify::NotifyFailure> + Send + Sync + 'static,
    ) -> Self {
        Self(std::sync::Arc::new(dispatch))
    }
    fn native(app: tauri::AppHandle) -> Self {
        Self::new(move || {
            let gui = app.clone();
            app.run_on_main_thread(move || {
                crate::native::request_quit(&gui);
            })
            .map_err(|_| notify::NotifyFailure)
        })
    }
}
#[zbus::interface(name = "org.freedesktop.Application")]
impl Application {
    fn activate_action(
        &self,
        action_name: &str,
        _parameters: Vec<zbus::zvariant::OwnedValue>,
        _platform_data: std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
    ) -> zbus::fdo::Result<()> {
        if action_name != "quit" {
            return Err(zbus::fdo::Error::InvalidArgs("ACTION_UNAVAILABLE".into()));
        }
        (self.0)().map_err(|_| zbus::fdo::Error::Failed("QUIT_DISPATCH_FAILED".into()))
    }
}
pub fn start(app: &tauri::AppHandle) {
    let state = app.state::<NativeState>();
    let (sender, mut receiver) = mpsc::channel(64);
    *state.gnome.sender.lock().unwrap() = Some(sender);
    let handle = app.clone();
    let mut pending = None;
    let mut connection: Option<zbus::Connection> = None;
    let task = tauri::async_runtime::spawn(async move {
        loop {
            if handle.state::<NativeState>().quit.is_approved() {
                break;
            }
            if connection.is_none() {
                match connect_application(&handle).await {
                    Ok(value) => connection = Some(value),
                    Err(_) => {
                        eprintln!("GNOME_BUS_CONNECT_FAILED");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                }
            }
            let bus = connection.as_ref().unwrap();
            let failed = run(&handle, bus, &mut receiver, &mut pending)
                .await
                .is_err();
            let closed = bus.is_closed();
            if closed {
                connection = None;
            }
            if failed {
                eprintln!("GNOME_CONNECTION_FAILED");
                let state = handle.state::<NativeState>();
                state.gnome.tray_host.store(false, Ordering::SeqCst);
                state.background.store(
                    state.gnome.granted_background.load(Ordering::SeqCst),
                    Ordering::SeqCst,
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
    *state.gnome.task.lock().unwrap() = Some(task);
}
async fn run(
    app: &tauri::AppHandle,
    connection: &zbus::Connection,
    receiver: &mut mpsc::Receiver<(u64, TrayState)>,
    pending: &mut Option<(u64, TrayState)>,
) -> Result<(), notify::NotifyFailure> {
    // Subscribe before Notify; a fast action can precede its method reply.
    let mut actions = notify::dbus::subscribe_actions(connection).await?;
    let mut ledger = ActionLedger::default();
    let mut last: Option<(u64, TrayState)> = None;
    let mut host = false;
    let mut probe = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = probe.tick() => {
                host = notify::dbus::tray_host(connection).await.unwrap_or(false) && app.tray_by_id("resident").is_some();
                let state = app.state::<NativeState>();
                state.gnome.tray_host.store(host, Ordering::SeqCst);
                state.background.store(host || state.gnome.granted_background.load(Ordering::SeqCst), Ordering::SeqCst);
                if host { last = None; }
                else {
                    if !is_flatpak() && !state.gnome.hinted.swap(true,Ordering::SeqCst) { state.gnome.hint_pending.store(true,Ordering::SeqCst); let _ = app.emit_to(tauri::EventTarget::webview_window("shell"),"desktop-background-hint",()); }
                    state.gnome.notice(state.events.generation(),state.view.lock().unwrap().clone());
                }
            }
            notice = next_notice(receiver, pending) => {
                let Some((generation,view)) = notice else {return Ok(())};
                if app.state::<NativeState>().events.with_current(generation,||()).is_none() { *pending = None; continue; }
                if is_flatpak() && app.state::<NativeState>().gnome.granted_background.load(Ordering::SeqCst)
                    && notify::portal::set_status(connection,&view).await.is_err() { eprintln!("BACKGROUND_PORTAL_STATUS_FAILED"); }
                if host || last.as_ref() == Some(&(generation,view.clone())) || app.state::<NativeState>().events.with_current(generation,||()).is_none() { *pending = None; continue; }
                let banner = Banner::from_state(&view);
                match notify::dbus::show(connection,&banner).await {
                    Ok(id) => {ledger.record(id,generation,banner.actions);last=Some((generation,view)); *pending = None; },
                    Err(_) => { *pending = Some((generation,view)); eprintln!("GNOME_NOTIFY_FAILED"); },
                }
            }
            signal = actions.next() => {
                let Some(signal) = signal else {return Err(notify::NotifyFailure)};
                let Ok((id,_)) = signal.body().deserialize::<(u32,String)>() else {continue};
                let generation = app.state::<NativeState>().events.generation();
                if let Some(action) = notify::dbus::owned_action(&signal,&mut ledger,generation) {
                    if notify::dbus::close(connection,id).await.is_err() { eprintln!("GNOME_NOTIFY_CLOSE_FAILED"); }
                    dispatch(app,generation,action);
                }
            }
        }
    }
}
fn dispatch(app: &tauri::AppHandle, generation: u64, action: Action) {
    let gui = app.clone();
    if app
        .run_on_main_thread(move || {
            gui.state::<NativeState>()
                .events
                .with_current(generation, || match action {
                    Action::Open => crate::native::focus(&gui),
                    Action::ShowLog => crate::native::navigate_shell(&gui, "#/settings/advanced"),
                    Action::StartAgain => {
                        eprintln!("HARNESS_START_UNAVAILABLE");
                        crate::native::navigate_shell(&gui, "#/settings/runtime");
                    }
                    Action::Update => crate::native::navigate_shell(&gui, "#/settings/updates"),
                    Action::Dismiss | Action::Later => {}
                });
        })
        .is_err()
    {
        eprintln!("GNOME_ACTION_DISPATCH_FAILED");
    }
}

/// Flatpak registration is mediated by the portal, never by host launch files.
pub fn is_flatpak() -> bool {
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("FLATPAK_ID").is_ok_and(|id| id == crate::ids::BUNDLE_ID)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}
pub async fn request_autostart(
    app: &tauri::AppHandle,
    enabled: bool,
) -> Result<bool, &'static str> {
    let state = app.state::<NativeState>();
    let _request = state.gnome.portal_busy.lock().await;
    let connection = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        zbus::Connection::session(),
    )
    .await
    .map_err(|_| "BACKGROUND_PORTAL_TIMEOUT")?
    .map_err(|_| "BACKGROUND_PORTAL_UNAVAILABLE")?;
    let executable = std::env::current_exe().map_err(|_| "AUTOSTART_EXECUTABLE_UNAVAILABLE")?;
    let executable = executable
        .to_str()
        .ok_or("AUTOSTART_EXECUTABLE_UNAVAILABLE")?;
    let grant = notify::portal::request_background(&connection, enabled, executable)
        .await
        .map_err(|_| "BACKGROUND_PORTAL_REQUEST_FAILED")?;
    state
        .gnome
        .granted_background
        .store(grant.background, Ordering::SeqCst);
    *state.gnome.autostart_grant.lock().unwrap() = Some(grant.autostart);
    // A denied or partial grant must immediately replace the previous background grant.
    state.background.store(
        grant.background || state.gnome.tray_host.load(Ordering::SeqCst),
        Ordering::SeqCst,
    );
    if grant.background {
        let view = state.view.lock().unwrap().clone();
        if notify::portal::set_status(&connection, &view)
            .await
            .is_err()
        {
            eprintln!("BACKGROUND_PORTAL_STATUS_FAILED");
        }
    }
    Ok(grant.autostart)
}

/// Cancellation leaves the caller-owned retry untouched and does not drain later events.
pub async fn next_notice(
    receiver: &mut mpsc::Receiver<(u64, TrayState)>,
    pending: &Option<(u64, TrayState)>,
) -> Option<(u64, TrayState)> {
    if let Some(value) = pending.as_ref() {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        Some(value.clone())
    } else {
        receiver.recv().await
    }
}

async fn connect_application(
    app: &tauri::AppHandle,
) -> Result<zbus::Connection, notify::NotifyFailure> {
    let connection = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        zbus::connection::Builder::session()?
            .name(crate::ids::BUNDLE_ID)?
            .serve_at("/app/plur1bus/desktop", Application::native(app.clone()))?
            .build()
            .await
    })
    .await
    .map_err(|_| notify::NotifyFailure)?
    .map_err(|_| notify::NotifyFailure)?;
    Ok(connection)
}

#[cfg(test)]
mod queue_tests {
    use super::*;
    #[tokio::test]
    async fn production_notification_send_waits_for_capacity_without_losing_order() {
        let (sender, mut receiver) = mpsc::channel(64);
        let state = std::sync::Arc::new(GnomeState::default());
        *state.sender.lock().unwrap() = Some(sender);
        for generation in 1..=64 {
            state.send(generation, TrayState::default()).await.unwrap();
        }
        let producer = state.clone();
        let mut task = tokio::spawn(async move { producer.send(65, TrayState::default()).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut task)
                .await
                .is_err()
        );
        assert_eq!(receiver.recv().await.unwrap().0, 1);
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        for generation in 2..=65 {
            assert_eq!(receiver.recv().await.unwrap().0, generation);
        }
        assert!(receiver.try_recv().is_err());
    }
}
