//! Persistent authenticated reverse RPC to Core-owned host services.
//!
//! A lazy connection subscribes to policy changes before serving host calls. One
//! reader handles responses and notifications, and a bounded best-effort event
//! queue keeps emit independent of a stalled Core. Cached policy decisions are
//! invalidated on notifications, disconnects and Core credential changes.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use plur1bus_rpc::client::{BackgroundClient, ClientEvent};
use plur1bus_rpc::{ConnectOptions, RpcError};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::contract::{
    AddressRules, AgentId, Cancel, Decision, EgressGate, EngineConfig, HostError, HostServices,
    JournalBacklog, LlmParams, LlmPort, LlmResult, PlatformCapabilities, Scheme, SecretPort,
    SecretValue, Target,
};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const EVENT_TIMEOUT: Duration = Duration::from_millis(250);
const WAIT_TICK: Duration = Duration::from_millis(20);
const POLICY_TTL: Duration = Duration::from_secs(60);
const MAX_POLICY_TARGETS: usize = 256;
const MAX_QUEUED_EVENTS: usize = 32;
const MAX_EVENT_BYTES: usize = 64 * 1024;

type Invalidate = Arc<dyn Fn() + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// Neither identity nor the host implements diagnostic formatting: they own credentials.
// The Core owner token is retained only as a rotation fingerprint and is never transmitted.
#[derive(Clone, PartialEq, Eq)]
struct CoreIdentity {
    token: String,
    pid: u32,
    incarnation: String,
}

impl CoreIdentity {
    fn read(home: &Path) -> Result<Self, HostError> {
        let run = home.join("run");
        let token = read_identity_file(&run.join("core.token"))?;
        let token = token.trim();
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(HostError::Unavailable);
        }
        let identity = read_identity_file(&run.join("core.pid"))?;
        let mut fields = identity.split_whitespace();
        let pid = fields
            .next()
            .and_then(|field| field.parse::<u32>().ok())
            .filter(|pid| *pid != 0)
            .ok_or(HostError::Unavailable)?;
        let incarnation = fields.next().ok_or(HostError::Unavailable)?;
        if fields.next().is_some() {
            return Err(HostError::Unavailable);
        }
        Ok(Self {
            token: token.to_owned(),
            pid,
            incarnation: incarnation.to_owned(),
        })
    }
}

#[derive(Default)]
struct PolicyState {
    generation: u64,
    identity: Option<CoreIdentity>,
    entries: HashMap<Target, (Instant, Decision)>,
}

#[derive(Default)]
struct PolicyCache {
    state: Mutex<PolicyState>,
    invalidator: Mutex<Option<Invalidate>>,
}

impl PolicyCache {
    fn notify_transports(&self) {
        let callback = lock(&self.invalidator).clone();
        if let Some(callback) = callback {
            // Listener failures must not propagate into a turn or the RPC reader.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback()));
        }
    }

    fn invalidate(&self) {
        {
            let mut state = lock(&self.state);
            state.generation = state.generation.wrapping_add(1);
            state.entries.clear();
        }
        self.notify_transports();
    }

    fn observe_identity(&self, identity: &CoreIdentity) {
        let changed = {
            let mut state = lock(&self.state);
            if state.identity.as_ref() == Some(identity) {
                false
            } else {
                state.identity = Some(identity.clone());
                state.generation = state.generation.wrapping_add(1);
                state.entries.clear();
                true
            }
        };
        if changed {
            self.notify_transports();
        }
    }

    fn lookup(&self, target: &Target) -> Option<Decision> {
        let mut state = lock(&self.state);
        if let Some((expires, decision)) = state.entries.get(target) {
            if *expires > Instant::now() {
                return Some(decision.clone());
            }
        }
        state.entries.remove(target);
        None
    }

    fn insert(&self, target: &Target, decision: &Decision, generation: u64) {
        let mut state = lock(&self.state);
        if state.generation != generation {
            return;
        }
        state
            .entries
            .retain(|_, (expires, _)| *expires > Instant::now());
        if state.entries.len() >= MAX_POLICY_TARGETS {
            state.entries.clear();
        }
        state.entries.insert(
            target.clone(),
            (Instant::now() + POLICY_TTL, decision.clone()),
        );
    }
}

struct ActiveConnection {
    identity: CoreIdentity,
    client: Arc<BackgroundClient>,
}

#[derive(Default)]
struct Session {
    connecting: bool,
    active: Option<ActiveConnection>,
}

struct HostLink {
    home: PathBuf,
    engine_token: String,
    session: Mutex<Session>,
    changed: Condvar,
    stopped: AtomicBool,
    policy: Arc<PolicyCache>,
}

