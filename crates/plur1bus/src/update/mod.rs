//! `plur1bus update` (D78, milestones §6.3 item 4, plan 2026-10-06-m8): download and verify, snapshot, swap, start,
//! health gate, and an automatic rollback when any step after the first write fails. The flow is a persistent state
//! machine ([`state`]); [`recover`] settles whatever a crashed run left behind. Everything that touches processes or
//! the service manager goes through [`Host`], so the machine itself is unit-tested with a fake one.
//!
//! Reached only from `update` and `daemon start` (the recovery hook), never from `supervisor/`.
pub mod addons;
pub mod bundle;
pub mod guard;
pub mod host;
pub mod plan;
pub mod snapshot;
pub mod state;

use crate::install::archive;
use crate::install::fetch;
use crate::install::manifest::{self, CoreUnit};
use crate::paths::Layout;
use serde::Serialize;
use state::{CoreTarget, Phase, State, Target};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const BINARY_MAX_BYTES: u64 = 512 << 20;
const CORE_MAX_BYTES: u64 = 1 << 30;
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(15 * 60);

/// Process-level side effects of an update.
pub trait Host {
    /// Stops the daemon (through the service manager when one owns the home). Returns whether it was running.
    fn stop(&self, layout: &Layout) -> Result<bool, String>;
    /// Starts the daemon with `bin` (the *target* binary, so the new supervisor runs the new code).
    fn start(&self, layout: &Layout, bin: &Path) -> Result<(), String>;
    /// The health gate (plan R5) against `bin`, which must report `version`.
    fn gate(&self, layout: &Layout, bin: &Path, version: &str) -> Result<(), String>;
    /// Whether the process that owned an update is still running.
    fn alive(&self, pid: u32) -> bool;
    /// Disables the add-ons that are incompatible with the new version (the daemon is stopped, the swap is done) and
    /// records them. On an `Err` nothing stays disabled. The default does nothing (a [`Host`] without ext access).
    fn disable_addons(
        &self,
        _layout: &Layout,
        _plan: &addons::AddonPlan,
        _from: &str,
        _to: &str,
    ) -> Result<(), String> {
        Ok(())
    }
    /// After a rollback: puts back what [`Host::disable_addons`] disabled. Returns the names it could not.
    fn restore_addons(&self, _layout: &Layout, _names: &[String]) -> Vec<String> {
        Vec::new()
    }
    /// After the new version is healthy: re-enables add-ons an earlier update disabled that are compatible now.
    /// Returns `(name, why)` for the ones that refused.
    fn reenable_addons(&self, _layout: &Layout, _names: &[String]) -> Vec<(String, String)> {
        Vec::new()
    }
}

/// A refusal or failure before anything was written (`reason` is a frozen string, `message` for people).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError {
    pub reason: &'static str,
    pub message: String,
}

impl UpdateError {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        UpdateError {
            reason,
            message: message.into(),
        }
    }
}

/// One asset to download.
#[derive(Debug, Clone)]
pub struct Asset {
    pub url: String,
    pub sha256: String,
    /// The size the signed manifest states: the download may not exceed it and must equal it.
    pub size: Option<u64>,
}

/// What a verified feed asks this install to become.
#[derive(Debug, Clone)]
pub struct Plan {
    pub from: String,
    pub to: String,
    pub channel: String,
    pub binary: Asset,
    /// The core payload and its release unit, when the core changes.
    pub core: Option<(Asset, manifest::ReleaseCore)>,
    /// What the new version means for installed add-ons.
    pub addons: addons::AddonPlan,
    /// Raise the channel's highest-seen version to `to` once the artefacts verified (replay protection).
    pub record_seen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Committed,
    RolledBack,
    Failed,
}

/// `PLUR1BUS_TEST_UPDATE_KILL_AT=<phase>` (test internals): the process dies abruptly right after that phase is
/// written, as a killed updater would.
fn maybe_die(phase: Phase) {
    let on = std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1");
    if !on {
        return;
    }
    let name = serde_json::to_value(phase)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string));
    if std::env::var("PLUR1BUS_TEST_UPDATE_KILL_AT").ok() == name {
        std::process::exit(137);
    }
}

