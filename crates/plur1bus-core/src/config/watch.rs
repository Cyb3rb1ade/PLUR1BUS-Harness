//! `config-watch.ts` (module-api): a `config.watch` subscription on the supervisor, the [`ConfigWatch`] the
//! configuration source follows (P4-11 ruling 2: the client arrives with the flip).
//!
//! One attempt reads `run/supervisor.token` (the supervisor may have rotated it), connects with the pid of
//! `run/supervisor.pid` as the expected server, authenticates with `supervisor.auth` and calls `config.watch`. Every
//! `config.changed` is buffered from before the connect on, so one that arrives right behind the reply is applied
//! before anyone could register a listener. The whole attempt is bounded by one timeout; a connection that answers
//! later is closed.
//!
//! Differences from TypeScript:
//! - A listener registered with `on_close` after the connection ended is not called (the trait forbids a call from
//!   inside `on_close`); [`ConfigWatch::ended`] tells the source instead.
//! - A `config.changed` without an object `config` or a string `revision` is ignored; TypeScript takes it as it is.
//! - Of the pushes buffered behind the reply only the newest is read. TypeScript replays them all (from the one that
//!   links to the snapshot on, skipping the snapshot pushed again), which gives the same configuration: no listener
//!   can be registered before the watch is handed out, and a push of the snapshot's revision carries the snapshot.
//! - `set_during_import` is not offered (the trait's default): the run-bound maintenance write arrives with the
//!   import package, and a source without it refuses that write, it never falls back to `config.set`.
use super::source::{Change, ConfigChanged, ConfigWatch, Connect, Unsubscribe, WatchError};
use crate::run_files;
use plur1bus_rpc::client::{BackgroundClient, ClientEvent};
use plur1bus_rpc::{ConnectOptions, Endpoint, RpcError};
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long a `config.set` may take: it waits for a requested restart (stop budget plus ready timeout).
const SET_TIMEOUT: Duration = Duration::from_secs(120);
/// The bound of one attempt when the caller names none.
const DEFAULT_TIMEOUT: Duration = Duration::from_millis(1000);
/// The attempts of one series when the caller names none.
const DEFAULT_ATTEMPTS: u32 = 3;

type ChangeFn = Arc<dyn Fn(&ConfigChanged) + Send + Sync>;
type CloseFn = Arc<dyn Fn() + Send + Sync>;

/// `config.changed`, as far as the subscription reads it; `None` for one without an object `config` or a string
/// `revision`.
fn push_of(params: &Value) -> Option<ConfigChanged> {
    let config = params.get("config").filter(|c| c.is_object())?;
    let revision = params.get("revision")?.as_str()?;
    Some(ConfigChanged {
        config: config.clone(),
        revision: revision.to_owned(),
    })
}

struct Inner {
    config: Value,
    revision: String,
    /// The pushes that arrived before the `config.watch` reply was taken; `None` once the subscription is live.
    buffered: Option<Vec<ConfigChanged>>,
    listeners: Vec<(u64, ChangeFn)>,
    closers: Vec<(u64, CloseFn)>,
    next: u64,
    ended: bool,
}

struct Shared(Mutex<Inner>);

