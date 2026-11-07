//! The front door's process state, its lifeline, and the timings it reads from `config.json` (P4-10).
//!
//! **State** (`$defs/ProcessState`): `ready` once the legacy core is ready and the socket listens; `orphaned` while the
//! lifeline is lost; `stopping` from the first stop request. `core.status` and `core.adopt` report it (the supervisor's
//! health reads it), and every change is a `core.state` notification (`events`).
//!
//! **Lifeline** (S4, ADR-012 §10.1): supervised, the supervisor holds the front door's stdin; a later `core.adopt` makes
//! that connection the lifeline instead. Losing the current one orphans the front door; after `supervisor.graceMs`
//! without a new adoption it stops, as the TypeScript core does (`orphan-watch.ts`).
//!
//! **Drain order** (ADR-012 §3, G17), carried out by `serve`: state `stopping` and its notification → `core.shutdown` to
//! the legacy core, which refuses new memory operations, drains the ones in flight and closes its links (every reply it
//! wrote reaches its client through the front door, which keeps forwarding) → wait for the legacy core to exit within
//! the budget, then kill it → stop accepting, end every client connection (a queued reply is still flushed; destroyed
//! after 1 s) → remove the run files → release the lock (after the files, so a successor never loses its fresh ones).
use serde_json::{json, Value};
use std::path::Path;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// `$defs/ProcessState`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessState {
    /// `starting`, `ready`, `orphaned`, `stopping`, `stopped`.
    pub state: &'static str,
    /// Epoch ms of the change.
    pub since: u64,
    /// Why, when stopped for a reason.
    pub reason: Option<&'static str>,
}

impl ProcessState {
    /// A state that starts now.
    pub fn now(state: &'static str) -> Self {
        ProcessState {
            state,
            since: now_ms(),
            reason: None,
        }
    }

    /// The wire shape.
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "state": self.state, "since": self.since });
        if let Some(r) = self.reason {
            v["reason"] = Value::from(r);
        }
        v
    }
}

/// What ends the main loop of `serve`.
#[derive(Debug)]
pub enum Event {
    /// Stop with this budget; exit with `ok_code` when every step succeeded.
    Stop {
        /// The stop budget (`core.shutdown`'s `budgetMs`, else `core.shutdownBudgetMs`).
        budget: Duration,
        /// For the log.
        why: &'static str,
        /// 0, or 130 for SIGINT.
        ok_code: i32,
    },
    /// The legacy core exited (expected only while stopping).
    LegacyExited,
    /// The orphan grace of this lifeline generation ran out.
    GraceExpired(u64),
}

/// The lifeline (S4): which source is current, and since when the front door is orphaned.
#[derive(Debug, Default)]
pub struct Lifeline {
    /// `Some(id)` when an adoption made connection `id` the lifeline; `None` for stdin or nothing.
    pub connection: Option<u64>,
    /// Epoch ms of the loss; `None` while a lifeline holds.
    pub orphaned_since: Option<u64>,
    /// Incremented on every attach, so a grace timer of an older loss does nothing.
    pub generation: u64,
}

/// The configuration the front door reads itself (P4-11 ports configuration; until then `config.json` once at start, and
/// the schema's defaults when it is missing or unreadable, in which case the legacy core refuses to start anyway).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timings {
    /// `supervisor.graceMs` (default 60 000).
    pub grace: Duration,
    /// `core.shutdownBudgetMs` (default 30 000): the budget of a stop by signal.
    pub shutdown_budget: Duration,
}

impl Timings {
    /// Reads `config.json`.
    pub fn read(config: &Path) -> Timings {
        let doc: Value = std::fs::read(config)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        let ms = |pointer: &str, default: u64| {
            doc.pointer(pointer)
                .and_then(Value::as_u64)
                .filter(|v| (1000..=3_600_000).contains(v))
                .unwrap_or(default)
        };
        Timings {
            grace: Duration::from_millis(ms("/supervisor/graceMs", 60_000)),
            shutdown_budget: Duration::from_millis(ms("/core/shutdownBudgetMs", 30_000)),
        }
    }
}

/// Arms the orphan grace of `generation`: after `grace` an [`Event::GraceExpired`] goes to `events` (the main loop ignores
/// it when the lifeline came back meanwhile).
pub fn arm_grace(events: Sender<Event>, generation: u64, grace: Duration) {
    let _ = std::thread::Builder::new()
        .name("core-orphan-grace".into())
        .spawn(move || {
            std::thread::sleep(grace);
            let _ = events.send(Event::GraceExpired(generation));
        });
}

/// Watches stdin (`--lifeline stdin`): its end is the loss of that lifeline, reported through `lost`.
pub fn watch_stdin(lost: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new()
        .name("core-lifeline".into())
        .spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
            lost();
        });
}

/// SIGTERM and SIGINT take the stop path (`bin.ts`: SIGINT exits 130).
#[cfg(unix)]
pub fn watch_signals(events: Sender<Event>, budget: Duration) -> std::io::Result<()> {
    use signal_hook::consts::{SIGINT, SIGTERM};
    let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT])?;
    std::thread::Builder::new()
        .name("core-signals".into())
        .spawn(move || {
            for signal in signals.forever() {
                let (why, ok_code) = if signal == SIGINT {
                    ("SIGINT", 130)
                } else {
                    ("SIGTERM", 0)
                };
                let _ = events.send(Event::Stop {
                    budget,
                    why,
                    ok_code,
                });
            }
        })?;
    Ok(())
}

/// No signals to watch: on Windows the supervisor stops the core through `core.shutdown`.
#[cfg(not(unix))]
pub fn watch_signals(_events: Sender<Event>, _budget: Duration) -> std::io::Result<()> {
    Ok(())
}

/// A small mutex helper that survives a poisoned lock (a panicking connection thread must not take the front door down).
pub fn relock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timings_come_from_config_json_with_the_schema_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.json");
        assert_eq!(
            Timings::read(&config),
            Timings {
                grace: Duration::from_secs(60),
                shutdown_budget: Duration::from_secs(30)
            }
        );
        std::fs::write(
            &config,
            r#"{"supervisor":{"graceMs":1500},"core":{"shutdownBudgetMs":2500}}"#,
        )
        .unwrap();
        assert_eq!(
            Timings::read(&config),
            Timings {
                grace: Duration::from_millis(1500),
                shutdown_budget: Duration::from_millis(2500)
            }
        );
        std::fs::write(&config, r#"{"supervisor":{"graceMs":5}}"#).unwrap();
        assert_eq!(
            Timings::read(&config).grace,
            Duration::from_secs(60),
            "out of range: default"
        );
    }

    #[test]
    fn process_states_have_the_schema_shape() {
        let s = ProcessState {
            state: "stopped",
            since: 5,
            reason: Some("start-failed"),
        };
        assert_eq!(
            s.to_json(),
            json!({"state":"stopped","since":5,"reason":"start-failed"})
        );
        assert_eq!(ProcessState::now("ready").to_json()["state"], "ready");
    }
}
