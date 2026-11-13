//! `config-source.ts`: where the core's configuration comes from (B7). The supervisor's `config.watch` (then every
//! `config.changed`), or config.json when no supervisor answers (at start, or after the watch was lost).
//!
//! The TypeScript source lives on one event loop; this one is called from several threads (the caller's, the watch's
//! reader, its own worker), so the rules the event loop gave for free are explicit here:
//!
//! - **One applier.** A candidate configuration is prepared and committed by one thread at a time. A candidate that
//!   arrives meanwhile replaces the single waiting one (never a queue of complete configurations) and is applied by the
//!   thread that is at work. TypeScript does this only while a `prepareChange` promise is pending; here it also
//!   serialises the change listeners, so they are never called concurrently or out of order.
//! - **Following a watch is atomic towards its pushes.** The listeners are registered first, then the snapshot is
//!   read and applied, and a push that arrives in between waits for that (the `following` gate). A push of a watch
//!   that is not the live one is ignored.
//! - **No lock is held across foreign code**: the watch, `prepare_change`, the privacy check and the change listeners
//!   are called with the state unlocked.
//!
//! - **A candidate belongs to the source it was taken from.** The state has an epoch that moves when a watch is
//!   followed or lost; a push or a file read that is overtaken by that while it is validated or read is dropped at the
//!   commit, under the lock that publishes. config.json is read by one thread at a time.
//! - **Foreign code that panics is contained** (the logger, the privacy rule, `prepare_change`, a listener, `Connect`);
//!   a panicking privacy rule or preparation refuses the candidate, and the applier is always released.
//!
//! Not ported: the directory watcher (`fs.watch`). TypeScript itself treats it as best effort and relies on the stat
//! poll (`FILE_POLL_MS`) for certainty; the poll is what this source has.
//!
//! Further differences from TypeScript:
//! - `open`: a first watch whose snapshot is accepted but then refused by `follow` is closed and re-watched with
//!   backoff; TypeScript keeps it open, unfollowed, and never retries.
//! - `current()` does not wait for another thread that is applying a change or reading the file: it returns what is
//!   published.
//! - The worker runs a re-watch itself, so the file poll pauses for one connect attempt, and `close` waits for it.
//! - `prepare_change`, [`EnginePrivacy`] and change listeners run inside the source's own serialisation: they may read
//!   the source but must not call `set`, `resubscribe` or `close` on it. A [`ConfigWatch`] must not call a listener
//!   from inside `on_change` or `on_close`, nor while it holds a lock that its `snapshot` takes.
//!
//! Seam (P4-11 ruling 2): the supervisor subscription is the [`ConfigWatch`] trait and [`Connect`]; the client of
//! module-api's `config-watch.ts` arrives with the flip. The shared-engine privacy rule is
//! [`assert_shared_engine_privacy`](super::policy::assert_shared_engine_privacy) unless [`EnginePrivacy`] replaces it.
use super::load::{load_config, read_config_file, validate_config, ConfigLoadError};
use super::policy::assert_shared_engine_privacy;
use super::warnings::{config_warnings, log_config_warnings};
use crate::logs::bootstrap::HarnessLogger;
use plur1bus_config::{restart_plan, ChangePlan};
use serde_json::{json, Map, Value};
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, TryLockError, Weak};
use std::thread::{JoinHandle, ThreadId};
use std::time::{Duration, Instant};

/// One `config.set` change: a dotted key and its value (what [`flatten_patch`](super::patch::flatten_patch) yields).
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    /// The dotted configuration key.
    pub key: String,
    /// The value to set.
    pub value: Value,
}

impl From<(String, Value)> for Change {
    fn from((key, value): (String, Value)) -> Self {
        Change { key, value }
    }
}

/// `config.changed`, as far as the source reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigChanged {
    /// The configuration after the change.
    pub config: Value,
    /// Its revision.
    pub revision: String,
}

/// Removes a listener.
pub type Unsubscribe = Box<dyn FnOnce() + Send>;

/// The error object a supervisor call was refused with.
#[derive(Clone, Debug, PartialEq)]
pub struct WatchError(pub Value);

/// A `config.watch` subscription on the supervisor (`ConfigWatch` of module-api).
pub trait ConfigWatch: Send + Sync {
    /// The latest configuration and its revision, read together: the `config.watch` snapshot, then each
    /// `config.changed` (also those that arrived before a listener was registered).
    fn snapshot(&self) -> (Value, String);
    /// The latest revision.
    fn revision(&self) -> String {
        self.snapshot().1
    }
    /// Registers a configuration-change listener. An implementation calls its listeners with none of its own locks
    /// held (a listener of the source may wait for a `snapshot` that another thread is reading) and never from inside
    /// `on_change` or `on_close`.
    fn on_change(&self, listener: Box<dyn Fn(&ConfigChanged) + Send + Sync>) -> Unsubscribe;
    /// Registers a listener that is called once when the subscription's connection ends (the supervisor died,
    /// dropped it, or `close` was called).
    fn on_close(&self, listener: Box<dyn Fn() + Send + Sync>) -> Unsubscribe;
    /// `config.set { changes }` on the same connection; the result object (it carries `revision`).
    fn set(&self, changes: &[Change]) -> Result<Value, WatchError>;
    /// The run-bound maintenance write on this connection; `None` when the subscription has no such method. It never
    /// falls back to `config.set`.
    fn set_during_import(
        &self,
        _run: &Value,
        _changes: &[Change],
    ) -> Option<Result<(), WatchError>> {
        None
    }
    /// Ends the subscription.
    fn close(&self);
}

/// `watchSupervisorConfig`: one attempt series (`attempts`, each bounded by the timeout); `None` when no supervisor
/// answered.
pub type Connect =
    Arc<dyn Fn(Option<u32>, Option<Duration>) -> Option<Arc<dyn ConfigWatch>> + Send + Sync>;
/// Prepares private disclosure metadata before a candidate is published (`previous`, `next`). An error keeps the last
/// accepted configuration.
pub type PrepareChange = Arc<dyn Fn(&Value, &Value) -> Result<(), String> + Send + Sync>;
/// Replaces `assertSharedEnginePrivacy(candidate, runningEngine)`: the reason when the candidate needs the running
/// engine to restart first.
pub type EnginePrivacy = Arc<dyn Fn(&Value, &Value) -> Result<(), String> + Send + Sync>;
/// Called after each accepted change, with the restart plan from `prev` to `next`.
pub type ChangeListener = Arc<dyn Fn(&Value, &Value, &ChangePlan) + Send + Sync>;

/// M1: the re-watch backoff after a lost or missing watch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    /// The first delay.
    pub initial: Duration,
    /// The longest delay (each retry doubles up to it).
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            initial: Duration::from_millis(1000),
            max: Duration::from_millis(30_000),
        }
    }
}

/// What [`ConfigSource::open`] takes.
#[derive(Clone)]
pub struct ConfigSourceOptions {
    /// `<home>/config.json`.
    pub config_path: PathBuf,
    /// Look the supervisor up first (the core runs with `--lifeline stdin`); otherwise read the file only.
    pub supervised: bool,
    /// Where the source logs.
    pub logger: Option<Arc<dyn HarnessLogger>>,
    /// The supervisor client; without one a supervised source behaves as if no supervisor answered.
    pub connect: Option<Connect>,
    /// B7: `config.watch` attempts at start (the client's default when `None`).
    pub attempts: Option<u32>,
    /// The bound of each attempt (the client's default when `None`).
    pub connect_timeout: Option<Duration>,
    /// M1: the re-watch backoff; default 1 s doubling up to 30 s.
    pub rewatch: Option<Backoff>,
    /// How often config.json is checked while it is the source; default [`FILE_POLL_MS`](super::patch::FILE_POLL_MS).
    pub file_poll: Option<Duration>,
    /// See [`PrepareChange`].
    pub prepare_change: Option<PrepareChange>,
    /// See [`EnginePrivacy`]; default the shared-engine privacy rule of `config::policy`.
    pub engine_privacy: Option<EnginePrivacy>,
}

impl ConfigSourceOptions {
    /// Options with every default.
    pub fn new(config_path: impl Into<PathBuf>, supervised: bool) -> ConfigSourceOptions {
        ConfigSourceOptions {
            config_path: config_path.into(),
            supervised,
            logger: None,
            connect: None,
            attempts: None,
            connect_timeout: None,
            rewatch: None,
            file_poll: None,
            prepare_change: None,
            engine_privacy: None,
        }
    }
}

/// Where `current()` comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    /// A watch is live.
    Supervisor,
    /// config.json.
    File,
}

