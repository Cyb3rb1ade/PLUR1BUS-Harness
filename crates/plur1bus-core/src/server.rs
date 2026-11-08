//! The front door's listener and connections (P4-10): `run/core.sock` (`0600` in a `0700` `run/`, a stale socket probed
//! and removed first) or the Windows pipe with the explicit user-and-SYSTEM DACL of `plur1bus_rpc::server_transport`
//! (closing ADR-012 deviation C2 for the core's own pipe), NDJSON framing with 4 MiB lines, a 16 MiB back-pressure limit
//! per client, the 30 s authentication deadline, and the route table that decides native or relay before any dispatch.
//!
//! Before `core.auth` everything is answered here, exactly as module-api's `RpcServer` answers it (API delegation, request
//! validation, `auth-required`). After it, the method table ([`crate::route`]) decides:
//! - `core.auth` again (a re-authentication): the front door verifies the client's credentials, then opens the client's
//!   link with them and the link credential, and answers with its own `pid` and `instanceId` and the union of native and
//!   relayed methods as capabilities (the first handshake takes the same path);
//! - `bridge.*`: native, for the legacy core's own connection only;
//! - `core.status`, `core.adopt`, `core.shutdown`, `events.subscribe`, `events.unsubscribe`: relayed so the legacy core
//!   still runs its admission and RBAC on them, and completed here: the status names the front door's process, an
//!   adoption makes the client connection the front door's lifeline, an accepted shutdown stops the front door, and an
//!   owner's subscriptions are kept for the front door's own `core.state`;
//! - the native set (`route::NATIVE`, empty until P4-11): module-api's admission here, then the generated dispatcher;
//! - everything else, known or unknown: relayed byte for byte on the client's link.
use crate::auth::{self, Caller, Refusal, Secret};
use crate::events::{self, Sub};
use crate::frame::{self, Line, RpcErr, MAX_PENDING_BYTES};
use crate::lifecycle::{self, relock, Event, Lifeline, ProcessState, Timings};
use crate::relay::Link;
use crate::route::{self, Kind, Route};
use crate::run_files::{self, RunFiles};
use plur1bus_rpc::server::{compile, findings, pruned_root, schema};
use plur1bus_rpc::server_transport::{Accepted, Listener};
use plur1bus_rpc::transport::Stream;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// An unauthenticated connection is closed after this long (`authIdleMs`).
pub const AUTH_IDLE: Duration = Duration::from_secs(30);
/// At most this many client connections at once; more are closed on accept (each costs threads, not a Node socket).
pub const MAX_CONNECTIONS: usize = 512;
/// The longest a handshake waits for the legacy core's answer.
const LINK_AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const THREAD_STACK: usize = 512 * 1024;

/// One-line diagnostics on stderr, never a credential (`plur1bus-core: <level> <message> <fields>`).
#[allow(clippy::needless_pass_by_value)] // callers build the fields in place
pub fn log(level: &str, message: &str, fields: Value) {
    let line = if fields.is_null() {
        format!("plur1bus-core: {level} {message}\n")
    } else {
        format!("plur1bus-core: {level} {message} {fields}\n")
    };
    let _ = io::stderr().lock().write_all(line.as_bytes());
}

/// The params and result validators of every `x-server: "core"` method, compiled from pruned schema roots (P4-03). The
/// front door itself compiles only the few it runs ([`Checks`]); the packages that serve methods natively build these.
pub fn validators() -> Result<plur1bus_rpc::server::Validators, String> {
    plur1bus_rpc::server::Validators::for_server("core")
}

/// The validators the front door runs itself, compiled once from pruned roots of the RPC schema.
pub struct Checks {
    request: jsonschema::Validator,
    auth_params: jsonschema::Validator,
    status_result: jsonschema::Validator,
    adopt_result: jsonschema::Validator,
    hello_params: jsonschema::Validator,
    hello_result: jsonschema::Validator,
}

impl Checks {
    /// Compiles them; an error is a schema bug and fails the start.
    pub fn new() -> Result<Checks, String> {
        let s = schema();
        let part = |method: &str, part: &str| {
            compile(&pruned_root(s, &s["$defs"]["methods"][method][part]))
                .map_err(|e| format!("{method} {part}: {e}"))
        };
        Ok(Checks {
            request: compile(&pruned_root(s, &json!({"$ref": "#/$defs/Request"})))?,
            auth_params: part("core.auth", "params")?,
            status_result: part("core.status", "result")?,
            adopt_result: part("core.adopt", "result")?,
            hello_params: part("bridge.hello", "params")?,
            hello_result: part("bridge.hello", "result")?,
        })
    }
}

/// `validateParams`: `_meta` is not a method field (D111).
fn without_meta(params: &Value) -> Value {
    let mut p = params.clone();
    if let Some(map) = p.as_object_mut() {
        map.remove("_meta");
    }
    p
}

/// What the front door holds for its whole life.
pub struct FrontDoor {
    /// The run files.
    pub files: RunFiles,
    /// The instance id (`--instance`, or a fresh one).
    pub instance: String,
    /// This process.
    pub pid: u32,
    started: Instant,
    core_token: Secret,
    api_token: Secret,
    link_token: Secret,
    legacy_pid: u32,
    /// The legacy core's `core.auth` result on the control link (its `contract`).
    legacy_contract: String,
    checks: Checks,
    state: Mutex<ProcessState>,
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    next_conn: AtomicU64,
    live: AtomicUsize,
    accepting: AtomicBool,
    stopping: AtomicBool,
    lifeline: Mutex<Lifeline>,
    events: Mutex<Sender<Event>>,
    /// The timings read at start.
    pub timings: Timings,
}

