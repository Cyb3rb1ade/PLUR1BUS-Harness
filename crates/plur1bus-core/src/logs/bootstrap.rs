//! `bootstrap.ts`: the one seam between the legacy call sites and the catalogue. [`CoreLog`] is the logger the core
//! starts with: it writes `core.process.started`, maps the few legacy messages that have a catalogued event, and sends
//! everything else through the writer's legacy format (still redacted). A logger failure never escapes into a timer
//! callback or a shutdown step.
//!
//! The TypeScript bootstrap flushes on `uncaughtExceptionMonitor` and on process exit. Rust has no exit hook: a panic
//! hook ([`CoreLog::install_crash_flush`]) flushes on a panic, and a normal exit calls [`HarnessLogger::close`].
use super::error::LogError;
use super::levels::LevelSettings;
use super::writer::{WriteFields, Writer, WriterOptions};
use plur1bus_log_schema::Level;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};

/// What the rest of the core logs through (`HarnessLogger` of `@plur1bus/module-api`). Fields are JSON; turning an error
/// value into its diagnostic fields is the caller's step.
pub trait HarnessLogger: Send + Sync {
    /// Delivers one record.
    fn log(&self, level: Level, message: &str, fields: &Map<String, Value>);
    /// A logger whose context is this one's plus `fields`.
    fn child(&self, fields: &Map<String, Value>) -> Arc<dyn HarnessLogger>;
    /// Changes the default level.
    fn set_level(&self, level: Level);
    /// Changes the rotation: `{ "maxBytes": number, "keep": number }`.
    fn set_rotation(&self, options: &Value);
    /// Flushes and releases the logger. Idempotent.
    fn close(&self);