impl SourceKind {
    /// The wire spelling (`supervisor`, `file`).
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Supervisor => "supervisor",
            SourceKind::File => "file",
        }
    }
}

/// Why a write through the source failed.
#[derive(Clone, Debug, PartialEq)]
pub enum SourceError {
    /// `E_NOT_AVAILABLE` with this reason (`config-policy-unavailable`, `import-config-transport`).
    NotAvailable(&'static str),
    /// The supervisor refused the call.
    Watch(WatchError),
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourceError::NotAvailable(reason) => write!(f, "E_NOT_AVAILABLE ({reason})"),
            SourceError::Watch(e) => write!(f, "{}", e.0),
        }
    }
}

impl std::error::Error for SourceError {}

struct State {
    watch: Option<Arc<dyn ConfigWatch>>,
    detach: Vec<Unsubscribe>,
    current: Value,
    /// The supervisor's revision of `current`; `None` for the file.
    revision: Option<String>,
    /// The configuration the core started with (`Null` until `open` has chosen it).
    built_with: Value,
    /// Whether `current` differs from `built_with` in a `core`-class key; recomputed per change, so `core.status`
    /// stays cheap (B11).
    pending: bool,
    closed: bool,
    file_stamp: String,
    retry_at: Option<Instant>,
    retry_delay: Duration,
    /// The thread that is preparing and committing a candidate.
    applier: Option<ThreadId>,
    /// The one candidate that arrived while the applier was at work.
    waiting: Option<Candidate>,
    /// Moves when a watch is followed or lost; a candidate of an earlier epoch is never published.
    epoch: u64,
    listeners: Vec<(u64, ChangeListener)>,
    next_listener: u64,
}

struct Shared {
    config_path: PathBuf,
    logger: Option<Arc<dyn HarnessLogger>>,
    connect: Option<Connect>,
    connect_timeout: Option<Duration>,
    backoff: Backoff,
    file_poll: Duration,
    prepare_change: Option<PrepareChange>,
    engine_privacy: Option<EnginePrivacy>,
    state: Mutex<State>,
    /// Wakes the worker (a timer changed, the source closed) and whoever waits for the applier to finish.
    wake: Condvar,
    /// Re-watches run one at a time.
    rewatching: Mutex<()>,
    /// Held while a watch is being followed; its pushes wait for it.
    following: Mutex<()>,
    /// Held while config.json is read and applied: one read at a time.
    reading: Mutex<()>,
}

fn object(fields: Value) -> Map<String, Value> {
    match fields {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn same(a: &Arc<dyn ConfigWatch>, b: &Arc<dyn ConfigWatch>) -> bool {
    Arc::ptr_eq(a, b)
}

/// What tells one state of the file from another: inode (Unix), modification and status-change time, size.
fn file_stamp(path: &Path) -> String {
    let Ok(meta) = std::fs::metadata(path) else {
        return "missing".to_string();
    };
    let nanos = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos())
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}.{}:{}",
            meta.ino(),
            nanos(meta.modified()),
            meta.ctime(),
            meta.ctime_nsec(),
            meta.len()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{}:{}:{}",
            nanos(meta.modified()),
            nanos(meta.created()),
            meta.len()
        )
    }
}

/// One configuration on its way to being published: where it came from decides whether it still may be.
struct Candidate {
    config: Value,
    /// The supervisor's revision; `None` for the file.
    revision: Option<String>,
    /// The source's epoch when this candidate was taken from the watch or the file.
    epoch: u64,
}

/// Held by the thread that prepares and commits. Should foreign code panic through `apply`, the applier is released
/// (and the waiting candidate dropped) instead of blocking every later change and every waiter for ever.
struct Applying<'a>(&'a Shared);

