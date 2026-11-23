//! Host-owned definitions, connection leases, tool caches and bounded restart policy.
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde_json::Value;

pub use plur1bus_providers::provenance::Trust;

use crate::{
    provenance,
    session::{Call, Error, Session},
};

const MAX_ENTRIES: usize = 128;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Scope {
    Installation,
    Agent(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Transport {
    Http,
    Stdio,
}

#[derive(Clone)]
pub struct Definition {
    pub name: String,
    pub scope: Scope,
    pub transport: Transport,
    pub idle_for: Duration,
    pub cache_for: Duration,
    pub max_result_bytes: usize,
    pub trust: Trust,
}

pub struct Caller<'a> {
    pub agent_id: &'a str,
    pub principal: &'a str,
}

pub trait Connection: Send + Sync {
    fn protocol(&self) -> &str;
    fn closed(&self) -> bool;
    fn tools_generation(&self) -> u64 {
        0
    }
    fn close(&self) -> Result<(), Error>;
    fn invoke(&self, call: Call, deadline: Instant) -> Result<Value, Error>;
}

impl Connection for Session {
    fn protocol(&self) -> &str {
        &self.info().protocol_version
    }
    fn closed(&self) -> bool {
        self.is_closed()
    }
    fn tools_generation(&self) -> u64 {
        Self::tools_generation(self)
    }
    fn close(&self) -> Result<(), Error> {
        Self::close(self)
    }
    fn invoke(&self, call: Call, deadline: Instant) -> Result<Value, Error> {
        Self::invoke(self, call, deadline)
    }
}

pub trait Host: Send + Sync {
    fn open(
        &self,
        definition: &Definition,
        previous_protocol: Option<&str>,
        deadline: Instant,
    ) -> Result<Arc<dyn Connection>, Error>;

    fn now(&self) -> Instant {
        Instant::now()
    }

    /// Apply host admission before using any connection, including an existing one.
    fn admit(&self, _definition: &Definition) -> Result<(), Error> {
        Ok(())
    }

    /// Apply the current private redactor before placing data in a caller's results or cache.
    fn redact(&self, _definition: &Definition, _value: &mut Value) {}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegistryError {
    Closed,
    Invalid,
    Conflict,
    NotRegistered,
    ResultLimit,
    Connection(Error),
}
impl From<Error> for RegistryError {
    fn from(error: Error) -> Self {
        Self::Connection(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Stopped,
    Starting,
    Running,
}

pub struct Status {
    pub name: String,
    pub scope: Scope,
    pub transport: Transport,
    pub phase: Phase,
    pub protocol: Option<String>,
    pub starts: u64,
    pub in_flight: usize,
    pub cache_fresh: bool,
    pub last_error: Option<Error>,
}

type Key = (Scope, String);
type Result<T, E = RegistryError> = std::result::Result<T, E>;

struct Cache {
    data: Value,
    expires: Instant,
    generation: u64,
}

#[derive(Default)]
struct State {
    retired: bool,
    starting: bool,
    session: Option<Arc<dyn Connection>>,
    protocol: Option<String>,
    starts: u64,
    leases: usize,
    idle: Option<Instant>,
    cache: Option<Cache>,
    last_error: Option<Error>,
    reconnect_at: Option<Instant>,
    reconnects: u8,
}

struct Entry {
    def: Definition,
    state: Mutex<State>,
    changed: Condvar,
}

impl Entry {
    fn new(def: Definition) -> Self {
        Self {
            def,
            state: Mutex::default(),
            changed: Condvar::new(),
        }
    }

    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.state.lock().map_err(|_| RegistryError::Closed)
    }

    fn ensure(&self, host: &dyn Host, deadline: Instant) -> Result<Arc<dyn Connection>> {
        let mut state = self.state()?;
        loop {
            if state.retired {
                return Err(RegistryError::NotRegistered);
            }
            if Instant::now() >= deadline {
                return Err(Error::Timeout.into());
            }
            if let Some(conn) = &state.session {
                if !conn.closed() {
                    return Ok(Arc::clone(conn));
                }
            }
            if state.starting {
                let wait = deadline.saturating_duration_since(Instant::now());
                state = self
                    .changed
                    .wait_timeout(state, wait)
                    .map_err(|_| RegistryError::Closed)?
                    .0;
                continue;
            }
            state.session = None;
            state.starting = true;
            state.reconnect_at = None;
            break;
        }
        let remembered = state.protocol.clone();
        drop(state);
        let opened = host.open(&self.def, remembered.as_deref(), deadline);
        let mut state = self.state()?;
        state.starting = false;
        self.changed.notify_all();
        if state.retired || Instant::now() >= deadline {
            let retired = state.retired;
            drop(state);
            if let Ok(conn) = opened {
                conn.close()?;
            }
            return Err(if retired {
                RegistryError::NotRegistered
            } else {
                Error::Timeout.into()
            });
        }
        match opened {
            Ok(connection) => {
                state.protocol = Some(connection.protocol().to_owned());
                state.session = Some(connection.clone());
                state.starts = state.starts.saturating_add(1);
                state.last_error = None;
                if state.leases == 0 {
                    state.idle = host.now().checked_add(self.def.idle_for);
                }
                Ok(connection)
            }
            Err(error) => {
                state.last_error = Some(error);
                if self.def.transport == Transport::Http && error != Error::AuthRequired {
                    schedule_reconnect(&mut state, host.now());
                }
                Err(error.into())
            }
        }
    }

    fn retire(&self) -> Result<Option<Arc<dyn Connection>>> {
        let mut state = self.state()?;
        state.retired = true;
        state.cache = None;
        state.reconnect_at = None;
        self.changed.notify_all();
        Ok(state.session.take())
    }

    fn status(&self, now: Instant) -> Result<Status> {
        let state = self.state()?;
        if state.retired {
            return Err(RegistryError::NotRegistered);
        }
        let phase = if state.starting {
            Phase::Starting
        } else if state
            .session
            .as_ref()
            .is_some_and(|connection| !connection.closed())
        {
            Phase::Running
        } else {
            Phase::Stopped
        };
        Ok(Status {
            name: self.def.name.clone(),
            scope: self.def.scope.clone(),
            transport: self.def.transport,
            phase,
            protocol: state.protocol.clone(),
            starts: state.starts,
            in_flight: state.leases,
            cache_fresh: state
                .cache
                .as_ref()
                .is_some_and(|cache| now < cache.expires),
            last_error: state.last_error,
        })
    }
}

#[derive(Default)]
struct Entries {
    entries: HashMap<Key, Arc<Entry>>,
    closed: bool,
}

pub struct Registry {
    host: Arc<dyn Host>,
    entries: Mutex<Entries>,
}

impl Registry {
    pub fn new(host: Arc<dyn Host>) -> Self {
        Self {
            host,
            entries: Mutex::default(),
        }
    }

    pub fn register(&self, definition: Definition) -> Result<()> {
        let key = key(&definition)?;
        let mut store = self.entries.lock().map_err(|_| RegistryError::Closed)?;
        if store.closed {
            return Err(RegistryError::Closed);
        }
        if store.entries.len() >= MAX_ENTRIES
            || store.entries.contains_key(&key)
            || store.entries.keys().any(|(scope, name)| {
                *name == definition.name
                    && matches!(scope, Scope::Installation)
                        != matches!(definition.scope, Scope::Installation)
            })
        {
            return Err(RegistryError::Conflict);
        }
        store.entries.insert(key, Arc::new(Entry::new(definition)));
        Ok(())
    }

    pub fn reload(&self, definition: Definition) -> Result<()> {
        let key = key(&definition)?;
        let mut store = self.entries.lock().map_err(|_| RegistryError::Closed)?;
        if store.closed {
            return Err(RegistryError::Closed);
        }
        let slot = store
            .entries
            .get_mut(&key)
            .ok_or(RegistryError::NotRegistered)?;
        let old = slot.retire()?;
        *slot = Arc::new(Entry::new(definition));
        drop(store);
        if let Some(connection) = old {
            connection.close()?;
        }
        Ok(())
    }

    pub fn unregister(&self, scope: Scope, name: &str) -> Result<()> {
        let mut store = self.entries.lock().map_err(|_| RegistryError::Closed)?;
        let entry = store
            .entries
            .remove(&(scope, name.into()))
            .ok_or(RegistryError::NotRegistered)?;
        let old = entry.retire()?;
        drop(store);
        if let Some(connection) = old {
            connection.close()?;
        }
        Ok(())
    }

    pub fn status(&self, name: &str, actor: &str) -> Result<Status> {
        self.resolve(name, actor)?.status(self.host.now())
    }

    pub fn list(&self, actor: &str) -> Result<Vec<Status>> {
        let mut matches = Vec::new();
        for entry in self.snapshot()? {
            if matches!(&entry.def.scope, Scope::Installation)
                || matches!(&entry.def.scope, Scope::Agent(agent) if agent == actor)
            {
                if let Ok(value) = entry.status(self.host.now()) {
                    matches.push(value);
                }
            }
        }
        matches.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(matches)
    }

    pub fn invoke(
        &self,
        name: &str,
        caller: Caller<'_>,
        call: Call,
        deadline: Instant,
    ) -> Result<Value> {
        if caller.principal.is_empty()
            || caller.principal.len() > 256
            || caller.principal.chars().any(char::is_control)
        {
            return Err(RegistryError::Invalid);
        }
        let entry = self.resolve(name, caller.agent_id)?;
        self.admit_entry(&entry, deadline)?;
        self.invoke_entry(&entry, call, deadline, Some(caller.principal))
    }

    pub fn list_tools(
        &self,
        name: &str,
        actor: &str,
        refresh: bool,
        deadline: Instant,
    ) -> Result<Value> {
        let entry = self.resolve(name, actor)?;
        self.admit_entry(&entry, deadline)?;
        if !refresh {
            let state = entry.state()?;
            if let Some(cache) = &state.cache {
                if cache_live(&state, cache, self.host.now()) {
                    let mut data = cache.data.clone();
                    drop(state);
                    self.host.redact(&entry.def, &mut data);
                    if entry.state()?.retired {
                        return Err(RegistryError::NotRegistered);
                    }
                    if Instant::now() >= deadline {
                        return Err(Error::Timeout.into());
                    }
                    return bounded(&entry.def, data);
                }
            }
        }
        self.invoke_entry(&entry, Call::ListTools, deadline, None)
    }

    pub fn invalidate_tools(&self, name: &str, actor: &str) -> Result<()> {
        self.resolve(name, actor)?.state()?.cache = None;
        Ok(())
    }

    /// A host timer calls this with its current clock. It never opens a session for an
    /// idle entry unless a previously used HTTP connection needs a bounded restart.
    pub fn tick(&self, now: Instant, deadline: Instant) -> Result<()> {
        for entry in self.snapshot()? {
            let (closing, reconnect) = {
                let mut state = entry.state()?;
                if state.retired {
                    continue;
                }
                if state
                    .session
                    .as_ref()
                    .is_some_and(|connection| connection.closed())
                {
                    state.session = None;
                    state.cache = None;
                    state.last_error = Some(Error::Closed);
                    if entry.def.transport == Transport::Http {
                        schedule_reconnect(&mut state, now);
                    }
                }
                let closing = if state.leases == 0 && state.idle.is_some_and(|stop| stop <= now) {
                    state.idle = None;
                    state.session.take()
                } else {
                    None
                };
                let reconnect = state.reconnect_at.is_some_and(|due| due <= now);
                (closing, reconnect)
            };
            if let Some(connection) = closing {
                connection.close()?;
            } else if reconnect && Instant::now() < deadline {
                self.host.admit(&entry.def)?;
                let _ = entry.ensure(self.host.as_ref(), deadline);
            }
        }
        Ok(())
    }

    pub fn close(&self) -> Result<()> {
        let mut state = self.entries.lock().map_err(|_| RegistryError::Closed)?;
        state.closed = true;
        let entries = std::mem::take(&mut state.entries);
        drop(state);
        let mut failure = None;
        for entry in entries.into_values() {
            if let Some(connection) = entry.retire()? {
                if let Err(error) = connection.close() {
                    failure = Some(error);
                }
            }
        }
        failure.map_or(Ok(()), |error| Err(error.into()))
    }

    fn snapshot(&self) -> Result<Vec<Arc<Entry>>> {
        let state = self.entries.lock().map_err(|_| RegistryError::Closed)?;
        if state.closed {
            return Err(RegistryError::Closed);
        }
        Ok(state.entries.values().cloned().collect())
    }

    fn resolve(&self, name: &str, actor: &str) -> Result<Arc<Entry>> {
        let state = self.entries.lock().map_err(|_| RegistryError::Closed)?;
        if state.closed {
            return Err(RegistryError::Closed);
        }
        state
            .entries
            .get(&(Scope::Agent(actor.into()), name.into()))
            .or_else(|| state.entries.get(&(Scope::Installation, name.into())))
            .cloned()
            .ok_or(RegistryError::NotRegistered)
    }

    fn admit_entry(&self, entry: &Entry, deadline: Instant) -> Result<()> {
        if Instant::now() >= deadline {
            return Err(Error::Timeout.into());
        }
        self.host.admit(&entry.def)?;
        Ok(())
    }

    fn invoke_entry(
        &self,
        entry: &Entry,
        call: Call,
        deadline: Instant,
        principal: Option<&str>,
    ) -> Result<Value> {
        let _lease = Lease::new(entry, self.host.as_ref())?;
        let conn = entry.ensure(self.host.as_ref(), deadline)?;
        let cache = matches!(call, Call::ListTools);
        let enveloped = matches!(
            call,
            Call::CallTool { .. } | Call::ReadResource { .. } | Call::GetPrompt { .. }
        );
        let tool = match &call {
            Call::CallTool { name, .. } => Some(name.clone()),
            _ => None,
        };
        let generation = conn.tools_generation();
        match conn.invoke(call, deadline) {
            Ok(mut value) => {
                let before = enveloped.then(|| value.clone());
                self.host.redact(&entry.def, &mut value);
                let redacted = before.is_some_and(|previous| previous != value);
                if enveloped {
                    let principal = principal.ok_or(RegistryError::Invalid)?;
                    if let Some(tool) = tool {
                        value = provenance::tool_result(
                            value,
                            &entry.def.name,
                            tool,
                            principal,
                            entry.def.trust,
                            redacted,
                            entry.def.max_result_bytes,
                        );
                    } else {
                        let object = value.as_object_mut().ok_or(RegistryError::Invalid)?;
                        object.insert("server".into(), Value::String(entry.def.name.clone()));
                        let origin = provenance::origin(
                            &entry.def.name,
                            principal,
                            entry.def.trust,
                            redacted,
                            false,
                        );
                        object.insert(
                            "provenance".into(),
                            serde_json::to_value(origin).map_err(|_| RegistryError::Invalid)?,
                        );
                        value = bounded(&entry.def, value)?;
                    }
                } else {
                    value = bounded(&entry.def, value)?;
                }
                let mut state = entry.state()?;
                if state.retired {
                    return Err(RegistryError::NotRegistered);
                }
                state.reconnects = 0;
                state.last_error = None;
                if cache && generation == conn.tools_generation() {
                    state.cache = self
                        .host
                        .now()
                        .checked_add(entry.def.cache_for)
                        .map(|expires| Cache {
                            data: value.clone(),
                            expires,
                            generation,
                        });
                }
                Ok(value)
            }
            Err(error) => {
                let mut state = entry.state()?;
                state.last_error = Some(error);
                if matches!(
                    error,
                    Error::Closed | Error::Backpressure | Error::ReconnectLimit
                ) && state
                    .session
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &conn))
                {
                    state.session = None;
                    state.cache = None;
                    if entry.def.transport == Transport::Http {
                        schedule_reconnect(&mut state, self.host.now());
                    }
                }
                Err(error.into())
            }
        }
    }
}

fn cache_live(state: &State, cache: &Cache, now: Instant) -> bool {
    !state.retired
        && now < cache.expires
        && state
            .session
            .as_ref()
            .is_none_or(|conn| !conn.closed() && cache.generation == conn.tools_generation())
}

fn key(def: &Definition) -> Result<Key> {
    if def.name.is_empty()
        || def.name.len() > 64
        || !def
            .name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || def.idle_for.is_zero()
        || def.max_result_bytes == 0
        || matches!(&def.scope, Scope::Agent(agent) if agent.is_empty() || agent.chars().any(char::is_control))
    {
        return Err(RegistryError::Invalid);
    }
    Ok((def.scope.clone(), def.name.clone()))
}

fn bounded(def: &Definition, value: Value) -> Result<Value> {
    let bytes = serde_json::to_vec(&value).map_err(|_| RegistryError::ResultLimit)?;
    if bytes.len() > def.max_result_bytes {
        Err(RegistryError::ResultLimit)
    } else {
        Ok(value)
    }
}

fn schedule_reconnect(state: &mut State, now: Instant) {
    if state.reconnects >= 5 || state.retired {
        return;
    }
    let delay = Duration::from_millis(100 << state.reconnects);
    state.reconnects += 1;
    state.reconnect_at = now.checked_add(delay);
}

struct Lease<'a> {
    entry: &'a Entry,
    host: &'a dyn Host,
}

impl<'a> Lease<'a> {
    fn new(entry: &'a Entry, host: &'a dyn Host) -> Result<Self> {
        let mut state = entry.state()?;
        if state.retired {
            return Err(RegistryError::NotRegistered);
        }
        state.leases += 1;
        state.idle = None;
        Ok(Self { entry, host })
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.entry.state() {
            state.leases -= 1;
            if state.leases == 0 && state.session.is_some() && !state.retired {
                state.idle = self.host.now().checked_add(self.entry.def.idle_for);
            }
        }
    }
}
