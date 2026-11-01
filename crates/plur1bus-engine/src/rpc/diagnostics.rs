//! Content-free process diagnostics on stderr, validated by the shared D111 catalogue.
//!
//! Callers supply only closed categories and OS errors; foreign error text, paths,
//! request parameters, credentials and memory content cannot enter a record.

use std::io::{self, Write};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

/// Process lifecycle transitions, separate from model/memory readiness.
#[derive(Clone, Copy)]
pub enum Lifecycle {
    /// Endpoint and identity files are ready.
    Started,
    /// The active parent connection or stdin lifeline was lost.
    Orphaned,
    /// A proved supervisor connection replaced the lifeline.
    Adopted,
    /// The common shutdown deadline has started.
    Stopping,
    /// The serving scope closed its run files.
    Stopped,
}

impl Lifecycle {
    fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Orphaned => "orphaned",
            Self::Adopted => "adopted",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
        }
    }
}

/// Fixed causes; never substitute a provider or operation's message.
#[derive(Clone, Copy)]
pub enum Reason {
    /// Endpoint startup completed.
    Ready,
    /// The parent stdin pipe closed.
    StdinClosed,
    /// The currently adopted connection closed.
    ConnectionClosed,
    /// Supervisor adoption succeeded.
    Adopted,
    /// An authenticated shutdown request was accepted.
    Shutdown,
    /// No replacement parent arrived before the orphan grace.
    GraceExpired,
    /// An OS shutdown signal was received.
    Signal,
    /// The local listener suffered a permanent failure.
    TransportFatal,
    /// The common shutdown budget expired.
    Deadline,
    /// Startup could not finish.
    StartupFailed,
    /// The nonce identifies a live process with the same start identity.
    StampOwnerLive,
    /// The job-lock age rule still protects an unproven nonce stamp.
    StampAgeRule,
    /// Another process holds the primary OS lock for this home.
    ProcessLockHeld,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::StdinClosed => "stdin-closed",
            Self::ConnectionClosed => "connection-closed",
            Self::Adopted => "adopted",
            Self::Shutdown => "shutdown",
            Self::GraceExpired => "grace-expired",
            Self::Signal => "signal",
            Self::TransportFatal => "transport-fatal",
            Self::Deadline => "deadline",
            Self::StartupFailed => "startup-failed",
            Self::StampOwnerLive => "stamp-owner-live",
            Self::StampAgeRule => "stamp-age-rule",
            Self::ProcessLockHeld => "process-lock-held",
        }
    }
}

/// The local boundary that failed, without any operation arguments.
#[derive(Clone, Copy)]
pub enum Stage {
    /// Process initialization.
    Startup,
    /// Listener creation.
    Listen,
    /// Native accept/poll boundary.
    Accept,
    /// A bounded worker could not start.
    Spawn,
    /// Resource shutdown.
    Close,
    /// A local peer's transport boundary.
    Peer,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Startup => "startup",
            Self::Listen => "listen",
            Self::Accept => "accept",
            Self::Spawn => "spawn",
            Self::Close => "close",
            Self::Peer => "peer",
        }
    }
}

#[derive(Serialize)]
struct Source {
    kind: &'static str,
    id: &'static str,
    version: &'static str,
}

// Field order follows record.schema.json's x-key-order, including omitted optional fields.
#[derive(Serialize)]
struct Record {
    ts: String,
    level: &'static str,
    source: Source,
    event: &'static str,
    msg: &'static str,
    attrs: Value,
}

fn render(
    event: &'static str,
    level: &'static str,
    msg: &'static str,
    attrs: Value,
) -> Option<String> {
    let line = serde_json::to_string(&Record {
        ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        source: Source {
            kind: "harness",
            id: "engine",
            version: crate::CRATE_VERSION,
        },
        event,
        msg,
        attrs,
    })
    .ok()?;
    if line.len() > plur1bus_log_schema::limits().line_bytes {
        return None;
    }
    plur1bus_log_schema::validate_line(&line).ok()?;
    Some(line)
}

fn lifecycle_line(state: Lifecycle, reason: Reason) -> Option<String> {
    render(
        "engine.process.lifecycle",
        "info",
        "engine process lifecycle changed",
        json!({"state":state.as_str(),"reason":reason.as_str(),"pid":std::process::id()}),
    )
}

fn error_kind(error: &io::Error) -> &'static str {
    #[cfg(unix)]
    if error.raw_os_error().is_some_and(|code| {
        [
            libc::EMFILE,
            libc::ENFILE,
            libc::ENOMEM,
            libc::ENOSPC,
            libc::EAGAIN,
        ]
        .contains(&code)
    }) {
        return "resource-limit";
    }
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(4 | 8 | 14 | 1450)) {
        return "resource-limit";
    }
    match error.kind() {
        io::ErrorKind::PermissionDenied => "permission",
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => "invalid-input",
        io::ErrorKind::BrokenPipe
        | io::ErrorKind::UnexpectedEof
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::NotConnected
        | io::ErrorKind::WriteZero => "connection-closed",
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => "timeout",
        io::ErrorKind::Interrupted => "interrupted",
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::Unsupported => "unsupported",
        io::ErrorKind::OutOfMemory => "resource-limit",
        _ => "other",
    }
}

fn failure_line(stage: Stage, error: &io::Error) -> Option<String> {
    let mut attrs =
        json!({"stage":stage.as_str(),"error_kind":error_kind(error),"pid":std::process::id()});
    if let Some(code) = error.raw_os_error() {
        attrs["os_error"] = json!(code);
    }
    render(
        "engine.process.error",
        "warn",
        "engine local boundary failed",
        attrs,
    )
}

enum Command {
    Line(String),
    Flush(mpsc::SyncSender<()>),
}

