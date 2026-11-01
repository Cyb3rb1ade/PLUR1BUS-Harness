//! Authenticated, bounded NDJSON engine server and the process lifecycle it owns.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use plur1bus_rpc::server_transport::{Accepted, Listener};
use serde_json::{json, Value};

use super::layout::EngineLayout;
use super::lifeline::{Lifeline, Watch};
use super::methods::{self, WireError};
use crate::contract::{AgentId, AgentStoreHandle, Cancel, CaptureHandle, CaptureResult, Engine};

const TICK: Duration = Duration::from_millis(25);
const MAX_CONNECTIONS: usize = 64;
const MAX_IN_FLIGHT: usize = 8;
const MAX_CAPTURES: usize = 4096;
const CAPTURE_RETENTION: Duration = Duration::from_secs(1800);
const STOP_BUDGET: Duration = Duration::from_secs(30);

/// A bounded server-start or transport failure. A live owner is never terminated here.
#[derive(Debug)]
pub enum ServeError {
    /// Another engine owns this home's nonce lock or endpoint.
    Locked,
    /// Local setup or transport failed.
    Io(io::Error),
    /// The checked-in wire schema could not be compiled.
    Schema,
}
impl From<io::Error> for ServeError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl fmt::Display for ServeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Locked => "another engine owns this home",
            Self::Io(_) => "engine local transport failed",
            Self::Schema => "invalid embedded RPC schema",
        })
    }
}
impl std::error::Error for ServeError {}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

struct Capture {
    completed: Mutex<Option<(Result<CaptureResult, WireError>, Instant)>>,
    changed: Condvar,
    abort: Box<dyn Fn(Option<String>) + Send + Sync>,
}

struct Connection {
    id: u64,
    writer: Mutex<Box<dyn Write + Send>>,
    closer: Arc<dyn Fn() + Send + Sync>,
    cancel: Cancel,
    authenticated: AtomicBool,
    agents: Mutex<HashMap<String, Vec<AgentStoreHandle>>>,
}

impl Connection {
    fn send(&self, value: &Value) -> io::Result<()> {
        let mut writer = lock(&self.writer);
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() > plur1bus_rpc::client::MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "engine frame exceeds limit",
            ));
        }
        writer.write_all(&bytes)?;
        writer.write_all(b"\n")?;
        writer.flush()
    }
    fn reply(&self, id: Value, result: Result<Value, WireError>) {
        let mut response = match result {
            Ok(result) => json!({"jsonrpc":"2.0","result":result}),
            Err(error) => {
                let mut data = json!({"error":error.error,"reason":error.reason});
                if let Some(ids) = error.ids {
                    data["ids"] = json!(ids);
                }
                json!({"jsonrpc":"2.0","error":{"code":error.code,"message":error.message,"data":data}})
            }
        };
        response["id"] = id;
        if self.send(&response).is_err() {
            (self.closer)();
        }
    }
    fn close(&self) {
        self.cancel.cancel();
        (self.closer)();
        for handles in lock(&self.agents).drain().map(|(_, v)| v) {
            for handle in handles {
                let _ = (handle.close)();
            }
        }
    }
}

struct Shared {
    engine: Arc<dyn Engine>,
    home: std::path::PathBuf,
    token: String,
    instance: String,
    stopping: AtomicBool,
    stop_budget: Mutex<Duration>,
    watch: Mutex<Watch>,
    orphaned_since: AtomicU64,
    requests: AtomicU64,
    auth_failures: AtomicU64,
    scheduler_lag_us: AtomicU64,
    connections: Mutex<HashMap<u64, Weak<Connection>>>,
    captures: Mutex<HashMap<String, Arc<Capture>>>,
    capture_workers: Mutex<Vec<JoinHandle<()>>>,
    validators: Validation,
}

