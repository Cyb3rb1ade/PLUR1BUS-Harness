use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, TimeDelta, Utc};
use plur1bus_desktop::logging::*;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct Clock(Arc<Mutex<DateTime<Utc>>>);
impl Clock {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(
            "2026-10-04T10:11:12.123Z".parse().unwrap(),
        )))
    }
    fn advance(&self, seconds: i64) {
        *self.0.lock().unwrap() += TimeDelta::seconds(seconds);
    }
}
impl LogClock for Clock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}
fn formatter(pii: bool) -> Formatter {
    Formatter::new(
        Arc::new(SecretRegistry::default()),
        Arc::new(CredentialPaths::new("/synthetic/home")),
        pii,
    )
}
fn open(dir: &Path, clock: &Clock, options: WriterOptions, fmt: Formatter) -> Writer {
    Writer::open(
        &dir.canonicalize().unwrap(),
        options,
        fmt,
        Arc::new(clock.clone()),
    )
    .unwrap()
}
fn lines(dir: &Path) -> Vec<String> {
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|s| s == "jsonl"))
        .collect();
    files.sort();
    files
        .iter()
        .flat_map(|p| {
            fs::read_to_string(p)
                .unwrap()
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect()
}
fn connection() -> RecordInput {
    RecordInput::new(Event::ConnectionLost {
        connection_id: uuid::Uuid::nil(),
        retrying: true,
    })
}

#[test]
fn redact_removes_tokens_tickets_cookies_keys_and_url_fragments() {
    let fmt = formatter(false);
    let values = [
        "synthetic-token-value",
        "synthetic-ticket-value",
        "synthetic-cookie-value",
        "synthetic-key-value",
        "synthetic-fragment-value",
    ];
    let input = format!("Authorization: Bearer {}\nCookie: sid={}\n{{\"ticket\":\"{}\",\"key\":\"{}\"}} https://user:pass@example.invalid/path?q=hello#{}", values[0], values[2], values[1], values[3], values[4]);
    let result = fmt.redact_text(&input).unwrap();
    for value in values {
        assert!(!result.contains(value), "sensitive text survived");
    }
    assert!(!result.contains("user:pass"));
    assert!(result.contains("[REDACTED:key]"));
    assert!(result.contains("q=[REDACTED:url]"));
    assert!(result.contains("#[REDACTED:url]"));
}

#[test]
fn registered_encodings_patterns_paths_and_optional_pii_are_scrubbed() {
    let secrets = Arc::new(SecretRegistry::default());
    let planted = "synthetic lease /+? with spaces";
    secrets.register(planted).unwrap();
    let fmt = Formatter::new(
        secrets,
        Arc::new(CredentialPaths::new("/synthetic/home")),
        false,
    );
    let encoded: String = url::form_urlencoded::byte_serialize(planted.as_bytes()).collect();
    let b64 = STANDARD.encode(planted);
    let hex = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    let inputs = [
        planted.to_string(),
        encoded,
        b64,
        "Bearer short-synthetic-value".into(),
        "Basic YWJjZGVmZw==".into(),
        "sk-ant-syntheticSecret".into(),
        "sk-proj-syntheticSecret".into(),
        "sk-syntheticSecret".into(),
        "ek_syntheticSecret".into(),
        "ghp_syntheticSecret".into(),
        "github_pat_syntheticSecret".into(),
        "xoxa-syntheticSecret".into(),
        "xoxb-syntheticSecret".into(),
        "xoxp-syntheticSecret".into(),
        "xoxr-syntheticSecret".into(),
        "AKIA1234567890ABCDEF".into(),
        format!("AIza{}", "Z".repeat(35)),
        "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c2ln".into(),
        format!(
            "-----BEGIN {0}-----\nsynthetic key material\n-----END {0}-----",
            "RSA PRIVATE KEY"
        ),
        "PLUR1BUS_TEST_VALUE=syntheticValue".into(),
        "Qz-_".repeat(14),
        "/synthetic/home/.ssh/id_ed25519".into(),
        "/synthetic/home/.gnupg/private-keys-v1.d/test".into(),
        "/synthetic/home/Library/Keychains/login.keychain-db".into(),
        "/synthetic/home/.aws/credentials".into(),
        "/synthetic/home/project/.env".into(),
        "/synthetic/home/.codex/auth.json".into(),
    ];
    for input in inputs {
        let out = fmt.redact_text(&input).unwrap();
        assert!(!out.contains(&input), "canary survived");
    }
    assert_eq!(fmt.redact_text(hex).unwrap(), hex);
    assert!(fmt
        .redact_text("/synthetic/home/.ssh/id_ed25519")
        .unwrap()
        .contains("<deny:ssh>/…#"));
    let pii = "person@example.invalid +49 170 1234567";
    assert_eq!(fmt.redact_text(pii).unwrap(), pii);
    assert!(!formatter(true)
        .redact_text(pii)
        .unwrap()
        .contains("person@"));
    assert!(!formatter(true)
        .redact_text(pii)
        .unwrap()
        .contains("1234567"));
}

#[test]
fn json_keys_are_case_insensitive_and_nested_values_are_replaced() {
    let fmt = formatter(false);
    for key in [
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "token",
        "secret",
        "password",
        "passwd",
        "apiKey",
        "api_key",
        "api-key",
        "clientSecret",
        "refresh",
        "code_verifier",
        "ticket",
        "csrf",
        "id_token_hint",
        "privateKey",
        "sessionKey",
        "code",
        "key",
    ] {
        let out = fmt
            .redact_json(&json!({key: {"nested": "synthetic-sensitive"}}))
            .unwrap();
        assert_eq!(out[key], "[REDACTED:key]");
        let out = fmt
            .redact_text(&format!("{key}=synthetic-sensitive"))
            .unwrap();
        assert!(!out.contains("synthetic-sensitive"), "key value survived");
    }
}

#[test]
fn the_log_file_never_contains_a_planted_token_or_key() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let secrets = Arc::new(SecretRegistry::default());
    let planted = "syntheticRegisteredValue";
    secrets.register(planted).unwrap();
    let fmt = Formatter::new(
        secrets,
        Arc::new(CredentialPaths::new("/synthetic/home")),
        false,
    );
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions {
            version: Some(planted.into()),
            ..Default::default()
        },
        fmt,
    );
    let hash = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    let mut input = RecordInput::new(Event::UpdateFailed {
        phase: UpdatePhase::Verify,
        sha256: Some(hash.into()),
    });
    input.trace_id = Some("4bf92f3577b34da6a3ce929d0e0e4736".into());
    input.span_id = Some("00f067aa0ba902b7".into());
    input.duration_ms = Some(25);
    input.err = Some(DiagnosticError {
        code: ErrorCode::Auth,
        reason: "sk-proj-syntheticFileKey".into(),
        retryable: false,
        hint: Some(ErrorHint::PairAgain),
    });
    writer.emit(input).unwrap();
    let records = lines(dir.path());
    assert_eq!(records.len(), 1);
    let raw = &records[0];
    assert!(!raw.contains(planted), "secret found in real file");
    assert!(
        !raw.contains("sk-proj-syntheticFileKey"),
        "vendor key found in real file"
    );
    let value: Value = serde_json::from_str(raw).unwrap();
    validate_record(&value).unwrap();
    let schema: Value = serde_json::from_str(RECORD_SCHEMA_JSON).unwrap();
    assert!(
        jsonschema::validator_for(&schema).unwrap().is_valid(&value),
        "record violates standalone JSON schema"
    );
    assert_eq!(value["source"]["kind"], "desktop");
    assert_eq!(value["source"]["id"], "shell");
    assert_eq!(value["err"]["code"], "auth");
    assert_eq!(value["attrs"]["sha256"], hash);
    assert_eq!(value["ts"], "2026-10-04T10:11:12.123Z");
    let mut previous = 0;
    for key in [
        "ts",
        "level",
        "source",
        "event",
        "msg",
        "trace_id",
        "span_id",
        "duration_ms",
        "err",
        "attrs",
    ] {
        let at = raw.find(&format!("\"{key}\":")).unwrap();
        assert!(at >= previous);
        previous = at;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().path()) {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn event_shapes_forbid_page_data_and_schema_rejects_invalid_metadata() {
    assert!(Event::from_registered(
        "desktop.deeplink.ignored",
        json!({"url":"https://example.invalid"})
    )
    .is_err());
    assert!(Event::from_registered(
        "desktop.webview.failed",
        json!({"webview":"panel-1", "failure":"terminated"})
    )
    .is_err());
    for field in [
        "page",
        "url",
        "body",
        "tool_result",
        "transcript",
        "foreign_message",
    ] {
        assert!(Event::from_registered("desktop.app.started", json!({field:"forbidden"})).is_err());
    }
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    let mut bad = connection();
    bad.trace_id = Some("A".repeat(32));
    assert!(writer.emit(bad).is_err());
    let mut bad = connection();
    bad.span_id = Some("0".repeat(16));
    assert!(writer.emit(bad).is_err());
    writer
        .emit(RecordInput::new(Event::DeeplinkIgnored))
        .unwrap();
    let raw = lines(dir.path()).pop().unwrap();
    assert!(!raw.contains("attrs"));
    assert!(!raw.contains("trace_id"));
    let mut value: Value = serde_json::from_str(&raw).unwrap();
    value["err"] = json!({"code":"arbitrary", "reason":"failed", "retryable":false});
    assert!(validate_record(&value).is_err());
    value.as_object_mut().unwrap().remove("err");
    value["surprise"] = json!(true);
    assert!(validate_record(&value).is_err());
    value.as_object_mut().unwrap().remove("surprise");
    value["source"].as_object_mut().unwrap().remove("version");
    assert!(
        validate_record(&value).is_err(),
        "source.version must be present even when unknown"
    );
    value["source"]["version"] = Value::Null;
    value["trace_id"] = Value::Null;
    assert!(
        validate_record(&value).is_err(),
        "absent optional fields must be omitted"
    );
}

#[test]
fn catalogue_and_unknown_events_obey_build_policy() {
    let catalogue: Value = serde_json::from_str(CATALOGUE_JSON).unwrap();
    let mut codes = std::collections::BTreeSet::new();
    for entry in catalogue.as_array().unwrap() {
        assert!(codes.insert(entry["event"].as_str().unwrap()));
    }
    for (event, level) in [
        (Event::AppStarted, "info"),
        (
            Event::AppCrashed {
                crash_id: "crash-test".into(),
            },
            "fatal",
        ),
        (connection().event, "warn"),
        (
            Event::WebviewFailed {
                webview: Webview::Shell,
                failure: WebviewFailure::Terminated,
            },
            "error",
        ),
        (
            Event::UpdateFailed {
                phase: UpdatePhase::Download,
                sha256: None,
            },
            "error",
        ),
        (Event::DeeplinkIgnored, "info"),
    ] {
        let entry = catalogue
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["event"] == event.code())
            .unwrap();
        assert_eq!(entry["level"], level);
    }
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    let result = writer.emit_named("unregistered.event?token=syntheticValue", json!({}));
    if cfg!(debug_assertions) {
        assert!(result.is_err());
        assert!(lines(dir.path()).is_empty());
    } else {
        result.unwrap();
        let raw = lines(dir.path()).pop().unwrap();
        assert!(raw.contains("log.unregistered"));
        assert!(!raw.contains("syntheticValue"));
    }
}

