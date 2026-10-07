//! Local-only crash foundation. Task 3 installs the hook during native startup and presents the
//! `pending` offers in the shell. This module installs nothing by importing it and exposes no IPC.
//!
//! The hook never chains the previous/default hook. A prestarted worker writes a private metadata
//! fallback first, then replaces it with formatted details. The hook waits at most 500 ms for that
//! worker (excluding the platform's stack capture). Busy/poisoned writer or redactor locks are never
//! waited on. Filesystem/symbolisation delays cannot extend the worker wait; a pending fallback may
//! remain when that budget expires. No upload, opener, or arbitrary-path operation exists here.
use crate::logging::{self, EmitStatus, Event, LogError, RecordInput, Result, Writer};
use std::{
    backtrace::Backtrace,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

const MAGIC: &str = "PLUR1BUS desktop crash v1\n";
const UNAVAILABLE: &str = "[REDACTED:unavailable]";
const MAX_CRASH: usize = 3 * 1024 * 1024;
static HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);

/// An opaque owned crash offer. Render/copy `details` as plain text; never HTML or instructions.
/// Calling `pending` does not consume it. Call `mark_handled` only after explicit user handling.
#[derive(Clone)]
pub struct PendingCrash {
    id: String,
    details: String,
    directory: PathBuf,
}
impl PendingCrash {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn details(&self) -> &str {
        &self.details
    }
}
#[derive(Clone)]
pub struct CrashReporter {
    writer: Writer,
    target: String,
    offers: Arc<Mutex<()>>,
}
struct PanicJob {
    message: String,
    backtrace: Backtrace,
    finished: mpsc::SyncSender<()>,
}
impl CrashReporter {
    /// The writer's existing private directory is the sole crash destination. `target` is a native build target.
    pub fn new(writer: Writer, target: &str) -> Result<Self> {
        if target.is_empty()
            || target.len() > 128
            || !target
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(LogError::Invalid("build target"));
        }
        Ok(Self {
            writer,
            target: target.into(),
            offers: Arc::new(Mutex::new(())),
        })
    }
    /// Install exactly once, explicitly during native startup. Replaces (never invokes) any previous hook.
    /// A full queue or concurrent panic returns immediately. The worker owns all filesystem and formatting work.
    pub fn install_hook(&self) -> Result<()> {
        if HOOK_INSTALLED
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(LogError::Invalid("crash hook already installed"));
        }
        let (sender, receiver) = mpsc::sync_channel::<PanicJob>(1);
        let reporter = self.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("desktop-crash-writer".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    let _ = reporter.persist(&job);
                    let _ = job.finished.try_send(());
                }
            })
        {
            HOOK_INSTALLED.store(false, Ordering::SeqCst);
            return Err(error.into());
        }
        let handling = Arc::new(AtomicBool::new(false));
        std::panic::set_hook(Box::new(move |info| {
            if handling.swap(true, Ordering::SeqCst) {
                return;
            }
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
                .unwrap_or("non-string panic payload");
            // Drop oversized input entirely: truncating a raw credential could evade exact-value redaction.
            let mut message = if payload.len() <= 16 * 1024 {
                payload.to_owned()
            } else {
                "[REDACTED:limit]".into()
            };
            if let Some(location) = info.location() {
                let file = location.file();
                if file.len() <= 4096 {
                    message.push_str(&format!(
                        "\nLocation: {file}:{}:{}",
                        location.line(),
                        location.column()
                    ));
                }
            }
            let (done, wait) = mpsc::sync_channel(1);
            let job = PanicJob {
                message,
                backtrace: Backtrace::force_capture(),
                finished: done,
            };
            if sender.try_send(job).is_ok() {
                let _ = wait.recv_timeout(Duration::from_millis(500));
            }
            handling.store(false, Ordering::SeqCst);
        }));
        Ok(())
    }
    fn persist(&self, job: &PanicJob) -> Result<()> {
        let directory = self.writer.directory();
        // System time avoids an application-supplied clock locking inside a panic path.
        let name = format!(
            "crash-{}-{}.txt",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            uuid::Uuid::now_v7()
        );
        let mut file = directory.create(&name)?;
        let fallback=format!("{MAGIC}Redaction: failed\nVersion: {UNAVAILABLE}\nTarget: {UNAVAILABLE}\nPanic: {UNAVAILABLE}\nBacktrace: {UNAVAILABLE}\nRecent logs: {UNAVAILABLE}\n");
        logging::write_crash(&mut file, &fallback)?;
        directory.sync()?;
        let formatter = self.writer.formatter();
        let failed = std::cell::Cell::new(false);
        let scrub = |value: &str| {
            formatter.redact_text(value).unwrap_or_else(|_| {
                failed.set(true);
                UNAVAILABLE.into()
            })
        };
        let version = scrub(self.writer.version().unwrap_or("unknown"));
        let target = scrub(&self.target);
        let panic = scrub(&job.message);
        let recent = self
            .writer
            .recent_lines()
            .map(|lines| {
                lines
                    .iter()
                    .map(|line| {
                        self.writer.sanitize_record_line(line).unwrap_or_else(|_| {
                            failed.set(true);
                            UNAVAILABLE.into()
                        })
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_else(|_| {
                failed.set(true);
                UNAVAILABLE.into()
            });
        // Persist useful sanitized evidence before potentially slow OS symbolisation.
        let redaction = if failed.get() { "failed" } else { "ok" };
        let essential=format!("{MAGIC}Redaction: {redaction}\nVersion: {version}\nTarget: {target}\nPanic: {panic}\nBacktrace: {UNAVAILABLE}\nRecent logs:\n{recent}\n");
        if essential.len() <= MAX_CRASH {
            logging::write_crash(&mut file, &essential)?;
        }
        let backtrace = scrub(&format!("{}", job.backtrace));
        let redaction = if failed.get() { "failed" } else { "ok" };
        let details=format!("{MAGIC}Redaction: {redaction}\nVersion: {version}\nTarget: {target}\nPanic: {panic}\nBacktrace:\n{backtrace}\nRecent logs:\n{recent}\n");
        if details.len() <= MAX_CRASH {
            logging::write_crash(&mut file, &details)?;
        }
        Ok(())
    }
    /// Discover owned pending reports. Emits a fatal event once per durable startup receipt, but keeps
    /// offering unhandled evidence on subsequent starts. A failed event/receipt leaves it pending.
    /// Task 3 calls this after creating the writer, then offers Copy details / Open folder in the shell.
    pub fn pending(&self) -> Result<Vec<PendingCrash>> {
        // Startup IPC and native observers can query the same reporter together.
        // Serialize formatter use and durable receipts; the panic worker never takes this lock.
        let _offers = self.offers.lock().map_err(|_| LogError::Busy)?;
        let directory = self.writer.directory();
        let mut names = directory.names()?;
        names.sort();
        let mut pending = Vec::new();
        for name in names {
            if !owned_crash_name(&name) {
                continue;
            }
            if directory.has_receipt(&format!("{name}.handled"))? {
                continue;
            }
            let text = match directory.read(&name, MAX_CRASH) {
                Ok(text) if text.starts_with(MAGIC) => text,
                _ => continue,
            };
            let details = self.sanitize_details(&text);
            if !directory.has_receipt(&format!("{name}.seen"))? {
                if text.starts_with(&format!("{MAGIC}Redaction: failed\n")) {
                    self.writer.crash_redaction_failed()?;
                }
                let status = self.writer.emit(RecordInput::new(Event::AppCrashed {
                    crash_id: name.clone(),
                }))?;
                if status == EmitStatus::Written {
                    directory.receipt(&format!("{name}.seen"))?;
                }
            }
            pending.push(PendingCrash {
                id: name,
                details,
                directory: directory.path().to_path_buf(),
            });
        }
        Ok(pending)
    }
    fn sanitize_details(&self, text: &str) -> String {
        let Some((header, lines)) = text.rsplit_once("\nRecent logs:\n") else {
            return self
                .writer
                .formatter()
                .redact_text(text)
                .unwrap_or_else(|_| format!("{MAGIC}{UNAVAILABLE}\n"));
        };
        let header = self
            .writer
            .formatter()
            .redact_text(header)
            .unwrap_or_else(|_| format!("{MAGIC}{UNAVAILABLE}"));
        let lines = lines
            .lines()
            .map(|line| {
                self.writer
                    .sanitize_record_line(line)
                    .unwrap_or_else(|_| UNAVAILABLE.into())
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("{header}\nRecent logs:\n{lines}\n")
    }
    /// Explicit user handling only. Persists a private receipt; retains the crash evidence itself.
    pub fn mark_handled(&self, offer: &PendingCrash) -> Result<()> {
        let _offers = self.offers.lock().map_err(|_| LogError::Busy)?;
        let directory = self.writer.directory();
        if offer.directory != directory.path() || !owned_crash_name(&offer.id) {
            return Err(LogError::Invalid("crash offer owner"));
        }
        if !directory.read(&offer.id, MAX_CRASH)?.starts_with(MAGIC) {
            return Err(LogError::Invalid("crash file"));
        }
        directory.receipt(&format!("{}.handled", offer.id))?;
        Ok(())
    }
    /// Trusted native integration may open this fixed owned folder after a user click. Never accept a renderer path.
    pub fn folder(&self) -> &Path {
        self.writer.directory_path()
    }
}
fn owned_crash_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("crash-")
        .and_then(|s| s.strip_suffix(".txt"))
    else {
        return false;
    };
    let Some((stamp, id)) = stem.split_once("Z-") else {
        return false;
    };
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%S%.3f").is_ok()
        && uuid::Uuid::parse_str(id).is_ok_and(|v| v.to_string() == id)
}