fn enter(layout: &Layout, s: &mut State, phase: Phase) -> Result<(), String> {
    s.phase = phase;
    state::save(layout, s).map_err(|e| format!("cannot write the update state: {e}"))?;
    maybe_die(phase);
    Ok(())
}

/// A file whose manifest states a size must have exactly that many bytes.
fn size_matches(p: &Path, declared: Option<u64>) -> Result<(), String> {
    let Some(want) = declared else { return Ok(()) };
    let got = fs::metadata(p)
        .map_err(|e| format!("{}: {e}", p.display()))?
        .len();
    if got == want {
        Ok(())
    } else {
        Err(format!(
            "{} has {got} bytes, the signed manifest says {want}",
            p.display()
        ))
    }
}

/// Downloads and verifies the new binary (and core payload) into `update/staging/`. Nothing outside it changes, and a
/// previous snapshot stays untouched, so a refused download costs nothing.
fn download(layout: &Layout, plan: &Plan) -> Result<(), UpdateError> {
    let staging = state::staging_dir(layout);
    state::remove_dir(&staging);
    fs::create_dir_all(&staging)
        .map_err(|e| UpdateError::new("io", format!("{}: {e}", staging.display())))?;
    let fail = |e: fetch::FetchError| {
        state::remove_dir(&staging);
        UpdateError::new(e.reason(), format!("download failed: {e}"))
    };
    let bin = staging.join("plur1bus");
    fetch::fetch_verified(
        &plan.binary.url,
        &bin,
        &plan.binary.sha256,
        plan.binary
            .size
            .map_or(BINARY_MAX_BYTES, |s| s.min(BINARY_MAX_BYTES)),
        DOWNLOAD_DEADLINE,
    )
    .map_err(fail)?;
    size_matches(&bin, plan.binary.size).map_err(|m| {
        state::remove_dir(&staging);
        UpdateError::new("size-mismatch", m)
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755))
            .map_err(|e| UpdateError::new("io", format!("{}: {e}", bin.display())))?;
    }
    if let Some((asset, _)) = &plan.core {
        let tar = staging.join("core.tar.gz");
        fetch::fetch_verified(
            &asset.url,
            &tar,
            &asset.sha256,
            asset.size.map_or(CORE_MAX_BYTES, |s| s.min(CORE_MAX_BYTES)),
            DOWNLOAD_DEADLINE,
        )
        .map_err(fail)?;
        size_matches(&tar, asset.size).map_err(|m| {
            state::remove_dir(&staging);
            UpdateError::new("size-mismatch", m)
        })?;
        let into = staging.join("core-extract");
        let extracted = archive::verify_and_extract(&tar, &asset.sha256, &into, 0);
        let _ = fs::remove_file(&tar);
        if let Err(e) = extracted {
            state::remove_dir(&staging);
            return Err(UpdateError::new(
                e.reason(),
                format!("core payload refused: {e}"),
            ));
        }
        let root = crate::install::setup::payload_root(&into).ok_or_else(|| {
            UpdateError::new("core-payload-invalid", "the core payload has no core.js")
        })?;
        fs::rename(&root, staging.join("core"))
            .map_err(|e| UpdateError::new("io", format!("{}: {e}", root.display())))?;
        state::remove_dir(&into);
    }
    Ok(())
}

fn fresh_state(plan: &Plan, target_bin: &Path, trigger: &str) -> State {
    let now = state::now_ms();
    State {
        id: state::new_id(),
        trigger: trigger.into(),
        phase: Phase::Stopping,
        from: plan.from.clone(),
        to: plan.to.clone(),
        channel: plan.channel.clone(),
        owner: std::process::id(),
        started_at: now,
        updated_at: now,
        was_running: false,
        target_bin: target_bin.to_path_buf(),
        core_swapped: false,
        release: Target {
            binary_sha256: plan.binary.sha256.to_ascii_lowercase(),
            core: plan.core.as_ref().map(|(a, c)| CoreTarget {
                version: c.version.clone(),
                contract: c.contract.clone(),
                rpc: c.rpc.clone(),
                sha256: a.sha256.to_ascii_lowercase(),
            }),
        },
        reason: None,
        message: None,
        addons_disabled: Vec::new(),
        addons_reenable: plan.addons.reenable.clone(),
    }
}

