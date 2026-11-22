//! Native ownership of the ADR-009 ledger after the Core stops its legacy writer.

use std::{
    io::{ErrorKind, Read, Seek, SeekFrom},
    path::Path,
    time::Duration,
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

const LEGACY: &str = "dreams.db";
const NATIVE: &str = "engine.sqlite";
const DDL: &str = include_str!("dream-ledger-v1.sql");
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const OPEN: OpenFlags = OpenFlags::SQLITE_OPEN_NO_MUTEX.union(OpenFlags::SQLITE_OPEN_NOFOLLOW);
const MAX_LOG_UNITS: usize = 262_144;

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
        .prepare(&format!("SELECT {columns} FROM {table}"))
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

/// This entry is called by the Core after it stops writing the legacy ledger.
/// All three tables and the import record become visible in one engine commit.
pub(crate) fn schedules(
    state: &Path,
    agent: &str,
    cancel: &Cancel,
) -> Result<(Value, Option<Imported>), EngineError> {
    with_ledger(state, cancel, |db, _| {
        Ok(json!({"schedules": read_schedules(db, agent)?}))
    })
}

fn with_ledger<T>(
    state: &Path,
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
    let imported = initialize(&tx, &dir, cancel)?;
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
    cancel: &Cancel,
) -> Result<(Option<Value>, Option<Imported>), EngineError> {
    with_ledger(state, cancel, |db, dir| {
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
