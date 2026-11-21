//! ADR-009 run ledger, schedules and shortlist in the versioned dreaming database.

use super::types::{
    Breaker, CandidateRow, CandidateSeed, CandidateSignals, CandidateState, DreamRun, FinishRun,
    NewRun, Outcome, Phase, Retention, RunQuery, Schedule, SchedulePatch, ScheduleSeed, Trigger,
};
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::private_store;
use plur1bus_store::rusqlite::types::Value as SqlValue;
use plur1bus_store::rusqlite::{
    self, params, params_from_iter, Connection, OptionalExtension, Row, Transaction,
    TransactionBehavior,
};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::path::Path;

type R<T> = Result<T, CollabError>;
const MIGRATIONS: &[&str] = &[include_str!("store-v1.sql")];
const SCHEDULE_ORDER: &str = "CASE phase WHEN 'light' THEN 0 WHEN 'rem' THEN 1 ELSE 2 END";

fn conflict(reason: &'static str, message: &'static str) -> CollabError {
    CollabError::with_reason(C::Conflict, message, reason)
}

fn encode(value: &impl Serialize) -> R<String> {
    serde_json::to_string(value)
        .map_err(|_| CollabError::new(C::Invalid, "dreaming record cannot be serialized"))
}

fn decode<T: DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn rows<T>(
    cx: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
    read: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> R<Vec<T>> {
    let mut statement = cx.prepare(sql)?;
    let entries = statement
        .query_map(args, read)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(entries)
}

fn optional<T: Into<SqlValue>>(value: Option<Option<T>>) -> Option<SqlValue> {
    value.map(|value| value.map_or(SqlValue::Null, Into::into))
}

fn read_schedule(row: &Row<'_>) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        seed: ScheduleSeed {
            agent_id: row.get("agent_id")?,
            phase: Phase::from_column(row, "phase")?,
            cron: row.get("cron")?,
            timezone: row.get("timezone")?,
            enabled: row.get::<_, i64>("enabled")? == 1,
            stagger_offset_s: row.get("stagger_offset_s")?,
            next_run_at: row.get("next_run_at")?,
        },
        last_run_id: row.get("last_run_id")?,
        breaker_state: Breaker::from_column(row, "breaker_state")?,
        breaker_until: row.get("breaker_until")?,
        breaker_reason: row.get("breaker_reason")?,
        importance_acc: row.get("importance_acc")?,
        captures_acc: row.get("captures_acc")?,
        capture_seq: row.get("capture_seq")?,
        last_capture_at: row.get("last_capture_at")?,
    })
}

fn read_run(row: &Row<'_>) -> rusqlite::Result<DreamRun> {
    let raw = row.get::<_, String>("idempotency_key")?;
    let base = raw.split_once('#');
    let outcome = row
        .get::<_, Option<String>>("outcome")?
        .map(|_| Outcome::from_column(row, "outcome"))
        .transpose()?;
    let error = row
        .get::<_, Option<String>>("error_json")?
        .filter(|text| !text.is_empty())
        .map(|text| decode(&text))
        .transpose()?;
    Ok(DreamRun {
        open: NewRun {
            run_id: row.get("run_id")?,
            agent_id: row.get("agent_id")?,
            phase: Phase::from_column(row, "phase")?,
            job_id: row.get("job_id")?,
            partition: row.get("partition")?,
            idempotency_key: base.map_or(raw.as_str(), |(key, _)| key).to_owned(),
            trigger: Trigger::from_column(row, "trigger")?,
            scheduled_for: row.get("scheduled_for")?,
            started_at: row.get("started_at")?,
            log_path: row.get("log_path")?,
        },
        claimed: base.is_none(),
        result: FinishRun {
            outcome,
            reason: row.get("reason")?,
            finished_at: row.get("finished_at")?,
            counts: decode(&row.get::<_, String>("counts_json")?)?,
            tokens_in: row.get("tokens_in")?,
            tokens_out: row.get("tokens_out")?,
            error,
        },
    })
}