/// Refuses while another update's owner is alive; otherwise settles a dead one first.
fn ensure_idle(layout: &Layout, host: &dyn Host) -> Result<(), UpdateError> {
    match state::load(layout) {
        Err(m) => Err(UpdateError::new("state-unreadable", m)),
        Ok(Some(s)) if !s.phase.is_terminal() => {
            if host.alive(s.owner) {
                return Err(UpdateError::new(
                    "update-in-progress",
                    format!("update {} is still running (pid {})", s.id, s.owner),
                ));
            }
            let after = recover(layout, host)
                .map_err(|m| UpdateError::new("state-unreadable", m))?
                .map(|s| s.phase);
            match after {
                Some(Phase::Failed) => Err(UpdateError::new(
                    "snapshot-invalid",
                    "an interrupted update could not be rolled back: its snapshot does not verify",
                )),
                _ => Ok(()),
            }
        }
        Ok(_) => Ok(()),
    }
}

/// Runs the whole flow for `plan`. `Err`: refused or failed before the first write (nothing changed). `Ok`: the
/// final state, `Committed` or, after an automatic rollback, `RolledBack`/`Failed`.
pub fn apply(
    layout: &Layout,
    host: &dyn Host,
    plan: &Plan,
    target_bin: &Path,
) -> Result<State, UpdateError> {
    ensure_idle(layout, host)?;
    let installed = manifest::read(layout)
        .map_err(|m| UpdateError::new("not-installed", m))?
        .ok_or_else(|| {
            UpdateError::new(
                "not-installed",
                "no install manifest: run `plur1bus setup` first",
            )
        })?;
    if installed.binary.version != plan.from {
        return Err(UpdateError::new(
            "not-installed",
            "the install manifest changed under the update",
        ));
    }
    download(layout, plan)?;
    if plan.record_seen {
        // Every artefact matches the signed manifest: from here on an older manifest is a replay, whatever happens next.
        guard::record_seen(layout, &plan.channel, &plan.to)
            .map_err(|m| UpdateError::new("guard-unreadable", m))?;
    }

    let mut st = fresh_state(plan, target_bin, "update");
    let io = |m: String| UpdateError::new("io", m);
    enter(layout, &mut st, Phase::Stopping).map_err(io)?;
    match host.stop(layout) {
        Ok(was) => st.was_running = was,
        Err(m) => {
            // Nothing was written yet except the state: close it as an untouched, rolled-back attempt.
            st.reason = Some("stop-failed".into());
            st.message = Some(m.clone());
            let _ = enter(layout, &mut st, Phase::RolledBack);
            state::remove_dir(&state::staging_dir(layout));
            return Err(UpdateError::new("stop-failed", m));
        }
    }
    if let Err(m) = snapshot::create(layout, target_bin) {
        st.reason = Some("snapshot-failed".into());
        st.message = Some(m.clone());
        let _ = enter(layout, &mut st, Phase::RolledBack);
        if st.was_running {
            let _ = host.start(layout, target_bin);
        }
        return Err(UpdateError::new("snapshot-failed", m));
    }
    enter(layout, &mut st, Phase::Snapshotted).map_err(io)?;

    let flow = (|| -> Result<(), (&'static str, String)> {
        enter(layout, &mut st, Phase::Swapping).map_err(|m| ("io", m))?;
        swap(layout, plan, target_bin, &mut st).map_err(|m| ("swap-failed", m))?;
        enter(layout, &mut st, Phase::Swapped).map_err(|m| ("io", m))?;
        if !plan.addons.disable.is_empty() {
            // Written first: a crash between here and the end of the disabling must still be undone by recovery.
            st.addons_disabled = plan.addons.disable.clone();
            state::save(layout, &mut st).map_err(|e| ("io", e.to_string()))?;
            host.disable_addons(layout, &plan.addons, &plan.from, &plan.to)
                .map_err(|m| ("addon-disable-failed", m))?;
        }
        host.start(layout, target_bin)
            .map_err(|m| ("start-failed", m))?;
        enter(layout, &mut st, Phase::Started).map_err(|m| ("io", m))?;
        host.gate(layout, target_bin, &plan.to)
            .map_err(|m| ("health-gate-failed", m))?;
        enter(layout, &mut st, Phase::Gated).map_err(|m| ("io", m))
    })();
    match flow {
        Ok(()) => match commit(layout, host, &mut st) {
            Ok(()) => Ok(st),
            Err(m) => Ok(rollback(layout, host, st, "commit-failed", &m)),
        },
        Err((reason, message)) => Ok(rollback(layout, host, st, reason, &message)),
    }
}

