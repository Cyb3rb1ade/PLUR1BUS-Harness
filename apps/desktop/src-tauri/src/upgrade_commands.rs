//! Shell-only progress and recovery. Approved metadata remains in Rust across app replacement.
use crate::{
    commands,
    controller::{
        journal::{Journal, Step},
        upgrade::Outcome,
        Controller,
    },
    runtime_commands::{resolve, RuntimeState},
    updates::{Kind, Release},
};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};
use tauri::{Emitter, Manager, WebviewWindow};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub pending: Version,
    #[serde(default)]
    pub automatic: bool,
    #[serde(default)]
    pub kind: Option<Kind>,
    #[serde(default)]
    pub bundle_digest: Option<String>,
}
pub fn load_pending(root: &Path) -> Result<Option<Pending>, String> {
    match std::fs::symlink_metadata(root.join("upgrades.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("storage".into()),
        Ok(_) => {}
    }
    let text = crate::controller::read_private_json(root, "upgrades.json", 32768)
        .map_err(|_| "storage")?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|_| "storage".into())
}
pub fn approve(
    root: &Path,
    r: &Release,
    automatic: bool,
) -> Result<(), crate::updates::UpdateError> {
    let pending = Pending {
        pending: r.version.clone(),
        automatic,
        kind: Some(r.kind),
        bundle_digest: Some(r.bundle_digest.clone()),
    };
    crate::controller::atomic_json(root, "upgrades.json", &pending)
        .map_err(|_| crate::updates::UpdateError::Storage)
}
/// Unattended approval is rechecked after app replacement; missing activity is busy.
pub fn automatic_resume_allowed(
    p: &Pending,
    s: &crate::updates::UpdateSettings,
    hour: u8,
    idle: bool,
) -> bool {
    if !p.automatic {
        return true;
    }
    let (start, end) = s.quiet_hours;
    let quiet = if start < end {
        hour >= start && hour < end
    } else if start > end {
        hour >= start || hour < end
    } else {
        false
    };
    p.kind == Some(Kind::Patch) && s.auto_patch && !s.held && quiet && idle
}
pub fn validate_pending(
    p: &Pending,
    bundle: &crate::controller::bundle::Bundle,
    bytes: &[u8],
) -> Result<Kind, String> {
    use sha2::{Digest, Sha256};
    if p.pending.to_string() != bundle.version
        || p.bundle_digest.as_deref() != Some(format!("{:x}", Sha256::digest(bytes)).as_str())
    {
        return Err("update-bundle-mismatch".into());
    }
    p.kind.ok_or_else(|| "update-approval-missing".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub app_version: &'static str,
    pub installed_version: Option<String>,
    pub image_digest: Option<String>,
    pub journal: Option<Journal>,
    pub rollback_available: bool,
}
#[tauri::command]
pub async fn harness_upgrade_status(window: WebviewWindow) -> Result<Status, String> {
    commands::check(&window, "harness_upgrade_status")?;
    let state = window
        .try_state::<RuntimeState>()
        .ok_or("runtime-unavailable")?;
    let root = commands::app_config_dir(window.app_handle())?;
    if !crate::update_commands::bundled_install_present(&root) {
        return Ok(Status {
            app_version: env!("CARGO_PKG_VERSION"),
            installed_version: None,
            image_digest: None,
            journal: None,
            rollback_available: false,
        });
    }
    let c = resolve(&window, &mut *state.0.lock().await, None).await?;
    let i = c.installed().map_err(|e| e.code())?;
    let journal = c.upgrade_journal().map_err(|e| e.code())?;
    let rollback_available = if let Some(j) = &journal {
        j.step == Step::Done
            && j.snapshot.is_some()
            && c.runtime
                .volume_present(
                    &j.snapshot.as_ref().ok_or("storage")?.volume,
                    &c.resource_labels("snapshot"),
                )
                .await
                .map_err(|e| e.message_key())?
            && c.runtime
                .state(&format!("{}-previous", c.names.container))
                .await
                .is_ok_and(|s| {
                    s.exists && s.labels.get("app.plur1bus.image.digest") == Some(&j.from_digest)
                })
    } else {
        false
    };
    Ok(Status {
        app_version: env!("CARGO_PKG_VERSION"),
        installed_version: i.as_ref().map(|i| i.installed_version.clone()),
        image_digest: i.map(|i| i.image_digest),
        journal,
        rollback_available,
    })
}
fn progress(app: &tauri::AppHandle, step: Step) {
    if matches!(
        step,
        Step::Preflight | Step::RollingBack | Step::RecoveryFailed
    ) {
        crate::native::navigate_shell(app, "#/settings/version");
    }
    let _ = app.emit_to("shell", "desktop-upgrade-progress", step);
    if let Some(state) = app.try_state::<crate::native::NativeState>() {
        let mut v = state.view.lock().unwrap();
        v.harness = if step == Step::Done || step == Step::RolledBack {
            crate::tray::HarnessState::Ready
        } else if step == Step::RecoveryFailed {
            crate::tray::HarnessState::Degraded
        } else if matches!(
            step,
            Step::RollingBack
                | Step::RestoringSnapshot
                | Step::StartingPrevious
                | Step::GatingPrevious
        ) {
            crate::tray::HarnessState::Rollback
        } else {
            crate::tray::HarnessState::Updating
        };
        *state.upgrade_overlay.lock().unwrap() = if matches!(step, Step::Done | Step::RolledBack) {
            None
        } else {
            Some(v.harness)
        };
        drop(v);
        crate::native::refresh_updates(app);
    }
}
async fn operate(
    window: &WebviewWindow,
    c: Arc<Controller>,
    manual: bool,
    pending: Option<Pending>,
) -> Result<Option<Outcome>, String> {
    let app = window.app_handle().clone();
    let root = commands::app_config_dir(&app)?;
    let store = commands::app_connection_store(&app)?;
    let credentials = app
        .try_state::<commands::ConnectionState>()
        .ok_or("credentials-unavailable")?;
    let action_app = app.clone();
    let outcome = commands::credential_action(&credentials, move |tokens, runtime| {
        let app = action_app;
        let installed = c
            .installed()
            .map_err(|e| e.code())?
            .ok_or("not-installed")?;
        let mut conn = store
            .load()
            .map_err(|_| "storage")?
            .into_iter()
            .find(|r| {
                r.kind == crate::connections::Kind::Bundled
                    && r.bundled.as_ref().is_some_and(|b| {
                        b.container == installed.container && b.endpoint == installed.endpoint
                    })
            })
            .ok_or("pairing-required")?;
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let journal = c.upgrade_journal().map_err(|e| e.code())?;
        let should_mutate = manual
            || journal.as_ref().is_some_and(|j| !j.step.terminal())
            || pending.as_ref().is_some_and(|p| {
                installed.installed_version != p.pending.to_string()
                    && journal
                        .as_ref()
                        .is_none_or(|j| j.to != p.pending || !j.step.terminal())
            });
        let was_active = if should_mutate {
            crate::native::suspend_for_upgrade(&app, conn.id)
        } else {
            false
        };
        let callback = |s| progress(&app, s);
        let operation = (|| -> Result<Option<Outcome>, String> {
            Ok(if manual {
                Some(
                    runtime
                        .block_on(c.rollback_manual(true, tokens.as_ref(), &conn, callback))
                        .map_err(|e| e.code())?,
                )
            } else if c
                .upgrade_journal()
                .map_err(|e| e.code())?
                .is_some_and(|j| !j.step.terminal())
            {
                runtime
                    .block_on(c.resume(tokens.as_ref(), &conn, callback))
                    .map_err(|e| e.code())?
            } else if let Some(p) = pending {
                let bundle = crate::controller::bundle::embedded();
                // A terminal record for this approval is never automatically retried.
                if c.upgrade_journal()
                    .map_err(|e| e.code())?
                    .is_some_and(|j| j.to == p.pending && j.step.terminal())
                    || installed.installed_version == p.pending.to_string()
                {
                    None
                } else {
                    let kind = validate_pending(
                        &p,
                        bundle,
                        include_bytes!("../../bundle/bundle.json.tmpl"),
                    )?;
                    Some(
                        runtime
                            .block_on(c.upgrade(
                                bundle,
                                p.pending,
                                kind,
                                tokens.as_ref(),
                                &conn,
                                callback,
                            ))
                            .map_err(|e| e.code())?,
                    )
                }
            } else {
                None
            })
        })();

        let outcome = match operation {
            Ok(outcome) => outcome,
            Err(error) => {
                // A rejected preflight leaves the old runtime intact. Only a settled
                // transaction may release the native generation fence again.
                if c.require_settled_upgrade().is_ok() {
                    if let Some(state) = app.try_state::<crate::native::NativeState>() {
                        *state.upgrade_overlay.lock().unwrap() = None;
                        state.view.lock().unwrap().harness = crate::tray::HarnessState::Degraded;
                        crate::native::refresh_updates(&app);
                    }
                    if let Ok(Some(token)) = tokens.get(&crate::secrets::token_account(conn.id)) {
                        if was_active {
                            if let Ok(client) = runtime
                                .block_on(crate::client::HarnessClient::from_connection(&conn))
                            {
                                runtime.block_on(async {
                                    crate::native::start_events(&app, conn.clone(), client, token);
                                });
                            }
                        } else if should_mutate {
                            runtime.block_on(async {
                                crate::host_commands::start_bridge(&app, conn.clone(), token);
                            });
                        }
                    }
                }
                return Err(error);
            }
        };
        if matches!(
            outcome,
            Some(Outcome::Upgraded { .. } | Outcome::RolledBack { .. })
        ) {
            let current = c
                .installed()
                .map_err(|e| e.code())?
                .ok_or("not-installed")?;
            if let Some(binding) = &mut conn.bundled {
                binding.image_digest = current.image_digest;
            }
            store.upsert(conn.clone()).map_err(|_| "storage")?;
            if let Some(token) = tokens
                .get(&crate::secrets::token_account(conn.id))
                .map_err(|_| "credentials-unavailable")?
            {
                if was_active {
                    let client = runtime
                        .block_on(crate::client::HarnessClient::from_connection(&conn))
                        .map_err(|_| "meta")?;
                    runtime.block_on(async {
                        crate::native::start_events(&app, conn.clone(), client, token);
                    });
                } else {
                    runtime.block_on(async {
                        crate::host_commands::start_bridge(&app, conn.clone(), token);
                    });
                }
            }
        }
        if let Some(Outcome::RolledBack { to, .. }) = &outcome {
            let mut settings = crate::updates::load_settings(&root).map_err(|_| "storage")?;
            settings
                .skipped
                .insert(to.clone(), chrono::Utc::now().timestamp().max(0) as u64);
            crate::updates::save_settings(&root, &settings).map_err(|_| "storage")?;
        }
        if let Some(value) = &outcome {
            let _ = app.emit_to("shell", "desktop-upgrade-outcome", value);
        }
        Ok(outcome)
    })
    .await?;
    if pending_exists(window)? && !matches!(outcome, Some(Outcome::RecoveryFailed { .. })) {
        std::fs::remove_file(commands::app_config_dir(window.app_handle())?.join("upgrades.json"))
            .map_err(|_| "storage")?;
    }
    Ok(outcome)
}
fn pending_exists(window: &WebviewWindow) -> Result<bool, String> {
    Ok(load_pending(&commands::app_config_dir(window.app_handle())?)?.is_some())
}
#[tauri::command]
pub async fn harness_rollback(
    window: WebviewWindow,
    confirmed: bool,
) -> Result<Option<Outcome>, String> {
    commands::check(&window, "harness_rollback")?;
    if !confirmed {
        return Err("rollback-confirmation-required".into());
    }
    let state = window
        .try_state::<RuntimeState>()
        .ok_or("runtime-unavailable")?;
    let c = resolve(&window, &mut *state.0.lock().await, None).await?;
    operate(&window, c, true, None).await
}
/// Recovery precedes autostart and watcher creation on every launch.
pub(crate) async fn on_start(window: &WebviewWindow) -> Result<(), String> {
    let root = commands::app_config_dir(window.app_handle())?;
    if !crate::update_commands::bundled_install_present(&root) {
        return Ok(());
    }
    let state = window
        .try_state::<RuntimeState>()
        .ok_or("runtime-unavailable")?;
    let c = resolve(window, &mut *state.0.lock().await, None).await?;
    if c.upgrade_journal()
        .map_err(|e| e.code())?
        .is_some_and(|j| j.step == Step::RecoveryFailed)
    {
        progress(window.app_handle(), Step::RecoveryFailed);
        return Err("upgrade-recovery-failed".into());
    }
    let pending = load_pending(&root)?;
    let journal = c.upgrade_journal().map_err(|e| e.code())?;
    if let Some(p) = &pending {
        if p.automatic && journal.as_ref().is_none_or(|j| j.step.terminal()) {
            use chrono::Timelike;
            let settings = crate::updates::load_settings(&root).map_err(|_| "storage")?;
            if !automatic_resume_allowed(
                p,
                &settings,
                chrono::Local::now().hour() as u8,
                !has_active_runs(window).await,
            ) {
                return Ok(());
            }
        }
    }
    let needs_resume = pending.is_some()
        || c.upgrade_journal()
            .map_err(|e| e.code())?
            .is_some_and(|j| !j.step.terminal());
    if needs_resume
        && matches!(
            operate(window, c, false, pending).await?,
            Some(Outcome::RecoveryFailed { .. })
        )
    {
        return Err("upgrade-recovery-failed".into());
    }
    Ok(())
}
/// Absence of a bounded native active-run count means busy, never unattended consent.
pub(crate) async fn has_active_runs(window: &WebviewWindow) -> bool {
    let Some(state) = window.try_state::<RuntimeState>() else {
        return true;
    };
    let Ok(c) = resolve(window, &mut *state.0.lock().await, None).await else {
        return true;
    };
    if c.upgrade_journal().map_or(true, |j| {
        j.is_some_and(|j| !j.step.terminal() || j.step == Step::RecoveryFailed)
    }) {
        return true;
    }
    c.exec_json(
        &["plur1bus", "daemon", "status", "--json"],
        std::time::Duration::from_secs(10),
    )
    .await
    .ok()
    .and_then(|v| {
        v.pointer("/activity/activeRuns")
            .and_then(serde_json::Value::as_u64)
    })
    .is_none_or(|n| n != 0)
}
