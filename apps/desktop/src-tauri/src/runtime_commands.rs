//! Shell-owned runtime operations. JavaScript receives no CLI, image or credential input.
use crate::{
    commands,
    controller::{bundle::embedded, Controller, HarnessStatus, Resources},
    runtime::{
        detect::{self, Detected, Endpoint, Env, Host},
        Runtime, RuntimeKind,
    },
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewWindow};
#[derive(Default)]
pub struct RuntimeState(pub tokio::sync::Mutex<RuntimeOwner>);
#[derive(Default)]
pub struct RuntimeOwner {
    detected: Vec<Detected>,
    controller: Option<Arc<Controller>>,
    watch: Option<tokio::task::JoinHandle<()>>,
    cancellation: Option<tokio_util::sync::CancellationToken>,
    pair_control: Option<Arc<crate::pair::PairControl>>,
    pub(crate) repair: crate::pair::BundledRepair,
    #[cfg(debug_assertions)]
    fixture: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeItem {
    pub id: String,
    #[serde(flatten)]
    pub detected: Detected,
}
fn id(d: &Detected) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(format!("{:?}:{}", d.kind, d.endpoint))
    )
}
fn env() -> Env {
    Env {
        host: if cfg!(target_os = "macos") {
            Host::Mac
        } else if cfg!(windows) {
            Host::Windows
        } else {
            Host::Linux
        },
        docker_host: std::env::var("DOCKER_HOST").ok(),
        xdg_runtime_dir: std::env::var_os("XDG_RUNTIME_DIR").map(Into::into),
        macos_major: macos_major(),
    }
}
#[cfg(target_os = "macos")]
fn macos_major() -> Option<u32> {
    let key = c"kern.osproductversion";
    let mut bytes = [0u8; 128];
    let mut len = bytes.len();
    // Read-only bounded OS version query; no shell process or user files.
    let result = unsafe {
        libc::sysctlbyname(
            key.as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0)
        .then(|| {
            std::str::from_utf8(&bytes[..len.min(bytes.len())])
                .ok()?
                .split('.')
                .next()?
                .parse()
                .ok()
        })
        .flatten()
}
#[cfg(not(target_os = "macos"))]
fn macos_major() -> Option<u32> {
    None
}
pub(crate) async fn resolve(
    window: &WebviewWindow,
    owner: &mut RuntimeOwner,
    selected: Option<&str>,
) -> Result<Arc<Controller>, String> {
    if let Some(c) = &owner.controller {
        if selected.is_some_and(|s| {
            s != id(&Detected {
                kind: c.info().kind,
                endpoint: c.info().endpoint.clone(),
                source: String::new(),
                version: String::new(),
                engine: String::new(),
                state: detect::DetectState::Ready,
            })
        }) {
            return Err("runtime-changed".into());
        }
        return Ok(c.clone());
    }
    let dir = commands::app_config_dir(window.app_handle())?.join("bundled");
    let installed_path = dir.join("installed.json");
    let saved = if installed_path.exists() {
        let meta = std::fs::symlink_metadata(&installed_path).map_err(|_| "storage")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 16384 {
            return Err("storage".into());
        }
        Some(
            serde_json::from_str::<crate::controller::Installed>(
                &crate::controller::read_private_json(&dir, "installed.json", 16384)
                    .map_err(|e| e.code())?,
            )
            .map_err(|_| "storage")?,
        )
    } else {
        None
    };
    let (kind, endpoint) = if let Some(saved) = saved {
        if selected.is_some_and(|s| {
            !owner
                .detected
                .iter()
                .any(|d| id(d) == s && d.kind == saved.runtime && d.endpoint == saved.endpoint)
        }) {
            return Err("runtime-changed".into());
        }
        (saved.runtime, saved.endpoint)
    } else {
        let d = owner
            .detected
            .iter()
            .find(|d| Some(id(d).as_str()) == selected)
            .ok_or("runtime-unavailable")?;
        (d.kind, d.endpoint.clone())
    };
    let runtime: Arc<dyn Runtime> = match kind {
        RuntimeKind::Apple => {
            if endpoint != "/usr/local/bin/container" {
                return Err("runtime-endpoint".into());
            }
            Arc::new(
                crate::runtime::apple::AppleRuntime::detect()
                    .await
                    .map_err(|e| e.message_key())?,
            )
        }
        RuntimeKind::Docker => Arc::new(
            crate::runtime::docker::DockerRuntime::connect(
                &Endpoint::parse(&endpoint).ok_or("runtime-endpoint")?,
            )
            .await
            .map_err(|e| e.message_key())?,
        ),
    };
    let c = Arc::new(
        Controller::new(runtime, embedded().clone(), dir).with_resource_dir(
            window
                .app_handle()
                .path()
                .resource_dir()
                .map_err(|_| "storage")?,
        ),
    );
    c.installed().map_err(|e| e.code())?;
    owner.controller = Some(c.clone());

    Ok(c)
}
#[tauri::command]
pub async fn runtime_detect(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
) -> Result<Vec<RuntimeItem>, String> {
    commands::check(&window, "runtime_detect")?;
    #[cfg(debug_assertions)]
    {
        let owner = state.0.lock().await;
        if owner.fixture {
            return Ok(owner
                .detected
                .iter()
                .map(|d| RuntimeItem {
                    id: id(d),
                    detected: d.clone(),
                })
                .collect());
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .ok_or("runtime-home")?;
    let detected = detect::detect_all(&env(), &home).await;
    let result = detected
        .iter()
        .map(|d| RuntimeItem {
            id: id(d),
            detected: d.clone(),
        })
        .collect();
    state.0.lock().await.detected = detected;
    Ok(result)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeRequest {
    pub runtime_id: String,
}
#[tauri::command]
pub async fn runtime_start(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
    request: RuntimeRequest,
) -> Result<(), String> {
    commands::check(&window, "runtime_start")?;
    let c = resolve(
        &window,
        &mut *state.0.lock().await,
        Some(&request.runtime_id),
    )
    .await?;
    c.runtime
        .ensure_started()
        .await
        .map_err(|e| e.message_key().into())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InstallRequest {
    pub runtime_id: String,
    pub agreed: bool,
    #[serde(default)]
    pub action: InstallAction,
}
#[derive(Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallAction {
    #[default]
    Start,
    Cancel,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledResult {
    connection_id: Option<uuid::Uuid>,
}
#[tauri::command]
pub async fn bundle_install(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
    credentials: tauri::State<'_, commands::ConnectionState>,
    request: InstallRequest,
) -> Result<InstalledResult, String> {
    commands::check(&window, "bundle_install")?;
    if request.action == InstallAction::Cancel {
        let owner = state.0.lock().await;
        let control = owner.pair_control.clone();
        let cancel = owner.cancellation.clone();
        drop(owner);
        if let Some(control) = control {
            if !tokio::task::spawn_blocking(move || control.cancel())
                .await
                .map_err(|_| "invalid")?
            {
                return Err("pair-already-committed".into());
            }
        }
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        return Ok(InstalledResult {
            connection_id: None,
        });
    }
    if !request.agreed {
        return Err("licences-required".into());
    }
    let allow_fixture = {
        #[cfg(debug_assertions)]
        {
            state.0.lock().await.fixture
        }
        #[cfg(not(debug_assertions))]
        {
            false
        }
    };
    embedded()
        .validate_release(allow_fixture)
        .map_err(str::to_owned)?;
    let c = resolve(
        &window,
        &mut *state.0.lock().await,
        Some(&request.runtime_id),
    )
    .await?;
    let cancel = {
        let mut owner = state.0.lock().await;
        if owner.cancellation.is_some() {
            return Err("install-busy".into());
        }
        let cancel = tokio_util::sync::CancellationToken::new();
        owner.cancellation = Some(cancel.clone());
        owner.pair_control = Some(Arc::new(crate::pair::PairControl::default()));
        cancel
    };
    let app = window.app_handle().clone();
    let progress_app = app.clone();
    let install = tokio::select! {
        _=cancel.cancelled()=>Err("cancelled".to_owned()),
        result=async {if matches!(c.status().await,HarnessStatus::Ready{..}) {return Ok(());}c.install(Resources::default(),move |step| {let _=progress_app.emit_to("shell","desktop-bundle-progress",step);}).await.map(|_|())}=>result.map_err(|e:crate::controller::CtlError|e.code().to_owned()),
    };
    if let Err(e) = install {
        state.0.lock().await.cancellation = None;
        return Err(e);
    }
    if let Err(e) = write_target(&window, &c) {
        state.0.lock().await.cancellation = None;
        return Err(e);
    }
    if let Err(e) = sync_origins(&app, c.clone()).await {
        let mut owner = state.0.lock().await;
        owner.cancellation = None;
        owner.pair_control = None;
        return Err(e);
    }
    let control = state.0.lock().await.pair_control.clone().ok_or("invalid")?;
    let store = commands::app_connection_store(&app)?;
    let paired = commands::credential_action(&credentials, move |tokens, runtime| {
        if let Some(old) = store
            .load()
            .map_err(|_| "storage")?
            .iter()
            .find(|row| row.kind == crate::connections::Kind::Bundled)
        {
            crate::native::retire_connection(&app, old.id);
        }
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let connection = runtime
            .block_on(crate::pair::pair_bundled_controlled(
                &c,
                tokens.as_ref(),
                &store,
                "PLUR1BUS",
                |step| {
                    let _ = app.emit_to("shell", "desktop-bundle-progress", step);
                },
                Some(&control),
            ))
            .map_err(|e| e.public_message())?;
        Ok(InstalledResult {
            connection_id: Some(connection.id),
        })
    })
    .await;
    let mut owner = state.0.lock().await;
    owner.cancellation = None;
    owner.pair_control = None;
    if cancel.is_cancelled() && paired.is_err() {
        return Err("cancelled".into());
    }
    if paired.is_ok() && owner.watch.is_none() {
        owner.watch = owner
            .controller
            .as_ref()
            .map(|c| native_watch(window.app_handle(), c.clone()));
    }
    paired
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StartRequest {
    pub memory_gib: Option<u8>,
}
#[tauri::command]
pub async fn harness_start(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
    request: StartRequest,
) -> Result<(), String> {
    commands::check(&window, "harness_start")?;
    let c = resolve(&window, &mut *state.0.lock().await, None).await?;
    if let Some(gib) = request.memory_gib {
        c.set_memory(gib).await
    } else {
        c.start().await
    }
    .map_err(|e| e.code())?;
    write_target(&window, &c)?;
    sync_origins(window.app_handle(), c.clone()).await?;
    let mut owner = state.0.lock().await;
    if owner.watch.is_none() {
        owner.watch = Some(native_watch(window.app_handle(), c));
    }
    Ok(())
}
#[tauri::command]
pub async fn harness_stop(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
) -> Result<(), String> {
    commands::check(&window, "harness_stop")?;
    let c = {
        let mut owner = state.0.lock().await;
        let c = resolve(&window, &mut owner, None).await?;
        if let Some(task) = owner.watch.take() {
            task.abort();
        }
        c
    };
    c.stop().await.map_err(|e| e.code().into())
}
#[tauri::command]
pub async fn harness_status(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
) -> Result<serde_json::Value, String> {
    commands::check(&window, "harness_status")?;
    if !commands::app_config_dir(window.app_handle())?
        .join("bundled/installed.json")
        .exists()
    {
        return Ok(serde_json::json!({"state":"not-installed"}));
    }
    match resolve(&window, &mut *state.0.lock().await, None).await {
        Ok(c) => {
            let mut value = serde_json::to_value(c.status().await).map_err(|_| "invalid")?;
            if let Ok(Some(i)) = c.installed() {
                value["resources"] = serde_json::to_value(i.resources).map_err(|_| "invalid")?;
            }
            Ok(value)
        }
        Err(_) => Ok(serde_json::json!({"state":"runtime-down"})),
    }
}
#[tauri::command]
pub async fn harness_logs_tail(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
) -> Result<String, String> {
    commands::check(&window, "harness_logs_tail")?;
    resolve(&window, &mut *state.0.lock().await, None)
        .await?
        .logs_tail(200)
        .await
        .map_err(|e| e.code().into())
}

fn write_target(_window: &WebviewWindow, c: &Controller) -> Result<(), String> {
    let installed = c
        .installed()
        .map_err(|e| e.code())?
        .ok_or("not-installed")?;
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        return crate::install::target_json::write(
            &commands::app_config_dir(_window.app_handle())?.join("forwarder"),
            &installed,
        )
        .map_err(|e| e.code().into());
    }
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("PLUR1BUS"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|p| std::path::PathBuf::from(p).join(".config"))
            })
            .map(|p| p.join("plur1bus"))
    }
    .ok_or("storage")?;
    crate::install::target_json::write(&base, &installed).map_err(|e| e.code().into())
}
/// Login waits for the saved endpoint only. No detected alternative is ever selected.
pub(crate) async fn on_login(window: WebviewWindow) -> Result<(), String> {
    if !commands::app_config_dir(window.app_handle())?
        .join("bundled/installed.json")
        .exists()
    {
        return Ok(());
    }
    let state = window.state::<RuntimeState>();
    let c = crate::controller::autostart::wait_socket(|| async {
        resolve(&window, &mut *state.0.lock().await, None)
            .await
            .ok()
    })
    .await?;
    crate::upgrade_commands::on_start(&window).await?;
    c.start().await.map_err(|e| e.code())?;
    sync_origins(window.app_handle(), c.clone()).await?;
    let mut owner = state.0.lock().await;
    if owner.watch.is_none() {
        owner.watch = Some(native_watch(window.app_handle(), c));
    }
    Ok(())
}

async fn sync_origins(app: &tauri::AppHandle, c: Arc<Controller>) -> Result<(), String> {
    let store = commands::app_connection_store(app)?;
    let handle = app.clone();
    commands::credential_action(&app.state::<commands::ConnectionState>(), move |_, _| {
        c.reconcile_connection_origins(&store, |id| crate::native::retire_connection(&handle, id))
            .map_err(|e| e.code().into())
    })
    .await?;
    let _ = crate::host_commands::resume_bundled(app).await;
    Ok(())
}
fn native_watch(app: &tauri::AppHandle, c: Arc<Controller>) -> tokio::task::JoinHandle<()> {
    let handle = app.clone();
    let weak = Arc::downgrade(&c);
    c.spawn_watch_with(Arc::new(move |status| {
        let app = handle.clone();
        let ctl = weak.upgrade();
        Box::pin(async move {
            if matches!(status, HarnessStatus::Ready { .. }) {
                if let Some(c) = ctl {
                    if sync_origins(&app, c).await.is_err() {
                        return;
                    }
                }
            }
            let _ = app.emit_to("shell", "desktop-harness-status", &status);
            crate::native::publish_controller(&app, status);
        })
    }))
}
pub(crate) async fn monitor_existing(window: WebviewWindow) -> Result<(), String> {
    crate::upgrade_commands::on_start(&window).await?;
    let _ = crate::host_commands::resume_bundled(window.app_handle()).await;
    if !commands::app_config_dir(window.app_handle())?
        .join("bundled/installed.json")
        .exists()
    {
        return Ok(());
    }
    let state = window.state::<RuntimeState>();
    let mut owner = state.0.lock().await;
    if owner.watch.is_some() {
        return Ok(());
    }
    let handle = window.app_handle().clone();
    let task_window = window.clone();
    owner.watch = Some(tokio::spawn(async move {
        let window = task_window;
        loop {
            let state = handle.state::<RuntimeState>();
            let c = resolve(&window, &mut *state.0.lock().await, None).await;
            match c {
                Ok(c) => {
                    let mut child = AbortWatch(native_watch(&handle, c));
                    let _ = (&mut child.0).await;
                    return;
                }
                Err(_) => {
                    let status = HarnessStatus::RuntimeDown;
                    let _ = handle.emit_to("shell", "desktop-harness-status", &status);
                    crate::native::publish_controller(&handle, status);
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }));
    Ok(())
}
struct AbortWatch(tokio::task::JoinHandle<()>);
impl Drop for AbortWatch {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(debug_assertions)]
impl RuntimeState {
    pub fn for_fixture(c: Arc<Controller>) -> Result<Self, &'static str> {
        if c.names.test.is_none() {
            return Err("fixture-namespace-required");
        }
        let info = c.info();
        let detected = Detected {
            kind: info.kind,
            endpoint: info.endpoint.clone(),
            source: "p1t-native-fixture".into(),
            version: info.version.clone(),
            engine: info.engine.clone(),
            state: detect::DetectState::Ready,
        };
        Ok(Self(tokio::sync::Mutex::new(RuntimeOwner {
            detected: vec![detected],
            controller: Some(c),
            fixture: true,
            ..Default::default()
        })))
    }
}