#[test]
fn levels_trace_expiry_and_live_policy_do_not_rewrite_the_preference() {
    for (level, otel, syslog) in [
        (Level::Trace, 1, 7),
        (Level::Debug, 5, 7),
        (Level::Info, 9, 6),
        (Level::Warn, 13, 4),
        (Level::Error, 17, 3),
        (Level::Fatal, 21, 2),
    ] {
        assert_eq!((level.otel_number(), level.syslog_number()), (otel, syslog));
    }
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let mut policy = LevelPolicy {
        default: Level::Trace,
        ..Default::default()
    };
    assert!(policy.validate(clock.now()).is_err());
    policy.trace_until = Some(clock.now() + TimeDelta::hours(25));
    assert!(policy.validate(clock.now()).is_err());
    policy.trace_until = Some(clock.now() + TimeDelta::seconds(10));
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions {
            levels: policy.clone(),
            ..Default::default()
        },
        formatter(false),
    );
    assert_eq!(writer.effective_level().unwrap(), Level::Trace);
    clock.advance(11);
    writer.tick().unwrap();
    writer.tick().unwrap();
    assert_eq!(writer.effective_level().unwrap(), Level::Debug);
    assert_eq!(policy.default, Level::Trace);
    assert_eq!(
        lines(dir.path())
            .iter()
            .filter(|l| l.contains("log.level.expired"))
            .count(),
        1
    );
    let policy = LevelPolicy {
        default: Level::Fatal,
        ..Default::default()
    };
    writer.set_levels(policy).unwrap();
    assert_eq!(writer.emit(connection()).unwrap(), EmitStatus::Filtered);
    writer
        .emit(RecordInput::new(Event::AppCrashed {
            crash_id: "crash-test".into(),
        }))
        .unwrap();
    assert!(lines(dir.path())
        .iter()
        .any(|l| l.contains("desktop.app.crashed")));
}