/// The credentials the front door wrote into `run/`.
pub struct Credentials {
    /// `run/core.token`.
    pub core: Secret,
    /// `run/api-delegation.token`.
    pub api: Secret,
    /// `run/core-legacy.token`.
    pub link: Secret,
}

impl FrontDoor {
    /// The front door for a running legacy core.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        files: RunFiles,
        instance: String,
        credentials: Credentials,
        legacy_pid: u32,
        legacy_contract: String,
        checks: Checks,
        events: Sender<Event>,
        timings: Timings,
        stdin_lifeline: bool,
    ) -> FrontDoor {
        FrontDoor {
            files,
            instance,
            pid: std::process::id(),
            started: Instant::now(),
            core_token: credentials.core,
            api_token: credentials.api,
            link_token: credentials.link,
            legacy_pid,
            legacy_contract,
            checks,
            state: Mutex::new(ProcessState::now("starting")),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            live: AtomicUsize::new(0),
            accepting: AtomicBool::new(true),
            stopping: AtomicBool::new(false),
            lifeline: Mutex::new(Lifeline {
                connection: None,
                orphaned_since: None,
                generation: u64::from(stdin_lifeline),
            }),
            events: Mutex::new(events),
            timings,
        }
    }

    /// The current process state.
    pub fn state(&self) -> ProcessState {
        relock(&self.state).clone()
    }

    /// Changes the process state and sends `core.state` to the owner subscribers.
    pub fn set_state(&self, next: ProcessState) {
        let note = frame::encode(
            &json!({"jsonrpc":"2.0","method":"core.state","params":{"process": next.to_json()}}),
        );
        *relock(&self.state) = next;
        for conn in self.connections() {
            let deliver = {
                let st = relock(&conn.state);
                st.authed
                    && !st.closing
                    && st.caller == Some(Caller::Owner)
                    && events::takes_core_state(&st.subs)
            };
            if deliver {
                conn.out.push(note.clone());
            }
        }
    }

    /// Client connections still open.
    pub fn open_connections(&self) -> usize {
        relock(&self.conns).len()
    }

    fn connections(&self) -> Vec<Arc<Conn>> {
        relock(&self.conns).values().cloned().collect()
    }

    /// Whether a stop has begun.
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Marks the stop as begun; `false` when it already was.
    pub fn begin_stop(&self) -> bool {
        !self.stopping.swap(true, Ordering::SeqCst)
    }

    fn send_event(&self, event: Event) {
        let _ = relock(&self.events).send(event);
    }

    /// Asks the main loop to stop.
    pub fn request_stop(&self, budget: Duration, why: &'static str) {
        self.send_event(Event::Stop {
            budget,
            why,
            ok_code: 0,
        });
    }

    /// The stdin lifeline ended: orphaned unless an adoption replaced it.
    pub fn stdin_lost(&self) {
        let lost = {
            let l = relock(&self.lifeline);
            l.connection.is_none()
        };
        if lost {
            self.orphan();
        }
    }

    fn connection_lost(&self, id: u64) {
        let lost = {
            let mut l = relock(&self.lifeline);
            if l.connection == Some(id) {
                l.connection = None;
                true
            } else {
                false
            }
        };
        if lost {
            self.orphan();
        }
    }

    fn orphan(&self) {
        if self.is_stopping() {
            return;
        }
        let (generation, since) = {
            let mut l = relock(&self.lifeline);
            if l.orphaned_since.is_some() {
                return;
            }
            let since = lifecycle::now_ms();
            l.orphaned_since = Some(since);
            (l.generation, since)
        };
        log(
            "warn",
            "lifeline lost, core orphaned",
            json!({"graceMs": self.timings.grace.as_millis() as u64}),
        );
        self.set_state(ProcessState {
            state: "orphaned",
            since,
            reason: None,
        });
        lifecycle::arm_grace(relock(&self.events).clone(), generation, self.timings.grace);
    }

    /// An adoption made connection `id` the lifeline (`orphan-watch.ts` `watchConnection`).
    fn attach_lifeline(&self, id: u64) {
        let was_orphaned = {
            let mut l = relock(&self.lifeline);
            l.connection = Some(id);
            l.generation += 1;
            l.orphaned_since.take().is_some()
        };
        if was_orphaned && !self.is_stopping() {
            log("info", "lifeline re-attached", Value::Null);
            self.set_state(ProcessState::now("ready"));
        }
    }

    /// Whether the orphan grace of `generation` still applies.
    pub fn grace_applies(&self, generation: u64) -> bool {
        let l = relock(&self.lifeline);
        l.generation == generation && l.orphaned_since.is_some()
    }

    /// Stops accepting and ends every client connection: queued replies are flushed, then the connection is closed; one
    /// still open after `grace` is destroyed.
    pub fn close_connections(&self, grace: Duration) {
        self.accepting.store(false, Ordering::SeqCst);
        for conn in self.connections() {
            conn.end(grace);
        }
    }

    fn patch_status(&self, status: &mut Value) {
        if status.is_object() {
            status["process"] = self.state().to_json();
            status["pid"] = Value::from(self.pid);
            status["instanceId"] = Value::from(self.instance.clone());
            status["uptimeMs"] =
                Value::from(u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX));
        }
    }
}

