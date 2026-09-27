//! The supervisor owns `config.json` (spec §6.1, rulings B3–B6, B18): it keeps the running configuration and its
//! revision, applies `config.set` (validated, all or nothing, written atomically), polls the file for hand edits (no
//! watcher crate: the dependency budget is std threads), applies the live keys it consumes itself
//! (`supervisor.healthIntervalMs`, `logs.*`) and tells `config.watch` subscribers (`config.changed`).
//!
//! Lock order: [`Shared::config`] before [`Shared::state`], never the other way round.
use super::subscribers::Topic;
use super::{now_ms, relock, Shared, SupervisorConfig};
use crate::paths::Layout;
use plur1bus_config as cfg;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// The watcher's tick before the time scale (B4).
pub const WATCH_TICK_MS: u64 = 1000;

/// What the supervisor knows about `config.json`, behind [`Shared::config`].
#[derive(Debug, Default)]
pub struct ConfigState {
    /// The running configuration (defaults filled in); `None` when config.json was invalid at start and no valid
    /// file has been seen since (B18).
    pub running: Option<Value>,
    /// [`cfg::revision`] of `running`.
    pub revision: Option<String>,
    /// SHA-256 of the last config.json bytes the supervisor applied or wrote itself (B4): the watcher ignores a
    /// file with these bytes.
    pub applied_hash: Option<[u8; 32]>,
    /// config.json's (mtime, length) when the watcher or a write last looked; `None` while the file is missing.
    pub stamp: Option<(SystemTime, u64)>,
    /// The last hand edit that failed validation; cleared by the next valid file or `config.set`.
    pub rejected: Option<Rejected>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    /// Wall time (epoch ms) of the rejection.
    pub at: u64,
    pub errors: Vec<String>,
    /// The rejected file's bytes (`None` when it could not be read): the watcher compares against them while the
    /// rejection is pending (M3), and a `config.set` backs exactly these up.
    pub bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetError {
    /// The schema refuses the result (`E_CONFIG_INVALID`).
    Invalid(Vec<String>),
    /// `ifRevision` names another revision than the running one (`E_CONFLICT reason=config-changed`).
    Conflict { current: String },
    /// No valid configuration runs (`E_NOT_AVAILABLE reason=config-unavailable`).
    Unavailable,
    /// The file could not be backed up or written (`E_INTERNAL`); nothing changed.
    Io(String),
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// config.json's (mtime, length), or `None` when it cannot be read (missing).
pub fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let m = fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Parses config.json's bytes (defaults filled in) or returns the validation errors.
fn parse(bytes: &[u8]) -> Result<Value, Vec<String>> {
    let text = std::str::from_utf8(bytes).map_err(|e| vec![format!("not UTF-8: {e}")])?;
    cfg::parse(text).map_err(|e| match e {
        cfg::ConfigError::Invalid(v) => v,
        other => vec![other.to_string()],
    })
}

/// config.json at supervisor start: valid → running; invalid → nothing runs and the file is `rejected` (B18); missing
/// → the defaults run (the file is written by the first `config.set`).
pub fn initial(layout: &Layout) -> ConfigState {
    let path = layout.config_path();
    let stamp = file_stamp(&path);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let d = cfg::defaults();
            return ConfigState {
                revision: Some(cfg::revision(&d)),
                running: Some(d),
                ..ConfigState::default()
            };
        }
        Err(e) => {
            return ConfigState {
                stamp,
                rejected: Some(Rejected {
                    at: now_ms(),
                    errors: vec![format!("cannot read config.json: {e}")],
                    bytes: None,
                }),
                ..ConfigState::default()
            }
        }
    };
    match parse(&bytes) {
        Ok(v) => ConfigState {
            revision: Some(cfg::revision(&v)),
            running: Some(v),
            applied_hash: Some(sha256(&bytes)),
            stamp,
            rejected: None,
        },
        Err(errors) => ConfigState {
            stamp,
            rejected: Some(Rejected {
                at: now_ms(),
                errors,
                bytes: Some(bytes),
            }),
            ..ConfigState::default()
        },
    }
}