#[test]
fn diagnostic_dedup_counts_first_and_fatal_is_never_suppressed() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    for _ in 0..340 {
        writer.emit(connection()).unwrap();
    }
    assert_eq!(lines(dir.path()).len(), 1);
    clock.advance(60);
    writer.tick().unwrap();
    let records = lines(dir.path());
    assert_eq!(records.len(), 2);
    let summary: Value = serde_json::from_str(&records[1]).unwrap();
    assert_eq!(summary["attrs"]["repeat"], 340);
    assert_eq!(summary["attrs"]["window_ms"], 60000);
    for _ in 0..2 {
        writer
            .emit(RecordInput::new(Event::AppCrashed {
                crash_id: "crash-test".into(),
            }))
            .unwrap();
    }
    assert_eq!(
        lines(dir.path())
            .iter()
            .filter(|l| l.contains("desktop.app.crashed"))
            .count(),
        2
    );
}

#[test]
fn rotation_age_retention_and_ring_are_bounded_and_leave_unowned_files() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    fs::write(dir.path().join("unrelated.jsonl"), "keep").unwrap();
    fs::write(dir.path().join("crash-unrelated.txt"), "keep").unwrap();
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions {
            limits: Limits {
                max_file_bytes: 1400,
                keep_files: 3,
                ..Default::default()
            },
            ..Default::default()
        },
        formatter(false),
    );
    for _ in 0..205 {
        writer
            .emit(RecordInput::new(Event::AppCrashed {
                crash_id: "crash-test".into(),
            }))
            .unwrap();
    }
    assert_eq!(writer.recent_lines().unwrap().len(), 200);
    let owned: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("desktop-")
        })
        .collect();
    assert!(owned.len() <= 3);
    for path in owned {
        assert!(fs::metadata(path).unwrap().len() <= 1400);
    }
    clock.advance(15 * 86400);
    writer.tick().unwrap();
    assert!(lines(dir.path())
        .iter()
        .any(|l| l.contains("log.retention.pruned")));
    assert_eq!(
        fs::read_to_string(dir.path().join("unrelated.jsonl")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("crash-unrelated.txt")).unwrap(),
        "keep"
    );
    assert!(!fs::read_dir(dir.path()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("desktop-2026-10-04")));
}

