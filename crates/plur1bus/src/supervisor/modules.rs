//! The module lifecycle under the supervisor (D14, B8, B13, B14): what every installed module should be
//! ([`ModulesView`]: run, or held back with a state), the slots at start ([`start_modules`]), bringing the modules to
//! that view after a restart plan, an install or an uninstall ([`reconcile_stop`], [`reconcile_start`]), the
//! `module.*` control calls the main thread runs ([`ModuleOp`], [`run_module_op`]) and the `module.list` result.
use super::state::{self, ChildState, Health, Role, RoleKind, Slot};
use super::{
    broadcast_module_state, child, now_ms, relock, spawn_child, start_child, Monitors, Shared,
    DEFAULT_STOP_BUDGET,
};
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What a `module.*` control call asks the main thread to do (it owns the monitors).
#[derive(Debug)]
pub enum ModuleVerb {
    Start,
    Stop,
    Restart,
    /// A module already copied into its staging directory (B14): committed on the main thread, around a stop and a
    /// start of the module when it runs.
    Install(Box<crate::modules::install::Staged>),
    /// `into: None` removes the module's directory (`module.uninstall`); `Some(dir)` moves it there instead
    /// (`ext.uninstall` puts it into the trash, X1-R19).
    Uninstall {
        into: Option<std::path::PathBuf>,
    },
}

/// A queued `module.*` control call: run by the main thread, which sends the result on `done`.
#[derive(Debug)]
pub struct ModuleOp {
    pub name: String,
    pub verb: ModuleVerb,
    /// How long a stop of the module may take (`budgetMs`, default [`DEFAULT_STOP_BUDGET`]).
    pub budget: Duration,
    pub done: std::sync::mpsc::Sender<Result<Value, OpError>>,
    /// [`OP_QUEUED`], then [`OP_RUNNING`] when the main thread takes it, or [`OP_CANCELLED`] when its caller gave up
    /// first (M5): a cancelled op is never run.
    pub state: Arc<std::sync::atomic::AtomicU8>,
}

pub const OP_QUEUED: u8 = 0;
pub const OP_RUNNING: u8 = 1;
pub const OP_CANCELLED: u8 = 2;

/// The caller of a queued op gives up: true when the op had not started (it never will), false when it runs.
pub fn cancel_op(state: &std::sync::atomic::AtomicU8) -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    state
        .compare_exchange(OP_QUEUED, OP_CANCELLED, SeqCst, SeqCst)
        .is_ok()
}

/// A refused or failed `module.*` call: the closed error code, its message, reason and detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError {
    pub error: &'static str,
    pub message: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
}

impl OpError {
    pub fn new(error: &'static str, message: impl Into<String>, reason: Option<&str>) -> Self {
        OpError {
            error,
            message: message.into(),
            reason: reason.map(str::to_string),
            detail: None,
        }
    }

    fn unknown(name: &str) -> Self {
        OpError::new(
            "E_MODULE_UNKNOWN",
            format!("no module named {name} is installed"),
            None,
        )
    }
}

/// Queues a `module.*` control call for the main thread and wakes it; `Err` during a stop.
pub fn push_module_op(
    shared: &Shared,
    name: &str,
    verb: ModuleVerb,
    budget: Duration,
) -> Result<OpHandle, OpError> {
    let mut st = shared.lock();
    if st.stopping.is_some() {
        return Err(OpError::new(
            "E_NOT_AVAILABLE",
            "the supervisor is stopping",
            Some("stopping"),
        ));
    }
    let (done, rx) = std::sync::mpsc::channel();
    let state = Arc::new(std::sync::atomic::AtomicU8::new(OP_QUEUED));
    st.module_ops.push_back(ModuleOp {
        name: name.to_string(),
        verb,
        budget,
        done,
        state: state.clone(),
    });
    shared.wake.notify_all();
    Ok(OpHandle { rx, state })
}

/// Room a `module.*` call leaves, beyond the module's stop, for a restart job the main thread runs before it.
const MODULE_OP_SLACK: Duration = Duration::from_secs(30);

