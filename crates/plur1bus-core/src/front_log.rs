//! The front door's own lines in `logs/core.log` (P4D-7).
//!
//! The legacy core owns the log's catalogue events (`core.process.started`, `.ready`, `.stopping`) until the cut; the
//! front door adds its diagnostics as lines in the legacy format with `src: "front-door"`, through the same writer the
//! legacy core uses in TypeScript: one role lock, one rotation, the writer's redaction. Its level (`core.logLevel`) and
//! rotation (`logs.maxBytes`, `logs.keep`) are the configuration's, read from config.json at start and followed
//! through the configuration source afterwards (the supervisor's `config.watch`, or the file when no supervisor
//! answers), without the `log.level.changed` records, which the legacy core writes.
//!
//! The log is never in the front door's way:
//! - [`FrontLog::open`] only starts a thread; that thread opens the writer (which may wait for the directory's and the
//!   role's lock), follows the configuration and writes.
//! - [`FrontLog::write`] hands a line to that thread through a bounded queue, so a caller (the accept loop among them)
//!   never takes the role lock, which another writer may hold, and never waits for a sync. A line that finds the queue
//!   full is counted, and the count is written as one line.
//! - A `warn` or `error` line is synced when it is written, so a message that repeats (a refused connection under a
//!   flood) is written once per second, followed by one line with the number of repetitions in that second; the
//!   fields are the first line's (stderr has every line).
//! - [`FrontLog::close`] waits for the queue to be written, at most [`CLOSE_WAIT`]; a lock is waited for at most
//!   [`LOCK_WAIT`], after which the writer keeps the lines for its next try. At the stop there is no next try: what
//!   the lock kept out of the file then is on stderr only.
//!
//! Without a writable log the lines go to stderr alone, as before.
use crate::config::load::read_config_file;
use crate::config::source::{ConfigSource, ConfigSourceOptions, Unsubscribe};
use crate::config::watch;
use crate::logs::levels::{LevelSettings, Source};
use crate::logs::redact::TextRedactor;
use crate::logs::sink::SinkHooks;
use crate::logs::writer::{Writer, WriterOptions};
use crate::run_files::RunFiles;
use plur1bus_log_schema::Level;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The version the legacy core names in its source (`createCoreLog` in `core.ts`).
const VERSION: &str = "0.1.0";
/// What marks a line as the front door's.
const SRC: &str = "front-door";
/// Lines that may wait for the log; the front door writes a handful at its start and stop and one per refused
/// connection under a flood, which is when the rest is dropped.
const QUEUE: usize = 1024;
/// How long [`FrontLog::flush`] waits for the queue to be written.
const FLUSH_WAIT: Duration = Duration::from_secs(10);
/// How long [`FrontLog::close`] waits for the log's thread.
pub const CLOSE_WAIT: Duration = Duration::from_secs(5);
/// How long the writer waits for a lock before it keeps its lines for the next try.
pub const LOCK_WAIT: Duration = Duration::from_secs(1);
/// The window in which a repeated `warn` or `error` line is counted instead of written, and how long the log's thread
/// sits idle before it writes the counts it holds.
const WINDOW: Duration = Duration::from_secs(1);

/// What the writer takes from a configuration: the level and the rotation, each only when the value is usable.
struct Settings {
    level: Option<Level>,
    rotation: Option<(f64, i64)>,
}

fn settings(config: &Value) -> Settings {
    let level = config["core"]["logLevel"].as_str().and_then(Level::parse);
    let max_bytes = config["logs"]["maxBytes"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0);
    let keep = config["logs"]["keep"].as_i64().filter(|n| *n >= 1);
    Settings {
        level,
        rotation: max_bytes.zip(keep),
    }
}

fn levels(level: Option<Level>) -> LevelSettings {
    LevelSettings {
        default_level: level,
        ..LevelSettings::default()
    }
}

/// Applies what `config` names; a value it does not name usably keeps what is in force.
fn apply(writer: &Writer, config: &Value) {
    let s = settings(config);
    if s.level.is_some() {
        let _ = writer.adopt_levels(levels(s.level));
    }
    if let Some((max_bytes, keep)) = s.rotation {
        let _ = writer.set_rotation(max_bytes, keep);
    }
}

/// Somebody else who wants every configuration the log's source reads (the first one and each change).
pub type ConfigObserver = Arc<dyn Fn(&Value) + Send + Sync>;

