use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Counted(Arc<AtomicUsize>);
impl JobBody for Counted {
    fn name(&self) -> JobName {
        JobName::KnowledgeUpdate
    }
    fn run(&self, _context: &JobContext, _cancel: &Cancel) -> Result<JobReport, EngineError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(JobReport::completed())
    }
}
const SOURCE: &str = r#"{"completed":{"rem:alpha:old":{"completedAt":"2026-01-01"}}}"#;
#[test]
fn configured_legacy_roots_are_migrated_before_body_admission_and_only_once() {
    let root = root();
    let jobs = root.path().join("jobs");
    let legacy = root.path().join("legacy");
    fs::create_dir(&jobs).unwrap();
    fs::create_dir(&legacy).unwrap();
    fs::write(legacy.join("run-state.json"), SOURCE).unwrap();
    let registry = Registry::new(&jobs, Arc::new(|| 1800000000000))
        .unwrap()
        .with_legacy_state_root(&agent(), &legacy)
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    registry.bind(Arc::new(Counted(calls.clone()))).unwrap();
    assert_eq!(fs::read_dir(&jobs).unwrap().count(), 0);
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let rows = registry
        .history(
            &agent(),
            serde_json::from_value(serde_json::json!({})).unwrap(),
        )
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].job, JobName::RemDream);
    assert_eq!(
        fs::read_to_string(legacy.join("run-state.json.migrated")).unwrap(),
        SOURCE
    );
    let receipt_before = fs::read(legacy.join("native-job-migration-alpha.json")).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        fs::read(legacy.join("native-job-migration-alpha.json")).unwrap(),
        receipt_before
    );
}
#[test]
fn failed_migration_never_admits_a_body_and_repair_is_retryable_in_the_same_registry() {
    let root = root();
    let jobs = root.path().join("jobs");
    let legacy = root.path().join("legacy");
    fs::create_dir(&jobs).unwrap();
    fs::create_dir(&legacy).unwrap();
    fs::write(legacy.join("run-state.json"), b"{bad").unwrap();
    let registry = Registry::new(&jobs, Arc::new(|| 1800000000000))
        .unwrap()
        .with_legacy_state_root(&agent(), &legacy)
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    registry.bind(Arc::new(Counted(calls.clone()))).unwrap();
    assert!(registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!jobs.join("alpha/ledger.jsonl").exists());
    fs::write(legacy.join("run-state.json"), SOURCE).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        fs::read(legacy.join("run-state.json.migrated")).unwrap(),
        b"{bad"
    );
}
#[test]
fn dry_run_and_unavailable_jobs_never_start_legacy_migration() {
    let root = root();
    let jobs = root.path().join("jobs");
    let legacy = root.path().join("legacy");
    fs::create_dir(&jobs).unwrap();
    fs::create_dir(&legacy).unwrap();
    fs::write(legacy.join("run-state.json"), SOURCE).unwrap();
    let registry = Registry::new(&jobs, Arc::new(|| 1800000000000))
        .unwrap()
        .with_legacy_state_root(&agent(), &legacy)
        .unwrap();
    assert!(registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never()
        )
        .is_err());
    registry.bind(Arc::new(Completed)).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            serde_json::from_value(serde_json::json!({"dryRun":true})).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(fs::read_dir(&jobs).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&legacy).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(legacy.join("run-state.json")).unwrap(),
        SOURCE
    );
}
#[test]
fn configured_root_replacement_refuses_before_body_or_replacement_state_write() {
    let root = root();
    let jobs = root.path().join("jobs");
    let legacy = root.path().join("legacy");
    fs::create_dir(&jobs).unwrap();
    fs::create_dir(&legacy).unwrap();
    fs::write(legacy.join("run-state.json"), SOURCE).unwrap();
    let registry = Registry::new(&jobs, Arc::new(|| 1800000000000))
        .unwrap()
        .with_legacy_state_root(&agent(), &legacy)
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    registry.bind(Arc::new(Counted(calls.clone()))).unwrap();
    fs::rename(&legacy, root.path().join("held-original")).unwrap();
    fs::create_dir(&legacy).unwrap();
    fs::write(legacy.join("run-state.json"), SOURCE).unwrap();
    assert!(registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read_dir(&legacy).unwrap().count(), 1);
}