struct BrokenResolver;
impl CredentialPathResolver for BrokenResolver {
    fn classify(&self, _: &str) -> Result<Option<DeniedPath>, RedactionError> {
        Err(RedactionError::Resolver)
    }
}
#[test]
fn redaction_failure_drops_original_and_writes_only_registered_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let fmt = Formatter::new(
        Arc::new(SecretRegistry::default()),
        Arc::new(BrokenResolver),
        false,
    );
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions {
            version: Some("/synthetic/path/canary".into()),
            ..Default::default()
        },
        fmt,
    );
    assert_eq!(
        writer.emit(connection()).unwrap(),
        EmitStatus::RedactionFailed
    );
    let raw = lines(dir.path()).pop().unwrap();
    assert!(!raw.contains("canary"));
    assert!(raw.contains("log.redaction.failed"));
    validate_record(&serde_json::from_str(&raw).unwrap()).unwrap();
}

#[cfg(unix)]
#[test]
fn unsafe_directory_symlink_file_and_hardlink_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let link = dir.path().join("linked");
    symlink(outside.path(), &link).unwrap();
    assert!(Writer::open(
        &link,
        WriterOptions::default(),
        formatter(false),
        Arc::new(clock.clone())
    )
    .is_err());
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o777)).unwrap();
    assert!(Writer::open(
        &dir.path().canonicalize().unwrap(),
        WriterOptions::default(),
        formatter(false),
        Arc::new(clock.clone())
    )
    .is_err());
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    writer.emit(connection()).unwrap();
    let log = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|s| s == "jsonl"))
        .unwrap();
    fs::remove_file(&log).unwrap();
    fs::write(outside.path().join("victim"), "untouched").unwrap();
    symlink(outside.path().join("victim"), &log).unwrap();
    assert!(writer.emit(RecordInput::new(Event::AppStarted)).is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("victim")).unwrap(),
        "untouched"
    );
    fs::remove_file(&log).unwrap();
    fs::set_permissions(
        outside.path().join("victim"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::hard_link(outside.path().join("victim"), &log).unwrap();
    assert!(writer.emit(RecordInput::new(Event::AppStarted)).is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("victim")).unwrap(),
        "untouched"
    );
}