impl HostLink {
    fn disconnect(&self) {
        let active = lock(&self.session).active.take();
        if let Some(active) = active {
            active.client.close();
        }
        self.policy.invalidate();
        self.changed.notify_all();
    }

    fn disconnect_client(&self, client: &Arc<BackgroundClient>) {
        let active = {
            let mut session = lock(&self.session);
            if session
                .active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(&active.client, client))
            {
                session.active.take()
            } else {
                None
            }
        };
        if let Some(active) = active {
            active.client.close();
            self.policy.invalidate();
        }
        self.changed.notify_all();
    }

    fn identity(&self) -> Result<CoreIdentity, HostError> {
        match CoreIdentity::read(&self.home) {
            Ok(identity) => {
                self.policy.observe_identity(&identity);
                Ok(identity)
            }
            Err(error) => {
                self.disconnect();
                Err(error)
            }
        }
    }

    fn check(&self, deadline: Instant, cancel: Option<&Cancel>) -> Result<Duration, HostError> {
        if let Some(cancel) = cancel {
            cancel.check()?;
        }
        if self.stopped.load(Ordering::Acquire) {
            return Err(HostError::Unavailable);
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(HostError::Unavailable)?;
        Ok(cancel
            .and_then(Cancel::remaining)
            .map_or(remaining, |budget| budget.min(remaining)))
    }

    fn connection(
        &self,
        deadline: Instant,
        cancel: Option<&Cancel>,
    ) -> Result<Arc<BackgroundClient>, HostError> {
        let identity = self.identity()?;
        loop {
            self.check(deadline, cancel)?;
            let mut session = lock(&self.session);
            if !session.connecting {
                if let Some(active) = &session.active {
                    if active.identity == identity && !active.client.is_closed() {
                        return Ok(active.client.clone());
                    }
                }
                session.connecting = true;
                let old = session.active.take();
                drop(session);
                if let Some(old) = old {
                    old.client.close();
                }
                self.policy.invalidate();
                let result = self.connect(&identity, deadline, cancel);
                let mut session = lock(&self.session);
                session.connecting = false;
                if result.is_err() {
                    if let Some(active) = session.active.take() {
                        active.client.close();
                    }
                }
                self.changed.notify_all();
                return result;
            }
            let remaining = self.check(deadline, cancel)?;
            drop(
                self.changed
                    .wait_timeout(session, remaining.min(WAIT_TICK))
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            );
        }
    }

    fn connect(
        &self,
        identity: &CoreIdentity,
        deadline: Instant,
        cancel: Option<&Cancel>,
    ) -> Result<Arc<BackgroundClient>, HostError> {
        let remaining = self.check(deadline, cancel)?;
        let options = ConnectOptions {
            expected_server_pid: Some(identity.pid),
            connect_timeout: remaining.min(ConnectOptions::default().connect_timeout),
            ..ConnectOptions::default()
        };
        let policy = self.policy.clone();
        // Address/UID or Windows pipe-PID verification remains inside the shared
        // client before either credential is transmitted.
        let client = Arc::new(BackgroundClient::connect_with_auth(
            &super::layout::unit_address(&self.home, "core"),
            json!({"token":self.engine_token,"engine":{"clientId":"plur1bus-engine","token":self.engine_token}}),
            options,
            Arc::new(move |event| match event {
                ClientEvent::Notification { method, .. } if method == "egress.changed" => policy.invalidate(),
                ClientEvent::Closed => policy.invalidate(),
                _ => {}
            }),
        ).map_err(|error| map_rpc_error(&error))?);
        if self.stopped.load(Ordering::Acquire) {
            client.close();
            return Err(HostError::Unavailable);
        }
        // Publish the interruptible client before subscription, so shutdown can
        // abort a Core that acknowledges auth but stalls the subscription.
        lock(&self.session).active = Some(ActiveConnection {
            identity: identity.clone(),
            client: client.clone(),
        });
        let remaining = self.check(deadline, cancel)?;
        let cancelled =
            || self.stopped.load(Ordering::Acquire) || cancel.is_some_and(Cancel::is_cancelled);
        let subscribed = client.call(
            "events.subscribe",
            json!({"names":["egress.changed"]}),
            remaining,
            &cancelled,
        );
        if !subscribed.as_ref().is_ok_and(|response| {
            response
                .get("subscriptionId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && id.len() <= 128)
        }) {
            client.close();
            return Err(HostError::Unavailable);
        }
        self.check(deadline, cancel)?;
        // Never promote credentials that changed while the handshake was in flight.
        if CoreIdentity::read(&self.home)? != *identity {
            client.close();
            return Err(HostError::Unavailable);
        }
        Ok(client)
    }

    fn call(
        &self,
        method: &str,
        params: Value,
        deadline: Instant,
        cancel: Option<&Cancel>,
    ) -> Result<(Value, u64), HostError> {
        let client = self.connection(deadline, cancel)?;
        let generation = lock(&self.policy.state).generation;
        let remaining = self.check(deadline, cancel)?;
        let cancelled =
            || self.stopped.load(Ordering::Acquire) || cancel.is_some_and(Cancel::is_cancelled);
        let result = client.call(method, params, remaining, &cancelled);
        if result.is_err() && client.is_closed() {
            self.disconnect_client(&client);
        }
        if let Some(cancel) = cancel {
            cancel.check()?;
        }
        result
            .map(|value| (value, generation))
            .map_err(|error| map_rpc_error(&error))
    }
}

struct QueuedEvent {
    name: String,
    payload: Value,
}
struct EventWorker {
    sender: mpsc::SyncSender<QueuedEvent>,
    thread: JoinHandle<()>,
}

/// Core-backed host ports with one lazy authenticated connection and bounded events.
/// This type intentionally has no diagnostic formatter because it owns credentials.
pub struct RpcHost {
    state: PathBuf,
    config: EngineConfig,
    fixture_now_ms: Option<i64>,
    platform: PlatformCapabilities,
    link: Arc<HostLink>,
    events: Mutex<Option<EventWorker>>,
    dropped_events: AtomicU64,
}

impl RpcHost {
    /// Construct without connecting. Preserve the same normalized absolute home
    /// passed to Core: Windows pipe identity hashes this configured spelling.
    pub fn new(home: PathBuf, engine_token: String, config: EngineConfig) -> Self {
        Self {
            state: home.join("state"),
            config,
            fixture_now_ms: None,
            platform: PlatformCapabilities::default(),
            link: Arc::new(HostLink {
                home,
                engine_token,
                session: Mutex::new(Session::default()),
                changed: Condvar::new(),
                stopped: AtomicBool::new(false),
                policy: Arc::new(PolicyCache::default()),
            }),
            events: Mutex::new(None),
            dropped_events: AtomicU64::new(0),
        }
    }

    /// Supply native filesystem and IPC callbacks.
    pub fn with_platform(mut self, platform: PlatformCapabilities) -> Self {
        self.platform = platform;
        self
    }

    /// Supply the offline clock already validated by the authorized CLI seam.
    pub fn with_fixture_clock(mut self, now_ms: Option<i64>) -> Self {
        self.fixture_now_ms = now_ms;
        self
    }

    /// Register the prompt, nonblocking callback that invalidates owned transport caches.
    /// The composition should capture the engine weakly so this does not create a cycle.
    pub fn set_egress_invalidator(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        *lock(&self.link.policy.invalidator) = Some(callback);
    }

    /// Number of best-effort events dropped because the queue was full or unavailable.
    pub fn dropped_events(&self) -> u64 {
        self.dropped_events.load(Ordering::Relaxed)
    }

    /// Stop events and interrupt all pending reverse RPCs. Subsequent calls fail closed.
    pub fn shutdown(&self) {
        self.link.stopped.store(true, Ordering::Release);
        self.link.disconnect();
        let worker = lock(&self.events).take();
        if let Some(worker) = worker {
            drop(worker.sender);
            let _ = worker.thread.join();
        }
    }

    /// Complete work for its actual owning agent, preserving the outer wire scope.
    pub fn complete_for(
        &self,
        agent: &AgentId,
        params: &LlmParams,
        cancel: &Cancel,
    ) -> Result<LlmResult, HostError> {
        cancel.check()?;
        let response = self.call(
            "host.llm.complete",
            json!({"agentId":agent,"params":params}),
            Some(cancel),
        );
        cancel.check()?;
        decode(response?)
    }

    fn call(
        &self,
        method: &str,
        params: Value,
        cancel: Option<&Cancel>,
    ) -> Result<Value, HostError> {
        self.link
            .call(method, params, Instant::now() + CALL_TIMEOUT, cancel)
            .map(|(value, _)| value)
    }

    fn queue_event(&self, name: &str, payload: Value) -> bool {
        if self.link.stopped.load(Ordering::Acquire) || name.len() > 256 {
            return false;
        }
        let mut counter = EventSize(0);
        if serde_json::to_writer(&mut counter, &payload).is_err() {
            return false;
        }
        let mut events = lock(&self.events);
        if events.is_none() {
            let (sender, receiver) = mpsc::sync_channel::<QueuedEvent>(MAX_QUEUED_EVENTS);
            let link = self.link.clone();
            let Ok(thread) = thread::Builder::new()
                .name("engine-events".into())
                .spawn(move || {
                    while !link.stopped.load(Ordering::Acquire) {
                        match receiver.recv_timeout(WAIT_TICK) {
                            Ok(event) => {
                                let _ = link.call(
                                    "host.event",
                                    json!({"name":event.name,"payload":event.payload}),
                                    Instant::now() + EVENT_TIMEOUT,
                                    None,
                                );
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                })
            else {
                return false;
            };
            *events = Some(EventWorker { sender, thread });
        }
        events.as_ref().is_some_and(|worker| {
            worker
                .sender
                .try_send(QueuedEvent {
                    name: name.to_owned(),
                    payload,
                })
                .is_ok()
        })
    }
}

impl Drop for RpcHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct EventSize(usize);
impl Write for EventSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_EVENT_BYTES.saturating_sub(self.0) {
            return Err(std::io::Error::other("event too large"));
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl HostServices for RpcHost {
    fn state_dir(&self) -> &Path {
        &self.state
    }

    fn config(&self) -> EngineConfig {
        self.config.clone()
    }

    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
        let response = self.call("host.workspaceDir", json!({ "agentId": agent }), None)?;
        match response.get("path") {
            Some(Value::Null) => Ok(None),
            Some(Value::String(path)) => Ok(Some(PathBuf::from(path))),
            _ => Err(HostError::InvalidResponse),
        }
    }

    fn llm(&self) -> Option<&dyn LlmPort> {
        Some(self)
    }

    fn secrets(&self) -> Option<&dyn SecretPort> {
        Some(self)
    }

    fn egress(&self) -> &dyn EgressGate {
        self
    }

    fn emit(&self, event: &str, payload: Value) {
        if !self.queue_event(event, payload) {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn now_ms(&self) -> i64 {
        if let Some(now) = self.fixture_now_ms {
            return now;
        }
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO);
        i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
    }

    fn platform(&self) -> &PlatformCapabilities {
        &self.platform
    }

    fn journal_backlog(&self) -> Option<JournalBacklog> {
        self.call("host.journalBacklog", json!({}), None)
            .ok()
            .and_then(|value| decode::<Option<JournalBacklog>>(value).ok())
            .flatten()
    }
}

impl LlmPort for RpcHost {
    fn complete(&self, _params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        cancel.check()?;
        // RE-01's trait cannot express the owning agent. Fail before connecting;
        // only complete_for may cross the guarded Core completion boundary.
        Err(HostError::Denied)
    }
}

impl SecretPort for RpcHost {
    fn get(&self, name: &str) -> Result<Option<SecretValue>, HostError> {
        let response = self.call("host.secret.get", json!({ "name": name }), None)?;
        match response.get("value") {
            Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(SecretValue::new(value.clone()))),
            _ => Err(HostError::InvalidResponse),
        }
    }
}

impl EgressGate for RpcHost {
    fn decide(&self, target: &Target) -> Decision {
        if self.link.stopped.load(Ordering::Acquire) {
            return deny("host-unavailable");
        }
        if self.link.identity().is_err() {
            return deny("host-unavailable");
        }
        if let Some(decision) = self.link.policy.lookup(target) {
            return decision;
        }
        let scheme = match target.scheme {
            Scheme::Http => "http",
            Scheme::Https => "https",
        };
        let (response, generation) = match self.link.call(
            "host.egress.decide",
            json!({"scheme":scheme,"host":target.host,"port":target.port}),
            Instant::now() + CALL_TIMEOUT,
            None,
        ) {
            Ok(response) => response,
            Err(HostError::Denied) => return deny("host-denied"),
            Err(HostError::InvalidResponse) => return deny("host-invalid-response"),
            Err(_) => return deny("host-unavailable"),
        };
        let decision = policy_decision(target, &response);
        let cacheable = match &decision {
            Decision::Allow { .. } => true,
            Decision::Deny { reason } => matches!(
                reason.as_str(),
                "invalid-url"
                    | "scheme"
                    | "port"
                    | "host-not-allowed"
                    | "loopback"
                    | "private-address"
                    | "not-found"
            ),
        };
        if cacheable {
            self.link.policy.insert(target, &decision, generation);
        }
        decision
    }
}

fn policy_decision(target: &Target, response: &Value) -> Decision {
    match response.get("allowed").and_then(Value::as_bool) {
        Some(false) => {
            let reason = response
                .get("reason")
                .and_then(Value::as_str)
                .filter(|reason| {
                    matches!(
                        *reason,
                        "invalid-url"
                            | "scheme"
                            | "port"
                            | "host-not-allowed"
                            | "loopback"
                            | "private-address"
                            | "not-found"
                    )
                })
                .unwrap_or("host-denied");
            deny(reason)
        }
        Some(true) => {
            let host = response.get("host").and_then(Value::as_str);
            let address = response
                .get("address")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<IpAddr>().ok());
            let Some(address) = address else {
                return deny("host-invalid-response");
            };
            let family = if address.is_ipv4() { 4 } else { 6 };
            if !host
                .is_some_and(|host| host.eq_ignore_ascii_case(target.host.trim_end_matches('.')))
                || response.get("port").and_then(Value::as_u64) != Some(u64::from(target.port))
                || response.get("family").and_then(Value::as_u64) != Some(family)
            {
                return deny("host-invalid-response");
            }
            let address_rules = AddressRules {
                // Core only allows loopback when the origin itself is a loopback
                // spelling. Recheck that invariant before granting the local resolver
                // permission to dial any loopback record. Private/metadata stay denied.
                allow_loopback: loopback(address) && loopback_host(&target.host),
                ..AddressRules::default()
            };
            if !crate::transport::target::address_allowed(address, address_rules) {
                return deny("host-invalid-response");
            }
            Decision::Allow { address_rules }
        }
        None => deny("host-invalid-response"),
    }
}

/// Read a private run identity through a bounded, no-follow held file.
/// Any unsafe metadata or filesystem error becomes a body-free unavailable error.
pub(crate) fn read_identity_file(path: &Path) -> Result<String, HostError> {
    const MAX_IDENTITY_BYTES: u64 = 4096;
    let parent = path.parent().ok_or(HostError::Unavailable)?;
    plur1bus_rpc::trust::verify_run_dir(parent).map_err(|_| HostError::Unavailable)?;
    crate::store::paths::assert_trusted_path(path).map_err(|_| HostError::Unavailable)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NONBLOCK also prevents an unexpectedly replaced FIFO from blocking
        // before the held descriptor can be checked as a regular file.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        // Hold the name stable while inspecting its DACL and reading its bytes.
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ);
    }
    let file = options.open(path).map_err(|_| HostError::Unavailable)?;
    let metadata = file.metadata().map_err(|_| HostError::Unavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_IDENTITY_BYTES {
        return Err(HostError::Unavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if metadata.uid() != euid || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err(HostError::Unavailable);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(HostError::Unavailable);
        }
        // SAFETY: this POD is immediately populated using the live held file.
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the handle and writable output remain valid throughout this query.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0
            || information.nNumberOfLinks != 1
        {
            return Err(HostError::Unavailable);
        }
        let user = plur1bus_rpc::win::user_sid().map_err(|_| HostError::Unavailable)?;
        for protected in [parent, path] {
            let entries = plur1bus_rpc::win::file_dacl_report_strict(protected)
                .map_err(|_| HostError::Unavailable)?;
            if entries.iter().any(|entry| {
                entry.allow
                    && entry.mask != 0
                    && entry.sid != user
                    && entry.sid != plur1bus_rpc::acl::SYSTEM_SID
            }) {
                return Err(HostError::Unavailable);
            }
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_IDENTITY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HostError::Unavailable)?;
    if bytes.len() > MAX_IDENTITY_BYTES as usize {
        return Err(HostError::Unavailable);
    }
    String::from_utf8(bytes).map_err(|_| HostError::Unavailable)
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, HostError> {
    serde_json::from_value(value).map_err(|_| HostError::InvalidResponse)
}

fn map_rpc_error(error: &RpcError) -> HostError {
    // Do not retain or format arbitrary remote message/reason/detail fields.
    match error {
        RpcError::Unavailable { .. } | RpcError::Version { .. } => HostError::Unavailable,
        RpcError::Protocol(_) => HostError::InvalidResponse,
        RpcError::Call { error, .. } => match error {
            plur1bus_rpc::types::ErrorCode::EDenied
            | plur1bus_rpc::types::ErrorCode::EUnauthorized => HostError::Denied,
            plur1bus_rpc::types::ErrorCode::ENotAvailable
            | plur1bus_rpc::types::ErrorCode::ECoreUnavailable => HostError::Unavailable,
            _ => HostError::Failed,
        },
    }
}

fn deny(reason: &str) -> Decision {
    Decision::Deny {
        reason: reason.to_owned(),
    }
}

fn loopback(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_loopback(),
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map_or_else(|| address.is_loopback(), |address| address.is_loopback()),
    }
}

fn loopback_host(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost") || host.parse().is_ok_and(loopback)
}