/// `supervisor.*` and `logs.*` of the running configuration (the defaults while none runs).
pub fn supervisor_config(running: Option<&Value>) -> SupervisorConfig {
    let defaults;
    let config = match running {
        Some(v) => v,
        None => {
            defaults = cfg::defaults();
            &defaults
        }
    };
    let num =
        |section: &str, key: &str, fallback: u64| config[section][key].as_u64().unwrap_or(fallback);
    SupervisorConfig {
        grace_ms: num("supervisor", "graceMs", 60_000),
        health_interval_ms: num("supervisor", "healthIntervalMs", 5_000),
        log_max_bytes: num("logs", "maxBytes", 20 * 1024 * 1024),
        log_keep: num("logs", "keep", 5).clamp(1, u32::MAX as u64) as u32,
    }
}

/// `daemon.status.config`.
pub fn status_json(st: &ConfigState) -> Value {
    json!({
        "revision": st.revision,
        "rejected": st.rejected.as_ref().map(|r| json!({ "at": r.at, "errors": r.errors })),
    })
}

fn restart_json(r: &cfg::Restart) -> Value {
    json!({ "live": r.live, "core": r.core, "modules": r.modules })
}

fn tier_name(t: cfg::Tier) -> &'static str {
    match t {
        cfg::Tier::Basic => "basic",
        cfg::Tier::Advanced => "advanced",
    }
}

/// The `config.get` result for `config` (the supervisor's running configuration, or the file the CLI read when no
/// supervisor runs): the whole value, one tier, or one key (`None` when the key does not exist).
pub fn get_result(
    config: &Value,
    revision: &str,
    key: Option<&str>,
    tier: Option<cfg::Tier>,
) -> Option<Value> {
    if let Some(t) = tier {
        return Some(json!({
            "key": Value::Null, "tier": tier_name(t), "value": cfg::filter_config_by_tier(config, t),
            "restartClass": Value::Null, "restart": Value::Null, "revision": revision,
        }));
    }
    let value = cfg::get(config, key)?;
    let class = key.map(cfg::restart_class_name);
    let restart = class
        .as_deref()
        .map(|c| if c.starts_with("module") { "module" } else { c });
    Some(json!({
        "key": key, "tier": key.map(|k| tier_name(cfg::tier_of(k))), "value": value,
        "restartClass": class, "restart": restart, "revision": revision,
    }))
}

/// Applies what the supervisor itself consumes of `config` at once: the health interval (read by the health loop
/// before each poll) and the log limits.
fn apply_live(shared: &Shared, config: &Value) {
    let sc = supervisor_config(Some(config));
    shared.log.set_limits(sc.log_max_bytes, sc.log_keep);
    for out in relock(&shared.out_logs).iter() {
        if let Some(f) = relock(out).as_mut() {
            f.set_limits(sc.log_max_bytes, sc.log_keep);
        }
    }
    shared.lock().config = sc;
}

/// B18: a core that exited 2 (`config-invalid`, fatal) is started again by the first valid config.json after an
/// invalid one (nothing ran, or the watcher had rejected the file): a hand edit, a `config.set` over the rejected file,
/// or the bytes that already ran (an edit reverted). A change while the file was valid all along does not re-arm it.
/// Its backoff is reset, as for `daemon.start`.
fn rearm_core(shared: &Shared) {
    let mut st = shared.lock();
    let (no_core, stopping) = (st.no_core, st.stopping.is_some());
    let Some(core) = st.slot_mut("core") else {
        return;
    };
    let crashed_config_invalid = core.child.as_ref().is_some_and(|c| {
        matches!(&c.health, super::state::Health::Crashed { reason: Some(r), .. }
            if r == super::state::CrashReason::ConfigInvalid.as_str())
    });
    if crashed_config_invalid && !no_core && !stopping && !core.start_requested {
        core.backoff.reset();
        core.start_requested = true;
        shared.wake.notify_all();
        drop(st);
        shared.log.info(
            "config.json is valid again, restarting the core",
            json!({ "child": "core" }),
        );
    }
}

