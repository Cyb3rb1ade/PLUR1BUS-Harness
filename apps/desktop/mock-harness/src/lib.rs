//! Test-only executable provisional harness contract.
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response, Sse},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{stream, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    fs, io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::{net::TcpListener, sync::broadcast, task::AbortHandle};

pub mod routes {
    pub const META: &str = "/api/v1/meta";
    pub const DEVICE_REDEEM: &str = "/api/v1/devices/redeem";
    pub const SESSION_TICKET: &str = "/api/v1/auth/session-ticket";
    pub const TICKET_REDEEM: &str = "/api/v1/auth/ticket/redeem";
    pub const WHOAMI: &str = "/api/v1/auth/whoami";
    pub const EVENTS: &str = "/events";
    pub const BRIDGE: &str = "/ws";
}

#[derive(Clone)]
pub struct MockOptions {
    pub bind: SocketAddr,
    pub state_dir: Option<PathBuf>,
    pub clock: Arc<AtomicI64>,
}
impl Default for MockOptions {
    fn default() -> Self {
        Self {
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            state_dir: None,
            clock: Arc::new(AtomicI64::new(i64::MIN)),
        }
    }
}
pub struct MockHarness;
pub struct MockHandle {
    pub origin: String,
    pub installation_id: String,
    pub control: MockControl,
    abort: AbortHandle,
}
impl Drop for MockHandle {
    fn drop(&mut self) {
        self.abort.abort();
    }
}
#[derive(Clone)]
pub struct MockControl {
    shared: Arc<Shared>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    token_hash: String,
    scopes: Vec<String>,
    revoked: bool,
    grant_key_unlock: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct PairCode {
    scopes: Vec<String>,
    expires: i64,
    grant_key_unlock: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Ticket {
    device_id: String,
    expires: i64,
}
#[derive(Serialize, Deserialize)]
struct Store {
    installation_id: String,
    devices: BTreeMap<String, Device>,
    pair_codes: BTreeMap<String, PairCode>,
    tickets: BTreeMap<String, Ticket>,
    sessions: BTreeMap<String, String>,
    status: String,
    secrets: String,
    provisioned: bool,
}
impl Store {
    fn new() -> Self {
        Self {
            installation_id: random_id(),
            devices: BTreeMap::new(),
            pair_codes: BTreeMap::new(),
            tickets: BTreeMap::new(),
            sessions: BTreeMap::new(),
            status: "ready".into(),
            secrets: "locked".into(),
            provisioned: false,
        }
    }
}
struct Shared {
    store: Mutex<Store>,
    path: Option<PathBuf>,
    clock: Arc<AtomicI64>,
    api_version: Mutex<String>,
    reported_id: Mutex<Option<String>>,
    failure: Mutex<Option<String>>,
    key_unlock_enabled: AtomicBool,
    redeem_attempts: Mutex<(i64, u32)>,
    event_id: AtomicU64,
    event_history: Mutex<VecDeque<(u64, Value)>>,
    events: broadcast::Sender<Event>,
    bridge_commands: broadcast::Sender<BridgeCommand>,
    pending_bridge: Mutex<BTreeMap<String, (String, String)>>,
    bridge_results: Mutex<BTreeMap<String, Value>>,
}
#[derive(Clone)]
enum Event {
    Status(u64, Value),
    Drop,
}
#[derive(Clone)]
enum BridgeCommand {
    Call(String, Value),
    Revoke(String),
}
impl Shared {
    fn now(&self) -> i64 {
        let injected = self.clock.load(Ordering::SeqCst);
        if injected == i64::MIN {
            Utc::now().timestamp()
        } else {
            injected
        }
    }
    fn save(&self, store: &Store) -> io::Result<()> {
        if let Some(path) = &self.path {
            let tmp = path.with_extension("next");
            fs::write(&tmp, serde_json::to_vec(store)?)?;
            fs::rename(tmp, path)?;
        }
        Ok(())
    }
}
impl MockHarness {
    pub async fn start(options: MockOptions) -> io::Result<MockHandle> {
        let path = if let Some(dir) = &options.state_dir {
            fs::create_dir_all(dir)?;
            Some(dir.join("mock-state.json"))
        } else {
            None
        };
        let store = match &path {
            Some(p) if p.exists() => serde_json::from_slice(&fs::read(p)?)?,
            _ => Store::new(),
        };
        let installation_id = store.installation_id.clone();
        let (events, _) = broadcast::channel(32);
        let (bridge_commands, _) = broadcast::channel(32);
        let shared = Arc::new(Shared {
            store: Mutex::new(store),
            path,
            clock: options.clock,
            api_version: Mutex::new("1.0.0".into()),
            reported_id: Mutex::new(None),
            failure: Mutex::new(None),
            key_unlock_enabled: AtomicBool::new(true),
            redeem_attempts: Mutex::new((0, 0)),
            event_id: AtomicU64::new(1),
            event_history: Mutex::new(VecDeque::new()),
            events,
            bridge_commands,
            pending_bridge: Mutex::new(BTreeMap::new()),
            bridge_results: Mutex::new(BTreeMap::new()),
        });
        shared.save(&shared.store.lock().unwrap())?;
        let listener = TcpListener::bind(options.bind).await?;
        let origin = format!("http://{}", listener.local_addr()?);
        let serving = shared.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router(serving)).await;
        });
        Ok(MockHandle {
            origin,
            installation_id,
            control: MockControl { shared },
            abort: task.abort_handle(),
        })
    }
}

