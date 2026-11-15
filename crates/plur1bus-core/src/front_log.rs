//! The front door's own lines in `logs/core.log` (P4D-7).
//!
//! The legacy core owns the log's catalogue events (`core.process.started`, `.ready`, `.stopping`) until the cut; the
//! front door adds its diagnostics as lines in the legacy format with `src: "front-door"`, through the same writer the
//! legacy core uses in TypeScript: one role lock, one rotation, the writer's redaction. Its level (`core.logLevel`) and
//! rotation (`logs.maxBytes`, `logs.keep`) are the configuration's, read from config.json at start and followed
//! through the configuration source afterwards (the supervisor's `config.watch`, or the file when no supervisor
//! answers), without the `log.level.changed` records, which the legacy core writes.
//!
//! Nothing here can stop the front door or make it wait. A line is handed to a thread of the log's own through a
//! bounded queue, so a caller (the accept loop among them) never takes the role lock, which another writer may hold
//! for seconds, and never waits for a sync; lines the log cannot take in time are dropped and counted in one line of
//! their own. Without a writable log the lines go to stderr alone, as before.
use crate::config::load::read_config_file;
use crate::config::source::{ConfigSource, ConfigSourceOptions, Unsubscribe};
use crate::config::watch;
use crate::logs::levels::{LevelSettings, Source};
use crate::logs::writer::{Writer, WriterOptions};
use crate::run_files::RunFiles;
use plur1bus_log_schema::Level;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Sender, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

/// The version the legacy core names in its source (`createCoreLog` in `core.ts`).
const VERSION: &str = "0.1.0";
/// What marks a line as the front door's.
const SRC: &str = "front-door";
/// Lines that may wait for the log; the front door writes a handful at its start and stop and one per refused
/// connection under a flood, which is when the rest is dropped.
const QUEUE: usize = 1024;
/// How long [`FrontLog::flush`] waits for the queue to be written.
const FLUSH_WAIT: Duration = Duration::from_secs(10);

enum Entry {
    Line {
        level: Level,
        message: String,
        fields: Map<String, Value>,
    },
    Flush(Sender<()>),
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

fn drain(writer: &Writer, dropped: &AtomicU64, entries: std::sync::mpsc::Receiver<Entry>) {
    for entry in entries {
        report_dropped(writer, dropped);
        match entry {
            Entry::Line {
                level,
                message,
                fields,
            } => {
                let _ = writer.write_legacy(level, &message, &fields);
            }
            Entry::Flush(done) => {
                let _ = writer.flush(true);
                let _ = done.send(());
            }
        }
    }
    report_dropped(writer, dropped);
}

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

fn apply(writer: &Writer, config: &Value) {
    let s = settings(config);
    // A level the policy refuses (`trace` without an expiry) keeps the level in force.
    let _ = writer.adopt_levels(levels(s.level));
    if let Some((max_bytes, keep)) = s.rotation {
        let _ = writer.set_rotation(max_bytes, keep);
    }
}

/// How the configuration is followed after the start.
#[derive(Clone, Copy)]
pub struct Follow {
    /// Look the supervisor up first (`--lifeline stdin`); otherwise the file alone.
    pub supervised: bool,
    /// How often config.json is checked while it is the source; the source's default when `None`.
    pub file_poll: Option<Duration>,
}

struct Followed {
    source: ConfigSource,
    off: Unsubscribe,
}

/// The front door's log: the writer behind its queue, and the configuration source it follows once that has opened.
pub struct FrontLog {
    writer: Arc<Writer>,
    queue: Mutex<Option<SyncSender<Entry>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    dropped: Arc<AtomicU64>,
    followed: Arc<Mutex<Option<Followed>>>,
    closed: Arc<AtomicBool>,
}

impl FrontLog {
    /// Opens `<home>/logs/core.log` with the settings of config.json (the defaults when it is missing or invalid) and
    /// starts following the configuration on a thread of its own, so a supervisor that does not answer never delays
    /// the start. `None` when the log cannot be opened.
    pub fn open(files: &RunFiles, follow: Follow) -> Option<FrontLog> {
        FrontLog::open_with(files, follow, QUEUE)
    }

    fn open_with(files: &RunFiles, follow: Follow, queue: usize) -> Option<FrontLog> {
        let config =
            read_config_file(&files.config).unwrap_or_else(|_| plur1bus_config::defaults());
        let s = settings(&config);
        let mut o = WriterOptions::new(
            files.home.join("logs"),
            "core",
            Source::new("harness", "core", Some(VERSION)),
        );
        o.levels = Some(levels(s.level));
        if let Some((max_bytes, keep)) = s.rotation {
            o.max_bytes = Some(max_bytes);
            o.keep = Some(keep);
        }
        let writer = Arc::new(Writer::new(o).ok()?);
        let dropped = Arc::new(AtomicU64::new(0));
        let (lines, entries) = sync_channel(queue);
        let worker = {
            let (writer, dropped) = (Arc::clone(&writer), Arc::clone(&dropped));
            std::thread::Builder::new()
                .name("core-front-log".into())
                .spawn(move || drain(&writer, &dropped, entries))
                .ok()?
        };
        let log = FrontLog {
            writer,
            queue: Mutex::new(Some(lines)),
            worker: Mutex::new(Some(worker)),
            dropped,
            followed: Arc::new(Mutex::new(None)),
            closed: Arc::new(AtomicBool::new(false)),
        };
        log.follow(files.home.clone(), files.config.clone(), follow);
        Some(log)
    }

    fn follow(&self, home: PathBuf, config_path: PathBuf, follow: Follow) {
        let (writer, followed, closed) = (
            Arc::clone(&self.writer),
            Arc::clone(&self.followed),
            Arc::clone(&self.closed),
        );
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
                let listener = {
                    let writer = Arc::clone(&writer);
                    Arc::new(
                        move |_: &Value, next: &Value, _: &plur1bus_config::ChangePlan| {
                            apply(&writer, next);
                        },
                    )
                };
                let off = source.on_change(listener);
                apply(&writer, &source.current());
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

    /// Waits until what is queued has been written, durably (at most [`FLUSH_WAIT`]).
    pub fn flush(&self) {
        let lines = self
            .queue
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(lines) = lines else {
            return;
        };
        let (done, written) = std::sync::mpsc::channel();
        if lines.send(Entry::Flush(done)).is_ok() {
            let _ = written.recv_timeout(FLUSH_WAIT);
        }
    }

    /// Stops following the configuration, writes what is queued and closes the writer. Idempotent.
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
        if let Some(worker) = worker {
            let _ = worker.join();
        }
        let _ = self.writer.flush(true);
        let _ = self.writer.close();
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