/// The swap: the new binary over the target, the old core tree into the snapshot and the new one in its place.
fn swap(layout: &Layout, plan: &Plan, target_bin: &Path, st: &mut State) -> Result<(), String> {
    let staging = state::staging_dir(layout);
    snapshot::put_file(&staging.join("plur1bus"), target_bin)
        .map_err(|e| format!("{}: {e}", target_bin.display()))?;
    if plan.core.is_some() {
        snapshot::core_in(layout)?;
        let core = layout.runtime().join("core");
        fs::create_dir_all(layout.runtime()).map_err(|e| e.to_string())?;
        fs::rename(staging.join("core"), &core).map_err(|e| format!("{}: {e}", core.display()))?;
        st.core_swapped = true;
    }
    Ok(())
}

/// Writes the install manifest of the new version, closes the state and removes the staging area. The snapshot stays
/// for `update --rollback` (plan R6).
fn commit(layout: &Layout, host: &dyn Host, st: &mut State) -> Result<(), String> {
    let mut m = manifest::read(layout)?.ok_or("no install manifest to update")?;
    m.binary.version = st.to.clone();
    m.binary.sha256 = Some(st.release.binary_sha256.clone());
    if let Some(c) = &st.release.core {
        m.core = CoreUnit {
            version: c.version.clone(),
            contract: c.contract.clone(),
            rpc: c.rpc.clone(),
            sha256: Some(c.sha256.clone()),
            source: "release".into(),
        };
    }
    m.updated_at = state::now_ms();
    manifest::write(layout, &m).map_err(|e| format!("cannot write manifest.json: {e}"))?;
    if !st.addons_reenable.is_empty() {
        let refused = host.reenable_addons(layout, &st.addons_reenable);
        if !refused.is_empty() {
            let list: Vec<String> = refused.iter().map(|(n, w)| format!("{n} ({w})")).collect();
            st.message = Some(format!("add-ons not re-enabled: {}", list.join("; ")));
        }
    }
    enter(layout, st, Phase::Committed)?;
    state::remove_dir(&state::staging_dir(layout));
    if !st.was_running {
        let _ = host.stop(layout);
    }
    let _ = crate::audit::append(
        layout,
        "update.apply",
        &st.to,
        serde_json::json!({ "from": st.from, "to": st.to, "id": st.id }),
    );
    Ok(())
}

/// Puts the snapshot back (after verifying it) and restarts the daemon when it was running. The returned state is
/// `RolledBack`, or `Failed` when the snapshot does not verify (then nothing is restored).
fn rollback(layout: &Layout, host: &dyn Host, mut st: State, reason: &str, message: &str) -> State {
    st.reason = Some(reason.to_string());
    st.message = Some(message.to_string());
    let _ = enter(layout, &mut st, Phase::RollingBack);
    let _ = host.stop(layout);
    let restored = snapshot::verify(layout)
        .and_then(|meta| snapshot::restore(layout, &st.target_bin, &meta).map(|_| meta));
    match restored {
        Ok(_) => {
            if !st.addons_disabled.is_empty() {
                let failed = host.restore_addons(layout, &st.addons_disabled);
                if !failed.is_empty() {
                    st.message = Some(format!(
                        "{message}; add-ons that stayed disabled: {}",
                        failed.join(", ")
                    ));
                }
            }
            if st.was_running {
                if let Err(m) = host.start(layout, &st.target_bin) {
                    st.message = Some(format!(
                        "{message}; the previous version was restored but did not start: {m}"
                    ));
                }
            }
            let _ = enter(layout, &mut st, Phase::RolledBack);
            state::remove_dir(&state::staging_dir(layout));
        }
        Err(m) => {
            st.message = Some(format!("{message}; rollback refused: {m}"));
            let _ = enter(layout, &mut st, Phase::Failed);
        }
    }
    st
}