impl Shared {
    fn status(&self) -> Value {
        let mut status = serde_json::to_value(self.engine.status()).unwrap_or(Value::Null);
        let since = self.orphaned_since.load(Ordering::Acquire);
        status["rpc"] = json!(plur1bus_rpc::RPC_VERSION);
        status["pid"] = json!(std::process::id());
        status["instanceId"] = json!(self.instance);
        status["process"] = json!({"state":if self.stopping.load(Ordering::Acquire) {"stopping"} else if since > 0 {"orphaned"} else {"ready"},"orphanedSince":if since == 0 {Value::Null} else {json!(since)}});
        let captures = lock(&self.captures);
        let completed = captures
            .values()
            .filter(|c| lock(&c.completed).is_some())
            .count();
        status["counters"] = json!({"requests":self.requests.load(Ordering::Relaxed),"authFailures":self.auth_failures.load(Ordering::Relaxed),"activeConnections":lock(&self.connections).len(),"capturesPending":captures.len()-completed,"capturesCompleted":completed});
        status["schedulerLagMs"] =
            json!(self.scheduler_lag_us.load(Ordering::Relaxed) as f64 / 1000.0);
        status
    }

    fn capture(
        self: &Arc<Self>,
        connection: &Arc<Connection>,
        params: &Value,
    ) -> Result<Value, WireError> {
        let mut captures = lock(&self.captures);
        captures.retain(|_, c| {
            lock(&c.completed)
                .as_ref()
                .is_none_or(|(_, at)| at.elapsed() < CAPTURE_RETENTION)
        });
        if captures.len() >= MAX_CAPTURES {
            return Err(WireError::not_available());
        }
        let handle = self.engine.capture(
            decode(&params["turn"])?,
            decode(params.get("options").unwrap_or(&json!({})))?,
        )?;
        let CaptureHandle {
            id,
            accepted_at,
            done,
            abort,
        } = handle;
        if captures.contains_key(&id) {
            abort(Some("duplicate-receipt".into()));
            return Err(WireError::internal());
        }
        let entry = Arc::new(Capture {
            completed: Mutex::new(None),
            changed: Condvar::new(),
            abort,
        });
        captures.insert(id.clone(), entry.clone());
        drop(captures);
        let state = self.clone();
        let connection = Arc::downgrade(connection);
        let capture_id = id.clone();
        let worker = thread::spawn(move || {
            let result = loop {
                match done.recv_timeout(TICK) {
                    Ok(value) => break Ok(value),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        break Err(WireError::not_available())
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                        if state.stopping.load(Ordering::Acquire) =>
                    {
                        break Err(WireError::not_available())
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }
            };
            *lock(&entry.completed) = Some((result.clone(), Instant::now()));
            entry.changed.notify_all();
            if let (Ok(result), Some(connection)) = (result, connection.upgrade()) {
                let _ = connection.send(&json!({"jsonrpc":"2.0","method":"engine.capture.done","params":{"id":capture_id,"result":result}}));
            }
        });
        let mut workers = lock(&self.capture_workers);
        reap(&mut workers);
        workers.push(worker);
        Ok(json!({"id":id,"acceptedAt":accepted_at}))
    }

    fn capture_wait(&self, params: &Value, cancel: &Cancel) -> Result<Value, WireError> {
        let entry = lock(&self.captures)
            .get(
                params["id"]
                    .as_str()
                    .ok_or_else(WireError::invalid_params)?,
            )
            .cloned()
            .ok_or_else(WireError::not_available)?;
        let timeout = params["timeoutMs"]
            .as_f64()
            .unwrap_or(30_000.0)
            .clamp(0.0, 120_000.0);
        let deadline = Instant::now() + Duration::from_secs_f64(timeout / 1000.0);
        let mut result = lock(&entry.completed);
        loop {
            if let Some((value, _)) = &*result {
                return value.clone().and_then(encode);
            }
            cancel.check().map_err(crate::contract::EngineError::from)?;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(json!({"pending":true}));
            }
            result = entry
                .changed
                .wait_timeout(result, left.min(TICK))
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }

    fn call(
        self: &Arc<Self>,
        connection: &Arc<Connection>,
        method: &str,
        params: &Value,
    ) -> Result<Value, WireError> {
        match method {
            "engine.status" => Ok(self.status()),
            "engine.shutdown" => Ok(json!({})),
            "engine.adopt" => {
                let path = self.home.join("run/supervisor.token");
                super::host_client::read_identity_file(&path)
                    .map_err(|_| unauthorized("adoption-refused"))
                    .and_then(|nonce| {
                        if token_equal(&params["nonce"], nonce.trim()) {
                            Ok(())
                        } else {
                            Err(unauthorized("adoption-refused"))
                        }
                    })?;
                lock(&self.watch).adopt(connection.id);
                self.orphaned_since.store(0, Ordering::Release);
                Ok(json!({"status":self.status()}))
            }
            "engine.open" => {
                let agent: AgentId = decode(&params["agentId"])?;
                let handle = self.engine.open(&agent)?;
                lock(&connection.agents)
                    .entry(agent.to_string())
                    .or_default()
                    .push(handle);
                Ok(json!({"agentId":agent}))
            }
            "engine.agent.close" => {
                let key = params["agentId"]
                    .as_str()
                    .ok_or_else(WireError::invalid_params)?;
                if let Some(handle) = lock(&connection.agents).get_mut(key).and_then(Vec::pop) {
                    (handle.close)()?;
                }
                Ok(json!({}))
            }
            "engine.capture" => self.capture(connection, params),
            "engine.capture.wait" => self.capture_wait(params, &connection.cancel),
            "engine.capture.abort" => {
                if let Some(capture) = lock(&self.captures).get(
                    params["id"]
                        .as_str()
                        .ok_or_else(WireError::invalid_params)?,
                ) {
                    (capture.abort)(params["reason"].as_str().map(str::to_owned));
                }
                Ok(json!({}))
            }
            _ => methods::dispatch(self.engine.as_ref(), method, params, &connection.cancel),
        }
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, WireError> {
    serde_json::from_value(value.clone()).map_err(|_| WireError::invalid_params())
}
fn encode<T: serde::Serialize>(value: T) -> Result<Value, WireError> {
    serde_json::to_value(value).map_err(|_| WireError::internal())
}
fn unauthorized(reason: &'static str) -> WireError {
    WireError {
        code: -32000,
        error: "E_UNAUTHORIZED",
        reason,
        message: "engine authentication required",
        ids: None,
    }
}

/// Compare the fixed-length hex token without returning on its first differing byte.
fn token_equal(value: &Value, expected: &str) -> bool {
    let Some(received) = value.as_str() else {
        return false;
    };
    if received.len() != 64 || expected.len() != 64 {
        return false;
    }
    received
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |difference, (a, b)| {
            difference | (a.to_ascii_lowercase() ^ b.to_ascii_lowercase())
        })
        == 0
}

struct Validation {
    methods: HashSet<String>,
    schema: jsonschema::Validator,
}

fn validators() -> Result<Validation, ServeError> {
    let mut root: Value = serde_json::from_str(plur1bus_rpc::capabilities::SCHEMA_JSON)
        .map_err(|_| ServeError::Schema)?;
    let methods: HashSet<String> = root["$defs"]["methods"]
        .as_object()
        .ok_or(ServeError::Schema)?
        .iter()
        .filter(|(_, method)| method["x-server"] == "engine")
        .map(|(name, _)| name.clone())
        .collect();
    let branches:Vec<Value> = methods.iter().map(|name| json!({
        "type":"object", "required":["method","params"], "additionalProperties":false,
        "properties":{"method":{"const":name},"params":{"$ref":format!("#/$defs/methods/{name}/params")}}
    })).collect();
    root["oneOf"] = json!(branches);
    let schema = jsonschema::validator_for(&root).map_err(|_| ServeError::Schema)?;
    Ok(Validation { methods, schema })
}

fn reap(workers: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let _ = workers.swap_remove(index).join();
        } else {
            index += 1;
        }
    }
}