fn read_candidate(row: &Row<'_>) -> rusqlite::Result<CandidateRow> {
    Ok(CandidateRow {
        seed: CandidateSeed {
            candidate_id: row.get("candidate_id")?,
            agent_id: row.get("agent_id")?,
            partition: row.get("partition")?,
            content_hash: row.get("content_hash")?,
            source_run_id: row.get("source_run_id")?,
            first_seen_at: row.get("first_seen_at")?,
            expires_at: row.get("expires_at")?,
            signals: CandidateSignals {
                recalls: row.get("recalls")?,
                unique_queries: row.get("unique_queries")?,
                score: row.get("score")?,
            },
        },
        state: CandidateState::from_column(row, "state")?,
        decision: row
            .get::<_, Option<String>>("decision_json")?
            .filter(|text| !text.is_empty())
            .map(|text| decode(&text))
            .transpose()?
            .unwrap_or(Value::Null),
    })
}

pub(super) struct ObservedCorpus {
    pub captures: i64,
    pub importance: f64,
}

/// The SQLite-backed dreaming state.
pub struct DreamStore {
    db: Store,
}

impl DreamStore {
    /// Opens a private store with the platform's default permission implementation.
    pub fn open(path: &Path) -> R<Self> {
        Self::open_with_permissions(path, &private_store::default_secure)
    }

    /// Opens a store with the host's owner-only filesystem port.
    pub fn open_with_permissions(path: &Path, secure: &dyn Fn(&Path) -> bool) -> R<Self> {
        if path != Path::new(":memory:") {
            private_store::prepare(path)
                .map_err(|_| CollabError::new(C::Storage, "cannot prepare dreaming store"))?;
            if !secure(path) {
                return Err(CollabError::new(
                    C::Storage,
                    "cannot protect dreaming store",
                ));
            }
        }
        let spec = OwnerSpec {
            store: StoreSpec::new("dreams", 1),
            journal: if path == Path::new(":memory:") {
                Journal::Unchanged
            } else {
                Journal::Wal
            },
            schema: Schema::Steps(MIGRATIONS),
            create: true,
        };
        Ok(Self {
            db: Store::open_owner(path, &spec)?,
        })
    }

