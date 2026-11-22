//! Native ownership of the ADR-009 ledger after the Core stops its legacy writer.

use std::{io::ErrorKind, path::Path, time::Duration};

use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OpenFlags, Transaction,
    TransactionBehavior,
};
use serde_json::{json, Value};

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
    let rows = read_schedules(&tx, agent)?;
    cancel.check()?;
    dir.assert_unchanged()?;
    tx.commit().map_err(StoreError::from)?;
    if imported.is_some() {
        dir.sync_entries()?;
    }
    Ok((json!({"schedules": rows}), imported))
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
