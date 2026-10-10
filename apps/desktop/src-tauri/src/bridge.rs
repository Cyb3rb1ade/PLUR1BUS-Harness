//! Bundled-only host bridge. Credentials never cross native IPC.
use crate::{
    connections::{Kind, Origin},
    secrets::{SecretString, StoreKind, TokenStore},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    protocol::{Message, WebSocketConfig},
};
use zeroize::Zeroizing;
pub type Backoff = crate::events::EventStream;
pub const MAX_FRAME: usize = 64 * 1024;

pub fn endpoint(kind: Kind, origin: &Origin) -> Option<url::Url> {
    let mut url = url::Url::parse(origin.as_str()).ok()?;
    if kind != Kind::Bundled || url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return None;
    }
    url.set_scheme("ws").ok()?;
    url.set_path("/ws");
    Some(url)
}
pub fn hello(enabled: bool) -> Value {
    json!({"type":"bridge.hello","capabilities":if enabled {vec!["host.keyUnlock"]}else{vec![]}})
}
pub fn needs_pairing(status: u16) -> bool {
    status == 401
}

/// Serializes get+create+set for test/backends outside the app's credential owner.
pub struct KeyUnlock(Mutex<Box<dyn TokenStore>>);
impl KeyUnlock {
    pub fn new(store: Box<dyn TokenStore>) -> Self {
        Self(Mutex::new(store))
    }
    pub fn call(
        &self,
        installation: &str,
        op: &str,
        enabled: bool,
    ) -> Result<SecretString, &'static str> {
        key_call(
            self.0.lock().map_err(|_| "E_STORAGE")?.as_ref(),
            installation,
            op,
            enabled,
        )
    }
}
/// Caller holds the existing app credential owner across this operation.
pub fn key_call(
    store: &dyn TokenStore,
    installation: &str,
    op: &str,
    enabled: bool,
) -> Result<SecretString, &'static str> {
    if !enabled {
        return Err("E_DENIED");
    }
    if installation.is_empty() || installation.len() > 256 {
        return Err("E_INVALID");
    }
    let account = crate::secrets::secret_store_account(installation);
    match op {
        "provision" => {
            if store.kind() == StoreKind::MemoryOnly {
                return Err("E_MEMORY_ONLY");
            }
            if store.get(&account).map_err(|_| "E_STORAGE")?.is_some() {
                return Err("E_EXISTS");
            }
            let bytes = Zeroizing::new(rand::random::<[u8; 32]>());
            let key = SecretString::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()));
            store.set(&account, &key).map_err(|_| "E_STORAGE")?;
            Ok(key)
        }
        "get" => store
            .get(&account)
            .map_err(|_| "E_STORAGE")?
            .ok_or("E_NOT_FOUND"),
        _ => Err("E_DENIED"),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Call {
    #[serde(rename = "type")]
    kind: String,
    call_id: String,
    capability: String,
    op: String,
    args: Value,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Retry,
    Pairing,
}

/// One connection attempt; bounded handshake/read/write, no redirect or foreign endpoint.
pub async fn session<F, Fut>(
    url: &url::Url,
    token: &SecretString,
    enabled: bool,
    backoff: &mut Backoff,
    mut call: F,
) -> Exit
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<SecretString, String>>,
{
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/ws"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Exit::Retry;
    }
    let Ok(mut request) = url.as_str().into_client_request() else {
        return Exit::Retry;
    };
    let Ok(mut bearer) = format!("Bearer {}", token.expose())
        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
    else {
        return Exit::Pairing;
    };
    bearer.set_sensitive(true);
    request.headers_mut().insert("Authorization", bearer);
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME));
    let connected = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio_tungstenite::connect_async_with_config(request, Some(config), false),
    )
    .await;
    let mut socket = match connected {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response)))
            if needs_pairing(response.status().as_u16()) =>
        {
            return Exit::Pairing
        }
        _ => return Exit::Retry,
    };
    if !send(&mut socket, hello(enabled).to_string()).await {
        return Exit::Retry;
    }
    let welcome = tokio::time::timeout(std::time::Duration::from_secs(15), socket.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = welcome else {
        return Exit::Retry;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Exit::Retry;
    };
    let Some(accepted) = value["accepted"].as_array() else {
        return Exit::Retry;
    };
    if value["type"] != "bridge.welcome"
        || accepted.iter().any(|v| !enabled || v != "host.keyUnlock")
        || accepted.len() > 1
    {
        return Exit::Retry;
    }
    let granted = accepted.len() == 1;
    backoff.reset_backoff();
    loop {
        let next = tokio::time::timeout(std::time::Duration::from_secs(90), socket.next()).await;
        match next {
            Ok(Some(Ok(Message::Text(text)))) => {
                let Ok(request) = serde_json::from_str::<Call>(&text) else {
                    return Exit::Retry;
                };
                if request.kind != "bridge.call"
                    || request.call_id.is_empty()
                    || request.call_id.len() > 256
                    || !request.args.is_object()
                    || request.args.as_object().is_some_and(|v| !v.is_empty())
                {
                    return Exit::Retry;
                }
                let result = if enabled && granted && request.capability == "host.keyUnlock" {
                    call(request.op).await
                } else {
                    Err("E_DENIED".into())
                };
                let reply = match result {
                    Ok(key) => {
                        json!({"type":"bridge.result","callId":request.call_id,"ok":true,"value":key.expose()})
                    }
                    Err(code) => {
                        json!({"type":"bridge.result","callId":request.call_id,"ok":false,"error":{"code":code}})
                    }
                };
                if !send(&mut socket, reply.to_string()).await {
                    return Exit::Retry;
                }
            }
            Ok(Some(Ok(Message::Ping(data)))) => {
                if !matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        socket.send(Message::Pong(data))
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    return Exit::Retry;
                }
            }
            Ok(Some(Ok(Message::Pong(_)))) => {}
            Ok(Some(Ok(Message::Close(Some(frame)))))
                if frame.code
                    == tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy
                    && frame.reason == "device revoked" =>
            {
                return Exit::Pairing
            }
            _ => return Exit::Retry,
        }
    }
}
async fn send<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, text: String) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    text.len() <= MAX_FRAME
        && matches!(
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                socket.send(Message::Text(text.into()))
            )
            .await,
            Ok(Ok(()))
        )
}