/// Makes `new` the running configuration and tells the subscribers. Called with the config lock held, so
/// notifications go out in revision order.
fn install(shared: &Shared, st: &mut ConfigState, new: Value, source: &str) {
    let previous = st.revision.clone();
    let was_invalid = st.running.is_none() || st.rejected.is_some();
    let before = st.running.take().unwrap_or_else(|| json!({}));
    let plan = cfg::restart_plan(&before, &new);
    let revision = cfg::revision(&new);
    st.running = Some(new.clone());
    st.revision = Some(revision.clone());
    st.rejected = None;
    apply_live(shared, &new);
    if was_invalid {
        rearm_core(shared);
    }
    if plan.changed.is_empty() && previous.is_some() {
        return;
    }
    shared.log.info(
        "configuration applied",
        json!({ "source": source, "revision": revision, "previousRevision": previous, "changed": plan.changed }),
    );
    let params = json!({
        "revision": revision, "previousRevision": previous, "changed": plan.changed,
        "restart": restart_json(&plan.restart), "config": new, "source": source,
    });
    for d in shared
        .subscribers
        .broadcast(Topic::Config, "config.changed", &params)
    {
        shared.log.warn(
            "config.watch subscriber dropped",
            json!({ "subscriptionId": d.id, "reason": d.reason }),
        );
    }
    // A hand edit of `modules.<name>` restarts, stops or starts that module like a `config.set` (B13); nobody waits
    // for it. (A core key edited by hand reaches the core through its own `restartPending`, B7.)
    if source == "file" && !plan.restart.modules.is_empty() {
        let modules = cfg::Restart {
            modules: plan.restart.modules.clone(),
            ..Default::default()
        };
        drop(super::push_restart(shared, modules));
    }
}

/// `config.set` (B5): validates `changes` against the running configuration (all or none), refuses a stale
/// `if_revision`, writes config.json atomically (after backing up a rejected hand edit, B4), makes the result the
/// running configuration and notifies the subscribers (`source: "set"`). `dry_run` only computes the plan. A changed
/// `modules.<name>` is validated against the module's `configSchema` (B13). A change of a `core`-class or a module key
/// then restarts that unit (B8): the job is queued with the new configuration, and waited for (up to the stop budget
/// plus the ready timeout) without the config lock (H3B-R6); `restarted`, `durationMs` and `estimates.core` report it.
pub fn set(
    shared: &Arc<Shared>,
    layout: &Layout,
    changes: Vec<(String, Value)>,
    if_revision: Option<&str>,
    dry_run: bool,
) -> Result<Value, SetError> {
    let started = Instant::now();
    // Serialised by the config mutex. It is released at the end of this block: a later step that waits for a
    // restart job (Task 5) must wait without it, because the restarted core's own `config.watch` needs it (H3B-R6).
    let (applied, changed, restart, revision, job) = {
        let mut st = relock(&shared.config);
        // I1: a hand edit the watcher has not seen yet is applied (or rejected) first, under this lock, so the set
        // builds on it: never overwritten unseen, and a stale `ifRevision` is a conflict.
        poll_locked(shared, layout, &mut st);
        let Some(running) = st.running.clone() else {
            return Err(SetError::Unavailable);
        };
        let current = st
            .revision
            .clone()
            .unwrap_or_else(|| cfg::revision(&running));
        if let Some(r) = if_revision {
            if r != current {
                return Err(SetError::Conflict { current });
            }
        }
        let plan = cfg::set_many(&running, &changes).map_err(|e| match e {
            cfg::ConfigError::Invalid(v) => SetError::Invalid(v),
            other => SetError::Invalid(vec![other.to_string()]),
        })?;
        // B13: a changed `modules.<name>` must satisfy its manifest's configSchema.
        let module_errors =
            crate::modules::config_errors(&crate::modules::scan(layout), &running, &plan.after);
        if !module_errors.is_empty() {
            return Err(SetError::Invalid(module_errors));
        }
        let restart = restart_json(&plan.restart);
        if dry_run || (plan.changed.is_empty() && st.rejected.is_none()) {
            (!dry_run, plan.changed, restart, current, None)
        } else {
            let path = layout.config_path();
            if let Some(rejected) = &st.rejected {
                // The bytes the watcher rejected, read under this lock a moment ago (not whatever is on disk now).
                let backup = path.with_file_name(format!("config.json.rejected-{}", now_ms()));
                let copied = match &rejected.bytes {
                    Some(b) => fs::write(&backup, b),
                    None => fs::copy(&path, &backup).map(|_| ()),
                };
                copied.map_err(|e| {
                    SetError::Io(format!("cannot back up the rejected config.json: {e}"))
                })?;
                shared.log.info(
                    "rejected config.json backed up",
                    json!({ "path": backup.display().to_string() }),
                );
            }
            let meta = cfg::write_atomic(&path, &plan.after)
                .map_err(|e| SetError::Io(format!("cannot write config.json: {e}")))?;
            st.applied_hash = Some(sha256(cfg::serialize(&plan.after).as_bytes()));
            // The temp file's stamp, taken before the rename: a write that lands after it always differs.
            st.stamp = meta.modified().ok().map(|m| (m, meta.len()));
            install(shared, &mut st, plan.after, "set");
            let revision = st.revision.clone().unwrap_or_default();
            // Queued before the config lock is released, so the job precedes any the restarted core's own
            // `restartPending` could cause. A module key restarts its module (B13), `enabled` stops or starts it.
            let job = (plan.restart.core || !plan.restart.modules.is_empty())
                .then(|| super::push_restart(shared, plan.restart.clone()))
                .flatten();
            (true, plan.changed, restart, revision, job)
        }
    };
    let mut restarted: Vec<String> = Vec::new();
    if let Some(rx) = job {
        let deadline = started + super::DEFAULT_STOP_BUDGET + ready_timeout(shared);
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(mut units) => {
                // M4: a unit counts as restarted only once its new process is ready.
                units.retain(|u| {
                    let ready = wait_ready(shared, u, deadline);
                    if !ready {
                        shared.log.warn(
                            &format!("the restarted {u} did not become ready"),
                            json!({ "revision": revision }),
                        );
                    }
                    ready
                });
                restarted = units;
            }
            Err(_) => shared.log.warn(
                "the requested restart did not finish in time",
                json!({ "revision": revision }),
            ),
        }
    }
    let mut out = json!({
        "applied": applied, "dryRun": dry_run, "changed": changed, "restart": restart, "revision": revision,
        "restarted": restarted, "durationMs": started.elapsed().as_millis() as u64,
    });
    // The last spawn-to-ready time is the estimate: on a dry run it informs the decision (M3).
    if (applied || dry_run) && restart["core"] == true {
        out["estimates"] = json!({ "core": shared.lock().core_ready_ms });
    }
    Ok(out)
}