/// How the configuration is followed after the start.
#[derive(Clone)]
pub struct Follow {
    /// Look the supervisor up first (`--lifeline stdin`); otherwise the file alone.
    pub supervised: bool,
    /// How often config.json is checked while it is the source; the source's default when `None`.
    pub file_poll: Option<Duration>,
    /// Told every configuration this source reads, after the log applied it: the front door has one configuration
    /// source, and what else needs a live key hears it here (`secrets.fileFallback.enabled`, P4-20 flip B1).
    pub observer: Option<ConfigObserver>,
}

/// What a test replaces.
struct Seams {
    queue: usize,
    lock_wait: Duration,
    hooks: Option<SinkHooks>,
    /// Masks every line with the values known at that moment (the mirror of the legacy core's registry, P4-20 flip A).
    redactor: Option<Arc<dyn TextRedactor>>,
}

impl Default for Seams {
    fn default() -> Seams {
        Seams {
            queue: QUEUE,
            lock_wait: LOCK_WAIT,
            hooks: None,
            redactor: None,
        }
    }
}

struct Followed {
    source: ConfigSource,
    off: Unsubscribe,
}

enum Entry {
    Line {
        level: Level,
        message: String,
        fields: Map<String, Value>,
    },
    Flush(Sender<()>),
}

/// A `warn` or `error` message written in the current window, and how often it came again since.
struct Repeated {
    fields: Map<String, Value>,
    since: Instant,
    count: u64,
}

/// The messages of the current windows. The front door's messages are fixed texts, a few dozen in all.
type Windows = HashMap<(Level, String), Repeated>;

/// One line for the repetitions counted, if any.
fn report_repeated(writer: &Writer, level: Level, message: &str, r: &Repeated) {
    if r.count == 0 {
        return;
    }
    let mut fields = r.fields.clone();
    fields.insert("line".into(), json!(message));
    fields.insert("repeated".into(), json!(r.count));
    let _ = writer.write_legacy(level, "front door log line repeated", &fields);
}

/// Ends the windows that are over (all of them with `all`) and writes their counts; returns how long the next one
/// still runs.
fn end_windows(writer: &Writer, windows: &mut Windows, all: bool) -> Duration {
    let mut next = WINDOW;
    windows.retain(|(level, message), r| {
        let age = r.since.elapsed();
        if all || age >= WINDOW {
            report_repeated(writer, *level, message, r);
            return false;
        }
        next = next.min(WINDOW - age);
        true
    });
    next
}

/// One line for the lines that found the queue full since the last one written.
fn report_dropped(writer: &Writer, dropped: &AtomicU64) {
    let n = dropped.swap(0, Ordering::SeqCst);
    if n == 0 {
        return;
    }
    let mut fields = Map::new();
    fields.insert("dropped".into(), json!(n));
    fields.insert("src".into(), json!(SRC));
    let _ = writer.write_legacy(Level::Warn, "front door log lines dropped", &fields);
}

fn write_line(
    writer: &Writer,
    windows: &mut Windows,
    level: Level,
    message: String,
    fields: Map<String, Value>,
) {
    if !level.at_least(Level::Warn) {
        let _ = writer.write_legacy(level, &message, &fields);
        return;
    }
    // The caller has ended the windows that are over, so a message found here is inside its second.
    if let Some(r) = windows.get_mut(&(level, message.clone())) {
        r.count += 1;
        return;
    }
    let _ = writer.write_legacy(level, &message, &fields);
    windows.insert(
        (level, message),
        Repeated {
            fields,
            since: Instant::now(),
            count: 0,
        },
    );
}

/// The log's thread: writes what is queued until every sender is gone, and the counts it holds when their second is
/// over, whether or not other lines keep coming.
fn drain(writer: &Writer, dropped: &AtomicU64, entries: &Receiver<Entry>) {
    let mut windows = Windows::new();
    let mut wait = WINDOW;
    loop {
        let entry = entries.recv_timeout(wait);
        end_windows(writer, &mut windows, false);
        match entry {
            Ok(Entry::Line {
                level,
                message,
                fields,
            }) => {
                report_dropped(writer, dropped);
                write_line(writer, &mut windows, level, message, fields);
            }
            Ok(Entry::Flush(done)) => {
                end_windows(writer, &mut windows, true);
                report_dropped(writer, dropped);
                let _ = writer.flush(true);
                let _ = done.send(());
            }
            Err(RecvTimeoutError::Timeout) => report_dropped(writer, dropped),
            Err(RecvTimeoutError::Disconnected) => break,
        }
        wait = end_windows(writer, &mut windows, false);
    }
    end_windows(writer, &mut windows, true);
    report_dropped(writer, dropped);
}

