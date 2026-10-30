//! Real Node children exercise the private maintenance protocol, process deadlines and durable result proof.
use super::*;
use crate::supervisor::{config, import_records as records, imports::RunRecord, Log};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

const FIXTURE: &str = r#"
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const lines=createInterface({input:process.stdin});
const iterator=lines[Symbol.asyncIterator]();
const first=await iterator.next();
const job=JSON.parse(first.value), scenario=JSON.parse(readFileSync(join(job.home,'scenario.json'))).scenario;
const out=value=>process.stdout.write(JSON.stringify({v:1,runId:job.runId,...value})+'\n');
process.stderr.write('PRIVATE_WORKER_BODY_MUST_NOT_ESCAPE\n');
if(process.argv.length!==3||process.argv[2]!=='--supervised')process.exit(12);
if(scenario==='raw'){process.stdout.write('PRIVATE_WORKER_BODY_MUST_NOT_ESCAPE\n');process.exit(0);}
if(scenario==='oversized'){process.stdout.write('x'.repeat(65537)+'\n');process.exit(0);}
if(scenario==='unknown'){out({type:'request',id:1,method:'arbitrary.exec',params:{body:'PRIVATE_WORKER_BODY_MUST_NOT_ESCAPE'}});setTimeout(()=>process.exit(0),30);}
else if(scenario==='stall'){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 writeFileSync(join(job.home,'descendant.pid'),String(child.pid));
 setInterval(()=>{},1000);
} else if(scenario==='abort'){
 for await(const line of iterator){if(JSON.parse(line).type==='abort'){writeFileSync(join(job.home,'abort-seen'),'yes');process.exit(0);}}
} else {
 const report=JSON.parse(readFileSync(join(job.home,'result.json')));
 if(scenario==='exit-descendant'){
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','ignore']});
  writeFileSync(join(job.home,'descendant.pid'),String(child.pid));
 }
 out({type:'result',...report});
 lines.close();process.stdin.destroy();
 process.exit(report.ok?0:1);
}
"#;

fn family() -> String {
    let catalog: std::collections::BTreeMap<String, Value> = serde_json::from_str(include_str!(
        "../../../../packages/core/src/import/source-catalog.json"
    ))
    .unwrap();
    catalog.into_keys().next().unwrap()
}

struct Fixture {
    _home: tempfile::TempDir,
    layout: Layout,
    shared: Arc<Shared>,
    job: Job,
    node: PathBuf,
    entry: PathBuf,
}

impl Fixture {
    fn new(scenario: &str) -> Self {
        let home = tempfile::tempdir().unwrap();
        let layout = Layout::new(home.path().canonicalize().unwrap());
        records::directory(&layout, &["logs"]).unwrap();
        let shared = Arc::new(Shared {
            maintenance: Default::default(),
            state: Mutex::new(crate::supervisor::test_state()),
            wake: Condvar::new(),
            log: Log::open(&layout.logs().join("supervisor.log"), 1 << 20, 3),
            config: Mutex::new(config::initial(&layout)),
            subscribers: Default::default(),
            out_logs: Mutex::new(Vec::new()),
        });
        let job = Job {
            invocation_id: uuid::Uuid::new_v4().to_string(),
            run_id: uuid::Uuid::new_v4().to_string(),
            plan_id: uuid::Uuid::new_v4().to_string(),
            plan_sha256: "a".repeat(64),
            owner_id: "owner".into(),
            role: "owner".into(),
            source_type: family(),
            mode: "apply".into(),
            attempt: 1,
            preflight_id: None,
            target_sha256: Some("b".repeat(64)),
            migrate_secrets: false,
            automatic_rollback: false,
        };
        imports::persist(
            &shared,
            &layout,
            RunRecord {
                version: 1,
                job: job.clone(),
                run: json!({"runId":job.run_id,"planId":job.plan_id,"sourceType":job.source_type,
                    "state":"queued","attempt":job.attempt,"createdAt":"2026-10-29T00:00:00.000Z",
                    "updatedAt":"2026-10-29T00:00:00.000Z","restored":false,
                    "resumable":false,"rollbackAvailable":false}),
            },
        )
        .unwrap();
        records::write(
            &layout,
            &layout.home.join("scenario.json"),
            &json!({"scenario":scenario}),
        )
        .unwrap();
        let entry = layout.home.join("worker.mjs");
        records::write_bytes(&layout, &entry, FIXTURE.as_bytes()).unwrap();
        let node = crate::supervisor::spawn_secrets::executable(Path::new("node"))
            .expect("pinned Node prerequisite must be installed");
        Self {
            _home: home,
            layout,
            shared,
            job,
            node,
            entry,
        }
    }

