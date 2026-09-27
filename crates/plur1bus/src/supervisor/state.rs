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
/// A module adds `ManifestInvalid` (its exit 2, an invalid manifest, or one left out of the start order) and
/// `ApiVersionUnsupported` (B12). `GaveUp` (H3B-R26) is the state of a child whose backoff gave up: five exits inside the
/// window; its last exit keeps its own reason. The values are `$defs/CrashReason` in the RPC schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReason {
    LockHeld,
    ConfigInvalid,
    EngineContract,
    ReadyTimeout,
    AdoptedExit,
    ManifestInvalid,
    ApiVersionUnsupported,
    GaveUp,
    None,
}

/// Why a module is `stopped` without being a crash: `modules.<name>.enabled` is false, its manifest asks for
/// `scope: "agent"` (B10), or `module.stop` asked for it (Task 10).
pub const STOPPED_DISABLED: &str = "disabled";
pub const STOPPED_SCOPE_AGENT: &str = "scope-agent-unsupported";
pub const STOPPED_BY_REQUEST: &str = "stopped-by-request";
/// A module whose `needs` names a module that is not started (disabled, agent-scoped, an unsupported API version, or
/// itself held back): stopped, transitively (H3B-R25).
pub const STOPPED_NEEDS_UNAVAILABLE: &str = "needs-unavailable";

impl CrashReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CrashReason::LockHeld => "lock-held",
            CrashReason::ConfigInvalid => "config-invalid",
            CrashReason::EngineContract => "engine-contract",
            CrashReason::ReadyTimeout => "ready-timeout",
            CrashReason::AdoptedExit => "adopted-exit",
            CrashReason::ManifestInvalid => "manifest-invalid",
            CrashReason::ApiVersionUnsupported => "api-version-unsupported",
            CrashReason::GaveUp => "gave-up",
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
    /// A module whose manifest says `restart: "never"`: crashed with `reason`, and no restart.
    Final { reason: Option<String> },
    /// A clean exit (code 0) the supervisor did not ask for, from a module that is not restarted after one
    /// (`restart: "on-failure"` or `"never"`): stopped, no restart.
    Exited,
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

/// [`classify_exit`] for a child of `kind`: a module's exit 2 is its runtime refusing its manifest
/// (`manifest-invalid`, P13), never `config-invalid`; exit 4 means nothing special for a module. Exit 3 (`lock-held`)
/// and every other exit follow the core's rules.
pub fn classify_exit_for(
    kind: RoleKind,
    code: Option<i32>,
    signal: Option<i32>,
    requested: bool,
) -> ExitClass {
    match (kind, requested, code) {
        (RoleKind::Core, ..) | (_, true, _) => classify_exit(code, signal, requested),
        (RoleKind::Module, false, Some(2)) => ExitClass::Fatal {
            reason: CrashReason::ManifestInvalid.to_string(),
        },
        (RoleKind::Module, false, Some(4)) => ExitClass::Retryable { reason: None },
        (RoleKind::Module, false, _) => classify_exit(code, signal, requested),
    }
}

/// A module manifest's `restart` (D14); the core behaves as `Always` (every unrequested exit is retried).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartPolicy {
    /// Also after a clean exit.
    Always,
    /// After a crash (a non-zero code or a signal), not after a clean exit. The manifest default.
    OnFailure,
    /// Never: an unrequested exit leaves the module crashed (or stopped, for a clean one).
    Never,
}

impl RestartPolicy {
    /// The manifest value; anything else (the schema allows none) is the default, `on-failure`.
    pub fn parse(s: &str) -> RestartPolicy {
        match s {
            "always" => RestartPolicy::Always,
            "never" => RestartPolicy::Never,
            _ => RestartPolicy::OnFailure,
        }
    }
}

