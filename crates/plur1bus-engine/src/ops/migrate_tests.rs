#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "synthetic migration assertions"
)]
use super::*;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Barrier, Mutex,
    },
};
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
#[derive(Default)]
struct Audit {
    entries: Mutex<Vec<Value>>,
    fail: AtomicBool,
}
impl MaintenanceAudit for Audit {
    fn append(&self, entry: &Value) -> Result<(), EngineError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(storage(()));
        }
        self.entries.lock().unwrap().push(entry.clone());
        Ok(())
    }
}
fn error_value(result: Result<MigrationResult, EngineError>) -> Value {
    match result {
        Ok(v) => serde_json::to_value(v).unwrap(),
        Err(EngineError::MemoryOp(e)) => json!({"error":e.code}),
        Err(e) => panic!("{e}"),
    }
}
#[test]
fn actual_node_marker_sequences_and_required_projected_audit() {
    let g: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/ops/golden/migrate.json")).unwrap();
    for c in g["cases"].as_array().unwrap() {
        let root = root();
        let base = root.path().join("store");
        if c["missing"] != true {
            fs::create_dir(&base).unwrap();
            if c["noMarker"] == true {
                fs::write(base.join("sentinel"), "unchanged").unwrap()
            } else if c["markerDirectory"] == true {
                fs::create_dir(base.join("_schema.json")).unwrap()
            } else {
                fs::write(
                    base.join("_schema.json"),
                    c["raw"].as_str().map(str::to_owned).unwrap_or_else(|| {
                        json!({"schemaVersion":c.get("schema").unwrap_or(&json!("0"))}).to_string()
                    }),
                )
                .unwrap();
            }
        }
        let audit = Arc::new(Audit::default());
        let now = g["now"].as_i64().unwrap();
        let migrator = SchemaMigrator::new(
            base.clone(),
            g["engineVersion"].as_str().unwrap().into(),
            Arc::new(move || now),
            audit.clone(),
        );
        let grant = MaintenanceGrant::for_test(Cancel::never());
        let cancel = Cancel::never();
        let mut pairs = vec![(
            c["from"].as_str().unwrap_or("0"),
            c["to"].as_str().unwrap_or("1"),
        )];
        if c["repeat"] == true {
            pairs.extend([("0", "1"), ("1", "1")]);
        }
        let results = pairs
            .iter()
            .map(|(from, to)| {
                error_value(migrator.migrate(
                    &grant,
                    (*from).to_owned().into(),
                    (*to).to_owned().into(),
                    &cancel,
                ))
            })
            .collect::<Vec<_>>();
        assert_eq!(results, *c["results"].as_array().unwrap(), "{}", c["name"]);
        let marker = fs::read_to_string(base.join("_schema.json")).ok();
        assert_eq!(json!(marker), c["marker"], "{} marker", c["name"]);
        assert_eq!(
            json!(crate::ops::status::schema_version(&base)),
            c["current"],
            "{} version",
            c["name"]
        );
        assert_eq!(audit.entries.lock().unwrap().len(), pairs.len());
        for (entry, (from, to)) in audit.entries.lock().unwrap().iter().zip(&pairs) {
            assert_eq!(entry["method"], "engine.admin.migrate");
            assert_eq!(entry["coreLink"], "test-core-link");
            assert_eq!(entry["actor"], "core-maintenance");
            let target = if digits(from) && digits(to) {
                json!({"from":from,"to":to})
            } else {
                json!({"invalid":true})
            };
            assert_eq!(entry["target"], target);
            assert_eq!(entry.as_object().unwrap().len(), 6);
        }
        if c["noMarker"] == true {
            assert_eq!(
                fs::read_to_string(base.join("sentinel")).unwrap(),
                "unchanged"
            )
        }
        assert!(!base.join("_schema-migrate.lock").exists());
    }
}
#[test]
fn revoked_grant_and_failed_audit_cannot_write_a_marker() {
    let root = root();
    let base = root.path().join("store");
    let audit = Arc::new(Audit::default());
    let m = SchemaMigrator::new(
        base.clone(),
        "synthetic-engine".into(),
        Arc::new(|| 1800000000000),
        audit.clone(),
    );
    let connection = Cancel::never();
    let grant = MaintenanceGrant::for_test(connection.clone());
    connection.cancel();
    assert!(matches!(
        m.migrate(
            &grant,
            "0".to_owned().into(),
            "1".to_owned().into(),
            &Cancel::never()
        ),
        Err(EngineError::Cancelled(_))
    ));
    assert!(!base.exists());
    assert!(audit.entries.lock().unwrap().is_empty());
    audit.fail.store(true, Ordering::SeqCst);
    let grant = MaintenanceGrant::for_test(Cancel::never());
    assert_eq!(
        error_value(m.migrate(
            &grant,
            "0".to_owned().into(),
            "1".to_owned().into(),
            &Cancel::never()
        )),
        json!({"error":"storage"})
    );
    assert!(!base.exists());
}
#[test]
fn independent_migrators_do_not_both_apply_stale_source_versions() {
    let root = root();
    let base = root.path().join("store");
    fs::create_dir(&base).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = vec![];
    for _ in 0..2 {
        let base = base.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let m = SchemaMigrator::new(
                base,
                "synthetic-engine".into(),
                Arc::new(|| 1800000000000),
                Arc::new(Audit::default()),
            );
            barrier.wait();
            error_value(m.migrate(
                &MaintenanceGrant::for_test(Cancel::never()),
                "0".to_owned().into(),
                "1".to_owned().into(),
                &Cancel::never(),
            ))
        }));
    }
    let results = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r["applied"] == true).count(), 1);
    assert!(results
        .iter()
        .filter(|r| r["applied"] != true)
        .all(|r| r["error"] == "conflict" || r["error"] == "lock-busy"));
    assert_eq!(
        crate::ops::status::schema_version(&base).as_deref(),
        Some("1")
    );
    assert!(!base.join("_schema-migrate.lock").exists());
}
#[test]
fn native_audit_is_durable_and_does_not_claim_a_person() {
    let root = root();
    let audit = root.path().join("audit/maintenance.jsonl");
    let m = SchemaMigrator::new(
        root.path().join("store"),
        "synthetic-engine".into(),
        Arc::new(|| 1800000000000),
        Arc::new(FileMaintenanceAudit::new(audit.clone())),
    );
    m.migrate(
        &MaintenanceGrant::for_test(Cancel::never()),
        "0".to_owned().into(),
        "1".to_owned().into(),
        &Cancel::never(),
    )
    .unwrap();
    let text = fs::read_to_string(audit).unwrap();
    let entries = text
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["actor"], "core-maintenance");
    assert!(entries[0].get("principal").is_none());
    assert!(entries[0].get("request").is_none());
}