    fn run(&self, budget: Duration) -> Result<Value, ExtError> {
        execute(
            &self.shared,
            &self.layout,
            &self.job,
            None,
            (&self.node, &self.entry),
            Instant::now() + budget,
        )
    }

    fn result(&self, value: &Value) {
        records::write(&self.layout, &self.layout.home.join("result.json"), value).unwrap();
    }

    fn checkpoint(&self, phase: &str) -> Value {
        let base = records::directory(
            &self.layout,
            &["imports", &self.job.run_id, "cold-snapshot"],
        )
        .unwrap();
        let manifest = json!({"schema":"import.cold-snapshot/1","runId":self.job.run_id,"roots":[],"config":{"existed":false,"size":0,"sha256":null},"bytes":0});
        records::write(&self.layout, &base.join("manifest.json"), &manifest).unwrap();
        let manifest = fs::read(base.join("manifest.json")).unwrap();
        let journal = json!({"schema":"import.maintenance/1","runId":self.job.run_id,"attempt":1,"phase":phase,
            "snapshotSha256":format!("{:x}",Sha256::digest(&manifest)),"history":[{"attempt":1,"phase":phase,"at":crate::supervisor::iso8601(1_790_000_000_123)}],"secrets":[]});
        records::write(
            &self.layout,
            &base.parent().unwrap().join("maintenance.json"),
            &journal,
        )
        .unwrap();
        let body = b"legacy report body is hashed without supervisor parsing";
        records::write_bytes(
            &self.layout,
            &base.parent().unwrap().join("report.json"),
            body,
        )
        .unwrap();
        json!({"schema":format!("import.{}/1",self.job.source_type),"sha256":format!("{:x}",Sha256::digest(body)),"bytes":body.len()})
    }

    fn private_output(&self, result: &Result<Value, ExtError>) {
        let metadata = match result {
            Ok(value) => value.to_string(),
            Err(error) => format!("{} {}", error.code, error.message),
        };
        assert!(!metadata.contains("PRIVATE_WORKER_BODY_MUST_NOT_ESCAPE"));
        let log = fs::read_to_string(self.layout.logs().join("supervisor.log")).unwrap();
        assert!(!log.contains("PRIVATE_WORKER_BODY_MUST_NOT_ESCAPE"));
    }
}

fn success() -> Value {
    json!({"ok":true,"status":"completed","restored":false,"resumable":false})
}

#[test]
fn a_real_child_cannot_claim_completion_without_a_private_committed_journal_and_report() {
    let fixture = Fixture::new("result");
    fixture.result(&success());
    let result = fixture.run(Duration::from_secs(5));
    assert!(
        result.is_err(),
        "an unproved real child result was accepted"
    );
    fixture.private_output(&result);
}

#[test]
fn malformed_raw_oversized_and_unknown_controls_never_forward_worker_body_or_logs() {
    for scenario in ["raw", "oversized", "unknown"] {
        let fixture = Fixture::new(scenario);
        let result = fixture.run(Duration::from_secs(5));
        assert!(result.is_err());
        fixture.private_output(&result);
    }
}