    /// `debug(message, fields)`.
    fn debug(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Debug, message, fields);
    }
    /// `info(message, fields)`.
    fn info(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Info, message, fields);
    }
    /// `warn(message, fields)`.
    fn warn(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Warn, message, fields);
    }
    /// `error(message, fields)`.
    fn error(&self, message: &str, fields: &Map<String, Value>) {
        self.log(Level::Error, message, fields);
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

type CrashRegistry = Mutex<Vec<(u64, Weak<Writer>)>>;

fn crash_registry() -> &'static CrashRegistry {
    static R: OnceLock<CrashRegistry> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// The core logger.
#[derive(Clone)]
pub struct CoreLog {
    writer: Arc<Writer>,
    closed: Arc<AtomicBool>,
    base: Map<String, Value>,
    version: Option<String>,
    id: u64,
}

impl CoreLog {
    /// Opens the writer and records `core.process.started`.
    pub fn new(o: WriterOptions) -> Result<CoreLog, LogError> {
        let version = o.source.version.clone();
        let writer = Arc::new(Writer::new(o)?);
        writer.write(
            "core.process.started",
            json!({ "pid": std::process::id() }),
            WriteFields::default(),
        )?;
        Ok(CoreLog {
            writer,
            closed: Arc::new(AtomicBool::new(false)),
            base: Map::new(),
            version,
            id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
        })
    }

    /// The writer behind this logger (levels, secrets, the output framer).
    pub fn writer(&self) -> &Arc<Writer> {
        &self.writer
    }

    /// `updateLevels(settings)`.
    pub fn update_levels(&self, settings: LevelSettings) -> Result<(), LogError> {
        self.writer.update_levels(settings)
    }

    /// `currentLevels()`.
    pub fn current_levels(&self) -> LevelSettings {
        self.writer.current_levels()
    }

    /// `registerSecret(value, { pinned })`.
    pub fn register_secret(&self, value: &str, pinned: bool) -> Result<(), LogError> {
        self.writer.register_secret(value, pinned)
    }

    /// Closes every window and flushes durably; errors are ignored so that the original crash is preserved.
    pub fn crash_flush(&self) {
        let _ = self.writer.tick(true);
        let _ = self.writer.flush(true);
    }

    /// Flushes this logger's writer when the process panics (`uncaughtExceptionMonitor`). The previous panic hook still
    /// runs. [`close`](HarnessLogger::close) withdraws the registration.
    pub fn install_crash_flush(&self) {
        let mut registry = crash_registry()
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        registry.push((self.id, Arc::downgrade(&self.writer)));
        static HOOK: OnceLock<()> = OnceLock::new();
        HOOK.get_or_init(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let writers: Vec<Arc<Writer>> = crash_registry()
                    .try_lock()
                    .map(|r| r.iter().filter_map(|(_, w)| w.upgrade()).collect())
                    .unwrap_or_default();
                for writer in writers {
                    let _ = writer.tick(true);
                    let _ = writer.flush(true);
                }
                previous(info);
            }));
        });
    }

    fn deliver(
        &self,
        level: Level,
        msg: &str,
        fields: &Map<String, Value>,
    ) -> Result<(), LogError> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut f = self.base.clone();
        f.extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
        let pid = std::process::id();
        match msg {
            "core ready" => {
                self.writer.write(
                    "core.process.ready",
                    json!({ "pid": pid }),
                    WriteFields::default(),
                )?;
                return self.writer.flush(true);
            }
            "core stopped" => {
                return self.writer.write(
                    "core.process.stopping",
                    json!({ "pid": pid }),
                    WriteFields::default(),
                )
            }
            "dreams run.finished"
                if f.get("outcome").and_then(Value::as_str) == Some("skipped")
                    && f.get("reason").and_then(Value::as_str).is_some() =>
            {
                let reason = f.get("reason").and_then(Value::as_str).unwrap_or_default();
                let phase = f.get("phase").map_or("rem".to_string(), |p| {
                    p.as_str().map_or_else(|| p.to_string(), str::to_string)
                });
                return self.writer.write(
                    "scheduler.run.skipped",
                    json!({ "job": format!("dream.{phase}"), "reason": reason }),
                    WriteFields {
                        source: Some(super::levels::Source {
                            kind: "harness".into(),
                            id: "scheduler".into(),
                            version: self.version.clone(),
                        }),
                        ..WriteFields::default()
                    },
                );
            }
            "compaction.summary.created"
            | "compaction.prune.hidden"
            | "compaction.prune.restored" => {
                return self
                    .writer
                    .write(msg, Value::Object(f), WriteFields::default());
            }
            _ => {}
        }
        // Untouched callers keep the legacy wire format, but cannot bypass writer-side redaction.
        self.writer.write_legacy(level, msg, &f)
    }
}

impl HarnessLogger for CoreLog {
    fn log(&self, level: Level, message: &str, fields: &Map<String, Value>) {
        // A logger failure must not escape into Core timer callbacks or shutdown steps.
        let _ = self.deliver(level, message, fields);
    }

    fn child(&self, fields: &Map<String, Value>) -> Arc<dyn HarnessLogger> {
        let mut child = self.clone();
        child
            .base
            .extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
        Arc::new(child)
    }

    fn set_level(&self, level: Level) {
        let mut settings = self.writer.current_levels();
        settings.default_level = Some(level);
        let _ = self.writer.update_levels(settings);
    }