impl MockControl {
    pub fn call_bridge(
        &self,
        device_id: &str,
        op: &str,
        args: Value,
    ) -> Result<String, &'static str> {
        if !matches!(op, "provision" | "get") {
            return Err("unsupported key-unlock operation");
        }
        let store = self.shared.store.lock().unwrap();
        let Some(device) = store.devices.get(device_id) else {
            return Err("unknown device");
        };
        if device.revoked
            || !device.grant_key_unlock
            || !device.scopes.iter().any(|s| s == "bridge.serve")
            || !self.shared.key_unlock_enabled.load(Ordering::SeqCst)
        {
            return Err("bridge grant denied");
        }
        drop(store);
        let call_id = random_id();
        self.shared
            .pending_bridge
            .lock()
            .unwrap()
            .insert(call_id.clone(), (device_id.into(), op.into()));
        let call = json!({"type":"bridge.call","callId":call_id,"capability":"host.keyUnlock","op":op,"args":args});
        if self
            .shared
            .bridge_commands
            .send(BridgeCommand::Call(device_id.into(), call))
            .is_err()
        {
            self.shared.pending_bridge.lock().unwrap().remove(&call_id);
            return Err("bridge disconnected");
        }
        Ok(call_id)
    }
    pub fn take_bridge_result(&self, call_id: &str) -> Option<Value> {
        self.shared.bridge_results.lock().unwrap().remove(call_id)
    }
    pub fn create_pair_code_with_grant(&self, grant: bool) -> String {
        self.create_pair_code_with_scopes_and_grant(
            &["ui.session", "events.read", "bridge.serve"],
            grant,
        )
    }
    pub fn create_pair_code(&self) -> String {
        self.create_pair_code_with_scopes(&["ui.session", "events.read", "bridge.serve"])
    }
    pub fn create_pair_code_with_scopes(&self, scopes: &[&str]) -> String {
        self.create_pair_code_with_scopes_and_grant(scopes, true)
    }
    fn create_pair_code_with_scopes_and_grant(&self, scopes: &[&str], grant: bool) -> String {
        let mut bytes = [0_u8; 4];
        rand::rng().fill_bytes(&mut bytes);
        let raw = format!("{:08X}", u32::from_be_bytes(bytes));
        let code = format!("{}-{}", &raw[..4], &raw[4..]);
        let mut store = self.shared.store.lock().unwrap();
        store.pair_codes.insert(
            hash(&code),
            PairCode {
                scopes: scopes.iter().map(|s| (*s).into()).collect(),
                expires: self.shared.now() + 3600,
                grant_key_unlock: grant,
            },
        );
        self.shared.save(&store).expect("persist pair code");
        code
    }
    pub fn revoke_device(&self, id: &str) -> bool {
        let mut store = self.shared.store.lock().unwrap();
        let Some(device) = store.devices.get_mut(id) else {
            return false;
        };
        device.revoked = true;
        self.shared.save(&store).expect("persist revocation");
        let _ = self
            .shared
            .bridge_commands
            .send(BridgeCommand::Revoke(id.into()));
        let _ = self.shared.events.send(Event::Drop);
        true
    }
    pub fn set_status(&self, state: &str, secrets: &str) {
        let mut store = self.shared.store.lock().unwrap();
        store.status = state.into();
        store.secrets = secrets.into();
        self.shared.save(&store).expect("persist status");
        let id = self.shared.event_id.fetch_add(1, Ordering::SeqCst) + 1;
        let data = json!({"state":state,"secrets":secrets});
        {
            let mut history = self.shared.event_history.lock().unwrap();
            history.push_back((id, data.clone()));
            if history.len() > 32 {
                history.pop_front();
            }
        }
        let _ = self.shared.events.send(Event::Status(id, data));
    }
    pub fn set_meta(&self, installation_id: Option<&str>, api_version: &str) {
        *self.shared.reported_id.lock().unwrap() = installation_id.map(str::to_owned);
        *self.shared.api_version.lock().unwrap() = api_version.into();
    }
    pub fn drop_sse(&self) {
        let _ = self.shared.events.send(Event::Drop);
    }
    pub fn set_key_unlock_enabled(&self, enabled: bool) {
        self.shared
            .key_unlock_enabled
            .store(enabled, Ordering::SeqCst);
    }
    pub fn inject_upgrade_failure(&self, step: Option<&str>) {
        *self.shared.failure.lock().unwrap() = step.map(str::to_owned);
    }
    pub fn set_provisioned(&self, value: bool) {
        let mut store = self.shared.store.lock().unwrap();
        store.provisioned = value;
        self.shared.save(&store).expect("persist provisioned flag");
    }
    pub fn provisioned(&self) -> bool {
        self.shared.store.lock().unwrap().provisioned
    }
}

fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route(routes::META, get(meta))
        .route(routes::DEVICE_REDEEM, post(redeem_device))
        .route(routes::SESSION_TICKET, post(session_ticket))
        .route(routes::TICKET_REDEEM, post(redeem_ticket))
        .route(routes::WHOAMI, get(whoami))
        .route(routes::EVENTS, get(events))
        .route(routes::BRIDGE, get(bridge))
        .route("/", get(spa))
        .route("/auth/ticket", get(spa))
        .route("/__test/pair", post(test_pair))
        .route("/__test/revoke", post(test_revoke))
        .route("/__test/failure", post(test_failure))
        .with_state(shared)
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn random_id() -> String {
    let mut bytes = [0_u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn expires_at(epoch: i64) -> String {
    DateTime::from_timestamp(epoch, 0)
        .unwrap()
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}
fn err(reason: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({"schema":"error/1","code":"E_AUTH","reason":reason})),
    )
        .into_response()
}

async fn meta(State(s): State<Arc<Shared>>) -> Json<Value> {
    let store = s.store.lock().unwrap();
    Json(
        json!({"apiVersion":*s.api_version.lock().unwrap(),"version":"0.1.0", "installationId":s.reported_id.lock().unwrap().clone().unwrap_or_else(||store.installation_id.clone()),"capabilities":["desktop.sessionTicket","host.bridge"]}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RedeemDevice {
    code: String,
    name: String,
    kind: String,
}
async fn redeem_device(State(s): State<Arc<Shared>>, Json(body): Json<RedeemDevice>) -> Response {
    {
        let mut attempts = s.redeem_attempts.lock().unwrap();
        if s.now() - attempts.0 >= 60 {
            *attempts = (s.now(), 0);
        }
        if attempts.1 >= 10 {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"schema":"error/1","code":"E_RATE_LIMIT"})),
            )
                .into_response();
        }
        attempts.1 += 1;
    }
    if body.kind != "desktop" || body.name.is_empty() {
        return err("invalid-request", StatusCode::BAD_REQUEST);
    }
    let mut store = s.store.lock().unwrap();
    let Some(code) = store.pair_codes.remove(&hash(&body.code)) else {
        return err("code-invalid", StatusCode::UNAUTHORIZED);
    };
    if code.expires <= s.now() {
        return err("code-expired", StatusCode::UNAUTHORIZED);
    }
    let id = random_id();
    let token = random_id();
    store.devices.insert(
        id.clone(),
        Device {
            id: id.clone(),
            token_hash: hash(&token),
            scopes: code.scopes,
            revoked: false,
            grant_key_unlock: code.grant_key_unlock,
        },
    );
    if s.save(&store).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"deviceId":id,"token":token})).into_response()
}