#[test]
fn a_total_deadline_kills_the_real_worker_and_its_descendant() {
    let fixture = Fixture::new("stall");
    let started = Instant::now();
    assert!(fixture.run(Duration::from_millis(800)).is_err());
    assert!(started.elapsed() < Duration::from_secs(3));
    let pid = fs::read_to_string(fixture.layout.home.join("descendant.pid"))
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    while running(pid) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!running(pid), "owned descendant survived deadline teardown");
}

fn running(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    if fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'))
    }) {
        // PID 1 in containers may retain a terminated orphan; it cannot execute or access source data.
        return false;
    }
    crate::proc::pid_alive(pid)
}

#[test]
fn daemon_stop_uses_its_existing_budget_and_grace_instead_of_a_new_thirty_second_wait() {
    let fixture = Fixture::new("stall");
    {
        let mut state = fixture.shared.lock();
        state.time_scale = 0.02;
        state.stopping = Some(crate::supervisor::StopRequest {
            budget: Duration::from_millis(100),
            requested_at: Instant::now(),
            source: crate::supervisor::StopSource::Rpc,
        });
    }
    let started = Instant::now();
    assert!(fixture.run(Duration::from_secs(5)).is_err());
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "worker overran daemon stop deadline"
    );
}

#[test]
fn the_actual_child_receipt_must_match_the_exact_report_cold_manifest_and_committed_phase() {
    for tamper in ["none", "report", "manifest", "phase", "schema"] {
        let fixture = Fixture::new("result");
        let report = fixture.checkpoint(if tamper == "phase" {
            "applying"
        } else {
            "committed"
        });
        let mut expected = success();
        expected["report"] = report;
        if tamper == "schema" {
            expected["report"]["schema"] = "import.unregistered/1".into();
        }
        fixture.result(&expected);
        let base = fixture
            .layout
            .home
            .join("imports")
            .join(&fixture.job.run_id);
        if tamper == "report" {
            fs::write(base.join("report.json"), b"changed report").unwrap();
        }
        if tamper == "manifest" {
            fs::write(base.join("cold-snapshot/manifest.json"), b"{}").unwrap();
        }
        let result = fixture.run(Duration::from_secs(5));
        assert_eq!(
            result.is_ok(),
            tamper == "none",
            "receipt proof mismatch for {tamper}"
        );
        fixture.private_output(&result);
    }
}

#[test]
fn a_real_nonzero_worker_exit_keeps_the_independently_proven_restored_result() {
    let fixture = Fixture::new("result");
    fixture.checkpoint("restored");
    fixture.result(&json!({"ok":false,"status":"failed","restored":true,"resumable":true,"error":{"code":"E_IMPORT_FAILED","reason":"apply-failed"}}));
    let result = fixture
        .run(Duration::from_secs(5))
        .expect("exit1 with durable restoration must keep the bounded result");
    assert_eq!(result["restored"], true);
    assert_eq!(result["error"]["reason"], "apply-failed");
    let log = fs::read_to_string(fixture.layout.logs().join("supervisor.log")).unwrap();
    let failure: Value = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|entry| entry["msg"] == "import worker failed")
        .expect("worker failures retain their bounded reason in the private supervisor log");
    assert_eq!(failure["runId"], fixture.job.run_id);
    assert_eq!(failure["reason"], "apply-failed");
    assert_eq!(failure["error"], "E_IMPORT_FAILED");
    fixture.private_output(&Ok(result));
}

#[test]
fn worker_failure_logs_never_include_unrecognized_error_codes_or_reasons() {
    let fixture = Fixture::new("result");
    fixture.checkpoint("restored");
    fixture.result(&json!({"ok":false,"status":"failed","restored":true,"resumable":true,
        "error":{"code":"PRIVATE_WORKER_BODY_MUST_NOT_ESCAPE","reason":"PRIVATE_WORKER_BODY_MUST_NOT_ESCAPE"}}));
    let result = fixture
        .run(Duration::from_secs(5))
        .expect("a restored failure retains only protocol-allowlisted metadata");
    assert_eq!(result["error"]["code"], "E_IMPORT_FAILED");
    assert_eq!(result["error"]["reason"], "worker-failed");
    fixture.private_output(&Ok(result));
}

