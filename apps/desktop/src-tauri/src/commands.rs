use crate::settings::{Settings, SettingsStore};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

pub use crate::host_commands::{
    approval_decide, approval_open, approvals_list, bridge_settings, helper_status,
    permissions_open_pane,
};
pub use crate::shell_commands::{APP_COMMANDS, SHELL_COMMANDS};

pub fn allowed_command(label: &str, command: &str) -> bool {
    (label == "shell" && SHELL_COMMANDS.contains(&command))
        || (label == "approvals"
            && [
                "app_info",
                "settings_get",
                "approvals_list",
                "approval_open",
                "approval_decide",
            ]
            .contains(&command))
}

pub fn authorized_shell(label: &str, current_url: &str) -> bool {
    if label != "shell" && label != "approvals" {
        return false;
    }
    let Ok(url) = tauri::Url::parse(current_url) else {
        return false;
    };
    let host = url.host_str();
    let exact_origin = match url.scheme() {
        "tauri" => host == Some("localhost") && url.port().is_none(),
        "http" => host == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    };
    exact_origin && url.username().is_empty() && url.password().is_none()
}

pub(crate) fn check(window: &WebviewWindow, command: &str) -> Result<(), String> {
    let current_url = window.url().map_err(|_| "shell URL unavailable")?;
    if !allowed_command(window.label(), command)
        || !authorized_shell(window.label(), current_url.as_str())
    {
        return Err("command unavailable for this window".into());
    }
    Ok(())
}

fn store(window: &WebviewWindow) -> Result<SettingsStore, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        return Ok(SettingsStore::new(dir.into()));
    }
    let dir = window
        .app_handle()
        .path()
        .app_config_dir()
        .map_err(|error| format!("settings location failed: {error}"))?;
    Ok(SettingsStore::new(dir))
}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub store_managed: bool,
    pub sandboxed: bool,
    pub platform: &'static str,
    pub locale: String,
}

pub fn linux_desktop(value: &str) -> &'static str {
    let names = value.to_ascii_uppercase();
    if names
        .split([':', ';'])
        .any(|name| name.contains("KDE") || name.contains("PLASMA"))
    {
        "kde"
    } else {
        "gnome"
    }
}

#[tauri::command]
pub fn app_info(window: WebviewWindow) -> Result<AppInfo, String> {
    check(&window, "app_info")?;
    let platform = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "windows") {
        "win"
    } else {
        linux_desktop(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default())
    };
    Ok(AppInfo {
        store_managed: cfg!(feature = "store"),
        sandboxed: cfg!(target_os = "linux") && std::env::var_os("FLATPAK_ID").is_some(),
        platform,
        locale: sys_locale::get_locale().unwrap_or_else(|| "en".into()),
    })
}