struct AuthFailure(&'static str, StatusCode);
impl AuthFailure {
    fn response(self) -> Response {
        err(self.0, self.1)
    }
}
fn auth(headers: &HeaderMap, store: &Store, scope: Option<&str>) -> Result<Device, AuthFailure> {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return Err(AuthFailure("missing-token", StatusCode::UNAUTHORIZED));
    };
    let Some(device) = store.devices.values().find(|d| d.token_hash == hash(token)) else {
        return Err(AuthFailure("invalid-token", StatusCode::UNAUTHORIZED));
    };
    if device.revoked {
        return Err(AuthFailure("device-revoked", StatusCode::UNAUTHORIZED));
    }
    if scope.is_some_and(|sc| !device.scopes.iter().any(|v| v == sc)) {
        return Err(AuthFailure("scope-denied", StatusCode::FORBIDDEN));
    }
    Ok(device.clone())
}

async fn session_ticket(State(s): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    let mut store = s.store.lock().unwrap();
    let device = match auth(&headers, &store, Some("ui.session")) {
        Ok(d) => d,
        Err(e) => return e.response(),
    };
    let now = s.now();
    store.tickets.retain(|_, t| t.expires > now);
    if store
        .tickets
        .values()
        .filter(|t| t.device_id == device.id)
        .count()
        >= 5
    {
        return err("ticket-limit", StatusCode::TOO_MANY_REQUESTS);
    }
    let ticket = random_id();
    let expires = now + 60;
    store.tickets.insert(
        hash(&ticket),
        Ticket {
            device_id: device.id,
            expires,
        },
    );
    if s.save(&store).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"ticket":ticket,"expiresAt":expires_at(expires)})).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RedeemTicket {
    ticket: String,
}
async fn redeem_ticket(State(s): State<Arc<Shared>>, Json(body): Json<RedeemTicket>) -> Response {
    let mut store = s.store.lock().unwrap();
    let Some(ticket) = store.tickets.remove(&hash(&body.ticket)) else {
        return err("ticket-invalid", StatusCode::UNAUTHORIZED);
    };
    if ticket.expires <= s.now()
        || store
            .devices
            .get(&ticket.device_id)
            .is_none_or(|d| d.revoked)
    {
        return err("ticket-invalid", StatusCode::UNAUTHORIZED);
    }
    let session = random_id();
    let csrf = random_id();
    store.sessions.insert(hash(&session), ticket.device_id);
    if s.save(&store).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let cookie = format!("p1_session={session}; HttpOnly; SameSite=Lax; Path=/");
    ([(header::SET_COOKIE, cookie)], Json(json!({"csrf":csrf}))).into_response()
}
async fn whoami(State(s): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    let store = s.store.lock().unwrap();
    let device = if headers.contains_key(header::AUTHORIZATION) {
        match auth(&headers, &store, None) {
            Ok(d) => d,
            Err(e) => return e.response(),
        }
    } else {
        let Some(session) = headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.split(';')
                    .find_map(|c| c.trim().strip_prefix("p1_session="))
            })
        else {
            return err("missing-token", StatusCode::UNAUTHORIZED);
        };
        let Some(id) = store.sessions.get(&hash(session)) else {
            return err("invalid-session", StatusCode::UNAUTHORIZED);
        };
        let Some(d) = store.devices.get(id) else {
            return err("invalid-session", StatusCode::UNAUTHORIZED);
        };
        if d.revoked {
            return err("device-revoked", StatusCode::UNAUTHORIZED);
        }
        d.clone()
    };
    Json(json!({"userId":"mock-owner","deviceId":device.id,"scopes":device.scopes})).into_response()
}
async fn events(State(s): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    {
        let store = s.store.lock().unwrap();
        if let Err(e) = auth(&headers, &store, Some("events.read")) {
            return e.response();
        }
    }
    let rx = s.events.subscribe();
    let last = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let latest = s.event_id.load(Ordering::SeqCst);
    let replay: Vec<(u64, Value)> = if let Some(last) = last {
        let history = s.event_history.lock().unwrap();
        history
            .iter()
            .filter(|(id, _)| *id > last)
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let initial = if last.is_none() || (replay.is_empty() && last != Some(latest)) {
        let store = s.store.lock().unwrap();
        vec![(
            latest,
            json!({"state":store.status,"secrets":store.secrets}),
        )]
    } else {
        replay
    };
    let sent_through = initial
        .last()
        .map(|(id, _)| *id)
        .unwrap_or(last.unwrap_or(latest));
    let stream = stream::iter(initial.into_iter().map(|(id, data)| {
        Ok::<_, std::convert::Infallible>(
            axum::response::sse::Event::default()
                .id(id.to_string())
                .event("harness.status")
                .data(data.to_string()),
        )
    }))
    .chain(stream::unfold(
        (rx, sent_through),
        |(mut rx, mut sent_through)| async move {
            loop {
                match rx.recv().await {
                    Ok(Event::Status(id, v)) if id > sent_through => {
                        sent_through = id;
                        return Some((
                            Ok(axum::response::sse::Event::default()
                                .id(id.to_string())
                                .event("harness.status")
                                .data(v.to_string())),
                            (rx, sent_through),
                        ));
                    }
                    Ok(Event::Status(_, _)) => continue,
                    Ok(Event::Drop) | Err(broadcast::error::RecvError::Closed) => return None,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
        },
    ));
    Sse::new(stream).into_response()
}
async fn bridge(
    State(s): State<Arc<Shared>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let device = {
        let store = s.store.lock().unwrap();
        match auth(&headers, &store, Some("bridge.serve")) {
            Ok(device) => device,
            Err(e) => return e.response(),
        }
    };
    let accepted_key_unlock =
        device.grant_key_unlock && s.key_unlock_enabled.load(Ordering::SeqCst);
    ws.max_frame_size(64 * 1024)
        .max_message_size(64 * 1024)
        .on_upgrade(move |socket| bridge_socket(socket, accepted_key_unlock, device.id, s))
        .into_response()
}
async fn bridge_socket(
    mut socket: WebSocket,
    accepted_key_unlock: bool,
    device_id: String,
    shared: Arc<Shared>,
) {
    let mut commands = shared.bridge_commands.subscribe();
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else { if matches!(message, Message::Close(_)) { break } continue };
                if text.len() > 64 * 1024 {
                    let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame { code: 1009, reason: "frame too large".into() }))).await;
                    break;
                }
                let Ok(value) = serde_json::from_str::<Value>(&text) else { break };
                match value["type"].as_str() {
                    Some("bridge.hello") => {
                        let accepted = value["capabilities"].as_array().map(|v| v.iter().filter(|c| accepted_key_unlock && c.as_str() == Some("host.keyUnlock")).cloned().collect::<Vec<_>>()).unwrap_or_default();
                        if socket.send(Message::Text(json!({"type":"bridge.welcome","accepted":accepted}).to_string().into())).await.is_err() { break }
                    }
                    Some("bridge.result") => {
                        let Some(call_id) = value["callId"].as_str() else { break };
                        let pending = shared.pending_bridge.lock().unwrap().remove(call_id);
                        if let Some((expected_device, op)) = pending {
                            if expected_device != device_id { break }
                            if op == "provision" && value["ok"] == true {
                                let mut store = shared.store.lock().unwrap(); store.provisioned = true;
                                if shared.save(&store).is_err() { break }
                            }
                            shared.bridge_results.lock().unwrap().insert(call_id.into(), value);
                        }
                    }
                    _ => break,
                }
            }
            command = commands.recv() => {
                match command {
                    Ok(BridgeCommand::Call(target, call)) if target == device_id => {
                        if socket.send(Message::Text(call.to_string().into())).await.is_err() { break }
                    }
                    Ok(BridgeCommand::Revoke(target)) if target == device_id => {
                        let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame { code: 1008, reason: "device revoked".into() }))).await;
                        break;
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestPair {
    scopes: Option<Vec<String>>,
}
async fn test_pair(State(s): State<Arc<Shared>>, Json(body): Json<TestPair>) -> Json<Value> {
    let scopes = body.scopes.unwrap_or_else(|| {
        vec![
            "ui.session".into(),
            "events.read".into(),
            "bridge.serve".into(),
        ]
    });
    let list: Vec<&str> = scopes.iter().map(String::as_str).collect();
    let code = (MockControl { shared: s.clone() }).create_pair_code_with_scopes(&list);
    Json(json!({"schema":"device.pair/1","code":code,"expiresAt":expires_at(s.now()+3600)}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestRevoke {
    device_id: String,
}
async fn test_revoke(State(s): State<Arc<Shared>>, Json(body): Json<TestRevoke>) -> Json<Value> {
    let ok = (MockControl { shared: s }).revoke_device(&body.device_id);
    Json(json!({"schema":"device.revoke/1","ok":ok}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestFailure {
    step: String,
}
async fn test_failure(State(s): State<Arc<Shared>>, Json(body): Json<TestFailure>) -> Json<Value> {
    Json(json!({"fail": s.failure.lock().unwrap().as_deref() == Some(body.step.as_str())}))
}
async fn spa() -> Html<&'static str> {
    Html(include_str!("spa.html"))
}