#[test]
fn encoded_secrets_preserve_case_and_unpadded_forms_are_redacted() {
    let registry = Arc::new(SecretRegistry::default());
    let planted = "SynthetIC/+?";
    registry.register(planted).unwrap();
    let fmt = Formatter::new(
        registry,
        Arc::new(CredentialPaths::new("/synthetic/home")),
        false,
    );
    for value in [
        "SynthetIC%2f%2b%3f".to_string(),
        STANDARD.encode(planted).trim_end_matches('=').to_owned(),
    ] {
        assert!(
            !fmt.redact_text(&value).unwrap().contains(&value),
            "encoded secret survived"
        );
    }
}

#[test]
fn pii_redaction_preserves_pure_hex_hashes() {
    let hash = "1234567890123456789012345678901234567890123456789012345678901234";
    assert_eq!(formatter(true).redact_text(hash).unwrap(), hash);
}

#[test]
fn hash_validation_does_not_apply_the_trace_ids_nonzero_rule() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let writer = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    let hash = "0".repeat(64);
    assert!(writer
        .emit(RecordInput::new(Event::UpdateFailed {
            phase: UpdatePhase::Verify,
            sha256: Some(hash.clone())
        }))
        .is_ok());
    let record: Value = serde_json::from_str(&lines(dir.path())[0]).unwrap();
    assert_eq!(record["attrs"]["sha256"], hash);
}

