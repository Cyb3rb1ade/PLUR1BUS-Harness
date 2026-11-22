use super::*;
use crate::toolcall::json::V;
use serde_json::{json, Value};

fn same(actual: impl Serialize, expected: &Value) {
    let value = serde_json::to_value(actual).unwrap();
    assert!(
        V::from_serde(&value).deep_equal(&V::from_serde(expected)),
        "actual {value}\nexpected {expected}",
    );
}

fn schedule(agent: &str, phase: Phase, enabled: bool) -> ScheduleSeed {
    ScheduleSeed {
        agent_id: agent.to_owned(),
        phase,
        cron: match phase {
            Phase::Light => "0 */4 * * *",
            _ => "15 1 * * *",
        }
        .to_owned(),
        timezone: "UTC".to_owned(),
        enabled,
        stagger_offset_s: 20,
        next_run_at: Some(5000),
    }
}

fn run(id: &str, start: i64, trigger: Trigger) -> NewRun {
    NewRun {
        run_id: id.to_owned(),
        agent_id: "agent-a".to_owned(),
        phase: Phase::Rem,
        job_id: "fixture-job".to_owned(),
        partition: None,
        idempotency_key: "fixture-key".to_owned(),
        trigger,
        scheduled_for: Some(0),
        started_at: start,
        log_path: Some("fixture.log".to_owned()),
    }
}

#[test]
fn the_store_replays_typescript() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/dreams/store.json"
    ))
    .unwrap();
    let store = DreamStore::open(Path::new(":memory:")).unwrap();
    same(store.schema_version().unwrap(), &fixture["version"]);
    let inserts = [
        schedule("agent-a", Phase::Rem, true),
        schedule("agent-a", Phase::Light, true),
        schedule("agent-b", Phase::Light, false),
        schedule("agent-a", Phase::Light, false),
    ]
    .map(|seed| store.insert_schedule(&seed).unwrap());
    same(inserts, &fixture["inserts"]);
    store.record_capture("agent-a", 5.5, 60).unwrap();
    store.record_capture("agent-a", 3.0, 65).unwrap();
    store
        .update_schedule(
            "agent-a",
            Phase::Light,
            SchedulePatch {
                next_run_at: Some(None),
                last_run_id: Some(Some("run-1".to_owned())),
                breaker_state: Some(Breaker::Open),
                breaker_until: Some(Some(120)),
                breaker_reason: Some(Some("fixture".to_owned())),
                ..SchedulePatch::default()
            },
        )
        .unwrap();
    same(store.schedules(None).unwrap(), &fixture["schedules"]);

    store.insert_run(&run("run-1", 20, Trigger::Cron)).unwrap();
    store.insert_run(&run("run-2", 30, Trigger::Cron)).unwrap();
    let mut claims = vec![
        store.claim_key("run-1", "fixture-key").unwrap(),
        store.claim_key("run-2", "fixture-key").unwrap(),
    ];
    let finish = |outcome: Outcome, data: &str| {
        let mut result: FinishRun = serde_json::from_str(data).unwrap();
        result.outcome = Some(outcome);
        result
    };
    store
        .finish_run(
            "run-1",
            &finish(
                Outcome::Failed,
                r#"{"reason":"fixture","finishedAt":25,"counts":{"llmSessions":1},"error":{"message":"fixture run error"}}"#,
            ),
        )
        .unwrap();
    claims.push(store.claim_key("run-2", "fixture-key").unwrap());
    store
        .finish_run(
            "run-2",
            &finish(
                Outcome::Completed,
                r#"{"finishedAt":40,"counts":{"llmSessions":2},"tokensIn":8,"tokensOut":2}"#,
            ),
        )
        .unwrap();
    store
        .insert_run(&run("run-3", 40, Trigger::Catchup))
        .unwrap();
    claims.push(store.claim_key("run-3", "fixture-key").unwrap());
    same(claims, &fixture["claims"]);
    same(store.key_holder("fixture-key").unwrap(), &fixture["holder"]);
    same(
        store
            .runs(&RunQuery {
                agent_id: Some("agent-a"),
                phase: Some(Phase::Rem),
                since: Some(0),
                limit: None,
            })
            .unwrap(),
        &fixture["runs"],
    );
    let window: Vec<String> = store
        .window_runs("agent-a", Phase::Rem, 0)
        .unwrap()
        .into_iter()
        .map(|row| row.open.run_id)
        .collect();
    same(window, &fixture["window"]);
    same(
        store
            .llm_sessions_since("agent-a", &[Phase::Rem, Phase::Deep], 0)
            .unwrap(),
        &fixture["llmSessions"],
    );
    same(store.prune(25, 35).unwrap(), &fixture["prune"]);
    same(store.open_runs().unwrap(), &fixture["openAfterPrune"]);

    let insert = |id: &str, agent: &str, partition: &str, expiry| {
        store
            .insert_candidate(
                &CandidateSeed {
                    candidate_id: id.to_owned(),
                    agent_id: agent.to_owned(),
                    partition: partition.to_owned(),
                    content_hash: "fixture-hash".to_owned(),
                    source_run_id: "run-2".to_owned(),
                    first_seen_at: 10,
                    expires_at: expiry,
                    signals: CandidateSignals {
                        recalls: 0,
                        unique_queries: 0,
                        score: None,
                    },
                },
                CandidateState::Shortlisted,
            )
            .unwrap()
    };
    let inserts = [
        insert("candidate-a", "agent-a", "agent-private", 35),
        insert("duplicate", "agent-a", "agent-private", 35),
        insert("other-partition", "agent-a", "workspace", 36),
        insert("other-agent", "agent-b", "agent-private", 35),
    ];
    let update = |recalls, unique_queries, score| {
        store
            .update_signals(
                "agent-a",
                "agent-private",
                "fixture-hash",
                CandidateSignals {
                    recalls,
                    unique_queries,
                    score: Some(score),
                },
            )
            .unwrap();
    };
    update(4, 3, 0.9);
    let expired = store.expire_candidates("agent-a", 35).unwrap();
    update(7, 7, 1.0);
    same(
        json!({
            "owned":store.candidates("agent-a", None).unwrap(),
            "other":store.candidates("agent-b", None).unwrap(),
            "expired":expired,"inserts":inserts,
        }),
        &fixture["candidates"],
    );
}