impl Drop for Applying<'_> {
    fn drop(&mut self) {
        let me = std::thread::current().id();
        let mut s = self.0.state();
        if s.applier == Some(me) {
            s.applier = None;
            s.waiting = None;
            self.0.wake.notify_all();
        }
    }
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// One record through the logger. A logger that panics does not unwind through the source's bookkeeping.
    fn logged(&self, fields: Value, call: impl FnOnce(&dyn HarnessLogger, &Map<String, Value>)) {
        if let Some(logger) = &self.logger {
            let fields = object(fields);
            let _ = catch_unwind(AssertUnwindSafe(|| call(logger.as_ref(), &fields)));
        }
    }

    fn info(&self, message: &str, fields: Value) {
        self.logged(fields, |logger, fields| logger.info(message, fields));
    }

    fn warn(&self, message: &str, fields: Value) {
        self.logged(fields, |logger, fields| logger.warn(message, fields));
    }

    fn error(&self, message: &str, fields: Value) {
        self.logged(fields, |logger, fields| logger.error(message, fields));
    }

    fn warn_about(&self, config: &Value) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            log_config_warnings(self.logger.as_deref(), &config_warnings(config));
        }));
    }

    /// The privacy rule against the engine the core was built with. A rule that panics refuses.
    fn privacy(&self, candidate: &Value) -> Result<(), String> {
        let engine = self.state().built_with["engine"].clone();
        catch_unwind(AssertUnwindSafe(|| match &self.engine_privacy {
            Some(check) => check(candidate, &engine),
            None => assert_shared_engine_privacy(candidate, engine.as_object())
                .map_err(|e| e.to_string()),
        }))
        .unwrap_or_else(|_| Err("the privacy rule panicked".to_string()))
    }

    /// A supervisor snapshot or push, or `None` (logged) when it fails the schema or, once the core is built, the
    /// privacy rule.
    fn accept(&self, config: &Value, revision: &str, what: &str, built: bool) -> Option<Value> {
        match validate_config(config) {
            Ok(valid) => {
                if built {
                    if let Err(err) = self.privacy(&valid) {
                        self.warn(
                            &format!(
                                "{what} requires the running engine to restart first; ignored"
                            ),
                            json!({ "err": err }),
                        );
                        return None;
                    }
                }
                Some(valid)
            }
            Err(errors) => {
                self.warn(
                    &format!("{what} is invalid; ignored"),
                    json!({ "revision": revision, "errors": errors }),
                );
                None
            }
        }
    }

    /// Publishes the candidate unless the source closed or moved on (another watch was followed, or the watch was lost)
    /// since the candidate was taken: that decision and the publication are one step under the state lock.
    fn commit(&self, candidate: &Candidate) {
        let next = &candidate.config;
        let (prev, listeners) = {
            let mut s = self.state();
            if s.closed || candidate.epoch != s.epoch {
                return;
            }
            let prev = std::mem::replace(&mut s.current, next.clone());
            s.revision.clone_from(&candidate.revision);
            s.pending = restart_plan(&s.built_with, next).restart.core;
            (prev, s.listeners.clone())
        };
        let plan = restart_plan(&prev, next);
        if plan.changed.is_empty() {
            return;
        }
        self.warn_about(next);
        for (_, listener) in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener(&prev, next, &plan))).is_err() {
                self.error("config change listener failed", json!({}));
            }
        }
    }

    fn refused_preparation(&self) {
        self.warn(
            "configuration sensitivity metadata is unavailable; the running configuration stays; repair module manifests and retry",
            json!({}),
        );
    }

    /// Prepares and commits the candidate, or leaves it as the waiting one when another thread is applying. The error
    /// is the privacy rule's refusal of the candidate itself.
    fn apply(&self, candidate: Candidate) -> Result<(), String> {
        if self.state().closed {
            return Ok(());
        }
        self.privacy(&candidate.config)?;
        {
            let mut s = self.state();
            if s.closed || candidate.epoch != s.epoch {
                return Ok(());
            }
            if s.applier.is_some() {
                // One pending candidate, not an unbounded queue of complete configurations during slow preparations.
                s.waiting = Some(candidate);
                return Ok(());
            }
            s.applier = Some(std::thread::current().id());
        }
        let _applying = Applying(self);
        let mut candidate = candidate;
        loop {
            let previous = self.state().current.clone();
            let prepared = match &self.prepare_change {
                Some(prepare) => {
                    catch_unwind(AssertUnwindSafe(|| prepare(&previous, &candidate.config)))
                        .unwrap_or_else(|_| Err("preparation panicked".to_string()))
                }
                None => Ok(()),
            };
            match prepared {
                Ok(()) => self.commit(&candidate),
                Err(_) => self.refused_preparation(),
            }
            // The candidate that arrived meanwhile, if it may run; otherwise the applier is done.
            let next = loop {
                let waiting = {
                    let mut s = self.state();
                    let waiting = if s.closed { None } else { s.waiting.take() };
                    if waiting.is_none() {
                        s.waiting = None;
                        s.applier = None;
                        self.wake.notify_all();
                    }
                    waiting
                };
                match waiting {
                    None => break None,
                    Some(c) => match self.privacy(&c.config) {
                        Ok(()) => break Some(c),
                        Err(err) => self.warn(
                            "configuration requires the running engine to restart first; ignored",
                            json!({ "err": err }),
                        ),
                    },
                }
            };
            match next {
                Some(c) => candidate = c,
                None => return Ok(()),
            }
        }
    }

    /// Waits until no candidate is being prepared. A call from the applying thread itself (a change listener or
    /// `prepare_change` that writes through the source) returns at once instead of waiting for itself.
    fn prepared_changes(&self) {
        let me = std::thread::current().id();
        let mut s = self.state();
        while s.applier.is_some_and(|t| t != me) {
            s = self.wake.wait(s).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Makes `watch` the live one: its pushes are applied from now on, then whatever it holds now is applied if it
    /// differs from what runs. False (the watch is left alone, to be closed by the caller) when its snapshot is refused
    /// or the source closed meanwhile.
    fn follow(self: &Arc<Self>, watch: &Arc<dyn ConfigWatch>) -> bool {
        let _gate = self
            .following
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let me = Arc::downgrade(self);
        let its = Arc::downgrade(watch);
        let off_change = watch.on_change(Box::new({
            let (me, its) = (me.clone(), its.clone());
            move |change: &ConfigChanged| {
                let (Some(me), Some(its)) = (me.upgrade(), its.upgrade()) else {
                    return;
                };
                // A push during `follow` waits for the snapshot to be applied.
                drop(me.following.lock().unwrap_or_else(PoisonError::into_inner));
                // One of a watch that is not the live one is dropped; the epoch is read with that check, so a push
                // that is overtaken by a re-watch while it is validated is dropped at the commit.
                let epoch = {
                    let s = me.state();
                    if !s.watch.as_ref().is_some_and(|w| same(w, &its)) {
                        return;
                    }
                    s.epoch
                };
                if let Some(config) = me.accept(
                    &change.config,
                    &change.revision,
                    "pushed configuration",
                    true,
                ) {
                    let _ = me.apply(Candidate {
                        config,
                        revision: Some(change.revision.clone()),
                        epoch,
                    });
                }
            }
        }));
        let off_close = watch.on_close(Box::new(move || {
            if let (Some(me), Some(its)) = (me.upgrade(), its.upgrade()) {
                me.lost(&its);
            }
        }));
        let (config, revision) = watch.snapshot();
        let Some(config) = self.accept(&config, &revision, "supervisor configuration", true) else {
            off_change();
            off_close();
            return false;
        };
        let (old, epoch) = {
            let mut s = self.state();
            if s.closed {
                drop(s);
                off_change();
                off_close();
                return false;
            }
            let old = std::mem::replace(&mut s.detach, vec![off_change, off_close]);
            s.watch = Some(Arc::clone(watch));
            s.retry_delay = self.backoff.initial;
            s.epoch += 1;
            (old, s.epoch)
        };
        for off in old {
            off();
        }
        let _ = self.apply(Candidate {
            config,
            revision: Some(revision),
            epoch,
        });
        true
    }

    /// M1: the connection of `watch` ended. If it is the live watch, what runs now is config.json, and re-watching
    /// starts; the end of a watch that was replaced meanwhile changes nothing.
    fn lost(self: &Arc<Self>, watch: &Arc<dyn ConfigWatch>) {
        let (detach, closed, revision) = {
            let mut s = self.state();
            if !s.watch.as_ref().is_some_and(|w| same(w, watch)) {
                return;
            }
            s.watch = None;
            s.epoch += 1;
            (std::mem::take(&mut s.detach), s.closed, s.revision.clone())
        };
        for off in detach {
            off();
        }
        if closed {
            return;
        }
        self.warn(
            "supervisor configuration watch lost; reading config.json and re-watching",
            json!({ "revision": revision }),
        );
        self.read_file();
        self.schedule_retry();
    }

    /// Applies config.json (never written here) while no watch is live; an unreadable or invalid file keeps what runs.
    /// One read at a time, so an older read cannot be published after a newer one.
    fn read_file(&self) {
        let _reading = self.reading.lock().unwrap_or_else(PoisonError::into_inner);
        self.read_file_now();
    }

    /// The caller holds `reading`.
    fn read_file_now(&self) {
        let epoch = {
            let s = self.state();
            if s.watch.is_some() || s.closed {
                return;
            }
            s.epoch
        };
        let applied = read_config_file(&self.config_path)
            .map_err(|e| e.to_string())
            .and_then(|config| {
                self.apply(Candidate {
                    config,
                    revision: None,
                    epoch,
                })
            });
        if let Err(err) = applied {
            self.warn(
                "config.json unreadable; the running configuration stays",
                json!({ "err": err }),
            );
        }
    }

    fn schedule_retry(&self) {
        let mut s = self.state();
        if s.closed || s.retry_at.is_some() || s.watch.is_some() {
            return;
        }
        let delay = s.retry_delay;
        s.retry_delay = self.backoff.max.min(delay.saturating_mul(2));
        s.retry_at = Some(Instant::now() + delay);
        self.wake.notify_all();
    }

    fn try_watch(&self, attempts: Option<u32>) -> Option<Arc<dyn ConfigWatch>> {
        let connect = self.connect.as_ref()?;
        catch_unwind(AssertUnwindSafe(|| connect(attempts, self.connect_timeout)))
            .ok()
            .flatten()
    }

    /// One re-watch. On success the new watch is followed before the old one is closed (I1); on failure config.json is
    /// read (when no watch is live) and re-watching goes on with backoff.
    fn rewatch(self: &Arc<Self>, explicit: bool) {
        let _one = self
            .rewatching
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        {
            let mut s = self.state();
            if s.closed {
                return;
            }
            s.retry_at = None;
        }
        let found = self.try_watch(Some(1));
        if self.state().closed {
            if let Some(watch) = found {
                watch.close();
            }
            return;
        }
        if let Some(watch) = found {
            let (old, from) = {
                let s = self.state();
                (s.watch.clone(), s.revision.clone())
            };
            if !self.follow(&watch) {
                watch.close();
                if self.state().watch.is_none() {
                    self.schedule_retry();
                }
                return;
            }
            self.prepared_changes();
            self.info(
                "configuration re-watched",
                json!({ "revision": watch.revision(), "previousRevision": from }),
            );
            if let Some(old) = old.filter(|old| !same(old, &watch)) {
                old.close();
            }
            return;
        }
        let live = self.state().watch.is_some();
        if explicit {
            self.warn(
                "supervisor configuration re-watch failed",
                json!({ "live": live }),
            );
        }
        if !live {
            self.read_file();
            self.prepared_changes();
            self.schedule_retry();
        }
    }

    /// Reads config.json again when it is the source and its stamp changed. When another thread is reading the file
    /// right now, that read is the refresh.
    fn refresh_file(&self) {
        let _reading = match self.reading.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return,
        };
        {
            let mut s = self.state();
            if s.watch.is_some() || s.closed {
                return;
            }
            let stamp = file_stamp(&self.config_path);
            if stamp == s.file_stamp {
                return;
            }
            s.file_stamp = stamp;
        }
        self.read_file_now();
    }

    /// The worker: the re-watch timer and the file poll.
    fn work(self: &Arc<Self>) {
        let mut next_poll = Instant::now() + self.file_poll;
        loop {
            let retry_due = {
                let mut s = self.state();
                loop {
                    if s.closed {
                        return;
                    }
                    let now = Instant::now();
                    if s.retry_at.is_some_and(|at| at <= now) || next_poll <= now {
                        break;
                    }
                    let until = s.retry_at.map_or(next_poll, |at| at.min(next_poll));
                    s = self
                        .wake
                        .wait_timeout(s, until.saturating_duration_since(now))
                        .unwrap_or_else(PoisonError::into_inner)
                        .0;
                }
                let due = s.retry_at.is_some_and(|at| at <= Instant::now());
                if due {
                    s.retry_at = None;
                }
                due
            };
            if retry_due {
                self.rewatch(false);
            }
            if next_poll <= Instant::now() {
                next_poll = Instant::now() + self.file_poll;
                self.refresh_file();
            }
        }
    }
}