/// Applies `policy` to a retryable exit: a clean exit (code 0, no signal) is `Exited` unless the policy is `Always`;
/// under `Never` any other retryable exit is `Final`. Requested and fatal exits are unchanged.
pub fn apply_policy(class: ExitClass, policy: RestartPolicy, code: Option<i32>) -> ExitClass {
    match (class, policy) {
        (ExitClass::Retryable { .. }, RestartPolicy::OnFailure | RestartPolicy::Never)
            if code == Some(0) =>
        {
            ExitClass::Exited
        }
        (ExitClass::Retryable { reason }, RestartPolicy::Never) => ExitClass::Final { reason },
        (class, _) => class,
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
#[derive(Debug)]
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

    /// Record an exit 3 (`lock-held`: another core holds `state/core.lock`) at `now`. It is delayed like any exit,
    /// but never counts toward GiveUp: the lock holder is a core that is still starting, and the next attempt probes
    /// for it and adopts it once it serves (Task 7 review). A GiveUp reached through other exits stays sticky.
    pub fn on_lock_held_exit(&mut self, now: Instant) -> RestartDecision {
        if self.given_up {
            return RestartDecision::GiveUp;
        }
        if let Some(ready_since) = self.ready_since {
            if now.saturating_duration_since(ready_since) >= self.window {
                self.delay_index = 0;
            }
        }
        self.ready_since = None;
        let delay = Duration::from_secs_f64(base_delay_secs(self.delay_index) * self.scale);
        self.delay_index += 1;
        RestartDecision::After(delay)
    }

    /// Whether the backoff has given up (sticky until `reset()`).
    pub fn given_up(&self) -> bool {
        self.given_up
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
    /// `ChildStatus.kind`.
    pub kind: RoleKind,
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
            "kind": match self.kind {
                RoleKind::Core => "core",
                RoleKind::Module => "module",
            },
        })
    }

    /// Renders this child as a `$defs/ModuleState` value (`module.watch`, `module.state`).
    pub fn to_module_state(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.role,
            "process": self.health.to_process_state(self.since_ms),
            "pid": self.pid,
            "instanceId": self.instance_id,
        })
    }

    /// A child that has not run yet: `starting`, no pid.
    pub fn fresh(role: &Role) -> ChildState {
        ChildState {
            role: role.name.clone(),
            kind: role.kind,
            health: Health::Starting,
            since_ms: 0,
            pid: None,
            instance_id: None,
            adopted: false,
            restarts: 0,
            last_exit: None,
            next_restart_at_ms: None,
        }
    }
}

/// Whether a supervised child is the core or a module.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RoleKind {
    Core,
    Module,
}

/// A supervised child's identity: its name (`core`, or the module's name) and its kind. The name keys its slot, its
/// run files ([`crate::paths::Layout::endpoints`]) and its logs.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Role {
    pub name: String,
    pub kind: RoleKind,
}

impl Role {
    pub fn core() -> Role {
        Role {
            name: "core".into(),
            kind: RoleKind::Core,
        }
    }

    pub fn module(name: &str) -> Role {
        Role {
            name: name.into(),
            kind: RoleKind::Module,
        }
    }

    /// The RPC method `verb` on this child's own surface: `core.<verb>` or `module.<verb>`.
    pub fn method(&self, verb: &str) -> String {
        match self.kind {
            RoleKind::Core => format!("core.{verb}"),
            RoleKind::Module => format!("module.{verb}"),
        }
    }
}

/// What currently keeps a supervised child's lifeline (S4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lifeline {
    /// No child, or the child's lifeline is gone (it is orphaned or has exited).
    None,
    /// A child this supervisor spawned: the supervisor holds the only write end of its stdin.
    Stdin,
    /// An adopted child: the authenticated connection on which its adoption succeeded.
    Connection,
}

