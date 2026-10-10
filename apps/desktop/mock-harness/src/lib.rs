//! Test-only executable provisional harness contract.
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Path, Query, Request, State,
    },
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response, Sse},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::{stream, StreamExt};
use plur1bus_desktop_contract::{capability, route as routes, scope};
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

pub use plur1bus_desktop_contract::route;
pub mod tls;

#[derive(Clone)]
pub struct MockOptions {
    pub bind: SocketAddr,
    pub state_dir: Option<PathBuf>,
    pub clock: Arc<AtomicI64>,
    pub test_control: bool,
    pub approvals_decide: bool,
}
impl Default for MockOptions {
    fn default() -> Self {
        Self {
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            state_dir: None,
            clock: Arc::new(AtomicI64::new(i64::MIN)),
            test_control: false,
            approvals_decide: false,
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
#[derive(Clone, Serialize, Deserialize)]
struct BrowserSession {
    device_id: String,
    csrf_hash: String,
}
#[derive(Serialize, Deserialize)]
struct Store {
    installation_id: String,
    devices: BTreeMap<String, Device>,
    pair_codes: BTreeMap<String, PairCode>,
    tickets: BTreeMap<String, Ticket>,
    sessions: BTreeMap<String, BrowserSession>,
    status: String,
    secrets: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    provisioned: bool,
    #[serde(default)]
    secret_key_digest: Option<String>,
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
            reason: None,
            provisioned: false,
            secret_key_digest: None,
        }
    }
}
struct Shared {
    store: Mutex<Store>,
    path: Option<PathBuf>,
    clock: Arc<AtomicI64>,
    api_version: Mutex<String>,
    session_ticket_capability: AtomicBool,
    reject_browser_tickets: AtomicBool,
    reported_id: Mutex<Option<String>>,
    failure: Mutex<Option<String>>,
    key_unlock_enabled: AtomicBool,
    approvals_decide: bool,
    accepted_bridge: Mutex<BTreeMap<String, u32>>,
    approvals: Mutex<BTreeMap<String, Value>>,
    redeem_attempts: Mutex<(i64, u32)>,
    event_id: AtomicU64,
    event_history: Mutex<VecDeque<(u64, String, Value)>>,
    events: broadcast::Sender<Event>,
    bridge_commands: broadcast::Sender<BridgeCommand>,
    pending_bridge: Mutex<BTreeMap<String, (String, String)>>,
    bridge_results: Mutex<BTreeMap<String, Value>>,
    origin: Mutex<Option<String>>,
    bound_ip: IpAddr,
    tls: Mutex<Option<tls::TlsState>>,
    proof_offer: Mutex<Option<tls::ProofOffer>>,
    proof_attempts: Mutex<(i64, u32)>,
    requests: Mutex<Vec<(String, bool)>>,
    event_replay_ids: Mutex<Vec<Option<String>>>,
    revoke_after: Mutex<Option<String>>,
    redemption_token_length: Mutex<Option<usize>>,
}
#[derive(Clone)]
enum Event {
    Data(u64, String, Value),
    Drop,
}
#[derive(Clone)]
enum BridgeCommand {
    Call(String, Value),
    Revoke(String),
}
impl Shared {
    fn publish(&self, topic: &str, data: Value) {
        let id = self.event_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut history = self.event_history.lock().unwrap();
        history.push_back((id, topic.into(), data.clone()));
        if history.len() > 32 {
            history.pop_front();
        }
        drop(history);
        let _ = self.events.send(Event::Data(id, topic.into(), data));
    }
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
            let tmp = path.with_extension(format!("next-{}", random_id()));
            let bytes = serde_json::to_vec(store)?;
            #[cfg(unix)]
            {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&tmp)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
            }
            #[cfg(not(unix))]
            fs::write(&tmp, bytes)?;
            fs::rename(tmp, path)?;
        }
        Ok(())
    }
}
impl MockHarness {
    pub async fn start(options: MockOptions) -> io::Result<MockHandle> {
        Self::start_inner(options, None).await
    }
    pub async fn start_tls(
        options: MockOptions,
        identity: tls::Identity,
    ) -> io::Result<MockHandle> {
        Self::start_inner(options, Some(identity)).await
    }
    async fn start_inner(
        options: MockOptions,
        identity: Option<tls::Identity>,
    ) -> io::Result<MockHandle> {
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
            session_ticket_capability: AtomicBool::new(true),
            reject_browser_tickets: AtomicBool::new(false),
            api_version: Mutex::new("1.0.0".into()),
            reported_id: Mutex::new(None),
            failure: Mutex::new(None),
            key_unlock_enabled: AtomicBool::new(true),
            approvals_decide: options.approvals_decide && cfg!(debug_assertions),
            accepted_bridge: Mutex::new(BTreeMap::new()),
            approvals: Mutex::new(BTreeMap::new()),
            redeem_attempts: Mutex::new((0, 0)),
            event_id: AtomicU64::new(1),
            event_history: Mutex::new(VecDeque::new()),
            events,
            bridge_commands,
            pending_bridge: Mutex::new(BTreeMap::new()),
            bridge_results: Mutex::new(BTreeMap::new()),
            origin: Mutex::new(None),
            bound_ip: options.bind.ip(),
            tls: Mutex::new(identity.map(tls::TlsState::new)),
            proof_offer: Mutex::new(None),
            proof_attempts: Mutex::new((0, 0)),
            requests: Mutex::new(Vec::new()),
            event_replay_ids: Mutex::new(Vec::new()),
            revoke_after: Mutex::new(None),
            redemption_token_length: Mutex::new(None),
        });
        shared.save(&shared.store.lock().unwrap())?;
        let listener = TcpListener::bind(options.bind).await?;
        let origin = format!(
            "{}://{}",
            if shared.tls.lock().unwrap().is_some() {
                "https"
            } else {
                "http"
            },
            listener.local_addr()?
        );
        *shared.origin.lock().unwrap() = Some(origin.clone());
        let serving = shared.clone();
        let task = tokio::spawn(async move {
            if serving.tls.lock().unwrap().is_some() {
                tls::serve(listener, serving, options.test_control).await;
                return;
            }
            let _ = axum::serve(
                listener,
                router(serving, options.test_control)
                    .into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
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
    pub fn set_redemption_token_length(&self, length: usize) {
        *self.shared.redemption_token_length.lock().unwrap() = Some(length);
    }

    pub fn revoke_after_route(&self, route: &str) {
        *self.shared.revoke_after.lock().unwrap() = Some(route.into());
    }

    pub fn recorded_requests(&self) -> Vec<(String, bool)> {
        self.shared.requests.lock().unwrap().clone()
    }
    pub fn event_cursor(&self) -> u64 {
        self.shared.event_id.load(Ordering::SeqCst)
    }

    /// Synthetic SSE replay cursors only; never records bearer headers or device secrets.
    pub fn recorded_event_replay_ids(&self) -> Vec<Option<String>> {
        self.shared.event_replay_ids.lock().unwrap().clone()
    }
    pub fn clear_requests(&self) {
        self.shared.requests.lock().unwrap().clear()
    }

    pub fn create_approval(&self, id: &str, summary: &str) {
        let record = json!({
            "id":id,"state":"pending","summary":summary,
            "capability":capability::SYNTHETIC_APPROVAL_FS_READ,"effect":"read","flags":[],
            "targets":["/p1t/synthetic-target"],"risk":"low",
            "reversibility":"reversible","undo":"No change to undo",
            "subject":{"agent":"p1t-agent","session":"p1t-session","task":"p1t-task"},
            "principal":"p1t-owner","provenance":"synthetic test request",
            "grantOptions":["once"],"actionHash":"p1t-synthetic-hash",
            "agentReason":"Synthetic unverified reason"
        });
        self.shared
            .approvals
            .lock()
            .unwrap()
            .insert(id.into(), record.clone());
        self.shared.publish("approval.requested", record);
    }
    /// Writes synthetic native attach discovery only into a caller-owned scratch directory.
    pub fn write_discovery_fixture(
        &self,
        scratch: &tempfile::TempDir,
        pid: u32,
        instance_id: &str,
    ) -> io::Result<PathBuf> {
        if !self.shared.bound_ip.is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "native discovery requires loopback",
            ));
        }
        let run = scratch.path().join("run");
        fs::create_dir_all(&run)?;
        let path = run.join("api.json");
        let doc = json!({"url":self.shared.origin.lock().unwrap().clone().unwrap_or_default(),"pid":pid,"instanceId":instance_id,"installationId":self.shared.store.lock().unwrap().installation_id,"apiVersion":self.shared.api_version.lock().unwrap().clone()});
        fs::write(&path, serde_json::to_vec(&doc)?)?;
        Ok(path)
    }
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
            || !device.scopes.iter().any(|s| s == scope::BRIDGE_SERVE)
            || !self.shared.key_unlock_enabled.load(Ordering::SeqCst)
        {
            return Err("bridge grant denied");
        }
        drop(store);
        if self
            .shared
            .accepted_bridge
            .lock()
            .unwrap()
            .get(device_id)
            .copied()
            .unwrap_or(0)
            == 0
        {
            return Err("bridge capability not accepted");
        }
        let call_id = random_id();
        self.shared
            .pending_bridge
            .lock()
            .unwrap()
            .insert(call_id.clone(), (device_id.into(), op.into()));
        let call = json!({"type":"bridge.call","callId":call_id,"capability":capability::KEY_UNLOCK,"op":op,"args":args});
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
    pub fn bridge_connection_count(&self, device_id: &str) -> u32 {
        self.shared
            .accepted_bridge
            .lock()
            .unwrap()
            .get(device_id)
            .copied()
            .unwrap_or(0)
    }
    pub fn take_bridge_result(&self, call_id: &str) -> Option<Value> {
        self.shared.bridge_results.lock().unwrap().remove(call_id)
    }
    pub fn create_pair_code_with_grant(&self, grant: bool) -> String {
        self.create_pair_code_with_scopes_and_grant(&scope::BUNDLED, grant)
    }
    pub fn create_pair_code(&self) -> String {
        self.create_pair_code_with_scopes(&scope::BUNDLED)
    }
    pub fn create_pair_code_with_scopes(&self, scopes: &[&str]) -> String {
        self.create_pair_code_with_scopes_and_grant(scopes, true)
    }
    fn create_pair_code_with_scopes_and_grant(&self, scopes: &[&str], grant: bool) -> String {
        let mut bytes = [0_u8; 8];
        rand::rng().fill_bytes(&mut bytes);
        let raw: String = bytes
            .iter()
            .map(|b| plur1bus_desktop_contract::trust::CODE_ALPHABET[(b & 31) as usize] as char)
            .collect();
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
        drop(store);
        if self.shared.tls.lock().unwrap().is_some() {
            *self.shared.proof_offer.lock().unwrap() =
                Some(tls::ProofOffer::new(&code, self.shared.now() + 3600));
        }
        code
    }
    pub fn revoke_device(&self, id: &str) -> bool {
        let mut store = self.shared.store.lock().unwrap();
        let Some(device) = store.devices.get_mut(id) else {
            return false;
        };
        device.revoked = true;
        self.shared.accepted_bridge.lock().unwrap().remove(id);
        self.shared.save(&store).expect("persist revocation");
        let _ = self
            .shared
            .bridge_commands
            .send(BridgeCommand::Revoke(id.into()));
        let _ = self.shared.events.send(Event::Drop);
        true
    }
    pub fn set_status(&self, state: &str, secrets: &str) {
        self.set_status_with_reason(state, secrets, None);
    }
    pub fn set_status_with_reason(&self, state: &str, secrets: &str, reason: Option<&str>) {
        let mut store = self.shared.store.lock().unwrap();
        store.status = state.into();
        store.secrets = secrets.into();
        store.reason = reason.map(str::to_owned);
        self.shared.save(&store).expect("persist status");
        let mut data = json!({"state":state,"secrets":secrets});
        if let Some(reason) = reason {
            data["reason"] = json!(reason);
        }
        self.shared.publish("harness.status", data);
    }
    pub fn reject_browser_tickets(&self, reject: bool) {
        self.shared
            .reject_browser_tickets
            .store(reject, Ordering::SeqCst);
    }
    pub fn set_session_ticket_capability(&self, enabled: bool) {
        self.shared
            .session_ticket_capability
            .store(enabled, Ordering::SeqCst);
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
    pub fn secrets_locked(&self) -> bool {
        self.shared.store.lock().unwrap().secrets == "locked"
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

fn router(shared: Arc<Shared>, test_control: bool) -> Router {
    let mut router = Router::new()
        .route(routes::META, get(meta))
        .route(
            plur1bus_desktop_contract::trust::PAIR_PROOF,
            post(tls::proof).layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .route(plur1bus_desktop_contract::trust::CA, get(tls::ca))
        .route(plur1bus_desktop_contract::trust::TRUST, get(tls::trust))
        .route(plur1bus_desktop_contract::trust::ACK, post(tls::ack))
        .route(routes::DEVICE_REDEEM, post(redeem_device))
        .route(routes::SESSION_TICKET, post(session_ticket))
        .route(routes::TICKET_REDEEM, post(redeem_ticket))
        .route(routes::WHOAMI, get(whoami))
        .route(routes::EVENTS, get(events))
        .route(routes::BRIDGE, get(bridge))
        .route(routes::APPROVALS, get(approvals))
        .route(routes::APPROVAL_DECISION, post(approval_decision))
        .route("/", get(spa))
        .route("/auth/ticket", get(spa))
        .route("/spa.js", get(spa_script))
        .route("/api/v1/session/check", post(browser_check));
    if test_control {
        let controls = Router::new()
            .route("/__test/owner", post(test_owner))
            .route("/__test/pair", post(test_pair))
            .route("/__test/revoke", post(test_revoke))
            .route("/__test/failure", post(test_failure))
            .route("/__test/ticket-mode", post(test_ticket_mode))
            .route("/__test/cookie-canary", post(test_cookie_canary))
            .route(
                "/__test/cookie-canary-check",
                post(test_cookie_canary_check),
            )
            .route(
                "/__test/download",
                get(|| async { vec![0x5au8; 10 * 1024 * 1024] }),
            )
            .route("/__test/foreign-redirect", get(test_foreign_redirect))
            .route_layer(middleware::from_fn(loopback_test_control));
        router = router.merge(controls);
    }
    router
        .layer(middleware::from_fn_with_state(
            shared.clone(),
            record_request,
        ))
        .with_state(shared)
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CookieCanary {
    value: String,
}
fn valid_canary(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("CANARY-")
        && value[7..].bytes().all(|b| b.is_ascii_hexdigit())
}
async fn test_cookie_canary(Json(input): Json<CookieCanary>) -> Response {
    if !valid_canary(&input.value) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    (
        [(
            header::SET_COOKIE,
            format!(
                "wp05_canary={}; HttpOnly; SameSite=Lax; Path=/",
                input.value
            ),
        )],
        Json(json!({"set":true})),
    )
        .into_response()
}
async fn test_cookie_canary_check(headers: HeaderMap, Json(input): Json<CookieCanary>) -> Response {
    let found = valid_canary(&input.value)
        && headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';').any(|cookie| {
                    cookie.trim().strip_prefix("wp05_canary=") == Some(input.value.as_str())
                })
            });
    if found {
        StatusCode::OK
    } else {
        StatusCode::FORBIDDEN
    }
    .into_response()
}

async fn record_request(
    State(shared): State<Arc<Shared>>,
    request: Request,
    next: Next,
) -> Response {
    shared.requests.lock().unwrap().push((
        request.uri().path().into(),
        request.headers().contains_key(header::AUTHORIZATION),
    ));
    let revoke = shared.revoke_after.lock().unwrap().as_deref() == Some(request.uri().path());
    let token_hash = if revoke {
        request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(hash)
    } else {
        None
    };
    let response = next.run(request).await;
    if let Some(hash) = token_hash {
        let mut store = shared.store.lock().unwrap();
        if let Some(device) = store.devices.values_mut().find(|d| d.token_hash == hash) {
            device.revoked = true;
        }
    }
    response
}
async fn loopback_test_control(request: Request, next: Next) -> Response {
    let loopback_peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(peer)| peer.ip().is_loopback());
    if !loopback_peer {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn random_id() -> String {
    let mut bytes = [0_u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn random_ticket() -> String {
    let mut bytes = [0_u8; 32];
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
        json!({"apiVersion":*s.api_version.lock().unwrap(),"version":"0.1.0", "installationId":s.reported_id.lock().unwrap().clone().unwrap_or_else(||store.installation_id.clone()),"capabilities":if s.session_ticket_capability.load(Ordering::SeqCst) { vec![capability::SESSION_TICKET,capability::HOST_BRIDGE,"test.mock"] } else { vec![capability::HOST_BRIDGE,"test.mock"] }}),
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
    let mut token = random_id();
    if let Some(length) = *s.redemption_token_length.lock().unwrap() {
        token.truncate(length);
    }
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
    let device = match auth(&headers, &store, Some(scope::UI_SESSION)) {
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
    let ticket = random_ticket();
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
    if s.reject_browser_tickets.load(Ordering::SeqCst) {
        return err("ticket-invalid", StatusCode::UNAUTHORIZED);
    }
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
    store.sessions.insert(
        hash(&session),
        BrowserSession {
            device_id: ticket.device_id,
            csrf_hash: hash(&csrf),
        },
    );
    if s.save(&store).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let secure = if s
        .origin
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|o| o.starts_with("https:"))
    {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!("p1_session={session}; HttpOnly; SameSite=Lax; Path=/{secure}");
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
        match browser_auth(&headers, &store) {
            Ok((d, _)) => d,
            Err(e) => return err(e, StatusCode::UNAUTHORIZED),
        }
    };
    Json(json!({"userId":"mock-owner","deviceId":device.id,"scopes":device.scopes})).into_response()
}
#[derive(Deserialize)]
struct ApprovalQuery {
    state: Option<String>,
}
async fn approvals(
    State(s): State<Arc<Shared>>,
    Query(query): Query<ApprovalQuery>,
    headers: HeaderMap,
) -> Response {
    {
        let store = s.store.lock().unwrap();
        if let Err(e) = auth(&headers, &store, Some(scope::APPROVALS_DECIDE)) {
            return e.response();
        }
    }
    if query
        .state
        .as_deref()
        .is_some_and(|state| state != "pending")
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let items: Vec<Value> = s
        .approvals
        .lock()
        .unwrap()
        .values()
        .filter(|v| v["state"] == "pending")
        .cloned()
        .collect();
    Json(json!({"schema":"approvals.list/1","approvals":items})).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalDecision {
    decision: String,
    scope: String,
}
async fn approval_decision(
    State(s): State<Arc<Shared>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ApprovalDecision>,
) -> Response {
    {
        let store = s.store.lock().unwrap();
        if let Err(e) = auth(&headers, &store, Some(scope::APPROVALS_DECIDE)) {
            return e.response();
        }
    }
    if !s.approvals_decide {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !matches!(body.decision.as_str(), "approve" | "deny")
        || !matches!(body.scope.as_str(), "once" | "task" | "session" | "always")
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let record = {
        let mut approvals = s.approvals.lock().unwrap();
        let Some(record) = approvals.get_mut(&id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if record["state"] != "pending" {
            return StatusCode::CONFLICT.into_response();
        }
        if !record["grantOptions"]
            .as_array()
            .is_some_and(|options| options.iter().any(|option| option == &body.scope))
        {
            return StatusCode::BAD_REQUEST.into_response();
        }
        record["state"] = json!(body.decision);
        record["scope"] = json!(body.scope);
        record.clone()
    };
    s.publish("approval.resolved", record.clone());
    Json(record).into_response()
}
#[derive(Deserialize)]
struct EventQuery {
    topics: Option<String>,
}
async fn events(
    State(s): State<Arc<Shared>>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Response {
    s.event_replay_ids.lock().unwrap().push(
        headers
            .get("last-event-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    );
    {
        let store = s.store.lock().unwrap();
        if headers.contains_key(header::AUTHORIZATION) {
            if let Err(e) = auth(&headers, &store, Some(scope::EVENTS_READ)) {
                return e.response();
            }
        } else if let Err(e) = browser_auth(&headers, &store) {
            return err(e, StatusCode::UNAUTHORIZED);
        }
    }
    let topics: Vec<String> = query
        .topics
        .unwrap_or_else(|| "harness.status".into())
        .split(',')
        .map(str::to_owned)
        .collect();
    if topics.iter().any(|topic| {
        !matches!(
            topic.as_str(),
            "harness.status" | "approval" | "devices.trust.next"
        )
    }) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let accepts = |topic: &str| {
        topics.iter().any(|requested| {
            requested == topic || (requested == "approval" && topic.starts_with("approval."))
        })
    };
    let rx = s.events.subscribe();
    let last = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let latest = s.event_id.load(Ordering::SeqCst);
    let recovery = last.is_some_and(|seen| {
        if seen > latest {
            return true;
        }
        let history = s.event_history.lock().unwrap();
        history
            .front()
            .is_none_or(|(oldest, _, _)| seen.saturating_add(1) < *oldest)
            && seen < latest
    });
    let replay: Vec<(u64, String, Value)> = if let Some(last) = last {
        let history = s.event_history.lock().unwrap();
        history
            .iter()
            .filter(|(id, topic, _)| *id > last && accepts(topic))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let mut initial = if topics.iter().any(|topic| topic == "harness.status")
        && (last.is_none() || (replay.is_empty() && recovery))
    {
        let store = s.store.lock().unwrap();
        let mut data = json!({"state":store.status,"secrets":store.secrets});
        if let Some(reason) = &store.reason {
            data["reason"] = json!(reason);
        }
        vec![(latest, "harness.status".into(), data)]
    } else {
        replay
    };
    // Bootstrap pending cards after subscribing, so requests before a reconnect
    // cannot disappear between the desktop's initial status and live SSE events.
    if (last.is_none() || recovery) && topics.iter().any(|topic| topic == "approval") {
        initial.extend(
            s.approvals
                .lock()
                .unwrap()
                .values()
                .filter(|v| v["state"] == "pending")
                .take(200)
                .cloned()
                .map(|v| (latest, "approval.requested".into(), v)),
        );
    }
    let sent_through = initial
        .last()
        .map(|(id, _, _)| *id)
        .unwrap_or(last.unwrap_or(latest));
    let stream = stream::iter(initial.into_iter().map(|(id, topic, data)| {
        Ok::<_, std::convert::Infallible>(
            axum::response::sse::Event::default()
                .id(id.to_string())
                .event(topic)
                .data(data.to_string()),
        )
    }))
    .chain(stream::unfold(
        (rx, sent_through, topics),
        |(mut rx, mut sent_through, topics)| async move {
            loop {
                match rx.recv().await {
                    Ok(Event::Data(id, topic, v)) if id > sent_through => {
                        sent_through = id;
                        if !topics.iter().any(|requested| {
                            requested == &topic
                                || (requested == "approval" && topic.starts_with("approval."))
                        }) {
                            continue;
                        }
                        return Some((
                            Ok(axum::response::sse::Event::default()
                                .id(id.to_string())
                                .event(topic)
                                .data(v.to_string())),
                            (rx, sent_through, topics),
                        ));
                    }
                    Ok(Event::Data(_, _, _)) => continue,
                    Ok(Event::Drop) | Err(broadcast::error::RecvError::Closed) => return None,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
        },
    ));
    Sse::new(stream)
        .keep_alive(
            axum::response::sse::KeepAlive::new().interval(std::time::Duration::from_secs(11)),
        )
        .into_response()
}
async fn bridge(
    State(s): State<Arc<Shared>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !headers.contains_key(header::AUTHORIZATION) {
        {
            let store = s.store.lock().unwrap();
            if let Err(e) = browser_auth(&headers, &store) {
                return err(e, StatusCode::UNAUTHORIZED);
            }
        }
        if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
            != s.origin.lock().unwrap().as_deref()
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        return ws
            .on_upgrade(|mut socket| async move {
                while let Some(Ok(message)) = socket.recv().await {
                    if socket.send(message).await.is_err() {
                        break;
                    }
                }
            })
            .into_response();
    }
    let device = {
        let store = s.store.lock().unwrap();
        match auth(&headers, &store, Some(scope::BRIDGE_SERVE)) {
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
    let mut accepted_here = false;
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
                        let accepted = value["capabilities"].as_array().map(|v| v.iter().filter(|c| accepted_key_unlock && c.as_str() == Some(capability::KEY_UNLOCK)).cloned().collect::<Vec<_>>()).unwrap_or_default();
                        if !accepted.is_empty() && !accepted_here {
                            *shared.accepted_bridge.lock().unwrap().entry(device_id.clone()).or_default() += 1;
                            accepted_here = true;
                        }
                        if accepted.is_empty() && accepted_here {
                            let mut count = shared.accepted_bridge.lock().unwrap();
                            if let Some(value) = count.get_mut(&device_id) { *value = value.saturating_sub(1); }
                            accepted_here = false;
                        }
                        if socket.send(Message::Text(json!({"type":"bridge.welcome","accepted":accepted}).to_string().into())).await.is_err() { break }
                    }
                    Some("bridge.result") => {
                        if !accepted_here { break }
                        let Some(call_id) = value["callId"].as_str() else { break };
                        let pending = shared.pending_bridge.lock().unwrap().remove(call_id);
                        if let Some((expected_device, op)) = pending {
                            if expected_device != device_id { break }
                            if op == "provision" && value["ok"] == true {
                                let mut store = shared.store.lock().unwrap(); store.provisioned = true;
                                if shared.save(&store).is_err() { break }
                            }
                            if value["ok"] == true {
                                if let Some(key) = value["value"].as_str().filter(|key| URL_SAFE_NO_PAD.decode(key).is_ok_and(|b| b.len() == 32)) {
                                    let digest = hash(key);
                                    let mut store = shared.store.lock().unwrap();
                                    if op == "provision" && store.secret_key_digest.is_none() { store.secret_key_digest = Some(digest.clone()); }
                                    let unlocked = store.secret_key_digest.as_ref() == Some(&digest);
                                    store.secrets = if unlocked { "unlocked" } else { "locked" }.into();
                                    store.reason = (!unlocked).then(|| "key-mismatch".into());
                                    if shared.save(&store).is_err() { break; }
                                    shared.publish("harness.status", json!({"state":store.status,"secrets":store.secrets,"reason":store.reason}));
                                }
                            }
                            shared.bridge_results.lock().unwrap().insert(call_id.into(), value);
                        }
                    }
                    _ => break,
                }
            }
            command = commands.recv() => {
                match command {
                    Ok(BridgeCommand::Call(target, call)) if target == device_id && accepted_here => {
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
    if accepted_here {
        let mut count = shared.accepted_bridge.lock().unwrap();
        if let Some(value) = count.get_mut(&device_id) {
            *value = value.saturating_sub(1);
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestPair {
    scopes: Option<Vec<String>>,
    #[serde(default)]
    grant_key_unlock: bool,
}
async fn test_pair(State(s): State<Arc<Shared>>, Json(body): Json<TestPair>) -> Response {
    let scopes = body.scopes.unwrap_or_else(|| {
        vec![
            scope::UI_SESSION.into(),
            scope::EVENTS_READ.into(),
            scope::BRIDGE_SERVE.into(),
        ]
    });
    if scopes
        .iter()
        .any(|value| !scope::ALL.contains(&value.as_str()))
    {
        return err("unknown-scope", StatusCode::BAD_REQUEST);
    }
    if body.grant_key_unlock && !scopes.iter().any(|value| value == scope::BRIDGE_SERVE) {
        return err("invalid-grant", StatusCode::BAD_REQUEST);
    }
    let list: Vec<&str> = scopes.iter().map(String::as_str).collect();
    let code = (MockControl { shared: s.clone() })
        .create_pair_code_with_scopes_and_grant(&list, body.grant_key_unlock);
    Json(json!({"schema":"device.pair/1","code":code,"expiresAt":expires_at(s.now()+3600)}))
        .into_response()
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestTicketMode {
    reject: bool,
}
async fn test_ticket_mode(
    State(s): State<Arc<Shared>>,
    Json(body): Json<TestTicketMode>,
) -> Json<Value> {
    s.reject_browser_tickets
        .store(body.reject, Ordering::SeqCst);
    Json(json!({"ok":true}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestRedirect {
    target: String,
}
async fn test_foreign_redirect(
    axum::extract::Query(body): axum::extract::Query<TestRedirect>,
) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, body.target)]).into_response()
}
fn browser_auth(
    headers: &HeaderMap,
    store: &Store,
) -> Result<(Device, BrowserSession), &'static str> {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|c| c.trim().strip_prefix("p1_session="))
        })
        .ok_or("missing-session")?;
    let session = store.sessions.get(&hash(cookie)).ok_or("invalid-session")?;
    let device = store
        .devices
        .get(&session.device_id)
        .filter(|d| !d.revoked)
        .ok_or("invalid-session")?;
    Ok((device.clone(), session.clone()))
}
async fn browser_check(State(s): State<Arc<Shared>>, headers: HeaderMap) -> Response {
    let store = s.store.lock().unwrap();
    let (_, session) = match browser_auth(&headers, &store) {
        Ok(v) => v,
        Err(e) => return err(e, StatusCode::UNAUTHORIZED),
    };
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        != s.origin.lock().unwrap().as_deref()
        || headers
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| hash(v) != session.csrf_hash)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({"ok":true})).into_response()
}
async fn spa() -> Response {
    ([(header::CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")],Html(include_str!("spa.html"))).into_response()
}
async fn spa_script() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript")],
        include_str!("spa.js"),
    )
        .into_response()
}

// Stub-only provisioning. The control router is explicitly enabled and loopback-only.
async fn test_owner(State(s): State<Arc<Shared>>) -> Response {
    let mut store = s.store.lock().unwrap();
    if store.provisioned {
        return Json(json!({"schema":"error/1","code":"E_EXISTS"})).into_response();
    }
    store.provisioned = true;
    if s.save(&store).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"schema":"user.create/1","userId":"mock-owner"})).into_response()
}

#[cfg(test)]
mod control_peer_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_control_routes_refuse_non_loopback_connection_peers() {
        let server = MockHarness::start(MockOptions {
            test_control: true,
            ..Default::default()
        })
        .await
        .unwrap();
        for (route, body) in [
            ("/__test/pair", json!({})),
            ("/__test/revoke", json!({"device_id":"synthetic"})),
            ("/__test/failure", json!({"step":"smoke"})),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri(route)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            request
                .extensions_mut()
                .insert(axum::extract::ConnectInfo(SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)),
                    50000,
                )));
            let response = router(server.control.shared.clone(), true)
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{route}");
        }
    }

    #[tokio::test]
    async fn test_control_routes_refuse_missing_peer_metadata() {
        let server = MockHarness::start(MockOptions {
            test_control: true,
            ..Default::default()
        })
        .await
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/__test/pair")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let response = router(server.control.shared.clone(), true)
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