    fn set_rotation(&self, options: &Value) {
        let max = options
            .get("maxBytes")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN);
        let keep = options.get("keep").and_then(Value::as_i64).unwrap_or(0);
        let _ = self.writer.set_rotation(max, keep);
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        crash_registry()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|(id, _)| *id != self.id);
        let _ = self.writer.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::levels::Source;
    use crate::logs::sink::SinkHooks;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn options(dir: &Path) -> WriterOptions {
        let mut o = WriterOptions::new(dir, "core", Source::new("harness", "core", Some("0.1.0")));
        o.timers = false;
        o.hooks = SinkHooks {
            secure_path: Arc::new(|_, _| true),
            ..SinkHooks::default()
        };
        o
    }

    fn read(dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("core.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn m(v: &Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn startup_ready_and_stop_are_catalogued_events() {
        let root = tempfile::tempdir().unwrap();
        let dir: PathBuf = root.path().join("logs");
        let log = CoreLog::new(options(&dir)).unwrap();
        log.info("core ready", &Map::new());
        log.info("core stopped", &Map::new());
        log.close();
        let l = read(&dir);
        let events: Vec<&str> = l.iter().map(|r| r["event"].as_str().unwrap()).collect();
        assert_eq!(
            events,
            [
                "core.process.started",
                "core.process.ready",
                "core.process.stopping"
            ]
        );
        assert_eq!(l[0]["attrs"]["pid"], std::process::id());
    }

    #[test]
    fn legacy_messages_and_mapped_events_and_children() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        let log = CoreLog::new(options(&dir)).unwrap();
        log.warn("memory recall slow", &m(&json!({"ms": 12})));
        let child = log.child(&m(&json!({"agent": "a1"})));
        child.warn("child says", &m(&json!({"n": 1})));
        log.info(
            "dreams run.finished",
            &m(&json!({"outcome": "skipped", "reason": "idle", "phase": "deep"})),
        );
        log.info("dreams run.finished", &m(&json!({"outcome": "done"})));
        log.info("compaction.summary.created", &m(&json!({"session": "s"})));
        log.close();
        log.warn("after close", &Map::new());
        let l = read(&dir);
        let by = |msg: &str| l.iter().find(|r| r["msg"] == msg).cloned();
        let legacy = by("memory recall slow").unwrap();
        assert_eq!(legacy["role"], "core");
        assert_eq!(legacy["ms"], 12);
        assert_eq!(by("child says").unwrap()["agent"], "a1");
        let skipped = l
            .iter()
            .find(|r| r["event"] == "scheduler.run.skipped")
            .unwrap();
        assert_eq!(
            skipped["attrs"],
            json!({"job": "dream.deep", "reason": "idle"})
        );
        assert_eq!(skipped["source"]["id"], "scheduler");
        assert_eq!(skipped["source"]["version"], "0.1.0");
        assert!(
            by("dreams run.finished").is_some(),
            "a finished dream is a legacy line"
        );
        assert!(l.iter().all(|r| r["msg"] != "after close"));
    }

    #[test]
    fn levels_rotation_and_secrets_go_through_to_the_writer() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        let log = CoreLog::new(options(&dir)).unwrap();
        log.set_level(Level::Warn);
        log.info("hidden", &Map::new());
        log.warn("shown", &Map::new());
        assert_eq!(log.current_levels().default_level, Some(Level::Warn));
        log.set_rotation(&json!({"maxBytes": 0, "keep": 1}));
        log.set_rotation(&json!({"maxBytes": 100000, "keep": 3}));
        let secret = "fixture-bootstrap-0123456789-ab";
        log.register_secret(secret, true).unwrap();
        log.warn(&format!("leak {secret}"), &Map::new());
        log.close();
        let text = std::fs::read_to_string(dir.join("core.log")).unwrap();
        assert!(!text.contains("hidden") && text.contains("shown") && !text.contains(secret));
    }

    /// The crash path runs in a child process: `PLUR1BUS_LOG_CRASH_DIR` set means "log, then panic with records queued".
    #[test]
    fn crash_child() {
        let Ok(dir) = std::env::var("PLUR1BUS_LOG_CRASH_DIR") else {
            return;
        };
        let log = CoreLog::new(options(Path::new(&dir))).unwrap();
        log.install_crash_flush();
        log.info("queued before the crash", &Map::new());
        panic!("deliberate crash of the test child");
    }

    #[test]
    fn a_panic_flushes_the_queued_records() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        let me = std::env::current_exe().unwrap();
        let out = Command::new(me)
            .args([
                "--exact",
                "logs::bootstrap::tests::crash_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("PLUR1BUS_LOG_CRASH_DIR", &dir)
            .output()
            .unwrap();
        assert!(!out.status.success(), "the child must panic");
        let l = read(&dir);
        assert!(
            l.iter().any(|r| r["event"] == "core.process.started"),
            "{l:?}"
        );
        assert!(
            l.iter().any(|r| r["msg"] == "queued before the crash"),
            "{l:?}"
        );
    }
}