#[test]
fn manual_rollback_refusal_and_crash_are_safe_only_before_rollback_intent_was_durable() {
    let mut fixture = Fixture::new("result");
    fixture.job.mode = "rollback".into();
    let refused = json!({"ok":false,"status":"failed","restored":false,"resumable":false,"error":{"code":"E_CONFLICT","reason":"target-changed"}});
    for phase in ["committed", "restored", "rolling-back", "applying"] {
        fixture.checkpoint(phase);
        let expected = matches!(phase, "committed" | "restored");
        assert_eq!(
            safe_refusal(&fixture.layout, &fixture.job, Some(&refused)),
            expected
        );
        assert_eq!(safe_refusal(&fixture.layout, &fixture.job, None), expected);
    }
    fixture.checkpoint("committed");
    fixture.job.automatic_rollback = true;
    assert!(!safe_refusal(&fixture.layout, &fixture.job, Some(&refused)));
}

#[test]
fn the_real_manual_rollback_target_change_retains_its_closed_conflict_code() {
    let mut fixture = Fixture::new("result");
    fixture.job.mode = "rollback".into();
    fixture.checkpoint("committed");
    fixture.result(&json!({"ok":false,"status":"failed","restored":false,"resumable":false,"error":{"code":"E_CONFLICT","reason":"target-changed"}}));
    let result = fixture.run(Duration::from_secs(5)).unwrap();
    assert_eq!(result["error"]["code"], "E_CONFLICT");
    assert!(safe_refusal(&fixture.layout, &fixture.job, Some(&result)));
}

#[test]
fn a_resumed_apply_refused_before_the_new_attempt_keeps_user_changes_and_the_previous_baseline() {
    let mut fixture = Fixture::new("result");
    fixture.checkpoint("restored");
    fixture.job.attempt = 2;
    let target = fixture.layout.home.join("user-current-state");
    fs::write(&target, b"user changes after rollback").unwrap();
    let base = fixture
        .layout
        .home
        .join("imports")
        .join(&fixture.job.run_id);
    let original = fs::read(base.join("cold-snapshot/manifest.json")).unwrap();
    let refused = json!({"ok":false,"status":"failed","restored":false,"resumable":false,"error":{"code":"E_CONFLICT","reason":"target-changed"}});
    fixture.result(&refused);
    assert!(safe_refusal(&fixture.layout, &fixture.job, Some(&refused)));
    assert!(safe_refusal(&fixture.layout, &fixture.job, None));
    let result = fixture
        .run(Duration::from_secs(5))
        .expect("pre-mutation refusal should retain the closed result");
    assert_eq!(result["error"]["code"], "E_CONFLICT");
    assert_eq!(fs::read(&target).unwrap(), b"user changes after rollback");
    assert_eq!(
        fs::read(base.join("cold-snapshot/manifest.json")).unwrap(),
        original
    );
    fixture.job.attempt = 3;
    assert!(!safe_refusal(&fixture.layout, &fixture.job, None));
}