#[test]
fn only_the_attempts_claim_can_commit_once() {
    let store = DreamStore::open(Path::new(":memory:")).unwrap();
    store.insert_run(&run("a", 5, Trigger::Manual)).unwrap();
    let finish = FinishRun {
        outcome: Some(Outcome::Completed),
        finished_at: Some(6),
        ..FinishRun::default()
    };
    assert!(!store.claim_key("a", "other-key").unwrap());
    let error = store.finish_run("a", &finish).unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("idempotent"));
    assert!(store.claim_key("a", "fixture-key").unwrap());
    assert!(!store.claim_key("a", "other-key").unwrap());
    store.finish_run("a", &finish).unwrap();
    let error = store
        .finish_run(
            "a",
            &FinishRun {
                outcome: Some(Outcome::Failed),
                finished_at: Some(8),
                ..FinishRun::default()
            },
        )
        .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("run-closed"));
    assert_eq!(
        store.key_holder("fixture-key").unwrap().as_deref(),
        Some("a")
    );
}

#[test]
fn actors_round_trip_both_dreaming_databases() {
    let dir = tempfile::tempdir().unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/core-parity/k7b-dream-store-driver.ts");
    let driver = |op| {
        let out = std::process::Command::new("node")
            .args(["--experimental-strip-types", "--conditions=source"])
            .arg(&script)
            .arg(op)
            .arg(dir.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    };
    driver("prepare");

    let protected_fixture = |path: &Path| cfg!(windows) || private_store::default_secure(path);
    {
        let ts =
            DreamStore::open_with_permissions(&dir.path().join("from-ts.db"), &protected_fixture)
                .unwrap();
        assert_eq!(
            ts.key_holder("fixture-slot").unwrap().as_deref(),
            Some("run-from-ts")
        );
        assert_eq!(
            ts.schedule("agent-a", Phase::Rem)
                .unwrap()
                .unwrap()
                .importance_acc,
            5.5
        );
        ts.finish_run(
            "run-from-ts",
            &FinishRun {
                outcome: Some(Outcome::Failed),
                reason: Some("fixture".to_owned()),
                finished_at: Some(4001),
                ..FinishRun::default()
            },
        )
        .unwrap();
    }
    {
        let rust =
            DreamStore::open_with_permissions(&dir.path().join("from-rust.db"), &protected_fixture)
                .unwrap();
        rust.insert_run(&run("run-from-rust", 5000, Trigger::Cron))
            .unwrap();
        assert!(rust.claim_key("run-from-rust", "fixture-key").unwrap());
        rust.finish_run(
            "run-from-rust",
            &FinishRun {
                outcome: Some(Outcome::Completed),
                finished_at: Some(5001),
                counts: [("llmSessions".to_owned(), 2.0)].into(),
                ..FinishRun::default()
            },
        )
        .unwrap();
    }
    assert_eq!(driver("verify"), b"DREAM_MODE_B_OK\n");
}

#[test]
fn overlapping_phases_cannot_both_reserve_the_last_model_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("quota.db");
    let secure = |path: &Path| cfg!(windows) || private_store::default_secure(path);
    let first = DreamStore::open_with_permissions(&path, &secure).unwrap();
    let second = DreamStore::open_with_permissions(&path, &secure).unwrap();
    let mut rem = run("rem", 100, Trigger::Cron);
    rem.idempotency_key = "quota-rem".into();
    let mut deep = run("deep", 100, Trigger::Cron);
    deep.phase = Phase::Deep;
    deep.idempotency_key = "quota-deep".into();
    first.insert_run(&rem).unwrap();
    second.insert_run(&deep).unwrap();
    assert!(first.claim_key("rem", &rem.idempotency_key).unwrap());
    assert!(second.claim_key("deep", &deep.idempotency_key).unwrap());
    assert!(first
        .reserve_model_session("rem", &rem.agent_id, 0, 1)
        .unwrap());
    assert!(!second
        .reserve_model_session("deep", &deep.agent_id, 0, 1)
        .unwrap());
    first
        .finish_run(
            "rem",
            &FinishRun {
                outcome: Some(Outcome::Aborted),
                finished_at: Some(101),
                ..FinishRun::default()
            },
        )
        .unwrap();
    assert_eq!(
        second
            .llm_sessions_since(&rem.agent_id, &[Phase::Rem, Phase::Deep], 0)
            .unwrap(),
        1
    );
    assert!(!second
        .reserve_model_session("deep", &deep.agent_id, 0, 1)
        .unwrap());
}
