use plur1bus_desktop::{diagnostics::Diagnostics, logging::*};

#[test]
fn native_diagnostics_bootstrap_uses_owned_profile_and_shared_redaction() {
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