#[test]
fn multiple_roots_resume_after_a_later_root_is_repaired() {
    let root = root();
    let jobs = root.path().join("jobs");
    let first = root.path().join("first");
    let second = root.path().join("second");
    for path in [&jobs, &first, &second] {
        fs::create_dir(path).unwrap();
    }
    fs::write(first.join("run-state.json"), SOURCE).unwrap();
    fs::write(second.join("run-state.json"), b"{bad").unwrap();
    let registry = Registry::new(&jobs, Arc::new(|| 1800000000000))
        .unwrap()
        .with_legacy_state_root(&agent(), &first)
        .unwrap()
        .with_legacy_state_root(&agent(), &second)
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    registry.bind(Arc::new(Counted(calls.clone()))).unwrap();
    assert!(registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let first_receipt = fs::read(first.join("native-job-migration-alpha.json")).unwrap();
    fs::write(
        second.join("run-state.json"),
        SOURCE.replace(":old", ":other"),
    )
    .unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        fs::read(first.join("native-job-migration-alpha.json")).unwrap(),
        first_receipt
    );
    let history = registry
        .history(
            &agent(),
            serde_json::from_value(serde_json::json!({})).unwrap(),
        )
        .unwrap();
    assert_eq!(history.len(), 3);
}
#[test]
fn an_absent_legacy_file_is_reconsidered_only_by_a_new_registry_session() {
    let root = root();
    let jobs = root.path().join("jobs");
    let legacy = root.path().join("legacy");
    fs::create_dir(&jobs).unwrap();
    fs::create_dir(&legacy).unwrap();
    let create = || {
        Registry::new(&jobs, Arc::new(|| 1800000000000))
            .unwrap()
            .with_legacy_state_root(&agent(), &legacy)
            .unwrap()
    };
    let registry = create();
    registry.bind(Arc::new(Completed)).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    fs::write(legacy.join("run-state.json"), SOURCE).unwrap();
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(fs::read_dir(&legacy).unwrap().count(), 1);
    registry.close();
    let restarted = create();
    restarted.bind(Arc::new(Completed)).unwrap();
    restarted
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(
        fs::read_to_string(legacy.join("run-state.json.migrated")).unwrap(),
        SOURCE
    );
    assert_eq!(
        restarted
            .history(
                &agent(),
                serde_json::from_value(serde_json::json!({})).unwrap()
            )
            .unwrap()
            .len(),
        4
    );
}
#[cfg(feature = "testkit")]
#[test]
fn interruption_during_startup_migration_retries_before_the_first_body() {
    let root = root();
    let jobs = root.path().join("jobs");
    let legacy = root.path().join("legacy");
    fs::create_dir(&jobs).unwrap();
    fs::create_dir(&legacy).unwrap();
    fs::write(legacy.join("run-state.json"), SOURCE).unwrap();
    let cancel = Cancel::never();
    let cancelled = cancel.clone();
    let registry = Registry::new(&jobs, Arc::new(|| 1800000000000))
        .unwrap()
        .with_legacy_state_root(&agent(), &legacy)
        .unwrap()
        .with_observer(Arc::new(move |phase| {
            if phase == "migration-rows" {
                cancelled.cancel();
            }
        }));
    let calls = Arc::new(AtomicUsize::new(0));
    registry.bind(Arc::new(Counted(calls.clone()))).unwrap();
    assert!(registry
        .run(JobName::KnowledgeUpdate, &agent(), options(), &cancel)
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        fs::read_to_string(legacy.join("run-state.json")).unwrap(),
        SOURCE
    );
    registry
        .run(
            JobName::KnowledgeUpdate,
            &agent(),
            options(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        registry
            .history(
                &agent(),
                serde_json::from_value(serde_json::json!({})).unwrap()
            )
            .unwrap()
            .len(),
        2
    );
}