#[test]
fn an_apply_refusal_is_safe_only_with_no_baseline_or_an_exactly_previous_fully_restored_attempt() {
    let mut fixture = Fixture::new("result");
    fixture.checkpoint("restored");
    let path = fixture
        .layout
        .home
        .join("imports")
        .join(&fixture.job.run_id)
        .join("maintenance.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["secrets"] =
        json!([{"name":"fixture:key","absentBefore":true,"created":true,"removed":false}]);
    records::write(&fixture.layout, &path, &state).unwrap();
    fixture.job.attempt = 2;
    assert!(!safe_refusal(&fixture.layout, &fixture.job, None));
    state["phase"] = "prepared".into();
    state["history"][0]["phase"] = "prepared".into();
    state["secrets"] = json!([]);
    state.as_object_mut().unwrap().remove("snapshotSha256");
    records::write(&fixture.layout, &path, &state).unwrap();
    assert!(safe_refusal(&fixture.layout, &fixture.job, None));
    fixture.job.attempt = 1;
    assert!(safe_refusal(&fixture.layout, &fixture.job, None));
    state["secrets"] =
        json!([{"name":"fixture:key","absentBefore":true,"created":false,"removed":false}]);
    records::write(&fixture.layout, &path, &state).unwrap();
    assert!(!safe_refusal(&fixture.layout, &fixture.job, None));
}

#[test]
fn an_abort_is_delivered_to_the_real_private_stdin_without_changing_the_durable_dirty_journal() {
    let fixture = Fixture::new("abort");
    fixture.checkpoint("applying");
    relock(&fixture.shared.maintenance).abort_requested = true;
    assert!(fixture.run(Duration::from_secs(5)).is_err());
    assert_eq!(
        fs::read_to_string(fixture.layout.home.join("abort-seen")).unwrap(),
        "yes"
    );
    let journal: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .layout
                .home
                .join("imports")
                .join(&fixture.job.run_id)
                .join("maintenance.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(journal["phase"], "applying");
}

#[test]
fn the_fixed_actual_built_import_worker_uses_private_native_controls_and_a_verified_report() {
    let mut fixture = Fixture::new("result");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let revision = relock(&fixture.shared.config).revision.clone().unwrap();
    let output = Command::new(&fixture.node)
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
        ])
        .arg(root.join("packages/core/test/import/native-worker-prepare.mjs"))
        .arg(&fixture.layout.home)
        .arg(revision)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "actual source/plan prerequisite failed"
    );
    assert!(
        output.stderr.is_empty(),
        "actual fixture must not print source diagnostics"
    );
    fixture.job = serde_json::from_slice(&output.stdout).expect("bounded prepared job metadata");
    imports::persist(
        &fixture.shared,
        &fixture.layout,
        RunRecord {
            version: 1,
            job: fixture.job.clone(),
            run: json!({"runId":fixture.job.run_id,"planId":fixture.job.plan_id,
                "sourceType":fixture.job.source_type,"state":"queued","attempt":fixture.job.attempt,
                "createdAt":"2026-10-29T00:00:00.000Z","updatedAt":"2026-10-29T00:00:00.000Z",
                "restored":false,"resumable":false,"rollbackAvailable":false}),
        },
    )
    .unwrap();
    fixture.entry = root.join("packages/core/dist/import.js");
    assert!(
        fixture.entry.is_file(),
        "pnpm --filter @plur1bus/core build is a required test prerequisite"
    );
    let result = fixture
        .run(Duration::from_secs(45))
        .expect("actual fixed dist worker and native controls must complete");
    assert_eq!(result["ok"], true);
    assert_eq!(result["status"], "completed");
    assert!(result["report"]["sha256"]
        .as_str()
        .is_some_and(records::hash));
    assert_eq!(
        fs::read_to_string(fixture.layout.home.join("agents/alpha/workspace/SOUL.md")).unwrap(),
        "actual private worker persona"
    );
    assert!(!result.to_string().contains("actual private worker persona"));
    fixture.private_output(&Ok(result));
}

#[test]
fn a_descendant_holding_stdout_after_parent_exit_cannot_extend_the_total_deadline() {
    let fixture = Fixture::new("exit-descendant");
    let mut expected = success();
    expected["report"] = fixture.checkpoint("committed");
    fixture.result(&expected);
    let started = Instant::now();
    assert!(fixture.run(Duration::from_millis(400)).is_err());
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "stdout draining extended the caller's total deadline"
    );
}