/// One supervised child as the scheduler sees it: the child's state, its lifeline, and its own restart backoff and
/// schedule.
#[derive(Debug)]
pub struct Slot {
    pub role: Role,
    /// The child, once spawned or adopted. Its `health` carries the crash reason (`Health::Crashed { reason }`) and
    /// `last_exit` the last exit with its reason; `adopted` says whether it was adopted (S19).
    pub child: Option<ChildState>,
    /// The child's lifeline source; `Lifeline::None` while there is no child.
    pub lifeline: Lifeline,
    /// The child's restart backoff (spec §6.4); `daemon.start` resets it.
    pub backoff: Backoff,
    /// When the main thread's scheduler respawns the child; set by an exit that the backoff allows to retry.
    pub restart_at: Option<Instant>,
    /// `daemon.start` (or the B18 re-arm) asked for an immediate spawn (a no-op while the child is running).
    pub start_requested: bool,
    /// What an unrequested exit leads to: the manifest's `restart` for a module, `Always` for the core.
    pub policy: RestartPolicy,
    /// A module's manifest `apiVersion`: its `module.auth` hello must report it, and its manifest `name` (B12).
    pub api_version: Option<String>,
    /// A module's `module.status.detail` as last polled (`module.list`); cleared by a spawn.
    pub detail: Option<serde_json::Value>,
}

impl Slot {
    /// An empty slot: no child yet, nothing scheduled. `scale` is the supervisor's time scale (see [`Backoff::new`]).
    pub fn new(role: Role, scale: f64) -> Slot {
        Slot {
            role,
            child: None,
            lifeline: Lifeline::None,
            backoff: Backoff::new(scale),
            restart_at: None,
            start_requested: false,
            policy: RestartPolicy::Always,
            api_version: None,
            detail: None,
        }
    }
}

/// The slot the scheduler serves next: the first one with a start request, else the one whose restart is due
/// earliest (`restart_at <= now`). `None` when nothing is due.
pub fn next_due(slots: &[Slot], now: Instant) -> Option<usize> {
    if let Some(i) = slots.iter().position(|s| s.start_requested) {
        return Some(i);
    }
    slots
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.restart_at.filter(|&at| at <= now).map(|at| (at, i)))
        .min()
        .map(|(_, i)| i)
}

/// B8: whether a requested restart resets a child's backoff first. Only a child crashed for good does: a fatal exit
/// (crashed with no restart scheduled) or a backoff that gave up. A retryable crash waiting for its backoff keeps its
/// attempt count.
pub fn crashed_for_good(child: Option<&ChildState>, given_up: bool) -> bool {
    given_up
        || child.is_some_and(|c| {
            matches!(c.health, Health::Crashed { .. }) && c.next_restart_at_ms.is_none()
        })
}

/// M8: a requested restart whose oldest job was queued before the running process started is skipped: that process
/// already watched the configuration that asked for it.
pub fn restart_already_done(running_since: Option<Instant>, oldest_job: Option<Instant>) -> bool {
    matches!((running_since, oldest_job), (Some(since), Some(queued)) if since > queued)
}