#[test]
fn cancellation_or_lost_nonce_before_marker_commit_preserves_source() {
    use std::sync::atomic::AtomicUsize;
    for lose_nonce in [false, true] {
        let root = root();
        let base = root.path().join("store");
        fs::create_dir(&base).unwrap();
        let marker = base.join("_schema.json");
        fs::write(&marker, "{\"schemaVersion\":\"0\"}").unwrap();
        let before = fs::read(&marker).unwrap();
        let calls = AtomicUsize::new(0);
        let cancel = Cancel::never();
        let during_write = cancel.clone();
        let lock_path = base.join("_schema-migrate.lock");
        let replacement = lock_path.clone();
        let clock = Arc::new(move || {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                if lose_nonce {
                    fs::write(&replacement, "{\"nonce\":\"foreign\"}").unwrap();
                } else {
                    during_write.cancel();
                }
            }
            1800000000000
        });
        let migrator = SchemaMigrator::new(
            base,
            "synthetic-engine".into(),
            clock,
            Arc::new(Audit::default()),
        );
        let result = migrator.migrate(
            &MaintenanceGrant::for_test(Cancel::never()),
            "0".to_owned().into(),
            "1".to_owned().into(),
            &cancel,
        );
        if lose_nonce {
            assert_eq!(error_value(result), json!({"error":"lock-lost"}));
            assert_eq!(
                fs::read_to_string(lock_path).unwrap(),
                "{\"nonce\":\"foreign\"}"
            );
        } else {
            assert!(matches!(result, Err(EngineError::Cancelled(_))));
            assert!(!lock_path.exists());
        }
        assert_eq!(fs::read(marker).unwrap(), before);
    }
}
