//! The supervisor's RPC endpoint: NDJSON JSON-RPC 2.0 on `run/supervisor.sock` (unix) or the per-home
//! `-supervisor` pipe (Windows). One accept loop, one thread per connection (S14). `supervisor.auth` must come first
//! (constant-time token compare); a connection that has not authenticated within [`AUTH_IDLE`] is closed. Params are
//! deserialised into the generated closed structs, so an unknown key is `E_INVALID_PARAMS`. A connection's writer is
//! a [`SharedWriter`]: its replies and the notifications of its `config.watch` and `module.watch` subscriptions share
//! it.
use super::config::{self, SetError};
use super::subscribers::{SharedWriter, Topic};
use super::{relock, spawn_guarded, Shared, StopSource, DEFAULT_STOP_BUDGET, SUPERVISOR_FEATURES};
use super::{ModuleVerb, OpError};
use crate::paths::{supervisor_address, Layout};
use plur1bus_rpc::client::MAX_LINE;
use plur1bus_rpc::types::{
    ConfigGetParams, ConfigGetParamsTier, ConfigSetParams, ConfigWatchParams, DaemonStartParams,
    DaemonStatusParams, DaemonStopParams, ExtDisableParams, ExtEnableParams, ExtInspectParams,
    ExtInstallParams, ExtListParams, ExtRestoreParams, ExtShowParams, ExtUninstallParams,
    ExtWatchParams, ModuleGraphParams, ModuleInstallParams, ModuleListParams, ModuleRestartParams,
    ModuleStartParams, ModuleStopParams, ModuleUninstallParams, ModuleWatchParams,
    SupervisorAuthParams,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A connection that has not sent a valid `supervisor.auth` by then is closed.
pub const AUTH_IDLE: Duration = Duration::from_secs(30);

/// At most one "accept failed" warning per this interval; the next one carries the suppressed count.
const ACCEPT_WARN_EVERY: Duration = Duration::from_secs(10);

/// `daemon.stop { budgetMs }` upper bound, as in the schema (typify does not check integer ranges).
const MAX_BUDGET_MS: i64 = 120_000;

/// `config.set { changes }` bounds, as in the schema (typify does not check array lengths).
const MAX_CHANGES: usize = 64;

/// One accepted connection, split so the connection thread can read and write while a watchdog closes it.
pub(crate) struct Accepted {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// Ends the connection from another thread; a blocked read (and write) then returns. Callable more than once:
    /// the auth-idle watchdog and a dropped subscription both use it.
    pub closer: Arc<dyn Fn() + Send + Sync>,
    /// Makes sure everything written reaches the peer before the connection is dropped.
    pub drain: Box<dyn FnMut() + Send>,
}

pub struct SupervisorServer {
    listener: imp::Listener,
    token: String,
    address: String,
}

impl SupervisorServer {
    /// Listens on the supervisor address. On unix `run/` must exist (the caller creates it `0700` and removes a
    /// dead socket first); the socket is made `0600`. A live socket at the address is an `AddrInUse` error.
    pub fn bind(layout: &Layout, token: &str) -> io::Result<Self> {
        let address = supervisor_address(
            &layout.home,
            if cfg!(windows) { "windows" } else { "posix" },
        );
        let listener = imp::Listener::bind(&address)?;
        Ok(Self {
            listener,
            token: token.to_string(),
            address,
        })
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    /// Accepts connections until the process exits, each on its own guarded thread.
    pub fn serve(self, shared: Arc<Shared>, layout: Layout) {
        let hello_base = {
            let st = shared.lock();
            json!({
                "rpc": plur1bus_rpc::RPC_VERSION,
                "instanceId": st.instance_id,
                "pid": st.pid,
                "capabilities": plur1bus_rpc::capabilities("supervisor", SUPERVISOR_FEATURES),
            })
        };
        let ctx = Arc::new(ConnCtx {
            token: self.token,
            hello: hello_base,
            shared: shared.clone(),
            layout,
        });
        let mut next_id: u64 = 0;
        // Accept failures (e.g. EMFILE) can repeat every few ms; log at most one per ACCEPT_WARN_EVERY.
        let mut last_warn: Option<Instant> = None;
        let mut suppressed: u64 = 0;
        loop {
            match self.listener.accept() {
                Ok(conn) => {
                    next_id += 1;
                    let ctx = ctx.clone();
                    let id = next_id;
                    if let Err(e) =
                        spawn_guarded(&shared, &format!("conn-{id}"), move || ctx.handle(conn))
                    {
                        shared.log.error(
                            "cannot start a connection thread",
                            json!({ "err": e.to_string() }),
                        );
                    }
                }
                Err(e) => {
                    if last_warn.is_none_or(|t| t.elapsed() >= ACCEPT_WARN_EVERY) {
                        shared.log.warn(
                            "accept failed",
                            json!({ "err": e.to_string(), "suppressed": suppressed }),
                        );
                        last_warn = Some(Instant::now());
                        suppressed = 0;
                    } else {
                        suppressed += 1;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

struct ConnCtx {
    token: String,
    hello: Value,
    shared: Arc<Shared>,
    layout: Layout,
}

/// One connection's output side, as the handlers need it.
struct Conn {
    writer: SharedWriter,
    closer: Arc<dyn Fn() + Send + Sync>,
    /// Subscriptions made on this connection; removed when it ends.
    subscriptions: Vec<String>,
    /// The `config.watch` subscription among them, reused by a second `config.watch`.
    config_sub: Option<String>,
    /// The `module.watch` subscription among them, reused by a second `module.watch`.
    module_sub: Option<String>,
    /// The `ext.watch` subscription among them, reused by a second `ext.watch`.
    ext_sub: Option<String>,
}

enum Line {
    Data(Vec<u8>),
    TooLong,
    Closed,
}

fn read_line(r: &mut BufReader<Box<dyn Read + Send>>) -> Line {
    let mut buf = Vec::new();
    match r.take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf) {
        Ok(0) | Err(_) => Line::Closed,
        Ok(_) if buf.last() == Some(&b'\n') => {
            buf.pop();
            Line::Data(buf)
        }
        Ok(_) if buf.len() > MAX_LINE => Line::TooLong,
        Ok(_) => Line::Closed, // EOF in the middle of a line
    }
}

/// An error reply. `data.error` is the closed `ErrorCode`; the JSON-RPC code follows the core (`-32602` for invalid
/// params unless overridden, `-32000` otherwise).
fn error_reply(
    id: &Value,
    error: &str,
    message: &str,
    reason: Option<&str>,
    detail: Option<String>,
    code: Option<i64>,
) -> Value {
    let code = code.unwrap_or(if error == "E_INVALID_PARAMS" {
        -32602
    } else {
        -32000
    });
    let mut data = json!({ "error": error });
    if let Some(r) = reason {
        data["reason"] = json!(r);
    }
    if let Some(d) = detail {
        data["detail"] = json!(d);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message, "data": data } })
}

fn result_reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// `config.*` answers `E_NOT_AVAILABLE reason=config-unavailable` while no valid configuration runs (B18).
fn config_unavailable(id: &Value) -> Value {
    error_reply(
        id,
        "E_NOT_AVAILABLE",
        "no valid configuration runs; fix config.json",
        Some("config-unavailable"),
        None,
        None,
    )
}

fn set_error_reply(id: &Value, e: SetError) -> Value {
    match e {
        SetError::Invalid(errors) => error_reply(
            id,
            "E_CONFIG_INVALID",
            "the configuration would be invalid",
            None,
            Some(errors.join("; ")),
            None,
        ),
        SetError::ForeignHostStorePath(violation) => error_reply(
            id,
            "E_CONFIG_INVALID",
            &violation.message(),
            Some("foreign-host-store-path"),
            None,
            None,
        ),
        SetError::Conflict { current } => {
            let mut r = error_reply(
                id,
                "E_CONFLICT",
                "config.json changed since the given revision",
                Some("config-changed"),
                None,
                None,
            );
            r["error"]["data"]["ids"] = json!({ "currentRevision": current });
            r
        }
        SetError::Unavailable => config_unavailable(id),
        SetError::Io(detail) => error_reply(
            id,
            "E_INTERNAL",
            "cannot write config.json",
            None,
            Some(detail),
            None,
        ),
    }
}

fn op_error_reply(id: &Value, e: OpError) -> Value {
    error_reply(id, e.error, &e.message, e.reason.as_deref(), e.detail, None)
}

/// An `ext.*` failure: its code, reason and message, and what the refusal must show in `error.data.ext`.
fn ext_error_reply(id: &Value, e: crate::ext::ExtError) -> Value {
    let mut r = error_reply(id, e.code, &e.message, e.reason, None, None);
    if let Some(ext) = super::ext::error_data(&e.data) {
        r["error"]["data"]["ext"] = ext;
    }
    r
}

fn ext_reply(id: &Value, r: Result<Value, crate::ext::ExtError>) -> Value {
    match r {
        Ok(v) => result_reply(id, v),
        Err(e) => ext_error_reply(id, e),
    }
}

fn invalid_params(id: &Value, detail: String) -> Value {
    error_reply(
        id,
        "E_INVALID_PARAMS",
        "invalid params",
        None,
        Some(detail),
        None,
    )
}

fn parse<P: DeserializeOwned>(params: &Value) -> Result<P, String> {
    serde_json::from_value(params.clone()).map_err(|e| e.to_string())
}

/// Constant-time equality for equal-length inputs (the length itself is not secret: tokens are always 64 chars).
fn tokens_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .fold(0u8, |acc, (x, y)| std::hint::black_box(acc | (x ^ y)))
            == 0
}

/// What the connection loop does after a reply.
enum After {
    Continue,
    Close,
    Stop(Duration),
    /// The reply is already queued on the connection's subscription (`config.watch`); nothing to write.
    Queued,
}

impl ConnCtx {
    /// `daemon.start`: reset the core's backoff and ask the main thread for an immediate spawn (a no-op while the
    /// core runs). Under `--no-core` there is never a child.
    fn daemon_start(&self, id: &Value) -> Value {
        let mut st = self.shared.lock();
        if st.no_core {
            return error_reply(
                id,
                "E_NOT_AVAILABLE",
                "this supervisor has no children to start",
                Some("no-children"),
                None,
                None,
            );
        }
        if st.stopping.is_some() {
            return error_reply(
                id,
                "E_NOT_AVAILABLE",
                "the supervisor is stopping",
                Some("stopping"),
                None,
                None,
            );
        }
        if let Some(core) = st.slot_mut("core") {
            core.backoff.reset();
            core.start_requested = true;
        }
        self.shared.wake.notify_all();
        drop(st);
        self.shared
            .log
            .info("daemon.start", json!({ "child": "core" }));
        result_reply(id, json!({ "accepted": true, "role": "core" }))
    }

    fn handle(&self, conn: Accepted) {
        let Accepted {
            reader,
            writer,
            closer,
            mut drain,
        } = conn;
        let mut conn = Conn {
            writer: Arc::new(Mutex::new(writer)),
            closer: closer.clone(),
            subscriptions: Vec::new(),
            config_sub: None,
            module_sub: None,
            ext_sub: None,
        };
        // Watchdog: closes the connection unless `authed_tx` is dropped (auth succeeded, or the connection ended)
        // within AUTH_IDLE.
        let (authed_tx, authed_rx) = mpsc::channel::<()>();
        let watchdog = spawn_guarded(&self.shared, "auth-idle", move || {
            if let Err(mpsc::RecvTimeoutError::Timeout) = authed_rx.recv_timeout(AUTH_IDLE) {
                closer();
            }
        });
        if let Err(e) = watchdog {
            // Without the watchdog nothing would close an idle unauthenticated connection: refuse it instead.
            self.shared.log.error(
                "cannot start the auth-idle watchdog, closing the connection",
                json!({ "err": e.to_string() }),
            );
            return;
        }
        let mut authed_tx = Some(authed_tx);
        let mut reader = BufReader::new(reader);
        loop {
            let (reply, after) = match read_line(&mut reader) {
                Line::Closed => break,
                Line::TooLong => (
                    error_reply(
                        &Value::Null,
                        "E_INVALID_PARAMS",
                        "line too long",
                        Some("line-too-long"),
                        None,
                        None,
                    ),
                    After::Close,
                ),
                Line::Data(buf) if buf.iter().all(u8::is_ascii_whitespace) => continue,
                Line::Data(buf) => match serde_json::from_slice::<Value>(&buf) {
                    Err(_) => (
                        error_reply(
                            &Value::Null,
                            "E_INVALID_PARAMS",
                            "parse error",
                            Some("parse-error"),
                            None,
                            Some(-32700),
                        ),
                        After::Continue,
                    ),
                    Ok(msg) => match self.dispatch(&msg, authed_tx.is_none(), &mut conn) {
                        None => continue, // a notification: no reply
                        Some((reply, after, authed)) => {
                            if authed {
                                authed_tx = None;
                            }
                            (reply, after)
                        }
                    },
                },
            };
            if !matches!(after, After::Queued) {
                let mut line = reply.to_string();
                line.push('\n');
                // Once the connection is subscribed, its replies take the subscription's queue too: a reply written
                // directly could overtake the queued `config.watch` reply or a notification sent before it.
                if let Some(sub) = conn.subscriptions.first() {
                    if !self.shared.subscribers.send_to(sub, line) {
                        // Its queue is full (the peer does not read) or the subscriber was dropped: close the
                        // connection, so a writer thread blocked on it ends and the socket is released (M1).
                        (conn.closer)();
                        break;
                    }
                } else {
                    let mut w = relock(&conn.writer);
                    if w.write_all(line.as_bytes())
                        .and_then(|_| w.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            }
            match after {
                After::Continue | After::Queued => {}
                After::Close => {
                    drain();
                    break;
                }
                After::Stop(budget) => {
                    // The reply is out before the stop starts.
                    drain();
                    self.shared.request_stop(budget, StopSource::Rpc);
                }
            }
        }
        drop(authed_tx);
        for id in &conn.subscriptions {
            self.shared.subscribers.remove(id);
        }
    }

    /// `config.watch`: under the config lock (so no `config.changed` can come in between), subscribe the connection
    /// and queue the reply as the subscription's first line, so the peer reads the reply before any notification.
    fn config_watch(&self, id: &Value, conn: &mut Conn) -> (Value, After) {
        let st = relock(&self.shared.config);
        let (Some(running), Some(revision)) = (st.running.as_ref(), st.revision.as_ref()) else {
            return (config_unavailable(id), After::Continue);
        };
        if let Some(sub) = conn.config_sub.clone() {
            // M5: a second config.watch on this connection reuses its subscription (no duplicate notifications).
            let mut line = result_reply(
                id,
                json!({ "subscriptionId": sub, "config": running, "revision": revision }),
            )
            .to_string();
            line.push('\n');
            if !self.shared.subscribers.send_to(&sub, line) {
                (conn.closer)(); // the read loop then ends
                return (Value::Null, After::Queued);
            }
            return (Value::Null, After::Queued);
        }
        let closer = conn.closer.clone();
        let sub = self.shared.subscribers.add(
            Topic::Config,
            conn.writer.clone(),
            Box::new(move || closer()),
        );
        let mut line = result_reply(
            id,
            json!({ "subscriptionId": sub, "config": running, "revision": revision }),
        )
        .to_string();
        line.push('\n');
        if !self.shared.subscribers.send_to(&sub, line) {
            self.shared.subscribers.remove(&sub);
            let reply = error_reply(
                id,
                "E_INTERNAL",
                "cannot start the subscription",
                None,
                None,
                None,
            );
            return (reply, After::Continue);
        }
        conn.subscriptions.push(sub.clone());
        conn.config_sub = Some(sub);
        (Value::Null, After::Queued)
    }

    /// `module.watch`: under the state lock (so no `module.state` can come in between, B3), subscribe the connection
    /// and queue the reply, holding every module child's current state, as the subscription's first line.
    fn module_watch(&self, id: &Value, conn: &mut Conn) -> (Value, After) {
        let st = self.shared.lock();
        let reply = |sub: &str| {
            let mut line = result_reply(
                id,
                json!({ "subscriptionId": sub, "modules": st.module_states() }),
            )
            .to_string();
            line.push('\n');
            line
        };
        if let Some(sub) = conn.module_sub.clone() {
            // A second module.watch on this connection reuses its subscription (no duplicate notifications).
            if !self.shared.subscribers.send_to(&sub, reply(&sub)) {
                (conn.closer)(); // the read loop then ends
            }
            return (Value::Null, After::Queued);
        }
        let closer = conn.closer.clone();
        let sub = self.shared.subscribers.add(
            Topic::Modules,
            conn.writer.clone(),
            Box::new(move || closer()),
        );
        if !self.shared.subscribers.send_to(&sub, reply(&sub)) {
            self.shared.subscribers.remove(&sub);
            let reply = error_reply(
                id,
                "E_INTERNAL",
                "cannot start the subscription",
                None,
                None,
                None,
            );
            return (reply, After::Continue);
        }
        conn.subscriptions.push(sub.clone());
        conn.module_sub = Some(sub);
        (Value::Null, After::Queued)
    }

    /// `ext.watch`: under the ext watch lock (so no `ext.changed` can come in between), subscribe the connection and
    /// queue the reply, holding every installed extension, as the subscription's first line.
    fn ext_watch(&self, id: &Value, conn: &mut Conn) -> (Value, After) {
        let watched = super::ext::watch(&self.shared, &self.layout, |items| {
            let reply = |sub: &str| {
                let mut line =
                    result_reply(id, json!({ "subscriptionId": sub, "items": items })).to_string();
                line.push('\n');
                line
            };
            if let Some(sub) = conn.ext_sub.clone() {
                // A second ext.watch on this connection reuses its subscription (no duplicate notifications).
                if !self.shared.subscribers.send_to(&sub, reply(&sub)) {
                    (conn.closer)(); // the read loop then ends
                }
                return (Value::Null, After::Queued);
            }
            let closer = conn.closer.clone();
            let sub = self.shared.subscribers.add(
                Topic::Ext,
                conn.writer.clone(),
                Box::new(move || closer()),
            );
            if !self.shared.subscribers.send_to(&sub, reply(&sub)) {
                self.shared.subscribers.remove(&sub);
                let reply = error_reply(
                    id,
                    "E_INTERNAL",
                    "cannot start the subscription",
                    None,
                    None,
                    None,
                );
                return (reply, After::Continue);
            }
            conn.subscriptions.push(sub.clone());
            conn.ext_sub = Some(sub);
            (Value::Null, After::Queued)
        });
        watched.unwrap_or_else(|e| (ext_error_reply(id, e), After::Continue))
    }

    fn config_get(&self, id: &Value, p: ConfigGetParams) -> Value {
        if p.key.is_some() && p.tier.is_some() {
            return invalid_params(id, "key and tier are exclusive".into());
        }
        let tier = p.tier.map(|t| match t {
            ConfigGetParamsTier::Basic => plur1bus_config::Tier::Basic,
            ConfigGetParamsTier::Advanced => plur1bus_config::Tier::Advanced,
        });
        let key = p.key.as_deref().map(String::as_str);
        let st = relock(&self.shared.config);
        let (Some(running), Some(revision)) = (st.running.as_ref(), st.revision.as_ref()) else {
            return config_unavailable(id);
        };
        match config::get_result(running, revision, key, tier) {
            Some(v) => result_reply(id, v),
            None => error_reply(
                id,
                "E_INVALID_PARAMS",
                &format!("no such key: {}", key.unwrap_or_default()),
                Some("unknown-key"),
                None,
                None,
            ),
        }
    }

    fn config_set(&self, id: &Value, params: &Value) -> Value {
        let p: ConfigSetParams = match parse(params) {
            Ok(p) => p,
            Err(d) => return invalid_params(id, d),
        };
        if p.changes.is_empty() || p.changes.len() > MAX_CHANGES {
            return invalid_params(id, format!("changes must hold 1 to {MAX_CHANGES} items"));
        }
        // A change without `value` deserialises as null; the schema requires the key.
        let raw = params["changes"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        if raw.iter().any(|c| c.get("value").is_none()) {
            return invalid_params(id, "every change needs a value".into());
        }
        let changes = p
            .changes
            .into_iter()
            .map(|c| (String::from(c.key), c.value))
            .collect();
        let if_revision = p.if_revision.as_deref().map(String::as_str);
        match config::set(
            &self.shared,
            &self.layout,
            changes,
            if_revision,
            p.dry_run.unwrap_or(false),
        ) {
            Ok(v) => result_reply(id, v),
            Err(e) => set_error_reply(id, e),
        }
    }

    /// Queues a `module.*` control call for the main thread and waits for its result ([`super::modules::run_op`]).
    fn module_op(&self, id: &Value, name: &str, verb: ModuleVerb, budget_ms: Option<i64>) -> Value {
        if budget_ms.is_some_and(|b| !(0..=MAX_BUDGET_MS).contains(&b)) {
            return invalid_params(
                id,
                format!("budgetMs must be between 0 and {MAX_BUDGET_MS}"),
            );
        }
        let budget = budget_ms
            .map(|b| Duration::from_millis(b as u64))
            .unwrap_or(DEFAULT_STOP_BUDGET);
        match super::modules::run_op(&self.shared, name, verb, budget) {
            Ok(v) => result_reply(id, v),
            Err(e) => op_error_reply(id, e),
        }
    }

    /// `module.install`: the source is checked and copied into its staging directory here (a refusal copies nothing,
    /// B14), then the main thread puts it in place around a stop and a start of the module.
    fn module_install(&self, id: &Value, path: &str) -> Value {
        // One install at a time: the staging directory is named after the module and this process.
        static STAGING: Mutex<()> = Mutex::new(());
        let _one = relock(&STAGING);
        let staged = match crate::modules::install::stage(&self.layout, std::path::Path::new(path))
        {
            Ok(s) => s,
            Err(e) if e.is_io() => {
                return error_reply(
                    id,
                    "E_INTERNAL",
                    "the module could not be copied",
                    None,
                    Some(e.to_string()),
                    None,
                )
            }
            Err(e) => {
                return error_reply(
                    id,
                    "E_INVALID_PARAMS",
                    "the module was not installed",
                    Some(e.reason()),
                    Some(e.to_string()),
                    None,
                )
            }
        };
        let name = staged.manifest.name.clone();
        self.module_op(id, &name, ModuleVerb::Install(Box::new(staged)), None)
    }

    /// Returns the reply, what to do next, and whether the connection is now authenticated; `None` for a message
    /// without an `id` (a notification), which gets no reply.
    fn dispatch(&self, msg: &Value, authed: bool, conn: &mut Conn) -> Option<(Value, After, bool)> {
        let id = msg.get("id").cloned();
        let valid = msg.is_object()
            && msg["jsonrpc"] == "2.0"
            && msg["method"].is_string()
            && matches!(id, None | Some(Value::String(_)) | Some(Value::Number(_)))
            && matches!(msg.get("params"), None | Some(Value::Object(_)));
        if !valid {
            let id = match id {
                Some(v @ (Value::String(_) | Value::Number(_))) => v,
                _ => Value::Null,
            };
            let reply = error_reply(
                &id,
                "E_INVALID_PARAMS",
                "invalid request",
                Some("invalid-request"),
                None,
                Some(-32600),
            );
            return Some((reply, After::Continue, false));
        }
        let id = id?;
        let method = msg["method"].as_str().unwrap_or_default();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

        if method == "supervisor.auth" {
            let p: SupervisorAuthParams = match parse(&params) {
                Ok(p) => p,
                Err(d) => return Some((invalid_params(&id, d), After::Close, false)),
            };
            if !tokens_match(&p.token, &self.token) {
                self.shared
                    .log
                    .warn("supervisor.auth refused", json!({ "reason": "bad-token" }));
                let reply = error_reply(
                    &id,
                    "E_UNAUTHORIZED",
                    "bad token",
                    Some("bad-token"),
                    None,
                    None,
                );
                return Some((reply, After::Close, false));
            }
            return Some((result_reply(&id, self.hello.clone()), After::Continue, true));
        }
        if !authed {
            let reply = error_reply(
                &id,
                "E_UNAUTHORIZED",
                "authenticate first",
                Some("auth-required"),
                None,
                None,
            );
            return Some((reply, After::Continue, false));
        }
        let reply = match method {
            "daemon.status" => match parse::<DaemonStatusParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => {
                    // Config first, then state (the lock order in `config`).
                    let cfg = config::status_json(&relock(&self.shared.config));
                    let mut status = self.shared.lock().status_json();
                    status["config"] = cfg;
                    (result_reply(&id, status), After::Continue)
                }
            },
            "config.get" => match parse::<ConfigGetParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(p) => (self.config_get(&id, p), After::Continue),
            },
            "config.set" => (self.config_set(&id, &params), After::Continue),
            "config.watch" => match parse::<ConfigWatchParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => self.config_watch(&id, conn),
            },
            "module.watch" => match parse::<ModuleWatchParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => self.module_watch(&id, conn),
            },
            "module.list" => match parse::<ModuleListParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    result_reply(&id, super::module_list(&self.shared, &self.layout)),
                    After::Continue,
                ),
            },
            "module.graph" => match parse::<ModuleGraphParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => {
                    let g = crate::modules::graph(&crate::modules::scan(&self.layout));
                    (result_reply(&id, json!(g)), After::Continue)
                }
            },
            "module.start" => match parse::<ModuleStartParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(p) => (
                    self.module_op(&id, &p.name, ModuleVerb::Start, p.budget_ms),
                    After::Continue,
                ),
            },
            "module.stop" => match parse::<ModuleStopParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(p) => (
                    self.module_op(&id, &p.name, ModuleVerb::Stop, p.budget_ms),
                    After::Continue,
                ),
            },
            "module.restart" => match parse::<ModuleRestartParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(p) => (
                    self.module_op(&id, &p.name, ModuleVerb::Restart, p.budget_ms),
                    After::Continue,
                ),
            },
            "module.install" => match parse::<ModuleInstallParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(p) => (self.module_install(&id, &p.path), After::Continue),
            },
            "module.uninstall" => match parse::<ModuleUninstallParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(p) => (
                    self.module_op(&id, &p.name, ModuleVerb::Uninstall { into: None }, None),
                    After::Continue,
                ),
            },
            "ext.watch" => match parse::<ExtWatchParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => self.ext_watch(&id, conn),
            },
            "ext.list" => match parse::<ExtListParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(&id, super::ext::list(&self.shared, &self.layout, &params)),
                    After::Continue,
                ),
            },
            "ext.show" => match parse::<ExtShowParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(&id, super::ext::show(&self.shared, &self.layout, &params)),
                    After::Continue,
                ),
            },
            "ext.inspect" => match parse::<ExtInspectParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(&id, super::ext::inspect(&self.layout, &params)),
                    After::Continue,
                ),
            },
            "ext.install" => match parse::<ExtInstallParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(
                        &id,
                        super::ext::install(&self.shared, &self.layout, &params),
                    ),
                    After::Continue,
                ),
            },
            "ext.uninstall" => match parse::<ExtUninstallParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(
                        &id,
                        super::ext::uninstall(&self.shared, &self.layout, &params),
                    ),
                    After::Continue,
                ),
            },
            "ext.restore" => match parse::<ExtRestoreParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(
                        &id,
                        super::ext::restore(&self.shared, &self.layout, &params),
                    ),
                    After::Continue,
                ),
            },
            "ext.enable" => match parse::<ExtEnableParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(&id, super::ext::enable(&self.shared, &self.layout, &params)),
                    After::Continue,
                ),
            },
            "ext.disable" => match parse::<ExtDisableParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (
                    ext_reply(
                        &id,
                        super::ext::disable(&self.shared, &self.layout, &params),
                    ),
                    After::Continue,
                ),
            },
            "daemon.start" => match parse::<DaemonStartParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(_) => (self.daemon_start(&id), After::Continue),
            },
            "daemon.stop" => match parse::<DaemonStopParams>(&params) {
                Err(d) => (invalid_params(&id, d), After::Continue),
                Ok(DaemonStopParams { budget_ms: Some(b) })
                    if !(0..=MAX_BUDGET_MS).contains(&b) =>
                {
                    (
                        invalid_params(
                            &id,
                            format!("budgetMs must be between 0 and {MAX_BUDGET_MS}"),
                        ),
                        After::Continue,
                    )
                }
                Ok(p) => {
                    let budget = p
                        .budget_ms
                        .map(|b| Duration::from_millis(b as u64))
                        .unwrap_or(DEFAULT_STOP_BUDGET);
                    (
                        result_reply(&id, json!({ "accepted": true })),
                        After::Stop(budget),
                    )
                }
            },
            other => (
                error_reply(
                    &id,
                    "E_INTERNAL",
                    &format!("method not found: {other}"),
                    Some("method-not-found"),
                    None,
                    Some(-32601),
                ),
                After::Continue,
            ),
        };
        Some((reply.0, reply.1, false))
    }
}

#[cfg(unix)]
mod imp {
    use super::Accepted;
    use std::io;
    use std::net::Shutdown;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind(address: &str) -> io::Result<Self> {
            let l = UnixListener::bind(address)?;
            std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self(l))
        }

        pub fn accept(&self) -> io::Result<Accepted> {
            let (s, _) = self.0.accept()?;
            let reader = s.try_clone()?;
            let closer = s.try_clone()?;
            Ok(Accepted {
                reader: Box::new(reader),
                writer: Box::new(s),
                closer: std::sync::Arc::new(move || {
                    let _ = closer.shutdown(Shutdown::Both);
                }),
                // The kernel delivers what was written before the close.
                drain: Box::new(|| {}),
            })
        }
    }
}

#[cfg(windows)]
use super::pipe_windows as imp;