impl Shared {
    fn new() -> Arc<Shared> {
        Arc::new(Shared(Mutex::new(Inner {
            config: Value::Null,
            revision: String::new(),
            buffered: Some(Vec::new()),
            listeners: Vec::new(),
            closers: Vec::new(),
            next: 0,
            ended: false,
        })))
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Called on the connection's reader thread, one event at a time; no lock is held while a listener runs.
    fn event(&self, event: ClientEvent) {
        match event {
            ClientEvent::Notification { method, params } => {
                if method != "config.changed" {
                    return;
                }
                let Some(push) = push_of(&params) else {
                    return;
                };
                let listeners = {
                    let mut inner = self.inner();
                    if let Some(buffered) = inner.buffered.as_mut() {
                        buffered.push(push);
                        return;
                    }
                    inner.config = push.config.clone();
                    inner.revision.clone_from(&push.revision);
                    inner
                        .listeners
                        .iter()
                        .map(|(_, f)| Arc::clone(f))
                        .collect::<Vec<_>>()
                };
                for listener in listeners {
                    // A listener never breaks the others.
                    let _ = catch_unwind(AssertUnwindSafe(|| listener(&push)));
                }
            }
            ClientEvent::Closed => {
                let closers = {
                    let mut inner = self.inner();
                    inner.ended = true;
                    std::mem::take(&mut inner.closers)
                };
                for (_, closer) in closers {
                    let _ = catch_unwind(AssertUnwindSafe(|| closer()));
                }
            }
        }
    }

    /// Takes the `config.watch` reply and the pushes buffered behind it. No listener exists yet, so of those pushes
    /// only the newest counts (the reply is queued before any notification on the connection, so a buffered push is
    /// never older than the snapshot). A push the reader takes after this is a live one; the outcome is the same.
    fn go_live(&self, config: Value, revision: String) {
        let mut inner = self.inner();
        let newest = inner.buffered.take().and_then(|mut pushes| pushes.pop());
        let newest = newest.unwrap_or(ConfigChanged { config, revision });
        inner.config = newest.config;
        inner.revision = newest.revision;
    }
}

/// A live `config.watch` subscription on the supervisor.
pub struct SupervisorWatch {
    client: BackgroundClient,
    shared: Arc<Shared>,
}

/// The error object of a refused or failed supervisor call: `error` (the code's name), `message`, and `reason` when
/// the supervisor or the transport named one.
fn watch_error(e: &RpcError) -> WatchError {
    let mut out = json!({ "error": e.code_name(), "message": e.to_string() });
    let reason = match e {
        RpcError::Call { reason, .. } => reason.clone(),
        RpcError::Unavailable { reason, .. } => Some(reason.clone()),
        RpcError::Version { .. } | RpcError::Protocol(_) => None,
    };
    if let Some(reason) = reason {
        out["reason"] = json!(reason);
    }
    WatchError(out)
}

impl ConfigWatch for SupervisorWatch {
    fn snapshot(&self) -> (Value, String) {
        let inner = self.shared.inner();
        (inner.config.clone(), inner.revision.clone())
    }

    fn on_change(&self, listener: Box<dyn Fn(&ConfigChanged) + Send + Sync>) -> Unsubscribe {
        let id = {
            let mut inner = self.shared.inner();
            inner.next += 1;
            let id = inner.next;
            inner.listeners.push((id, Arc::from(listener)));
            id
        };
        let shared = Arc::downgrade(&self.shared);
        Box::new(move || {
            if let Some(shared) = shared.upgrade() {
                shared.inner().listeners.retain(|(other, _)| *other != id);
            }
        })
    }

    fn on_close(&self, listener: Box<dyn Fn() + Send + Sync>) -> Unsubscribe {
        let id = {
            let mut inner = self.shared.inner();
            if inner.ended {
                // Never called from inside `on_close`; `ended` is how the source learns of it.
                return Box::new(|| {});
            }
            inner.next += 1;
            let id = inner.next;
            inner.closers.push((id, Arc::from(listener)));
            id
        };
        let shared = Arc::downgrade(&self.shared);
        Box::new(move || {
            if let Some(shared) = shared.upgrade() {
                shared.inner().closers.retain(|(other, _)| *other != id);
            }
        })
    }

    fn set(&self, changes: &[Change]) -> Result<Value, WatchError> {
        let changes: Vec<Value> = changes
            .iter()
            .map(|c| json!({ "key": c.key, "value": c.value }))
            .collect();
        self.client
            .call(
                "config.set",
                json!({ "changes": changes }),
                SET_TIMEOUT,
                &|| false,
            )
            .map_err(|e| watch_error(&e))
    }

