//! Supervisor notification subscriptions (ruling B3): `config.watch` (and, later, `module.watch`) registers the calling
//! connection here. Each subscriber has a bounded queue (`sync_channel(QUEUE)`) drained by its own writer thread, so
//! a `broadcast` never writes to a socket itself: it only `try_send`s. A subscriber whose queue is full (a client that
//! stopped reading) is dropped and its connection closed, so it can never hold up a `config.set`.
//!
//! The writer thread itself may block in a write for as long as the peer does not read. On unix closing the
//! connection fails that write. On Windows a supervisor write has no deadline (H3B-R18, an ADR-012 deviation): the
//! closer cancels the pipe's pending I/O, but the never-reading case is not covered by a test there.
use serde_json::{json, Value};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};

/// Lines a subscriber may have queued before it counts as not reading.
pub const QUEUE: usize = 64;

/// What a subscription receives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Topic {
    /// `config.changed`.
    Config,
    /// `module.state` (Task 9).
    Modules,
}

/// A connection's writer, shared by its request loop (replies) and its subscribers' writer threads (notifications),
/// so a line is always written whole.
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct Sub {
    id: String,
    topic: Topic,
    tx: SyncSender<String>,
    /// Closes the subscriber's connection (both directions); taken when the subscriber is dropped for not reading.
    closer: Option<Box<dyn FnOnce() + Send>>,
}

/// Why [`Subscribers::broadcast`] removed a subscriber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dropped {
    pub id: String,
    /// `"not-reading"` (its queue was full; its connection was closed) or `"gone"` (its writer ended).
    pub reason: &'static str,
}

#[derive(Default)]
pub struct Subscribers {
    subs: Mutex<Vec<Sub>>,
    next: AtomicU64,
}

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Writes queued lines until the queue closes or a write fails. A panic here is a bug: like every supervisor thread,
/// it ends the process with exit 70 (spec §4).
fn writer_loop(rx: mpsc::Receiver<String>, w: SharedWriter) {
    for line in rx {
        let mut w = relock(&w);
        if w.write_all(line.as_bytes())
            .and_then(|_| w.flush())
            .is_err()
        {
            return;
        }
    }
}

impl Subscribers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribes the connection that writes through `w` to `topic`; `closer` ends that connection. Returns the
    /// subscription id (`sub-<n>`).
    pub fn add(&self, topic: Topic, w: SharedWriter, closer: Box<dyn FnOnce() + Send>) -> String {
        let id = format!("sub-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let (tx, rx) = mpsc::sync_channel::<String>(QUEUE);
        let spawned = std::thread::Builder::new()
            .name(format!("{id}-writer"))
            .spawn(move || {
                if catch_unwind(AssertUnwindSafe(|| writer_loop(rx, w))).is_err() {
                    eprintln!("plur1bus supervise: a subscriber writer thread panicked");
                    std::process::exit(super::EXIT_PANIC);
                }
            });
        if spawned.is_err() {
            // Without a writer nothing would drain the queue: close the connection instead of queueing forever.
            closer();
            return id;
        }
        relock(&self.subs).push(Sub {
            id: id.clone(),
            topic,
            tx,
            closer: Some(closer),
        });
        id
    }

    /// Queues `line` (a whole NDJSON line, newline included) for subscriber `id` only; false when it is gone or its
    /// queue is full. Used for the `config.watch` reply, so it reaches the peer before any notification.
    pub fn send_to(&self, id: &str, line: String) -> bool {
        relock(&self.subs)
            .iter()
            .find(|s| s.id == id)
            .is_some_and(|s| s.tx.try_send(line).is_ok())
    }

    /// Removes subscriber `id` (its connection ended); its writer thread ends once its queue is drained.
    pub fn remove(&self, id: &str) {
        relock(&self.subs).retain(|s| s.id != id);
    }

    /// Number of live subscribers of `topic`.
    pub fn count(&self, topic: Topic) -> usize {
        relock(&self.subs)
            .iter()
            .filter(|s| s.topic == topic)
            .count()
    }

    /// Queues the notification `method(params)` for every subscriber of `topic`, without blocking. Returns the
    /// subscribers dropped on the way: one whose queue is full has its connection closed.
    pub fn broadcast(&self, topic: Topic, method: &str, params: &Value) -> Vec<Dropped> {
        let mut line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        line.push('\n');
        let mut dropped = Vec::new();
        relock(&self.subs).retain_mut(|s| {
            if s.topic != topic {
                return true;
            }
            match s.tx.try_send(line.clone()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    if let Some(close) = s.closer.take() {
                        close();
                    }
                    dropped.push(Dropped {
                        id: s.id.clone(),
                        reason: "not-reading",
                    });
                    false
                }
                Err(TrySendError::Disconnected(_)) => {
                    dropped.push(Dropped {
                        id: s.id.clone(),
                        reason: "gone",
                    });
                    false
                }
            }
        });
        dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    /// A writer that blocks every write until `open` is set (a client that never reads).
    struct Stuck(Arc<AtomicBool>);
    impl Write for Stuck {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            while !self.0.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(std::io::Error::other(format!("closed ({} bytes)", b.len())))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            relock(&self.0).extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_reader_gets_every_line_in_order_and_other_topics_nothing() {
        let subs = Subscribers::new();
        let buf = Buf::default();
        let w: SharedWriter = Arc::new(Mutex::new(Box::new(buf.clone())));
        let id = subs.add(Topic::Config, w, Box::new(|| {}));
        assert!(subs.send_to(&id, "first\n".into()));
        for i in 0..3 {
            assert!(subs
                .broadcast(Topic::Config, "config.changed", &json!({ "i": i }))
                .is_empty());
        }
        assert!(subs
            .broadcast(Topic::Modules, "module.state", &json!({}))
            .is_empty());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = String::from_utf8(relock(&buf.0).clone()).unwrap();
            if text.lines().count() == 4 {
                let lines: Vec<&str> = text.lines().collect();
                assert_eq!(lines[0], "first");
                for (i, l) in lines[1..].iter().enumerate() {
                    let v: Value = serde_json::from_str(l).unwrap();
                    assert_eq!(v["method"], "config.changed");
                    assert_eq!(v["params"]["i"], i);
                    assert!(v.get("id").is_none());
                }
                break;
            }
            assert!(Instant::now() < deadline, "{text}");
            std::thread::sleep(Duration::from_millis(5));
        }
        subs.remove(&id);
        assert_eq!(subs.count(Topic::Config), 0);
    }

    #[test]
    fn a_subscriber_that_never_reads_is_dropped_and_closed_without_blocking() {
        let subs = Subscribers::new();
        let open = Arc::new(AtomicBool::new(false));
        let closed = Arc::new(AtomicBool::new(false));
        let w: SharedWriter = Arc::new(Mutex::new(Box::new(Stuck(open.clone()))));
        let c = closed.clone();
        let o = open.clone();
        subs.add(
            Topic::Config,
            w,
            Box::new(move || {
                c.store(true, Ordering::SeqCst);
                o.store(true, Ordering::SeqCst); // closing the connection fails the blocked write
            }),
        );
        let started = Instant::now();
        let mut dropped = Vec::new();
        // The writer takes one line and blocks on it; QUEUE more fill the channel; the next one finds it full.
        for i in 0..QUEUE + 2 {
            dropped.extend(subs.broadcast(Topic::Config, "config.changed", &json!({ "i": i })));
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(dropped.len(), 1, "{dropped:?}");
        assert_eq!(dropped[0].reason, "not-reading");
        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(subs.count(Topic::Config), 0);
    }
}
