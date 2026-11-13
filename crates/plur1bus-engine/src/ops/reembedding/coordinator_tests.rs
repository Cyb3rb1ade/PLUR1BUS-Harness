#![allow(clippy::unwrap_used, reason = "actual Node coordinator fixtures")]
use super::super::coordinator_ports::*;
use super::*;
use crate::contract::{EmbedKind, EngineError, VectorSpaceIdentity};
use serde_json::Value;
#[derive(Default)]
struct Live {
    calls: Vec<String>,
    target: Vec<Json>,
    now: i64,
    version: String,
    config: String,
    policy: JsonBox,
    bad_readback: bool,
    bad_provider: bool,
    provider_close_fails: bool,
    backend_close_fails: bool,
    wrong_identity: bool,
    validation_mode: String,
    queries: usize,
    axes: BTreeMap<String, usize>,
    semantic: bool,
    created: bool,
    crashed: bool,
}
#[derive(Default)]
struct JsonBox(Option<Json>);
struct Boundary {
    case: Json,
    live: Arc<Mutex<Live>>,
    real_backend: Option<Arc<super::super::backend::GenerationBackend>>,
}
fn f<'a>(v: &'a Json, k: &str) -> &'a Json {
    field(v, k).unwrap()
}
fn s(v: &Json, k: &str) -> String {
    get_text(v, k).unwrap()
}
fn yes(v: &Json, k: &str) -> bool {
    field(v, k) == Some(&Json::Bool(true))
}
impl Boundary {
    fn call(&self, name: &str) {
        self.live.lock().unwrap().calls.push(name.into());
    }
}
impl CopyBackend for Boundary {
    fn inventory(&self, _: &Cancel) -> Result<Vec<Json>, BackendError> {
        self.call("inventory");
        let live = self.live.lock().unwrap();
        Ok(vec![obj(vec![
            ("generation", string("active")),
            ("configRevision", string(&live.config)),
            ("fingerprint", f(&self.case, "sourceFingerprint").clone()),
            (
                "tables",
                Json::Array(vec![obj(vec![
                    ("tableId", string("agent-a/memories")),
                    ("version", string(&live.version)),
                    (
                        "rowCount",
                        number(array(f(&self.case, "sourceRows")).unwrap().len() as u64),
                    ),
                    ("estimatedBytes", number(1000)),
                    ("dimensions", number(3)),
                ])]),
            ),
        ])])
    }
    fn create_target(&self, _: &Json, _: &Cancel) -> Result<(), BackendError> {
        self.call("create-target");
        let mut l = self.live.lock().unwrap();
        if l.created {
            return Err(BackendError::Exists);
        }
        l.created = true;
        Ok(())
    }
    fn describe(&self, _: &str, _: &Cancel) -> Result<Json, BackendError> {
        Ok(obj(vec![
            ("generation", string("target")),
            ("dimensions", number(3)),
        ]))
    }
    fn read_source(
        &self,
        _: &str,
        offset: usize,
        limit: usize,
        _: &Cancel,
    ) -> Result<Vec<Json>, BackendError> {
        self.call("source-batch");
        Ok(array(f(&self.case, "sourceRows"))
            .unwrap()
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect())
    }
    fn write_target(
        &self,
        _: &str,
        _: &str,
        rows: &[Json],
        _: &Cancel,
    ) -> Result<(), BackendError> {
        self.call("write-target");
        let mut l = self.live.lock().unwrap();
        for row in rows {
            if !l
                .target
                .iter()
                .any(|r| get_text(r, "id") == get_text(row, "id"))
            {
                l.target.push(row.clone());
            }
        }
        if yes(&self.case, "policyAfterWrite") {
            l.policy.0 = Some(obj(vec![("revision", number(2))]));
        }
        if yes(&self.case, "crashAfterWrite") && !l.crashed {
            l.crashed = true;
            return Err(BackendError::Storage);
        }
        Ok(())
    }
    fn read_target(
        &self,
        _: &str,
        _: &str,
        ids: &[String],
        _: &Cancel,
    ) -> Result<Vec<Json>, BackendError> {
        self.call("readback");
        let l = self.live.lock().unwrap();
        Ok(ids
            .iter()
            .filter_map(|id| {
                l.target
                    .iter()
                    .find(|r| get_text(r, "id").as_ref() == Some(id))
                    .cloned()
            })
            .map(|mut r| {
                if l.bad_readback {
                    put(&mut r, "text", string("corrupted synthetic readback")).unwrap();
                }
                r
            })
            .collect())
    }
    fn validate(&self, _: &str, _: &Cancel) -> Result<Json, BackendError> {
        self.call("validate-generation");
        let count = self.live.lock().unwrap().target.len();
        if count != array(f(&self.case, "sourceRows")).unwrap().len() {
            return Err(BackendError::Drift);
        }
        Ok(obj(vec![
            ("tables", number(1)),
            ("rows", number(count as u64)),
            ("dimensions", number(3)),
        ]))
    }
    fn close(&self) -> Result<(), BackendError> {
        self.call("close-backend");
        if self.live.lock().unwrap().backend_close_fails {
            return Err(BackendError::Storage);
        }
        Ok(())
    }
}
struct Provider {
    live: Arc<Mutex<Live>>,
    identity: VectorSpaceIdentity,
}
impl MigrationProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f64>>, CoordinatorError> {
        let mut l = self.live.lock().unwrap();
        l.calls.push("embed".into());
        if !l.validation_mode.is_empty() {
            if matches!(kind, EmbedKind::Query) {
                l.queries += 1;
                if l.validation_mode == "error" {
                    return Err(CoordinatorError::Provider);
                }
                if l.validation_mode == "miss" {
                    return Ok(texts
                        .iter()
                        .map(|text| {
                            let others = l
                                .axes
                                .iter()
                                .filter(|(t, _)| *t != text)
                                .map(|(_, a)| *a)
                                .collect::<Vec<_>>();
                            (0..8)
                                .map(|i| {
                                    if others.contains(&i) {
                                        1.0 / (others.len() as f64).sqrt()
                                    } else {
                                        0.0
                                    }
                                })
                                .collect()
                        })
                        .collect());
                }
            }
            return Ok(texts
                .iter()
                .map(|text| {
                    let next = l.axes.len();
                    let axis = *l.axes.entry(text.clone()).or_insert(next);
                    (0..8)
                        .map(|i| {
                            if i == if l.validation_mode == "miss" { axis } else { 0 } {
                                1.0
                            } else {
                                0.0
                            }
                        })
                        .collect()
                })
                .collect());
        }
        Ok(if l.bad_provider {
            vec![]
        } else {
            texts.iter().map(|_| vec![0.25, 0.5, 0.75]).collect()
        })
    }
    fn close(&self) -> Result<(), CoordinatorError> {
        self.live
            .lock()
            .unwrap()
            .calls
            .push("close-provider".into());
        if self.live.lock().unwrap().provider_close_fails {
            return Err(CoordinatorError::Provider);
        }
        Ok(())
    }
}
impl MigrationRuntime for Boundary {
    fn now_ms(&self) -> i64 {
        self.live.lock().unwrap().now
    }
    fn free_bytes(&self, _: &Cancel) -> Result<u64, CoordinatorError> {
        self.call("disk");
        Ok(1000000)
    }
    fn artifacts_verified(&self, _: &Json, _: &Cancel) -> Result<bool, CoordinatorError> {
        unreachable!("remote fixture has no artifact inspection")
    }
    fn plan_probe(&self, _: &Json, _: &Cancel) -> Result<Vec<f64>, CoordinatorError> {
        self.call("plan-probe");
        if !self.live.lock().unwrap().validation_mode.is_empty() {
            return Ok(vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        }
        Ok(vec![0.25, 0.5, 0.75])
    }
    fn create_provider(
        &self,
        target: &Json,
        _: &Cancel,
    ) -> Result<Box<dyn MigrationProvider>, CoordinatorError> {
        self.call("provider");
        let mut value: Value = serde_json::from_str(&write_json(f(target, "fingerprint"))).unwrap();
        if self.live.lock().unwrap().wrong_identity {
            value["model"] = serde_json::json!("synthetic-wrong-model");
        }
        let identity = crate::embedding::identity::identity_from_value(&value).unwrap();
        Ok(Box::new(Provider {
            live: self.live.clone(),
            identity,
        }))
    }
    fn policy_snapshot(&self, _: &Cancel) -> Result<Option<Json>, CoordinatorError> {
        self.call("policy");
        Ok(self.live.lock().unwrap().policy.0.clone())
    }
    fn validate_probes(
        &self,
        record: &Json,
        provider: &dyn MigrationProvider,
        cancel: &Cancel,
    ) -> Result<Json, CoordinatorError> {
        self.call("validation-probe");
        if let Some(backend) = &self.real_backend {
            let value = super::super::validation::validate(record, backend, provider, cancel)?;
            return parse_json(&value.to_string()).map_err(|_| CoordinatorError::Host);
        }
        Ok(obj(vec![(
            "semanticRecall",
            Json::Bool(self.live.lock().unwrap().semantic),
        )]))
    }
}
#[derive(Default)]
struct Audit {
    rows: Mutex<Vec<Value>>,
    fail: AtomicBool,
}
impl MaintenanceAudit for Audit {
    fn append(&self, v: &Value) -> Result<(), EngineError> {
        if self.fail.load(Ordering::Acquire) {
            return Err(crate::ops::context::error(
                crate::contract::MemoryOpErrorCode::Storage,
            ));
        }
        self.rows.lock().unwrap().push(v.clone());
        Ok(())
    }
}
fn fixture() -> Json {
    parse_json(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-coordinator.json"
    ))
    .unwrap()
}
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn normalized(value: &Json) -> Json {
    fn scrub(v: &mut Json) {
        match v {
            Json::Object(items) => {
                for (key, v) in items {
                    if *key == crate::text::js::JsString::from("tokenHash") {
                        *v = string("[fresh OS proof hash]");
                    } else {
                        scrub(v);
                    }
                }
            }
            Json::Array(items) => {
                for v in items {
                    scrub(v);
                }
            }
            _ => {}
        }
    }
    let mut v = normalize(value, 0).unwrap();
    scrub(&mut v);
    v
}
fn setup(
    case: &Json,
    path: &std::path::Path,
) -> (ReembeddingCoordinator, Arc<Boundary>, Arc<Audit>) {
    let live = Arc::new(Mutex::new(Live {
        now: 1000,
        version: "7".into(),
        config: "config-a".into(),
        policy: JsonBox(Some(obj(vec![("revision", number(1))]))),
        semantic: true,
        ..Default::default()
    }));
    let boundary = Arc::new(Boundary {
        case: case.clone(),
        live,
        real_backend: None,
    });
    let audit = Arc::new(Audit::default());
    let mut limits = field(case, "limits")
        .cloned()
        .unwrap_or_else(|| obj(vec![]));
    put(&mut limits, "batchSize", number(1)).unwrap();
    let coordinator = ReembeddingCoordinator::new(
        Arc::new(MigrationStateStore::new(path).unwrap()),
        boundary.clone(),
        boundary.clone(),
        audit.clone(),
        MigrationLimits::from_json(&limits).unwrap(),
    );
    (coordinator, boundary, audit)
}
#[test]
fn twenty_actual_node_coordinator_scenarios_match_durable_progress_and_calls() {
    let fixtures = fixture();
    let cases = array(f(&fixtures, "cases")).unwrap();
    assert_eq!(cases.len(), 20);
    for case in cases {
        let name = s(case, "name");
        let root = root();
        let (coordinator, boundary, audit) = setup(case, root.path());
        let grant = MaintenanceGrant::for_test(Cancel::never());
        let cancel = Cancel::never();
        let mut proof = String::new();
        for (step, expected) in array(f(case, "ops"))
            .unwrap()
            .iter()
            .zip(array(f(case, "results")).unwrap())
        {
            let op = if matches!(step, Json::String(_)) {
                obj(vec![("op", step.clone())])
            } else {
                step.clone()
            };
            let operation = s(&op, "op");
            {
                let mut l = boundary.live.lock().unwrap();
                if let Some(v) = field(&op, "now").and_then(integer) {
                    l.now = v as i64;
                }
                if let Some(v) = get_text(&op, "version") {
                    l.version = v;
                }
                if let Some(v) = get_text(&op, "configRevision") {
                    l.config = v;
                }
                if let Some(v) = field(&op, "policy") {
                    l.policy.0 = Some(v.clone());
                }
                if field(&op, "badReadback").is_some() {
                    l.bad_readback = yes(&op, "badReadback");
                }
                if field(&op, "badProvider").is_some() {
                    l.bad_provider = yes(&op, "badProvider");
                }
                if field(&op, "semanticRecall").is_some() {
                    l.semantic = yes(&op, "semanticRecall");
                }
            }
            let start = boundary.live.lock().unwrap().calls.len();
            let token = if yes(&op, "wrongProof") {
                "invalid-proof"
            } else {
                &proof
            };
            let result = match operation.as_str() {
                "plan" => coordinator
                    .plan(&grant, f(case, "request"), &cancel)
                    .map(|p| {
                        proof = p.plan().confirmation().expose_token().into();
                        let metadata =
                            serde_json::to_value(p.plan().confirmation().persisted()).unwrap();
                        assert!(confirmation::verify_binding(&proof, &metadata));
                        obj(vec![
                            ("plan", p.plan().plan().clone()),
                            ("planDigest", string(p.plan().digest())),
                            ("record", p.record().clone()),
                        ])
                    }),
                "apply" => coordinator.apply(&grant, "migration-a", token, &cancel),
                "resume" => coordinator.resume(&grant, "migration-a", token, &cancel),
                "validate" => coordinator.validate(&grant, "migration-a", &cancel),
                "status" => coordinator
                    .status(&grant, "migration-a", &cancel)
                    .map(|v| v.unwrap_or(Json::Null)),
                "shutdown" => coordinator.shutdown().map(|()| Json::Null),
                _ => unreachable!("unknown recorded action"),
            };
            match result {
                Ok(v) => assert_eq!(
                    normalized(&v),
                    normalized(f(expected, "value")),
                    "{name}: {operation} value"
                ),
                Err(e) => {
                    assert!(
                        field(expected, "error").is_some(),
                        "{name}: {operation}: {e:?}"
                    );
                    if let CoordinatorError::Invalid(category) = e {
                        assert!(
                            s(expected, "error").starts_with(category),
                            "{name}: {e:?} vs {}",
                            s(expected, "error")
                        );
                    }
                }
            }
            let calls = boundary.live.lock().unwrap().calls[start..].to_vec();
            let expected_calls = array(f(expected, "calls"))
                .unwrap()
                .iter()
                .map(|v| super::super::state_json::text(v).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(calls, expected_calls, "{name}: {operation} calls");
            assert_eq!(
                normalized(
                    &coordinator
                        .state
                        .get("migration-a")
                        .unwrap()
                        .unwrap_or(Json::Null)
                ),
                normalized(f(expected, "state")),
                "{name}: {operation} state"
            );
            assert_eq!(
                normalized(&Json::Array(boundary.live.lock().unwrap().target.clone())),
                normalized(f(expected, "target")),
                "{name}: {operation} target"
            );
        }
        for entry in audit.rows.lock().unwrap().iter() {
            assert_eq!(entry["actor"], "core-maintenance");
            assert_eq!(entry["coreLink"], "test-core-link");
            assert!(!entry.to_string().contains(&proof));
            assert!(!entry.to_string().contains("alpha"));
        }
        coordinator.shutdown().unwrap();
    }
}
#[test]
fn revoked_grants_audit_failure_and_exclusive_admission_prevent_work() {
    let fixtures = fixture();
    let case = &array(f(&fixtures, "cases")).unwrap()[0];
    let root = root();
    let (coordinator, boundary, audit) = setup(case, root.path());
    let revoke = Cancel::never();
    let grant = MaintenanceGrant::for_test(revoke.clone());
    revoke.cancel();
    assert_eq!(
        coordinator
            .plan(&grant, f(case, "request"), &Cancel::never())
            .unwrap_err(),
        CoordinatorError::Cancelled
    );
    assert!(audit.rows.lock().unwrap().is_empty());
    assert!(boundary.live.lock().unwrap().calls.is_empty());
    let grant = MaintenanceGrant::for_test(Cancel::never());
    audit.fail.store(true, Ordering::Release);
    assert_eq!(
        coordinator
            .plan(&grant, f(case, "request"), &Cancel::never())
            .unwrap_err(),
        CoordinatorError::Audit
    );
    assert!(boundary.live.lock().unwrap().calls.is_empty());
    assert!(!root.path().join("control").exists());
    audit.fail.store(false, Ordering::Release);
    let held = coordinator.operation.lock().unwrap();
    assert_eq!(
        coordinator
            .plan(&grant, f(case, "request"), &Cancel::never())
            .unwrap_err(),
        CoordinatorError::Busy
    );
    drop(held);
    assert!(boundary.live.lock().unwrap().calls.is_empty());
    assert_eq!(audit.rows.lock().unwrap().len(), 1);
}

#[test]
fn provider_rotation_cleanup_identity_and_shutdown_are_fail_closed() {
    let fixtures = fixture();
    let case = &array(f(&fixtures, "cases")).unwrap()[0];
    let root = root();
    let (coordinator, boundary, _) = setup(case, root.path());
    let grant = MaintenanceGrant::for_test(Cancel::never());
    let cancel = Cancel::never();
    let planned = coordinator
        .plan(&grant, f(case, "request"), &cancel)
        .unwrap();
    let record = planned.record();
    let mut cache = None;
    boundary.live.lock().unwrap().wrong_identity = true;
    assert!(matches!(
        coordinator.provider(record, &mut cache, &grant, &cancel),
        Err(CoordinatorError::Invalid(
            "target embedding provider identity mismatch"
        ))
    ));
    assert!(cache.is_none());
    assert!(boundary
        .live
        .lock()
        .unwrap()
        .calls
        .ends_with(&["provider".into(), "close-provider".into()]));
    boundary.live.lock().unwrap().wrong_identity = false;
    coordinator
        .provider(record, &mut cache, &grant, &cancel)
        .unwrap();
    let mut replacement = record.clone();
    put(&mut replacement, "planDigest", string(&"b".repeat(64))).unwrap();
    boundary.live.lock().unwrap().provider_close_fails = true;
    let start = boundary.live.lock().unwrap().calls.len();
    assert!(matches!(
        coordinator.provider(&replacement, &mut cache, &grant, &cancel),
        Err(CoordinatorError::Provider)
    ));
    assert_eq!(
        &boundary.live.lock().unwrap().calls[start..],
        ["close-provider"]
    );
    assert_eq!(cache.as_ref().unwrap().digest, s(record, "planDigest"));
    boundary.live.lock().unwrap().provider_close_fails = false;
    coordinator
        .provider(&replacement, &mut cache, &grant, &cancel)
        .unwrap();
    assert!(boundary
        .live
        .lock()
        .unwrap()
        .calls
        .ends_with(&["close-provider".into(), "provider".into()]));
    coordinator.operation.lock().unwrap().provider = cache;
    {
        let mut live = boundary.live.lock().unwrap();
        live.provider_close_fails = true;
        live.backend_close_fails = true;
    }
    let start = boundary.live.lock().unwrap().calls.len();
    assert_eq!(
        coordinator.shutdown(),
        Err(CoordinatorError::Cleanup {
            provider: true,
            backend: true
        })
    );
    assert_eq!(
        &boundary.live.lock().unwrap().calls[start..],
        ["close-provider", "close-backend"]
    );
    coordinator.shutdown().unwrap();
    assert_eq!(
        &boundary.live.lock().unwrap().calls[start..],
        ["close-provider", "close-backend"]
    );
    assert_eq!(
        coordinator
            .apply(
                &grant,
                "migration-a",
                planned.plan().confirmation().expose_token(),
                &cancel
            )
            .unwrap_err(),
        CoordinatorError::Closed
    );
}
#[test]
fn shutdown_waits_for_the_active_operation_before_releasing_resources() {
    let fixtures = fixture();
    let case = &array(f(&fixtures, "cases")).unwrap()[0];
    let root = root();
    let (coordinator, boundary, _) = setup(case, root.path());
    let coordinator = Arc::new(coordinator);
    let active = coordinator.operation.lock().unwrap();
    let other = coordinator.clone();
    let shutdown = std::thread::spawn(move || other.shutdown());
    let deadline = Instant::now() + Duration::from_secs(5);
    while !coordinator.closing.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(boundary.live.lock().unwrap().calls.is_empty());
    assert!(matches!(
        coordinator.exclusive(),
        Err(CoordinatorError::Closed)
    ));
    drop(active);
    shutdown.join().unwrap().unwrap();
    assert_eq!(boundary.live.lock().unwrap().calls, ["close-backend"]);
}

/// Fault at the real durable-write boundary, before coordinator readback/cursor commit.
struct InterruptedBackend {
    backend: Arc<super::super::backend::GenerationBackend>,
    interrupt: AtomicBool,
}
impl CopyBackend for InterruptedBackend {
    fn inventory(&self, c: &Cancel) -> Result<Vec<Json>, BackendError> {
        CopyBackend::inventory(self.backend.as_ref(), c)
    }
    fn create_target(&self, r: &Json, c: &Cancel) -> Result<(), BackendError> {
        CopyBackend::create_target(self.backend.as_ref(), r, c)
    }
    fn describe(&self, g: &str, c: &Cancel) -> Result<Json, BackendError> {
        CopyBackend::describe(self.backend.as_ref(), g, c)
    }
    fn read_source(
        &self,
        t: &str,
        o: usize,
        l: usize,
        c: &Cancel,
    ) -> Result<Vec<Json>, BackendError> {
        CopyBackend::read_source(self.backend.as_ref(), t, o, l, c)
    }
    fn write_target(&self, g: &str, t: &str, r: &[Json], c: &Cancel) -> Result<(), BackendError> {
        CopyBackend::write_target(self.backend.as_ref(), g, t, r, c)?;
        if self.interrupt.swap(false, Ordering::AcqRel) {
            return Err(BackendError::Storage);
        }
        Ok(())
    }
    fn read_target(
        &self,
        g: &str,
        t: &str,
        ids: &[String],
        c: &Cancel,
    ) -> Result<Vec<Json>, BackendError> {
        CopyBackend::read_target(self.backend.as_ref(), g, t, ids, c)
    }
    fn validate(&self, g: &str, c: &Cancel) -> Result<Json, BackendError> {
        CopyBackend::validate(self.backend.as_ref(), g, c)
    }
    fn close(&self) -> Result<(), BackendError> {
        self.backend.close()
    }
}
fn copy_fixture(source: &std::path::Path, dest: &std::path::Path) {
    std::fs::create_dir_all(dest).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = dest.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_fixture(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}
fn file_hashes(root: &std::path::Path) -> BTreeMap<PathBuf, String> {
    use sha2::{Digest, Sha256};
    fn visit(root: &std::path::Path, p: &std::path::Path, out: &mut BTreeMap<PathBuf, String>) {
        for e in std::fs::read_dir(p).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                visit(root, &e.path(), out);
            } else {
                out.insert(
                    e.path().strip_prefix(root).unwrap().to_owned(),
                    format!("{:x}", Sha256::digest(std::fs::read(e.path()).unwrap())),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}
#[test]
fn fresh_coordinator_replays_a_real_lance_write_without_duplicates_or_source_changes() {
    use super::super::backend::{BackendConfig, GenerationBackend};
    let root = root();
    let active = root.path().join("active");
    copy_fixture(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ops/reembedding-stores/exact-replay"),
        &active.join("agent-a"),
    );
    let before = file_hashes(&active);
    let fixtures = fixture();
    let case = &array(f(&fixtures, "cases")).unwrap()[0];
    let state_root = root.path().join("state");
    let cancel = Cancel::never();
    let grant = MaintenanceGrant::for_test(Cancel::never());
    let build = |interrupt| {
        let backend = Arc::new(
            GenerationBackend::new(BackendConfig {
                state_root: state_root.clone(),
                active_root: active.clone(),
                active_shared_base: active.clone(),
                namespace: None,
                active_generation: "active".into(),
                active_selection: serde_json::json!({"mode":"generation","generation":"active"}),
                active_fingerprint: serde_json::from_str(&write_json(f(case, "sourceFingerprint")))
                    .unwrap(),
                active_secret_ref: None,
                config_revision: None,
            })
            .unwrap(),
        );
        let runtime = Arc::new(Boundary {
            case: case.clone(),
            live: Arc::new(Mutex::new(Live {
                now: 1000,
                semantic: true,
                ..Default::default()
            })),
            real_backend: Some(backend.clone()),
        });
        let coordinator = ReembeddingCoordinator::new(
            Arc::new(MigrationStateStore::new(&state_root).unwrap()),
            Arc::new(InterruptedBackend {
                backend: backend.clone(),
                interrupt: AtomicBool::new(interrupt),
            }),
            runtime,
            Arc::new(Audit::default()),
            MigrationLimits::default(),
        );
        (coordinator, backend)
    };
    let (first, backend) = build(true);
    let plan = first.plan(&grant, f(case, "request"), &cancel).unwrap();
    let proof = plan.plan().confirmation().expose_token().to_owned();
    assert_eq!(
        first.apply(&grant, "migration-a", &proof, &cancel),
        Err(CoordinatorError::Backend(BackendError::Storage))
    );
    let saved = first
        .status(&grant, "migration-a", &cancel)
        .unwrap()
        .unwrap();
    assert_eq!(s(&saved, "state"), "running");
    assert_eq!(integer(f(f(&saved, "cursor"), "completedRows")), Some(0));
    assert_eq!(
        backend.describe("target", &cancel).unwrap()["tables"]["agent-a/memories"]["writtenRows"],
        1
    );
    first.shutdown().unwrap();
    drop(first);
    drop(backend);
    let (second, backend) = build(false);
    assert_eq!(
        s(
            &second
                .resume(&grant, "migration-a", &proof, &cancel)
                .unwrap(),
            "state"
        ),
        "validating"
    );
    let ready = second.validate(&grant, "migration-a", &cancel).unwrap();
    assert_eq!(s(&ready, "state"), "ready_to_switch");
    assert_eq!(integer(f(f(&ready, "cursor"), "completedRows")), Some(1));
    assert_eq!(backend.validate("target", &cancel).unwrap()["rows"], 1);
    assert_eq!(file_hashes(&active), before);
    second.shutdown().unwrap();
}

#[test]
fn migration_started_and_written_by_actual_node_resumes_in_rust() {
    use super::super::backend::{BackendConfig, GenerationBackend};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let root = root();
    let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ops/reembedding-coordinator-store");
    copy_fixture(&fixture_path, root.path());
    let active = root.path().join("active");
    let before = file_hashes(&active);
    let fixtures = fixture();
    let case = &array(f(&fixtures, "cases")).unwrap()[0];
    let state_root = root.path().join("state");
    let backend = Arc::new(
        GenerationBackend::new(BackendConfig {
            state_root: state_root.clone(),
            active_root: active.clone(),
            active_shared_base: active,
            namespace: None,
            active_generation: "active".into(),
            active_selection: serde_json::json!({"mode":"generation","generation":"active"}),
            active_fingerprint: serde_json::from_str(&write_json(f(case, "sourceFingerprint")))
                .unwrap(),
            active_secret_ref: None,
            config_revision: None,
        })
        .unwrap(),
    );
    let runtime = Arc::new(Boundary {
        case: case.clone(),
        live: Arc::new(Mutex::new(Live {
            now: 1000,
            semantic: true,
            ..Default::default()
        })),
        real_backend: Some(backend.clone()),
    });
    let coordinator = ReembeddingCoordinator::new(
        Arc::new(MigrationStateStore::new(&state_root).unwrap()),
        backend.clone(),
        runtime,
        Arc::new(Audit::default()),
        MigrationLimits::default(),
    );
    let grant = MaintenanceGrant::for_test(Cancel::never());
    let cancel = Cancel::never();
    let node_record = f(f(&fixtures, "restart"), "record");
    assert_eq!(
        normalized(
            &coordinator
                .status(&grant, "migration-a", &cancel)
                .unwrap()
                .unwrap()
        ),
        normalized(node_record)
    );
    let seed = integer(f(f(&fixtures, "restart"), "proofSeed")).unwrap() as u8;
    let proof = format!("reemb_v1_{}", URL_SAFE_NO_PAD.encode([seed; 32]));
    let resumed = coordinator
        .resume(&grant, "migration-a", &proof, &cancel)
        .unwrap();
    assert_eq!(s(&resumed, "state"), "validating");
    assert_eq!(integer(f(f(&resumed, "cursor"), "completedRows")), Some(1));
    let ready = coordinator
        .validate(&grant, "migration-a", &cancel)
        .unwrap();
    assert_eq!(s(&ready, "state"), "ready_to_switch");
    assert_eq!(backend.validate("target", &cancel).unwrap()["rows"], 1);
    assert_eq!(file_hashes(&root.path().join("active")), before);
    coordinator.shutdown().unwrap();
}

#[test]
fn actual_engine_validation_scenarios_match_against_real_lance() {
    use super::super::backend::{BackendConfig, GenerationBackend};
    use crate::store::lance::migration_table::MigrationAccess;
    use arrow_schema::{DataType, Field, Schema};
    let cases: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-validation.json"
    ))
    .unwrap();
    let fixtures = fixture();
    let base = &array(f(&fixtures, "cases")).unwrap()[0];
    for case in cases["cases"].as_array().unwrap() {
        let root = root();
        let active = root.path().join("active");
        let state = root.path().join("state");
        let cancel = Cancel::never();
        let access = MigrationAccess::new().unwrap();
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("text", DataType::Utf8, false),
            Field::new("status", DataType::Utf8, false),
            Field::new(
                "vector",
                DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 3),
                true,
            ),
        ]));
        let source = access
            .create(&active.join("anna"), "memories", schema, &cancel)
            .unwrap();
        let count = case["count"].as_u64().unwrap();
        if count > 0 {
            source.add((0..count).map(|i|serde_json::json!({"id":format!("11111111-1111-4111-8111-{:012}",i),"text":format!("fact {i} about the lighthouse keeper"),"status":"active","vector":[1,0,0]})).collect(),&cancel).unwrap();
        }
        let before = file_hashes(&active);
        let backend = Arc::new(
            GenerationBackend::new(BackendConfig {
                state_root: state.clone(),
                active_root: active.clone(),
                active_shared_base: active.clone(),
                namespace: None,
                active_generation: "active".into(),
                active_selection: serde_json::json!({"mode":"generation","generation":"active"}),
                active_fingerprint: serde_json::from_str(&write_json(f(base, "sourceFingerprint")))
                    .unwrap(),
                active_secret_ref: None,
                config_revision: None,
            })
            .unwrap(),
        );
        let runtime = Arc::new(Boundary {
            case: base.clone(),
            live: Arc::new(Mutex::new(Live {
                now: 1000,
                validation_mode: case["mode"].as_str().unwrap().to_owned(),
                ..Default::default()
            })),
            real_backend: Some(backend.clone()),
        });
        let coordinator = ReembeddingCoordinator::new(
            Arc::new(MigrationStateStore::new(&state).unwrap()),
            backend,
            runtime.clone(),
            Arc::new(Audit::default()),
            MigrationLimits::default(),
        );
        let grant = MaintenanceGrant::for_test(Cancel::never());
        let mut request = f(base, "request").clone();
        let mut target = f(&request, "target").clone();
        let mut fp = f(&target, "fingerprint").clone();
        put(&mut fp, "dimensions", number(8)).unwrap();
        put(&mut target, "fingerprint", fp).unwrap();
        put(&mut request, "target", target).unwrap();
        let plan = coordinator.plan(&grant, &request, &cancel).unwrap();
        let proof = plan.plan().confirmation().expose_token();
        let copied = coordinator
            .apply(&grant, "migration-a", proof, &cancel)
            .unwrap();
        assert_eq!(s(&copied, "state"), "validating");
        let result = coordinator.validate(&grant, "migration-a", &cancel);
        assert_eq!(
            result.is_err(),
            !case["error"].is_null(),
            "{}",
            case["name"]
        );
        let record = coordinator
            .status(&grant, "migration-a", &cancel)
            .unwrap()
            .unwrap();
        assert_eq!(s(&record, "state"), case["state"]);
        assert_eq!(
            runtime.live.lock().unwrap().queries as u64,
            case["queries"].as_u64().unwrap()
        );
        let value: Value = serde_json::from_str(&write_json(&record)).unwrap();
        let v = &value["receipts"]["validation"];
        let projected = if v.is_null() {
            Value::Null
        } else {
            serde_json::json!({"semanticRecall":v["semanticRecall"],"rows":v["rows"],"validationMemoryIdPresent":!v["validationMemoryId"].is_null(),"validationTable":v["validationTable"]})
        };
        assert_eq!(projected, case["validation"], "{}", case["name"]);
        assert_eq!(file_hashes(&active), before);
        coordinator.shutdown().unwrap();
    }
}
