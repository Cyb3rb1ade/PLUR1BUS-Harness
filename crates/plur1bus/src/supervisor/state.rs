//! Pure supervisor state machine: child health, exit classification and restart backoff.
//!
//! Nothing in this module touches the filesystem, a socket or a clock other than through the
//! `std::time::Instant`/`Duration` values its callers pass in (spec §6.4, global constraint
//! "clocks"). It exists so the rules that decide whether and when to restart a child can be
//! tested in isolation from process spawning, health polling and I/O (Tasks 5-7).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// A supervised child's health, mirroring `$defs/ProcessState`'s `state` enum plus the data each
/// state carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Health {
    Starting,
    Ready,
    Degraded(String),
    Orphaned {
        since: u64,
    },
    Stopping,
    Stopped {
        reason: Option<String>,
    },
    Crashed {
        code: Option<i32>,
        signal: Option<String>,
        at: u64,
        reason: Option<String>,
    },
}

impl Health {
    /// Renders this health as a `$defs/ProcessState` value. `since` is the epoch-ms fallback for
    /// variants that don't carry their own timestamp; `Orphaned` and `Crashed` report their own
    /// (`since`, `at`) instead, since those are the moment the *health* changed, which can differ
    /// from when the caller last touched this child.
    pub fn to_process_state(&self, since: u64) -> serde_json::Value {
        let (state, reason, since_ms): (&str, Option<String>, u64) = match self {
            Health::Starting => ("starting", None, since),
            Health::Ready => ("ready", None, since),
            Health::Degraded(reason) => ("degraded", Some(reason.clone()), since),
            Health::Orphaned { since: s } => ("orphaned", None, *s),
            Health::Stopping => ("stopping", None, since),
            Health::Stopped { reason } => ("stopped", reason.clone(), since),
            Health::Crashed { at, reason, .. } => ("crashed", reason.clone(), *at),
        };
        let mut obj = serde_json::Map::new();
        obj.insert("state".into(), serde_json::Value::String(state.into()));
        obj.insert("since".into(), serde_json::Value::from(since_ms));
        if let Some(reason) = reason {
            obj.insert("reason".into(), serde_json::Value::String(reason));
        }
        serde_json::Value::Object(obj)
    }
}

/// The full crash-reason vocabulary (ruling H3-R3). `classify_exit` produces the two exit-code
/// reasons (`LockHeld`, `ConfigInvalid`, `EngineContract`); `ReadyTimeout` and `AdoptedExit` are
/// reserved here for Tasks 6 and 7 (a child that never becomes ready, and an adopted child later
/// observed to exit); `None` denotes "crashed with no more specific reason than the exit itself".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReason {
    LockHeld,
    ConfigInvalid,
    EngineContract,
    ReadyTimeout,
    AdoptedExit,
    None,
}

impl CrashReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CrashReason::LockHeld => "lock-held",
            CrashReason::ConfigInvalid => "config-invalid",
            CrashReason::EngineContract => "engine-contract",
            CrashReason::ReadyTimeout => "ready-timeout",
            CrashReason::AdoptedExit => "adopted-exit",
            CrashReason::None => "none",
        }
    }
}

impl std::fmt::Display for CrashReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How an exit should be handled, per ruling S9.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitClass {
    /// A clean exit the supervisor itself asked for (`daemon.stop`, `core.shutdown`): not a
    /// crash, no restart.
    Requested,
    /// Not requested, but not fatal either: restart with backoff.
    Retryable { reason: Option<String> },
    /// Fatal: mark crashed with `reason` and never restart until `daemon start`.
    Fatal { reason: String },
}

/// Classifies a child's exit per ruling S9.
///
/// `signal` distinguishes *how* the child died but not, on its own, whether the exit is fatal:
/// under S9 only two exit codes (2, 4) are fatal, exit 3 is the one retryable code with a named
/// reason, and every other code or a bare signal is retryable with no specific reason.
pub fn classify_exit(code: Option<i32>, signal: Option<i32>, requested: bool) -> ExitClass {
    let _ = signal;
    if requested {
        return ExitClass::Requested;
    }
    match code {
        Some(2) => ExitClass::Fatal {
            reason: CrashReason::ConfigInvalid.to_string(),
        },
        Some(4) => ExitClass::Fatal {
            reason: CrashReason::EngineContract.to_string(),
        },
        Some(3) => ExitClass::Retryable {
            reason: Some(CrashReason::LockHeld.to_string()),
        },
        _ => ExitClass::Retryable { reason: None },
    }
}

