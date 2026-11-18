//! Parity mode B for the user jobs store and the system-jobs ledger (P4-K K7a): TypeScript writes the files with the product
//! code, Rust opens, reads and writes copies of them and creates a fresh store, TypeScript reads the result again and compares
//! the schema text of the Rust-made files with its own (`tests/core-parity/k7a-b-driver.ts`). Needs Node (`PLUR1BUS_NODE` or
//! `node` on PATH) with the workspace's TypeScript sources, like the other mixed-language tests.
//!
// Unix only: the files are created owner-only through `private_store`, which has a Unix implementation alone until the flip.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::approvals::js_json::J;
use plur1bus_core::budget::{Clock, UuidIds};
use plur1bus_core::jobs::system::{
    CreateSystemJobsOptions, HistoryQuery, RunContext, RunOptions, SystemJobHandler,
    SystemJobOutcome, SystemJobSpec, SystemJobs, SystemOutcome,
};
use plur1bus_core::jobs::user::{UserJobOutcome, UserJobs, UserJobsOptions};
use plur1bus_core::jobs::JobsError;
use plur1bus_core::rbac::audit::{AuditEvent, AuditSink};
use plur1bus_core::rbac::types::{AgentRight, Principal, PrincipalKind, Role};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> String {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/k7a-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "k7a-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct At(i64);
impl Clock for At {
    fn now(&self) -> i64 {
        self.0
    }
}

struct Quiet;
impl AuditSink for Quiet {
    fn append(&mut self, _: &AuditEvent) -> Result<(), String> {
        Ok(())
    }
}

fn person(id: &str, role: Role, rights: &[(&str, AgentRight)]) -> Principal {
    let mut p = Principal::new(id, role);
    p.kind = Some(PrincipalKind::Person);
    if !rights.is_empty() {
        p.agent_rights = Some(rights.iter().map(|(a, r)| ((*a).to_owned(), *r)).collect());
    }
    p
}

fn user_jobs(path: &Path, now: i64) -> UserJobs {
    UserJobs::open(UserJobsOptions {
        path: path.to_path_buf(),
        clock: Arc::new(At(now)),
        ids: Arc::new(UuidIds),
        audit: Box::new(Quiet),
        agent_exists: Box::new(|id| id == "main"),
        agents: Some(Box::new(|| vec!["main".to_owned()])),
        resolve: Box::new(|id| match id {
            "mel" => Some(person("mel", Role::Member, &[("main", AgentRight::Manage)])),
            "olga" => Some(person("olga", Role::Owner, &[])),
            _ => None,
        }),
        display_name: None,
        budget_blocked: Box::new(|_| false),
        notify: Box::new(|_| Ok(())),
        on_recorded: None,
        submit_turn: Box::new(|_, _| Ok(UserJobOutcome::Completed)),
        validate_delivery: None,
        is_stopping: Some(Box::new(|| false)),
        secure_path: None,
    })
    .unwrap()
}

struct Plain;
impl SystemJobHandler for Plain {
    fn spec(&self) -> SystemJobSpec {
        SystemJobSpec {
            name: "j".into(),
            every: 60_000.0,
            jitter: 0.1,
            exclusive: false,
        }
    }
    fn next_run_at(&self) -> Option<f64> {
        None
    }
    fn validate_args(&self, a: Option<&J>) -> Result<J, JobsError> {
        Ok(a.cloned().unwrap_or(J::Obj(Vec::new())))
    }
    fn run(&self, _: &J, _: &RunContext<'_>) -> Result<SystemJobOutcome, JobsError> {
        Ok(SystemJobOutcome {
            outcome: SystemOutcome::Completed,
            reason: None,
            running_run_id: None,
            detail: J::Null,
        })
    }
}

fn system_jobs(ledger: &Path, now: i64) -> SystemJobs {
    let jobs = SystemJobs::new(CreateSystemJobsOptions {
        ledger_path: ledger.to_path_buf(),
        clock: Arc::new(At(now)),
        ids: Arc::new(UuidIds),
        secure_path: Box::new(|p| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).is_ok()
        }),
        warn: Rc::new(|m, f| panic!("unexpected warning {m}: {}", f.stringify())),
        engine_has_job: Box::new(|_| false),
        on_recorded: None,
        on_failed: None,
    });
    jobs.register(Rc::new(Plain)).unwrap();
    jobs
}