/// Settles an update whose owner is gone (plan "Design"): before the swap nothing changed; from `swapping` on it is
/// rolled back; once the gate passed it is rolled forward. `Ok(None)`: nothing to do (no update, a finished one, or
/// an owner that is still alive).
pub fn recover(layout: &Layout, host: &dyn Host) -> Result<Option<State>, String> {
    let Some(mut st) = state::load(layout)? else {
        return Ok(None);
    };
    if st.phase.is_terminal() || host.alive(st.owner) {
        return Ok(None);
    }
    // From here the recovering process owns the update (a `daemon start` it runs must not recover again).
    st.owner = std::process::id();
    let settled = match st.phase {
        Phase::Stopping | Phase::Snapshotted => {
            st.reason = Some("interrupted".into());
            st.message = Some("the update stopped before the swap; nothing was changed".into());
            enter(layout, &mut st, Phase::RolledBack)?;
            state::remove_dir(&state::staging_dir(layout));
            if st.was_running {
                let _ = host.start(layout, &st.target_bin);
            }
            st
        }
        Phase::Gated => {
            commit(layout, host, &mut st)?;
            st
        }
        _ => rollback(
            layout,
            host,
            st,
            "interrupted",
            "the update was interrupted after the swap",
        ),
    };
    Ok(Some(settled))
}

/// `update --rollback`: restores the snapshot of the last committed update.
pub fn rollback_manual(layout: &Layout, host: &dyn Host) -> Result<State, UpdateError> {
    ensure_idle(layout, host)?;
    let last = state::load(layout)
        .map_err(|m| UpdateError::new("state-unreadable", m))?
        .filter(|s| s.phase == Phase::Committed)
        .ok_or_else(|| {
            UpdateError::new(
                "nothing-to-roll-back",
                "no committed update has a snapshot to go back to",
            )
        })?;
    let meta = snapshot::verify(layout).map_err(|m| UpdateError::new("snapshot-invalid", m))?;
    let undo_addons = last.addons_disabled.clone();
    let mut st = State {
        id: state::new_id(),
        trigger: "manual-rollback".into(),
        phase: Phase::RollingBack,
        from: last.to.clone(),
        to: last.from.clone(),
        owner: std::process::id(),
        started_at: state::now_ms(),
        reason: Some("manual".into()),
        message: None,
        addons_disabled: Vec::new(),
        addons_reenable: Vec::new(),
        ..last
    };
    let io = |m: String| UpdateError::new("io", m);
    enter(layout, &mut st, Phase::RollingBack).map_err(io)?;
    st.was_running = host
        .stop(layout)
        .map_err(|m| UpdateError::new("stop-failed", m))?;
    if let Err(m) = snapshot::restore(layout, &st.target_bin, &meta) {
        st.message = Some(m.clone());
        let _ = enter(layout, &mut st, Phase::Failed);
        return Err(UpdateError::new("restore-failed", m));
    }
    if st.was_running {
        if let Err(m) = host.start(layout, &st.target_bin) {
            st.message = Some(format!(
                "restored, but the previous version did not start: {m}"
            ));
        }
    }
    if !undo_addons.is_empty() {
        // The previous version is back: the add-ons its successor disabled were fine with it.
        let failed = host.restore_addons(layout, &undo_addons);
        if !failed.is_empty() {
            st.message = Some(format!(
                "add-ons that stayed disabled: {}",
                failed.join(", ")
            ));
        }
    }
    enter(layout, &mut st, Phase::RolledBack).map_err(UpdateError::new_io)?;
    state::remove_dir(&state::snapshot_dir(layout));
    let _ = crate::audit::append(
        layout,
        "update.rollback",
        &st.to,
        serde_json::json!({ "from": st.from, "to": st.to, "id": st.id }),
    );
    Ok(st)
}

impl UpdateError {
    fn new_io(m: String) -> Self {
        UpdateError::new("io", m)
    }
}

/// Where the swap lands: `PLUR1BUS_UPDATE_TARGET_BIN` under test internals, else the running binary (plan R4).
pub fn target_binary() -> Result<PathBuf, String> {
    if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1") {
        if let Some(p) = std::env::var_os("PLUR1BUS_UPDATE_TARGET_BIN") {
            return Ok(PathBuf::from(p));
        }
    }
    std::env::current_exe().map_err(|e| format!("cannot locate the plur1bus binary: {e}"))
}

#[cfg(test)]
mod tests;