#[test]
fn clock_rollback_keeps_the_active_file_within_the_retention_cap() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let options = WriterOptions {
        limits: Limits {
            keep_files: 2,
            ..Limits::default()
        },
        ..WriterOptions::default()
    };
    let writer = open(dir.path(), &clock, options, formatter(false));
    let emit = |id: &str| {
        writer
            .emit(RecordInput::new(Event::AppCrashed {
                crash_id: id.into(),
            }))
            .unwrap()
    };
    assert_eq!(emit("first-day"), EmitStatus::Written);
    clock.advance(86400);
    assert_eq!(emit("second-day"), EmitStatus::Written);
    clock.advance(-172800);
    assert_eq!(emit("rolled-back-day"), EmitStatus::Written);
    assert!(lines(dir.path())
        .iter()
        .any(|line| line.contains("rolled-back-day")));
    assert_eq!(emit("second-after-rollback"), EmitStatus::Written);
    assert!(lines(dir.path())
        .iter()
        .any(|line| line.contains("second-after-rollback")));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn start_prunes_expired_files_even_without_a_new_event() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let w = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    w.emit(connection()).unwrap();
    drop(w);
    clock.advance(14 * 86400 + 1);
    let _w = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    assert!(!fs::read_dir(dir.path()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("desktop-2026-10-04")));
}

#[test]
fn source_specific_levels_win_and_expired_startup_trace_resolves_debug() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let mut levels = LevelPolicy {
        default: Level::Error,
        desktop: Some(Level::Warn),
        ..Default::default()
    };
    levels.sources.insert(SourceId::Shell, Level::Info);
    let w = open(
        dir.path(),
        &clock,
        WriterOptions {
            levels,
            ..Default::default()
        },
        formatter(false),
    );
    assert_eq!(w.effective_level().unwrap(), Level::Info);
    assert_eq!(
        w.emit(RecordInput::new(Event::AppStarted)).unwrap(),
        EmitStatus::Written
    );
    drop(w);
    let levels = LevelPolicy {
        default: Level::Trace,
        trace_until: Some(clock.now() - TimeDelta::seconds(1)),
        ..Default::default()
    };
    let writer = Writer::open(
        &dir.path().canonicalize().unwrap(),
        WriterOptions {
            levels,
            ..Default::default()
        },
        formatter(false),
        Arc::new(clock),
    );
    assert!(
        writer.is_ok(),
        "a persisted expired trace preference must not prevent startup"
    );
    let writer = writer.unwrap();
    writer.tick().unwrap();
    assert_eq!(writer.effective_level().unwrap(), Level::Debug);
}

#[test]
fn static_catalogue_covers_all_native_event_literals_and_schema_alternatives() {
    let catalogue: Value = serde_json::from_str(CATALOGUE_JSON).unwrap();
    let names: std::collections::BTreeSet<_> = catalogue
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    let pattern = regex::Regex::new(r#""((?:desktop|log)(?:\.[a-z][a-z_]*){1,3})""#).unwrap();
    let mut dirs = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let source = fs::read_to_string(path).unwrap();
                for found in pattern.captures_iter(&source) {
                    assert!(
                        names.contains(&found[1]),
                        "unregistered native event literal"
                    );
                }
            }
        }
    }
    let schema: Value = serde_json::from_str(RECORD_SCHEMA_JSON).unwrap();
    let alternatives: std::collections::BTreeSet<_> = schema["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["properties"]["event"]["const"].as_str().unwrap())
        .collect();
    assert_eq!(alternatives, names);
    let levels: Value = serde_json::from_str(LEVELS_JSON).unwrap();
    for entry in levels.as_array().unwrap() {
        let level: Level = serde_json::from_value(entry["level"].clone()).unwrap();
        assert_eq!(level.otel_number(), entry["otel"].as_u64().unwrap() as u8);
        assert_eq!(
            level.syslog_number(),
            entry["syslog"].as_u64().unwrap() as u8
        );
    }
}