/// The ready timeout of a spawned core before the time scale (60 s, as `child::Timing`).
const READY_TIMEOUT_SECS: u64 = 60;

/// The longest a `config.set` waits for its restart job (time scale 1): the stop budget plus the ready timeout. The
/// CLI's `config.set` call deadline is this plus 10 s (H3B-R22), so it never gives up while the supervisor waits.
pub const RESTART_WAIT_MAX: Duration =
    Duration::from_secs(super::DEFAULT_STOP_BUDGET.as_secs() + READY_TIMEOUT_SECS);

/// The supervisor's ready timeout for a spawned core (60 s × time scale, as `child::Timing`).
fn ready_timeout(shared: &Shared) -> Duration {
    Duration::from_secs_f64(READY_TIMEOUT_SECS as f64 * shared.lock().time_scale)
}

/// Waits until the unit (`core` or a module) the restart started is ready (true), or has exited or `deadline` passes
/// (false).
fn wait_ready(shared: &Shared, unit: &str, deadline: Instant) -> bool {
    use super::state::Health;
    while Instant::now() < deadline {
        let st = shared.lock();
        let health = st
            .slot(unit)
            .and_then(|s| s.child.as_ref())
            .map(|c| c.health.clone());
        drop(st);
        match health {
            Some(Health::Ready) => return true,
            Some(Health::Crashed { .. } | Health::Stopped { .. }) | None => return false,
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// One watcher tick (B4): see [`poll_locked`].
pub fn poll_file(shared: &Arc<Shared>, layout: &Layout) {
    let mut st = relock(&shared.config);
    poll_locked(shared, layout, &mut st);
}

/// Looks at config.json with the config lock held (the watcher's tick, and the start of every `config.set`, I1).
/// When its mtime or length changed, or while a rejection is pending (M3: a fix of the same length within one
/// coarse mtime tick is still seen), it is read: bytes the supervisor applied or wrote itself are ignored; a valid,
/// different file is applied like a set (`source: "file"`); an invalid one leaves the running configuration alone
/// and is recorded in `rejected`. The file is never rewritten here.
fn poll_locked(shared: &Shared, layout: &Layout, st: &mut ConfigState) {
    let path = layout.config_path();
    let stamp = file_stamp(&path);
    if stamp == st.stamp && st.rejected.is_none() {
        return;
    }
    st.stamp = stamp;
    if stamp.is_none() {
        if st.rejected.is_none() {
            shared.log.warn(
                "config.json is gone; the running configuration stays",
                json!({}),
            );
        }
        return;
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            st.stamp = None; // look again at the next tick
            shared
                .log
                .warn("cannot read config.json", json!({ "err": e.to_string() }));
            return;
        }
    };
    if st
        .rejected
        .as_ref()
        .is_some_and(|r| r.bytes.as_deref() == Some(&bytes[..]))
    {
        return; // still the file already rejected
    }
    let hash = sha256(&bytes);
    if st.applied_hash == Some(hash) {
        if st.rejected.take().is_some() {
            shared.log.info(
                "config.json matches the running configuration again",
                json!({}),
            );
            rearm_core(shared);
        }
        return;
    }
    match parse(&bytes) {
        Err(errors) => {
            shared.log.warn(
                "config.json rejected; the running configuration stays",
                json!({ "errors": errors, "running": st.revision }),
            );
            st.rejected = Some(Rejected {
                at: now_ms(),
                errors,
                bytes: Some(bytes),
            });
        }
        Ok(new) => {
            // B13: a hand edit of `modules.<name>` must satisfy the module's configSchema too.
            let before = st.running.clone().unwrap_or_else(|| json!({}));
            let errors =
                crate::modules::config_errors(&crate::modules::scan(layout), &before, &new);
            if !errors.is_empty() {
                shared.log.warn(
                    "config.json rejected; the running configuration stays",
                    json!({ "errors": errors, "running": st.revision }),
                );
                st.rejected = Some(Rejected {
                    at: now_ms(),
                    errors,
                    bytes: Some(bytes),
                });
                return;
            }
            st.applied_hash = Some(hash);
            install(shared, st, new, "file");
        }
    }
}

/// Starts the watcher thread: [`poll_file`] every `WATCH_TICK_MS × scale`, for the life of the process.
pub fn spawn_watcher(shared: &Arc<Shared>, layout: &Layout, scale: f64) -> std::io::Result<()> {
    let tick = Duration::from_secs_f64(WATCH_TICK_MS as f64 / 1000.0 * scale);
    let (s, l) = (shared.clone(), layout.clone());
    super::spawn_guarded(shared, "config-watch", move || loop {
        std::thread::sleep(tick);
        poll_file(&s, &l);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_state_follows_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path().to_path_buf());
        // Missing: the defaults run, nothing is written.
        let st = initial(&layout);
        assert_eq!(st.running, Some(cfg::defaults()));
        assert_eq!(st.revision, Some(cfg::revision(&cfg::defaults())));
        assert!(st.rejected.is_none() && st.applied_hash.is_none());
        assert!(!layout.config_path().exists());
        // Valid: it runs, and its bytes are the applied ones.
        cfg::write_atomic(&layout.config_path(), &cfg::defaults()).unwrap();
        let st = initial(&layout);
        assert!(st.running.is_some() && st.stamp.is_some());
        assert_eq!(
            st.applied_hash,
            Some(sha256(&fs::read(layout.config_path()).unwrap()))
        );
        // Invalid: nothing runs (B18) and the file is rejected with its errors.
        fs::write(
            layout.config_path(),
            r#"{"schemaVersion":1,"core":{"logLevel":"loud"}}"#,
        )
        .unwrap();
        let st = initial(&layout);
        assert!(st.running.is_none() && st.revision.is_none());
        let r = st.rejected.unwrap();
        assert!(r.errors.iter().any(|e| e.contains("logLevel")), "{r:?}");
        assert_eq!(
            supervisor_config(None),
            supervisor_config(Some(&cfg::defaults()))
        );
    }

    #[test]
    fn get_result_keeps_the_cli_restart_field_and_adds_class_and_revision() {
        let c = cfg::defaults();
        let v = get_result(&c, "r1", Some("core.logLevel"), None).unwrap();
        assert_eq!(v["restart"], "live");
        assert_eq!(v["restartClass"], "live");
        assert_eq!(v["tier"], "advanced");
        assert_eq!(v["revision"], "r1");
        let v = get_result(&c, "r1", None, Some(cfg::Tier::Basic)).unwrap();
        assert!(v["key"].is_null() && v["restart"].is_null() && v["restartClass"].is_null());
        assert!(v["value"].get("core").is_none());
        assert!(get_result(&c, "r1", Some("nope.key"), None).is_none());
        let whole = get_result(&c, "r1", None, None).unwrap();
        assert_eq!(whole["value"], c);
        assert!(whole["tier"].is_null());
    }
}