/// The backoff delay sequence in seconds (spec §6.4): 1, 2, 4, 8, 16, 32, 60, 60, ...
fn base_delay_secs(index: usize) -> f64 {
    let capped = index.min(6);
    if capped >= 6 {
        60.0
    } else {
        2f64.powi(capped as i32)
    }
}

/// How the supervisor should react to a child's exit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartDecision {
    /// Restart after this delay.
    After(Duration),
    /// Too many crashes in the trailing window: stop restarting until `daemon start` (`reset()`).
    GiveUp,
}

/// Pure restart-backoff state machine (spec §6.4).
///
/// Delays double from 1 s up to a 60 s ceiling on every exit; the delay resets to the start of
/// that sequence once the child has been ready for a full window (`on_ready` followed by an exit
/// at least `10 min * scale` later). Five exits within a trailing `10 min * scale` window give up
/// permanently, sticky until `reset()` — even a later exit long after the fifth one stays a
/// `GiveUp` until the caller resets it (daemon start / `daemon.start`).
pub struct Backoff {
    scale: f64,
    window: Duration,
    delay_index: usize,
    ready_since: Option<Instant>,
    exits: VecDeque<Instant>,
    given_up: bool,
}

impl Backoff {
    /// `scale` is `PLUR1BUS_SUPERVISOR_TIME_SCALE` (1.0 in production); every duration this type
    /// produces or compares against is multiplied by it.
    pub fn new(scale: f64) -> Self {
        Backoff {
            scale,
            window: Duration::from_secs_f64(600.0 * scale),
            delay_index: 0,
            ready_since: None,
            exits: VecDeque::new(),
            given_up: false,
        }
    }

    /// Record that the child became ready at `now`. Used to detect the "ready for 10 min * scale"
    /// condition that resets the backoff delay.
    pub fn on_ready(&mut self, now: Instant) {
        self.ready_since = Some(now);
    }

    /// Record an exit at `now` and decide what happens next.
    pub fn on_exit(&mut self, now: Instant) -> RestartDecision {
        if self.given_up {
            return RestartDecision::GiveUp;
        }

        if let Some(ready_since) = self.ready_since {
            if now.saturating_duration_since(ready_since) >= self.window {
                self.delay_index = 0;
            }
        }
        // The child is no longer ready as of this exit.
        self.ready_since = None;

        self.exits
            .retain(|&t| now.saturating_duration_since(t) <= self.window);
        self.exits.push_back(now);

        if self.exits.len() >= 5 {
            self.given_up = true;
            return RestartDecision::GiveUp;
        }

        let delay = Duration::from_secs_f64(base_delay_secs(self.delay_index) * self.scale);
        self.delay_index += 1;
        RestartDecision::After(delay)
    }

    /// Clear all history (daemon start / `daemon.start`, ruling S9's "no retry until daemon
    /// start" and spec §6.4).
    pub fn reset(&mut self) {
        self.delay_index = 0;
        self.ready_since = None;
        self.exits.clear();
        self.given_up = false;
    }
}

/// The last exit a child had, mirroring `$defs/ChildStatus.lastExit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: u64,
    pub reason: Option<String>,
}

impl LastExit {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "code": self.code,
            "signal": self.signal,
            "at": self.at,
            "reason": self.reason,
        })
    }
}

/// One supervised child as the supervisor tracks it, mirroring `$defs/ChildStatus`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildState {
    pub role: String,
    pub health: Health,
    /// Epoch ms since `health` last changed; the fallback `since` for `Health::to_process_state`.
    pub since_ms: u64,
    pub pid: Option<u32>,
    pub instance_id: Option<String>,
    /// `true` when the supervisor adopted a running child instead of spawning it (S19).
    pub adopted: bool,
    pub restarts: u32,
    pub last_exit: Option<LastExit>,
    /// Epoch ms of the scheduled restart; `None` when none is scheduled.
    pub next_restart_at_ms: Option<u64>,
}

