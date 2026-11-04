//! Shared, bounded frontend bus and polling primitives. No terminal or asynchronous runtime is owned here.
use super::{input::AcceptKey, CodeError};
use plur1bus_rpc::Client;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc::{self, Receiver, SyncSender, TrySendError},
    Arc,
};
use std::time::{Duration, Instant};

pub(super) enum Event {
    Input(String, AcceptKey),
    #[cfg(feature = "tui")]
    FrontendInput {
        line: String,
        key: AcceptKey,
        question: Option<String>,
    },
    Interrupt,
    Eof,
    Frame(Value),
    Reply {
        operation: String,
        result: Result<Value, CodeError>,
    },
    Notice(String),
    Failed(CodeError),
}

impl Event {
    fn bytes(&self) -> usize {
        128 + match self {
            Self::Input(s, _) | Self::Notice(s) => s.len(),
            #[cfg(feature = "tui")]
            Self::FrontendInput { line, question, .. } => {
                line.len() + question.as_ref().map_or(0, String::len)
            }
            Self::Frame(v) => v.to_string().len(),
            Self::Reply { result: Ok(v), .. } => v.to_string().len(),
            Self::Reply { result: Err(e), .. } | Self::Failed(e) => e.message.len(),
            Self::Interrupt | Self::Eof => 0,
        }
    }
}

const BYTE_LIMIT: usize = 8 * 1024 * 1024;
struct Permit {
    bytes: usize,
    used: Arc<AtomicUsize>,
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
pub(super) struct Envelope {
    event: Event,
    _permit: Permit,
}
impl Envelope {
    pub fn into_event(self) -> Event {
        self.event
    }
}

#[derive(Clone)]
pub(super) struct Bus {
    sender: SyncSender<Envelope>,
    used: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}
impl Bus {
    /// A terminal producer can stop without stopping the reader needed for final cancellation.
    #[cfg(feature = "tui")]
    pub fn with_stop(&self, stop: Arc<AtomicBool>) -> Self {
        Self {
            sender: self.sender.clone(),
            used: self.used.clone(),
            stop,
        }
    }

    pub fn channel(stop: Arc<AtomicBool>) -> (Self, Receiver<Envelope>) {
        let (sender, receiver) = mpsc::sync_channel(64);
        (
            Self {
                sender,
                used: Arc::new(AtomicUsize::new(0)),
                stop,
            },
            receiver,
        )
    }
    /// Backpressure checks shutdown too: no producer can keep a terminal-owning thread stuck in send().
    pub fn send(&self, event: Event) -> bool {
        let bytes = event.bytes();
        if bytes > BYTE_LIMIT {
            return false;
        }
        loop {
            if self.stop.load(Ordering::Acquire) {
                return false;
            }
            if self
                .used
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                    (used <= BYTE_LIMIT - bytes).then_some(used + bytes)
                })
                .is_ok()
            {
                break;
            }
            std::thread::park_timeout(Duration::from_millis(5));
        }
        let mut envelope = Envelope {
            event,
            _permit: Permit {
                bytes,
                used: self.used.clone(),
            },
        };
        loop {
            if self.stop.load(Ordering::Acquire) {
                return false;
            }
            match self.sender.try_send(envelope) {
                Ok(()) => return true,
                Err(TrySendError::Disconnected(_)) => return false,
                Err(TrySendError::Full(value)) => {
                    envelope = value;
                    std::thread::park_timeout(Duration::from_millis(5));
                }
            }
        }
    }
}

pub(super) fn request(
    client: &mut Client,
    method: &str,
    params: Value,
    stop: &AtomicBool,
    timeout: Duration,
) -> Result<Value, CodeError> {
    client.start_call(method, params)?;
    let deadline = Instant::now() + timeout;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err(CodeError::new("E_CANCELLED", "coding frontend stopped"));
        }
        if Instant::now() >= deadline {
            return Err(CodeError::new("E_TIMEOUT", "coding RPC deadline exceeded"));
        }
        if let Some(value) = client.poll_call()? {
            return Ok(value);
        }
    }
}

/// Durable per-session sequence; subscription/replay overlap is expected, gaps must be repaired before advancing.
#[derive(Default)]
pub(super) struct Cursor(pub u64);
impl Cursor {
    pub fn inspect(&self, seq: u64) -> Sequence {
        if seq <= self.0 {
            Sequence::Duplicate
        } else if seq == self.0.saturating_add(1) {
            Sequence::Next
        } else {
            Sequence::Gap
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Sequence {
    Duplicate,
    Next,
    Gap,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "tui")]
    #[test]
    fn a_full_terminal_queue_can_stop_its_producer_without_stopping_the_reader() {
        let global = Arc::new(AtomicBool::new(false));
        let local = Arc::new(AtomicBool::new(false));
        let (bus, rx) = Bus::channel(global.clone());
        let terminal = bus.with_stop(local.clone());
        for _ in 0..64 {
            assert!(terminal.send(Event::Notice("frame".into())));
        }
        let (done, result) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let sent = terminal.send(Event::Notice("blocked input".into()));
            let _ = done.send(sent);
        });
        local.store(true, Ordering::Release);
        let outcome = result.recv_timeout(Duration::from_secs(1));
        // Release either implementation on failure so the regression itself never leaves a blocked thread.
        if outcome.is_err() {
            global.store(true, Ordering::Release);
        }
        thread.join().expect("terminal producer");
        assert!(!outcome.expect("local stop releases producer"));
        assert!(!global.load(Ordering::Acquire));
        drop(rx.recv().expect("one queued frame"));
        assert!(bus.send(Event::Notice("reader still active".into())));
    }
    #[test]
    fn replay_overlap_is_deduplicated_and_a_gap_cannot_advance_the_cursor() {
        let cursor = Cursor(7);
        assert_eq!(cursor.inspect(7), Sequence::Duplicate);
        assert_eq!(cursor.inspect(8), Sequence::Next);
        assert_eq!(cursor.inspect(9), Sequence::Gap);
        assert_eq!(cursor.0, 7);
    }
    #[test]
    fn bounded_bus_releases_bytes_and_stops_without_waiting_for_a_consumer() {
        let stop = Arc::new(AtomicBool::new(false));
        let (bus, rx) = Bus::channel(stop.clone());
        assert!(bus.send(Event::Notice("hello".into())));
        assert!(bus.used.load(Ordering::Acquire) > 0);
        assert!(matches!(
            rx.recv().expect("sent event").into_event(),
            Event::Notice(_)
        ));
        assert_eq!(bus.used.load(Ordering::Acquire), 0);
        stop.store(true, Ordering::Release);
        assert!(!bus.send(Event::Eof));
    }
}