    /// Current schema version.
    pub fn schema_version(&self) -> R<i64> {
        Ok(self
            .db
            .conn()
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    /// Looks up one schedule by agent and phase.
    pub fn schedule(&self, agent: &str, phase: Phase) -> R<Option<Schedule>> {
        Ok(self
            .db
            .conn()
            .query_row(
                "SELECT * FROM dream_schedule WHERE agent_id = ? AND phase = ?",
                params![agent, phase.as_str()],
                read_schedule,
            )
            .optional()?)
    }

    /// Lists schedules, ordering phases light, rem, deep within each agent.
    pub fn schedules(&self, agent: Option<&str>) -> R<Vec<Schedule>> {
        let sql = format!(
            "SELECT * FROM dream_schedule WHERE (?1 IS NULL OR agent_id = ?1)
             ORDER BY agent_id, {SCHEDULE_ORDER}"
        );
        rows(self.db.conn(), &sql, [agent], read_schedule)
    }

    /// Creates a schedule without overwriting an owner's existing settings.
    pub fn insert_schedule(&self, schedule: &ScheduleSeed) -> R<bool> {
        Ok(self.db.conn().execute(
            "INSERT OR IGNORE INTO dream_schedule
             (agent_id, phase, cron, timezone, enabled, stagger_offset_s, next_run_at)
             VALUES (?,?,?,?,?,?,?)",
            params![
                schedule.agent_id,
                schedule.phase.as_str(),
                schedule.cron,
                schedule.timezone,
                schedule.enabled,
                schedule.stagger_offset_s,
                schedule.next_run_at
            ],
        )? != 0)
    }

    /// Applies a typed patch without disturbing capture identity or unmentioned columns.
    pub fn update_schedule(&self, agent: &str, phase: Phase, patch: SchedulePatch) -> R<()> {
        let changes = [
            ("cron", patch.cron.map(SqlValue::Text)),
            ("timezone", patch.timezone.map(SqlValue::Text)),
            (
                "enabled",
                patch
                    .enabled
                    .map(|value| SqlValue::Integer(i64::from(value))),
            ),
            (
                "stagger_offset_s",
                patch.stagger_offset_s.map(SqlValue::Integer),
            ),
            ("next_run_at", optional(patch.next_run_at)),
            ("last_run_id", optional(patch.last_run_id)),
            (
                "breaker_state",
                patch
                    .breaker_state
                    .map(|state| SqlValue::Text(state.as_str().to_owned())),
            ),
            ("breaker_until", optional(patch.breaker_until)),
            ("breaker_reason", optional(patch.breaker_reason)),
            ("importance_acc", patch.importance_acc.map(SqlValue::Real)),
            ("captures_acc", patch.captures_acc.map(SqlValue::Integer)),
        ];
        let mut columns = Vec::new();
        let mut values = Vec::new();
        for (column, value) in changes {
            if let Some(value) = value {
                columns.push(format!("{column} = ?"));
                values.push(value);
            }
        }
        if columns.is_empty() {
            return Ok(());
        }
        values.extend([
            SqlValue::Text(agent.to_owned()),
            SqlValue::Text(phase.as_str().to_owned()),
        ]);
        let sql = format!(
            "UPDATE dream_schedule SET {} WHERE agent_id = ? AND phase = ?",
            columns.join(", ")
        );
        self.db.conn().execute(&sql, params_from_iter(values))?;
        Ok(())
    }

    pub(super) fn advance_due(&self, old: &ScheduleSeed, at: i64, next: Option<i64>) -> R<bool> {
        Ok(self.db.conn().execute(
            "UPDATE dream_schedule SET next_run_at = ?1 WHERE agent_id = ?2 AND phase = ?3
             AND enabled = 1 AND next_run_at = ?4 AND cron = ?5 AND timezone = ?6 AND stagger_offset_s = ?7",
            params![next, old.agent_id, old.phase.as_str(), at, old.cron, old.timezone, old.stagger_offset_s],
        )? == 1)
    }

    pub(super) fn refresh_breakers(&self, agent: &str, now: i64) -> R<()> {
        self.db.conn().execute(
            "UPDATE dream_schedule SET breaker_state = 'closed', breaker_until = NULL, breaker_reason = NULL
             WHERE agent_id = ?1 AND phase IN ('rem', 'deep') AND breaker_state = 'open' AND breaker_until <= ?2",
            params![agent, now],
        )?;
        Ok(())
    }

    /// Removes only current scheduling for a retired agent.
    pub fn delete_schedules(&self, agent: &str) -> R<usize> {
        Ok(self
            .db
            .conn()
            .execute("DELETE FROM dream_schedule WHERE agent_id = ?", [agent])?)
    }

    /// Advances the durable per-agent capture cursor and all phase accumulators.
    pub fn record_capture(&self, agent: &str, importance: f64, at: i64) -> R<()> {
        if !importance.is_finite() || importance < 0.0 || at < 0 {
            return Err(CollabError::new(
                C::Invalid,
                "invalid dreaming capture signal",
            ));
        }
        self.db.conn().execute(
            "UPDATE dream_schedule SET importance_acc = importance_acc + ?, captures_acc = captures_acc + 1,
             capture_seq = capture_seq + 1, last_capture_at = ? WHERE agent_id = ?",
            params![importance, at, agent],
        )?;
        Ok(())
    }

    fn insert_on(cx: &Connection, run: &NewRun) -> R<()> {
        if run.run_id.is_empty()
            || run.idempotency_key.is_empty()
            || run.run_id.contains('#')
            || run.idempotency_key.contains('#')
        {
            return Err(CollabError::new(
                C::Invalid,
                "invalid dreaming run identity",
            ));
        }
        let key = format!("{}#{}", run.idempotency_key, run.run_id);
        cx.execute(
            "INSERT INTO dream_run
             (run_id, agent_id, phase, job_id, partition, idempotency_key, trigger, scheduled_for, started_at, log_path)
             VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![run.run_id, run.agent_id, run.phase.as_str(), run.job_id, run.partition, key,
                run.trigger.as_str(), run.scheduled_for, run.started_at, run.log_path],
        )?;
        Ok(())
    }

    /// Records an open attempt with a provisional key before any work is performed.
    pub fn insert_run(&self, run: &NewRun) -> R<()> {
        Self::insert_on(self.db.conn(), run)
    }

    pub(super) fn begin_phase(&self, run: &NewRun) -> R<bool> {
        let transaction =
            Transaction::new_unchecked(self.db.conn(), TransactionBehavior::Immediate)?;
        let busy = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM dream_run WHERE agent_id = ? AND phase = ? AND outcome IS NULL)
             OR (SELECT count(*) FROM dream_run WHERE outcome IS NULL) >= 3",
            params![run.agent_id, run.phase.as_str()],
            |row| row.get(0),
        )?;
        Self::insert_on(&transaction, run)?;
        transaction.commit()?;
        Ok(busy)
    }

