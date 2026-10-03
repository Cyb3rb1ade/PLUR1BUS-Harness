//! Rust-only pairing and native process restart driver. JavaScript never sees credentials.
use plur1bus_desktop::{client::HarnessClient, connections::Origin};
use plur1bus_mock_harness::{MockHarness, MockOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

#[derive(Debug, PartialEq)]
struct ProgressObservation {
    last: String,
    stages: Vec<String>,
    counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuditFailureCategory {
    None,
    ReadDir,
    ReadDirSharing,
    ReadDirAccessDenied,
    ReadDirMissing,
    ReadDirOther,
    EntryDisappeared,
    Metadata,
    FileRead,
    Symlink,
    CounterLimit,
    SecretDetected,
    CookieDatabase,
    CookieQuery,
    FileReadSharing,
    FileReadAccessDenied,
    FileReadMissing,
    FileReadOther,
    Deadline,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuditFailureTarget {
    None,
    RootDirectory,
    NestedDirectory,
    Lease,
    CookieDatabase,
    BrowserLock,
    StorageFile,
    CacheFile,
    OtherFile,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditObservation {
    audit_complete: bool,
    secret_detected: bool,
    cookie_database_files: u32,
    cookie_rows: u64,
    cookie_read_only_complete: bool,
    cookie_database_native_profile_files: u32,
    cookie_database_other_root_files: u32,
    cookie_database_primary_files: u32,
    cookie_database_sidecar_files: u32,
    read_failures: u32,
    entries_disappeared: u32,
    metadata_failures: u32,
    read_dir_failures: u32,
    symlink_entries: u32,
    failure_category: AuditFailureCategory,
    failure_target: AuditFailureTarget,
}

impl AuditObservation {
    fn unavailable() -> Self {
        Self {
            audit_complete: false,
            secret_detected: false,
            cookie_database_files: 0,
            cookie_rows: 0,
            cookie_read_only_complete: false,
            cookie_database_native_profile_files: 0,
            cookie_database_other_root_files: 0,
            cookie_database_primary_files: 0,
            cookie_database_sidecar_files: 0,
            read_failures: 0,
            entries_disappeared: 0,
            metadata_failures: 0,
            read_dir_failures: 0,
            symlink_entries: 0,
            failure_category: AuditFailureCategory::ReadDir,
            failure_target: AuditFailureTarget::None,
        }
    }

    fn bounded(&self) -> bool {
        const MAX_AUDIT_ITEMS: u32 = 4096;
        self.cookie_database_files <= MAX_AUDIT_ITEMS
            && self.cookie_database_native_profile_files <= MAX_AUDIT_ITEMS
            && self.cookie_database_other_root_files <= MAX_AUDIT_ITEMS
            && self.cookie_database_primary_files <= MAX_AUDIT_ITEMS
            && self.cookie_database_sidecar_files <= MAX_AUDIT_ITEMS
            && self
                .cookie_database_native_profile_files
                .saturating_add(self.cookie_database_other_root_files)
                == self.cookie_database_files
            && self
                .cookie_database_primary_files
                .saturating_add(self.cookie_database_sidecar_files)
                == self.cookie_database_files
            && self.read_failures <= MAX_AUDIT_ITEMS
            && self.entries_disappeared <= MAX_AUDIT_ITEMS
            && self.metadata_failures <= MAX_AUDIT_ITEMS
            && self.read_dir_failures <= MAX_AUDIT_ITEMS
            && self.symlink_entries <= MAX_AUDIT_ITEMS
            && self
                .cookie_database_files
                .saturating_add(self.read_failures)
                .saturating_add(self.entries_disappeared)
                .saturating_add(self.metadata_failures)
                .saturating_add(self.read_dir_failures)
                .saturating_add(self.symlink_entries)
                <= MAX_AUDIT_ITEMS
    }

    fn clean(&self) -> bool {
        self.audit_complete
            && !self.secret_detected
            && self.cookie_database_files == 0
            && self.cookie_rows == 0
            && self.cookie_read_only_complete
            && self.read_failures == 0
            && self.entries_disappeared == 0
            && self.metadata_failures == 0
            && self.read_dir_failures == 0
            && self.symlink_entries == 0
            && self.failure_category == AuditFailureCategory::None
            && self.failure_target == AuditFailureTarget::None
    }

    fn live_clean(&self) -> bool {
        self.audit_complete
            && !self.secret_detected
            && self.cookie_rows == 0
            && self.cookie_read_only_complete
            && self.cookie_database_other_root_files == 0
            && (cfg!(windows) || self.cookie_database_files == 0)
            && self.read_failures == 0
            && self.entries_disappeared == 0
            && self.metadata_failures == 0
            && self.read_dir_failures == 0
            && self.symlink_entries == 0
            && self.failure_category == AuditFailureCategory::None
            && self.failure_target == AuditFailureTarget::None
    }
}

fn session_live_clean(session: &Value) -> bool {
    serde_json::from_value::<AuditObservation>(session["profileLiveAudit"].clone())
        .is_ok_and(|audit| audit.live_clean())
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SecondaryProbeObservation {
    available: bool,
    proxy_generated_403: bool,
    other_window_acl_denied: bool,
    document_opaque_origin: bool,
    document_content_type_text_plain: bool,
    fetch_rejected_type_error: bool,
    native_cookie_store_empty: bool,
    profile_path_verified: bool,
    profile_acl_private: bool,
    profile_isolated: bool,
    profile_cleanup_complete: bool,
    cleanup_cookie_rows: u64,
    cleanup_read_only_complete: bool,
    cleanup_secret_detected: bool,
    profile_live_audit: AuditObservation,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PrivateProfileObservation {
    applicable: bool,
    callback_available: bool,
    environment_options_available: bool,
    profile_state_available: bool,
    private_enabled: bool,
    native_cookie_store_empty: bool,
    profile_path_verified: bool,
    profile_acl_private: bool,
    profile_live_audit: AuditObservation,
}

impl Default for PrivateProfileObservation {
    fn default() -> Self {
        Self {
            applicable: false,
            callback_available: false,
            environment_options_available: false,
            profile_state_available: false,
            private_enabled: false,
            native_cookie_store_empty: false,
            profile_path_verified: false,
            profile_acl_private: false,
            profile_live_audit: AuditObservation::unavailable(),
        }
    }
}

impl PrivateProfileObservation {
    fn unavailable() -> Self {
        Self::default()
    }
}

impl SecondaryProbeObservation {
    fn unavailable() -> Self {
        Self {
            available: false,
            proxy_generated_403: false,
            other_window_acl_denied: false,
            document_opaque_origin: false,
            document_content_type_text_plain: false,
            fetch_rejected_type_error: false,
            native_cookie_store_empty: false,
            profile_path_verified: false,
            profile_acl_private: false,
            profile_isolated: false,
            profile_cleanup_complete: false,
            cleanup_cookie_rows: 0,
            cleanup_read_only_complete: false,
            cleanup_secret_detected: false,
            profile_live_audit: AuditObservation::unavailable(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeDiagnostic {
    secondary_probe: SecondaryProbeObservation,
    pre_close_audit: AuditObservation,
    audit: AuditObservation,
    teardown: TeardownObservation,
    profile: PrivateProfileObservation,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TeardownObservation {
    process_exit_applicable: bool,
    capture_complete: bool,
    close_complete: bool,
    process_exit_complete: bool,
    audit_complete: bool,
    profile_cleanup_complete: bool,
    cleanup_cookie_rows: u64,
    cleanup_read_only_complete: bool,
    cleanup_secret_detected: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SweepObservation {
    removed: u32,
    skipped_active: u32,
    skipped_unknown: u32,
    positive_profiles: u32,
    positive_rows: u64,
}

impl TeardownObservation {
    fn clean(&self) -> bool {
        self.capture_complete
            && self.close_complete
            && (!self.process_exit_applicable || self.process_exit_complete)
            && self.audit_complete
            && self.profile_cleanup_complete
            && self.cleanup_cookie_rows == 0
            && self.cleanup_read_only_complete
            && !self.cleanup_secret_detected
    }
}

impl NativeDiagnostic {
    fn unavailable() -> Self {
        Self {
            secondary_probe: SecondaryProbeObservation::unavailable(),
            pre_close_audit: AuditObservation::unavailable(),
            audit: AuditObservation::unavailable(),
            teardown: TeardownObservation::default(),
            profile: PrivateProfileObservation::unavailable(),
        }
    }
}

fn parse_diagnostic(root: &Value) -> NativeDiagnostic {
    let diagnostic = root
        .get("diagnostic")
        .cloned()
        .and_then(|value| serde_json::from_value::<NativeDiagnostic>(value).ok());
    match diagnostic {
        Some(value) if value.audit.bounded() && value.pre_close_audit.bounded() => value,
        _ => NativeDiagnostic::unavailable(),
    }
}

fn read_bounded(path: &std::path::Path, limit: u64) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    ((bytes.len() as u64) <= limit).then_some(bytes)
}

fn progress_labels() -> &'static [&'static str] {
    &[
        "starting",
        "fixture-setup",
        "fixture-input-parsed",
        "fixture-builder-start",
        "fixture-open-spa-start",
        "fixture-open-spa-complete",
        "fixture-open-spa-failed",
        "fixture-open-spa-timeout",
        "session-ready",
        "proxy-obtained",
        "secrets-registering",
        "secrets-registered",
        "cookies-checked",
        "benchmark-start",
        "benchmark-done",
        "second-window-opened",
        "second-page-started-ticket",
        "second-page-started-other-path",
        "second-page-finished-ticket",
        "second-page-finished-other-path",
        "second-page-finished-first-origin",
        "second-page-finished-other-origin",
        "second-eval-accepted",
        "second-eval-rejected",
        "second-eval-source-mismatch",
        "second-probe-entry",
        "second-probe-ready-wait",
        "second-probe-ready",
        "second-probe-ipc",
        "second-probe-fetch",
        "second-probe-sse-first",
        "second-probe-sse-second",
        "second-probe-websocket",
        "second-probe-download",
        "second-probe-foreign",
        "second-probe-terminal",
        "second-probe-failed",
        "second-probe-source-mismatch",
        "session-title-rejected-origin",
        "session-title-rejected-duplicate",
        "session-title-rejected-exhausted",
        "session-title-claimed-first",
        "session-title-claimed-second",
        "error-title-rejected-origin",
        "negative-checks",
        "other-window-construction-start",
        "other-window-construction-complete",
        "other-window-construction-failed",
        "other-window-wait-start",
        "other-window-wait-channel-closed",
        "other-window-wait-timeout",
        "other-window-page-finished",
        "other-window-eval-submitted",
        "other-window-eval-failed",
        "other-window-script-entry",
        "other-window-fetch-start",
        "other-window-fetch-complete",
        "other-window-fetch-error",
        "other-window-ipc-start",
        "other-window-ipc-complete",
        "other-window-probe-complete",
        "other-window-local-page-finished",
        "other-window-local-eval-submitted",
        "other-window-local-eval-failed",
        "other-window-local-script-entry",
        "other-window-local-probe-complete",
        "negative-done",
        "replay",
        "error-page",
        "retire",
        "retirement-window-close-start",
        "retirement-window-close-requested",
        "retirement-window-close-failed",
        "retirement-window-close-complete",
        "retirement-observer-build-start",
        "retirement-observer-build-complete",
        "retirement-observer-build-deadline-exhausted",
        "retirement-observer-create-failed",
        "retirement-observer-main-thread-dispatch-requested",
        "retirement-observer-main-thread-callback-before-deadline",
        "retirement-observer-main-thread-callback-after-deadline",
        "retirement-observer-main-thread-dispatch-request-failed",
        "retirement-observer-unexpected-url",
        "retirement-observer-page-started",
        "retirement-observer-page-finished",
        "retirement-observer-eval-submitted",
        "retirement-observer-eval-rejected",
        "retirement-observer-script-entry",
        "retirement-observer-ipc-available",
        "retirement-observer-ipc-missing",
        "retirement-observer-ipc-start",
        "retirement-observer-ipc-complete",
        "retirement-observer-title-complete",
        "retirement-observer-retire-failed",
        "retirement-observer-proxy-check-failed",
        "retirement-observer-proxy-403-confirmed",
        "retirement-observer-navigation-failed",
        "retirement-observer-navigation-requested",
        "retirement-observer-ipc-invalid",
        "audit",
        "audit-live-scan-complete",
        "audit-live-scan-incomplete",
        "retirement-observer-close-start",
        "retirement-observer-close-requested",
        "retirement-observer-close-failed",
        "retirement-observer-timeout",
        "teardown-wait-start",
        "teardown-wait-complete",
        "teardown-wait-failed",
        "audit-closed-scan-complete",
        "audit-closed-scan-incomplete",
        "audit-scan-complete",
        "audit-scan-incomplete",
        "audit-report-serialized",
        "audit-report-serialization-failed",
        "audit-report-secret-detected",
        "audit-report-written",
        "audit-report-write-failed",
        "audit-failed",
        "audit-passed",
    ]
}

fn parse_progress_history(last: &str, history: &str) -> Result<ProgressObservation, &'static str> {
    let labels = progress_labels();
    let last = last.trim();
    if !labels.contains(&last) {
        return Err("unknown progress stage");
    }
    let mut stages = Vec::new();
    if history.trim().is_empty() {
        stages.push(last.to_owned());
    } else {
        for stage in history.lines().map(str::trim).filter(|s| !s.is_empty()) {
            if !labels.contains(&stage) {
                return Err("unknown progress stage");
            }
            stages.push(stage.to_owned());
        }
    }
    let mut counts = BTreeMap::new();
    for stage in &stages {
        *counts.entry(stage.clone()).or_insert(0) += 1;
    }
    Ok(ProgressObservation {
        last: last.to_owned(),
        stages,
        counts,
    })
}

fn read_progress_file(path: &std::path::Path) -> String {
    const MAX_PROGRESS_BYTES: u64 = 4096;
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut value = String::new();
    file.take(MAX_PROGRESS_BYTES + 1)
        .read_to_string(&mut value)
        .expect("progress file is UTF-8");
    assert!(
        value.len() <= MAX_PROGRESS_BYTES as usize,
        "progress file exceeded bound"
    );
    value
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChildInput<'a> {
    origin: &'a str,
    installation_id: &'a str,
    device_id: &'a str,
    token: &'a str,
    foreign_origin: &'a str,
}
fn main() {
    const { assert!(cfg!(debug_assertions), "debug-only fixture") };
    let artifacts = PathBuf::from(std::env::args_os().nth(1).expect("artifact directory"));
    std::fs::create_dir_all(&artifacts).unwrap();
    let scratch = tempfile::Builder::new()
        .prefix("wp05-native-session-")
        .tempdir()
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let m = runtime
        .block_on(MockHarness::start(MockOptions {
            test_control: true,
            ..Default::default()
        }))
        .unwrap();
    let client = HarnessClient::new(Origin::parse(&m.origin).unwrap(), None);
    let credential = runtime
        .block_on(client.redeem(&m.control.create_pair_code(), "Native fixture"))
        .unwrap();
    let sensor = runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let foreign = format!("http://{}", sensor.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let recorded = hits.clone();
    runtime.spawn(async move {
        let app = axum::Router::new().fallback(axum::routing::any(move || {
            let hits = recorded.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                "foreign"
            }
        }));
        axum::serve(sensor, app).await.unwrap();
    });
    let mut reports = Vec::new();
    let mut tickets = Vec::new();
    for phase in ["first", "restart"] {
        m.control.reject_browser_tickets(false);
        let phase_root = scratch.path().join(phase);
        std::fs::create_dir_all(&phase_root).unwrap();
        let result = phase_root.join("result.json");
        let home = phase_root.join("home");
        let config = phase_root.join("config");
        let cache = phase_root.join("cache");
        let data = phase_root.join("data");
        let temp = phase_root.join("tmp");
        for d in [&home, &config, &cache, &data, &temp] {
            std::fs::create_dir_all(d).unwrap();
        }
        let prefs = if phase == "first" {
            json!({"theme":"dark","locale":"de"})
        } else {
            json!({"theme":"light","locale":"en"})
        };
        let settings_dir = config.join("app.plur1bus.desktop");
        std::fs::create_dir_all(&settings_dir).unwrap();
        std::fs::write(
            settings_dir.join("settings.json"),
            serde_json::to_vec(&prefs).unwrap(),
        )
        .unwrap();
        let exe = std::env::current_exe()
            .unwrap()
            .with_file_name(if cfg!(windows) {
                "production_spa.exe"
            } else {
                "production_spa"
            });
        let mut child = Command::new(exe)
            .arg(&result)
            .current_dir(&phase_root)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("CFFIXED_USER_HOME", &home)
            .env("APPDATA", &config)
            .env("LOCALAPPDATA", &cache)
            .env("XDG_CONFIG_HOME", &config)
            .env("XDG_CACHE_HOME", &cache)
            .env("XDG_DATA_HOME", &data)
            .env("TMPDIR", &temp)
            .env("TEMP", &temp)
            .env("TMP", &temp)
            .env(
                "PLUR1BUS_DESKTOP_CONFIG_DIR",
                config.join("app.plur1bus.desktop"),
            )
            .env("WP05_NATIVE_SCRATCH", &phase_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("native child");
        let input = zeroize::Zeroizing::new(
            serde_json::to_vec(&ChildInput {
                origin: &m.origin,
                installation_id: &m.installation_id,
                device_id: &credential.device_id,
                token: credential.token.expose(),
                foreign_origin: &foreign,
            })
            .unwrap(),
        );
        child.stdin.take().unwrap().write_all(&input).unwrap();
        drop(input);
        let child_started = std::time::Instant::now();
        let deadline = child_started + std::time::Duration::from_secs(90);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned native child timed out; raw output discarded");
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let last = read_progress_file(&result.with_extension("progress"));
        let history = read_progress_file(&result.with_extension("progress-history"));
        let observation = parse_progress_history(&last, &history).expect("closed progress stages");
        if !status.success() {
            const MAX_DIAGNOSTIC_BYTES: u64 = 262_144;
            let diagnostic = read_bounded(&result, MAX_DIAGNOSTIC_BYTES)
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .map(|value| parse_diagnostic(&value))
                .unwrap_or_else(NativeDiagnostic::unavailable);
            std::fs::write(
                artifacts.join(format!("{phase}.json")),
                serde_json::to_vec_pretty(&json!({
                    "result":"failed",
                    "milestone":observation.last.clone(),
                    "milestones":observation.stages,
                    "milestoneCounts":observation.counts,
                    "exitCode":status.code(),
                    "childElapsedMs":child_started.elapsed().as_millis().min(90_000),
                    "diagnostic":diagnostic,
                    "rawChildOutputDiscarded":true
                }))
                .unwrap(),
            )
            .unwrap();
        }
        assert!(
            status.success(),
            "native child failed at {} with code {:?}; raw output discarded",
            observation.last,
            status.code()
        );
        let bytes = read_bounded(&result, 262_144).expect("bounded native report");
        assert!(
            !bytes
                .windows(credential.token.expose().len())
                .any(|v| v == credential.token.expose().as_bytes()),
            "credential in public report"
        );
        let report: Value = serde_json::from_slice(&bytes).unwrap();
        if cfg!(windows) {
            let sweep: SweepObservation = serde_json::from_value(report["startupSweep"].clone())
                .expect("closed startup sweep observation");
            assert!(sweep.removed <= 128 && sweep.skipped_active <= 128);
            assert_eq!(
                sweep.skipped_unknown, 0,
                "startup sweep left unknown profile ownership"
            );
            assert_eq!(
                sweep.positive_profiles, 0,
                "startup sweep found cookie rows"
            );
            assert_eq!(sweep.positive_rows, 0, "startup sweep found cookie rows");
        }
        let diagnostic = parse_diagnostic(&report);
        assert!(
            diagnostic.secondary_probe.available,
            "secondary probe diagnostic unavailable"
        );
        assert!(
            diagnostic.secondary_probe.proxy_generated_403,
            "secondary probe proxy 403 was not observed"
        );
        assert!(
            diagnostic.secondary_probe.other_window_acl_denied,
            "secondary probe ACL denial was not observed"
        );
        assert!(
            diagnostic.teardown.clean(),
            "native teardown was incomplete"
        );
        assert!(
            diagnostic.pre_close_audit.live_clean(),
            "native live cookie audit failed"
        );
        assert!(
            diagnostic.secondary_probe.native_cookie_store_empty,
            "secondary cookie store not empty"
        );
        if cfg!(windows) {
            assert!(
                diagnostic.profile.native_cookie_store_empty,
                "observer cookie store not empty"
            );
            assert!(
                diagnostic.profile.profile_path_verified && diagnostic.profile.profile_acl_private,
                "observer profile isolation or ACL unverified"
            );
            assert!(
                diagnostic.profile.profile_live_audit.live_clean(),
                "observer live cookie database audit failed"
            );
            assert!(
                diagnostic.secondary_probe.profile_path_verified
                    && diagnostic.secondary_probe.profile_acl_private
                    && diagnostic.secondary_probe.profile_isolated
                    && diagnostic.secondary_probe.profile_cleanup_complete
                    && diagnostic.secondary_probe.cleanup_read_only_complete
                    && diagnostic.secondary_probe.cleanup_cookie_rows == 0
                    && !diagnostic.secondary_probe.cleanup_secret_detected
                    && diagnostic.secondary_probe.profile_live_audit.live_clean(),
                "secondary profile isolation, ACL, or cleanup failed"
            );
        }
        assert!(diagnostic.audit.clean(), "native audit not clean");
        std::fs::write(
            artifacts.join(format!("{phase}.json")),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        assert_eq!(report["sessions"].as_array().unwrap().len(), 2);
        for session in report["sessions"].as_array().unwrap() {
            for key in [
                "loggedIn",
                "fragmentGone",
                "cookieStoreEmpty",
                "shellInfo",
                "onlyShellInfo",
                "csrf",
                "sseUnbuffered",
                "sseSurvivesTenSeconds",
                "websocket",
                "selfAsset",
                "inlineCspBlocked",
                "download10MiB",
                "foreignRedirectBlocked",
                "foreignFetchBlocked",
                "foreignImageBlocked",
                "foreignWebsocketBlocked",
            ] {
                assert_eq!(session["browser"][key], true, "native check {key}");
            }
            assert_eq!(session["nativeCookieStoreEmpty"], true);
            if cfg!(windows) {
                assert_eq!(session["profilePathVerified"], true);
                assert_eq!(session["profileAclPrivate"], true);
                assert_eq!(session["profileIsolated"], true);
                assert!(
                    session_live_clean(session),
                    "authenticated SPA live cookie rows or audit failure"
                );
            }
        }
        assert_eq!(report["retirement"]["actualAclDenied"], true);
        if cfg!(target_os = "linux") {
            assert_eq!(report["retirement"]["proxyGenerated403"], true);
            assert_eq!(report["retirement"]["ipcAvailable"], true);
            assert_eq!(report["retirement"]["ipcCompleted"], true);
            assert_eq!(report["retirement"]["typeError"], false);
        }
        assert_eq!(
            report["negativeControls"]["missingWrongSecretHostOrigin"],
            true
        );
        assert_eq!(report["negativeControls"]["proxyGenerated403"], true);
        assert_eq!(
            report["negativeControls"]["otherWebview"]["otherWindowAclDenied"],
            true
        );
        assert_eq!(
            report["negativeControls"]["oldOriginWhileReplacementActive"]["aclDenied"],
            true
        );
        assert_eq!(
            report["negativeControls"]["oldOriginWhileReplacementActive"]["rustCallerDenied"],
            false
        );
        for key in ["terminalError", "fragmentGone", "controls44", "honestError"] {
            assert_eq!(report["ticketError"][key], true, "ticket error {key}");
        }
        assert_eq!(report["productionBenchmark"]["pairedRequests"], 100);
        assert!(
            report["productionBenchmark"]["p95OverheadMs"]
                .as_f64()
                .unwrap()
                <= 5.0,
            "production p95 exceeds5ms"
        );
        assert_eq!(report["ticketError"]["savedTheme"], prefs["theme"]);
        assert_eq!(report["ticketError"]["savedLocale"], prefs["locale"]);
        assert_eq!(report["secretOnDisk"], false);
        assert_eq!(report["cookieDatabaseFiles"], 0);
        let count = m
            .control
            .recorded_requests()
            .iter()
            .filter(|(p, _)| p == "/api/v1/auth/session-ticket")
            .count();
        tickets.push(count);
        assert_eq!(
            count,
            if phase == "first" { 3 } else { 6 },
            "fresh tickets for reopened windows and full restart"
        );
        std::fs::write(
            artifacts.join(format!("{phase}.json")),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        reports.push(report);
    }
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "foreign network handler was reached"
    );
    let report = json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"fullProcessRestart":true,"sessionsPerProcess":reports.iter().map(|r|r["sessions"].as_array().unwrap().len()).collect::<Vec<_>>(),"cumulativeFreshTickets":tickets,"foreignHandlerRequests":hits.load(Ordering::SeqCst),"rawChildOutputDiscarded":true,"credentialOrchestration":"Rust MemoryStore and stdin only","cookieDatabaseFiles":0,"secretOnDisk":false});
    std::fs::write(
        artifacts.join("index.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Native SPA acceptance completed");
}

#[cfg(test)]
mod tests {
    use super::{
        parse_diagnostic, parse_progress_history, session_live_clean, AuditFailureCategory,
        AuditObservation, NativeDiagnostic,
    };
    use serde_json::json;

    #[test]
    fn timeout_artifact_retains_closed_intermediate_stages_and_counts() {
        let observation = parse_progress_history(
            "other-window-wait-timeout",
            "other-window-page-finished\nother-window-eval-submitted\nother-window-script-entry\nother-window-fetch-start\nother-window-wait-timeout\n",
        )
        .unwrap();
        assert_eq!(observation.last, "other-window-wait-timeout");
        assert_eq!(observation.stages.len(), 5);
        assert_eq!(observation.counts["other-window-fetch-start"], 1);
        assert_eq!(observation.counts["other-window-wait-timeout"], 1);
    }

    #[test]
    fn progress_history_rejects_unknown_stage_without_echoing_it() {
        assert!(parse_progress_history(
            "other-window-wait-timeout",
            "other-window-page-finished\nnot-a-public-stage\n",
        )
        .is_err());
    }

    #[test]
    fn retirement_observer_stages_are_closed_and_whitelisted() {
        let stages = "retirement-observer-build-start\nretirement-observer-build-complete\nretirement-observer-build-deadline-exhausted\nretirement-observer-main-thread-dispatch-requested\nretirement-observer-main-thread-callback-before-deadline\nretirement-observer-main-thread-callback-after-deadline\nretirement-observer-main-thread-dispatch-request-failed\nretirement-observer-unexpected-url\nretirement-observer-page-started\nretirement-observer-page-finished\nretirement-observer-eval-submitted\nretirement-observer-script-entry\nretirement-observer-ipc-available\nretirement-observer-ipc-start\nretirement-observer-ipc-complete\nretirement-observer-title-complete\n";
        let observation = parse_progress_history("retirement-observer-title-complete", stages)
            .expect("retirement stages must be whitelisted");
        assert_eq!(observation.stages.len(), 16);
    }

    #[test]
    fn unknown_renderer_diagnostic_fields_become_unavailable() {
        let diagnostic = parse_diagnostic(&json!({
            "diagnostic": {
                "secondaryProbe": {
                    "available": true,
                    "proxyGenerated403": true,
                    "otherWindowAclDenied": true,
                    "documentOpaqueOrigin": false,
                    "documentContentTypeTextPlain": true,
                    "fetchRejectedTypeError": true,
                    "privatePayload": "discard"
                },
                "audit": {
                    "auditComplete": true,
                    "secretDetected": false,
                    "cookieDatabaseFiles": 0,
                    "readFailures": 0,
                    "entriesDisappeared": 0,
                    "metadataFailures": 0,
                    "readDirFailures": 0,
                    "symlinkEntries": 0,
                    "failureCategory": "none"
                }
            }
        }));
        assert!(!diagnostic.secondary_probe.available);
        assert!(!diagnostic.audit.audit_complete);
        assert_eq!(
            diagnostic.audit.failure_category,
            AuditFailureCategory::ReadDir
        );
    }

    #[test]
    fn diagnostic_counter_overflow_becomes_unavailable() {
        let diagnostic = parse_diagnostic(&json!({
            "diagnostic": {
                "secondaryProbe": {
                    "available": true,
                    "proxyGenerated403": true,
                    "otherWindowAclDenied": true,
                    "documentOpaqueOrigin": false,
                    "documentContentTypeTextPlain": true,
                    "fetchRejectedTypeError": true
                },
                "audit": {
                    "auditComplete": false,
                    "secretDetected": false,
                    "cookieDatabaseFiles": 4097,
                    "readFailures": 0,
                    "entriesDisappeared": 0,
                    "metadataFailures": 0,
                    "readDirFailures": 0,
                    "symlinkEntries": 0,
                    "failureCategory": "counter-limit"
                }
            }
        }));
        assert!(!diagnostic.secondary_probe.available);
        assert!(!diagnostic.audit.audit_complete);
    }

    #[test]
    fn contradictory_clean_audit_remains_available_but_fails_clean_check() {
        let mut observation = NativeDiagnostic::unavailable();
        observation.secondary_probe.available = true;
        observation.audit.audit_complete = true;
        observation.audit.cookie_read_only_complete = true;
        observation.audit.read_failures = 1;
        observation.audit.failure_category = AuditFailureCategory::None;
        let diagnostic = parse_diagnostic(&json!({ "diagnostic": observation }));
        assert!(diagnostic.secondary_probe.available);
        assert!(!diagnostic.audit.clean());
        assert_eq!(diagnostic.audit.read_failures, 1);
    }

    #[test]
    fn missing_profile_evidence_is_unavailable() {
        let mut value = serde_json::to_value(NativeDiagnostic::unavailable()).unwrap();
        value.as_object_mut().unwrap().remove("profile");
        let diagnostic = parse_diagnostic(&json!({ "diagnostic": value }));
        assert!(!diagnostic.secondary_probe.available);
    }

    #[test]
    fn missing_failure_target_makes_diagnostic_unavailable() {
        let mut value = serde_json::to_value(NativeDiagnostic::unavailable()).unwrap();
        value["audit"]
            .as_object_mut()
            .unwrap()
            .remove("failureTarget");
        let diagnostic = parse_diagnostic(&json!({ "diagnostic": value }));
        assert!(!diagnostic.audit.audit_complete);
        assert_eq!(
            diagnostic.audit.failure_category,
            AuditFailureCategory::ReadDir
        );
    }

    #[test]
    fn each_authenticated_session_requires_complete_live_zero_rows() {
        assert!(!session_live_clean(&json!({})));
        let mut audit = AuditObservation::unavailable();
        audit.audit_complete = true;
        audit.cookie_read_only_complete = true;
        audit.failure_category = AuditFailureCategory::None;
        assert!(session_live_clean(&json!({ "profileLiveAudit": audit })));
        audit.cookie_rows = 1;
        audit.failure_category = AuditFailureCategory::CookieDatabase;
        assert!(!session_live_clean(&json!({ "profileLiveAudit": audit })));
    }
}
