//! Durable ADR-009 phase runs. The Core admits triggers and dispatches jobs.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::{
    bounded_text, candidates, read_runs, reconcile_open_runs, with_ledger, Cancel, EngineError,
    LogQuery, StoreError,
};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum RunTransition {
    Begin(Begin),
    PrepareCandidates(candidates::Prepare),
    Finish(Finish),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Begin {
    run_id: String,
    phase: String,
    idempotency_key: String,
    trigger: String,
    scheduled_for: Option<i64>,
    claim: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Finish {
    run_id: String,
    outcome: String,
    reason: Option<String>,
    #[serde(default)]
    counts: BTreeMap<String, i64>,
    tokens_in: Option<i64>,
    tokens_out: Option<i64>,
}

pub(crate) enum RunTransitionResult {
    Run(Value),
    Candidates(Value),
    Missing,
    Conflict,
}

impl RunTransition {
    pub(crate) fn valid(&self) -> bool {
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 128
                && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        };
        match self {
            Self::Begin(s) => {
                valid_id(&s.run_id)
                    && primary_job(&s.phase).is_some()
                    && matches!(
                        s.trigger.as_str(),
                        "cron" | "importance" | "manual" | "catchup"
                    )
                    && s.scheduled_for.is_none_or(|time| time >= 0)
                    && bounded_text(&s.idempotency_key, 512)
                    && !s.idempotency_key.contains('#')
            }
            Self::PrepareCandidates(request) => valid_id(&request.run_id) && request.valid(),
            Self::Finish(f) => {
                valid_id(&f.run_id)
                    && (f.outcome == "completed" && f.reason.is_none()
                        || matches!(f.outcome.as_str(), "skipped" | "failed" | "aborted")
                            && f.reason.as_ref().is_some_and(|r| bounded_text(r, 256)))
                    && f.tokens_in.is_none_or(|count| count >= 0)
                    && f.tokens_out.is_none_or(|count| count >= 0)
                    && f.counts.len() <= 64
                    && f.counts
                        .iter()
                        .all(|(name, count)| bounded_text(name, 64) && *count >= 0)
            }
        }
    }
}

fn primary_job(phase: &str) -> Option<&'static str> {
    match phase {
        "light" => Some("light-dream"),
        "rem" => Some("rem-dream"),
        "deep" => Some("consolidate-daily"),
        _ => None,
    }
}

#[derive(Clone, Copy)]
pub(crate) struct RunCall<'a> {
    pub(crate) now: i64,
    pub(crate) cancel: &'a Cancel,
    pub(crate) core: uuid::Uuid,
    pub(crate) response_bytes: usize,
}

pub(crate) fn transition(
    state: &std::path::Path,
    agent: &str,
    transition: &RunTransition,
    call: RunCall<'_>,
    check_core: impl Fn() -> Result<(), EngineError>,
) -> Result<RunTransitionResult, EngineError> {
    let RunCall {
        now,
        cancel,
        core,
        response_bytes,
    } = call;
    with_ledger(state, true, cancel, |db, _| {
        check_core()?;
        establish_writer(db, core, now, cancel)?;
        let result = match transition {
            RunTransition::Begin(start) => begin(db, agent, start, now, cancel)?,
            RunTransition::PrepareCandidates(request) => {
                prepare(db, agent, request, now, cancel, response_bytes)?
            }
            RunTransition::Finish(result) => finish(db, agent, result, now, cancel)?,
        };
        crate::rpc::seams::pause_fixture_step(state, "dream-run-before-commit")?;
        check_core()?;
        Ok(result)
    })
}

