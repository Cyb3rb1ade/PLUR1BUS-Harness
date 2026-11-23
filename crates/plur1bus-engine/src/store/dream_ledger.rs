//! Native ownership of the ADR-009 ledger after the Core stops its legacy writer.

use std::{
    io::{ErrorKind, Read, Seek, SeekFrom},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OpenFlags, Transaction,
    TransactionBehavior,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::contract::{Cancel, EngineError, StoreError};

use super::{
    directory::{regular_file_identity, TrustedDirectory},
    paths::{secure_dir, secure_file},
};

mod candidates;
mod runs;
pub(crate) use runs::{transition, RunTransition, RunTransitionResult};

const LEGACY: &str = "dreams.db";
const NATIVE: &str = "engine.sqlite";
const DDL: &str = include_str!("dream-ledger-v1.sql");
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const OPEN: OpenFlags = OpenFlags::SQLITE_OPEN_NO_MUTEX.union(OpenFlags::SQLITE_OPEN_NOFOLLOW);
const MAX_LOG_UNITS: usize = 262_144;
const DIARY_NAME: &str = "DREAMS.md";
const MAX_DIARY_BYTES: usize = 262_144;

const TABLES: [(&str, &str); 3] = [
    ("dream_run", "run_id,agent_id,phase,job_id,partition,idempotency_key,trigger,scheduled_for,started_at,finished_at,outcome,reason,counts_json,tokens_in,tokens_out,cost_micros,log_path,error_json"),
    ("dream_schedule", "agent_id,phase,cron,timezone,enabled,stagger_offset_s,next_run_at,last_run_id,breaker_state,breaker_until,breaker_reason,importance_acc,captures_acc,capture_seq,last_capture_at"),
    ("dream_candidate", "candidate_id,agent_id,partition,content_hash,source_run_id,first_seen_at,expires_at,recalls,unique_queries,score,state,decision_json"),
];

#[derive(Clone, Copy)]
pub(crate) struct Imported {
    pub(crate) runs: i64,
    pub(crate) schedules: i64,
    pub(crate) candidates: i64,
}

fn is_missing(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::Io {
            kind: ErrorKind::NotFound
        }
    )
}