/// The accept loop: one thread per connection until the front door stops accepting.
pub fn accept_loop(front: &Arc<FrontDoor>, listener: &Listener) {
    let mut failures = 0u32;
    while front.accepting.load(Ordering::SeqCst) {
        let accepted = match listener.accept_timeout(Duration::from_millis(25)) {
            Ok(Some(a)) => {
                failures = 0;
                a
            }
            Ok(None) => continue,
            Err(e) => {
                failures = failures.saturating_add(1);
                if failures == 1 || failures.is_multiple_of(100) {
                    log(
                        "warn",
                        "accept failed",
                        json!({"err": e.to_string(), "consecutive": failures}),
                    );
                }
                std::thread::sleep(Duration::from_millis(50).saturating_mul(failures.min(20)));
                continue;
            }
        };
        if front.live.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            front.live.fetch_sub(1, Ordering::SeqCst);
            log(
                "warn",
                "connection limit reached, closing a new connection",
                Value::Null,
            );
            (accepted.closer)();
            continue;
        }
        let f = front.clone();
        let spawned = std::thread::Builder::new()
            .name("core-conn".into())
            .stack_size(THREAD_STACK)
            .spawn(move || {
                serve_connection(&f, accepted);
                f.live.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            front.live.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// A client's outgoing bytes: a queue drained by its own writer thread, so a slow client never blocks the link that
/// feeds it. More than [`MAX_PENDING_BYTES`] queued disconnects the client (ADR-012 §3, `MAX_PENDING_BYTES`).
struct Outbox {
    inner: Mutex<OutState>,
    ready: Condvar,
}

#[derive(Default)]
struct OutState {
    queue: VecDeque<Vec<u8>>,
    pending: usize,
    ending: bool,
    dead: bool,
}

impl Outbox {
    fn new() -> Self {
        Outbox {
            inner: Mutex::new(OutState::default()),
            ready: Condvar::new(),
        }
    }

    /// Queues `bytes`; `false` when the client is gone or has just been disconnected for not reading.
    fn push(&self, bytes: Vec<u8>) -> bool {
        let mut st = relock(&self.inner);
        if st.dead || st.ending {
            return false;
        }
        st.pending += bytes.len();
        st.queue.push_back(bytes);
        let over = st.pending > MAX_PENDING_BYTES;
        if over {
            st.dead = true;
        }
        drop(st);
        self.ready.notify_all();
        !over
    }
}

/// One client connection.
pub struct Conn {
    id: u64,
    out: Arc<Outbox>,
    closer: Arc<dyn Fn() + Send + Sync>,
    state: Mutex<ConnState>,
}

#[derive(Default)]
struct ConnState {
    authed: bool,
    caller: Option<Caller>,
    /// An API connection's handshake delegation: every later request must carry the same principal and transport.
    api: Option<ApiBinding>,
    /// An engine connection's `engine.token`, verified again before every native call (module-api's rule).
    engine_token: Option<Secret>,
    link: Option<Arc<Link>>,
    subs: Vec<Sub>,
    intercepts: HashMap<String, Intercept>,
    closing: bool,
}

/// What an API handshake bound to its connection (module-api's `c.api` and `c.apiTransport`).
#[derive(Clone, Debug, PartialEq)]
struct ApiBinding {
    /// The delegation's `principal`, `null` without one.
    principal: Value,
    transport: Option<String>,
}

/// A relayed request whose answer the front door completes.
enum Intercept {
    Auth {
        id: Value,
        caller: Caller,
        api: Option<ApiBinding>,
        engine_token: Option<Secret>,
        done: Sender<bool>,
    },
    Status {
        id: Value,
    },
    Adopt {
        id: Value,
        nonce: String,
    },
    Shutdown {
        id: Value,
        budget: Option<u64>,
    },
    Subscribe {
        id: Value,
        params: Value,
    },
    Unsubscribe {
        id: Value,
        sub: String,
    },
}

impl Conn {
    fn caller(&self) -> Option<Caller> {
        relock(&self.state).caller
    }

    fn authed(&self) -> bool {
        relock(&self.state).authed
    }

    fn send(&self, value: &Value) {
        if !self.out.push(frame::encode(value)) && relock(&self.out.inner).dead {
            self.disconnect_slow();
        }
    }

    fn send_raw(&self, mut bytes: Vec<u8>) {
        bytes.push(b'\n');
        if !self.out.push(bytes) && relock(&self.out.inner).dead {
            self.disconnect_slow();
        }
    }

    fn disconnect_slow(&self) {
        let first = {
            let mut st = relock(&self.state);
            !std::mem::replace(&mut st.closing, true)
        };
        if first {
            log(
                "warn",
                "client not reading, disconnecting",
                json!({"connectionId": self.id}),
            );
        }
        (self.closer)();
    }

    #[allow(clippy::needless_pass_by_value)] // every caller builds the error in place
    fn error(&self, id: &Value, e: RpcErr) {
        self.send(&e.frame(id));
    }

    /// The legacy core cannot be reached for this connection (it is stopping or gone): the connection ends without a
    /// reply, which is what a client of a TypeScript core that goes away sees (module-api's `closed`, the CLI's
    /// unavailable core). Callers treat that like an unreachable core (a capture is journaled, a recall degrades, the
    /// API admits its import maintenance fallback); a refusal from the front door would read as an answer instead.
    fn legacy_gone(&self) {
        if relock(&self.state).closing {
            return;
        }
        self.end(Duration::from_secs(1));
    }

    /// `replyAndClose`: the error, then the connection ends (destroyed after a second if the peer does not close).
    fn reply_and_close(&self, id: &Value, e: RpcErr) {
        if relock(&self.state).closing {
            return;
        }
        self.error(id, e);
        self.end(Duration::from_secs(1));
    }

    /// Ends the connection after its queued bytes are written; destroys it after `grace`.
    fn end(&self, grace: Duration) {
        let link = {
            let mut st = relock(&self.state);
            st.closing = true;
            st.link.clone()
        };
        if let Some(link) = link {
            link.close();
        }
        {
            let mut out = relock(&self.out.inner);
            out.ending = true;
        }
        self.out.ready.notify_all();
        let closer = self.closer.clone();
        let _ = std::thread::Builder::new()
            .name("core-conn-grace".into())
            .stack_size(64 * 1024)
            .spawn(move || {
                std::thread::sleep(grace);
                closer();
            });
    }
}

fn refusal(r: Refusal) -> RpcErr {
    RpcErr::new(r.code, r.message, r.reason)
}

fn serve_connection(front: &Arc<FrontDoor>, accepted: Accepted) {
    let Accepted {
        reader,
        writer,
        closer,
        drain,
        read_timeout,
        ..
    } = accepted;
    let id = front.next_conn.fetch_add(1, Ordering::Relaxed);
    let conn = Arc::new(Conn {
        id,
        out: Arc::new(Outbox::new()),
        closer: closer.clone(),
        state: Mutex::new(ConnState::default()),
    });
    relock(&front.conns).insert(id, conn.clone());
    let out = conn.out.clone();
    let writer_closer = closer.clone();
    let writer_thread = std::thread::Builder::new()
        .name("core-conn-out".into())
        .stack_size(THREAD_STACK)
        .spawn(move || write_loop(&out, writer, drain, &*writer_closer));
    if writer_thread.is_err() {
        closer();
        relock(&front.conns).remove(&id);
        return;
    }
    let deadline = Instant::now() + AUTH_IDLE;
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    let mut timed = true;
    loop {
        if conn.authed() {
            if timed {
                let _ = read_timeout(None);
                timed = false;
            }
        } else {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || read_timeout(Some(left)).is_err() {
                break;
            }
        }
        match frame::read_line(&mut reader) {
            Ok(Line::Data(bytes)) => handle_line(front, &conn, bytes),
            Ok(Line::TooLong(n)) => {
                conn.reply_and_close(&Value::Null, frame::line_too_long(n));
                break;
            }
            Ok(Line::Eof) | Err(_) => break,
        }
        if relock(&conn.state).closing {
            break;
        }
    }
    // Flush what is queued, close the link, and destroy the connection after a second if the writer is stuck.
    conn.end(Duration::from_secs(1));
    relock(&front.conns).remove(&id);
    front.connection_lost(id);
    if let Ok(t) = writer_thread {
        let _ = t.join();
    }
}

fn write_loop(
    out: &Outbox,
    mut writer: Box<dyn Write + Send>,
    mut drain: Box<dyn FnMut() + Send>,
    closer: &(dyn Fn() + Send + Sync),
) {
    loop {
        let next = {
            let mut st = relock(&out.inner);
            loop {
                if st.dead {
                    break None;
                }
                if let Some(bytes) = st.queue.pop_front() {
                    st.pending -= bytes.len();
                    break Some(bytes);
                }
                if st.ending {
                    break None;
                }
                st = out.ready.wait(st).unwrap_or_else(|p| p.into_inner());
            }
        };
        match next {
            Some(bytes) => {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    relock(&out.inner).dead = true;
                    break;
                }
            }
            None => break,
        }
    }
    drain();
    closer();
}

fn handle_line(front: &Arc<FrontDoor>, conn: &Arc<Conn>, bytes: Vec<u8>) {
    let parsed = parse_line(&bytes);
    let authed = conn.authed();
    match parsed {
        Ok(msg) if authed => post_auth(front, conn, bytes, msg),
        Ok(msg) => pre_auth(front, conn, msg),
        // After the handshake an unparsable line goes to the legacy core, which answers it as the TypeScript core does;
        // before it, the front door answers (a lone surrogate escape lands here, P4D-3).
        Err(_) if authed && conn.caller() != Some(Caller::LegacyCore) => relay_raw(conn, bytes),
        Err(_) => conn.error(&Value::Null, frame::parse_error()),
    }
}

/// A line as the TypeScript server reads it: invalid UTF-8 is replaced by U+FFFD before `JSON.parse` (its decoder does
/// the same), so such a line is answered like any other. A relayed line still goes on as the client wrote it.
fn parse_line(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    match std::str::from_utf8(bytes) {
        Ok(text) => serde_json::from_str(text),
        Err(_) => serde_json::from_str(&String::from_utf8_lossy(bytes)),
    }
}

/// module-api's `dispatch` up to the handshake: the API delegation, `validateRequest`, `core.auth`, `auth-required`.
fn pre_auth(front: &Arc<FrontDoor>, conn: &Arc<Conn>, mut msg: Value) {
    let id = frame::id_of(&msg);
    let is_auth = msg.get("method").and_then(Value::as_str) == Some("core.auth");
    let auth_delegation = is_auth
        .then(|| {
            msg.get("params")
                .and_then(Value::as_object)
                .and_then(|p| p.get("api"))
                .cloned()
        })
        .flatten();
    let top_api = msg.get("api").cloned();
    let has_api = msg.is_object() && (top_api.is_some() || auth_delegation.is_some());
    if has_api {
        let delegation = top_api
            .clone()
            .filter(|v| !v.is_null())
            .or(auth_delegation)
            .unwrap_or(Value::Null);
        if let Err(r) = auth::verify_api_delegation(&delegation, &front.api_token) {
            return conn.error(&id, refusal(r));
        }
        if let Some(map) = msg.as_object_mut() {
            map.remove("api");
        }
    }
    let found = findings(&front.checks.request, &msg);
    if !found.is_empty() {
        return conn.error(
            &id,
            RpcErr::new(
                "E_INVALID_PARAMS",
                "invalid request",
                Some("invalid-request"),
            )
            .detail(found.join("; "))
            .jsonrpc(-32600),
        );
    }
    if is_auth {
        return handle_auth(front, conn, &msg, has_api, top_api);
    }
    conn.error(
        &id,
        RpcErr::new(
            "E_UNAUTHORIZED",
            "authenticate first",
            Some("auth-required"),
        ),
    );
}

/// `core.auth`: the front door's own credential checks, then the link.
fn handle_auth(
    front: &Arc<FrontDoor>,
    conn: &Arc<Conn>,
    msg: &Value,
    has_api: bool,
    top_api: Option<Value>,
) {
    let id = frame::id_of(msg);
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let (authed, current) = {
        let st = relock(&conn.state);
        (st.authed, st.caller)
    };
    if current == Some(Caller::Client) {
        return conn.reply_and_close(
            &id,
            RpcErr::new("E_DENIED", "scoped identity cannot change", None),
        );
    }
    let found = findings(&front.checks.auth_params, &without_meta(&params));
    if !found.is_empty() {
        return conn.reply_and_close(
            &id,
            RpcErr::new("E_INVALID_PARAMS", "invalid params", None).detail(found.join("; ")),
        );
    }
    let Some(p) = params.as_object() else {
        return conn.reply_and_close(&id, RpcErr::new("E_INVALID_PARAMS", "invalid params", None));
    };
    // A link credential never comes from a client: only the front door presents one, and only to the legacy core.
    if p.contains_key("frontDoor") {
        return conn.reply_and_close(
            &id,
            RpcErr::new(
                "E_UNAUTHORIZED",
                "front door link refused",
                Some("front-door-link"),
            ),
        );
    }
    let has_engine = p.contains_key("engine");
    if authed && (current == Some(Caller::Engine)) != has_engine {
        return conn.reply_and_close(
            &id,
            RpcErr::new(
                "E_DENIED",
                "connection identity cannot change",
                Some("engine-identity-change"),
            ),
        );
    }
    let token = p.get("token").and_then(Value::as_str).unwrap_or("");
    let caller = if has_engine {
        if has_api || current == Some(Caller::Api) {
            return conn.reply_and_close(
                &id,
                RpcErr::new(
                    "E_DENIED",
                    "engine credentials cannot delegate",
                    Some("engine-delegation"),
                ),
            );
        }
        let engine_token = run_files::read_token(&front.files.engine_token)
            .ok()
            .flatten();
        if let Err(r) = auth::verify_engine(p, engine_token.as_ref()) {
            return conn.reply_and_close(&id, refusal(r));
        }
        Caller::Engine
    } else if front.core_token.matches(token) {
        if has_api {
            Caller::Api
        } else {
            Caller::Owner
        }
    } else if !has_api && front.link_token.matches(token) {
        Caller::LegacyCore
    } else if has_api {
        return conn.reply_and_close(
            &id,
            RpcErr::new("E_UNAUTHORIZED", "bad token", Some("bad-token")),
        );
    } else {
        Caller::Client
    };
    if caller == Caller::LegacyCore || current == Some(Caller::LegacyCore) {
        if caller != Caller::LegacyCore || (authed && current != Some(Caller::LegacyCore)) {
            return conn.reply_and_close(&id, bridge_principal());
        }
        {
            let mut st = relock(&conn.state);
            st.authed = true;
            st.caller = Some(Caller::LegacyCore);
        }
        return conn.send(&json!({"jsonrpc":"2.0","id":id,"result":{
            "contract": front.legacy_contract, "rpc": plur1bus_rpc::RPC_VERSION, "instanceId": front.instance,
            "pid": front.pid, "capabilities": plur1bus_rpc::capabilities("bridge", &[]),
        }}));
    }
    let Some(link) = link_of(front, conn) else {
        return conn.legacy_gone();
    };
    // What the handshake binds to the connection for the native calls after it (module-api's `c.api`, `c.engineToken`).
    let api = (caller == Caller::Api).then(|| {
        let delegation = top_api
            .clone()
            .filter(|v| !v.is_null())
            .or_else(|| p.get("api").cloned())
            .unwrap_or(Value::Null);
        ApiBinding {
            principal: delegation.get("principal").cloned().unwrap_or(Value::Null),
            transport: delegation
                .get("transport")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    });
    let engine_token = (caller == Caller::Engine)
        .then(|| p.get("engine").and_then(|e| e.get("token")))
        .flatten()
        .and_then(Value::as_str)
        .map(|t| Secret::new(t.to_owned()));
    let link_id = link.next_id();
    let mut forwarded = p.clone();
    forwarded.insert(
        "frontDoor".into(),
        json!({"token": front.link_token.expose(), "caller": caller.as_str()}),
    );
    let mut request = Map::new();
    request.insert("jsonrpc".into(), Value::from("2.0"));
    request.insert("id".into(), Value::from(link_id.clone()));
    request.insert("method".into(), Value::from("core.auth"));
    request.insert("params".into(), Value::Object(forwarded));
    if let Some(api) = top_api {
        request.insert("api".into(), api);
    }
    let (done, finished) = mpsc::channel();
    relock(&conn.state).intercepts.insert(
        link_id,
        Intercept::Auth {
            id: id.clone(),
            caller,
            api,
            engine_token,
            done,
        },
    );
    if link.send(&frame::encode(&Value::Object(request))).is_err() {
        return conn.legacy_gone();
    }
    // The next request of this client waits for the handshake, as the TypeScript server serves a pipelined request
    // after an owner's synchronous handshake.
    if finished.recv_timeout(LINK_AUTH_TIMEOUT).is_err() {
        conn.legacy_gone();
    }
}

fn bridge_principal() -> RpcErr {
    RpcErr::new(
        "E_DENIED",
        "bridge methods are for the legacy core only",
        Some("bridge-principal"),
    )
}

/// The client's link, opened (and its reader started) on first use.
fn link_of(front: &Arc<FrontDoor>, conn: &Arc<Conn>) -> Option<Arc<Link>> {
    if let Some(link) = relock(&conn.state).link.clone() {
        return Some(link);
    }
    let (link, reader) = match Link::connect(&front.files.legacy_address, front.legacy_pid) {
        Ok(pair) => pair,
        Err(e) => {
            log(
                "warn",
                "cannot open a link to the legacy core",
                json!({"err": e.to_string(), "connectionId": conn.id}),
            );
            return None;
        }
    };
    let link = Arc::new(link);
    relock(&conn.state).link = Some(link.clone());
    let (f, c, l) = (front.clone(), conn.clone(), link.clone());
    let spawned = std::thread::Builder::new()
        .name("core-link".into())
        .stack_size(THREAD_STACK)
        .spawn(move || link_loop(&f, &c, &l, reader));
    if spawned.is_err() {
        link.close();
        return None;
    }
    Some(link)
}

/// Everything after the handshake.
fn post_auth(front: &Arc<FrontDoor>, conn: &Arc<Conn>, bytes: Vec<u8>, msg: Value) {
    let id = frame::id_of(&msg);
    let method = msg
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let caller = conn.caller();
    if caller == Some(Caller::LegacyCore) {
        return bridge_call(front, conn, &id, &method, &msg);
    }
    let route = route::route(&method);
    match route {
        Route::Bridge => return conn.error(&id, bridge_principal()),
        Route::Native => return native(front, conn, &id, &method, msg),
        Route::Complete(_) | Route::Relay => {}
    }
    // An API connection's every request carries its delegation: the front door checks it before relaying it.
    if caller == Some(Caller::Api) {
        if let Some(delegation) = msg.get("api").filter(|v| !v.is_null()) {
            if let Err(r) = auth::verify_api_delegation(delegation, &front.api_token) {
                return conn.error(&id, refusal(r));
            }
        }
    }
    let Route::Complete(kind) = route else {
        return relay_raw(conn, bytes);
    };
    if kind == Kind::Auth {
        let auth_delegation = msg
            .get("params")
            .and_then(Value::as_object)
            .and_then(|p| p.get("api"))
            .cloned();
        let top_api = msg.get("api").cloned();
        let has_api = top_api.is_some() || auth_delegation.is_some();
        let mut stripped = msg.clone();
        if let Some(map) = stripped.as_object_mut() {
            map.remove("api");
        }
        if has_api {
            let delegation = top_api
                .clone()
                .filter(|v| !v.is_null())
                .or(auth_delegation)
                .unwrap_or(Value::Null);
            if let Err(r) = auth::verify_api_delegation(&delegation, &front.api_token) {
                return conn.error(&id, refusal(r));
            }
        }
        return handle_auth(front, conn, &stripped, has_api, top_api);
    }
    let intercept = match kind {
        Kind::Auth => None, // handled above
        Kind::Status => Some(Intercept::Status { id: id.clone() }),
        Kind::Adopt => {
            if front.is_stopping() {
                return conn.error(
                    &id,
                    RpcErr::new("E_NOT_AVAILABLE", "core is stopping", Some("stopping")),
                );
            }
            let nonce = msg
                .pointer("/params/nonce")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            Some(Intercept::Adopt {
                id: id.clone(),
                nonce,
            })
        }
        Kind::Shutdown => Some(Intercept::Shutdown {
            id: id.clone(),
            budget: msg.pointer("/params/budgetMs").and_then(Value::as_u64),
        }),
        Kind::Subscribe => Some(Intercept::Subscribe {
            id: id.clone(),
            params: msg.get("params").cloned().unwrap_or_else(|| json!({})),
        }),
        Kind::Unsubscribe => Some(Intercept::Unsubscribe {
            id: id.clone(),
            sub: msg
                .pointer("/params/subscriptionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        }),
    };
    // A request without a usable id is relayed as written: the legacy core answers it (invalid request).
    let intercept = intercept.filter(|_| !id.is_null());
    let Some(intercept) = intercept else {
        return relay_raw(conn, bytes);
    };
    let link = relock(&conn.state).link.clone();
    let Some(link) = link else {
        return conn.legacy_gone();
    };
    let link_id = link.next_id();
    let mut rewritten = msg;
    rewritten["id"] = Value::from(link_id.clone());
    relock(&conn.state).intercepts.insert(link_id, intercept);
    if link.send(&frame::encode(&rewritten)).is_err() {
        conn.legacy_gone();
    }
}

/// A method the front door serves itself (`route::NATIVE`), after module-api's admission in its `dispatch` order: a scoped
/// client cannot delegate; a delegation on the request is verified, an API connection must carry one, and its principal
/// and transport must be the handshake's; the request shape; an engine connection's token is verified again and it may
/// call `host.*` only; a delegation needs an API handshake; a scoped client has no `events.*`. The method then decides on
/// RBAC and a scoped client's per-call authorization from its [`route::CallContext`]. It is never relayed: a native
/// method that answers `NotServed` is a route-table drift (`E_INTERNAL`, reason `route-table-drift`).
fn native(front: &Arc<FrontDoor>, conn: &Arc<Conn>, id: &Value, method: &str, mut msg: Value) {
    let caller = conn.caller().unwrap_or(Caller::Client);
    let has_api = msg.get("api").is_some();
    if caller == Caller::Client && (has_api || msg.pointer("/params/api").is_some()) {
        return conn.error(
            id,
            RpcErr::new("E_DENIED", "scoped clients cannot delegate", None),
        );
    }
    let mut api_principal = None;
    if has_api {
        let delegation = msg
            .as_object_mut()
            .and_then(|m| m.remove("api"))
            .unwrap_or(Value::Null);
        let transport = match auth::verify_api_delegation(&delegation, &front.api_token) {
            Ok(transport) => transport,
            Err(r) => return conn.error(id, refusal(r)),
        };
        let principal = delegation.get("principal").cloned().unwrap_or(Value::Null);
        let bound = relock(&conn.state).api.clone();
        if let Some(bound) = bound {
            let same = |key: &str| bound.principal.get(key) == principal.get(key);
            if !same("userId") || !same("kind") {
                return conn.error(
                    id,
                    RpcErr::new(
                        "E_UNAUTHORIZED",
                        "API connection identity cannot change",
                        Some("api-identity-change"),
                    ),
                );
            }
            if bound.transport != transport {
                return conn.error(
                    id,
                    RpcErr::new(
                        "E_UNAUTHORIZED",
                        "API transport cannot change",
                        Some("api-transport-change"),
                    ),
                );
            }
        }
        api_principal = Some(principal);
    } else if caller == Caller::Api {
        return conn.error(
            id,
            RpcErr::new(
                "E_UNAUTHORIZED",
                "API principal required",
                Some("api-principal-required"),
            ),
        );
    }
    let found = findings(&front.checks.request, &msg);
    if !found.is_empty() {
        return conn.error(
            id,
            RpcErr::new(
                "E_INVALID_PARAMS",
                "invalid request",
                Some("invalid-request"),
            )
            .detail(found.join("; "))
            .jsonrpc(-32600),
        );
    }
    if caller == Caller::Engine {
        let current = run_files::read_token(&front.files.engine_token)
            .ok()
            .flatten();
        let still = {
            let st = relock(&conn.state);
            match (st.engine_token.as_ref(), current.as_ref()) {
                (Some(held), Some(current)) => {
                    auth::is_hex64(current.expose()) && current.matches(held.expose())
                }
                _ => false,
            }
        };
        if !still {
            return conn.error(id, refusal(auth::ENGINE_DELEGATION));
        }
        if !method.starts_with("host.")
            && !["events.subscribe", "events.unsubscribe"].contains(&method)
        {
            return conn.error(
                id,
                RpcErr::new(
                    "E_DENIED",
                    "engine connection cannot call this method",
                    Some("engine-method"),
                ),
            );
        }
    }
    if has_api && caller != Caller::Api {
        return conn.error(
            id,
            RpcErr::new(
                "E_UNAUTHORIZED",
                "delegate at handshake",
                Some("api-handshake-required"),
            ),
        );
    }
    if caller == Caller::Client && method.starts_with("events.") {
        return conn.error(
            id,
            RpcErr::new(
                "E_DENIED",
                "scoped client subscriptions are unavailable",
                None,
            ),
        );
    }
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let cx = route::CallContext {
        caller,
        api_principal,
    };
    match route::serve(&cx, method, params) {
        Ok(result) => conn.send(&json!({"jsonrpc":"2.0","id":id,"result":result})),
        Err(error) => conn.send(&json!({"jsonrpc":"2.0","id":id,"error":error})),
    }
}

/// Relays a client line to its link unchanged.
fn relay_raw(conn: &Arc<Conn>, mut bytes: Vec<u8>) {
    let link = relock(&conn.state).link.clone();
    match link {
        Some(link) => {
            bytes.push(b'\n');
            if link.send(&bytes).is_err() {
                conn.legacy_gone();
            }
        }
        None => conn.legacy_gone(),
    }
}

/// The legacy core's bridge connection: `bridge.*` only, served here.
fn bridge_call(front: &Arc<FrontDoor>, conn: &Arc<Conn>, id: &Value, method: &str, msg: &Value) {
    match method {
        "bridge.hello" => {
            let params = without_meta(msg.get("params").unwrap_or(&json!({})));
            let found = findings(&front.checks.hello_params, &params);
            if !found.is_empty() {
                return conn.error(
                    id,
                    RpcErr::new("E_INVALID_PARAMS", "invalid params", None)
                        .detail(found.join("; ")),
                );
            }
            let result = json!({"rpc": plur1bus_rpc::RPC_VERSION, "instanceId": front.instance, "pid": front.pid});
            if !findings(&front.checks.hello_result, &result).is_empty() {
                return conn.error(
                    id,
                    RpcErr::new(
                        "E_INTERNAL",
                        "result violates schema",
                        Some("result-schema"),
                    ),
                );
            }
            conn.send(&json!({"jsonrpc":"2.0","id":id,"result":result}));
        }
        "core.auth" => handle_auth(front, conn, msg, false, None),
        _ => conn.error(id, bridge_principal()),
    }
}

/// Reads the legacy core's answers and notifications for one client.
fn link_loop(front: &Arc<FrontDoor>, conn: &Arc<Conn>, link: &Arc<Link>, reader: Box<dyn Stream>) {
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    while let Ok(Line::Data(bytes)) = frame::read_line(&mut reader) {
        let Ok(mut msg) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        let own = msg
            .get("id")
            .and_then(Value::as_str)
            .filter(|i| link.owns(i))
            .map(str::to_owned);
        if let Some(own) = own {
            let taken = relock(&conn.state).intercepts.remove(&own);
            if let Some(intercept) = taken {
                complete(front, conn, intercept, &mut msg);
            }
            continue;
        }
        let notification = msg.get("method").is_some() && msg.get("id").is_none();
        if notification
            && msg.get("method").and_then(Value::as_str) == Some("core.state")
            && conn.caller() == Some(Caller::Owner)
        {
            continue; // the front door's own process state is what an owner subscriber sees
        }
        conn.send_raw(bytes);
    }
    // The link is gone: so is this client's connection to the core.
    let pending: Vec<Intercept> = {
        let mut st = relock(&conn.state);
        st.intercepts.drain().map(|(_, v)| v).collect()
    };
    for intercept in pending {
        if let Intercept::Auth { done, .. } = intercept {
            let _ = done.send(false);
        }
    }
    if !relock(&conn.state).closing {
        conn.end(Duration::from_secs(1));
    }
}

/// Completes an intercepted request with the legacy core's answer and sends it with the client's own id.
fn complete(front: &Arc<FrontDoor>, conn: &Arc<Conn>, intercept: Intercept, msg: &mut Value) {
    let ok = msg.get("result").is_some();
    match intercept {
        Intercept::Auth {
            id,
            caller,
            api,
            engine_token,
            done,
        } => {
            msg["id"] = id;
            if ok {
                let result = &mut msg["result"];
                result["instanceId"] = Value::from(front.instance.clone());
                result["pid"] = Value::from(front.pid);
                let features: Vec<String> = result
                    .pointer("/capabilities/features")
                    .and_then(Value::as_array)
                    .map(|f| {
                        f.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                if result.get("capabilities").is_some() {
                    let refs: Vec<&str> = features.iter().map(String::as_str).collect();
                    // The union of the methods served natively and the relayed ones: every `x-server: "core"` method.
                    result["capabilities"] = plur1bus_rpc::capabilities("core", &refs);
                }
                let mut st = relock(&conn.state);
                st.authed = true;
                st.caller = Some(caller);
                st.api = api;
                st.engine_token = engine_token;
            }
            conn.send(msg);
            let _ = done.send(ok);
        }
        Intercept::Status { id } => {
            msg["id"] = id;
            if ok {
                front.patch_status(&mut msg["result"]);
                if !findings(&front.checks.status_result, &msg["result"]).is_empty() {
                    let id = msg["id"].clone();
                    return conn.error(
                        &id,
                        RpcErr::new(
                            "E_INTERNAL",
                            "result violates schema",
                            Some("result-schema"),
                        ),
                    );
                }
            }
            conn.send(msg);
        }
        Intercept::Adopt { id, nonce } => {
            msg["id"] = id.clone();
            if ok {
                let supervisor = run_files::read_token(&front.files.supervisor_token)
                    .ok()
                    .flatten();
                if !auth::adoption_nonce_matches(supervisor.as_ref(), &nonce) {
                    log("warn", "adoption refused", json!({"connectionId": conn.id}));
                    return conn.error(
                        &id,
                        RpcErr::new("E_UNAUTHORIZED", "adoption refused", Some("adopt-nonce")),
                    );
                }
                front.attach_lifeline(conn.id);
                log("info", "adopted", json!({"connectionId": conn.id}));
                front.patch_status(&mut msg["result"]["status"]);
                if !findings(&front.checks.adopt_result, &msg["result"]).is_empty() {
                    return conn.error(
                        &id,
                        RpcErr::new(
                            "E_INTERNAL",
                            "result violates schema",
                            Some("result-schema"),
                        ),
                    );
                }
            }
            conn.send(msg);
        }
        Intercept::Shutdown { id, budget } => {
            msg["id"] = id;
            let accepted = msg.pointer("/result/accepted") == Some(&Value::Bool(true));
            conn.send(msg);
            if accepted {
                let budget = budget.map_or(front.timings.shutdown_budget, Duration::from_millis);
                front.request_stop(budget, "core.shutdown");
            }
        }
        Intercept::Subscribe { id, params } => {
            msg["id"] = id;
            if ok && conn.caller() == Some(Caller::Owner) {
                if let Some(sub) = Sub::from_call(&params, &msg["result"]) {
                    relock(&conn.state).subs.push(sub);
                }
            }
            conn.send(msg);
        }
        Intercept::Unsubscribe { id, sub } => {
            msg["id"] = id;
            if msg.pointer("/result/removed") == Some(&Value::Bool(true)) {
                relock(&conn.state).subs.retain(|s| s.id != sub);
            }
            conn.send(msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outbox_disconnects_a_client_that_lets_16_mib_pile_up() {
        let out = Outbox::new();
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..16 {
            assert!(out.push(chunk.clone()));
        }
        assert!(!out.push(vec![b'y']), "the byte past 16 MiB disconnects");
        assert!(relock(&out.inner).dead);
        assert!(!out.push(vec![b'z']), "nothing is queued for a dead client");
    }

    #[test]
    fn the_validators_the_front_door_runs_compile_from_the_schema() {
        let checks = Checks::new().unwrap();
        assert!(findings(
            &checks.request,
            &json!({"jsonrpc":"2.0","id":1,"method":"x","params":{}})
        )
        .is_empty());
        assert!(
            !findings(
                &checks.request,
                &json!({"jsonrpc":"2.0","id":1,"method":"x","principal":"owner"})
            )
            .is_empty(),
            "a request is closed: no identity field rides on it"
        );
        assert!(findings(&checks.hello_params, &json!({})).is_empty());
        assert!(!findings(&checks.hello_params, &json!({"x":1})).is_empty());
    }
}