/// Opens `<home>/logs/core.log` with the settings of config.json (the defaults when it is missing or invalid).
fn open_writer(home: &Path, config_path: &Path, seams: &Seams) -> Option<Arc<Writer>> {
    let config = read_config_file(config_path).unwrap_or_else(|_| plur1bus_config::defaults());
    writer_for(home, &settings(&config), seams)
}

fn writer_for(home: &Path, s: &Settings, seams: &Seams) -> Option<Arc<Writer>> {
    let mut o = WriterOptions::new(
        home.join("logs"),
        "core",
        Source::new("harness", "core", Some(VERSION)),
    );
    o.levels = Some(levels(s.level));
    if let Some((max_bytes, keep)) = s.rotation {
        o.max_bytes = Some(max_bytes);
        o.keep = Some(keep);
    }
    o.lock_timeout = Some(seams.lock_wait);
    o.redactor = seams.redactor.clone();
    if let Some(hooks) = seams.hooks.clone() {
        o.hooks = hooks;
    }
    // A level the writer's policy refuses must not cost the log: the default level then.
    let mut plain = o.clone();
    plain.levels = None;
    Writer::new(o)
        .or_else(|_| Writer::new(plain))
        .ok()
        .map(Arc::new)
}

/// Follows the configuration on a thread of its own, so a supervisor that does not answer delays no line.
fn follow_config(
    writer: &Arc<Writer>,
    home: PathBuf,
    config_path: PathBuf,
    follow: Follow,
    followed: &Arc<Mutex<Option<Followed>>>,
    closed: &Arc<AtomicBool>,
) {
    let (writer, followed, closed) = (Arc::clone(writer), Arc::clone(followed), Arc::clone(closed));
    let spawned = std::thread::Builder::new()
        .name("core-config".into())
        .spawn(move || {
            // No logger: the legacy core's own source reports the same configuration events to this log.
            let mut o = ConfigSourceOptions::new(config_path, follow.supervised);
            o.connect = Some(watch::connector(home));
            o.file_poll = follow.file_poll;
            let Ok(source) = ConfigSource::open(o) else {
                return;
            };
            let observer = follow.observer.clone();
            let observed = move |writer: &Writer, config: &Value| {
                apply(writer, config);
                if let Some(observer) = &observer {
                    observer(config);
                }
            };
            let listener = {
                let (writer, observed) = (Arc::clone(&writer), observed.clone());
                Arc::new(
                    move |_: &Value, next: &Value, _: &plur1bus_config::ChangePlan| {
                        observed(&writer, next);
                    },
                )
            };
            let off = source.on_change(listener);
            // A change between the subscription and this first read was applied by the listener; reading again
            // until nothing moved keeps an older snapshot from overwriting it.
            let mut current = source.current();
            loop {
                observed(&writer, &current);
                let again = source.current();
                if again == current {
                    break;
                }
                current = again;
            }
            let mut slot = followed.lock().unwrap_or_else(PoisonError::into_inner);
            if closed.load(Ordering::SeqCst) {
                drop(slot);
                off();
                source.close();
            } else {
                *slot = Some(Followed { source, off });
            }
        });
    // Without the thread the log keeps the settings it started with.
    drop(spawned);
}

/// The front door's log: the queue to its thread, and the configuration source it follows once that has opened.
pub struct FrontLog {
    queue: Mutex<Option<SyncSender<Entry>>>,
    worker: Mutex<Option<(JoinHandle<()>, Receiver<()>)>>,
    dropped: Arc<AtomicU64>,
    followed: Arc<Mutex<Option<Followed>>>,
    closed: Arc<AtomicBool>,
    /// The redactor of [`open_masking`](Self::open_masking), for [`mask`](Self::mask).
    masker: Option<Arc<dyn TextRedactor>>,
}

impl FrontLog {
    /// Starts the log's thread, which opens `<home>/logs/core.log` with the settings of config.json, follows the
    /// configuration and writes what [`FrontLog::write`] queues. Returns at once; `None` only when the thread cannot
    /// be started. When the log cannot be opened, the lines are dropped.
    pub fn open(files: &RunFiles, follow: Follow) -> Option<FrontLog> {
        FrontLog::open_with(files, follow, Seams::default())
    }