struct Queue(mpsc::SyncSender<Command>);

static QUEUE: OnceLock<Option<Queue>> = OnceLock::new();

impl Queue {
    fn new(mut sink: impl Write + Send + 'static) -> Option<Self> {
        let (sender, receiver) = mpsc::sync_channel(64);
        let _worker = std::thread::Builder::new()
            .name("engine-diagnostics".into())
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    match command {
                        Command::Line(line) => {
                            let _ = writeln!(sink, "{line}");
                        }
                        Command::Flush(done) => {
                            let _ = sink.flush();
                            let _ = done.try_send(());
                        }
                    }
                }
            })
            .ok()?;
        Some(Self(sender))
    }

    fn write(&self, line: String) {
        // A slow or abandoned stderr cannot stall serving or the shutdown deadline.
        // Full queues drop diagnostics; never allocate unbounded buffers or spawn per line.
        let _ = self.0.try_send(Command::Line(line));
    }

    fn flush(&self, timeout: Duration) {
        let (sender, receiver) = mpsc::sync_channel(1);
        if self.0.try_send(Command::Flush(sender)).is_ok() {
            let _ = receiver.recv_timeout(timeout);
        }
    }
}

fn queue() -> Option<&'static Queue> {
    QUEUE.get_or_init(|| Queue::new(io::stderr())).as_ref()
}

/// Whether structured diagnostics have been initialized, including a failed writer start.
/// Runtime exit paths must not fall back to a blocking stderr write: the diagnostic
/// worker may already be blocked on that same stream's lock or pipe.
pub fn initialized() -> bool {
    QUEUE.get().is_some()
}

fn write(line: Option<String>) {
    if let (Some(line), Some(queue)) = (line, queue()) {
        queue.write(line);
    }
}

/// Emit one fixed lifecycle category; stdout remains exclusively the readiness protocol.
pub fn lifecycle(state: Lifecycle, reason: Reason) {
    write(lifecycle_line(state, reason));
}

/// Emit only the OS error class/number; `error.to_string()` is deliberately never evaluated.
pub fn failure(stage: Stage, error: &io::Error) {
    write(failure_line(stage, error));
}

/// Best-effort flush bounded by the caller's remaining shutdown budget.
pub fn flush(timeout: Duration) {
    if let Some(queue) = queue() {
        queue.flush(timeout);
    }
}

#[cfg(test)]
mod tests {
    // Synthetic diagnostics must validate; failed fixture setup is a failing test.
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    #[test]
    fn blocked_stderr_never_blocks_producers_or_grows_the_queue() {
        struct BlockedSink {
            started: Option<mpsc::Sender<()>>,
            release: mpsc::Receiver<()>,
        }
        impl Write for BlockedSink {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if let Some(started) = self.started.take() {
                    started.send(()).map_err(io::Error::other)?;
                    self.release.recv().map_err(io::Error::other)?;
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        struct Release(Option<mpsc::Sender<()>>);
        impl Drop for Release {
            fn drop(&mut self) {
                if let Some(sender) = self.0.take() {
                    let _ = sender.send(());
                }
            }
        }
        let (started, waiting) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let release = Release(Some(release));
        let queue = Queue::new(BlockedSink {
            started: Some(started),
            release: resume,
        })
        .unwrap();
        queue.write("first record".into());
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        let producer = Queue(queue.0.clone());
        let (done, finished) = mpsc::channel();
        let producer = std::thread::Builder::new()
            .spawn(move || {
                for _ in 0..256 {
                    producer.write("bounded record".into());
                }
                // The sink has not been released; the queue must now be full, not growing.
                assert!(matches!(
                    producer.0.try_send(Command::Line("extra".into())),
                    Err(mpsc::TrySendError::Full(_))
                ));
                done.send(()).unwrap();
            })
            .unwrap();
        finished
            .recv_timeout(Duration::from_secs(5))
            .expect("blocked stderr must not block the engine");
        drop(release);
        producer.join().unwrap();
    }

    #[test]
    fn lifecycle_records_validate_and_keep_the_shared_key_order() {
        for (state, reason) in [
            (Lifecycle::Started, Reason::Ready),
            (Lifecycle::Orphaned, Reason::StdinClosed),
            (Lifecycle::Adopted, Reason::Adopted),
            (Lifecycle::Stopping, Reason::Signal),
            (Lifecycle::Stopped, Reason::Shutdown),
            (Lifecycle::Stopped, Reason::StampOwnerLive),
            (Lifecycle::Stopped, Reason::StampAgeRule),
            (Lifecycle::Stopped, Reason::ProcessLockHeld),
        ] {
            let line = lifecycle_line(state, reason).expect("registered lifecycle record");
            assert!(plur1bus_log_schema::validate_line(&line).is_ok());
            assert!(line.starts_with("{\"ts\":"));
            assert!(line.len() < 512);
        }
    }

    #[test]
    fn injected_error_content_is_absent_from_the_diagnostic() {
        let error = io::Error::other("PRIVATE-MEMORY credential=FAKE-value Bearer FAKE-token");
        let line = failure_line(Stage::Peer, &error).expect("registered error record");
        assert!(
            !line.contains("PRIVATE") && !line.contains("credential") && !line.contains("FAKE")
        );
        assert!(plur1bus_log_schema::validate_line(&line).is_ok());
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["attrs"]["error_kind"], "other");
        assert_eq!(value["attrs"].as_object().unwrap().len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_exhaustion_has_a_fixed_class_and_the_errno() {
        let line =
            failure_line(Stage::Accept, &io::Error::from_raw_os_error(libc::EMFILE)).unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["attrs"]["error_kind"], "resource-limit");
        assert_eq!(value["attrs"]["os_error"], libc::EMFILE);
    }
}