impl ChildState {
    /// Renders this child as a `$defs/ChildStatus` value.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "role": self.role,
            "process": self.health.to_process_state(self.since_ms),
            "pid": self.pid,
            "instanceId": self.instance_id,
            "adopted": self.adopted,
            "restarts": self.restarts,
            "lastExit": self.last_exit.as_ref().map(LastExit::to_json),
            "nextRestartAt": self.next_restart_at_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::collections::VecDeque as StdVecDeque;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn backoff_doubles_from_1s_to_60s() {
        let mut backoff = Backoff::new(1.0);
        let start = Instant::now();
        let expected = [1u64, 2, 4, 8, 16, 32, 60, 60];
        let mut now = start;
        for (i, expected_secs) in expected.iter().enumerate() {
            // Space exits 11 minutes apart: well past the 10-minute reset window, but `on_ready`
            // is never called, so the stable-window reset must not fire.
            if i > 0 {
                now += Duration::from_secs(11 * 60);
            }
            let decision = backoff.on_exit(now);
            assert_eq!(
                decision,
                RestartDecision::After(secs(*expected_secs)),
                "exit {i}"
            );
        }
    }

    #[test]
    fn five_crashes_in_ten_minutes_give_up() {
        let mut backoff = Backoff::new(1.0);
        let start = Instant::now();
        // Five exits, one minute apart: all within the trailing 10-minute window.
        for i in 0..4u64 {
            let now = start + Duration::from_secs(60 * i);
            let decision = backoff.on_exit(now);
            assert_ne!(
                decision,
                RestartDecision::GiveUp,
                "exit {i} gave up too early"
            );
        }
        let fifth = start + Duration::from_secs(60 * 4);
        assert_eq!(backoff.on_exit(fifth), RestartDecision::GiveUp);

        // Sticky: a sixth exit 20 minutes after the fifth is still GiveUp, until reset().
        let sixth = fifth + Duration::from_secs(20 * 60);
        assert_eq!(backoff.on_exit(sixth), RestartDecision::GiveUp);

        backoff.reset();
        let seventh = sixth + Duration::from_secs(1);
        assert_eq!(backoff.on_exit(seventh), RestartDecision::After(secs(1)));
    }

    #[test]
    fn ten_minutes_stable_resets_the_delay() {
        let mut backoff = Backoff::new(1.0);
        let start = Instant::now();

        // Escalate a couple of times.
        assert_eq!(backoff.on_exit(start), RestartDecision::After(secs(1)));
        let second = start + Duration::from_secs(1);
        assert_eq!(backoff.on_exit(second), RestartDecision::After(secs(2)));

        // The child comes up and stays ready for 10 minutes * scale.
        let ready_at = second + Duration::from_secs(5);
        backoff.on_ready(ready_at);
        let next_exit = ready_at + Duration::from_secs(600) + Duration::from_secs(1);
        assert_eq!(backoff.on_exit(next_exit), RestartDecision::After(secs(1)));
    }

    #[test]
    fn classify_exit_follows_s9() {
        assert_eq!(classify_exit(Some(0), None, true), ExitClass::Requested);
        assert_eq!(
            classify_exit(Some(0), None, false),
            ExitClass::Retryable { reason: None }
        );
        assert_eq!(
            classify_exit(Some(3), None, false),
            ExitClass::Retryable {
                reason: Some("lock-held".to_string())
            }
        );
        assert_eq!(
            classify_exit(Some(2), None, false),
            ExitClass::Fatal {
                reason: "config-invalid".to_string()
            }
        );
        assert_eq!(
            classify_exit(Some(4), None, false),
            ExitClass::Fatal {
                reason: "engine-contract".to_string()
            }
        );
        assert_eq!(
            classify_exit(None, Some(9), false),
            ExitClass::Retryable { reason: None }
        );
    }