/// The earliest scheduled restart of any slot: when the scheduler has to wake up next.
pub fn next_wake(slots: &[Slot]) -> Option<Instant> {
    slots.iter().filter_map(|s| s.restart_at).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn child_with(health: Health, next: Option<u64>) -> ChildState {
        ChildState {
            role: "core".into(),
            kind: RoleKind::Core,
            health,
            since_ms: 0,
            pid: None,
            instance_id: None,
            adopted: false,
            restarts: 0,
            last_exit: None,
            next_restart_at_ms: next,
        }
    }

    #[test]
    fn only_a_child_crashed_for_good_has_its_backoff_reset() {
        let crashed = || Health::Crashed {
            code: Some(1),
            signal: None,
            at: 1,
            reason: None,
        };
        // Fatal (no restart scheduled) or given up: reset.
        assert!(crashed_for_good(Some(&child_with(crashed(), None)), false));
        assert!(crashed_for_good(
            Some(&child_with(Health::Ready, None)),
            true
        ));
        // A retryable crash waiting for its backoff, a running child, no child: kept.
        assert!(!crashed_for_good(
            Some(&child_with(crashed(), Some(5))),
            false
        ));
        assert!(!crashed_for_good(
            Some(&child_with(Health::Ready, None)),
            false
        ));
        assert!(!crashed_for_good(None, false));
    }

    #[test]
    fn a_restart_requested_before_the_running_process_started_is_already_done() {
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_millis(5);
        assert!(restart_already_done(Some(t1), Some(t0)));
        assert!(!restart_already_done(Some(t0), Some(t1)));
        assert!(!restart_already_done(Some(t0), Some(t0)));
        assert!(!restart_already_done(None, Some(t0)), "nothing runs: spawn");
        assert!(!restart_already_done(Some(t0), None));
    }
    use std::collections::VecDeque as StdVecDeque;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn role_method_names() {
        assert_eq!(Role::core().method("status"), "core.status");
        assert_eq!(Role::core().method("shutdown"), "core.shutdown");
        assert_eq!(Role::module("fixture").method("status"), "module.status");
        assert_eq!(Role::module("fixture").method("auth"), "module.auth");
        assert_eq!(
            Role::core(),
            Role {
                name: "core".into(),
                kind: RoleKind::Core
            }
        );
        assert_eq!(
            Role::module("fixture-b"),
            Role {
                name: "fixture-b".into(),
                kind: RoleKind::Module
            }
        );
    }

    #[test]
    fn next_due_prefers_a_start_request_then_the_earliest_restart() {
        let now = Instant::now();
        let slot = |name: &str, restart_at: Option<Instant>, start_requested: bool| {
            let mut s = Slot::new(Role::module(name), 1.0);
            s.restart_at = restart_at;
            s.start_requested = start_requested;
            s
        };
        // Nothing requested, nothing scheduled.
        assert_eq!(next_due(&[], now), None);
        assert_eq!(next_due(&[slot("a", None, false)], now), None);
        // A restart in the future is not due yet.
        assert_eq!(
            next_due(&[slot("a", Some(now + secs(1)), false)], now),
            None
        );
        // The earliest of the due restarts wins; a future one never does.
        let slots = [
            slot("a", Some(now + secs(5)), false),
            slot("b", Some(now - secs(1)), false),
            slot("c", Some(now - secs(3)), false),
            slot("d", Some(now), false),
        ];
        assert_eq!(next_due(&slots, now), Some(2));
        // A start request comes before any due restart, wherever it sits.
        let slots = [
            slot("a", Some(now - secs(9)), false),
            slot("b", None, true),
            slot("c", Some(now + secs(9)), true),
        ];
        assert_eq!(next_due(&slots, now), Some(1));
        // The earliest scheduled restart, due or not, is when the scheduler wakes next.
        let slots = [
            slot("a", Some(now + secs(5)), false),
            slot("b", Some(now + secs(2)), false),
            slot("c", None, false),
        ];
        assert_eq!(next_wake(&slots), Some(now + secs(2)));
        assert_eq!(next_wake(&[slot("a", None, false)]), None);
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
    fn lock_held_exits_back_off_but_never_give_up() {
        let mut backoff = Backoff::new(1.0);
        let start = Instant::now();
        let expected = [1u64, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60, 60];
        for (i, s) in expected.iter().enumerate() {
            let now = start + Duration::from_secs(i as u64);
            assert_eq!(
                backoff.on_lock_held_exit(now),
                RestartDecision::After(secs(*s)),
                "lock-held exit {i}"
            );
        }
        assert!(!backoff.given_up());
        // Real crashes still give up on the fifth in the window, however many lock-held exits came between.
        let t = start + Duration::from_secs(20);
        for i in 0..4u64 {
            assert_ne!(
                backoff.on_exit(t + secs(i)),
                RestartDecision::GiveUp,
                "crash {i}"
            );
            let _ = backoff.on_lock_held_exit(t + secs(i) + Duration::from_millis(500));
        }
        assert_eq!(backoff.on_exit(t + secs(4)), RestartDecision::GiveUp);
        assert!(backoff.given_up());
        assert_eq!(
            backoff.on_lock_held_exit(t + secs(5)),
            RestartDecision::GiveUp
        );
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
                kind: RoleKind::Core,
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
            kind: RoleKind::Core,
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

    #[test]
    fn a_module_child_renders_its_kind_and_its_module_state() {
        let validator = child_status_validator();
        let schema: serde_json::Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
        let doc = serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$ref": "#/$defs/notifications/module.state",
            "$defs": schema["$defs"]
        });
        let notification = jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&doc)
            .unwrap();
        let mut child = ChildState::fresh(&Role::module("fixture-b"));
        child.health = Health::Stopped {
            reason: Some(STOPPED_DISABLED.into()),
        };
        let v = child.to_json();
        assert_eq!(v["kind"], "module");
        assert!(validator.is_valid(&v), "{v}");
        assert_eq!(ChildState::fresh(&Role::core()).to_json()["kind"], "core");
        let m = child.to_module_state();
        assert_eq!(
            m,
            serde_json::json!({ "name": "fixture-b", "process": { "state": "stopped", "reason": "disabled", "since": 0 }, "pid": null, "instanceId": null })
        );
        assert!(notification.is_valid(&m), "{m}");
    }

    #[test]
    fn crash_reasons_match_the_schema_vocabulary() {
        let schema: serde_json::Value = serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).unwrap();
        let all = [
            CrashReason::LockHeld,
            CrashReason::ConfigInvalid,
            CrashReason::EngineContract,
            CrashReason::ReadyTimeout,
            CrashReason::AdoptedExit,
            CrashReason::ManifestInvalid,
            CrashReason::ApiVersionUnsupported,
            CrashReason::GaveUp,
            CrashReason::None,
        ];
        let ours: Vec<serde_json::Value> =
            all.iter().map(|r| serde_json::json!(r.as_str())).collect();
        assert_eq!(
            schema["$defs"]["CrashReason"]["enum"],
            serde_json::json!(ours)
        );
    }

    #[test]
    fn a_module_exit_2_is_manifest_invalid_not_config_invalid() {
        let m = RoleKind::Module;
        assert_eq!(
            classify_exit_for(m, Some(2), None, false),
            ExitClass::Fatal {
                reason: "manifest-invalid".into()
            }
        );
        assert_eq!(
            classify_exit_for(RoleKind::Core, Some(2), None, false),
            ExitClass::Fatal {
                reason: "config-invalid".into()
            }
        );
        assert_eq!(
            classify_exit_for(m, Some(3), None, false),
            ExitClass::Retryable {
                reason: Some("lock-held".into())
            }
        );
        assert_eq!(
            classify_exit_for(m, Some(4), None, false),
            ExitClass::Retryable { reason: None }
        );
        assert_eq!(
            classify_exit_for(m, Some(1), None, false),
            ExitClass::Retryable { reason: None }
        );
        assert_eq!(
            classify_exit_for(m, Some(2), None, true),
            ExitClass::Requested
        );
        assert_eq!(CrashReason::ManifestInvalid.as_str(), "manifest-invalid");
        assert_eq!(
            CrashReason::ApiVersionUnsupported.as_str(),
            "api-version-unsupported"
        );
    }

    #[test]
    fn the_restart_policy_decides_whether_an_exit_is_retried() {
        use RestartPolicy::*;
        let retry = || ExitClass::Retryable { reason: None };
        assert_eq!(RestartPolicy::parse("always"), Always);
        assert_eq!(RestartPolicy::parse("never"), Never);
        assert_eq!(RestartPolicy::parse("on-failure"), OnFailure);
        // A clean exit: retried only under `always`.
        assert_eq!(apply_policy(retry(), Always, Some(0)), retry());
        assert_eq!(apply_policy(retry(), OnFailure, Some(0)), ExitClass::Exited);
        assert_eq!(apply_policy(retry(), Never, Some(0)), ExitClass::Exited);
        // A crash: retried unless `never`.
        assert_eq!(apply_policy(retry(), Always, Some(1)), retry());
        assert_eq!(apply_policy(retry(), OnFailure, None), retry());
        assert_eq!(
            apply_policy(
                ExitClass::Retryable {
                    reason: Some("lock-held".into())
                },
                Never,
                Some(3)
            ),
            ExitClass::Final {
                reason: Some("lock-held".into())
            }
        );
        // Requested and fatal exits are never changed.
        assert_eq!(
            apply_policy(ExitClass::Requested, Never, Some(0)),
            ExitClass::Requested
        );
        let fatal = || ExitClass::Fatal {
            reason: "manifest-invalid".into(),
        };
        assert_eq!(apply_policy(fatal(), Always, Some(2)), fatal());
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