/// The core's configuration source. [`close`](Self::close) ends it; dropping it closes it.
pub struct ConfigSource {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl ConfigSource {
    /// Opens the source: the supervisor's snapshot when `supervised` and one answers, else config.json. A supervised
    /// core never writes config.json (the supervisor owns it, M4), so its fallback reads without creating or migrating
    /// the file; a standalone core loads it (defaults written, migration persisted). An invalid file is the error (the
    /// core exits 2, B18).
    pub fn open(o: ConfigSourceOptions) -> Result<ConfigSource, ConfigLoadError> {
        let backoff = o.rewatch.unwrap_or_default();
        let shared = Arc::new(Shared {
            config_path: o.config_path,
            logger: o.logger,
            connect: o.connect,
            connect_timeout: o.connect_timeout,
            backoff,
            file_poll: o
                .file_poll
                .unwrap_or(Duration::from_millis(super::patch::FILE_POLL_MS)),
            prepare_change: o.prepare_change,
            engine_privacy: o.engine_privacy,
            state: Mutex::new(State {
                watch: None,
                detach: Vec::new(),
                current: Value::Null,
                revision: None,
                built_with: Value::Null,
                pending: false,
                closed: false,
                file_stamp: String::new(),
                retry_at: None,
                retry_delay: backoff.initial,
                applier: None,
                waiting: None,
                epoch: 0,
                listeners: Vec::new(),
                next_listener: 0,
            }),
            wake: Condvar::new(),
            rewatching: Mutex::new(()),
            following: Mutex::new(()),
            reading: Mutex::new(()),
        });
        let mut first = None;
        if o.supervised {
            first = shared.try_watch(o.attempts);
            if first.is_none() {
                shared.warn(
                    "supervisor configuration unavailable; reading config.json",
                    json!({}),
                );
            }
        }
        let snapshot = first.as_ref().and_then(|watch| {
            let (config, revision) = watch.snapshot();
            shared.accept(&config, &revision, "supervisor configuration", false)
        });
        if snapshot.is_none() {
            if let Some(watch) = first.take() {
                watch.close();
            }
        }
        let current = match snapshot {
            Some(config) => config,
            None if o.supervised => read_config_file(&shared.config_path)?,
            None => load_config(&shared.config_path)?.0,
        };
        {
            let mut s = shared.state();
            s.current = current.clone();
            s.built_with = current.clone();
        }
        log_config_warnings(shared.logger.as_deref(), &config_warnings(&current));
        let followed = first.as_ref().is_some_and(|watch| shared.follow(watch));
        if !followed {
            if let Some(watch) = &first {
                watch.close();
            }
            // M1: a supervised core that missed the start window keeps trying.
            if o.supervised {
                shared.schedule_retry();
            }
        }
        let worker = {
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("plur1bus-config".into())
                .spawn(move || shared.work())
                .ok()
        };
        Ok(ConfigSource {
            shared,
            worker: Mutex::new(worker),
        })
    }

    /// The configuration in force. While config.json is the source it is checked first (one `stat`).
    pub fn current(&self) -> Value {
        self.shared.refresh_file();
        self.shared.state().current.clone()
    }

    /// `supervisor` while a watch is live; `file` otherwise.
    pub fn source(&self) -> SourceKind {
        if self.shared.state().watch.is_some() {
            SourceKind::Supervisor
        } else {
            SourceKind::File
        }
    }

    /// The supervisor's revision of `current()`; `None` for the file.
    pub fn revision(&self) -> Option<String> {
        self.shared.state().revision.clone()
    }

    /// Whether `current()` differs from the configuration the core started with in a `core`-class key.
    pub fn restart_pending(&self) -> bool {
        self.shared.state().pending
    }

    /// Registers a listener that is called after each accepted change. Listeners are called one change at a time, on
    /// the thread that applied the change. A listener may read the source (`current`, `revision`, `source`) but must
    /// not call `set`, `resubscribe` or `close` on it: those can be the call it is running under.
    pub fn on_change(&self, listener: ChangeListener) -> Unsubscribe {
        let id = {
            let mut s = self.shared.state();
            s.next_listener += 1;
            let id = s.next_listener;
            s.listeners.push((id, listener));
            id
        };
        let shared: Weak<Shared> = Arc::downgrade(&self.shared);
        Box::new(move || {
            if let Some(shared) = shared.upgrade() {
                shared.state().listeners.retain(|(n, _)| *n != id);
            }
        })
    }

    /// `config.watch` again now (a new supervisor adopted the core); the difference is applied like a change. When no
    /// supervisor answers, config.json is read instead and re-watching goes on with backoff.
    pub fn resubscribe(&self) {
        self.shared.rewatch(true);
    }

    /// `config.set` on the supervisor; `None` while the configuration is the file. `Ok` means the acknowledged
    /// revision is the one in force: the reply can precede the corresponding push, so an authoritative snapshot is read
    /// in that case, and a rejected or superseded disclosure policy cannot authorise a follow-up operation.
    pub fn set(&self, changes: &[Change]) -> Option<Result<(), SourceError>> {
        const UNAVAILABLE: SourceError = SourceError::NotAvailable("config-policy-unavailable");
        let (watch, revision) = {
            let s = self.shared.state();
            (s.watch.clone()?, s.revision.clone())
        };
        if revision.as_deref() != Some(watch.revision().as_str()) {
            return Some(Err(UNAVAILABLE));
        }
        let result = match watch.set(changes) {
            Ok(result) => result,
            Err(e) => return Some(Err(SourceError::Watch(e))),
        };
        let acknowledged = result["revision"].as_str().unwrap_or_default().to_string();
        let live = |shared: &Shared| -> Option<(Arc<dyn ConfigWatch>, Option<String>)> {
            let s = shared.state();
            if s.closed {
                return None;
            }
            Some((s.watch.clone()?, s.revision.clone()))
        };
        if live(&self.shared).is_some_and(|(w, _)| w.revision() != acknowledged) {
            self.shared.rewatch(true);
        }
        self.shared.prepared_changes();
        let in_force = live(&self.shared).is_some_and(|(w, revision)| {
            w.revision() == acknowledged && revision.as_deref() == Some(acknowledged.as_str())
        });
        Some(if in_force { Ok(()) } else { Err(UNAVAILABLE) })
    }

    /// The private active-run write; an unavailable or lost supervisor is an error, never an ordinary `config.set` or
    /// a file write.
    pub fn set_during_import(&self, run: &Value, changes: &[Change]) -> Result<(), SourceError> {
        const UNAVAILABLE: SourceError = SourceError::NotAvailable("import-config-transport");
        let watch = {
            let s = self.shared.state();
            if s.closed {
                return Err(UNAVAILABLE);
            }
            s.watch.clone().ok_or(UNAVAILABLE)?
        };
        watch
            .set_during_import(run, changes)
            .ok_or(UNAVAILABLE)?
            .map_err(SourceError::Watch)
    }