    fn child_status_validator() -> jsonschema::Validator {
        let schema: serde_json::Value =
            serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).expect("rpc.schema.json parses");
        let doc = serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": "#/$defs/ChildStatus",
            "$defs": schema["$defs"]
        });
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&doc)
            .expect("ChildStatus schema compiles")
    }

    #[test]
    fn child_status_json_validates_against_the_schema() {
        let validator = child_status_validator();
        let healths = vec![
            Health::Starting,
            Health::Ready,
            Health::Degraded("unresponsive".to_string()),
            Health::Orphaned { since: 111 },
            Health::Stopping,
            Health::Stopped { reason: None },
            Health::Stopped {
                reason: Some("requested".to_string()),
            },
            Health::Crashed {
                code: Some(2),
                signal: None,
                at: 222,
                reason: Some("config-invalid".to_string()),
            },
            Health::Crashed {
                code: None,
                signal: Some("SIGKILL".to_string()),
                at: 333,
                reason: None,
            },
        ];
        for health in healths {
            let child = ChildState {
                role: "core".to_string(),
                health: health.clone(),
                since_ms: 1_700_000_000_000,
                pid: Some(4242),
                instance_id: Some("inst-1".to_string()),
                adopted: false,
                restarts: 2,
                last_exit: Some(LastExit {
                    code: Some(1),
                    signal: None,
                    at: 1_700_000_000_500,
                    reason: None,
                }),
                next_restart_at_ms: Some(1_700_000_001_000),
            };
            let value = child.to_json();
            let errs: Vec<String> = validator
                .iter_errors(&value)
                .map(|e| e.to_string())
                .collect();
            assert!(errs.is_empty(), "{health:?} -> {value}: {errs:?}");
        }

        // Also cover the "nothing scheduled, never adopted, no pid" corner.
        let child = ChildState {
            role: "core".to_string(),
            health: Health::Starting,
            since_ms: 0,
            pid: None,
            instance_id: None,
            adopted: true,
            restarts: 0,
            last_exit: None,
            next_restart_at_ms: None,
        };
        let value = child.to_json();
        let errs: Vec<String> = validator
            .iter_errors(&value)
            .map(|e| e.to_string())
            .collect();
        assert!(errs.is_empty(), "{value}: {errs:?}");
    }

    proptest! {
        #[test]
        fn backoff_invariants(
            deltas_ms in prop::collection::vec(0u64..=1_200_000u64, 1..40),
            readies in prop::collection::vec(any::<bool>(), 1..40),
        ) {
            let scale = 1.0;
            let window = Duration::from_secs_f64(600.0 * scale);
            let cap = Duration::from_secs_f64(60.0 * scale);
            let mut backoff = Backoff::new(scale);
            let start = Instant::now();
            let mut cumulative = Duration::ZERO;
            let mut exit_times: StdVecDeque<Duration> = StdVecDeque::new();

            for (i, delta) in deltas_ms.iter().enumerate() {
                cumulative += Duration::from_millis(*delta);
                let now = start + cumulative;
                if readies.get(i).copied().unwrap_or(false) {
                    backoff.on_ready(now);
                }
                let decision = backoff.on_exit(now);
                exit_times.push_back(cumulative);

                // Independent reference: was there ever, up to and including this exit, a point
                // whose trailing window already held >= 5 exits? `GiveUp` is sticky, so this is
                // the "at some point since the last reset" condition, and resets never happen in
                // this generated sequence.
                let times: Vec<Duration> = exit_times.iter().copied().collect();
                let mut expect_give_up = false;
                for j in 0..times.len() {
                    let t_j = times[j];
                    let count = times[..=j]
                        .iter()
                        .filter(|&&t| t_j.checked_sub(t).map(|d| d <= window).unwrap_or(false))
                        .count();
                    if count >= 5 {
                        expect_give_up = true;
                        break;
                    }
                }

                match decision {
                    RestartDecision::GiveUp => {
                        prop_assert!(expect_give_up, "GiveUp at step {} without 5-in-window cause", i);
                    }
                    RestartDecision::After(d) => {
                        prop_assert!(!expect_give_up, "expected GiveUp at step {} but got After({:?})", i, d);
                        prop_assert!(d <= cap, "delay {:?} exceeds the {:?} cap at step {}", d, cap, i);
                    }
                }
            }
        }
    }
}