    fn ended(&self) -> bool {
        self.shared.inner().ended
    }

    fn close(&self) {
        self.client.close();
    }
}

/// `<pid> <instanceId>` of `run/supervisor.pid`: the pid, when the file names one.
fn recorded_pid(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    text.split_whitespace()
        .next()?
        .parse()
        .ok()
        .filter(|pid| *pid > 0)
}

fn unavailable(reason: &str, detail: &str) -> RpcError {
    RpcError::Unavailable {
        reason: reason.into(),
        detail: detail.into(),
    }
}

/// One attempt, bounded as a whole by `timeout`.
fn attempt(home: &Path, timeout: Duration) -> Result<Arc<SupervisorWatch>, RpcError> {
    let start = Instant::now();
    let run = home.join("run");
    let token = run_files::read_token(&run.join("supervisor.token"))
        .map_err(|_| unavailable("supervisor-token", "the supervisor's token is unreadable"))?
        .ok_or_else(|| unavailable("supervisor-token", "no supervisor token"))?;
    let shared = Shared::new();
    let events = Arc::clone(&shared);
    let client = BackgroundClient::connect_with_auth(
        &run_files::unit_address(home, "supervisor", cfg!(windows)),
        json!({ "token": token.expose() }),
        ConnectOptions {
            connect_timeout: timeout,
            call_timeout: SET_TIMEOUT,
            endpoint: Endpoint::Supervisor,
            expected_server_pid: recorded_pid(&run.join("supervisor.pid")),
        },
        Arc::new(move |event| events.event(event)),
    )?;
    let left = timeout.saturating_sub(start.elapsed());
    if left.is_zero() {
        client.close();
        return Err(unavailable(
            "call-timeout",
            "config.watch answered too late",
        ));
    }
    // A reply after the deadline closes the connection (`BackgroundClient::call`).
    let reply = client.call("config.watch", json!({}), left, &|| false)?;
    let (Some(config), Some(revision)) = (
        reply.get("config").filter(|c| c.is_object()),
        reply.get("revision").and_then(Value::as_str),
    ) else {
        client.close();
        return Err(RpcError::Protocol("invalid config.watch result".into()));
    };
    shared.go_live(config.clone(), revision.to_owned());
    Ok(Arc::new(SupervisorWatch { client, shared }))
}

/// `watchSupervisorConfig`: connects to the supervisor of `home` and subscribes to its configuration. `attempts` tries
/// (default 3), each bounded by `connect_timeout` (default 1 s) and spaced so every attempt but the last takes that
/// long at least; the last error when none succeeds.
pub fn watch_supervisor_config(
    home: &Path,
    attempts: Option<u32>,
    connect_timeout: Option<Duration>,
) -> Result<Arc<SupervisorWatch>, RpcError> {
    let timeout = connect_timeout.unwrap_or(DEFAULT_TIMEOUT);
    let attempts = attempts.unwrap_or(DEFAULT_ATTEMPTS).max(1);
    let mut last = unavailable("no-attempt", "no attempt made");
    for n in 0..attempts {
        let start = Instant::now();
        match attempt(home, timeout) {
            Ok(watch) => return Ok(watch),
            Err(e) => last = e,
        }
        let left = timeout.saturating_sub(start.elapsed());
        if n + 1 < attempts && !left.is_zero() {
            std::thread::sleep(left);
        }
    }
    Err(last)
}

/// The [`Connect`] of a home, for [`ConfigSourceOptions::connect`](super::source::ConfigSourceOptions::connect):
/// `None` when no supervisor answered.
pub fn connector(home: impl Into<PathBuf>) -> Connect {
    let home = home.into();
    Arc::new(move |attempts, connect_timeout| {
        watch_supervisor_config(&home, attempts, connect_timeout)
            .ok()
            .map(|watch| watch as Arc<dyn ConfigWatch>)
    })
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