fn connection_loop(state: &Arc<Shared>, accepted: Accepted, id: u64) {
    let _ = accepted.set_read_timeout(Some(Duration::from_secs(30)));
    let connection = Arc::new(Connection {
        id,
        writer: Mutex::new(accepted.writer),
        closer: accepted.closer,
        cancel: Cancel::never(),
        authenticated: AtomicBool::new(false),
        agents: Mutex::new(HashMap::new()),
    });
    let read_timeout = accepted.read_timeout;
    let (auth_done, auth_pending) = std::sync::mpsc::channel();
    let auth_closer = connection.closer.clone();
    let auth_watchdog = thread::spawn(move || {
        if auth_pending.recv_timeout(Duration::from_secs(30)).is_err() {
            auth_closer();
        }
    });
    lock(&state.connections).insert(id, Arc::downgrade(&connection));
    let mut drain = accepted.drain;
    let mut reader = BufReader::new(accepted.reader);
    let mut authenticated = false;
    let mut workers = Vec::new();
    loop {
        let mut bytes = Vec::new();
        // take() bounds allocation even when the peer omits its newline.
        let read = reader
            .by_ref()
            .take((plur1bus_rpc::client::MAX_LINE + 2) as u64)
            .read_until(b'\n', &mut bytes);
        if !matches!(read, Ok(n) if n > 0)
            || bytes.len() > plur1bus_rpc::client::MAX_LINE + 1
            || bytes.last() != Some(&b'\n')
        {
            break;
        }
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                connection.reply(Value::Null, Err(WireError::invalid_params()));
                break;
            }
        };
        let request_id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request["method"].as_str().unwrap_or("");
        if request["jsonrpc"] != "2.0" || method.is_empty() {
            connection.reply(request_id, Err(WireError::invalid_params()));
            break;
        }
        // Authentication precedes method lookup, parameter validation, callbacks and all data-dependent work.
        if !authenticated
            && (method != "engine.auth" || !token_equal(&request["params"]["token"], &state.token))
        {
            state.auth_failures.fetch_add(1, Ordering::Relaxed);
            connection.reply(
                request_id,
                Err(unauthorized(if method == "engine.auth" {
                    "bad-token"
                } else {
                    "auth-required"
                })),
            );
            if method == "engine.auth" {
                break;
            }
            continue;
        }
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if !state.validators.methods.contains(method) {
            connection.reply(request_id, Err(WireError::method_not_found()));
            continue;
        };
        if !state
            .validators
            .schema
            .is_valid(&json!({"method":method,"params":params}))
        {
            connection.reply(request_id, Err(WireError::invalid_params()));
            if !authenticated {
                break;
            }
            continue;
        }
        if method == "engine.auth" {
            // Reauthentication can never turn a bad token into an already-authenticated call.
            if !token_equal(&params["token"], &state.token) {
                connection.reply(request_id, Err(unauthorized("bad-token")));
                break;
            }
            authenticated = true;
            let _ = auth_done.send(());
            connection.authenticated.store(true, Ordering::Release);
            if read_timeout(None).is_err() {
                break;
            }
            connection.reply(request_id,Ok(json!({"contract":state.engine.contract(),"rpc":plur1bus_rpc::RPC_VERSION,"instanceId":state.instance,"pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("engine",&[]),"engineCapabilities":state.engine.capabilities()})));
            continue;
        }
        if state.stopping.load(Ordering::Acquire) {
            connection.reply(request_id, Err(WireError::not_available()));
            break;
        }
        state.requests.fetch_add(1, Ordering::Relaxed);
        if method == "engine.shutdown" {
            let ms = params["budgetMs"]
                .as_f64()
                .unwrap_or(30_000.0)
                .clamp(0.0, 120_000.0);
            *lock(&state.stop_budget) = Duration::from_secs_f64(ms / 1000.0);
            // Acknowledge before publishing stop; the accept loop can now close readers safely.
            connection.reply(request_id, Ok(json!({})));
            state.stopping.store(true, Ordering::Release);
            break;
        }
        reap(&mut workers);
        if workers.len() >= MAX_IN_FLIGHT {
            connection.reply(request_id, Err(WireError::not_available()));
            continue;
        }
        let state = state.clone();
        let connection = connection.clone();
        let method = method.to_owned();
        workers.push(thread::spawn(move || {
            let result = state.call(&connection, &method, &params);
            connection.reply(request_id, result);
        }));
    }
    drop(auth_done);
    let _ = auth_watchdog.join();
    drain();
    connection.close();
    for worker in workers {
        let _ = worker.join();
    }
    lock(&state.connections).remove(&id);
    let mut watch = lock(&state.watch);
    if watch.connection_closed(id) {
        state.orphaned_since.store(epoch_ms(), Ordering::Release);
    }
}

/// Serve one engine until shutdown or orphan-grace expiry. The caller retains its layout until all I/O has closed.
pub fn serve(
    engine: Arc<dyn Engine>,
    layout: &EngineLayout,
    lifeline: Lifeline,
) -> Result<(), ServeError> {
    let _signals = super::signals::Guard::install()?;
    let validators = validators()?;
    let mut files = layout.acquire()?;
    let listener = Listener::bind(&layout.address)?;
    files.publish()?;
    let state = Arc::new(Shared {
        engine,
        home: layout.home.clone(),
        token: layout.token().into(),
        instance: layout.instance_id.clone(),
        stopping: AtomicBool::new(false),
        stop_budget: Mutex::new(STOP_BUDGET),
        watch: Mutex::new(Watch::new(lifeline, layout.grace)),
        orphaned_since: AtomicU64::new(0),
        requests: AtomicU64::new(0),
        auth_failures: AtomicU64::new(0),
        scheduler_lag_us: AtomicU64::new(0),
        connections: Mutex::new(HashMap::new()),
        captures: Mutex::new(HashMap::new()),
        capture_workers: Mutex::new(Vec::new()),
        validators,
    });
    if let Err(error) = writeln!(
        io::stdout().lock(),
        "{}",
        json!({"ready":true,"address":layout.address,"pid":std::process::id()})
    ) {
        let _ = state.engine.close(Some(STOP_BUDGET));
        return Err(error.into());
    }
    let events = state.engine.events();
    let event_state = state.clone();
    let event_worker = thread::spawn(move || {
        while !event_state.stopping.load(Ordering::Acquire) {
            match events.recv_timeout(TICK) {
                Ok(event) => {
                    let connections: Vec<_> = lock(&event_state.connections)
                        .values()
                        .filter_map(Weak::upgrade)
                        .collect();
                    for connection in connections {
                        if connection.authenticated.load(Ordering::Acquire) {
                            let _ = connection.send(
                                &json!({"jsonrpc":"2.0","method":"engine.event","params":event}),
                            );
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    if lifeline == Lifeline::Stdin {
        let state = Arc::downgrade(&state);
        thread::spawn(move || {
            let mut buffer = [0; 64];
            let mut stdin = io::stdin().lock();
            while matches!(stdin.read(&mut buffer),Ok(n) if n > 0) {}
            if let Some(state) = state.upgrade() {
                let mut watch = lock(&state.watch);
                if watch.stdin_closed() {
                    state.orphaned_since.store(epoch_ms(), Ordering::Release);
                }
            }
        });
    }
    let mut workers = Vec::new();
    let mut next_id = 0;
    let result = loop {
        if state.stopping.load(Ordering::Acquire)
            || super::signals::requested()
            || lock(&state.watch).expired()
        {
            break Ok(());
        }
        reap(&mut workers);
        let started = Instant::now();
        match listener.accept_timeout(TICK) {
            Ok(Some(accepted)) if workers.len() < MAX_CONNECTIONS => {
                next_id += 1;
                let state = state.clone();
                workers.push(thread::spawn(move || {
                    connection_loop(&state, accepted, next_id)
                }));
            }
            Ok(Some(accepted)) => (accepted.closer)(),
            Ok(None) => {}
            Err(e) => break Err(ServeError::Io(e)),
        }
        state.scheduler_lag_us.store(
            started.elapsed().saturating_sub(TICK).as_micros() as u64,
            Ordering::Relaxed,
        );
    };
    state.stopping.store(true, Ordering::Release);
    for capture in lock(&state.captures).values() {
        (capture.abort)(Some("engine-stopping".into()));
        capture.changed.notify_all();
    }
    // Give the shutdown request worker the chance to serialize its acknowledgement, then unblock every reader/writer.
    for connection in lock(&state.connections).values().filter_map(Weak::upgrade) {
        connection.close();
    }
    let _ = state.engine.close(Some(*lock(&state.stop_budget)));
    for worker in workers {
        let _ = worker.join();
    }
    for worker in lock(&state.capture_workers).drain(..) {
        let _ = worker.join();
    }
    let _ = event_worker.join();
    drop(listener);
    drop(files);
    result
}