fn mode(p: &Path) -> u32 {
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn typescript_user_jobs_and_ledger_files_round_trip_through_the_rust_port() {
    let dir = std::env::temp_dir().join(format!("plur1bus-k7a-b-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    driver("prepare", &dir);
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let now = manifest["now"].as_i64().unwrap();
    assert_eq!(
        manifest["rotated"],
        json!(true),
        "TypeScript rotated its ledger"
    );
    let olga = person("olga", Role::Owner, &[]);
    let mel = person("mel", Role::Member, &[("main", AgentRight::Manage)]);

    // A store TypeScript made: its job is read, the run it left `running` becomes `abandoned`, and Rust adds a job.
    std::fs::copy(
        dir.join("user-jobs-ts.sqlite"),
        dir.join("user-jobs-rust.sqlite"),
    )
    .unwrap();
    let path = dir.join("user-jobs-rust.sqlite");
    let jobs = user_jobs(&path, now + 10_000);
    let listed = jobs.list(&olga).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].get("id").and_then(J::as_str),
        manifest["jobId"].as_str()
    );
    let history = jobs.history(None, &olga, None).unwrap();
    let outcomes: Vec<(String, String)> = history
        .iter()
        .map(|r| {
            (
                r.get("runId").and_then(J::as_str).unwrap().to_owned(),
                r.get("outcome").and_then(J::as_str).unwrap().to_owned(),
            )
        })
        .collect();
    assert!(outcomes.contains(&("run-open".into(), "abandoned".into())));
    assert!(outcomes.contains(&("run-done".into(), "completed".into())));
    let created = jobs
        .create(
            &J::parse(r#"{"name":"From Rust","agentId":"main","prompt":"p","schedule":{"cron":"*/5 * * * *","timezone":"UTC"},"enabled":true}"#).unwrap(),
            &mel,
        )
        .unwrap();
    assert_eq!(created.get("runAs").and_then(J::as_str), Some("mel"));
    jobs.close();

    // A fresh store: owner-only, with the schema text of the reference file.
    let fresh = dir.join("user-jobs-fresh-rust.sqlite");
    user_jobs(&fresh, now).close();
    assert_eq!(mode(&fresh), 0o600);

    // A store of a newer version is refused and left as it was.
    let newer = dir.join("user-jobs-newer.sqlite");
    std::fs::copy(dir.join("user-jobs-ts.sqlite"), &newer).unwrap();
    {
        let db = plur1bus_store::rusqlite::Connection::open(&newer).unwrap();
        db.execute_batch("PRAGMA user_version = 7").unwrap();
    }
    let before = std::fs::read(&newer).unwrap();
    let refused = UserJobs::open(UserJobsOptions {
        path: newer.clone(),
        clock: Arc::new(At(now)),
        ids: Arc::new(UuidIds),
        audit: Box::new(Quiet),
        agent_exists: Box::new(|_| true),
        agents: None,
        resolve: Box::new(|_| None),
        display_name: None,
        budget_blocked: Box::new(|_| false),
        notify: Box::new(|_| Ok(())),
        on_recorded: None,
        submit_turn: Box::new(|_, _| Ok(UserJobOutcome::Completed)),
        validate_delivery: None,
        is_stopping: None,
        secure_path: None,
    });
    assert!(refused.is_err(), "a store of schema v7 is refused");
    assert_eq!(
        std::fs::read(&newer).unwrap(),
        before,
        "the refused file is untouched"
    );

    // The ledger TypeScript wrote, with its rotated half: Rust reads both, appends, and rotates nothing it should not.
    let ledger_dir = dir.join("ledger-rust");
    std::fs::create_dir_all(&ledger_dir).unwrap();
    for name in ["ledger.jsonl", "ledger.jsonl.1"] {
        std::fs::copy(dir.join("ledger-ts").join(name), ledger_dir.join(name)).unwrap();
    }
    let s = system_jobs(&ledger_dir.join("ledger.jsonl"), now + 40_000);
    let before: Vec<String> = s
        .history(&HistoryQuery::default())
        .iter()
        .map(|r| r.run_id.clone())
        .collect();
    assert_eq!(
        before.len(),
        3,
        "the three TypeScript runs, one in the rotated file"
    );
    assert!(before.contains(&manifest["tsRotatingRunId"].as_str().unwrap().to_owned()));
    let (record, _) = s
        .run(
            "j",
            Some(&J::parse(r#"{"from":"rust","n":2}"#).unwrap()),
            &RunOptions {
                trigger: "manual".into(),
                signal: None,
            },
        )
        .unwrap();
    assert_eq!(record.outcome, "completed");
    let after = s.history(&HistoryQuery::default());
    assert_eq!(after.len(), 4);

    std::fs::write(
        dir.join("rust-results.json"),
        json!({ "rustRunId": record.run_id, "rustJobId": created.get("id").and_then(J::as_str) })
            .to_string(),
    )
    .unwrap();

    // The files Rust wrote have the schema text of the files TypeScript made, and the product code reads them.
    let out: Value = serde_json::from_str(&driver("verify", &dir)).unwrap();
    for (k, v) in out["sameSchema"].as_object().unwrap() {
        assert_eq!(v, &json!(true), "schema text differs for {k}");
    }
    let names: Vec<&str> = out["userJobs"]["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j[0].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Daily", "From Rust"]);
    let history = out["userJobs"]["history"].as_array().unwrap();
    assert!(history
        .iter()
        .any(|r| r[0] == "run-open" && r[1] == "abandoned"));
    assert_eq!(out["ledger"]["hasRustRun"], json!(true));
    assert_eq!(out["ledger"]["hasTsRotating"], json!(true));
    assert_eq!(out["ledger"]["runs"].as_array().unwrap().len(), 4);
    let _ = std::fs::remove_dir_all(&dir);
}
