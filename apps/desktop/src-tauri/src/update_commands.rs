//! Shell-only update ownership: no publisher-controlled URLs or keys enter from JavaScript.
use crate::{commands, updates::*};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};
/// One owner serializes checks, decisions, and installs.
#[derive(Default)]
pub struct UpdateState(pub tokio::sync::Mutex<Owner>);
/// Verified metadata is held in Rust only; installs cannot substitute UI metadata.
#[derive(Default)]
pub struct Owner {
    release: Option<Release>,
    started: bool,
}
/// Public editable preferences exclude rate-limit and suppression bookkeeping.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub channel: Channel,
    pub held: bool,
    pub auto_patch: bool,
    pub quiet_hours: (u8, u8),
    pub check_on_start: bool,
}
impl From<&UpdateSettings> for Preferences {
    fn from(s: &UpdateSettings) -> Self {
        Self {
            channel: s.channel,
            held: s.held,
            auto_patch: s.auto_patch,
            quiet_hours: s.quiet_hours,
            check_on_start: s.check_on_start,
        }
    }
}
/// The same snapshot powers the settings page and update offer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: Preferences,
    pub release: Option<Release>,
    pub offer: Offer,
    pub store_build: bool,
    pub install_available: bool,
}
fn now() -> u64 {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("PLUR1BUS_DESKTOP_CLOCK") {
        if let Ok(seconds) = value.parse() {
            return seconds;
        }
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn dir(window: &WebviewWindow) -> Result<std::path::PathBuf, String> {
    commands::app_config_dir(window.app_handle())
}
fn snapshot(s: &UpdateSettings, o: &Owner, root: &Path) -> Snapshot {
    use chrono::Timelike;
    let hour = chrono::Local::now().hour() as u8;
    // Until WP11 has a proven no-active-run source and the shared upgrade path,
    // automatic execution is held back; the policy itself remains fully testable.
    let offer = o
        .release
        .as_ref()
        .map(|r| {
            decide(
                r,
                &Version::parse(env!("CARGO_PKG_VERSION")).unwrap(),
                s,
                now(),
                hour,
                true,
            )
        })
        .unwrap_or(Offer::None);
    Snapshot {
        settings: s.into(),
        release: o.release.clone(),
        offer,
        store_build: cfg!(feature = "store"),
        install_available: cfg!(all(feature = "direct-updater", not(feature = "store")))
            && !bundled_install_present(root),
    }
}
fn error(e: UpdateError) -> String {
    e.code().into()
}
fn endpoint(channel: Channel, updater: bool) -> Result<url::Url, UpdateError> {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var(if updater {
        "PLUR1BUS_DESKTOP_UPDATER_ENDPOINT"
    } else {
        "PLUR1BUS_DESKTOP_FEED_URL"
    }) {
        let url = url::Url::parse(&value).map_err(|_| UpdateError::Network)?;
        if valid_url(&url, true) {
            return Ok(url);
        }
        return Err(UpdateError::Network);
    }
    url::Url::parse(&if updater {
        format!(
            "https://updates.plur1bus.app/{}/latest.json",
            channel.name()
        )
    } else {
        format!("https://updates.plur1bus.app/{}.json", channel.name())
    })
    .map_err(|_| UpdateError::Network)
}
/// Only HTTPS, with loopback HTTP available in debug fixtures.
pub fn valid_url(url: &url::Url, debug: bool) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https"
            || (debug
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))))
}
fn key(channel: Channel, updater: bool) -> String {
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var(if updater {
        "PLUR1BUS_DESKTOP_UPDATER_PUBKEY"
    } else {
        "PLUR1BUS_DESKTOP_FEED_PUBKEY"
    }) {
        return key;
    }
    channel.key(updater).trim().into()
}
async fn get(url: url::Url, limit: usize) -> Result<Vec<u8>, UpdateError> {
    use futures_util::StreamExt;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| UpdateError::Network)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| UpdateError::Network)?;
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > limit as u64)
    {
        return Err(UpdateError::Network);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| UpdateError::Network)?;
        if bytes.len() + chunk.len() > limit {
            return Err(UpdateError::Network);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
/// Get or replace preferences, preserving skipped versions and opted-out patches.
#[tauri::command]
pub async fn update_settings(
    window: WebviewWindow,
    request: Option<Preferences>,
) -> Result<Snapshot, String> {
    commands::check(&window, "update_settings")?;
    let root = dir(&window)?;
    let state = window.state::<UpdateState>();
    let mut o = state.0.lock().await;
    let mut s = load_settings(&root).map_err(error)?;
    if let Some(p) = request {
        if s.channel != p.channel {
            o.release = None;
        }
        s.channel = p.channel;
        s.held = p.held;
        s.auto_patch = p.auto_patch;
        s.quiet_hours = p.quiet_hours;
        s.check_on_start = p.check_on_start;
        save_settings(&root, &s).map_err(error)?;
    }
    let result = snapshot(&s, &o, &root);
    publish(window.app_handle(), &result);
    Ok(result)
}
/// Reserve a six-hour check before any request; failed requests stay rate-limited.
#[tauri::command]
pub async fn update_check(
    window: WebviewWindow,
    startup: Option<bool>,
) -> Result<Snapshot, String> {
    commands::check(&window, "update_check")?;
    let root = dir(&window)?;
    let state = window.state::<UpdateState>();
    let mut o = state.0.lock().await;
    let mut s = load_settings(&root).map_err(error)?;
    if startup == Some(true) {
        if o.started {
            return Ok(snapshot(&s, &o, &root));
        }
        o.started = true;
        s.next_start(now());
        save_settings(&root, &s).map_err(error)?;
        if !s.check_on_start {
            return Ok(snapshot(&s, &o, &root));
        }
    }
    let clock = now();
    if s.last_check
        .is_some_and(|last| clock.saturating_sub(last) < 21600)
    {
        return Ok(snapshot(&s, &o, &root));
    }
    let feed_key = key(s.channel, false);
    if feed_key.contains("PLACEHOLDER") {
        return Err(error(UpdateError::Placeholder));
    }
    s.last_check = Some(clock);
    save_settings(&root, &s).map_err(error)?;
    let url = endpoint(s.channel, false).map_err(error)?;
    let sig_url = url::Url::parse(&format!("{}.minisig", url.as_str()))
        .map_err(|_| error(UpdateError::Network))?;
    let bytes = get(url, 131072).await.map_err(error)?;
    let sig = get(sig_url, 8192).await.map_err(error)?;
    let sig = std::str::from_utf8(&sig).map_err(|_| error(UpdateError::Signature))?;
    o.release = Some(verify_feed(&bytes, sig, &feed_key, s.channel).map_err(error)?);
    let result = snapshot(&s, &o, &root);
    publish(window.app_handle(), &result);
    Ok(result)
}
fn publish(app: &tauri::AppHandle, s: &Snapshot) {
    let state = app.state::<crate::native::NativeState>();
    let mut view = state.view.lock().unwrap();
    view.held = s.settings.held;
    view.update_available = !matches!(s.offer, Offer::None);
    drop(view);
    crate::native::refresh_updates(app);
}
/// Suppress the verified offer using the native clock.
#[tauri::command]
pub async fn update_later(window: WebviewWindow) -> Result<Snapshot, String> {
    mutate(window, false).await
}
/// Skip the exact verified version, with a seven-day security reminder.
#[tauri::command]
pub async fn update_skip(window: WebviewWindow) -> Result<Snapshot, String> {
    mutate(window, true).await
}
async fn mutate(window: WebviewWindow, skip: bool) -> Result<Snapshot, String> {
    commands::check(&window, if skip { "update_skip" } else { "update_later" })?;
    let root = dir(&window)?;
    let state = window.state::<UpdateState>();
    let o = state.0.lock().await;
    let mut s = load_settings(&root).map_err(error)?;
    let release = o.release.as_ref().ok_or("update-not-checked")?;
    if skip {
        s.skip(release, now());
    } else {
        s.later(now());
    }
    save_settings(&root, &s).map_err(error)?;
    let result = snapshot(&s, &o, &root);
    publish(window.app_handle(), &result);
    Ok(result)
}
/// Persist the pending product version before the installer can exit or restart.
pub fn pending_before_install<T>(
    root: &Path,
    version: &Version,
    install: impl FnOnce() -> Result<T, UpdateError>,
) -> Result<T, UpdateError> {
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Pending {
        pending: Version,
    }
    match std::fs::read(root.join("upgrades.json")) {
        Ok(bytes) => {
            if bytes.len() > 32768 {
                return Err(UpdateError::Storage);
            }
            let _: Pending = serde_json::from_slice(&bytes).map_err(|_| UpdateError::Storage)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(UpdateError::Storage),
    }
    write_private(
        root,
        "upgrades.json",
        &Pending {
            pending: version.clone(),
        },
    )?;
    install()
}
/// App-only updates are available for attached installs. Bundled upgrades require WP11.
#[tauri::command]
pub async fn update_install(window: WebviewWindow) -> Result<(), String> {
    commands::check(&window, "update_install")?;
    #[cfg(any(feature = "store", not(feature = "direct-updater")))]
    {
        let _ = window;
        Err("update-store-managed".into())
    }
    #[cfg(all(feature = "direct-updater", not(feature = "store")))]
    {
        use tauri_plugin_updater::UpdaterExt;
        let root = dir(&window)?;
        if bundled_install_present(&root) {
            return Err("update-harness-upgrade-unavailable".into());
        }
        let state = window.state::<UpdateState>();
        let o = state.0.lock().await;
        let s = load_settings(&root).map_err(error)?;
        let release = o.release.as_ref().ok_or("update-not-checked")?;
        if !matches!(
            snapshot(&s, &o, &root).offer,
            Offer::Show | Offer::AutoInstall
        ) {
            return Err("update-not-offered".into());
        }
        let endpoint = endpoint(release.channel, true).map_err(error)?;
        let manifest = verify_manifest(
            &get(endpoint.clone(), 131072).await.map_err(error)?,
            release,
        )
        .map_err(error)?;
        let public = key(release.channel, true);
        if public.contains("PLACEHOLDER") {
            return Err(error(UpdateError::Placeholder));
        }
        let updater = window
            .app_handle()
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|_| error(UpdateError::Manifest))?
            .pubkey(tauri_public_key(&public).map_err(error)?)
            .timeout(Duration::from_secs(300))
            .configure_client(|client| client.redirect(reqwest_updater_redirect()))
            .build()
            .map_err(|_| error(UpdateError::Manifest))?;
        let update = updater
            .check()
            .await
            .map_err(|_| error(UpdateError::Manifest))?
            .ok_or("update-not-offered")?;
        // Plugin fetches again: bind that second response to the already hash-pinned value.
        if update.raw_json != manifest
            || update.version != release.version.to_string()
            || !valid_url(&update.download_url, cfg!(debug_assertions))
        {
            return Err(error(UpdateError::Manifest));
        }
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|_| error(UpdateError::Signature))?;
        pending_before_install(&root, &release.version, || {
            update.install(bytes).map_err(|_| UpdateError::Storage)
        })
        .map_err(error)?;
        window.app_handle().restart();
    }
}

#[cfg(all(feature = "direct-updater", not(feature = "store")))]
fn reqwest_updater_redirect() -> reqwest_updater::redirect::Policy {
    reqwest_updater::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 10 || !valid_url(attempt.url(), cfg!(debug_assertions)) {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}

/// Fixed Store URI: the shell never receives an arbitrary external-open URL.
#[tauri::command]
pub fn update_store_open(window: WebviewWindow) -> Result<(), String> {
    commands::check(&window, "update_store_open")?;
    #[cfg(all(windows, feature = "store"))]
    {
        std::process::Command::new("rundll32.exe")
            .args([
                "url.dll,FileProtocolHandler",
                "ms-windows-store://search/?query=PLUR1BUS",
            ])
            .spawn()
            .map(|_| ())
            .map_err(|_| "update-store-unavailable".into())
    }
    #[cfg(not(all(windows, feature = "store")))]
    {
        Err("update-store-unavailable".into())
    }
}

/// A bundled install lives below the controller directory, never at the config root.
pub fn bundled_install_present(root: &Path) -> bool {
    !matches!(std::fs::symlink_metadata(root.join("bundled/installed.json")),Err(e) if e.kind()==std::io::ErrorKind::NotFound)
}