    /// As [`open`](Self::open), with a redactor every line goes through beside the writer's own rules: the front door's
    /// lines are masked with every value the legacy core's registry holds (P4-20 flip A).
    pub fn open_masking(
        files: &RunFiles,
        follow: Follow,
        redactor: Arc<dyn TextRedactor>,
    ) -> Option<FrontLog> {
        let seams = Seams {
            redactor: Some(redactor),
            ..Seams::default()
        };
        FrontLog::open_with(files, follow, seams)
    }

    fn open_with(files: &RunFiles, follow: Follow, seams: Seams) -> Option<FrontLog> {
        let dropped = Arc::new(AtomicU64::new(0));
        let followed = Arc::new(Mutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let (lines, entries) = sync_channel(seams.queue);
        let masker = seams.redactor.clone();
        // Dropped when the thread ends, however it ends: that is how `close` learns of it.
        let (ended, end) = std::sync::mpsc::channel::<()>();
        let worker = {
            let (home, config_path) = (files.home.clone(), files.config.clone());
            let (dropped, followed, closed) = (
                Arc::clone(&dropped),
                Arc::clone(&followed),
                Arc::clone(&closed),
            );
            std::thread::Builder::new()
                .name("core-front-log".into())
                .spawn(move || {
                    let _ended = ended;
                    let Some(writer) = open_writer(&home, &config_path, &seams) else {
                        return;
                    };
                    follow_config(&writer, home, config_path, follow, &followed, &closed);
                    drain(&writer, &dropped, &entries);
                    let _ = writer.flush(true);
                    let _ = writer.close();
                })
                .ok()?
        };
        Some(FrontLog {
            queue: Mutex::new(Some(lines)),
            worker: Mutex::new(Some((worker, end))),
            dropped,
            followed,
            closed,
            masker,
        })
    }

    /// `text` with every value the masking redactor holds replaced (its exact values and their forms, none of the
    /// pattern rules): for the copy of a line that does not go through the writer, the one on stderr.
    pub fn mask(&self, text: &str) -> String {
        match self
            .masker
            .as_ref()
            .and_then(|redactor| redactor.secret_matcher())
        {
            Some(matcher) => matcher.project_text(text).text,
            None => text.to_owned(),
        }
    }

    /// One line: `{"at":…,"level":…,"role":"core",<fields>,"msg":…}`, if the level passes, with `"src":"front-door"`
    /// among the fields (in key order). A field named `src` is the caller's no longer; nothing else is renamed here
    /// (the writer keeps its own keys). Never waits: the line is queued for the log's thread (its `at` is the time
    /// that thread writes it), or counted as dropped when the queue is full.
    pub fn write(&self, level: &str, message: &str, fields: &Value) {
        let Some(level) = Level::parse(level) else {
            return;
        };
        let mut all: Map<String, Value> = fields.as_object().cloned().unwrap_or_default();
        all.insert("src".into(), json!(SRC));
        let queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(lines) = queue.as_ref() else {
            return;
        };
        let entry = Entry::Line {
            level,
            message: message.to_owned(),
            fields: all,
        };
        if lines.try_send(entry).is_err() {
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Waits until what is queued has been written (at most [`FLUSH_WAIT`] in all); the counts held are written
    /// first. For tests and tools: the front door itself never waits for its log.
    pub fn flush(&self) {
        let lines = self
            .queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(lines) = lines else {
            return;
        };
        let until = Instant::now() + FLUSH_WAIT;
        let (done, written) = std::sync::mpsc::channel();
        let mut entry = Entry::Flush(done);
        loop {
            match lines.try_send(entry) {
                Ok(()) => break,
                Err(std::sync::mpsc::TrySendError::Full(back)) if Instant::now() < until => {
                    entry = back;
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(_) => return,
            }
        }
        let _ = written.recv_timeout(until.saturating_duration_since(Instant::now()));
    }

    /// Stops following the configuration and lets the log's thread write what is queued and close the writer; waits
    /// for that at most [`CLOSE_WAIT`] (lines not written by then are on stderr only). Idempotent.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let followed = self
            .followed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(Followed { source, off }) = followed {
            off();
            source.close();
        }
        // Without its sender the log's thread writes what is queued and ends.
        drop(
            self.queue
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some((worker, end)) = worker {
            if !matches!(end.recv_timeout(CLOSE_WAIT), Err(RecvTimeoutError::Timeout)) {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for FrontLog {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
#[path = "front_log_tests.rs"]
mod tests;