#[test]
fn source_handles_share_rotation_but_never_attribution_or_dedup_identity() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Clock::new();
    let shell = open(
        dir.path(),
        &clock,
        WriterOptions::default(),
        formatter(false),
    );
    let controller = shell.for_source(SourceId::Controller);
    shell.emit(connection()).unwrap();
    controller.emit(connection()).unwrap();
    let records = lines(dir.path());
    assert_eq!(
        records.len(),
        2,
        "distinct sources must not deduplicate each other"
    );
    let first: Value = serde_json::from_str(&records[0]).unwrap();
    let second: Value = serde_json::from_str(&records[1]).unwrap();
    assert_eq!(first["source"]["id"], "shell");
    assert_eq!(second["source"]["id"], "controller");
    assert_eq!(controller.recent_lines().unwrap().len(), 2);
}

#[test]
fn credential_paths_include_auth_records_quoted_paths_and_controlled_aliases() {
    let fmt = formatter(false);
    for path in [
        "/synthetic/home/project/production.env",
        "/synthetic/home/.credentials.json",
        "/synthetic/other/agents/a/agent/auth-profiles.json",
        "/synthetic/other/agents/a/agent/state.sqlite",
        "/synthetic/other/credentials/value",
        r"C:\synthetic\AppData\Local\hermes\auth.json",
    ] {
        assert!(
            fmt.redact_text(path).unwrap().contains("[REDACTED:path]"),
            "credential path survived"
        );
    }
    let text = fmt
        .redact_text("at \"/synthetic home/.ssh/key file\"")
        .unwrap();
    assert!(
        !text.contains("synthetic home"),
        "quoted credential path was only partly removed"
    );
    struct Alias;
    impl CredentialPathResolver for Alias {
        fn classify(&self, path: &str) -> Result<Option<DeniedPath>, RedactionError> {
            Ok((path == "/synthetic/alias").then(|| DeniedPath {
                class: CredentialClass::Ssh,
                canonical: "/synthetic/home/.ssh/id_key".into(),
            }))
        }
    }
    let alias = Formatter::new(Arc::new(SecretRegistry::default()), Arc::new(Alias), false);
    let out = alias.redact_text("at /synthetic/alias").unwrap();
    assert!(out.contains("<deny:ssh>/…#"));
    assert!(!out.contains("/synthetic/alias"));
}

#[test]
fn registry_saturation_is_counted_and_keeps_safe_event_records() {
    let registry = Arc::new(SecretRegistry::default());
    // Fill the bounded encoding store with distinct values; never evict credentials.
    for index in 0..2000 {
        registry.register_sensitive(&format!("credential-{index:04}/+suffix"));
    }
    let failures = registry.registration_failures();
    assert!(failures > 0);
    let directory = tempfile::tempdir().unwrap();
    let fmt = Formatter::new(
        registry,
        Arc::new(CredentialPaths::new("/synthetic/home")),
        false,
    );
    let writer = open(
        directory.path(),
        &Clock::new(),
        WriterOptions::default(),
        fmt,
    );
    assert_eq!(
        writer
            .emit(RecordInput::new(Event::AppCrashed {
                crash_id: "credential-1999/+suffix".replace(['/', '+'], "-")
            }))
            .unwrap(),
        EmitStatus::Written
    );
    assert_eq!(
        writer.emit(RecordInput::new(Event::AppStarted)).unwrap(),
        EmitStatus::Written
    );
    let records = lines(directory.path());
    assert_eq!(records.len(), 3); // one visible count, then both original event envelopes
    let values: Vec<Value> = records
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(values[0]["event"], "log.registry.saturated");
    assert_eq!(values[0]["attrs"]["failures"], failures);
    assert_eq!(values[1]["event"], "desktop.app.crashed");
    assert_eq!(values[1]["attrs"]["crash_id"], "[REDACTED:registry]");
    assert_eq!(values[2]["event"], "desktop.app.started");
    let schema: Value = serde_json::from_str(RECORD_SCHEMA_JSON).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    for value in values {
        validate_record(&value).unwrap();
        assert!(
            validator.is_valid(&value),
            "registry fallback violates wire schema"
        );
    }
    assert!(!records.join("\n").contains("credential-"));
}