fn check_sidecars(dir: &TrustedDirectory, name: &str) -> Result<(), StoreError> {
    for suffix in ["-journal", "-wal", "-shm"] {
        match dir.open_file(&format!("{name}{suffix}")) {
            Ok(file) => {
                regular_file_identity(&file)?;
            }
            Err(err) if is_missing(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

fn open(dir: &TrustedDirectory, name: &str, flags: OpenFlags) -> Result<Connection, StoreError> {
    let file = dir.open_file(name)?;
    let identity = regular_file_identity(&file)?;
    check_sidecars(dir, name)?;
    let db = Connection::open_with_flags(dir.path().join(name), OPEN | flags)?;
    db.busy_timeout(BUSY_TIMEOUT)?;
    db.pragma_update(None, "trusted_schema", false)?;
    if regular_file_identity(&dir.open_file(name)?)? != identity {
        return Err(StoreError::UntrustedPath);
    }
    Ok(db)
}

fn copy(
    source: &Transaction<'_>,
    destination: &Transaction<'_>,
    table: &str,
    columns: &str,
    cancel: &Cancel,
) -> Result<i64, EngineError> {
    let mut select = source
        .prepare(&format!("SELECT {columns} FROM {table} ORDER BY rowid"))
        .map_err(StoreError::from)?;
    let n = select.column_count();
    let placeholders = vec!["?"; n].join(",");
    let mut insert = destination
        .prepare(&format!(
            "INSERT INTO {table} ({columns}) VALUES ({placeholders})"
        ))
        .map_err(StoreError::from)?;
    let mut rows = select.query([]).map_err(StoreError::from)?;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(StoreError::from)? {
        cancel.check()?;
        let values = (0..n)
            .map(|index| row.get::<_, SqlValue>(index))
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)?;
        insert
            .execute(params_from_iter(values))
            .map_err(StoreError::from)?;
        count += 1;
    }
    Ok(count)
}

fn version(db: &Connection) -> Result<i64, StoreError> {
    Ok(db.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn initialize(
    tx: &Transaction<'_>,
    dir: &TrustedDirectory,
    now: Option<i64>,
    cancel: &Cancel,
) -> Result<Option<Imported>, EngineError> {
    match version(tx)? {
        1 => {
            let complete: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM dream_import WHERE id=1)",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)?;
            return if complete {
                Ok(None)
            } else {
                Err(StoreError::Corrupt.into())
            };
        }
        0 => (),
        _ => return Err(StoreError::Corrupt.into()),
    }
    tx.execute_batch(DDL).map_err(StoreError::from)?;
    let mut counts = [0; 3];
    match open(dir, LEGACY, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(mut source) => {
            let snapshot = source.transaction().map_err(StoreError::from)?;
            if version(&snapshot)? != 1 {
                return Err(StoreError::Corrupt.into());
            }
            for (count, (table, columns)) in counts.iter_mut().zip(TABLES) {
                *count = copy(&snapshot, tx, table, columns, cancel)?;
            }
            snapshot.commit().map_err(StoreError::from)?;
            reconcile_open_runs(tx, now, cancel)?;
        }
        Err(err) if is_missing(&err) => {}
        Err(err) => return Err(err.into()),
    }
    let [runs, schedules, candidates] = counts;
    tx.execute(
        "INSERT INTO dream_import (id,runs,schedules,candidates) VALUES (1,?,?,?)",
        params![runs, schedules, candidates],
    )
    .map_err(StoreError::from)?;
    tx.pragma_update(None, "user_version", 1)
        .map_err(StoreError::from)?;
    Ok(Some(Imported {
        runs,
        schedules,
        candidates,
    }))
}

/// Close interrupted runs and release their claims as part of writer handoff.
fn reconcile_open_runs(
    tx: &Connection,
    now: Option<i64>,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    cancel.check()?;
    let now = now.unwrap_or_else(|| {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO);
        i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
    });
    // The legacy scheduler visits open runs in insertion order, so the last
    // imported open row wins for a schedule with more than one interrupted run.
    tx.execute_batch(
        "UPDATE dream_schedule AS schedule SET last_run_id = (
            SELECT run.run_id FROM dream_run AS run
             WHERE run.agent_id = schedule.agent_id AND run.phase = schedule.phase
               AND run.outcome IS NULL ORDER BY run.rowid DESC LIMIT 1
         ) WHERE EXISTS (
            SELECT 1 FROM dream_run AS run
             WHERE run.agent_id = schedule.agent_id AND run.phase = schedule.phase
               AND run.outcome IS NULL
         )",
    )
    .map_err(StoreError::from)?;
    cancel.check()?;
    let error = json!({"message":"the process stopped before the run finished"});
    tx.execute(
        "UPDATE dream_run SET outcome = 'aborted', reason = 'crashed', finished_at = ?1,
            tokens_in = NULL, tokens_out = NULL, error_json = ?2,
            idempotency_key = CASE WHEN instr(idempotency_key, '#') = 0 THEN idempotency_key
                ELSE substr(idempotency_key, 1, instr(idempotency_key, '#') - 1)
            END || '#aborted:' || run_id
         WHERE outcome IS NULL",
        params![now, error.to_string()],
    )
    .map_err(StoreError::from)?;
    Ok(())
}

/// This entry is called by the Core after it stops writing the legacy ledger.
/// All three tables and the import record become visible in one engine commit.
pub(crate) fn schedules(
    state: &Path,
    agent: &str,
    now: Option<i64>,
    cancel: &Cancel,
) -> Result<(Value, Option<Imported>), EngineError> {
    with_ledger(state, now, cancel, |db, _| {
        Ok(json!({"schedules": read_schedules(db, agent)?}))
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SchedulePlan {
    cron: String,
    timezone: String,
    enabled: bool,
    next_run_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ScheduleEdit {
    phase: String,
    expected: SchedulePlan,
    desired: SchedulePlan,
}

pub(crate) enum ScheduleEditResult {
    Updated(Value),
    Missing,
    Stale,
}

pub(crate) fn edit_schedule(
    state: &Path,
    agent: &str,
    edit: &ScheduleEdit,
    now: Option<i64>,
    cancel: &Cancel,
) -> Result<(ScheduleEditResult, Option<Imported>), EngineError> {
    with_ledger(state, now, cancel, |db, _| {
        let expected = &edit.expected;
        let desired = &edit.desired;
        let updated = db
            .execute(
                "UPDATE dream_schedule
             SET cron=?1, timezone=?2, enabled=?3,
                 next_run_at=CASE WHEN ?3 THEN ?4 ELSE next_run_at END
             WHERE agent_id=?5 AND phase=?6 AND cron=?7 AND timezone=?8 AND enabled=?9
                 AND (CASE WHEN enabled THEN next_run_at ELSE NULL END) IS ?10",
                params![
                    desired.cron,
                    desired.timezone,
                    desired.enabled,
                    desired.next_run_at,
                    agent,
                    edit.phase,
                    expected.cron,
                    expected.timezone,
                    expected.enabled,
                    expected.next_run_at,
                ],
            )
            .map_err(StoreError::from)?;
        if updated > 0 {
            return Ok(ScheduleEditResult::Updated(
                json!({"schedules": read_schedules(db, agent)?}),
            ));
        }
        let exists = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM dream_schedule WHERE agent_id=? AND phase=?)",
                params![agent, edit.phase],
                |row| row.get(0),
            )
            .map_err(StoreError::from)?;
        Ok(if exists {
            ScheduleEditResult::Stale
        } else {
            ScheduleEditResult::Missing
        })
    })
}

/// This read returns only authoritative ledger fields. The caller projects
/// volatile scheduler state, runtime thresholds and workspace diary metadata.
pub(crate) fn status(
    state: &Path,
    agent: Option<&str>,
    now: Option<i64>,
    cancel: &Cancel,
) -> Result<(Value, Option<Imported>), EngineError> {
    with_ledger(state, now, cancel, |db, _| {
        let mut statement = db
            .prepare(
                "SELECT DISTINCT agent_id FROM dream_schedule
             WHERE ?1 IS NULL OR agent_id = ?1 ORDER BY agent_id",
            )
            .map_err(StoreError::from)?;
        let agents = statement
            .query_map([agent], |row| row.get::<_, String>(0))
            .map_err(StoreError::from)?;
        let mut results = Vec::new();
        for agent in agents {
            cancel.check()?;
            let agent = agent.map_err(StoreError::from)?;
            results.push(json!({"agentId":agent,"phases":phase_status(db, &agent, cancel)?}));
        }
        Ok(json!({"schemaVersion":version(db)?, "agents":results}))
    })
}

fn phase_status(db: &Connection, agent: &str, cancel: &Cancel) -> Result<Vec<Value>, EngineError> {
    let mut schedules = db
        .prepare(
            "SELECT phase, cron, timezone, enabled, stagger_offset_s, next_run_at,
                breaker_state, breaker_until, breaker_reason, importance_acc, captures_acc
         FROM dream_schedule WHERE agent_id = ?
         ORDER BY CASE phase WHEN 'light' THEN 0 WHEN 'rem' THEN 1 ELSE 2 END",
        )
        .map_err(StoreError::from)?;
    let mut rows = schedules.query([agent]).map_err(StoreError::from)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(StoreError::from)? {
        cancel.check()?;
        let get = |index| row.get::<_, String>(index).map_err(StoreError::from);
        let phase = get(0)?;
        let breaker = get(6)?;
        if !matches!(phase.as_str(), "light" | "rem" | "deep")
            || !matches!(breaker.as_str(), "closed" | "open")
        {
            return Err(StoreError::Corrupt.into());
        }
        let enabled = row.get::<_, i64>(3).map_err(StoreError::from)? == 1;
        let next: Option<i64> = if enabled {
            row.get(5).map_err(StoreError::from)?
        } else {
            None
        };
        let mut last_run = read_runs(
            db,
            &LogQuery {
                agent_id: Some(agent.into()),
                phase: Some(phase.clone()),
                run_id: None,
                limit: Some(1),
            },
            cancel,
        )?;
        let importance = row.get::<_, f64>(9).map_err(StoreError::from)?;
        if !importance.is_finite() {
            return Err(StoreError::Corrupt.into());
        }
        let accumulated = if importance.fract() == 0.0 && importance.abs() <= (1i64 << 53) as f64 {
            json!(importance as i64)
        } else {
            json!(importance)
        };
        result.push(json!({
            "phase":phase, "cron":get(1)?, "timezone":get(2)?, "enabled":enabled,
            "staggerOffsetS":row.get::<_, i64>(4).map_err(StoreError::from)?,
            "nextRunAt":next, "lastRun":last_run.pop(),
            "breaker": {
                "state":breaker,
                "until":row.get::<_, Option<i64>>(7).map_err(StoreError::from)?,
                "reason":row.get::<_, Option<String>>(8).map_err(StoreError::from)?,
            },
            "importance": {
                "accumulated":accumulated,
                "capturesSinceRun":row.get::<_, i64>(10).map_err(StoreError::from)?,
            },
        }));
    }
    Ok(result)
}

fn with_ledger<T>(
    state: &Path,
    now: Option<i64>,
    cancel: &Cancel,
    operation: impl FnOnce(&Connection, &TrustedDirectory) -> Result<T, EngineError>,
) -> Result<(T, Option<Imported>), EngineError> {
    cancel.check()?;
    secure_dir(state)?;
    let dir = TrustedDirectory::open(state)?.create_child("dreams")?;
    secure_dir(dir.path())?;
    match dir.create_file(NATIVE) {
        Ok(file) => {
            regular_file_identity(&file)?;
            secure_file(&dir.path().join(NATIVE))?;
        }
        Err(StoreError::Io {
            kind: ErrorKind::AlreadyExists,
        }) => {}
        Err(err) => return Err(err.into()),
    }
    let mut db = open(&dir, NATIVE, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StoreError::from)?;
    let imported = initialize(&tx, &dir, now, cancel)?;
    let value = operation(&tx, &dir)?;
    cancel.check()?;
    dir.assert_unchanged()?;
    tx.commit().map_err(StoreError::from)?;
    if imported.is_some() {
        dir.sync_entries()?;
    }
    Ok((value, imported))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LogQuery {
    pub(crate) agent_id: Option<String>,
    pub(crate) phase: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) limit: Option<u16>,
}

pub(crate) fn log(
    state: &Path,
    query: &LogQuery,
    now: Option<i64>,
    cancel: &Cancel,
) -> Result<(Option<Value>, Option<Imported>), EngineError> {
    with_ledger(state, now, cancel, |db, dir| {
        let runs = read_runs(db, query, cancel)?;
        if query.run_id.is_some() && runs.is_empty() {
            return Ok(None);
        }
        let log = if query.run_id.is_some() {
            runs.first().and_then(|run| read_log_tail(dir, run))
        } else {
            None
        };
        let mut value = json!({"runs":runs});
        if let Some(log) = log {
            value["log"] = json!(log);
        }
        Ok(Some(value))
    })
}

fn read_runs(
    db: &Connection,
    query: &LogQuery,
    cancel: &Cancel,
) -> Result<Vec<Value>, EngineError> {
    let mut terms = Vec::new();
    let mut args = Vec::new();
    let limit = if let Some(run) = query.run_id.as_ref() {
        terms.push("run_id = ?");
        args.push(SqlValue::Text(run.clone()));
        1
    } else {
        if let Some(agent) = query.agent_id.as_ref() {
            terms.push("agent_id = ?");
            args.push(SqlValue::Text(agent.clone()));
        }
        if let Some(phase) = query.phase.as_ref() {
            terms.push("phase = ?");
            args.push(SqlValue::Text(phase.clone()));
        }
        query.limit.unwrap_or(20)
    };
    args.push(SqlValue::Integer(i64::from(limit)));
    let predicate = if terms.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", terms.join(" AND "))
    };
    let mut select = db.prepare(&format!(
        "SELECT run_id,agent_id,phase,job_id,partition,idempotency_key,trigger,scheduled_for,started_at,
                finished_at,outcome,reason,counts_json,tokens_in,tokens_out,log_path,error_json
         FROM dream_run {predicate} ORDER BY started_at DESC, rowid DESC LIMIT ?"
    )).map_err(StoreError::from)?;
    let mut rows = select
        .query(params_from_iter(args))
        .map_err(StoreError::from)?;
    let mut runs = Vec::new();
    while let Some(row) = rows.next().map_err(StoreError::from)? {
        cancel.check()?;
        runs.push(project_run(row)?);
    }
    Ok(runs)
}

fn project_run(row: &rusqlite::Row<'_>) -> Result<Value, StoreError> {
    let key: String = row.get(5)?;
    let (key, claimed) = key
        .split_once('#')
        .map_or((key.as_str(), true), |(key, _)| (key, false));
    let started: i64 = row.get(8)?;
    let finished: Option<i64> = row.get(9)?;
    let mut counts: Map<String, Value> =
        serde_json::from_str(&row.get::<_, String>(12)?).map_err(|_| StoreError::Corrupt)?;
    counts.retain(|_, value| value.is_number());
    let failure: Option<String> = row.get(16)?;
    let failure = failure
        .filter(|value| !value.is_empty())
        .map(|value| -> Result<Value, StoreError> {
            let data: Value = serde_json::from_str(&value).map_err(|_| StoreError::Corrupt)?;
            if data.is_null() {
                return Ok(Value::Null);
            }
            let mut error =
                json!({"message": data["message"].as_str().ok_or(StoreError::Corrupt)?});
            if let Some(name) = data["name"].as_str().filter(|name| !name.is_empty()) {
                error["name"] = json!(name);
            }
            Ok(error)
        })
        .transpose()?;
    Ok(json!({
        "runId":row.get::<_, String>(0)?, "agentId":row.get::<_, String>(1)?,
        "phase":row.get::<_, String>(2)?, "jobId":row.get::<_, String>(3)?,
        "partition":row.get::<_, Option<String>>(4)?, "idempotencyKey":key, "claimed":claimed,
        "trigger":row.get::<_, String>(6)?, "scheduledFor":row.get::<_, Option<i64>>(7)?,
        "startedAt":started, "finishedAt":finished,
        "durationMs":finished.map(|end| end.saturating_sub(started).max(0)),
        "outcome":row.get::<_, Option<String>>(10)?, "reason":row.get::<_, Option<String>>(11)?,
        "counts":counts, "tokensIn":row.get::<_, Option<i64>>(13)?, "tokensOut":row.get::<_, Option<i64>>(14)?,
        "logPath":row.get::<_, Option<String>>(15)?, "error":failure,
    }))
}

fn read_log_tail(dir: &TrustedDirectory, run: &Value) -> Option<String> {
    let recorded = Path::new(run["logPath"].as_str()?);
    let agent = dir.open_child(run["agentId"].as_str()?).ok()?;
    let phase = agent.open_child(run["phase"].as_str()?).ok()?;
    let name = format!("{}.log", run["runId"].as_str()?);
    if recorded != phase.path().join(&name) {
        return None;
    }
    let mut file = phase.open_file(&name).ok()?;
    regular_file_identity(&file).ok()?;
    let len = file.metadata().ok()?.len();
    // A UTF-16 unit needs at most three UTF-8 bytes. Leave room for the
    // leading partial UTF-8 code point when seeking into a large file.
    let size = len.min((MAX_LOG_UNITS * 3 + 3) as u64);
    file.seek(SeekFrom::Start(len - size)).ok()?;
    let mut raw = Vec::new();
    file.take(size).read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let mut units = 0;
    let start = text
        .char_indices()
        .rev()
        .find_map(|(index, character)| {
            units += character.len_utf16();
            (units > MAX_LOG_UNITS).then_some(index + character.len_utf8())
        })
        .unwrap_or(0);
    Some(text[start..].to_owned())
}

pub(crate) fn diary(
    workspace: Option<&Path>,
    agent: &str,
    cancel: &Cancel,
) -> Result<Value, EngineError> {
    cancel.check()?;
    let path = workspace.map(|dir| dir.join(DIARY_NAME));
    let (size, text, truncated) = workspace.and_then(read_diary).unwrap_or_default();
    cancel.check()?;
    Ok(json!({
        "agentId":agent,"path":path,"exists":size > 0,"bytes":size,"text":text,"truncated":truncated,
    }))
}

fn read_diary(workspace: &Path) -> Option<(u64, String, bool)> {
    let dir = TrustedDirectory::open(workspace).ok()?;
    let file = dir.open_file(DIARY_NAME).ok()?;
    regular_file_identity(&file).ok()?;
    let size = file.metadata().ok()?.len();
    let mut prefix = Vec::new();
    file.take(MAX_DIARY_BYTES as u64 + 1)
        .read_to_end(&mut prefix)
        .ok()?;
    dir.assert_unchanged().ok()?;
    let truncated = prefix.len() > MAX_DIARY_BYTES;
    if truncated {
        let mut end = MAX_DIARY_BYTES;
        while end > 0 && prefix[end] & 0xc0 == 0x80 {
            end -= 1;
        }
        prefix.truncate(end);
    }
    Some((
        size,
        String::from_utf8_lossy(&prefix).into_owned(),
        truncated,
    ))
}

fn read_schedules(db: &Connection, agent: &str) -> Result<Vec<Value>, StoreError> {
    let mut query = db.prepare(
        "SELECT phase,cron,timezone,enabled,stagger_offset_s,next_run_at
         FROM dream_schedule WHERE agent_id = ?
         ORDER BY CASE phase WHEN 'light' THEN 0 WHEN 'rem' THEN 1 ELSE 2 END",
    )?;
    let rows = query.query_map([agent], |row| {
        let enabled = row.get::<_, i64>(3)? == 1;
        let next: Option<i64> = if enabled { row.get(5)? } else { None };
        Ok(json!({
            "agentId": agent, "phase": row.get::<_, String>(0)?,
            "cron": row.get::<_, String>(1)?, "timezone": row.get::<_, String>(2)?,
            "enabled": enabled, "staggerOffsetS": row.get::<_, i64>(4)?, "nextRunAt": next,
        }))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod diary_tests {
    #![allow(clippy::unwrap_used, reason = "private workspace fixture")]
    use super::*;
    use std::fs;

    #[test]
    fn diary_reports_absence_and_reads_a_utf8_prefix_with_true_file_size() {
        let ws = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let path = ws.path().join("DREAMS.md");
        let cancel = Cancel::never();
        assert_eq!(
            diary(None, "a1", &cancel).unwrap(),
            json!({"agentId":"a1","path":null,"exists":false,"bytes":0,"text":"","truncated":false})
        );
        assert_eq!(
            diary(Some(ws.path()), "a1", &cancel).unwrap(),
            json!({"agentId":"a1","path":path,"exists":false,"bytes":0,"text":"","truncated":false})
        );
        let text = format!("{}🌙\n", "a".repeat(262_143));
        fs::write(&path, &text).unwrap();
        secure_file(&path).unwrap();
        assert_eq!(
            diary(Some(ws.path()), "a1", &cancel).unwrap(),
            json!({"agentId":"a1","path":path,"exists":true,"bytes":text.len(),
                "text":"a".repeat(262_143),"truncated":true})
        );
    }
}