fn establish_writer(
    db: &Connection,
    core: uuid::Uuid,
    now: i64,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let old: Option<String> = db
        .query_row(
            "SELECT core FROM dream_ledger_writer WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::from)?;
    let core = core.to_string();
    if old.as_deref() != Some(core.as_str()) {
        if old.is_some() {
            reconcile_open_runs(db, Some(now), cancel)?;
        }
        db.execute(
            "INSERT INTO dream_ledger_writer (id,core) VALUES (1,?1)
             ON CONFLICT(id) DO UPDATE SET core=excluded.core",
            [core],
        )
        .map_err(StoreError::from)?;
    }
    Ok(())
}

fn prepare(
    db: &Connection,
    agent: &str,
    request: &candidates::Prepare,
    now: i64,
    cancel: &Cancel,
    response_bytes: usize,
) -> Result<RunTransitionResult, EngineError> {
    let Some(run) = get(db, &request.run_id, cancel)?.filter(|run| run["agentId"] == agent) else {
        return Ok(RunTransitionResult::Missing);
    };
    let phase = run["phase"].as_str().ok_or(StoreError::Corrupt)?;
    if run["claimed"] != true || !run["outcome"].is_null() || !matches!(phase, "light" | "deep") {
        return Ok(RunTransitionResult::Conflict);
    }
    Ok(
        candidates::prepare(db, agent, phase, request, now, cancel, response_bytes)?.map_or(
            RunTransitionResult::Conflict,
            RunTransitionResult::Candidates,
        ),
    )
}

fn get(db: &Connection, id: &str, cancel: &Cancel) -> Result<Option<Value>, EngineError> {
    let mut runs = read_runs(
        db,
        &LogQuery {
            run_id: Some(id.to_owned()),
            agent_id: None,
            phase: None,
            limit: None,
        },
        cancel,
    )?;
    Ok(runs.pop())
}

fn begin(
    db: &Connection,
    agent: &str,
    s: &Begin,
    now: i64,
    cancel: &Cancel,
) -> Result<RunTransitionResult, EngineError> {
    if let Some(existing) = get(db, &s.run_id, cancel)? {
        return Ok(if existing["agentId"] != agent {
            RunTransitionResult::Missing
        } else if existing["phase"] == s.phase
            && existing["trigger"] == s.trigger
            && existing["idempotencyKey"] == s.idempotency_key
            && existing["scheduledFor"].as_i64() == s.scheduled_for
        {
            RunTransitionResult::Run(existing)
        } else {
            RunTransitionResult::Conflict
        });
    }
    let job = primary_job(&s.phase).ok_or(StoreError::InvalidInput)?;
    let mut key = format!("{}#{}", s.idempotency_key, s.run_id);
    if s.claim {
        let claimed: bool = db
            .query_row(
                "SELECT NOT EXISTS (SELECT 1 FROM dream_run WHERE idempotency_key = ?)",
                [&s.idempotency_key],
                |row| row.get(0),
            )
            .map_err(StoreError::from)?;
        if claimed {
            key.clone_from(&s.idempotency_key);
        }
    }
    db.execute(
        "INSERT INTO dream_run (run_id,agent_id,phase,job_id,partition,idempotency_key,trigger,scheduled_for,started_at)
         VALUES (?1,?2,?3,?4,'agent-private',?5,?6,?7,?8)",
        params![s.run_id, agent, s.phase, job, key, s.trigger, s.scheduled_for, now],
    ).map_err(StoreError::from)?;
    saved(db, &s.run_id, cancel)
}

fn finish(
    db: &Connection,
    agent: &str,
    f: &Finish,
    now: i64,
    cancel: &Cancel,
) -> Result<RunTransitionResult, EngineError> {
    let Some(existing) = get(db, &f.run_id, cancel)?.filter(|run| run["agentId"] == agent) else {
        return Ok(RunTransitionResult::Missing);
    };
    let status = f.outcome.as_str();
    let counts = serde_json::to_value(&f.counts).map_err(|_| StoreError::Corrupt)?;
    if !existing["outcome"].is_null() {
        return Ok(
            if existing["outcome"] == status
                && existing["reason"].as_str() == f.reason.as_deref()
                && existing["counts"] == counts
                && existing["tokensIn"].as_i64() == f.tokens_in
                && existing["tokensOut"].as_i64() == f.tokens_out
            {
                RunTransitionResult::Run(existing)
            } else {
                RunTransitionResult::Conflict
            },
        );
    }
    let key = existing["idempotencyKey"]
        .as_str()
        .ok_or(StoreError::Corrupt)?;
    let complete = status == "completed";
    let key = if complete {
        if existing["claimed"] != true {
            return Ok(RunTransitionResult::Conflict);
        }
        key.to_owned()
    } else {
        format!("{key}#{status}:{}", f.run_id)
    };
    let phase = existing["phase"].as_str().ok_or(StoreError::Corrupt)?;
    db.execute(
        "UPDATE dream_run SET outcome=?1,reason=?2,finished_at=?3,counts_json=?4,tokens_in=?5,tokens_out=?6,
            idempotency_key=?7 WHERE run_id=?8 AND agent_id=?9 AND outcome IS NULL",
        params![status, f.reason, now, counts.to_string(), f.tokens_in, f.tokens_out, key, f.run_id, agent],
    ).map_err(StoreError::from)?;
    db.execute(
        "UPDATE dream_schedule SET last_run_id=?1,
             importance_acc=CASE WHEN ?2 THEN 0 ELSE importance_acc END,
             captures_acc=CASE WHEN ?2 THEN 0 ELSE captures_acc END
         WHERE agent_id=?3 AND phase=?4",
        params![f.run_id, complete, agent, phase],
    )
    .map_err(StoreError::from)?;
    saved(db, &f.run_id, cancel)
}

fn saved(db: &Connection, id: &str, cancel: &Cancel) -> Result<RunTransitionResult, EngineError> {
    get(db, id, cancel)?
        .map(RunTransitionResult::Run)
        .ok_or_else(|| StoreError::Corrupt.into())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::cell::Cell;

    use serde_json::json;

    use super::*;

    #[test]
    fn transition_validation_reserves_the_claim_suffix_and_bounds_the_count_map() {
        let begin = |key: &str| {
            serde_json::from_value::<RunTransition>(json!({
                "kind":"begin","runId":"sample","phase":"deep","trigger":"manual",
                "idempotencyKey":key,"claim":true
            }))
            .unwrap()
        };
        assert!(begin("sample-key").valid());
        assert!(!begin("sample#suffix").valid());
        for (entries, valid) in [(64, true), (65, false)] {
            let counts: BTreeMap<_, _> = (0..entries).map(|n| (format!("count-{n}"), n)).collect();
            let finish = serde_json::from_value::<RunTransition>(json!({
                "kind":"finish","runId":"sample","outcome":"completed","counts":counts
            }))
            .unwrap();
            assert_eq!(finish.valid(), valid);
        }
    }

    #[test]
    fn changed_core_at_commit_rolls_back_the_writer_handoff_and_run() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().canonicalize().unwrap().join("state");
        let old = uuid::Uuid::from_u128(1);
        let new = uuid::Uuid::from_u128(2);
        let cancel = Cancel::never();
        let start = |id| {
            serde_json::from_value::<RunTransition>(json!({
                "kind":"begin", "runId":id, "phase":"deep", "trigger":"cron",
                "idempotencyKey":"fixture-window", "claim":true
            }))
            .unwrap()
        };
        let old_run = start("old-run");
        let next_run = start("next-run");
        let call = |now, core| RunCall {
            now,
            core,
            cancel: &cancel,
            response_bytes: usize::MAX,
        };
        super::super::import_legacy(&path, Some(1), &cancel, || Ok(())).unwrap();
        transition(&path, "a1", &old_run, call(1, old), || Ok(())).unwrap();
        let calls = Cell::new(0);
        let failed = transition(&path, "a1", &next_run, call(2, new), || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                Err(crate::contract::HostError::Denied.into())
            } else {
                Ok(())
            }
        });
        assert!(matches!(
            failed,
            Err(EngineError::Host(crate::contract::HostError::Denied))
        ));
        let db = Connection::open(path.join("dreams/engine.sqlite")).unwrap();
        assert!(get(&db, "next-run", &cancel).unwrap().is_none());
        assert_eq!(
            get(&db, "old-run", &cancel).unwrap().unwrap()["claimed"],
            true
        );

        transition(&path, "a1", &next_run, call(3, new), || Ok(())).unwrap();
        let abandoned = get(&db, "old-run", &cancel).unwrap().unwrap();
        assert_eq!(abandoned["outcome"], "aborted");
        assert_eq!(abandoned["finishedAt"], 3);
        assert_eq!(
            get(&db, "next-run", &cancel).unwrap().unwrap()["claimed"],
            true
        );
    }
}
