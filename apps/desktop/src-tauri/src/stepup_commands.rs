//! Only the bundled shell may operate this approval handle. The remote SPA receives no proof or challenge interface.
use crate::client::{StepUpPublic, StepUpPurpose};
use tauri::Manager;

pub(crate) fn notify_required(app: &tauri::AppHandle, id: uuid::Uuid, purpose: StepUpPurpose) {
    use tauri::Emitter;
    let _ = app.emit_to(
        "shell",
        "desktop-stepup-required",
        serde_json::json!({"id":id,"purpose":purpose}),
    );
    if let Some(window) = app.get_webview_window("shell") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginRequest {
    pub connection_id: uuid::Uuid,
    pub purpose: StepUpPurpose,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandleRequest {
    pub connection_id: uuid::Uuid,
    pub handle: String,
}
enum Action {
    Begin(StepUpPurpose),
    Poll(String),
    Cancel(String),
    Open(String),
}

async fn act(
    window: &tauri::WebviewWindow,
    state: &crate::commands::ConnectionState,
    transports: &crate::transport::Transports,
    id: uuid::Uuid,
    action: Action,
) -> Result<Option<StepUpPublic>, String> {
    let app = window.app_handle().clone();
    let store = crate::commands::app_connection_store(&app)?;
    let tstore = crate::commands::transport_store(&app)?;
    let owner = state.clone();
    transports
        .open_gated(&store, &tstore, id, move |listed, checked| async move {
            crate::commands::credential_action(&owner, move |tokens, runtime| {
                let store = crate::commands::app_connection_store(&app)?;
                let row = store
                    .load()
                    .map_err(|_| "storage")?
                    .into_iter()
                    .find(|row| row.id == id)
                    .ok_or("invalid")?;
                if row != listed {
                    return Err("connection-changed".into());
                }
                let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
                let token = crate::pair::connection_token(&row, tokens.as_ref())
                    .map_err(|error| error.public_message())?;
                runtime.block_on(async move {
                    let client = crate::client::HarnessClient::from_connection_pinned(
                        &row,
                        checked.map(|(target, _)| target.pin),
                    )
                    .await
                    .map_err(|error| crate::pair::PairError::Client(error).public_message())?;
                    match action {
                        Action::Begin(purpose) => {
                            client.begin_step_up(&token, purpose).await.map(Some)
                        }
                        Action::Poll(handle) => {
                            client.poll_step_up(&token, &handle).await.map(Some)
                        }
                        Action::Cancel(handle) => {
                            client.cancel_step_up(&token, &handle).await.map(|()| None)
                        }
                        Action::Open(handle) => {
                            client.step_up_info(&token, &handle).map_err(|error| {
                                crate::pair::PairError::Client(error).public_message()
                            })?;
                            crate::policy::ExternalUrl::desktop_approval(client.origin())
                                .and_then(|url| url.open())
                                .map_err(|_| "browser-open-failed")?;
                            return Ok(None);
                        }
                    }
                    .map_err(|error| crate::pair::PairError::Client(error).public_message())
                })
            })
            .await
        })
        .await
}
fn handle(value: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "invalid".into())
}
#[tauri::command]
pub async fn step_up_begin(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::commands::ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: BeginRequest,
) -> Result<StepUpPublic, String> {
    crate::commands::check(&window, "step_up_begin")?;
    act(
        &window,
        &state,
        &transports,
        request.connection_id,
        Action::Begin(request.purpose),
    )
    .await?
    .ok_or("invalid".into())
}
#[tauri::command]
pub async fn step_up_poll(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::commands::ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: HandleRequest,
) -> Result<StepUpPublic, String> {
    crate::commands::check(&window, "step_up_poll")?;
    handle(&request.handle)?;
    act(
        &window,
        &state,
        &transports,
        request.connection_id,
        Action::Poll(request.handle),
    )
    .await?
    .ok_or("invalid".into())
}
#[tauri::command]
pub async fn step_up_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::commands::ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: HandleRequest,
) -> Result<(), String> {
    crate::commands::check(&window, "step_up_cancel")?;
    handle(&request.handle)?;
    act(
        &window,
        &state,
        &transports,
        request.connection_id,
        Action::Cancel(request.handle),
    )
    .await
    .map(|_| ())
}
#[tauri::command]
pub async fn step_up_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::commands::ConnectionState>,
    transports: tauri::State<'_, crate::transport::Transports>,
    request: HandleRequest,
) -> Result<(), String> {
    crate::commands::check(&window, "step_up_open")?;
    handle(&request.handle)?;
    act(
        &window,
        &state,
        &transports,
        request.connection_id,
        Action::Open(request.handle),
    )
    .await
    .map(|_| ())
}