    /// Returns the attempt currently holding a stable key.
    pub fn key_holder(&self, key: &str) -> R<Option<String>> {
        Ok(self
            .db
            .conn()
            .query_row(
                "SELECT run_id FROM dream_run WHERE idempotency_key = ?",
                [key],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Atomically claims this attempt's own key, or reports that the claim is unavailable.
    pub fn claim_key(&self, run_id: &str, key: &str) -> R<bool> {
        if key.is_empty() || key.contains('#') || run_id.contains('#') {
            return Err(CollabError::new(
                C::Invalid,
                "invalid dreaming run identity",
            ));
        }
        let provisional = format!("{key}#{run_id}");
        Ok(self.db.conn().execute(
            "UPDATE OR IGNORE dream_run SET idempotency_key = ?1
             WHERE run_id = ?2 AND outcome IS NULL AND idempotency_key IN (?1, ?3)",
            params![key, run_id, provisional],
        )? != 0)
    }

    /// Closes an open attempt once. A completed attempt must already have claimed its key.
    pub fn finish_run(&self, id: &str, result: &FinishRun) -> R<()> {
        self.finish(id, result, None)
    }

    pub(super) fn finish_phase(
        &self,
        id: &str,
        result: &FinishRun,
        corpus: ObservedCorpus,
    ) -> R<()> {
        self.finish(id, result, Some(corpus))
    }

    fn finish(&self, id: &str, result: &FinishRun, corpus: Option<ObservedCorpus>) -> R<()> {
        let (Some(outcome), Some(at)) = (result.outcome, result.finished_at) else {
            return Err(CollabError::new(
                C::Invalid,
                "missing dreaming run disposition",
            ));
        };
        let transaction =
            Transaction::new_unchecked(self.db.conn(), TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT idempotency_key, outcome, coalesce(CAST(json_extract(counts_json,'$.llmSessions') AS INTEGER),0)
                 FROM dream_run WHERE run_id = ?",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()?;
        let Some((raw, None, sessions)) = current else {
            return Err(conflict(
                "run-closed",
                "dreaming attempt is missing or already closed",
            ));
        };
        let key = match outcome {
            Outcome::Completed if raw.contains('#') => {
                return Err(conflict(
                    "idempotent",
                    "a completed dreaming attempt needs its claim",
                ));
            }
            Outcome::Completed => raw,
            other => {
                let base = raw.split_once('#').map_or(raw.as_str(), |(base, _)| base);
                format!("{base}#{}:{id}", other.as_str())
            }
        };
        let mut counts = result.counts.clone();
        if sessions as f64 > counts.get("llmSessions").copied().unwrap_or(0.0) {
            counts.insert("llmSessions".into(), sessions as f64);
        }
        transaction.execute(
            "UPDATE dream_run SET outcome = ?, reason = ?, finished_at = ?, counts_json = ?,
             tokens_in = ?, tokens_out = ?, error_json = ?, idempotency_key = ? WHERE run_id = ? AND outcome IS NULL",
            params![outcome.as_str(), result.reason, at, encode(&counts)?, result.tokens_in,
                result.tokens_out, result.error.as_ref().map(encode).transpose()?, key, id],
        )?;
        if let Some(corpus) = corpus {
            let captures = if outcome == Outcome::Completed {
                corpus.captures
            } else {
                0
            };
            let importance = if outcome == Outcome::Completed {
                corpus.importance
            } else {
                0.0
            };
            transaction.execute(
                "UPDATE dream_schedule SET last_run_id = ?1,
                 captures_acc = MAX(0, captures_acc - ?2), importance_acc = MAX(0.0, importance_acc - ?3)
                 WHERE (agent_id, phase) = (SELECT agent_id, phase FROM dream_run WHERE run_id = ?1)",
                params![id, captures, importance],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Finds an attempt by its opaque identifier.
    pub fn run(&self, id: &str) -> R<Option<DreamRun>> {
        Ok(self
            .db
            .conn()
            .query_row("SELECT * FROM dream_run WHERE run_id = ?", [id], read_run)
            .optional()?)
    }

    /// Reads newest attempts first, with optional scope and time constraints.
    pub fn runs(&self, query: &RunQuery<'_>) -> R<Vec<DreamRun>> {
        rows(
            self.db.conn(),
            "SELECT * FROM dream_run WHERE (?1 IS NULL OR agent_id = ?1)
             AND (?2 IS NULL OR phase = ?2) AND (?3 IS NULL OR started_at >= ?3)
             ORDER BY started_at DESC, rowid DESC LIMIT ?4",
            params![
                query.agent_id,
                query.phase.map(Phase::as_str),
                query.since,
                query.limit.unwrap_or(50)
            ],
            read_run,
        )
    }

    /// Returns all observed attempts of a scheduled slot, oldest first.
    pub fn window_runs(&self, agent: &str, phase: Phase, at: i64) -> R<Vec<DreamRun>> {
        rows(
            self.db.conn(),
            "SELECT * FROM dream_run WHERE agent_id = ? AND phase = ? AND scheduled_for = ?
             ORDER BY started_at, rowid",
            params![agent, phase.as_str(), at],
            read_run,
        )
    }

    /// Finds the last attempt without excluding refusals.
    pub fn last_run(&self, agent: &str, phase: Phase) -> R<Option<DreamRun>> {
        Ok(self.db.conn().query_row(
            "SELECT * FROM dream_run WHERE agent_id = ? AND phase = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
            params![agent, phase.as_str()],
            read_run,
        ).optional()?)
    }

    /// Lists interrupted attempts that still need reconciliation.
    pub fn open_runs(&self) -> R<Vec<DreamRun>> {
        rows(
            self.db.conn(),
            "SELECT * FROM dream_run WHERE outcome IS NULL",
            [],
            read_run,
        )
    }

    /// Retires closed ledger records and detaches expired log references in one transaction.
    pub fn prune(&self, ledger_before: i64, logs_before: i64) -> R<Retention> {
        let transaction =
            Transaction::new_unchecked(self.db.conn(), TransactionBehavior::Immediate)?;
        let logs = rows(&transaction,
            "SELECT log_path FROM dream_run WHERE outcome IS NOT NULL AND log_path IS NOT NULL AND started_at < ?",
            [logs_before],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE dream_run SET log_path = NULL WHERE outcome IS NOT NULL AND log_path IS NOT NULL AND started_at < ?",
            [logs_before],
        )?;
        let deleted = transaction.execute(
            "DELETE FROM dream_run WHERE outcome IS NOT NULL AND started_at < ?",
            [ledger_before],
        )?;
        transaction.commit()?;
        Ok(Retention { deleted, logs })
    }

    pub(super) fn reserve_model_session(
        &self,
        id: &str,
        agent: &str,
        day: i64,
        cap: i64,
    ) -> R<bool> {
        let next_day = day.saturating_add(86_400_000);
        let transaction =
            Transaction::new_unchecked(self.db.conn(), TransactionBehavior::Immediate)?;
        let used: i64 = transaction.query_row(
            "SELECT coalesce(sum(max(0,coalesce(CAST(json_extract(counts_json,'$.llmSessions') AS INTEGER),0))),0)
             FROM dream_run WHERE agent_id = ?1 AND phase IN ('rem','deep')
             AND (outcome IS NULL OR (started_at >= ?2 AND started_at < ?3))",
            params![agent, day, next_day], |row| row.get(0))?;
        if used >= cap {
            return Ok(false);
        }
        let reserved = transaction.execute(
            "UPDATE dream_run SET counts_json=json_set(counts_json,'$.llmSessions',
             coalesce(CAST(json_extract(counts_json,'$.llmSessions') AS INTEGER),0)+1)
             WHERE run_id=?1 AND agent_id=?2 AND phase IN ('rem','deep') AND outcome IS NULL
             AND instr(idempotency_key,'#')=0 AND started_at >= ?3 AND started_at < ?4",
            params![id, agent, day, next_day],
        )?;
        transaction.commit()?;
        Ok(reserved == 1)
    }

    pub(super) fn release_skipped_session(&self, id: &str) -> R<()> {
        self.db.conn().execute(
            "UPDATE dream_run SET counts_json=json_set(counts_json,'$.llmSessions',
             max(0,coalesce(CAST(json_extract(counts_json,'$.llmSessions') AS INTEGER),0)-1))
             WHERE run_id=? AND outcome IS NULL AND instr(idempotency_key,'#')=0",
            [id],
        )?;
        Ok(())
    }

    /// Counts closed-run model sessions for the caller's agent, phases and window.
    pub fn llm_sessions_since(&self, agent: &str, phases: &[Phase], since: i64) -> R<i64> {
        Ok(self.db.conn().query_row(
            "SELECT COALESCE(SUM(CAST(json_extract(counts_json, '$.llmSessions') AS INTEGER)), 0)
             FROM dream_run WHERE agent_id = ?1 AND phase IN (SELECT value FROM json_each(?2))
             AND started_at >= ?3 AND outcome IS NOT NULL",
            params![agent, encode(&phases)?, since],
            |row| row.get(0),
        )?)
    }

    pub(super) fn update_candidates<T>(&self, change: impl FnOnce() -> R<T>) -> R<T> {
        let transaction =
            Transaction::new_unchecked(self.db.conn(), TransactionBehavior::Immediate)?;
        let value = change()?;
        transaction.commit()?;
        Ok(value)
    }

    /// Records a shortlist item with deduplication within the owner and partition.
    pub fn insert_candidate(&self, entry: &CandidateSeed, state: CandidateState) -> R<bool> {
        Ok(self.db.conn().execute(
            "INSERT OR IGNORE INTO dream_candidate (candidate_id, agent_id, partition, content_hash, source_run_id,
             first_seen_at, expires_at, recalls, unique_queries, score, state) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            params![entry.candidate_id, entry.agent_id, entry.partition, entry.content_hash, entry.source_run_id,
                entry.first_seen_at, entry.expires_at, entry.signals.recalls, entry.signals.unique_queries,
                entry.signals.score, state.as_str()],
        )? != 0)
    }

    /// Updates observations only for items still on the owner's shortlist.
    pub fn update_signals(
        &self,
        agent: &str,
        partition: &str,
        hash: &str,
        signals: CandidateSignals,
    ) -> R<()> {
        self.db.conn().execute(
            "UPDATE dream_candidate SET recalls = ?, unique_queries = ?, score = ?
             WHERE agent_id = ? AND partition = ? AND content_hash = ? AND state = 'shortlisted'",
            params![
                signals.recalls,
                signals.unique_queries,
                signals.score,
                agent,
                partition,
                hash
            ],
        )?;
        Ok(())
    }

    /// Transitions a shortlisted candidate for the same owner without reviving a terminal item.
    pub fn set_candidate_state(
        &self,
        agent: &str,
        id: &str,
        state: CandidateState,
        decision: &Value,
    ) -> R<bool> {
        Ok(self.db.conn().execute(
            "UPDATE dream_candidate SET state = ?, decision_json = ?
             WHERE agent_id = ? AND candidate_id = ? AND state = 'shortlisted'",
            params![state.as_str(), encode(decision)?, agent, id],
        )? != 0)
    }

    /// Reads only the requested owner's candidates.
    pub fn candidates(&self, agent: &str, state: Option<CandidateState>) -> R<Vec<CandidateRow>> {
        rows(
            self.db.conn(),
            "SELECT * FROM dream_candidate WHERE agent_id = ?1 AND (?2 IS NULL OR state = ?2)
             ORDER BY first_seen_at, candidate_id",
            params![agent, state.map(CandidateState::as_str)],
            read_candidate,
        )
    }

    /// Expires shortlisted rows at their inclusive deadline.
    pub fn expire_candidates(&self, agent: &str, at: i64) -> R<usize> {
        Ok(self.db.conn().execute(
            "UPDATE dream_candidate SET state = 'expired', decision_json = ?
             WHERE agent_id = ? AND state = 'shortlisted' AND expires_at <= ?",
            params![
                encode(&json!({"gate":"expiry", "passed":false, "at":at}))?,
                agent,
                at
            ],
        )?)
    }
}

#[cfg(test)]
#[path = "store_vectors.rs"]
mod vectors;
