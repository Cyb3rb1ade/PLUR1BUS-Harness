use plur1bus_desktop::{diagnostics::Diagnostics, logging::*};

// Production redaction deliberately fails closed during process-registry writes.
// Keep unrelated registration out of this disk-persistence observation.
static PROCESS_REGISTRY_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[test]
fn native_diagnostics_bootstrap_uses_owned_profile_and_shared_redaction() {
    let _registry = PROCESS_REGISTRY_TEST.blocking_lock();
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let diagnostics =
        Diagnostics::open(&root.join("logs"), "/synthetic/home", "fixture-target").unwrap();
    let secret = "CANARY-native-diagnostic-secret";
    let credential = plur1bus_desktop::secrets::SecretString::new(secret.into());
    assert_eq!(credential.expose(), secret);
    let mut record = RecordInput::new(Event::DeeplinkIgnored);
    record.err = Some(DiagnosticError {
        code: ErrorCode::Auth,
        reason: secret.into(),
        retryable: false,
        hint: None,
    });
    diagnostics.writer.emit(record).unwrap();
    let lines = diagnostics.writer.recent_lines().unwrap();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("desktop.app.started"));
    assert!(!lines.join("\n").contains(secret));
    assert!(diagnostics.crash.pending().unwrap().is_empty());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.join("logs"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn native_diagnostics_rejects_relative_location_before_creating_files() {
    assert!(Diagnostics::open(
        std::path::Path::new("relative-profile"),
        "/synthetic/home",
        "fixture"
    )
    .is_err());
}

#[test]
fn secret_registration_failure_closes_the_redaction_boundary() {
    use std::sync::Arc;
    let registry = Arc::new(SecretRegistry::default());
    let formatter = Formatter::new(
        registry.clone(),
        Arc::new(CredentialPaths::new("/synthetic/home")),
        true,
    );
    registry.register_sensitive(&"x".repeat(4097));
    assert_eq!(
        formatter.redact_text("otherwise readable"),
        Err(RedactionError::RegistryLimit)
    );
    assert!(formatter
        .redact_json(&serde_json::json!({"reason":"otherwise readable"}))
        .is_err());
}

#[tokio::test]
async fn confirmed_shutdown_flushes_expired_diagnostics_through_production_worker() {
    let _registry = PROCESS_REGISTRY_TEST.lock().await;
    use chrono::{DateTime, TimeDelta, Utc};
    use std::sync::{Arc, Mutex};
    struct Clock(Mutex<DateTime<Utc>>);
    impl LogClock for Clock {
        fn now(&self) -> DateTime<Utc> {
            *self.0.lock().unwrap()
        }
    }
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(Clock(Mutex::new("2026-10-04T10:00:00Z".parse().unwrap())));
    let diagnostics = Diagnostics::open_with_clock(
        &root.path().canonicalize().unwrap().join("logs"),
        "/synthetic/home",
        "fixture",
        clock.clone(),
    )
    .unwrap();
    let writer = diagnostics.writer.clone();
    assert_eq!(
        writer
            .emit(RecordInput::new(Event::DeeplinkIgnored))
            .unwrap(),
        EmitStatus::Written
    );
    assert_eq!(
        writer
            .emit(RecordInput::new(Event::DeeplinkIgnored))
            .unwrap(),
        EmitStatus::Deduplicated
    );
    *clock.0.lock().unwrap() += TimeDelta::seconds(60);
    plur1bus_desktop::diagnostics::shutdown_owned(diagnostics)
        .await
        .unwrap();
    let records: Vec<String> = std::fs::read_dir(root.path().join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .flat_map(|path| {
            std::fs::read_to_string(path)
                .unwrap()
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    assert!(
        records.iter().any(|line| {
            let record: serde_json::Value = serde_json::from_str(line).unwrap();
            record["event"] == "desktop.deeplink.ignored" && record["attrs"]["repeat"] == 2
        }),
        "production shutdown worker must persist the expired repeat summary"
    );
}

#[tokio::test]
async fn blocked_shutdown_worker_returns_the_closed_timeout_reason() {
    use chrono::{DateTime, Utc};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    };
    struct Clock {
        enabled: AtomicBool,
        entered: AtomicBool,
        released: Mutex<bool>,
        signal: Condvar,
    }
    impl LogClock for Clock {
        fn now(&self) -> DateTime<Utc> {
            if self.enabled.load(Ordering::SeqCst) {
                self.entered.store(true, Ordering::SeqCst);
                let mut released = self.released.lock().unwrap();
                while !*released {
                    released = self.signal.wait(released).unwrap();
                }
            }
            "2026-10-04T10:00:00Z".parse().unwrap()
        }
    }
    let root = tempfile::tempdir().unwrap();
    let clock = Arc::new(Clock {
        enabled: AtomicBool::new(false),
        entered: AtomicBool::new(false),
        released: Mutex::new(false),
        signal: Condvar::new(),
    });
    let diagnostics = Diagnostics::open_with_clock(
        &root.path().canonicalize().unwrap().join("logs"),
        "/synthetic/home",
        "fixture",
        clock.clone(),
    )
    .unwrap();
    clock.enabled.store(true, Ordering::SeqCst);
    let result = plur1bus_desktop::diagnostics::shutdown_owned(diagnostics).await;
    *clock.released.lock().unwrap() = true;
    clock.signal.notify_all();
    assert!(
        clock.entered.load(Ordering::SeqCst),
        "real shutdown worker must enter the injected blocking clock"
    );
    assert_eq!(result, Err("DIAGNOSTIC_SHUTDOWN_TIMEOUT"));
}