#[tauri::command]
pub fn settings_get(window: WebviewWindow) -> Result<Settings, String> {
    check(&window, "settings_get")?;
    store(&window)?.get()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsSetRequest {
    pub settings: Settings,
}

#[tauri::command]
pub fn settings_set(
    window: WebviewWindow,
    request: SettingsSetRequest,
) -> Result<Settings, String> {
    check(&window, "settings_set")?;
    store(&window)?.set(&request.settings)?;
    if window
        .app_handle()
        .try_state::<crate::native::NativeState>()
        .is_some()
    {
        crate::native::refresh_language(window.app_handle(), request.settings.locale);
    }
    Ok(request.settings)
}

// One owner serializes all connection/token mutations; listing never initializes tokens.
#[derive(Default, Clone)]
pub struct ConnectionState(
    pub std::sync::Arc<tokio::sync::Mutex<Option<Box<dyn crate::secrets::TokenStore>>>>,
    // Mirror of the opened token store's kind, published when a credential action
    // ends. Listing reads it without the owner lock, which a credential action may
    // hold for network and keychain I/O (startup resume, pairing, prompts).
    std::sync::Arc<std::sync::Mutex<Option<crate::secrets::StoreKind>>>,
);
impl ConnectionState {
    /// State around an already-opened token store; the kind mirror starts empty until a
    /// credential action publishes it.
    pub fn new(
        store: std::sync::Arc<tokio::sync::Mutex<Option<Box<dyn crate::secrets::TokenStore>>>>,
    ) -> Self {
        Self(store, Default::default())
    }
    /// Kind of the credential store as of the last finished action; `None` until one opened it.
    /// Never waits for the owner lock.
    pub fn store_kind(&self) -> Option<crate::secrets::StoreKind> {
        *self.1.lock().unwrap_or_else(|e| e.into_inner())
    }
}
/// Keep the mutation lock across the complete action while running synchronous
/// credential APIs (including interactive prompts) outside async runtime workers.
pub(crate) async fn credential_action<T: Send + 'static>(
    state: &ConnectionState,
    action: impl FnOnce(
            &mut Option<Box<dyn crate::secrets::TokenStore>>,
            tokio::runtime::Handle,
        ) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    let mut guard = state.0.clone().lock_owned().await;
    let runtime = tokio::runtime::Handle::current();
    let kind = state.1.clone();
    tokio::task::spawn_blocking(move || {
        let result = action(&mut guard, runtime);
        *kind.lock().unwrap_or_else(|e| e.into_inner()) = guard.as_ref().map(|t| t.kind());
        result
    })
    .await
    .map_err(|_| "keychain-error".to_owned())?
}
fn connection_store(window: &WebviewWindow) -> Result<crate::connections::Store, String> {
    app_connection_store(window.app_handle())
}
pub(crate) fn app_connection_store(
    app: &tauri::AppHandle,
) -> Result<crate::connections::Store, String> {
    Ok(crate::connections::Store::open(&app_config_dir(app)?))
}
pub(crate) fn app_config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR") {
        return Ok(dir.into());
    }
    app.path().app_config_dir().map_err(|_| "storage".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionList {
    pub connections: Vec<crate::connections::Connection>,
    pub active: Option<uuid::Uuid>,
    pub token_store: Option<crate::secrets::StoreKind>,
    /// The path of every remote connection (transport choice spec §3.2, §7.3); bundled and local rows have none.
    pub transports: std::collections::BTreeMap<uuid::Uuid, crate::transport::TransportView>,
    /// Whether `connection-transport.json` can be written (`read-only-newer`: `transport.store.newer`).
    pub transport_store: crate::transport::StoreMode,
}
/// The app's transport state: the real seams, and its check lines on stderr beside the other diagnostic codes.
pub fn transports() -> crate::transport::Transports {
    crate::transport::Transports::production(std::sync::Arc::new(|line: &str| eprintln!("{line}")))
}
pub(crate) fn transport_store(
    app: &tauri::AppHandle,
) -> Result<crate::transport::TransportStore, String> {
    Ok(crate::transport::TransportStore::open(&app_config_dir(
        app,
    )?))
}
/// What to check (transport choice spec §7.1): an origin being added, a bare host (SSH, later packages), or an
/// existing remote connection under a path the person may be changing.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "kind")]
pub enum CheckTarget {
    Origin { origin: String },
    Host { host: String, port: u16 },
    Connection { id: uuid::Uuid },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TransportCheckRequest {
    pub target: CheckTarget,
    pub transport: crate::transport::Transport,
    pub purpose: crate::transport::Purpose,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TransportSetRequest {
    pub id: uuid::Uuid,
    pub transport: crate::transport::Transport,
    pub public_ack: bool,
}
/// A bare host target from IPC: the host string validated by spec §4.4 (`host-invalid`, `host-ipv4-noncanonical`), a
/// port that can be connected to.
pub fn host_target(host: &str, port: u16) -> Result<(crate::transport::HostInput, u16), String> {
    if port == 0 {
        return Err("invalid".into());
    }
    let host = crate::transport::HostInput::parse(host).map_err(|e| e.code().to_owned())?;
    Ok((host, port))
}
/// The advisory check of the shell's check panel (spec §7.1, §5.4): one per window, a newer one supersedes it
/// (`transport-check-busy`). Only a host string (validated, spec §4.4), a port, enums and a connection id cross IPC.
#[tauri::command]
pub async fn transport_check(
    window: WebviewWindow,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: TransportCheckRequest,
) -> Result<crate::transport::TransportReport, String> {
    check(&window, "transport_check")?;
    use crate::transport::{HostInput, TargetInput, TransportError};
    let app = window.app_handle();
    let store = app_connection_store(app)?;
    let tstore = transport_store(app)?;
    let row = match &request.target {
        CheckTarget::Connection { id } => Some(
            store
                .load()
                .map_err(|_| "storage")?
                .into_iter()
                .find(|c| c.id == *id && c.kind == crate::connections::Kind::Remote)
                .ok_or("invalid")?,
        ),
        _ => None,
    };
    let (host, port) = match &request.target {
        CheckTarget::Origin { origin } => {
            let origin =
                crate::connections::Origin::parse(origin).map_err(|_| "insecure-origin")?;
            HostInput::from_origin(&origin).map_err(|e| e.code())?
        }
        CheckTarget::Host { host, port } => host_target(host, *port)?,
        CheckTarget::Connection { .. } => {
            let row = row.as_ref().ok_or("invalid")?;
            HostInput::from_origin(&row.origin).map_err(|e| e.code())?
        }
    };
    let input = TargetInput {
        host,
        port,
        transport: request.transport,
        purpose: request.purpose,
    };
    transports
        .check_for_window(
            window.label(),
            transports.check_input(&input, row.as_ref().map(|row| (&tstore, row))),
        )
        .await
        .map_err(|e: TransportError| e.code().to_owned())
}
/// *Weg ändern…* and *Bestätigen und verbinden* (spec §7.1, §8): stores the path of a remote connection after a fresh
/// check; `publicAck` is stored only when that check finds the target public.
#[tauri::command]
pub async fn connection_transport_set(
    window: WebviewWindow,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: TransportSetRequest,
) -> Result<crate::transport::TransportReport, String> {
    check(&window, "connection_transport_set")?;
    let app = window.app_handle().clone();
    let row = app_connection_store(&app)?
        .load()
        .map_err(|_| "storage")?
        .into_iter()
        .find(|c| c.id == request.id && c.kind == crate::connections::Kind::Remote)
        .ok_or("invalid")?;
    let result = transports
        .set_transport(
            &transport_store(&app)?,
            &row,
            request.transport,
            request.public_ack,
        )
        .await
        .map_err(str::to_owned);
    // The tray switch shows each connection's path.
    crate::native::connections_changed(&app);
    result
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionIdRequest {
    pub id: uuid::Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameRequest {
    pub id: uuid::Uuid,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PairCodeRequest {
    pub origin: String,
    pub name: String,
    pub code: String,
    pub repair_id: Option<uuid::Uuid>,
    pub link_id: Option<u64>,
    /// The path the person chose (spec §7.1, required, no preselection).
    pub transport: crate::transport::Transport,
    /// The person ticked the public-address confirmation; honoured only when Rust's fresh check needs it.
    pub public_ack: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairLocalRequest {
    pub name: String,
    #[serde(default)]
    pub extensions: bool,
    #[serde(default)]
    pub imports: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub connection: crate::connections::Connection,
    pub token_store: crate::secrets::StoreKind,
}
#[tauri::command]
pub async fn connections_list(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
) -> Result<ConnectionList, String> {
    check(&window, "connections_list")?;
    // Listing never acquires credentials and never waits for the credential owner.
    let store = connection_store(&window)?;
    let connections = store.load().map_err(|_| "storage")?;
    let tstore = transport_store(window.app_handle())?;
    let views = connections
        .iter()
        .filter(|c| c.kind == crate::connections::Kind::Remote)
        .map(|c| (c.id, transports.view(&tstore, c)))
        .collect();
    Ok(ConnectionList {
        connections,
        active: store.active().map_err(|_| "storage")?,
        token_store: state.store_kind(),
        transports: views,
        transport_store: tstore.mode(),
    })
}
#[tauri::command]
pub async fn connections_rename(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: RenameRequest,
) -> Result<(), String> {
    check(&window, "connections_rename")?;
    let _lock = state.0.lock().await;
    let store = connection_store(&window)?;
    let mut row = store
        .load()
        .map_err(|_| "storage")?
        .into_iter()
        .find(|c| c.id == request.id)
        .ok_or("invalid")?;
    row.name = request.name.trim().to_owned();
    store.upsert(row).map_err(|_| "invalid")?;
    crate::native::connections_changed(window.app_handle());
    Ok(())
}
#[tauri::command]
pub async fn connections_remove(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: ConnectionIdRequest,
) -> Result<(), String> {
    check(&window, "connections_remove")?;
    let store = connection_store(&window)?;
    let tstore = transport_store(window.app_handle())?;
    let app = window.app_handle().clone();
    let changed = app.clone();
    let result = credential_action(&state, move |tokens, _| {
        crate::native::retire_connection(&app, request.id);
        crate::pair::remove_connection(
            &store,
            request.id,
            tokens.as_deref(),
            crate::secrets::open_for_removal().as_ref(),
        )
        .map_err(|e| e.public_message())?;
        // Spec §3.2: keychain, then metadata, then the sidecar entry.
        match app.try_state::<crate::transport::Transports>() {
            Some(transports) => transports.forget(&tstore, request.id),
            None => {
                let _ = tstore.remove(request.id);
            }
        }
        Ok(())
    })
    .await;
    crate::native::connections_changed(&changed);
    result
}
#[tauri::command]
pub async fn pair_code(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: PairCodeRequest,
) -> Result<Paired, String> {
    check(&window, "pair_code")?;
    let store = connection_store(&window)?;
    let tstore = transport_store(window.app_handle())?;
    // A link always creates a new connection. An existing connection can never be repaired or
    // replaced by an external offer, and the renderer cannot substitute the offer's trust.
    let offer = match request.link_id {
        Some(id) if request.repair_id.is_none() => Some(
            window
                .state::<crate::deeplink::LinkState>()
                .0
                .lock()
                .unwrap()
                .confirm_pair(id, &request.origin, &request.code)
                .ok_or("invalid")?,
        ),
        Some(_) => return Err("invalid".into()),
        None => None,
    };
    // Transport choice spec §7.1: the UI's check is advisory; Rust re-runs it before any TCP connection to the
    // harness and pairs over exactly the checked addresses.
    let origin = match &offer {
        Some(crate::deeplink::DeepLink::Pair { origin, .. }) => origin.clone(),
        _ => crate::connections::Origin::parse(&request.origin).map_err(|_| "insecure-origin")?,
    };
    let checked = transports
        .check_pair(&origin, request.transport, request.public_ack)
        .await
        .map_err(|e| e.code().to_owned())?;
    let connect = checked.pin.clone();
    let code = crate::secrets::SecretString::new(request.code);
    let app = window.app_handle().clone();
    let result = credential_action(&state, move |tokens, runtime| {
        if let Some(id) = request.repair_id {
            crate::native::retire_connection(&app, id);
        }
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let connection = runtime
            .block_on(async {
                if let Some(crate::deeplink::DeepLink::Pair {
                    origin, pin, ca, ..
                }) = offer
                {
                    let client = crate::client::HarnessClient::from_pairing_payload_pinned(
                        origin,
                        pin,
                        ca,
                        Some(connect),
                    )
                    .await
                    .map_err(crate::pair::PairError::from)?;
                    crate::pair::pair_using_client(
                        client,
                        code.expose(),
                        &request.name,
                        crate::connections::Kind::Remote,
                        None,
                        None,
                        tokens.as_ref(),
                        &store,
                    )
                    .await
                } else {
                    crate::pair::pair_code_pinned(
                        &request.origin,
                        code.expose(),
                        &request.name,
                        tokens.as_ref(),
                        &store,
                        request.repair_id,
                        Some(connect),
                    )
                    .await
                }
            })
            .map_err(|e| e.public_message())?;
        Ok(Paired {
            connection,
            token_store: tokens.kind(),
        })
    })
    .await;
    if let Ok(paired) = &result {
        // After the connection row exists (spec §3.2); a store that cannot persist holds a confirmation for this
        // session instead.
        let _ = transports.record_pairing(
            &tstore,
            &paired.connection,
            request.transport,
            &checked.report,
        );
        if let Some(id) = request.link_id {
            window
                .state::<crate::deeplink::LinkState>()
                .0
                .lock()
                .unwrap()
                .finish_pair(id);
        }
        crate::native::connections_changed(window.app_handle());
    }
    result
}
#[tauri::command]
pub async fn pair_local(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    request: PairLocalRequest,
) -> Result<Paired, String> {
    check(&window, "pair_local")?;
    let root = crate::discovery::state_root().ok_or("cli-missing")?;
    let record = crate::discovery::discover(&root, crate::discovery::alive).ok_or("cli-missing")?;
    if !crate::discovery::reachable(&record).await {
        return Err("cli-missing".into());
    }
    let cli = crate::pair::resolve_cli().ok_or("cli-missing")?;
    let offer = if record.current {
        crate::pair::pair_local_current(
            &cli,
            &request.name,
            crate::pair::PairGrants {
                extensions: request.extensions,
                imports: request.imports,
            },
        )
        .await
    } else if request.extensions || request.imports {
        return Err("incompatible".into());
    } else {
        crate::pair::pair_local(&cli, &request.name).await
    }
    .map_err(|e| e.public_message())?;
    if offer
        .origin
        .as_ref()
        .is_some_and(|origin| *origin != record.url)
    {
        return Err("installation-mismatch".into());
    }
    let code = crate::secrets::SecretString::new(offer.code);
    let store = connection_store(&window)?;
    let result = credential_action(&state, move |tokens, runtime| {
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let connection = runtime
            .block_on(crate::pair::pair(
                record.url,
                code.expose(),
                &request.name,
                crate::connections::Kind::Local,
                Some(&record.installation_id),
                None,
                tokens.as_ref(),
                &store,
            ))
            .map_err(|e| e.public_message())?;
        Ok(Paired {
            connection,
            token_store: tokens.kind(),
        })
    })
    .await;
    crate::native::connections_changed(window.app_handle());
    result
}
#[derive(Serialize)]
pub struct Opened {
    pub selected: bool,
    pub spa_available: bool,
    /// The fresh check of a remote connection's open (its notices for the page; spec §7.1).
    pub transport: Option<crate::transport::TransportReport>,
}
#[tauri::command]
pub async fn open_connection(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: ConnectionIdRequest,
) -> Result<Opened, String> {
    check(&window, "open_connection")?;
    let store = connection_store(&window)?;
    let app = window.app_handle().clone();
    // Transport choice spec §7.1, §9.2: a remote connection is checked and gated before any harness contact; a public
    // target without a valid confirmation returns `transport-confirm-needed` and nothing connects. Metadata is read
    // without the credential owner, as listing does. The tray switch takes the same path (desktop spec §6.3).
    let owner = state.inner().clone();
    let connect_app = app.clone();
    let result = transports
        .open_gated(
            &store,
            &transport_store(&app)?,
            request.id,
            |listed, checked| connect_checked(connect_app, owner, listed, checked),
        )
        .await;
    crate::native::connections_changed(&app);
    result
}
/// The harness contact of an open, after its gate ([`crate::transport::Transports::open_gated`]): `listed` is the row
/// the gate checked, `checked` its check and path. Shared by `open_connection` and the tray switch.
pub(crate) async fn connect_checked(
    app: tauri::AppHandle,
    state: ConnectionState,
    listed: crate::connections::Connection,
    checked: Option<(crate::transport::CheckedTarget, crate::transport::Transport)>,
) -> Result<Opened, String> {
    let store = app_connection_store(&app)?;
    let id = listed.id;
    let report = checked.as_ref().map(|(c, _)| c.report.clone());
    let opened = checked.as_ref().map(|(c, t)| (c.report.clone(), *t));
    let connect = checked.map(|(c, _)| c.pin);
    credential_action(&state, move |tokens, runtime| {
        if app.try_state::<crate::native::NativeState>().is_some() {
            crate::native::retire_connection(&app, id);
        }
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let mut row = store
            .load()
            .map_err(|_| "storage")?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or("invalid")?;
        // The row checked above, still the same target; a remote row is never opened unpinned.
        if row.origin != listed.origin
            || row.kind != listed.kind
            || (row.kind == crate::connections::Kind::Remote) != connect.is_some()
        {
            return Err("invalid".into());
        }
        let validated = runtime.block_on(crate::pair::validate_connection_pinned(
            &mut row,
            tokens.as_ref(),
            &store,
            connect.as_ref(),
        ));
        if let Err(error) = validated {
            if row.kind != crate::connections::Kind::Bundled
                || !matches!(
                    error,
                    crate::pair::PairError::PairingNeeded
                        | crate::pair::PairError::Client(
                            crate::client::ClientError::Revoked
                                | crate::client::ClientError::Unauthorized
                        )
                )
            {
                return Err(error.public_message());
            }
            row = runtime.block_on(async {
                let window = app.get_webview_window("shell").ok_or("invalid")?;
                let owner = app.state::<crate::runtime_commands::RuntimeState>();
                let mut owner = owner.0.lock().await;
                let ctl = crate::runtime_commands::resolve(&window, &mut owner, None).await?;
                owner
                    .repair
                    .repair_once(&ctl, &row, tokens.as_ref(), &store)
                    .await
                    .map_err(|e| e.public_message())
            })?;
        }
        let monitor = if app.try_state::<crate::native::NativeState>().is_some() {
            let client = runtime
                .block_on(crate::client::HarnessClient::from_connection_pinned(
                    &row,
                    connect.clone(),
                ))
                .map_err(|e| crate::pair::PairError::Client(e).public_message())?;
            let token = crate::secrets::load_token_or_pairing_needed(tokens.as_ref(), row.id)
                .map_err(|_| "pairing-needed")?;
            Some((client, token))
        } else {
            None
        };
        runtime.block_on(crate::spa::open_spa(
            &app,
            &mut row,
            tokens.as_ref(),
            &store,
            connect.as_ref(),
        ))?;
        if let Some((client, token)) = monitor {
            // Spawn while entered into the async runtime; token remains native-only.
            runtime.block_on(async {
                crate::native::start_events(&app, row.clone(), client, token, opened.as_ref());
            });
        }
        Ok(Opened {
            selected: true,
            spa_available: true,
            transport: report,
        })
    })
    .await
}
#[cfg(test)]
mod worker_tests {
    #[tokio::test(flavor = "current_thread")]
    async fn credential_work_leaves_async_worker_available_and_serializes_mutations() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let state = super::ConnectionState::default();
        let running = Arc::new(AtomicBool::new(false));
        let seen = running.clone();
        let first = super::credential_action(&state, move |_, _| {
            seen.store(true, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(100));
            seen.store(false, Ordering::SeqCst);
            Ok(())
        });
        let second = async {
            while !running.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            assert!(running.load(Ordering::SeqCst));
            super::credential_action(&state, move |_, _| {
                assert!(!running.load(Ordering::SeqCst));
                Ok(())
            })
            .await
            .unwrap();
        };
        let (result, ()) = tokio::join!(first, second);
        result.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn store_kind_does_not_wait_for_a_running_credential_action() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let state = super::ConnectionState::default();
        assert_eq!(state.store_kind(), None);
        let release = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicBool::new(false));
        let (hold, seen) = (release.clone(), started.clone());
        let running = super::credential_action(&state, move |tokens, _| {
            *tokens = Some(Box::new(crate::secrets::MemoryStore::default()));
            seen.store(true, Ordering::SeqCst);
            while !hold.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Ok(())
        });
        let probe = async {
            while !started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            // The owner lock is held across the (simulated) network/keychain wait,
            // yet listing the connections must answer immediately.
            assert_eq!(state.store_kind(), None);
            release.store(true, Ordering::SeqCst);
        };
        let (result, ()) = tokio::join!(running, probe);
        result.unwrap();
        assert_eq!(
            state.store_kind(),
            Some(crate::secrets::StoreKind::MemoryOnly)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn store_kind_follows_the_owner_state_after_each_action() {
        let state = super::ConnectionState::default();
        super::credential_action(&state, |_, _| Ok(()))
            .await
            .unwrap();
        assert_eq!(state.store_kind(), None);
        super::credential_action(&state, |tokens, _| {
            *tokens = Some(Box::new(crate::secrets::MemoryStore::default()));
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            state.store_kind(),
            Some(crate::secrets::StoreKind::MemoryOnly)
        );
        // A failing action still publishes what the owner now holds.
        let failed: Result<(), String> =
            super::credential_action(&state, |_, _| Err("keychain-error".into())).await;
        assert!(failed.is_err());
        assert_eq!(
            state.store_kind(),
            Some(crate::secrets::StoreKind::MemoryOnly)
        );
    }
}

/// Native app information exposed to the paired SPA, with no D2 features.
#[derive(Serialize)]
pub struct ShellInfo {
    pub product: &'static str,
    pub version: &'static str,
    pub platform: &'static str,
    pub arch: &'static str,
    pub features: Vec<&'static str>,
}
/// The SPA's only IPC command. Exact current URL and label are checked in Rust.
#[tauri::command]
pub fn shell_info(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::spa::SpaState>,
) -> Result<ShellInfo, String> {
    let current = webview.url().map_err(|_| "SPA URL unavailable")?;
    crate::spa::check_caller(&state, webview.label(), &current)?;
    Ok(ShellInfo {
        product: crate::ids::PRODUCT,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        features: vec![],
    })
}

#[tauri::command]
pub fn quit_request(window: WebviewWindow) -> Result<crate::lifecycle::QuitOffer, String> {
    check(&window, "quit_request")?;
    Ok(crate::native::request_quit(window.app_handle()))
}
#[tauri::command]
pub fn quit_offer(window: WebviewWindow) -> Result<Option<crate::lifecycle::QuitOffer>, String> {
    check(&window, "quit_offer")?;
    let state = window.state::<crate::native::NativeState>();
    Ok(state.quit.is_pending().then(|| state.quit.request(false)))
}
#[tauri::command]
pub async fn quit_response(
    window: WebviewWindow,
    choice: Option<crate::lifecycle::QuitChoice>,
) -> Result<(), String> {
    check(&window, "quit_response")?;
    let state = window.state::<crate::native::NativeState>();
    match choice {
        None => state.quit.cancel(),
        Some(choice) => {
            // Bundled harness stopping is not available until WP8's controller adapter.
            state.quit.approve(choice, false).map_err(str::to_owned)?;
            state.events.stop();
            // Native fixtures and the diagnostics shells do not manage the host bridge state.
            if let Some(host) = window.try_state::<crate::host_commands::HostState>() {
                host.bridge.stop();
                host.helper.stop();
            }
            #[cfg(unix)]
            state.gnome.stop();
            let diagnostics = { state.diagnostics.lock().unwrap().take() };
            if let Some(diagnostics) = diagnostics {
                if let Err(reason) = crate::diagnostics::shutdown_owned(diagnostics).await {
                    eprintln!("{reason}");
                }
            }
            window.app_handle().exit(0);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn autostart_get(window: WebviewWindow) -> Result<Option<bool>, String> {
    check(&window, "autostart_get")?;
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        use crate::controller::autostart::AppLauncher;
        return crate::controller::autostart::NativeLauncher(window.app_handle())
            .is_enabled()
            .map(Some)
            .map_err(|reason| reason.code().to_owned());
    }
    #[cfg(target_os = "linux")]
    if crate::gnome::is_flatpak() {
        return Ok(*window
            .app_handle()
            .state::<crate::native::NativeState>()
            .gnome
            .autostart_grant
            .lock()
            .unwrap());
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        return crate::desktop_integration::appimage_autostart_get()
            .map(Some)
            .map_err(str::to_owned);
    }
    #[cfg(all(target_os = "windows", feature = "store"))]
    return Ok(None);
    #[cfg(all(target_os = "windows", not(feature = "store")))]
    return crate::desktop_integration::windows_autostart_get()
        .map(Some)
        .map_err(str::to_owned);
    #[cfg(not(target_os = "windows"))]
    {
        use crate::controller::autostart::AppLauncher;
        crate::controller::autostart::NativeLauncher(window.app_handle())
            .is_enabled()
            .map(Some)
            .map_err(|reason| reason.code().to_owned())
    }
}
#[tauri::command]
pub async fn autostart_set(window: WebviewWindow, enabled: bool) -> Result<bool, String> {
    check(&window, "autostart_set")?;
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        return crate::controller::autostart::set_enabled(
            &crate::controller::autostart::NativeLauncher(window.app_handle()),
            enabled,
        )
        .map_err(|reason| reason.code().to_owned());
    }
    #[cfg(target_os = "linux")]
    if crate::gnome::is_flatpak() {
        return crate::gnome::request_autostart(window.app_handle(), enabled)
            .await
            .map_err(str::to_owned);
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        return crate::desktop_integration::appimage_autostart_set(enabled).map_err(str::to_owned);
    }
    #[cfg(target_os = "windows")]
    return crate::desktop_integration::windows_autostart_set(enabled).map_err(str::to_owned);
    #[cfg(not(target_os = "windows"))]
    {
        crate::controller::autostart::set_enabled(
            &crate::controller::autostart::NativeLauncher(window.app_handle()),
            enabled,
        )
        .map_err(|reason| reason.code().to_owned())
    }
}

#[tauri::command]
pub fn background_hint(window: WebviewWindow) -> Result<bool, String> {
    check(&window, "background_hint")?;
    #[cfg(unix)]
    {
        Ok(window
            .app_handle()
            .state::<crate::native::NativeState>()
            .gnome
            .hint_pending
            .swap(false, std::sync::atomic::Ordering::SeqCst))
    }
    #[cfg(not(unix))]
    {
        Ok(false)
    }
}

#[derive(serde::Serialize)]
pub struct CrashOffer {
    id: String,
    details: String,
}

#[tauri::command]
pub async fn crash_offers(window: WebviewWindow) -> Result<Vec<CrashOffer>, String> {
    check(&window, "crash_offers")?;
    let reporter = crash_reporter(&window).ok();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(reporter) = reporter else {
            return Ok(Vec::new());
        };
        reporter
            .pending()
            .map(|offers| {
                offers
                    .into_iter()
                    .map(|offer| CrashOffer {
                        id: offer.id().to_owned(),
                        details: offer.details().to_owned(),
                    })
                    .collect()
            })
            .map_err(|_| "CRASH_READ_FAILED".to_owned())
    })
    .await
    .map_err(|_| "CRASH_READ_FAILED".to_owned())?
}

#[tauri::command]
pub async fn crash_handled(window: WebviewWindow, id: String) -> Result<(), String> {
    check(&window, "crash_handled")?;
    let reporter = crash_reporter(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let offers = reporter
            .pending()
            .map_err(|_| "CRASH_READ_FAILED".to_owned())?;
        let offer = offers
            .iter()
            .find(|offer| offer.id() == id)
            .ok_or_else(|| "CRASH_OFFER_UNKNOWN".to_owned())?;
        reporter
            .mark_handled(offer)
            .map_err(|_| "CRASH_HANDLING_FAILED".to_owned())
    })
    .await
    .map_err(|_| "CRASH_HANDLING_FAILED".to_owned())?
}

// Fixed diagnostic destination; renderer supplies neither a path nor an executable.
fn crash_reporter(window: &WebviewWindow) -> Result<crate::crash::CrashReporter, String> {
    let state = window
        .app_handle()
        .try_state::<crate::native::NativeState>()
        .ok_or("CRASH_UNAVAILABLE")?;
    let diagnostics = state.diagnostics.lock().map_err(|_| "CRASH_UNAVAILABLE")?;
    diagnostics
        .as_ref()
        .map(|d| d.crash.clone())
        .ok_or("CRASH_UNAVAILABLE".into())
}
#[tauri::command]
pub async fn crash_last_report(
    window: WebviewWindow,
) -> Result<Option<crate::crash::LastCrashReport>, String> {
    check(&window, "crash_last_report")?;
    let reporter = crash_reporter(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        reporter
            .last_report()
            .map_err(|_| "CRASH_READ_FAILED".into())
    })
    .await
    .map_err(|_| "CRASH_READ_FAILED")?
}
#[tauri::command]
pub async fn crash_dismiss(window: WebviewWindow) -> Result<(), String> {
    check(&window, "crash_dismiss")?;
    let reporter = crash_reporter(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        reporter
            .dismiss_last()
            .map_err(|_| "CRASH_HANDLING_FAILED".into())
    })
    .await
    .map_err(|_| "CRASH_HANDLING_FAILED")?
}
#[tauri::command]
pub async fn diagnostics_open(window: WebviewWindow) -> Result<(), String> {
    check(&window, "diagnostics_open")?;
    let folder = crash_reporter(&window)?.folder().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer.exe");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        command
            .arg(folder)
            .status()
            .map_err(|_| "DIAGNOSTICS_OPEN_FAILED".to_owned())
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("DIAGNOSTICS_OPEN_FAILED".into())
                }
            })
    })
    .await
    .map_err(|_| "DIAGNOSTICS_OPEN_FAILED")?
}
#[tauri::command]
pub fn crash_restart(window: WebviewWindow) -> Result<(), String> {
    check(&window, "crash_restart")?;
    crash_reporter(&window)?
        .end_session()
        .map_err(|_| "CRASH_HANDLING_FAILED")?;
    window.app_handle().restart();
}