/// Queues a `module.*` control call for the main thread and waits for its result: the stop budget, the stop grace and
/// room for a restart job running before it. An op that has not started by then is cancelled (it never runs, M5) and
/// answers `E_NOT_AVAILABLE reason=busy`; one already running is waited for, so a reported failure never runs
/// afterwards. The `module.*` handlers and the ext layer's `SupervisorHost` share it.
pub fn run_op(
    shared: &Shared,
    name: &str,
    verb: ModuleVerb,
    budget: Duration,
) -> Result<Value, OpError> {
    let scale = shared.lock().time_scale;
    let wait = budget + child::stop_grace(scale) + MODULE_OP_SLACK;
    let op = push_module_op(shared, name, verb, budget)?;
    let stopping = || {
        OpError::new(
            "E_NOT_AVAILABLE",
            "the supervisor is stopping",
            Some("stopping"),
        )
    };
    match op.rx.recv_timeout(wait) {
        Ok(r) => return r,
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(stopping()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
    }
    if cancel_op(&op.state) {
        return Err(OpError::new(
            "E_NOT_AVAILABLE",
            "the supervisor was busy; the call was cancelled and nothing changed",
            Some("busy"),
        ));
    }
    op.rx.recv().unwrap_or_else(|_| Err(stopping()))
}

/// A queued op as its caller holds it: the result channel and the op's state ([`cancel_op`]).
pub struct OpHandle {
    pub rx: std::sync::mpsc::Receiver<Result<Value, OpError>>,
    pub state: Arc<std::sync::atomic::AtomicU8>,
}

/// What every installed module should be now, as the registry (`modules/`, D14) and the running configuration say.
struct ModulesView {
    installed: Vec<crate::modules::Installed>,
    /// Slot order: the start order, then the modules left out of it (scan order). Only valid role names.
    names: Vec<String>,
    /// `None`: it should run. `Some((health, errors))`: it is held back with that state (`modules.<name>.enabled`
    /// false → stopped `disabled`; `scope: "agent"` → stopped `scope-agent-unsupported`, B10; an unsupported
    /// `apiVersion` → crashed `api-version-unsupported`, B12; a `needs` on a held module → stopped `needs-unavailable`,
    /// transitively, H3B-R25; left out of the start order → crashed `manifest-invalid`).
    held: BTreeMap<String, Option<(Health, Vec<String>)>>,
}

impl ModulesView {
    fn manifest(&self, name: &str) -> Option<&crate::modules::Manifest> {
        self.installed
            .iter()
            .find(|i| i.name == name)
            .and_then(|i| i.manifest.as_ref().ok())
    }

    /// Why `name` cannot run, as a `module.*` error; `Err` also when it is not installed.
    fn runnable(&self, name: &str) -> Result<(), OpError> {
        match self.held.get(name) {
            None => Err(OpError::unknown(name)),
            Some(None) => Ok(()),
            Some(Some((health, errors))) => {
                let reason = held_reason(health);
                let mut e = OpError::new(
                    "E_NOT_AVAILABLE",
                    format!("module {name} cannot run ({reason})"),
                    Some(&reason),
                );
                e.detail = (!errors.is_empty()).then(|| errors.join("; "));
                Err(e)
            }
        }
    }
}

/// Whether `child` is `stopped` by `module.stop` (B13).
fn stopped_by_request(child: &ChildState) -> bool {
    matches!(&child.health, Health::Stopped { reason: Some(r) } if r == state::STOPPED_BY_REQUEST)
}

/// The reason a held-back state carries.
fn held_reason(h: &Health) -> String {
    h.to_process_state(0)["reason"]
        .as_str()
        .unwrap_or("not started")
        .to_string()
}

fn modules_view(shared: &Shared, layout: &Layout) -> ModulesView {
    let installed = crate::modules::scan(layout);
    let order = crate::modules::start_order(&installed);
    let graph = crate::modules::graph(&installed);
    let current = crate::modules::current_api_version();
    let modules_config = relock(&shared.config)
        .running
        .as_ref()
        .map(|c| c["modules"].clone())
        .unwrap_or(Value::Null);
    let mut held = BTreeMap::new();
    let mut names = Vec::new();
    // Modules not started, with why: a dependent of one of them is held back too (`start_order` is topological, so
    // one pass makes it transitive, H3B-R25).
    let mut held_back: BTreeMap<String, String> = BTreeMap::new();
    // H3B-R28: a module stopped by `module.stop` holds its dependents back too (it may still be started itself).
    let (requested_stops, ext_overlays): (BTreeSet<String>, BTreeMap<String, &'static str>) = {
        let st = shared.lock();
        let stops = st
            .slots
            .iter()
            .filter(|s| s.child.as_ref().is_some_and(stopped_by_request))
            .map(|s| s.role.name.clone())
            .collect();
        let overlays = st
            .ext_overlays
            .iter()
            .filter_map(|(n, o)| super::ext::overlay_reason(*o).map(|r| (n.clone(), r)))
            .collect();
        (stops, overlays)
    };
    for name in &order {
        let Some(Ok(m)) = installed
            .iter()
            .find(|i| &i.name == name)
            .map(|i| i.manifest.as_ref())
        else {
            continue;
        };
        let stopped = |reason: &str| Health::Stopped {
            reason: Some(reason.to_string()),
        };
        let h = if !crate::modules::enabled(&modules_config, name) {
            Some((stopped(state::STOPPED_DISABLED), vec![]))
        } else if let Some(reason) = ext_overlays.get(name) {
            // X1-R17: a packaged module that is revoked, tampered with or incompatible is held back.
            Some((stopped(reason), vec![]))
        } else if m.scope == "agent" {
            Some((stopped(state::STOPPED_SCOPE_AGENT), vec![]))
        } else if !crate::modules::api_version_supported(&m.api_version, current) {
            let errors = vec![format!(
                "apiVersion {} is not supported (current {current}, previous {})",
                m.api_version,
                current.saturating_sub(1)
            )];
            Some((crashed(state::CrashReason::ApiVersionUnsupported), errors))
        } else {
            let unavailable: Vec<String> = m
                .needs
                .iter()
                .filter_map(|n| {
                    held_back
                        .get(n)
                        .map(|why| format!("needs {n}, which is not started ({why})"))
                })
                .collect();
            (!unavailable.is_empty())
                .then(|| (stopped(state::STOPPED_NEEDS_UNAVAILABLE), unavailable))
        };
        match &h {
            Some((health, _)) => {
                held_back.insert(name.clone(), held_reason(health));
            }
            None if requested_stops.contains(name) => {
                held_back.insert(name.clone(), state::STOPPED_BY_REQUEST.to_string());
            }
            None => {}
        }
        names.push(name.clone());
        held.insert(name.clone(), h);
    }
    for i in installed.iter().filter(|i| !order.contains(&i.name)) {
        if !valid_role_name(&i.name) {
            continue;
        }
        let errors = match &i.manifest {
            Err(errors) => errors.clone(),
            Ok(m) => crate::modules::excluded_because(&i.name, m, &graph, &order),
        };
        names.push(i.name.clone());
        held.insert(
            i.name.clone(),
            Some((crashed(state::CrashReason::ManifestInvalid), errors)),
        );
    }
    ModulesView {
        installed,
        names,
        held,
    }
}

/// A new slot for module `name`, with its manifest's restart policy and `apiVersion`.
fn module_slot(view: &ModulesView, name: &str, scale: f64) -> Slot {
    let mut slot = Slot::new(Role::module(name), scale);
    if let Some(m) = view.manifest(name) {
        slot.policy = state::RestartPolicy::parse(&m.restart);
        slot.api_version = Some(m.api_version.clone());
    }
    slot
}

/// Gives module `name` the held-back `health` (logged as "module not started" with `errors`) unless its child already
/// shows that state; clears any start or restart it had scheduled.
fn hold(shared: &Shared, name: &str, health: &Health, errors: &[String]) {
    let mut st = shared.lock();
    let Some(slot) = st.slot_mut(name) else {
        return;
    };
    slot.start_requested = false;
    slot.restart_at = None;
    let same = slot.child.as_ref().is_some_and(|c| {
        c.health.to_process_state(0)["state"] == health.to_process_state(0)["state"]
            && held_reason(&c.health) == held_reason(health)
    });
    if same {
        return;
    }
    let mut child = slot
        .child
        .take()
        .unwrap_or_else(|| ChildState::fresh(&slot.role));
    child.health = health.clone();
    child.since_ms = now_ms();
    child.pid = None;
    child.instance_id = None;
    child.next_restart_at_ms = None;
    slot.child = Some(child);
    broadcast_module_state(shared, slot);
    drop(st);
    shared.log.info(
        "module not started",
        json!({ "module": name, "reason": held_reason(health), "errors": errors }),
    );
}

/// The installed modules at start (D14), after the core: every module gets a slot in [`ModulesView`] order. One that
/// should run is started by the scheduler (adopted or spawned, [`start_child`]), one per turn, so a core restart is
/// never held up behind module start-up; a held-back one shows its state ([`hold`]; P13: the reasons go to the log).
/// None of the held-back ones is ever restarted on its own.
pub(super) fn start_modules(shared: &Arc<Shared>, layout: &Layout) {
    let view = modules_view(shared, layout);
    if view.installed.is_empty() {
        return;
    }
    for i in view.installed.iter().filter(|i| !valid_role_name(&i.name)) {
        shared.log.warn(
            "module directory name is not a module name; not started",
            json!({ "module": i.name }),
        );
    }
    let scale = shared.lock().time_scale;
    for name in &view.names {
        let mut slot = module_slot(&view, name, scale);
        let held = view.held.get(name).cloned().flatten();
        slot.start_requested = held.is_none();
        shared.lock().slots.push(slot);
        if let Some((health, errors)) = held {
            hold(shared, name, &health, &errors);
        }
    }
    shared.wake.notify_all();
}

/// Every installed module has a slot, and the slots follow `view` (the core first); a slot whose module is gone and
/// that runs no process is removed with its monitor.
fn sync_slots(shared: &Shared, view: &ModulesView, monitors: &mut Monitors) {
    let mut st = shared.lock();
    let scale = st.time_scale;
    let gone: Vec<String> = st
        .slots
        .iter()
        .filter(|s| s.role.kind == RoleKind::Module && !view.held.contains_key(&s.role.name))
        .map(|s| s.role.name.clone())
        .filter(|n| !monitors.get(n).is_some_and(child::Monitor::is_running))
        .collect();
    st.slots
        .retain(|s| s.role.kind == RoleKind::Core || !gone.contains(&s.role.name));
    for n in gone {
        monitors.remove(&n);
    }
    for name in &view.names {
        if st.slot(name).is_none() {
            st.slots.push(module_slot(view, name, scale));
        }
    }
    let rank = |s: &Slot| match s.role.kind {
        RoleKind::Core => 0,
        RoleKind::Module => {
            1 + view
                .names
                .iter()
                .position(|n| *n == s.role.name)
                .unwrap_or(view.names.len())
        }
    };
    st.slots.sort_by_key(rank);
}

/// The first half of bringing the modules to [`ModulesView`] (B8, B13): stops, in reverse start order, every running
/// module that is now held back (disabled, or a need that went away) and every running module in `restart` (its own
/// configuration changed) that did not start after the oldest request (M8).
pub(super) struct Reconcile {
    view: ModulesView,
    restart: BTreeSet<String>,
    oldest: Option<Instant>,
}

pub(super) fn reconcile_stop(
    shared: &Arc<Shared>,
    layout: &Layout,
    monitors: &mut Monitors,
    restart: &BTreeSet<String>,
    oldest: Option<Instant>,
) -> Reconcile {
    let view = modules_view(shared, layout);
    sync_slots(shared, &view, monitors);
    for name in view.names.iter().rev() {
        let Some(m) = monitors.get_mut(name).filter(|m| m.is_running()) else {
            continue;
        };
        let held = view.held.get(name).is_some_and(Option::is_some);
        let fresh = state::restart_already_done(m.running_since(), oldest);
        if held {
            m.stop(DEFAULT_STOP_BUDGET);
        } else if restart.contains(name) && !fresh {
            m.stop_restarting(DEFAULT_STOP_BUDGET);
        }
    }
    Reconcile {
        view,
        restart: restart.clone(),
        oldest,
    }
}

/// Whether a module that should run and runs no process is started by a reconcile: when its own configuration changed
/// (unless `module.stop` stopped it, B13), or when it is in a held-back state that no longer applies, or has never had
/// a process (a module installed or made startable since).
fn wants_start(slot: &Slot, has_monitor: bool, in_plan: bool) -> bool {
    let (state, reason) = match &slot.child {
        None => return true,
        Some(c) => {
            let ps = c.health.to_process_state(0);
            (
                ps["state"].as_str().unwrap_or("").to_string(),
                ps["reason"].as_str().map(str::to_string),
            )
        }
    };
    let reason = reason.as_deref();
    if state == "stopped" && reason == Some(state::STOPPED_BY_REQUEST) {
        return false;
    }
    if in_plan {
        return true;
    }
    let held_stop = state == "stopped"
        && matches!(
            reason,
            Some(
                state::STOPPED_DISABLED
                    | state::STOPPED_SCOPE_AGENT
                    | state::STOPPED_NEEDS_UNAVAILABLE
                    | state::STOPPED_EXT_REVOKED
                    | state::STOPPED_EXT_TAMPERED
                    | state::STOPPED_EXT_INCOMPATIBLE
            )
        );
    let held_crash = !has_monitor
        && state == "crashed"
        && matches!(reason, Some("manifest-invalid" | "api-version-unsupported"));
    held_stop || held_crash
}

/// The second half: every module that should run and runs no process is started in start order when
/// [`wants_start`] says so (a crash for good has its backoff reset first, B8); every held-back module shows its state.
/// Returns the modules of `restart` that run a process started for it (or one already fresh, M8).
pub(super) fn reconcile_start(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    r: Reconcile,
) -> Vec<String> {
    let mut restarted = Vec::new();
    for name in &r.view.names {
        match r.view.held.get(name).cloned().flatten() {
            Some((health, errors)) => {
                let requested = shared
                    .lock()
                    .slot(name)
                    .and_then(|s| s.child.as_ref())
                    .is_some_and(stopped_by_request);
                // A module stopped by request keeps showing that until it is started (B13).
                if !requested && !monitors.get(name).is_some_and(child::Monitor::is_running) {
                    hold(shared, name, &health, &errors);
                }
            }
            None => {
                let in_plan = r.restart.contains(name);
                if let Some(m) = monitors.get(name).filter(|m| m.is_running()) {
                    if in_plan && state::restart_already_done(m.running_since(), r.oldest) {
                        restarted.push(name.clone());
                    }
                    continue;
                }
                let start = {
                    let mut st = shared.lock();
                    let Some(slot) = st.slot_mut(name) else {
                        continue;
                    };
                    let start = wants_start(slot, monitors.contains_key(name), in_plan);
                    if start {
                        if state::crashed_for_good(slot.child.as_ref(), slot.backoff.given_up()) {
                            slot.backoff.reset();
                        }
                        slot.start_requested = false;
                        slot.restart_at = None;
                    }
                    start
                };
                if start {
                    start_module(shared, layout, token, name, monitors);
                    if in_plan {
                        restarted.push(name.clone());
                    }
                }
            }
        }
    }
    restarted
}

/// Starts module `name` now: through its monitor, or by probing for one to adopt and then spawning (its first start).
fn start_module(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    name: &str,
    monitors: &mut Monitors,
) {
    let role = Role::module(name);
    if monitors.contains_key(name) {
        spawn_child(shared, layout, &role, monitors);
    } else {
        start_child(shared, layout, token, &role, monitors);
    }
}

/// Runs one `module.*` control call on the main thread and sends its result.
pub(super) fn run_module_op(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    op: ModuleOp,
) {
    let ModuleOp {
        name,
        verb,
        budget,
        done,
        state,
    } = op;
    // M5: its caller already gave up and reported a failure; a staged install is dropped (its copy removed).
    if state
        .compare_exchange(
            OP_QUEUED,
            OP_RUNNING,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        shared.log.info(
            "module call cancelled before it ran (its caller timed out)",
            json!({ "module": name }),
        );
        return;
    }
    let verb_name = match &verb {
        ModuleVerb::Start => "start",
        ModuleVerb::Stop => "stop",
        ModuleVerb::Restart => "restart",
        ModuleVerb::Install(_) => "install",
        ModuleVerb::Uninstall { .. } => "uninstall",
    };
    shared.log.info(
        &format!("module.{verb_name}"),
        json!({ "module": name, "budgetMs": budget.as_millis() as u64 }),
    );
    let result = match verb {
        ModuleVerb::Install(staged) => {
            install_module(shared, layout, token, monitors, *staged, budget)
        }
        ModuleVerb::Uninstall { into } => uninstall_module(
            shared,
            layout,
            token,
            monitors,
            &name,
            into.as_deref(),
            budget,
        ),
        verb => control_module(shared, layout, token, monitors, &name, verb, budget),
    };
    if let Err(e) = &result {
        shared.log.info(
            &format!("module.{verb_name} refused"),
            json!({ "module": name, "error": e.error, "reason": e.reason, "detail": e.detail }),
        );
    }
    let _ = done.send(result);
}

fn no_children() -> OpError {
    OpError::new(
        "E_NOT_AVAILABLE",
        "this supervisor has no children to start",
        Some("no-children"),
    )
}

/// `module.start|stop|restart` (B13): refused for a module that is not installed or cannot run. `stop` leaves it
/// `stopped` with reason `stopped-by-request` (no restart scheduled) until `start`, `restart` or a supervisor restart.
fn control_module(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    name: &str,
    verb: ModuleVerb,
    budget: Duration,
) -> Result<Value, OpError> {
    if shared.lock().no_core {
        return Err(no_children());
    }
    let view = modules_view(shared, layout);
    sync_slots(shared, &view, monitors);
    match verb {
        // M3: a module that has a slot can always be stopped, whatever its manifest says now.
        ModuleVerb::Stop if shared.lock().slot(name).is_some() => {}
        ModuleVerb::Stop => return Err(OpError::unknown(name)),
        _ => view.runnable(name)?,
    }
    let running = monitors.get(name).is_some_and(child::Monitor::is_running);
    match verb {
        ModuleVerb::Stop => {
            if let Some(m) = monitors.get_mut(name) {
                m.stop(budget);
            }
            let mut st = shared.lock();
            if let Some(slot) = st.slot_mut(name) {
                slot.start_requested = false;
                slot.restart_at = None;
                let mut child = slot
                    .child
                    .take()
                    .unwrap_or_else(|| ChildState::fresh(&slot.role));
                child.health = Health::Stopped {
                    reason: Some(state::STOPPED_BY_REQUEST.to_string()),
                };
                child.since_ms = now_ms();
                child.next_restart_at_ms = None;
                slot.child = Some(child);
                broadcast_module_state(shared, slot);
            }
        }
        ModuleVerb::Restart if running => {
            if let Some(m) = monitors.get_mut(name) {
                m.restart_requested(budget);
            }
        }
        // Start, or a restart of a module that runs no process: a fresh start with its backoff cleared.
        _ if !running => {
            if let Some(slot) = shared.lock().slot_mut(name) {
                slot.backoff.reset();
                slot.start_requested = false;
                slot.restart_at = None;
            }
            start_module(shared, layout, token, name, monitors);
        }
        _ => {} // start while it runs: nothing to do
    }
    // H3B-R28: its dependents follow (a stop holds them back as needs-unavailable, a start releases them).
    let r = reconcile_stop(shared, layout, monitors, &BTreeSet::new(), None);
    reconcile_start(shared, layout, token, monitors, r);
    Ok(json!({ "accepted": true, "name": name }))
}

/// `module.install` with a supervisor (B14): a running module of that name is stopped, the staged copy put in place,
/// and the modules reconciled: the module starts again when it was running, or when it is new and may run.
fn install_module(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    staged: crate::modules::install::Staged,
    budget: Duration,
) -> Result<Value, OpError> {
    let name = staged.manifest.name.clone();
    let version = staged.manifest.version.clone();
    let no_core = shared.lock().no_core;
    let was_running = monitors.get(&name).is_some_and(child::Monitor::is_running);
    if was_running {
        if let Some(m) = monitors.get_mut(&name) {
            m.stop_restarting(budget);
        }
    }
    let replaced = match crate::modules::install::commit(staged) {
        Ok(r) => r,
        Err(e) => {
            if was_running {
                start_module(shared, layout, token, &name, monitors);
            }
            let mut err = OpError::new("E_INTERNAL", "the module could not be installed", None);
            err.detail = Some(e.to_string());
            return Err(err);
        }
    };
    shared.log.info(
        "module installed",
        json!({ "module": name, "version": version, "replaced": replaced }),
    );
    if !no_core {
        let restart: BTreeSet<String> = if was_running {
            [name.clone()].into()
        } else {
            BTreeSet::new()
        };
        let r = reconcile_stop(shared, layout, monitors, &restart, None);
        reconcile_start(shared, layout, token, monitors, r);
    }
    Ok(json!({ "name": name, "version": version, "replaced": replaced }))
}

/// `module.uninstall` with a supervisor (B14): the module is stopped, its directory and slot removed (its
/// `modules.<name>` stays in config.json), and the modules reconciled (a dependent is held back). With `into`
/// (`ext.uninstall`), the directory is moved there instead of removed (`modules::install::remove_to`).
fn uninstall_module(
    shared: &Arc<Shared>,
    layout: &Layout,
    token: &str,
    monitors: &mut Monitors,
    name: &str,
    into: Option<&std::path::Path>,
    budget: Duration,
) -> Result<Value, OpError> {
    if crate::modules::install::installed_dir(layout, name).is_none() {
        return Err(OpError::unknown(name));
    }
    if let Some(m) = monitors.get_mut(name) {
        m.stop(budget);
    }
    let removed = match into {
        None => crate::modules::install::uninstall(layout, name),
        Some(dir) => crate::modules::install::remove_to(layout, name, dir),
    };
    if let Err(e) = removed {
        let mut err = OpError::new("E_INTERNAL", "the module could not be removed", None);
        err.detail = Some(e.to_string());
        return Err(err);
    }
    shared
        .log
        .info("module uninstalled", json!({ "module": name }));
    let no_core = {
        let mut st = shared.lock();
        st.slots
            .retain(|s| s.role.name != name || s.role.kind == RoleKind::Core);
        st.no_core
    };
    monitors.remove(name);
    if !no_core {
        let r = reconcile_stop(shared, layout, monitors, &BTreeSet::new(), None);
        reconcile_start(shared, layout, token, monitors, r);
    }
    Ok(json!({ "name": name, "removed": true }))
}

/// The `module.list` result: [`crate::modules::list_entries`] with every module's child and last polled detail.
pub fn module_list(shared: &Shared, layout: &Layout) -> Value {
    let installed = crate::modules::scan(layout);
    let modules_config = relock(&shared.config)
        .running
        .as_ref()
        .map(|c| c["modules"].clone())
        .unwrap_or(Value::Null);
    let mut entries = crate::modules::list_entries(&installed, &modules_config);
    let st = shared.lock();
    for e in &mut entries {
        let slot = e["name"].as_str().and_then(|n| st.slot(n));
        e["child"] = slot
            .and_then(|s| s.child.as_ref())
            .map(ChildState::to_json)
            .unwrap_or(Value::Null);
        e["detail"] = slot.and_then(|s| s.detail.clone()).unwrap_or(Value::Null);
    }
    json!({ "modules": entries })
}

/// `Health::Crashed` for a module that never ran: no code, no signal, `reason`.
fn crashed(reason: state::CrashReason) -> Health {
    Health::Crashed {
        code: None,
        signal: None,
        at: now_ms(),
        reason: Some(reason.to_string()),
    }
}

/// `$defs/ChildStatus.role`'s pattern, `^[a-z0-9][a-z0-9-]{0,63}$`.
fn valid_role_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot_in(health: Option<Health>) -> Slot {
        let mut slot = Slot::new(Role::module("fixture"), 1.0);
        slot.child = health.map(|h| ChildState {
            health: h,
            ..ChildState::fresh(&slot.role)
        });
        slot
    }
    fn stopped(reason: Option<&str>) -> Health {
        Health::Stopped {
            reason: reason.map(str::to_string),
        }
    }
    fn crashed_with(reason: &str) -> Health {
        Health::Crashed {
            code: None,
            signal: None,
            at: 0,
            reason: Some(reason.to_string()),
        }
    }

    #[test]
    fn a_cancelled_op_never_runs_and_a_running_one_cannot_be_cancelled() {
        use std::sync::atomic::{AtomicU8, Ordering};
        let queued = AtomicU8::new(OP_QUEUED);
        assert!(cancel_op(&queued));
        assert_eq!(queued.load(Ordering::SeqCst), OP_CANCELLED);
        // The main thread's claim then fails, so the op is dropped.
        assert!(queued
            .compare_exchange(OP_QUEUED, OP_RUNNING, Ordering::SeqCst, Ordering::SeqCst)
            .is_err());
        let running = AtomicU8::new(OP_RUNNING);
        assert!(!cancel_op(&running));
    }

    #[test]
    fn wants_start_follows_the_held_states_the_plan_and_a_requested_stop() {
        // (health, has a monitor, in the plan) → started by a reconcile?
        let cases: Vec<(Option<Health>, bool, bool, bool)> = vec![
            // Never had a process (a new slot): started.
            (None, false, false, true),
            // A requested stop survives any reconcile (B13).
            (
                Some(stopped(Some(state::STOPPED_BY_REQUEST))),
                true,
                true,
                false,
            ),
            (
                Some(stopped(Some(state::STOPPED_BY_REQUEST))),
                true,
                false,
                false,
            ),
            // Its own configuration changed: started whatever it shows.
            (Some(stopped(None)), true, true, true),
            (Some(crashed_with("gave-up")), true, true, true),
            // Not in the plan: only a held-back state that no longer applies.
            (
                Some(stopped(Some(state::STOPPED_DISABLED))),
                true,
                false,
                true,
            ),
            (
                Some(stopped(Some(state::STOPPED_NEEDS_UNAVAILABLE))),
                true,
                false,
                true,
            ),
            (
                Some(stopped(Some(state::STOPPED_SCOPE_AGENT))),
                false,
                false,
                true,
            ),
            (Some(stopped(None)), true, false, false),
            (Some(Health::Ready), true, false, false),
            (Some(crashed_with("gave-up")), true, false, false),
            // A never-run module held back as crashed is started once it may run; a real exit 2 (a monitor) is not.
            (Some(crashed_with("manifest-invalid")), false, false, true),
            (
                Some(crashed_with("api-version-unsupported")),
                false,
                false,
                true,
            ),
            (Some(crashed_with("manifest-invalid")), true, false, false),
        ];
        for (health, has_monitor, in_plan, want) in cases {
            let slot = slot_in(health.clone());
            assert_eq!(
                wants_start(&slot, has_monitor, in_plan),
                want,
                "{health:?} monitor={has_monitor} plan={in_plan}"
            );
        }
    }
}