    /// Ends the source: no change is applied afterwards, the watch is closed, the worker stops. Idempotent.
    pub fn close(&self) {
        let (detach, watch) = {
            let mut s = self.shared.state();
            if s.closed {
                return;
            }
            s.closed = true;
            s.waiting = None;
            s.retry_at = None;
            self.shared.wake.notify_all();
            (std::mem::take(&mut s.detach), s.watch.take())
        };
        for off in detach {
            off();
        }
        if let Some(watch) = watch {
            watch.close();
        }
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            if worker.thread().id() != std::thread::current().id() {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for ConfigSource {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plur1bus_config::defaults;
    use plur1bus_log_schema::Level;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    type Record = (String, String, Value);

    /// `capture()` of the TypeScript tests: every record with its level, message and fields.
    #[derive(Default)]
    struct Capture(Mutex<Vec<Record>>);

    impl Capture {
        fn has(&self, level: &str, message: &str) -> bool {
            self.0
                .lock()
                .unwrap()
                .iter()
                .any(|(l, m, _)| l == level && m == message)
        }

        fn fields(&self, message: &str) -> Value {
            let records = self.0.lock().unwrap();
            let found = records.iter().find(|(_, m, _)| m == message);
            found.map_or(Value::Null, |(_, _, f)| f.clone())
        }
    }

    impl HarnessLogger for Capture {
        fn log(&self, level: Level, message: &str, fields: &Map<String, Value>) {
            self.0.lock().unwrap().push((
                level.as_str().to_string(),
                message.to_string(),
                Value::Object(fields.clone()),
            ));
        }
        fn child(&self, _: &Map<String, Value>) -> Arc<dyn HarnessLogger> {
            Arc::new(Capture::default())
        }
        fn set_level(&self, _: Level) {}
        fn set_rotation(&self, _: &Value) {}
        fn close(&self) {}
    }

    type OnChange = Arc<dyn Fn(&ConfigChanged) + Send + Sync>;
    type OnClose = Arc<dyn Fn() + Send + Sync>;
    type Hook = Box<dyn FnOnce() + Send>;

    #[derive(Default)]
    struct FakeInner {
        config: Value,
        revision: String,
        change: Vec<(usize, OnChange)>,
        close: Vec<(usize, OnClose)>,
        ids: usize,
        closed: bool,
    }

    /// A `config.watch` subscription without a supervisor behind it. Listeners are called with no lock held.
    #[derive(Default)]
    struct FakeWatch {
        inner: Arc<Mutex<FakeInner>>,
        sets: Mutex<Vec<usize>>,
        runtime_sets: Mutex<Vec<(Value, usize)>>,
        /// The revision `set` acknowledges without pushing it (the reply precedes the push).
        acknowledges: Mutex<Option<String>>,
        /// The configuration `set` pushes before it answers.
        pushes_on_set: Mutex<Option<Value>>,
        /// Whether the subscription has the run-bound write.
        runtime: bool,
        /// Runs once, inside the next `on_change` registration.
        on_register: Mutex<Option<Hook>>,
        /// Runs once, after the next `snapshot` was read and before it is returned.
        on_snapshot: Mutex<Option<Hook>>,
    }

    fn next_revision() -> String {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        format!("rev-{}", NEXT.fetch_add(1, Ordering::SeqCst))
    }

    impl FakeWatch {
        fn at(config: Value, revision: &str) -> Arc<FakeWatch> {
            let watch = FakeWatch::default();
            {
                let mut inner = watch.inner.lock().unwrap();
                inner.config = config;
                inner.revision = revision.to_string();
            }
            Arc::new(watch)
        }

        fn new(config: Value) -> Arc<FakeWatch> {
            FakeWatch::at(config, &next_revision())
        }

        fn with_runtime(config: Value) -> Arc<FakeWatch> {
            let watch = FakeWatch {
                runtime: true,
                ..FakeWatch::default()
            };
            {
                let mut inner = watch.inner.lock().unwrap();
                inner.config = config;
                inner.revision = next_revision();
            }
            Arc::new(watch)
        }

        fn closed(&self) -> bool {
            self.inner.lock().unwrap().closed
        }

        /// A `config.changed`: the watch holds the new configuration, then its listeners hear of it.
        fn push_as(&self, config: Value, revision: &str) {
            let listeners: Vec<OnChange> = {
                let mut inner = self.inner.lock().unwrap();
                inner.config = config.clone();
                inner.revision = revision.to_string();
                inner.change.iter().map(|(_, l)| l.clone()).collect()
            };
            let change = ConfigChanged {
                config,
                revision: revision.to_string(),
            };
            for listener in listeners {
                listener(&change);
            }
        }

        fn push(&self, config: Value) -> String {
            let revision = next_revision();
            self.push_as(config, &revision);
            revision
        }

        /// The connection ends.
        fn end(&self) {
            let listeners: Vec<OnClose> = {
                let mut inner = self.inner.lock().unwrap();
                inner.closed = true;
                inner.close.iter().map(|(_, l)| l.clone()).collect()
            };
            for listener in listeners {
                listener();
            }
        }
    }

    impl ConfigWatch for FakeWatch {
        fn snapshot(&self) -> (Value, String) {
            let snapshot = {
                let inner = self.inner.lock().unwrap();
                (inner.config.clone(), inner.revision.clone())
            };
            let hook = self.on_snapshot.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
            snapshot
        }

        fn on_change(&self, listener: Box<dyn Fn(&ConfigChanged) + Send + Sync>) -> Unsubscribe {
            let hook = self.on_register.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
            let id = {
                let mut inner = self.inner.lock().unwrap();
                inner.ids += 1;
                let id = inner.ids;
                inner.change.push((id, Arc::from(listener)));
                id
            };
            let inner = Arc::clone(&self.inner);
            Box::new(move || inner.lock().unwrap().change.retain(|(n, _)| *n != id))
        }

        fn on_close(&self, listener: Box<dyn Fn() + Send + Sync>) -> Unsubscribe {
            let id = {
                let mut inner = self.inner.lock().unwrap();
                inner.ids += 1;
                let id = inner.ids;
                inner.close.push((id, Arc::from(listener)));
                id
            };
            let inner = Arc::clone(&self.inner);
            Box::new(move || inner.lock().unwrap().close.retain(|(n, _)| *n != id))
        }

        fn set(&self, changes: &[Change]) -> Result<Value, WatchError> {
            self.sets.lock().unwrap().push(changes.len());
            let pushed = self.pushes_on_set.lock().unwrap().clone();
            let revision = match pushed {
                Some(config) => self.push(config),
                None => self
                    .acknowledges
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| self.snapshot().1),
            };
            Ok(json!({ "revision": revision }))
        }

        fn set_during_import(
            &self,
            run: &Value,
            changes: &[Change],
        ) -> Option<Result<(), WatchError>> {
            if !self.runtime {
                return None;
            }
            self.runtime_sets
                .lock()
                .unwrap()
                .push((run.clone(), changes.len()));
            Some(Ok(()))
        }

        fn close(&self) {
            self.end();
        }
    }

    /// What answers `config.watch`: the offered watches, one per connect, and nothing after them.
    #[derive(Default)]
    struct Supervisor {
        offered: Mutex<VecDeque<Arc<FakeWatch>>>,
        attempts: Mutex<Vec<Option<u32>>>,
    }

    impl Supervisor {
        fn offering(watch: &Arc<FakeWatch>) -> Arc<Supervisor> {
            let supervisor = Arc::new(Supervisor::default());
            supervisor.offer(watch);
            supervisor
        }

        fn offer(&self, watch: &Arc<FakeWatch>) {
            self.offered.lock().unwrap().push_back(Arc::clone(watch));
        }

        fn connect(self: &Arc<Self>) -> Connect {
            let me = Arc::clone(self);
            Arc::new(move |attempts, _timeout| {
                me.attempts.lock().unwrap().push(attempts);
                let next = me.offered.lock().unwrap().pop_front();
                next.map(|watch| watch as Arc<dyn ConfigWatch>)
            })
        }
    }

    struct Home {
        _dir: tempfile::TempDir,
        path: PathBuf,
    }

    fn home_with(config: Option<&Value>) -> Home {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        if let Some(config) = config {
            std::fs::write(&path, config.to_string()).unwrap();
        }
        Home { _dir: dir, path }
    }

    fn with_level(level: &str) -> Value {
        let mut config = defaults();
        config["core"]["logLevel"] = json!(level);
        config
    }

    fn level(config: &Value) -> String {
        config["core"]["logLevel"].as_str().unwrap().to_string()
    }

    fn change(key: &str, value: Value) -> Change {
        Change {
            key: key.to_string(),
            value,
        }
    }

    fn until(what: &str, pred: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pred() {
            assert!(Instant::now() < deadline, "not in time: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn options(
        home: &Home,
        supervisor: &Arc<Supervisor>,
        log: &Arc<Capture>,
    ) -> ConfigSourceOptions {
        let mut o = ConfigSourceOptions::new(&home.path, true);
        o.logger = Some(log.clone());
        o.connect = Some(supervisor.connect());
        o.attempts = Some(1);
        o.connect_timeout = Some(Duration::from_millis(100));
        o.file_poll = Some(Duration::from_millis(20));
        o
    }

    /// A source on `watch`, with config.json holding `file`.
    fn supervised(file: &Value, watch: &Arc<FakeWatch>) -> (Home, Arc<Capture>, ConfigSource) {
        let home = home_with(Some(file));
        let log = Arc::new(Capture::default());
        let source =
            ConfigSource::open(options(&home, &Supervisor::offering(watch), &log)).unwrap();
        (home, log, source)
    }

    fn levels_seen(source: &ConfigSource) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let _keep = source.on_change(Arc::new(move |_, next, _| {
            sink.lock().unwrap().push(level(next));
        }));
        seen
    }

    #[test]
    fn a_supervised_source_serves_the_snapshot_not_the_file() {
        let watch = FakeWatch::new(with_level("debug"));
        let (_home, _log, source) = supervised(&with_level("info"), &watch);
        assert_eq!(source.source(), SourceKind::Supervisor);
        assert_eq!(level(&source.current()), "debug");
        assert_eq!(source.revision(), Some(watch.snapshot().1));
        assert!(!source.restart_pending());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let _keep = source.on_change(Arc::new(move |prev, next, plan| {
            let mut row = vec![level(prev), level(next)];
            row.extend(plan.restart.live.iter().cloned());
            sink.lock().unwrap().push(row);
        }));
        let revision = watch.push(with_level("warn"));
        assert_eq!(*seen.lock().unwrap(), [["debug", "warn", "core.logLevel"]]);
        assert_eq!(source.revision(), Some(revision));
        assert_eq!(level(&source.current()), "warn");
    }

    #[test]
    fn an_invalid_pushed_config_is_ignored_and_logged() {
        let watch = FakeWatch::new(with_level("info"));
        let (_home, log, source) = supervised(&defaults(), &watch);
        let before = source.revision();
        let seen = levels_seen(&source);
        let mut bad = with_level("info");
        bad["core"] = json!({ "logLevel": "loud" });
        watch.push_as(bad, "bad");
        assert!(log.has("warn", "pushed configuration is invalid; ignored"));
        assert_eq!(
            log.fields("pushed configuration is invalid; ignored")["revision"],
            "bad"
        );
        assert_eq!(level(&source.current()), "info");
        assert_eq!(source.revision(), before);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unreachable_supervisor_falls_back_to_the_file() {
        let home = home_with(Some(&with_level("warn")));
        let log = Arc::new(Capture::default());
        let supervisor = Arc::new(Supervisor::default());
        let source = ConfigSource::open(options(&home, &supervisor, &log)).unwrap();
        assert_eq!(source.source(), SourceKind::File);
        assert_eq!(level(&source.current()), "warn");
        assert_eq!(source.revision(), None);
        // no supervisor to send a change to
        assert!(source
            .set(&[change("core.logLevel", json!("info"))])
            .is_none());
        assert!(log.has(
            "warn",
            "supervisor configuration unavailable; reading config.json"
        ));
        assert_eq!(*supervisor.attempts.lock().unwrap(), [Some(1)]);
    }

    #[test]
    fn a_supervised_fallback_runs_the_defaults_without_creating_a_missing_config_json() {
        let home = home_with(None);
        let log = Arc::new(Capture::default());
        let source =
            ConfigSource::open(options(&home, &Arc::new(Supervisor::default()), &log)).unwrap();
        assert_eq!(source.source(), SourceKind::File);
        assert_eq!(source.current(), defaults());
        // only the supervisor writes config.json (M4)
        assert!(!home.path.exists());
    }

    #[test]
    fn a_standalone_source_loads_the_file_and_creates_a_missing_one() {
        let home = home_with(None);
        let mut o = ConfigSourceOptions::new(&home.path, false);
        o.file_poll = Some(Duration::from_millis(20));
        let source = ConfigSource::open(o).unwrap();
        assert_eq!(source.source(), SourceKind::File);
        assert_eq!(source.current(), defaults());
        assert!(home.path.exists());
        assert!(source.set(&[]).is_none());
    }

    #[test]
    fn an_invalid_file_is_the_error_of_open() {
        let home = home_with(None);
        std::fs::write(&home.path, "{\"core\":{\"logLevel\":\"loud\"}}").unwrap();
        assert!(ConfigSource::open(ConfigSourceOptions::new(&home.path, false)).is_err());
        let log = Arc::new(Capture::default());
        let supervised = options(&home, &Arc::new(Supervisor::default()), &log);
        assert!(ConfigSource::open(supervised).is_err());
    }

    #[test]
    fn restart_pending_follows_a_core_class_change() {
        let watch = FakeWatch::new(defaults());
        let (_home, _log, source) = supervised(&defaults(), &watch);
        let mut changed = defaults();
        changed["engine"]["duplicateThreshold"] = json!(1.01);
        let revision = watch.push(changed);
        assert_eq!(source.revision(), Some(revision));
        assert!(source.restart_pending());
        // back to the engine the core was built with: a live-only difference is not pending
        let revision = watch.push(with_level("debug"));
        assert_eq!(source.revision(), Some(revision));
        assert!(!source.restart_pending());
    }

    #[test]
    fn re_watching_applies_what_the_new_watch_holds_and_what_it_pushes_while_the_old_one_closes() {
        let a = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let supervisor = Supervisor::offering(&a);
        let source = ConfigSource::open(options(&home, &supervisor, &log)).unwrap();
        let seen = levels_seen(&source);
        // Supervisor B takes the home over; A's connection to the core stays open for now.
        let b = FakeWatch::new(with_level("warn"));
        b.push(with_level("error")); // behind the reply, before any listener
        supervisor.offer(&b);
        source.resubscribe();
        assert_eq!(level(&source.current()), "error");
        let revision = b.push(with_level("debug")); // after the re-watch
        assert_eq!(source.revision(), Some(revision));
        assert_eq!(level(&source.current()), "debug");
        assert_eq!(source.source(), SourceKind::Supervisor);
        assert_eq!(*seen.lock().unwrap(), ["error", "debug"]);
        assert!(log.has("info", "configuration re-watched"));
        // the re-watch closed the old watch; that, or A's connection ending, is not a lost watch
        assert!(a.closed());
        a.end();
        a.push(with_level("warn"));
        assert_eq!(source.source(), SourceKind::Supervisor);
        assert_eq!(level(&source.current()), "debug");
        assert!(!b.closed());
    }

    #[test]
    fn a_lost_watch_falls_back_to_the_file_and_re_watches_with_backoff() {
        let home = home_with(Some(&with_level("warn")));
        let log = Arc::new(Capture::default());
        let a = FakeWatch::new(with_level("debug"));
        let supervisor = Supervisor::offering(&a);
        let mut o = options(&home, &supervisor, &log);
        o.rewatch = Some(Backoff {
            initial: Duration::from_millis(20),
            max: Duration::from_millis(80),
        });
        let source = ConfigSource::open(o).unwrap();
        assert_eq!(level(&source.current()), "debug");
        a.end();
        assert_eq!(source.source(), SourceKind::File);
        // config.json runs now
        assert_eq!(level(&source.current()), "warn");
        assert_eq!(source.revision(), None);
        assert!(source
            .set(&[change("core.logLevel", json!("info"))])
            .is_none());
        assert!(log.has(
            "warn",
            "supervisor configuration watch lost; reading config.json and re-watching"
        ));
        // Several retries find nobody, then a supervisor answers.
        until("retries", || supervisor.attempts.lock().unwrap().len() >= 3);
        assert_eq!(source.source(), SourceKind::File);
        let next = FakeWatch::new(with_level("error"));
        supervisor.offer(&next);
        until("re-watched", || source.source() == SourceKind::Supervisor);
        assert_eq!(level(&source.current()), "error");
        assert_eq!(source.revision(), Some(next.snapshot().1));
        assert!(supervisor.attempts.lock().unwrap()[1..]
            .iter()
            .all(|a| *a == Some(1)));
    }

    #[test]
    fn a_failed_resubscribe_reads_the_file() {
        let home = home_with(Some(&with_level("warn")));
        let log = Arc::new(Capture::default());
        let mut o = options(&home, &Arc::new(Supervisor::default()), &log);
        o.rewatch = Some(Backoff {
            initial: Duration::from_secs(60),
            max: Duration::from_secs(60),
        });
        o.file_poll = Some(Duration::from_secs(60));
        let source = ConfigSource::open(o).unwrap();
        assert_eq!(source.source(), SourceKind::File);
        std::fs::write(&home.path, with_level("error").to_string()).unwrap(); // edited meanwhile
        source.resubscribe();
        assert_eq!(source.source(), SourceKind::File);
        assert_eq!(level(&source.current()), "error");
        assert!(log.has("warn", "supervisor configuration re-watch failed"));
        assert_eq!(
            log.fields("supervisor configuration re-watch failed")["live"],
            false
        );
    }

    #[test]
    fn a_standalone_source_follows_the_file_and_keeps_what_runs_when_it_is_unreadable() {
        let home = home_with(Some(&with_level("info")));
        let log = Arc::new(Capture::default());
        let mut o = ConfigSourceOptions::new(&home.path, false);
        o.logger = Some(log.clone());
        o.file_poll = Some(Duration::from_millis(20));
        let source = ConfigSource::open(o).unwrap();
        let seen = levels_seen(&source);
        std::fs::write(&home.path, with_level("error").to_string()).unwrap();
        // the poll finds it without anybody asking
        until("the edit", || seen.lock().unwrap().len() == 1);
        assert_eq!(*seen.lock().unwrap(), ["error"]);
        std::fs::write(&home.path, "{ not json").unwrap();
        until("the refusal", || {
            log.has(
                "warn",
                "config.json unreadable; the running configuration stays",
            )
        });
        assert_eq!(level(&source.current()), "error");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    /// `prepare_change` that blocks on the configuration with log level `warn` until the test lets it go.
    fn gated() -> (PrepareChange, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered, preparing) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let entered = Mutex::new(entered);
        let released = Mutex::new(released);
        let prepare: PrepareChange = Arc::new(move |_previous, next| {
            if level(next) == "warn" {
                entered.lock().unwrap().send(()).unwrap();
                released.lock().unwrap().recv().unwrap();
            }
            Ok(())
        });
        (prepare, preparing, release)
    }

    #[test]
    fn an_acknowledged_write_is_visible_even_when_its_notification_is_still_in_transit() {
        let home = home_with(Some(&with_level("info")));
        let log = Arc::new(Capture::default());
        let a = FakeWatch::new(with_level("info"));
        *a.acknowledges.lock().unwrap() = Some("acknowledged".to_string());
        let supervisor = Supervisor::offering(&a);
        // The authoritative snapshot a second `config.watch` returns.
        supervisor.offer(&FakeWatch::at(with_level("warn"), "acknowledged"));
        let (prepare, preparing, release) = gated();
        let mut o = options(&home, &supervisor, &log);
        o.prepare_change = Some(prepare);
        let source = Arc::new(ConfigSource::open(o).unwrap());
        let writer = {
            let source = Arc::clone(&source);
            std::thread::spawn(move || source.set(&[change("core.logLevel", json!("warn"))]))
        };
        preparing.recv_timeout(Duration::from_secs(3)).unwrap();
        // not published while its preparation runs, and the write has not returned
        assert_eq!(level(&source.current()), "info");
        assert!(!writer.is_finished());
        release.send(()).unwrap();
        assert_eq!(writer.join().unwrap(), Some(Ok(())));
        assert_eq!(level(&source.current()), "warn");
        assert_eq!(source.revision().as_deref(), Some("acknowledged"));
        assert_eq!(*a.sets.lock().unwrap(), [1]);
    }

    #[test]
    fn a_confirmed_write_whose_metadata_could_not_be_prepared_is_refused() {
        let home = home_with(Some(&with_level("info")));
        let log = Arc::new(Capture::default());
        let watch = FakeWatch::new(with_level("info"));
        *watch.pushes_on_set.lock().unwrap() = Some(with_level("warn"));
        let mut o = options(&home, &Supervisor::offering(&watch), &log);
        o.prepare_change = Some(Arc::new(|_previous, next| {
            if level(next) == "warn" {
                return Err("unavailable".to_string());
            }
            Ok(())
        }));
        let source = ConfigSource::open(o).unwrap();
        assert_eq!(
            source.set(&[change("core.logLevel", json!("warn"))]),
            Some(Err(SourceError::NotAvailable("config-policy-unavailable")))
        );
        assert_eq!(level(&source.current()), "info");
        assert!(log.has(
            "warn",
            "configuration sensitivity metadata is unavailable; the running configuration stays; repair module manifests and retry"
        ));
        // A write on a source whose revision is behind its watch is refused before it is sent.
        assert_eq!(
            source.set(&[change("core.logLevel", json!("error"))]),
            Some(Err(SourceError::NotAvailable("config-policy-unavailable")))
        );
        assert_eq!(*watch.sets.lock().unwrap(), [1]);
    }

    #[test]
    fn candidates_that_arrive_during_a_preparation_collapse_into_the_newest() {
        let watch = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let (prepare, preparing, release) = gated();
        let mut o = options(&home, &Supervisor::offering(&watch), &log);
        o.prepare_change = Some(prepare);
        let source = ConfigSource::open(o).unwrap();
        let seen = levels_seen(&source);
        let first = {
            let watch = Arc::clone(&watch);
            std::thread::spawn(move || watch.push(with_level("warn")))
        };
        preparing.recv_timeout(Duration::from_secs(3)).unwrap();
        watch.push(with_level("error")); // waits
        let newest = watch.push(with_level("debug")); // replaces it
        assert_eq!(level(&source.current()), "info");
        release.send(()).unwrap();
        first.join().unwrap();
        assert_eq!(*seen.lock().unwrap(), ["warn", "debug"]);
        assert_eq!(level(&source.current()), "debug");
        assert_eq!(source.revision(), Some(newest));
    }

    #[test]
    fn maintenance_writes_use_only_the_run_bound_method_and_never_config_set() {
        let watch = FakeWatch::with_runtime(defaults());
        let (_home, _log, source) = supervised(&defaults(), &watch);
        let run = json!({ "runId": "12345678-1234-4123-8123-123456789011" });
        let changes = [change("embedding.model", json!("fixture/model"))];
        assert_eq!(source.set_during_import(&run, &changes), Ok(()));
        assert_eq!(*watch.runtime_sets.lock().unwrap(), [(run.clone(), 1)]);
        assert!(watch.sets.lock().unwrap().is_empty());
        watch.end();
        assert_eq!(source.source(), SourceKind::File);
        // a lost private transport never falls back to config.set or a file write
        assert_eq!(
            source.set_during_import(&run, &changes),
            Err(SourceError::NotAvailable("import-config-transport"))
        );
        assert!(watch.sets.lock().unwrap().is_empty());
        // a subscription without the method
        let plain = FakeWatch::new(defaults());
        let (_home, _log, source) = supervised(&defaults(), &plain);
        assert_eq!(
            source.set_during_import(&run, &changes),
            Err(SourceError::NotAvailable("import-config-transport"))
        );
    }

    #[test]
    fn a_pushed_config_that_needs_the_running_engine_to_restart_is_ignored() {
        let watch = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let engines = Arc::new(Mutex::new(Vec::new()));
        let asked = engines.clone();
        let mut o = options(&home, &Supervisor::offering(&watch), &log);
        o.engine_privacy = Some(Arc::new(move |candidate, engine| {
            asked.lock().unwrap().push(engine.clone());
            if level(candidate) == "error" {
                return Err("local endpoints required".to_string());
            }
            Ok(())
        }));
        let source = ConfigSource::open(o).unwrap();
        let before = source.revision();
        watch.push(with_level("error"));
        assert!(log.has(
            "warn",
            "pushed configuration requires the running engine to restart first; ignored"
        ));
        assert_eq!(level(&source.current()), "info");
        assert_eq!(source.revision(), before);
        watch.push(with_level("debug"));
        assert_eq!(level(&source.current()), "debug");
        // the rule is asked against the engine the core was built with
        let engines = engines.lock().unwrap();
        assert!(!engines.is_empty());
        assert!(engines.iter().all(|e| *e == defaults()["engine"]));
    }

    #[test]
    fn a_failing_listener_is_logged_and_the_others_still_hear_the_change() {
        let watch = FakeWatch::new(with_level("info"));
        let (_home, log, source) = supervised(&defaults(), &watch);
        let _first = source.on_change(Arc::new(|_, _, _| unreachable!("listener failure")));
        let seen = levels_seen(&source);
        let dropped = Arc::new(AtomicUsize::new(0));
        let counter = dropped.clone();
        let off = source.on_change(Arc::new(move |_, _, _| {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        watch.push(with_level("warn"));
        assert!(log.has("error", "config change listener failed"));
        assert_eq!(*seen.lock().unwrap(), ["warn"]);
        off();
        watch.push(with_level("error"));
        assert_eq!(*seen.lock().unwrap(), ["warn", "error"]);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        // a push that changes nothing is not a change
        watch.push(with_level("error"));
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_closed_source_applies_nothing_and_closes_its_watch() {
        let watch = FakeWatch::new(with_level("info"));
        let (_home, _log, source) = supervised(&defaults(), &watch);
        let seen = levels_seen(&source);
        source.close();
        source.close();
        assert!(watch.closed());
        watch.push(with_level("warn"));
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(level(&source.current()), "info");
        assert_eq!(source.source(), SourceKind::File);
        assert!(source.set(&[]).is_none());
        source.resubscribe();
        assert_eq!(source.source(), SourceKind::File);
    }

    #[test]
    fn a_push_that_arrives_while_a_watch_is_being_followed_waits_for_its_snapshot() {
        let a = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let supervisor = Supervisor::offering(&a);
        let source = ConfigSource::open(options(&home, &supervisor, &log)).unwrap();
        let seen = levels_seen(&source);
        // B's snapshot is read as "warn"; before the source has applied it, B pushes "error" from its own thread.
        let b = FakeWatch::new(with_level("warn"));
        let pusher = Arc::new(Mutex::new(None));
        {
            let (watch, slot) = (Arc::clone(&b), Arc::clone(&pusher));
            *b.on_snapshot.lock().unwrap() = Some(Box::new(move || {
                let push = std::thread::spawn(move || watch.push(with_level("error")));
                *slot.lock().unwrap() = Some(push);
                std::thread::sleep(Duration::from_millis(50));
            }));
        }
        supervisor.offer(&b);
        source.resubscribe();
        let push = pusher.lock().unwrap().take().unwrap();
        let newest = push.join().unwrap();
        assert_eq!(*seen.lock().unwrap(), ["warn", "error"]);
        assert_eq!(level(&source.current()), "error");
        assert_eq!(source.revision(), Some(newest));
    }

    #[test]
    fn a_source_closed_while_a_watch_is_being_followed_does_not_keep_that_watch() {
        let a = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let supervisor = Supervisor::offering(&a);
        let source = Arc::new(ConfigSource::open(options(&home, &supervisor, &log)).unwrap());
        let b = FakeWatch::new(with_level("warn"));
        {
            let source = Arc::clone(&source);
            *b.on_register.lock().unwrap() = Some(Box::new(move || source.close()));
        }
        supervisor.offer(&b);
        source.resubscribe();
        assert!(a.closed());
        assert!(b.closed());
        assert_eq!(source.source(), SourceKind::File);
        assert_eq!(level(&source.current()), "info");
    }

    #[test]
    fn a_candidate_of_an_earlier_source_is_not_published() {
        let a = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let supervisor = Supervisor::offering(&a);
        let source = ConfigSource::open(options(&home, &supervisor, &log)).unwrap();
        let earlier = source.shared.state().epoch;
        let b = FakeWatch::new(with_level("warn"));
        supervisor.offer(&b);
        source.resubscribe();
        // A push of the old watch, and a file read, that were under way when the new watch was followed.
        for revision in [Some("of-the-old-watch".to_string()), None] {
            let overtaken = Candidate {
                config: with_level("error"),
                revision,
                epoch: earlier,
            };
            source.shared.apply(overtaken).unwrap();
            assert_eq!(level(&source.current()), "warn");
            assert_eq!(source.revision(), Some(b.snapshot().1));
        }
        // The same when the watch is lost: what was pushed just before does not overwrite the file.
        let supervised = source.shared.state().epoch;
        b.end();
        assert_eq!(source.source(), SourceKind::File);
        let late = Candidate {
            config: with_level("error"),
            revision: Some("late".to_string()),
            epoch: supervised,
        };
        source.shared.apply(late).unwrap();
        assert_eq!(source.revision(), None);
        assert_eq!(source.current(), defaults());
    }

    #[test]
    fn the_end_of_a_replaced_watch_does_not_take_the_new_one_down() {
        let a = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let supervisor = Supervisor::offering(&a);
        let source = ConfigSource::open(options(&home, &supervisor, &log)).unwrap();
        let b = FakeWatch::new(with_level("warn"));
        supervisor.offer(&b);
        source.resubscribe();
        // A's connection ended while B was being followed: its close listener gets to run only now.
        let old: Arc<dyn ConfigWatch> = a;
        source.shared.lost(&old);
        assert_eq!(source.source(), SourceKind::Supervisor);
        assert!(!b.closed());
        let revision = b.push(with_level("debug"));
        assert_eq!(source.revision(), Some(revision));
        assert!(!log.has(
            "warn",
            "supervisor configuration watch lost; reading config.json and re-watching"
        ));
    }

    #[test]
    fn a_rule_or_a_preparation_that_panics_refuses_the_candidate() {
        let watch = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let mut o = options(&home, &Supervisor::offering(&watch), &log);
        o.engine_privacy = Some(Arc::new(|candidate, _| {
            assert!(level(candidate) != "error", "rule failure");
            Ok(())
        }));
        o.prepare_change = Some(Arc::new(|_, next| {
            assert!(level(next) != "debug", "preparation failure");
            Ok(())
        }));
        let source = ConfigSource::open(o).unwrap();
        watch.push(with_level("error"));
        assert!(log.has(
            "warn",
            "pushed configuration requires the running engine to restart first; ignored"
        ));
        watch.push(with_level("debug"));
        assert!(log.has(
            "warn",
            "configuration sensitivity metadata is unavailable; the running configuration stays; repair module manifests and retry"
        ));
        assert_eq!(level(&source.current()), "info");
        let revision = watch.push(with_level("warn"));
        assert_eq!(level(&source.current()), "warn");
        assert_eq!(source.revision(), Some(revision));
    }

    #[test]
    fn a_rule_that_panics_on_the_waiting_candidate_releases_the_applier() {
        let watch = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let log = Arc::new(Capture::default());
        let (prepare, preparing, release) = gated();
        let mut o = options(&home, &Supervisor::offering(&watch), &log);
        o.prepare_change = Some(prepare);
        // The rule passes a candidate twice (as a push, on its way to the applier) and fails when the applier takes it.
        let asked = Arc::new(AtomicUsize::new(0));
        let count = asked.clone();
        o.engine_privacy = Some(Arc::new(move |candidate, _| {
            if level(candidate) == "error" {
                assert!(count.fetch_add(1, Ordering::SeqCst) < 2, "rule failure");
            }
            Ok(())
        }));
        let source = ConfigSource::open(o).unwrap();
        let first = {
            let watch = Arc::clone(&watch);
            std::thread::spawn(move || watch.push(with_level("warn")))
        };
        preparing.recv_timeout(Duration::from_secs(3)).unwrap();
        watch.push(with_level("error")); // waits
        release.send(()).unwrap();
        first.join().unwrap();
        assert_eq!(asked.load(Ordering::SeqCst), 3);
        assert_eq!(level(&source.current()), "warn");
        assert!(log.has(
            "warn",
            "configuration requires the running engine to restart first; ignored"
        ));
        // The applier was released: the next change is applied and a write does not wait for ever.
        watch.push(with_level("debug"));
        assert_eq!(level(&source.current()), "debug");
        assert_eq!(source.set(&[]), Some(Ok(())));
    }

    struct Angry;

    impl HarnessLogger for Angry {
        fn log(&self, _: Level, message: &str, _: &Map<String, Value>) {
            unreachable!("logger failure: {message}")
        }
        fn child(&self, _: &Map<String, Value>) -> Arc<dyn HarnessLogger> {
            Arc::new(Angry)
        }
        fn set_level(&self, _: Level) {}
        fn set_rotation(&self, _: &Value) {}
        fn close(&self) {}
    }

    #[test]
    fn a_logger_that_panics_does_not_stop_the_source() {
        let watch = FakeWatch::new(with_level("info"));
        let home = home_with(Some(&defaults()));
        let mut o = ConfigSourceOptions::new(&home.path, true);
        o.logger = Some(Arc::new(Angry));
        o.connect = Some(Supervisor::offering(&watch).connect());
        let source = ConfigSource::open(o).unwrap();
        let mut bad = with_level("info");
        bad["core"] = json!({ "logLevel": "loud" });
        watch.push(bad); // the refusal is logged, and the logger panics
        let revision = watch.push(with_level("warn"));
        assert_eq!(level(&source.current()), "warn");
        assert_eq!(source.revision(), Some(revision));
        watch.end(); // so is the loss of the watch
        assert_eq!(source.source(), SourceKind::File);
        assert_eq!(source.current(), defaults());
    }

    #[test]
    fn a_pushed_config_with_a_proto_key_is_ignored_and_logged_without_values() {
        let watch = FakeWatch::new(with_level("info"));
        let (_home, log, source) = supervised(&defaults(), &watch);
        let before = source.revision();
        let mut bad = defaults();
        bad["engine"] = json!({ "__proto__": { "zxq": 1 } });
        watch.push(bad);
        assert!(log.has("warn", "pushed configuration is invalid; ignored"));
        let logged = log.fields("pushed configuration is invalid; ignored");
        assert!(!logged.to_string().contains("zxq"), "{logged}");
        assert_eq!(source.revision(), before);
        assert!(source.current()["engine"].get("__proto__").is_none());
    }

    #[test]
    fn a_closed_standalone_source_does_not_read_the_file_again() {
        let home = home_with(Some(&with_level("info")));
        let mut o = ConfigSourceOptions::new(&home.path, false);
        o.file_poll = Some(Duration::from_millis(10));
        let source = ConfigSource::open(o).unwrap();
        let seen = levels_seen(&source);
        assert_eq!(level(&source.current()), "info");
        source.close();
        std::fs::write(&home.path, with_level("error").to_string()).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(level(&source.current()), "info");
        assert!(seen.lock().unwrap().is_empty());
    }
}
